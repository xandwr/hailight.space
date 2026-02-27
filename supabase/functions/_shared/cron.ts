import { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/**
 * Log cron execution start. Returns the execution ID for completion tracking.
 */
export async function logCronStart(
  db: SupabaseClient,
  jobName: string,
): Promise<bigint | null> {
  try {
    const { data, error } = await db.rpc("log_cron_execution", {
      p_job_name: jobName,
    });
    if (error) {
      console.error("cron_log_start_failed", error.message);
      return null;
    }
    return data;
  } catch {
    return null; // Never block the actual job
  }
}

/**
 * Log cron execution completion with result data.
 */
export async function logCronEnd(
  db: SupabaseClient,
  execId: bigint | null,
  status: "completed" | "failed" | "timeout",
  httpStatus: number,
  result?: Record<string, unknown>,
  error?: string,
): Promise<void> {
  if (execId === null) return;
  try {
    await db.rpc("complete_cron_execution", {
      p_id: execId,
      p_status: status,
      p_http_status: httpStatus,
      p_result: result ?? null,
      p_error: error ?? null,
    });
  } catch {
    // Never block the response
  }
}
