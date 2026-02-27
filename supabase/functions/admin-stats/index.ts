import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { AppError, AuthError } from "../_shared/errors.ts";
import { Logger, createRequestId } from "../_shared/logger.ts";
import { corsResponse, corsOptions } from "../_shared/cors.ts";
import { getServiceClient, authenticateRequest } from "../_shared/auth.ts";

const db = getServiceClient();

async function assertAdmin(userId: string): Promise<void> {
  const { data, error } = await db.rpc("is_admin", { p_user_id: userId });
  if (error || !data) {
    throw new AuthError("Admin access required");
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsOptions();

  const requestId = req.headers.get("x-request-id") ?? createRequestId();
  const log = new Logger({ request_id: requestId, endpoint: "admin-stats" });
  const started = performance.now();

  if (req.method !== "GET") {
    return corsResponse(
      { error: { code: "METHOD_NOT_ALLOWED", message: "GET only" } },
      405,
      { "x-request-id": requestId },
    );
  }

  try {
    const { userId } = await authenticateRequest(req, db);
    await assertAdmin(userId);
    log.info("admin_auth_ok", { user_id: userId });

    // Run all stats queries in parallel
    const [
      harvestResult,
      sourceCountsResult,
      directionsResult,
      userStatsResult,
      recentEventsResult,
      cronHealthResult,
      topTopicsResult,
      cronRecentResult,
    ] = await Promise.all([
      // Harvest state
      db.from("harvest_state").select("*"),

      // Source counts by type
      db.rpc("admin_source_counts"),

      // Research directions summary
      db.rpc("admin_research_summary"),

      // User stats
      db.rpc("admin_user_stats"),

      // Recent events (last 50)
      db
        .from("events")
        .select("event_type, properties, page, created_at")
        .order("created_at", { ascending: false })
        .limit(50),

      // Cron health: aggregated per-job stats
      db.rpc("admin_cron_health"),

      // Top topics by source count
      db.rpc("admin_top_topics"),

      // Recent cron executions (last 20)
      db
        .from("cron_executions")
        .select("job_name, status, http_status, started_at, completed_at, duration_ms, result, error")
        .order("started_at", { ascending: false })
        .limit(20),
    ]);

    const elapsed = Math.round(performance.now() - started);
    log.info("admin_stats_done", { elapsed_ms: elapsed });

    return corsResponse(
      {
        harvest: harvestResult.data ?? [],
        source_counts: sourceCountsResult.data ?? [],
        research_directions: directionsResult.data ?? [],
        user_stats: userStatsResult.data ?? [],
        recent_events: recentEventsResult.data ?? [],
        cron_health: cronHealthResult.data ?? [],
        cron_recent: cronRecentResult.data ?? [],
        top_topics: topTopicsResult.data ?? [],
        elapsed_ms: elapsed,
      },
      200,
      { "x-request-id": requestId },
    );
  } catch (err) {
    const elapsed = Math.round(performance.now() - started);

    if (err instanceof AppError) {
      log.warn("admin_stats_failed", {
        status: err.statusCode,
        code: err.code,
        elapsed_ms: elapsed,
      });
      return corsResponse(err.toJSON(), err.statusCode, {
        "x-request-id": requestId,
      });
    }

    log.error("admin_stats_unhandled_error", err, { elapsed_ms: elapsed });
    return corsResponse(
      { error: { code: "INTERNAL_ERROR", message: "An internal error occurred" } },
      500,
      { "x-request-id": requestId },
    );
  }
});
