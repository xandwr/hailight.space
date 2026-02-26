import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { AppError } from "../_shared/errors.ts";
import { Logger, createRequestId } from "../_shared/logger.ts";
import { corsResponse, corsOptions } from "../_shared/cors.ts";
import { getServiceClient, authenticateRequest } from "../_shared/auth.ts";
import { withRetry, resilientFetch, isRetryable } from "../_shared/retry.ts";
import { ExternalServiceError } from "../_shared/errors.ts";

const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const ANALYSIS_MODEL = "anthropic/claude-sonnet-4";

const db = getServiceClient();

interface TopicGap {
  topic_a_id: string;
  topic_a_label: string;
  topic_b_id: string;
  topic_b_label: string;
  topic_similarity: number;
}

interface Bridge {
  source_title: string;
  source_url: string;
  topic_a_label: string;
  topic_b_label: string;
  bridge_score: number;
}

interface TopicDensity {
  topic_id: string;
  topic_label: string;
  query_count: number;
  source_count: number;
  avg_similarity: number;
  stddev_similarity: number;
}

interface TrajectoryPoint {
  raw_input: string;
  topic_label: string;
  movement_type: string;
  similarity_to_previous: number | null;
}

interface Contradiction {
  source_a_title: string;
  source_b_title: string;
  explanation: string;
  strength: number;
}

interface RecentDirection {
  topic_a_label: string;
  topic_b_label: string;
  bridge_query: string;
  sources_found: number;
  bridge_score_before: number;
  bridge_score_after: number;
  status: string;
  completed_at: string;
}

interface InsightData {
  gaps: TopicGap[];
  bridges: Bridge[];
  density: TopicDensity[];
  trajectory: TrajectoryPoint[];
  contradictions: Contradiction[];
  recent_research: RecentDirection[];
}

interface InsightSynthesis {
  narrative: string;
  strongest_areas: string[];
  blindspots: string[];
  surprising_connections: string[];
  recommended_queries: string[];
}

/**
 * Gather all analytics data for a user in parallel.
 */
async function gatherInsightData(
  userId: string,
  log: Logger,
): Promise<InsightData> {
  log.info("gather_start");

  const [
    gapsResult,
    bridgesResult,
    densityResult,
    trajectoryResult,
    contradictionsResult,
    researchResult,
  ] = await Promise.all([
    db.rpc("topic_gaps", { p_user_id: userId, p_limit: 10 }),
    db.rpc("semantic_bridges", { p_user_id: userId, p_min_similarity: 0.4, p_limit: 10 }),
    db.rpc("knowledge_density", { p_user_id: userId }),
    db.rpc("query_trajectory", { p_user_id: userId, p_limit: 30 }),
    db.rpc("find_contradictions", { p_user_id: userId, p_limit: 10 }),
    db
      .from("research_directions")
      .select(
        "topic_a:topics!research_directions_topic_a_id_fkey(label), topic_b:topics!research_directions_topic_b_id_fkey(label), bridge_query, sources_found, bridge_score_before, bridge_score_after, status, completed_at",
      )
      .in("status", ["completed", "exhausted"])
      .order("completed_at", { ascending: false })
      .limit(5),
  ]);

  // Log any RPC failures but don't abort — partial data is still useful
  const errors: string[] = [];
  if (gapsResult.error) errors.push(`gaps: ${gapsResult.error.message}`);
  if (bridgesResult.error) errors.push(`bridges: ${bridgesResult.error.message}`);
  if (densityResult.error) errors.push(`density: ${densityResult.error.message}`);
  if (trajectoryResult.error) errors.push(`trajectory: ${trajectoryResult.error.message}`);
  if (contradictionsResult.error) errors.push(`contradictions: ${contradictionsResult.error.message}`);
  if (researchResult.error) errors.push(`research: ${researchResult.error.message}`);

  if (errors.length > 0) {
    log.warn("gather_partial_errors", { errors });
  }

  // Flatten research_directions join results
  const recentResearch: RecentDirection[] = (researchResult.data ?? []).map(
    (r: any) => ({
      topic_a_label: r.topic_a?.label ?? "unknown",
      topic_b_label: r.topic_b?.label ?? "unknown",
      bridge_query: r.bridge_query,
      sources_found: r.sources_found,
      bridge_score_before: r.bridge_score_before,
      bridge_score_after: r.bridge_score_after,
      status: r.status,
      completed_at: r.completed_at,
    }),
  );

  const data: InsightData = {
    gaps: gapsResult.data ?? [],
    bridges: bridgesResult.data ?? [],
    density: densityResult.data ?? [],
    trajectory: trajectoryResult.data ?? [],
    contradictions: contradictionsResult.data ?? [],
    recent_research: recentResearch,
  };

  log.info("gather_done", {
    gaps: data.gaps.length,
    bridges: data.bridges.length,
    topics: data.density.length,
    trajectory_points: data.trajectory.length,
    contradictions: data.contradictions.length,
    recent_research: data.recent_research.length,
  });

  return data;
}

/**
 * Synthesize a narrative from structured analytics data.
 */
async function synthesizeInsights(
  data: InsightData,
  log: Logger,
): Promise<InsightSynthesis> {
  log.info("synthesis_start");

  // If user has no data at all, skip the LLM call
  if (data.density.length === 0) {
    return {
      narrative: "No research data yet. Start searching to build your knowledge graph.",
      strongest_areas: [],
      blindspots: [],
      surprising_connections: [],
      recommended_queries: [],
    };
  }

  const prompt = `You are the insight engine for Hailight, a research tool that surfaces the space between knowledge — the gaps, bridges, contradictions, and trajectories in a user's research.

Analyze this user's knowledge graph and produce a concise, useful synthesis. Be direct and specific. Name topics, sources, and connections by name. Don't be generic.

## User's Knowledge Graph

### Topics (${data.density.length} total)
${data.density.map((t) => `- "${t.topic_label}": ${t.source_count} sources, ${t.query_count} queries, avg coherence ${t.avg_similarity?.toFixed(3) ?? "?"} ± ${t.stddev_similarity?.toFixed(3) ?? "?"}`).join("\n")}

### Gaps — Topic Pairs With No Bridges (${data.gaps.length})
${data.gaps.length > 0 ? data.gaps.map((g) => `- "${g.topic_a_label}" ↔ "${g.topic_b_label}" (similarity: ${g.topic_similarity.toFixed(3)})`).join("\n") : "None found."}

### Bridges — Sources Connecting Topics (${data.bridges.length})
${data.bridges.length > 0 ? data.bridges.map((b) => `- "${b.source_title}" bridges "${b.topic_a_label}" ↔ "${b.topic_b_label}" (score: ${b.bridge_score.toFixed(3)})`).join("\n") : "None found."}

### Contradictions (${data.contradictions.length})
${data.contradictions.length > 0 ? data.contradictions.map((c) => `- "${c.source_a_title}" vs "${c.source_b_title}": ${c.explanation} (strength: ${c.strength})`).join("\n") : "None detected."}

### Recent Research Trajectory (last ${data.trajectory.length} queries)
${data.trajectory.slice(-15).map((t) => `- [${t.movement_type}] "${t.raw_input}" → ${t.topic_label}`).join("\n")}

### Auto-Research Activity (${data.recent_research.length} recent)
${data.recent_research.length > 0 ? data.recent_research.map((r) => `- "${r.topic_a_label}" ↔ "${r.topic_b_label}": queried "${r.bridge_query}" → ${r.sources_found} sources, bridge ${r.bridge_score_before.toFixed(3)} → ${r.bridge_score_after.toFixed(3)} [${r.status}]`).join("\n") : "No auto-research yet."}

## Instructions

Produce a JSON response with:
1. **narrative**: 2-4 paragraph overview of the user's research landscape. What patterns emerge? Where are they deep vs shallow? What's the shape of their curiosity? What should they know that they don't yet? Write like a research advisor, not a chatbot.
2. **strongest_areas**: 2-4 topics where they have the most depth/coherence.
3. **blindspots**: 2-4 gaps or weak areas they should know about — topic pairs that should be connected but aren't, areas where they're circling without deepening, contradictions they haven't resolved.
4. **surprising_connections**: 1-3 non-obvious bridges or patterns. Things the user probably hasn't noticed.
5. **recommended_queries**: 3-5 specific search queries that would most improve their knowledge graph — filling gaps, resolving contradictions, or exploring promising bridges.

Respond in this exact JSON format:
{
  "narrative": "...",
  "strongest_areas": ["...", "..."],
  "blindspots": ["...", "..."],
  "surprising_connections": ["...", "..."],
  "recommended_queries": ["...", "..."]
}

Only output valid JSON. No markdown fences.`;

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
            model: ANALYSIS_MODEL,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.4,
            max_tokens: 4000,
          }),
        },
        "OpenRouter/chat",
      ),
    { maxAttempts: 2, shouldRetry: isRetryable },
  ).catch((err) => {
    const statusCode = (err as any).statusCode ?? 0;
    throw new ExternalServiceError("OpenRouter/chat", statusCode, err.message);
  });

  const result = await resp.json();
  const content: string = result.choices[0].message.content;

  let synthesis: InsightSynthesis;
  try {
    synthesis = JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) synthesis = JSON.parse(match[0]);
    else throw new Error(`Failed to parse insight synthesis: ${content.slice(0, 200)}`);
  }

  log.info("synthesis_done");
  return synthesis;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsOptions();

  const requestId = req.headers.get("x-request-id") ?? createRequestId();
  const log = new Logger({ request_id: requestId, endpoint: "insights" });
  const started = performance.now();

  if (req.method !== "GET" && req.method !== "POST") {
    return corsResponse(
      { error: { code: "METHOD_NOT_ALLOWED", message: "GET or POST" } },
      405,
      { "x-request-id": requestId },
    );
  }

  try {
    // --- Auth ---
    const { userId } = await authenticateRequest(req, db);
    log.info("auth_ok", { user_id: userId });

    // --- Gather all analytics in parallel ---
    const data = await gatherInsightData(userId, log);

    // --- Synthesize via LLM ---
    const synthesis = await synthesizeInsights(data, log);

    const elapsed = Math.round(performance.now() - started);
    log.info("insights_done", { elapsed_ms: elapsed });

    return corsResponse(
      {
        synthesis,
        data: {
          topic_count: data.density.length,
          gap_count: data.gaps.length,
          bridge_count: data.bridges.length,
          contradiction_count: data.contradictions.length,
          gaps: data.gaps,
          bridges: data.bridges,
          density: data.density,
          trajectory: data.trajectory.slice(-15),
          contradictions: data.contradictions,
          recent_research: data.recent_research,
        },
        elapsed_ms: elapsed,
      },
      200,
      { "x-request-id": requestId },
    );
  } catch (err) {
    const elapsed = Math.round(performance.now() - started);

    if (err instanceof AppError) {
      log.warn("insights_failed", { status: err.statusCode, code: err.code, elapsed_ms: elapsed });
      return corsResponse(err.toJSON(), err.statusCode, { "x-request-id": requestId });
    }

    log.error("insights_unhandled_error", err, { elapsed_ms: elapsed });
    return corsResponse(
      { error: { code: "INTERNAL_ERROR", message: "An internal error occurred" } },
      500,
      { "x-request-id": requestId },
    );
  }
});
