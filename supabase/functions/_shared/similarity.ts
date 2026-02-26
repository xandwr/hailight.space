import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { Logger } from "./logger.ts";

export interface CrossQueryMatch {
  source_index: number;
  matched_source_id: string;
  matched_title: string;
  matched_url: string;
  matched_query: string;
  similarity: number;
}

/**
 * Find sources from OTHER queries that are semantically similar
 * to the sources in the current query. Probe-derived threshold: 0.54.
 */
export async function findRelatedSources(
  embeddings: number[][],
  currentQueryId: string,
  db: SupabaseClient,
  log: Logger,
  threshold = 0.54,
  limit = 5,
): Promise<CrossQueryMatch[]> {
  log.info("cross_query_start", { source_count: embeddings.length, threshold });

  // Fire all similarity searches in parallel
  const results = await Promise.allSettled(
    embeddings.map(async (embedding, i) => {
      const vecStr = `[${embedding.join(",")}]`;
      const { data, error } = await db.rpc("match_sources", {
        query_embedding: vecStr,
        match_threshold: threshold,
        match_count: limit,
        exclude_query_id: currentQueryId,
      });
      if (error) {
        log.warn("cross_query_rpc_error", { source_index: i, error: error.message });
        return [];
      }
      return (data ?? []).map((m: any) => ({
        source_index: i,
        matched_source_id: m.id,
        matched_title: m.title,
        matched_url: m.url,
        matched_query: m.raw_input,
        similarity: m.similarity,
      }));
    }),
  );

  const matches: CrossQueryMatch[] = results
    .filter((r): r is PromiseFulfilledResult<CrossQueryMatch[]> => r.status === "fulfilled")
    .flatMap((r) => r.value);

  log.info("cross_query_done", { matches: matches.length });
  return matches;
}
