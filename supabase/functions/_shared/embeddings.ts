import { withRetry, resilientFetch, isRetryable } from "./retry.ts";
import { ExternalServiceError } from "./errors.ts";
import { Logger } from "./logger.ts";

const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const EMBEDDING_MODEL = "qwen/qwen3-embedding-8b";
const EMBEDDING_DIMS = 1536;

export { EMBEDDING_DIMS };

/**
 * Embed an array of texts via OpenRouter. Retries on 5xx/network errors.
 * Returns embeddings in the same order as input texts.
 */
export async function embedTexts(
  texts: string[],
  log: Logger,
): Promise<number[][]> {
  log.info("embedding_start", { count: texts.length, model: EMBEDDING_MODEL });

  const resp = await withRetry(
    () =>
      resilientFetch(
        "https://openrouter.ai/api/v1/embeddings",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: EMBEDDING_MODEL,
            input: texts,
            dimensions: EMBEDDING_DIMS,
          }),
        },
        "OpenRouter/embeddings",
      ),
    { maxAttempts: 3, shouldRetry: isRetryable },
  ).catch((err) => {
    const statusCode = (err as any).statusCode ?? 0;
    throw new ExternalServiceError("OpenRouter/embeddings", statusCode, err.message);
  });

  const data = await resp.json();
  const embeddings: number[][] = data.data
    .sort((a: any, b: any) => a.index - b.index)
    .map((d: any) => d.embedding);

  log.info("embedding_done", { count: embeddings.length });
  return embeddings;
}
