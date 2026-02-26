import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { AppError, AuthError, ValidationError } from "../_shared/errors.ts";
import { Logger, createRequestId } from "../_shared/logger.ts";
import { corsResponse, corsOptions } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("ANON_KEY") ?? "";

const db = getServiceClient();

/**
 * API key management endpoint.
 *
 * POST   /api-keys         — Create a new API key
 * GET    /api-keys         — List all keys for the authenticated user
 * DELETE /api-keys?id=xxx  — Revoke a key
 *
 * Auth: JWT only (you need to be logged in to manage keys).
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsOptions();

  const requestId = req.headers.get("x-request-id") ?? createRequestId();
  const log = new Logger({ request_id: requestId, endpoint: "api-keys" });

  try {
    // JWT auth only for key management
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      throw new AuthError();
    }

    const token = authHeader.replace("Bearer ", "");
    const authClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user }, error: authErr } = await authClient.auth.getUser();
    if (authErr || !user) throw new AuthError("Invalid or expired token");

    const userId = user.id;
    log.info("authenticated", { user_id: userId });

    const url = new URL(req.url);

    // --- CREATE ---
    if (req.method === "POST") {
      let body: any = {};
      try {
        body = await req.json();
      } catch { /* empty body is fine, use defaults */ }

      const name = typeof body.name === "string" ? body.name.slice(0, 100) : "Default";
      const scopes = Array.isArray(body.scopes) ? body.scopes.filter((s: any) => typeof s === "string") : ["search"];

      // Check existing key count (max 5 per user)
      const { count, error: countErr } = await db
        .from("api_keys")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .is("revoked_at", null);

      if (countErr) throw countErr;
      if ((count ?? 0) >= 5) {
        throw new ValidationError("Maximum 5 active API keys per user");
      }

      // Generate key: hlk_ prefix + 40 random hex chars
      const rawKey = `hlk_${generateRandomHex(40)}`;
      const keyHash = await hashKey(rawKey);
      const keyPrefix = rawKey.slice(0, 12);

      const { data: inserted, error: insertErr } = await db
        .from("api_keys")
        .insert({
          user_id: userId,
          key_hash: keyHash,
          key_prefix: keyPrefix,
          name,
          scopes,
        })
        .select("id, key_prefix, name, scopes, created_at")
        .single();

      if (insertErr) throw insertErr;

      log.info("api_key_created", { key_id: inserted.id, key_prefix: keyPrefix });

      // Return the full key ONCE — it's never stored or retrievable again
      return corsResponse(
        {
          key: rawKey,
          id: inserted.id,
          prefix: inserted.key_prefix,
          name: inserted.name,
          scopes: inserted.scopes,
          created_at: inserted.created_at,
          warning: "Store this key securely. It will not be shown again.",
        },
        201,
        { "x-request-id": requestId },
      );
    }

    // --- LIST ---
    if (req.method === "GET") {
      const { data: keys, error: listErr } = await db
        .from("api_keys")
        .select("id, key_prefix, name, scopes, last_used_at, expires_at, revoked_at, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });

      if (listErr) throw listErr;

      return corsResponse({ keys }, 200, { "x-request-id": requestId });
    }

    // --- REVOKE ---
    if (req.method === "DELETE") {
      const keyId = url.searchParams.get("id");
      if (!keyId) throw new ValidationError("Missing 'id' query parameter");

      const { error: revokeErr } = await db
        .from("api_keys")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", keyId)
        .eq("user_id", userId)
        .is("revoked_at", null);

      if (revokeErr) throw revokeErr;

      log.info("api_key_revoked", { key_id: keyId });
      return corsResponse({ revoked: true }, 200, { "x-request-id": requestId });
    }

    return corsResponse(
      { error: { code: "METHOD_NOT_ALLOWED", message: "Use GET, POST, or DELETE" } },
      405,
      { "x-request-id": requestId },
    );
  } catch (err) {
    if (err instanceof AppError) {
      log.warn("request_failed", { status: err.statusCode, code: err.code });
      return corsResponse(err.toJSON(), err.statusCode, { "x-request-id": requestId });
    }

    log.error("unhandled_error", err);
    return corsResponse(
      { error: { code: "INTERNAL_ERROR", message: "An internal error occurred" } },
      500,
      { "x-request-id": requestId },
    );
  }
});

function generateRandomHex(length: number): string {
  const bytes = new Uint8Array(length / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(key));
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
