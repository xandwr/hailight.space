import { withRetry, resilientFetch, isRetryable } from "./retry.ts";
import { ExternalServiceError } from "./errors.ts";
import { Logger } from "./logger.ts";

const EXA_API_KEY = Deno.env.get("EXA_API_KEY")!;

export interface ExaResult {
  url: string;
  title: string;
  author: string | null;
  publishedDate: string | null;
  text: string;
  summary: string;
  highlights: string[];
  score: number | null;
}

export async function searchExa(
  query: string,
  log: Logger,
  numResults = 10,
): Promise<ExaResult[]> {
  log.info("exa_search_start", { query_length: query.length, numResults });

  const resp = await withRetry(
    () =>
      resilientFetch(
        "https://api.exa.ai/search",
        {
          method: "POST",
          headers: {
            "x-api-key": EXA_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query,
            numResults,
            type: "auto",
            contents: {
              text: { maxCharacters: 3000 },
              highlights: { numSentences: 3, highlightsPerUrl: 3 },
              summary: { query },
            },
          }),
        },
        "Exa/search",
      ),
    { maxAttempts: 2, shouldRetry: isRetryable },
  ).catch((err) => {
    const statusCode = (err as any).statusCode ?? 0;
    throw new ExternalServiceError("Exa/search", statusCode, err.message);
  });

  const data = await resp.json();
  const results: ExaResult[] = data.results.map((r: any) => ({
    url: r.url,
    title: r.title,
    author: r.author ?? null,
    publishedDate: r.publishedDate ?? null,
    text: r.text ?? "",
    summary: r.summary ?? "",
    highlights: r.highlights ?? [],
    score: r.score ?? null,
  }));

  log.info("exa_search_done", { results_count: results.length });
  return results;
}
