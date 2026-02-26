/**
 * Retry with exponential backoff + jitter for external API calls.
 */

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Only retry if this returns true for the error */
  shouldRetry?: (err: unknown) => boolean;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  shouldRetry: () => true,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, shouldRetry } = {
    ...DEFAULT_OPTIONS,
    ...opts,
  };

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts || !shouldRetry!(err)) throw err;

      // Exponential backoff with full jitter
      const expDelay = baseDelayMs * Math.pow(2, attempt - 1);
      const jitteredDelay = Math.random() * Math.min(expDelay, maxDelayMs);
      await new Promise((r) => setTimeout(r, jitteredDelay));
    }
  }

  throw lastError;
}

/**
 * Fetch wrapper that throws on non-2xx and is retryable for 5xx/network errors.
 */
export async function resilientFetch(
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  const resp = await fetch(url, init);

  if (resp.ok) return resp;

  const body = await resp.text().catch(() => "(unreadable body)");

  // 5xx = retryable, 4xx = not
  const err = new Error(`${label}: ${resp.status} ${body}`);
  (err as any).statusCode = resp.status;
  (err as any).retryable = resp.status >= 500;
  throw err;
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof TypeError) return true; // network errors
  if (typeof err === "object" && err !== null && "retryable" in err) {
    return (err as any).retryable === true;
  }
  return false;
}
