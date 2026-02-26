import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { AppError } from "../_shared/errors.ts";
import { Logger, createRequestId } from "../_shared/logger.ts";
import { corsResponse, corsOptions } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/auth.ts";
import { embedTexts } from "../_shared/embeddings.ts";
import { withRetry, isRetryable } from "../_shared/retry.ts";
import { ExternalServiceError } from "../_shared/errors.ts";

const DAEMON_SECRET = Deno.env.get("DAEMON_SECRET") ?? "";
const db = getServiceClient();

// arXiv OAI-PMH endpoint (migrated from export.arxiv.org/oai2 in 2025)
const OAI_BASE = "https://oaipmh.arxiv.org/oai";

// CS subcategories we want
const ARXIV_CS_SET = "cs";

// Batch size for embedding (OpenRouter limit is ~2048 inputs, but keep reasonable)
const EMBED_BATCH_SIZE = 50;

interface ArxivPaper {
  arxivId: string;
  title: string;
  abstract: string;
  authors: string[];
  categories: string[];
  publishedAt: string;
  url: string;
}

/** Extract text between XML tags (handles namespaced and non-namespaced) */
function xmlTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

/** Extract all matches of a tag */
function xmlTagAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  const results: string[] = [];
  let m;
  while ((m = re.exec(xml)) !== null) results.push(m[1].trim());
  return results;
}

/**
 * Parse arXiv OAI-PMH XML response via regex.
 * Regex is more reliable than DOMParser for namespaced arXiv XML in edge runtime.
 */
function parseOaiResponse(xml: string): {
  papers: ArxivPaper[];
  resumptionToken: string | null;
  completeListSize: number | null;
} {
  // Check for OAI-PMH errors
  const errorMatch = xml.match(/<error\s+code="([^"]*)"[^>]*>([^<]*)<\/error>/);
  if (errorMatch) {
    throw new Error(`OAI-PMH error: ${errorMatch[1]} - ${errorMatch[2]}`);
  }

  const papers: ArxivPaper[] = [];

  // Split into records
  const recordRegex = /<record>([\s\S]*?)<\/record>/gi;
  let recordMatch;
  while ((recordMatch = recordRegex.exec(xml)) !== null) {
    const rec = recordMatch[1];

    // Skip deleted records
    if (rec.includes('status="deleted"')) continue;

    // Extract arXiv metadata block
    const arxivBlock = rec.match(/<arXiv[\s\S]*?<\/arXiv>/)?.[0];
    if (!arxivBlock) continue;

    const arxivId = xmlTag(arxivBlock, "id");
    const abstract = xmlTag(arxivBlock, "abstract");
    if (!arxivId || !abstract || abstract.length < 50) continue;

    const title = (xmlTag(arxivBlock, "title") ?? "").replace(/\s+/g, " ");

    // Parse authors: extract each <author> block
    const authorBlocks = xmlTagAll(arxivBlock, "author");
    const authors = authorBlocks.map((block) => {
      const keyname = xmlTag(block, "keyname") ?? "";
      const forenames = xmlTag(block, "forenames") ?? "";
      return `${forenames} ${keyname}`.trim();
    });

    // Categories
    const categoriesStr = xmlTag(arxivBlock, "categories") ?? "";
    const categories = categoriesStr.split(/\s+/).filter(Boolean);

    // Date
    const created = xmlTag(arxivBlock, "created") ?? "";
    const publishedAt = created ? `${created}T00:00:00Z` : new Date().toISOString();

    papers.push({
      arxivId,
      title,
      abstract: abstract.replace(/\s+/g, " "),
      authors,
      categories,
      publishedAt,
      url: `https://arxiv.org/abs/${arxivId}`,
    });
  }

  // Resumption token
  const tokenMatch = xml.match(
    /<resumptionToken(?:\s[^>]*)?>([^<]*)<\/resumptionToken>/,
  );
  const resumptionToken = tokenMatch?.[1]?.trim() || null;
  const sizeMatch = xml.match(/completeListSize=['"](\d+)['"]/);
  const completeListSize = sizeMatch ? parseInt(sizeMatch[1], 10) : null;

  return { papers, resumptionToken, completeListSize };
}

/**
 * Fetch a page of papers from arXiv OAI-PMH.
 */
async function fetchArxivPage(
  resumptionToken: string | null,
  fromDate: string | null,
  log: Logger,
): Promise<{ papers: ArxivPaper[]; resumptionToken: string | null; completeListSize: number | null }> {
  let url: string;

  if (resumptionToken) {
    // Continue from resumption token (arXiv returns it already URL-encoded)
    url = `${OAI_BASE}?verb=ListRecords&resumptionToken=${resumptionToken}`;
  } else {
    // Initial request — fetch CS papers
    url = `${OAI_BASE}?verb=ListRecords&metadataPrefix=arXiv&set=${ARXIV_CS_SET}`;
    if (fromDate) {
      url += `&from=${fromDate}`;
    }
  }

  log.info("oai_fetch_start", { url: url.slice(0, 200) });

  const resp = await withRetry(
    async () => {
      const r = await fetch(url);
      if (!r.ok) {
        const err = new Error(`OAI-PMH: ${r.status}`);
        (err as any).statusCode = r.status;
        // 503 with Retry-After is arXiv's rate limit signal
        (err as any).retryable = r.status === 503 || r.status >= 500;
        throw err;
      }
      return r;
    },
    {
      maxAttempts: 5,
      baseDelayMs: 3000, // arXiv asks for 3s between requests
      maxDelayMs: 30000,
      shouldRetry: isRetryable,
    },
  );

  const xml = await resp.text();
  const result = parseOaiResponse(xml);

  log.info("oai_fetch_done", {
    papers_in_page: result.papers.length,
    has_more: !!result.resumptionToken,
    complete_list_size: result.completeListSize,
  });

  return result;
}

/**
 * Embed and insert a batch of papers.
 */
async function embedAndInsertBatch(
  papers: ArxivPaper[],
  log: Logger,
): Promise<{ inserted: number; skipped: number }> {
  if (papers.length === 0) return { inserted: 0, skipped: 0 };

  // Check which papers we already have (dedup by external_id)
  const arxivIds = papers.map((p) => p.arxivId);
  const { data: existing } = await db
    .from("sources")
    .select("external_id")
    .eq("source_type", "arxiv")
    .in("external_id", arxivIds);

  const existingIds = new Set((existing ?? []).map((e: any) => e.external_id));
  const newPapers = papers.filter((p) => !existingIds.has(p.arxivId));

  if (newPapers.length === 0) {
    log.info("batch_all_duplicates", { skipped: papers.length });
    return { inserted: 0, skipped: papers.length };
  }

  // Embed abstracts in sub-batches
  const allEmbeddings: number[][] = [];
  for (let i = 0; i < newPapers.length; i += EMBED_BATCH_SIZE) {
    const batch = newPapers.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map((p) => `${p.title}\n\n${p.abstract}`);
    const embeddings = await embedTexts(texts, log);
    allEmbeddings.push(...embeddings);
  }

  // Insert into sources
  const rows = newPapers.map((paper, idx) => ({
    url: paper.url,
    title: paper.title,
    author: paper.authors.join(", "),
    published_at: paper.publishedAt,
    snippet: paper.abstract.slice(0, 500),
    full_text: paper.abstract,
    embedding: JSON.stringify(allEmbeddings[idx]),
    exa_score: null,
    source_type: "arxiv",
    external_id: paper.arxivId,
    categories: paper.categories,
  }));

  // Insert in chunks to avoid payload size limits
  const CHUNK_SIZE = 100;
  let totalInserted = 0;

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const { error } = await db.from("sources").upsert(chunk, {
      onConflict: "source_type,external_id",
      ignoreDuplicates: true,
    });
    if (error) {
      log.error("insert_error", error, { chunk_offset: i, chunk_size: chunk.length });
      throw new Error(`DB insert failed: ${error.message}`);
    }
    totalInserted += chunk.length;
  }

  log.info("batch_inserted", {
    inserted: totalInserted,
    skipped: papers.length - newPapers.length,
  });

  return { inserted: totalInserted, skipped: papers.length - newPapers.length };
}

/**
 * Main handler: harvest arXiv papers via OAI-PMH.
 *
 * POST body:
 * - resumption_token: string | null — continue from previous harvest
 * - from_date: string | null — ISO date (YYYY-MM-DD) to start from
 * - max_pages: number — max pages to fetch in this invocation (default: 3)
 */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsOptions();

  const requestId = req.headers.get("x-request-id") ?? createRequestId();
  const log = new Logger({ request_id: requestId, endpoint: "ingest-arxiv" });

  try {
    // Auth: daemon secret only
    const authHeader = req.headers.get("Authorization");
    const providedSecret = authHeader?.replace("Bearer ", "") ?? "";
    if (!DAEMON_SECRET || providedSecret !== DAEMON_SECRET) {
      throw new AppError("Unauthorized", 401, "UNAUTHORIZED");
    }

    const body = req.method === "POST" ? await req.json() : {};
    const maxPages: number = Math.min(body.max_pages ?? 3, 10);

    // Load harvest state (auto-resume from where we left off)
    const { data: state } = await db
      .from("harvest_state")
      .select("*")
      .eq("source_type", "arxiv")
      .single();

    let resumptionToken: string | null =
      body.resumption_token ?? state?.resumption_token ?? null;
    const fromDate: string | null =
      body.from_date ?? (state?.is_complete ? new Date().toISOString().slice(0, 10) : state?.last_from_date) ?? null;

    log.info("harvest_start", {
      has_token: !!resumptionToken,
      from_date: fromDate,
      max_pages: maxPages,
    });

    let totalInserted = 0;
    let totalSkipped = 0;
    let pagesProcessed = 0;
    let completeListSize: number | null = null;

    for (let page = 0; page < maxPages; page++) {
      // Fetch page from arXiv
      const result = await fetchArxivPage(resumptionToken, fromDate, log);

      if (result.completeListSize) {
        completeListSize = result.completeListSize;
      }

      // Embed and insert
      const { inserted, skipped } = await embedAndInsertBatch(result.papers, log);
      totalInserted += inserted;
      totalSkipped += skipped;
      pagesProcessed++;

      resumptionToken = result.resumptionToken;

      log.info("page_complete", {
        page: page + 1,
        inserted,
        skipped,
        has_more: !!resumptionToken,
      });

      // No more pages
      if (!resumptionToken) break;

      // Rate limit: arXiv asks for 3s between requests
      if (page < maxPages - 1 && resumptionToken) {
        await new Promise((r) => setTimeout(r, 3500));
      }
    }

    // Persist harvest state for next invocation
    await db.from("harvest_state").upsert({
      source_type: "arxiv",
      resumption_token: resumptionToken,
      last_from_date: fromDate,
      last_harvested_at: new Date().toISOString(),
      total_ingested: (state?.total_ingested ?? 0) + totalInserted,
      is_complete: !resumptionToken,
    }, { onConflict: "source_type" });

    const response = {
      pages_processed: pagesProcessed,
      papers_inserted: totalInserted,
      papers_skipped: totalSkipped,
      complete_list_size: completeListSize,
      resumption_token: resumptionToken,
      has_more: !!resumptionToken,
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
