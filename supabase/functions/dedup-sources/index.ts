import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { AppError } from "../_shared/errors.ts";
import { Logger, createRequestId } from "../_shared/logger.ts";
import { corsResponse, corsOptions } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/auth.ts";

const DAEMON_SECRET = Deno.env.get("DAEMON_SECRET") ?? "";
const db = getServiceClient();

/**
 * Merge two duplicate sources: keep the one with more data, delete the other.
 * Reassigns any connections and query references from the loser to the winner.
 */
async function mergePair(
  sourceAId: string,
  sourceBId: string,
  sourceAType: string,
  sourceBType: string,
  log: Logger,
): Promise<{ winner: string; loser: string }> {
  // Prefer arxiv > openalex > search (arxiv has canonical IDs, search is ephemeral)
  const typePriority: Record<string, number> = {
    arxiv: 3,
    openalex: 2,
    search: 1,
  };

  const aPriority = typePriority[sourceAType] ?? 0;
  const bPriority = typePriority[sourceBType] ?? 0;

  const winnerId = aPriority >= bPriority ? sourceAId : sourceBId;
  const loserId = winnerId === sourceAId ? sourceBId : sourceAId;

  // Reassign connections referencing the loser
  await db
    .from("connections")
    .update({ source_a: winnerId })
    .eq("source_a", loserId);
  await db
    .from("connections")
    .update({ source_b: winnerId })
    .eq("source_b", loserId);

  // Copy DOI to winner if winner lacks one
  const { data: loserData } = await db
    .from("sources")
    .select("doi")
    .eq("id", loserId)
    .single();
  if (loserData?.doi) {
    const { data: winnerData } = await db
      .from("sources")
      .select("doi")
      .eq("id", winnerId)
      .single();
    if (!winnerData?.doi) {
      await db.from("sources").update({ doi: loserData.doi }).eq("id", winnerId);
    }
  }

  // Delete the loser
  const { error } = await db.from("sources").delete().eq("id", loserId);
  if (error) {
    log.error("merge_delete_failed", error, { winner: winnerId, loser: loserId });
    throw new Error(`Failed to delete duplicate source: ${error.message}`);
  }

  log.info("merged_pair", {
    winner: winnerId,
    winner_type: winnerId === sourceAId ? sourceAType : sourceBType,
    loser: loserId,
    loser_type: loserId === sourceAId ? sourceAType : sourceBType,
  });

  return { winner: winnerId, loser: loserId };
}

/**
 * Periodic dedup sweep: find near-duplicate embeddings and merge them.
 *
 * POST body:
 * - similarity_threshold: float (default 0.95) — min cosine similarity to flag as duplicate
 * - batch_size: number (default 500) — how many recent sources to scan
 * - max_pairs: number (default 100) — max pairs to process per invocation
 * - dry_run: boolean (default false) — if true, report duplicates without merging
 */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsOptions();

  const requestId = req.headers.get("x-request-id") ?? createRequestId();
  const log = new Logger({ request_id: requestId, endpoint: "dedup-sources" });

  try {
    // Auth: daemon secret only
    const authHeader = req.headers.get("Authorization");
    const providedSecret = authHeader?.replace("Bearer ", "") ?? "";
    if (!DAEMON_SECRET || providedSecret !== DAEMON_SECRET) {
      throw new AppError("Unauthorized", 401, "UNAUTHORIZED");
    }

    const body = req.method === "POST" ? await req.json() : {};
    const similarityThreshold: number = body.similarity_threshold ?? 0.95;
    const batchSize: number = Math.min(body.batch_size ?? 500, 2000);
    const maxPairs: number = Math.min(body.max_pairs ?? 100, 500);
    const dryRun: boolean = body.dry_run ?? false;

    log.info("dedup_start", {
      similarity_threshold: similarityThreshold,
      batch_size: batchSize,
      max_pairs: maxPairs,
      dry_run: dryRun,
    });

    // Find duplicate pairs via embedding similarity
    const { data: pairs, error } = await db.rpc("find_duplicate_sources", {
      p_similarity_threshold: similarityThreshold,
      p_batch_size: batchSize,
      p_max_pairs: maxPairs,
    });

    if (error) {
      log.error("dedup_rpc_failed", error);
      throw new Error(`Dedup RPC failed: ${error.message}`);
    }

    const duplicates = pairs ?? [];
    log.info("duplicates_found", { count: duplicates.length });

    if (dryRun) {
      return corsResponse(
        {
          dry_run: true,
          duplicates_found: duplicates.length,
          pairs: duplicates.map((p: any) => ({
            source_a: { id: p.source_a_id, type: p.source_a_type, title: p.source_a_title },
            source_b: { id: p.source_b_id, type: p.source_b_type, title: p.source_b_title },
            similarity: p.similarity,
          })),
        },
        200,
        { "x-request-id": requestId },
      );
    }

    // Merge duplicates
    let merged = 0;
    let failed = 0;
    const mergedIds = new Set<string>();

    for (const pair of duplicates) {
      // Skip if either source was already merged in this run
      if (mergedIds.has(pair.source_a_id) || mergedIds.has(pair.source_b_id)) continue;

      try {
        const { loser } = await mergePair(
          pair.source_a_id,
          pair.source_b_id,
          pair.source_a_type,
          pair.source_b_type,
          log,
        );
        mergedIds.add(loser);
        merged++;
      } catch (err) {
        log.error("merge_failed", err, {
          source_a: pair.source_a_id,
          source_b: pair.source_b_id,
        });
        failed++;
      }
    }

    const response = {
      duplicates_found: duplicates.length,
      merged,
      failed,
      skipped: duplicates.length - merged - failed,
    };

    log.info("dedup_complete", response);
    return corsResponse(response, 200, { "x-request-id": requestId });
  } catch (err) {
    log.error("dedup_failed", err);

    if (err instanceof AppError) {
      return corsResponse(
        { error: { code: err.code, message: err.message } },
        err.statusCode,
        { "x-request-id": requestId },
      );
    }

    return corsResponse(
      { error: { code: "INTERNAL_ERROR", message: "Dedup sweep failed" } },
      500,
      { "x-request-id": requestId },
    );
  }
});
