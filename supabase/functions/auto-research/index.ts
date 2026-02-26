import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { AppError } from "../_shared/errors.ts";
import { Logger, createRequestId } from "../_shared/logger.ts";
import { corsResponse, corsOptions } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/auth.ts";
import { embedTexts } from "../_shared/embeddings.ts";
import { searchExa } from "../_shared/exa.ts";
import { analyzeConnections } from "../_shared/llm.ts";
import { classifyIntoTopic } from "../_shared/topics.ts";
import { findRelatedSources } from "../_shared/similarity.ts";
import { withRetry, resilientFetch, isRetryable } from "../_shared/retry.ts";
import { ExternalServiceError } from "../_shared/errors.ts";

const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const DAEMON_SECRET = Deno.env.get("DAEMON_SECRET") ?? "";

const db = getServiceClient();

interface ResearchDirection {
  topic_a_id: string;
  topic_a_label: string;
  topic_a_description: string | null;
  topic_b_id: string;
  topic_b_label: string;
  topic_b_description: string | null;
  topic_similarity: number;
  best_existing_bridge: number;
  priority_score: number;
}

/**
 * Generate a bridge query that would connect two topics.
 * The LLM synthesizes what question sits "between" them.
 */
async function generateBridgeQuery(
  direction: ResearchDirection,
  log: Logger,
): Promise<string> {
  log.info("bridge_query_gen_start", {
    topic_a: direction.topic_a_label,
    topic_b: direction.topic_b_label,
  });

  const resp = await withRetry(
    () =>
      resilientFetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "anthropic/claude-sonnet-4",
            messages: [
              {
                role: "user",
                content: `You are a research assistant. Two research topics exist that are semantically related but have no connecting sources between them.

Topic A: "${direction.topic_a_label}"${direction.topic_a_description ? ` — ${direction.topic_a_description}` : ""}
Topic B: "${direction.topic_b_label}"${direction.topic_b_description ? ` — ${direction.topic_b_description}` : ""}

Semantic similarity between them: ${direction.topic_similarity.toFixed(3)}

Generate a single, specific search query that would find sources bridging these two topics. The query should target the conceptual space BETWEEN them — not just one or the other, but the intersection, tension, or connection point.

Respond with ONLY the search query, nothing else. Keep it under 200 characters.`,
              },
            ],
            temperature: 0.7,
            max_tokens: 100,
          }),
        },
        "OpenRouter/chat",
      ),
    { maxAttempts: 2, shouldRetry: isRetryable },
  ).catch((err) => {
    const statusCode = (err as any).statusCode ?? 0;
    throw new ExternalServiceError("OpenRouter/chat", statusCode, err.message);
  });

  const data = await resp.json();
  const query = data.choices[0].message.content.trim().replace(/^["']|["']$/g, "");
  log.info("bridge_query_gen_done", { query });
  return query;
}

/**
 * Compute the best bridge score between two specific topics.
 * Uses pair_bridge_score RPC — O(sources) not O(sources × topics²).
 */
async function computeBridgeScore(
  topicAId: string,
  topicBId: string,
  log: Logger,
): Promise<number> {
  const { data, error } = await db.rpc("pair_bridge_score", {
    p_topic_a_id: topicAId,
    p_topic_b_id: topicBId,
    p_min_similarity: 0.3,
  });

  if (error) {
    log.warn("bridge_score_compute_failed", { error: error.message });
    return 0;
  }

  return data?.[0]?.best_bridge_score ?? 0;
}

/**
 * Process a single research direction: generate query, search, embed, store.
 * Reuses the search pipeline modules.
 */
async function processDirection(
  direction: ResearchDirection,
  log: Logger,
): Promise<{ sourcesFound: number; bridgeScoreAfter: number }> {
  // Look up the user who owns these topics
  const { data: topicRow } = await db
    .from("topics")
    .select("user_id")
    .eq("id", direction.topic_a_id)
    .single();

  const userId = topicRow?.user_id;
  if (!userId) throw new Error(`No user found for topic ${direction.topic_a_id}`);

  // 1. Generate bridge query
  const bridgeQuery = await generateBridgeQuery(direction, log);

  // 2. Record the direction
  const directionId = crypto.randomUUID();
  const { error: insertErr } = await db.from("research_directions").insert({
    id: directionId,
    topic_a_id: direction.topic_a_id,
    topic_b_id: direction.topic_b_id,
    bridge_query: bridgeQuery,
    status: "searching",
    bridge_score_before: direction.best_existing_bridge,
  });
  if (insertErr) throw insertErr;

  try {
    // 3. Create query record (attributed to the topic owner)
    const { data: queryRow, error: queryErr } = await db
      .from("queries")
      .insert({
        raw_input: bridgeQuery,
        user_id: userId,
      })
      .select("id")
      .single();
    if (queryErr) throw queryErr;
    const queryId = queryRow.id;

    // 4. Exa search (fewer results for auto-research — save costs)
    const exaResults = await searchExa(bridgeQuery, log, 5);

    if (exaResults.length === 0) {
      await db.from("research_directions").update({
        status: "exhausted",
        sources_found: 0,
        completed_at: new Date().toISOString(),
      }).eq("id", directionId);
      return { sourcesFound: 0, bridgeScoreAfter: direction.best_existing_bridge };
    }

    // 5. Embed query + sources
    const textsToEmbed = [
      bridgeQuery,
      ...exaResults.map(
        (r) => `${r.title}\n${r.summary}\n${r.highlights.join(" ")}`,
      ),
    ];
    const allEmbeddings = await embedTexts(textsToEmbed, log);
    const queryEmbedding = allEmbeddings[0];
    const sourceEmbeddings = allEmbeddings.slice(1);

    // 6. Store sources
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

    // 7. Classify into topic + cross-query search + LLM analysis (parallel)
    const [topicInfo, crossQueryMatches, analysis] = await Promise.all([
      classifyIntoTopic(bridgeQuery, queryEmbedding, userId, queryId, db, log),
      findRelatedSources(sourceEmbeddings, queryId, db, log),
      analyzeConnections(
        bridgeQuery,
        exaResults.map((r) => ({
          title: r.title,
          url: r.url,
          summary: r.summary,
          highlights: r.highlights,
        })),
        log,
      ),
    ]);

    // 8. Store connections
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

    // 9. Store synthesis
    await db.from("syntheses").insert({
      query_id: queryId,
      summary: analysis.synthesis,
      gaps_identified: analysis.gaps,
      follow_up_questions: analysis.follow_up_questions,
      model: "anthropic/claude-sonnet-4",
    });

    // 10. Compute new bridge score
    const bridgeScoreAfter = await computeBridgeScore(
      direction.topic_a_id,
      direction.topic_b_id,
      log,
    );

    // 11. Update direction record
    await db.from("research_directions").update({
      status: "completed",
      query_id: queryId,
      sources_found: exaResults.length,
      bridge_score_after: bridgeScoreAfter,
      completed_at: new Date().toISOString(),
    }).eq("id", directionId);

    return { sourcesFound: exaResults.length, bridgeScoreAfter };
  } catch (err) {
    // Mark as failed, preserve the error
    await db.from("research_directions").update({
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      completed_at: new Date().toISOString(),
    }).eq("id", directionId);
    throw err;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsOptions();

  const requestId = req.headers.get("x-request-id") ?? createRequestId();
  const log = new Logger({ request_id: requestId, endpoint: "auto-research" });
  const started = performance.now();

  if (req.method !== "POST") {
    return corsResponse(
      { error: { code: "METHOD_NOT_ALLOWED", message: "POST only" } },
      405,
      { "x-request-id": requestId },
    );
  }

  try {
    // --- Auth: daemon secret or service role ---
    // This function is NOT user-facing. It's called by cron/scheduler.
    const authHeader = req.headers.get("Authorization");
    const providedSecret = authHeader?.replace("Bearer ", "");

    if (!DAEMON_SECRET || providedSecret !== DAEMON_SECRET) {
      return corsResponse(
        { error: { code: "AUTH_ERROR", message: "Invalid daemon secret" } },
        401,
        { "x-request-id": requestId },
      );
    }

    log.info("daemon_start");

    // --- Parse options ---
    let maxDirections = 3;
    try {
      const body = await req.json();
      if (body?.max_directions) maxDirections = Math.min(body.max_directions, 10);
    } catch {
      // no body is fine, use defaults
    }

    // --- 1. Identify research directions ---
    const { data: directions, error: dirErr } = await db.rpc(
      "identify_research_directions",
      { p_max_directions: maxDirections },
    );

    if (dirErr) throw dirErr;

    if (!directions?.length) {
      log.info("daemon_done", { reason: "no_gaps_found", elapsed_ms: Math.round(performance.now() - started) });
      return corsResponse(
        { message: "No research directions found", directions_processed: 0 },
        200,
        { "x-request-id": requestId },
      );
    }

    log.info("directions_identified", {
      count: directions.length,
      top_priority: directions[0].priority_score,
    });

    // --- 2. Process each direction sequentially (to stay within rate limits) ---
    const results: Array<{
      topic_a: string;
      topic_b: string;
      bridge_query?: string;
      sources_found: number;
      bridge_score_before: number;
      bridge_score_after: number;
      status: "completed" | "failed";
      error?: string;
    }> = [];

    for (const direction of directions) {
      try {
        const result = await processDirection(direction, log);
        results.push({
          topic_a: direction.topic_a_label,
          topic_b: direction.topic_b_label,
          sources_found: result.sourcesFound,
          bridge_score_before: direction.best_existing_bridge,
          bridge_score_after: result.bridgeScoreAfter,
          status: "completed",
        });
      } catch (err) {
        log.error("direction_failed", err, {
          topic_a: direction.topic_a_label,
          topic_b: direction.topic_b_label,
        });
        results.push({
          topic_a: direction.topic_a_label,
          topic_b: direction.topic_b_label,
          sources_found: 0,
          bridge_score_before: direction.best_existing_bridge,
          bridge_score_after: direction.best_existing_bridge,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // --- 3. Refresh materialized views ---
    const { error: refreshErr } = await db.rpc("refresh_topic_similarities");
    if (refreshErr) log.warn("refresh_failed", { error: refreshErr.message });

    const elapsed = Math.round(performance.now() - started);
    const completed = results.filter((r) => r.status === "completed").length;
    const totalSources = results.reduce((s, r) => s + r.sources_found, 0);

    log.info("daemon_done", {
      directions_processed: results.length,
      completed,
      total_sources: totalSources,
      elapsed_ms: elapsed,
    });

    return corsResponse(
      {
        directions_processed: results.length,
        completed,
        total_sources_added: totalSources,
        results,
        elapsed_ms: elapsed,
      },
      200,
      { "x-request-id": requestId },
    );
  } catch (err) {
    const elapsed = Math.round(performance.now() - started);

    if (err instanceof AppError) {
      log.warn("daemon_failed", { status: err.statusCode, code: err.code, elapsed_ms: elapsed });
      return corsResponse(err.toJSON(), err.statusCode, { "x-request-id": requestId });
    }

    log.error("daemon_unhandled_error", err, { elapsed_ms: elapsed });
    return corsResponse(
      { error: { code: "INTERNAL_ERROR", message: "An internal error occurred" } },
      500,
      { "x-request-id": requestId },
    );
  }
});
