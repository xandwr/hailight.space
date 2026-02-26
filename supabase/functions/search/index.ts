import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { AppError, RateLimitError, ValidationError } from "../_shared/errors.ts";
import { Logger, createRequestId } from "../_shared/logger.ts";
import { corsResponse, corsOptions } from "../_shared/cors.ts";
import { authenticateRequest, getServiceClient } from "../_shared/auth.ts";
import { embedTexts } from "../_shared/embeddings.ts";
import { searchExa } from "../_shared/exa.ts";
import { analyzeConnections } from "../_shared/llm.ts";
import { classifyIntoTopic } from "../_shared/topics.ts";
import { findRelatedSources } from "../_shared/similarity.ts";

const db = getServiceClient();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsOptions();

  const requestId = req.headers.get("x-request-id") ?? createRequestId();
  const log = new Logger({ request_id: requestId, endpoint: "search" });
  const started = performance.now();

  if (req.method !== "POST") {
    return corsResponse({ error: { code: "METHOD_NOT_ALLOWED", message: "POST only" } }, 405, {
      "x-request-id": requestId,
    });
  }

  try {
    // --- Auth ---
    const { userId, authMethod } = await authenticateRequest(req, db);
    log.info("authenticated", { auth_method: authMethod });

    // --- Rate limit ---
    const { data: rl, error: rlErr } = await db.rpc("check_rate_limit", {
      p_user_id: userId,
      p_endpoint: "search",
      p_window_seconds: 60,
      p_max_requests: 10,
    });

    if (rlErr) log.warn("rate_limit_check_failed", { error: rlErr.message });

    if (rl?.[0] && !rl[0].allowed) {
      throw new RateLimitError(rl[0].retry_after_seconds, 0);
    }

    const remaining = rl?.[0]?.remaining ?? -1;

    // --- Input validation ---
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new ValidationError("Request body must be valid JSON");
    }

    const query = (body as any)?.query;
    if (!query || typeof query !== "string") {
      throw new ValidationError("Missing 'query' string in request body");
    }
    if (query.length > 2000) {
      throw new ValidationError("Query must be 2000 characters or fewer");
    }
    if (query.trim().length < 3) {
      throw new ValidationError("Query must be at least 3 characters");
    }

    const trimmedQuery = query.trim();
    log.info("pipeline_start", { query_length: trimmedQuery.length, user_id: userId });

    // --- 1. Create query record ---
    const { data: queryRow, error: queryErr } = await db
      .from("queries")
      .insert({ raw_input: trimmedQuery, user_id: userId })
      .select("id")
      .single();

    if (queryErr) throw queryErr;
    const queryId = queryRow.id;
    log.info("query_created", { query_id: queryId });

    // --- 2. Exa search ---
    const exaResults = await searchExa(trimmedQuery, log);

    // --- 3. Batch embed query + sources ---
    const textsToEmbed = [
      trimmedQuery,
      ...exaResults.map(
        (r) => `${r.title}\n${r.summary}\n${r.highlights.join(" ")}`,
      ),
    ];
    const allEmbeddings = await embedTexts(textsToEmbed, log);
    const queryEmbedding = allEmbeddings[0];
    const sourceEmbeddings = allEmbeddings.slice(1);

    // --- 4. Store sources with embeddings ---
    const sourceRows = exaResults.map((r, i) => ({
      query_id: queryId,
      url: r.url,
      title: r.title,
      author: r.author,
      published_at: r.publishedDate,
      snippet: r.summary,
      full_text: r.text,
      exa_score: r.score,
      embedding: JSON.stringify(sourceEmbeddings[i]),
    }));

    const { data: insertedSources, error: sourceErr } = await db
      .from("sources")
      .insert(sourceRows)
      .select("id");

    if (sourceErr) throw sourceErr;

    // --- 5. Parallel: topic classification + cross-query search + LLM analysis ---
    const [topicInfo, crossQueryMatches, analysis] = await Promise.all([
      classifyIntoTopic(trimmedQuery, queryEmbedding, userId, queryId, db, log),
      findRelatedSources(sourceEmbeddings, queryId, db, log),
      analyzeConnections(
        trimmedQuery,
        exaResults.map((r) => ({
          title: r.title,
          url: r.url,
          summary: r.summary,
          highlights: r.highlights,
        })),
        log,
      ),
    ]);

    // --- 6. Store connections ---
    if (analysis.connections.length > 0) {
      const connectionRows = analysis.connections
        .filter(
          (c) =>
            c.source_a_index < insertedSources.length &&
            c.source_b_index < insertedSources.length &&
            c.source_a_index !== c.source_b_index,
        )
        .map((c) => ({
          query_id: queryId,
          source_a_id: insertedSources[c.source_a_index].id,
          source_b_id: insertedSources[c.source_b_index].id,
          relationship: c.relationship,
          explanation: c.explanation,
          strength: Math.max(0, Math.min(1, c.strength)),
        }));

      if (connectionRows.length > 0) {
        const { error: connErr } = await db.from("connections").insert(connectionRows);
        if (connErr) log.warn("connections_insert_partial", { error: connErr.message });
      }
    }

    // --- 7. Store synthesis ---
    const { error: synthErr } = await db.from("syntheses").insert({
      query_id: queryId,
      summary: analysis.synthesis,
      gaps_identified: analysis.gaps,
      follow_up_questions: analysis.follow_up_questions,
      model: "anthropic/claude-sonnet-4",
    });

    if (synthErr) log.warn("synthesis_insert_failed", { error: synthErr.message });

    // --- 8. Response ---
    const elapsed = Math.round(performance.now() - started);
    log.info("pipeline_done", { query_id: queryId, elapsed_ms: elapsed });

    return corsResponse(
      {
        query_id: queryId,
        topic: {
          id: topicInfo.topic_id,
          label: topicInfo.topic_label,
          is_new: topicInfo.is_new,
        },
        sources: exaResults.map((r, i) => ({
          id: insertedSources[i].id,
          url: r.url,
          title: r.title,
          summary: r.summary,
          highlights: r.highlights,
          score: r.score,
        })),
        connections: analysis.connections.map((c) => ({
          source_a: exaResults[c.source_a_index]?.title,
          source_b: exaResults[c.source_b_index]?.title,
          relationship: c.relationship,
          explanation: c.explanation,
          strength: c.strength,
        })),
        cross_query_connections: crossQueryMatches.map((m) => ({
          current_source: exaResults[m.source_index]?.title,
          related_source: m.matched_title,
          related_url: m.matched_url,
          from_query: m.matched_query,
          similarity: Math.round(m.similarity * 1000) / 1000,
        })),
        synthesis: analysis.synthesis,
        gaps: analysis.gaps,
        follow_up_questions: analysis.follow_up_questions,
      },
      200,
      {
        "x-request-id": requestId,
        "x-ratelimit-remaining": String(remaining),
      },
    );
  } catch (err) {
    const elapsed = Math.round(performance.now() - started);

    if (err instanceof AppError) {
      log.warn("request_failed", { status: err.statusCode, code: err.code, elapsed_ms: elapsed });
      const headers: Record<string, string> = { "x-request-id": requestId };
      if (err instanceof RateLimitError) {
        headers["retry-after"] = String(err.retryAfter);
        headers["x-ratelimit-remaining"] = "0";
      }
      return corsResponse(err.toJSON(), err.statusCode, headers);
    }

    // Unexpected error — log full details, return opaque message
    log.error("unhandled_error", err, { elapsed_ms: elapsed });
    return corsResponse(
      { error: { code: "INTERNAL_ERROR", message: "An internal error occurred" } },
      500,
      { "x-request-id": requestId },
    );
  }
});
