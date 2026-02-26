import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { AppError } from "../_shared/errors.ts";
import { Logger, createRequestId } from "../_shared/logger.ts";
import { corsResponse, corsOptions } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/auth.ts";
import { embedTexts } from "../_shared/embeddings.ts";
import { withRetry, isRetryable } from "../_shared/retry.ts";
import { ExternalServiceError } from "../_shared/errors.ts";

const DAEMON_SECRET = Deno.env.get("DAEMON_SECRET") ?? "";
const OPENALEX_API_KEY = Deno.env.get("OPENALEX_API_KEY") ?? "";
const OPENALEX_MAILTO = Deno.env.get("OPENALEX_MAILTO") ?? "admin@hailight.space";
const db = getServiceClient();

const OPENALEX_BASE = "https://api.openalex.org/works";

// Batch size for embedding (match arXiv harvester)
const EMBED_BATCH_SIZE = 50;

// Max results per API page (OpenAlex max is 200)
const PAGE_SIZE = 200;

// Level 0 concept IDs (OpenAlex)
// C41008148 = Computer Science, C33923547 = Mathematics, C121332964 = Physics
// has_abstract filters out works without usable text (saves embedding costs)
const CONCEPT_FILTER = "concepts.id:C41008148|C33923547|C121332964,has_abstract:true";

interface OpenAlexWork {
  openalexId: string;
  doi: string | null;
  title: string;
  abstract: string;
  authors: string[];
  topics: string[];
  publicationDate: string;
  citedByCount: number;
  url: string;
  type: string;
}

/**
 * Reconstruct abstract text from OpenAlex's inverted index format.
 * Keys are words (with attached punctuation), values are position arrays.
 */
function reconstructAbstract(
  invertedIndex: Record<string, number[]> | null,
): string {
  if (!invertedIndex) return "";

  let maxPos = 0;
  for (const positions of Object.values(invertedIndex)) {
    for (const pos of positions) {
      if (pos > maxPos) maxPos = pos;
    }
  }

  const words = new Array<string>(maxPos + 1).fill("");
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) {
      words[pos] = word;
    }
  }

  return words.join(" ").trim();
}

/**
 * Extract short OpenAlex ID from full URL.
 * "https://openalex.org/W2741809807" → "W2741809807"
 */
function extractId(url: string): string {
  return url.split("/").pop() ?? url;
}

/**
 * Parse an OpenAlex API response into our internal format.
 */
function parseWorks(results: any[]): OpenAlexWork[] {
  const works: OpenAlexWork[] = [];

  for (const work of results) {
    const abstract = reconstructAbstract(work.abstract_inverted_index);
    // Skip works without usable abstracts
    if (!abstract || abstract.length < 50) continue;

    const title = work.display_name ?? work.title ?? "";
    if (!title) continue;

    const openalexId = extractId(work.id);

    const authors = (work.authorships ?? []).map(
      (a: any) => a.author?.display_name ?? "",
    ).filter(Boolean);

    // Collect topic labels
    const topics = (work.topics ?? []).map(
      (t: any) => t.display_name,
    ).filter(Boolean);

    const publicationDate = work.publication_date
      ? `${work.publication_date}T00:00:00Z`
      : new Date().toISOString();

    const doi = work.doi ?? null;
    const url = doi ?? work.primary_location?.landing_page_url ?? `https://openalex.org/${openalexId}`;

    works.push({
      openalexId,
      doi,
      title,
      abstract,
      authors,
      topics,
      publicationDate,
      citedByCount: work.cited_by_count ?? 0,
      url,
      type: work.type ?? "unknown",
    });
  }

  return works;
}

/**
 * Fetch a page of works from OpenAlex API.
 */
async function fetchOpenAlexPage(
  cursor: string,
  filter: string,
  log: Logger,
): Promise<{
  works: OpenAlexWork[];
  nextCursor: string | null;
  totalCount: number | null;
}> {
  const params = new URLSearchParams({
    filter,
    per_page: String(PAGE_SIZE),
    cursor,
    select:
      "id,doi,display_name,publication_date,abstract_inverted_index,authorships,topics,type,cited_by_count,primary_location,open_access",
    mailto: OPENALEX_MAILTO,
  });

  if (OPENALEX_API_KEY) {
    params.set("api_key", OPENALEX_API_KEY);
  }

  const url = `${OPENALEX_BASE}?${params}`;
  log.info("openalex_fetch_start", { url: url.slice(0, 300) });

  const resp = await withRetry(
    async () => {
      const r = await fetch(url, {
        headers: {
          "User-Agent": `HailightHarvester/1.0 (mailto:${OPENALEX_MAILTO})`,
        },
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        const err = new Error(`OpenAlex: ${r.status} ${body.slice(0, 200)}`);
        (err as any).statusCode = r.status;
        (err as any).retryable = r.status >= 500 || r.status === 429;
        throw err;
      }
      return r;
    },
    {
      maxAttempts: 4,
      baseDelayMs: 1000,
      maxDelayMs: 15000,
      shouldRetry: (err) => {
        // Retry 429 (rate limit) and 5xx
        if ((err as any)?.retryable) return true;
        return isRetryable(err);
      },
    },
  );

  const data = await resp.json();
  const meta = data.meta ?? {};
  const works = parseWorks(data.results ?? []);

  log.info("openalex_fetch_done", {
    works_in_page: works.length,
    raw_results: (data.results ?? []).length,
    total_count: meta.count,
    has_more: !!meta.next_cursor,
  });

  return {
    works,
    nextCursor: meta.next_cursor ?? null,
    totalCount: meta.count ?? null,
  };
}

/**
 * Embed and insert a batch of works.
 */
async function embedAndInsertBatch(
  works: OpenAlexWork[],
  log: Logger,
): Promise<{ inserted: number; skipped: number }> {
  if (works.length === 0) return { inserted: 0, skipped: 0 };

  // Dedup layer 1: by external_id (same source re-ingest)
  const externalIds = works.map((w) => w.openalexId);
  const { data: existing } = await db
    .from("sources")
    .select("external_id")
    .eq("source_type", "openalex")
    .in("external_id", externalIds);

  const existingIds = new Set(
    (existing ?? []).map((e: any) => e.external_id),
  );

  // Dedup layer 2: by DOI (cross-source, e.g. already ingested via arXiv)
  const doisToCheck = works
    .filter((w) => w.doi && !existingIds.has(w.openalexId))
    .map((w) => w.doi!);
  const existingDois = new Set<string>();
  if (doisToCheck.length > 0) {
    const { data: doiMatches } = await db
      .from("sources")
      .select("doi")
      .in("doi", doisToCheck);
    for (const m of doiMatches ?? []) existingDois.add(m.doi);
  }

  const newWorks = works.filter(
    (w) => !existingIds.has(w.openalexId) && !(w.doi && existingDois.has(w.doi)),
  );

  if (newWorks.length === 0) {
    log.info("batch_all_duplicates", {
      skipped: works.length,
      by_id: existingIds.size,
      by_doi: existingDois.size,
    });
    return { inserted: 0, skipped: works.length };
  }

  // Embed in sub-batches
  const allEmbeddings: number[][] = [];
  for (let i = 0; i < newWorks.length; i += EMBED_BATCH_SIZE) {
    const batch = newWorks.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map((w) => `${w.title}\n\n${w.abstract}`);
    const embeddings = await embedTexts(texts, log);
    allEmbeddings.push(...embeddings);
  }

  // Build rows for sources table
  const rows = newWorks.map((work, idx) => ({
    url: work.url,
    title: work.title,
    author: work.authors.join(", "),
    published_at: work.publicationDate,
    snippet: work.abstract.slice(0, 500),
    full_text: work.abstract,
    embedding: JSON.stringify(allEmbeddings[idx]),
    exa_score: null,
    source_type: "openalex",
    external_id: work.openalexId,
    doi: work.doi,
    categories: work.topics.slice(0, 10), // Top 10 topic labels
  }));

  // Insert in chunks to avoid payload limits
  const CHUNK_SIZE = 100;
  let totalInserted = 0;

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const { error } = await db.from("sources").upsert(chunk, {
      onConflict: "source_type,external_id",
      ignoreDuplicates: true,
    });
    if (error) {
      log.error("insert_error", error, {
        chunk_offset: i,
        chunk_size: chunk.length,
      });
      throw new Error(`DB insert failed: ${error.message}`);
    }
    totalInserted += chunk.length;
  }

  log.info("batch_inserted", {
    inserted: totalInserted,
    skipped: works.length - newWorks.length,
  });

  return { inserted: totalInserted, skipped: works.length - newWorks.length };
}

/**
 * Main handler: harvest scholarly works from OpenAlex.
 *
 * POST body:
 * - cursor: string | null — continue from previous harvest ("*" for fresh start)
 * - filter: string | null — OpenAlex filter override (default: CS topics + recent)
 * - from_date: string | null — ISO date (YYYY-MM-DD) for incremental harvest
 * - max_pages: number — max pages to fetch (default: 8, max: 20)
 */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsOptions();

  const requestId = req.headers.get("x-request-id") ?? createRequestId();
  const log = new Logger({
    request_id: requestId,
    endpoint: "ingest-openalex",
  });

  try {
    // Auth: daemon secret only
    const authHeader = req.headers.get("Authorization");
    const providedSecret = authHeader?.replace("Bearer ", "") ?? "";
    if (!DAEMON_SECRET || providedSecret !== DAEMON_SECRET) {
      throw new AppError("Unauthorized", 401, "UNAUTHORIZED");
    }

    const body = req.method === "POST" ? await req.json() : {};
    const maxPages: number = Math.min(body.max_pages ?? 8, 20);

    // Load harvest state (maybeSingle: no error if row doesn't exist yet)
    const { data: state } = await db
      .from("harvest_state")
      .select("*")
      .eq("source_type", "openalex")
      .maybeSingle();

    // Determine cursor: body override > saved state > fresh start
    let cursor: string = body.cursor ?? state?.resumption_token ?? "*";

    // Build filter
    const fromDate: string | null =
      body.from_date ??
      (state?.is_complete
        ? state?.last_from_date ?? new Date().toISOString().slice(0, 10)
        : state?.last_from_date) ??
      null;

    let filter = body.filter ?? CONCEPT_FILTER;
    if (fromDate && !body.filter) {
      // Use from_updated_date for incremental, from_publication_date for initial
      const dateFilter = state?.is_complete
        ? `from_updated_date:${fromDate}`
        : `from_publication_date:${fromDate}`;
      filter = `${filter},${dateFilter}`;
    }

    // If previous harvest completed and no new from_date, start fresh from recent
    if (state?.is_complete && !body.from_date && !body.cursor) {
      const lastDate = state.last_from_date ?? new Date().toISOString().slice(0, 10);
      filter = `${CONCEPT_FILTER},from_updated_date:${lastDate}`;
      cursor = "*";
    }

    log.info("harvest_start", {
      cursor: cursor.slice(0, 50),
      filter,
      max_pages: maxPages,
      resuming: cursor !== "*",
    });

    let totalInserted = 0;
    let totalSkipped = 0;
    let pagesProcessed = 0;
    let totalCount: number | null = null;

    for (let page = 0; page < maxPages; page++) {
      const result = await fetchOpenAlexPage(cursor, filter, log);

      if (result.totalCount) totalCount = result.totalCount;

      const { inserted, skipped } = await embedAndInsertBatch(
        result.works,
        log,
      );
      totalInserted += inserted;
      totalSkipped += skipped;
      pagesProcessed++;

      log.info("page_complete", {
        page: page + 1,
        inserted,
        skipped,
        has_more: !!result.nextCursor,
      });

      if (!result.nextCursor) {
        cursor = "*"; // Signal completion
        break;
      }

      cursor = result.nextCursor;
    }

    const isComplete = cursor === "*";

    // Persist harvest state
    await db.from("harvest_state").upsert(
      {
        source_type: "openalex",
        resumption_token: isComplete ? null : cursor,
        last_from_date: fromDate ?? new Date().toISOString().slice(0, 10),
        last_harvested_at: new Date().toISOString(),
        total_ingested: (state?.total_ingested ?? 0) + totalInserted,
        is_complete: isComplete,
      },
      { onConflict: "source_type" },
    );

    const response = {
      pages_processed: pagesProcessed,
      works_inserted: totalInserted,
      works_skipped: totalSkipped,
      total_count: totalCount,
      cursor: isComplete ? null : cursor,
      has_more: !isComplete,
    };

    log.info("harvest_complete", response);

    return corsResponse(response, 200, { "x-request-id": requestId });
  } catch (err) {
    log.error("harvest_failed", err);

    if (err instanceof AppError) {
      return corsResponse(
        { error: { code: err.code, message: err.message } },
        err.statusCode,
        { "x-request-id": requestId },
      );
    }

    return corsResponse(
      { error: { code: "INTERNAL_ERROR", message: "Harvest failed" } },
      500,
      { "x-request-id": requestId },
    );
  }
});
