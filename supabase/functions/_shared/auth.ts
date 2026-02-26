import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { AuthError } from "./errors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("ANON_KEY") ?? "";

/** Service-role client — for DB writes that bypass RLS */
export function getServiceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

export interface AuthResult {
  userId: string;
  authMethod: "jwt" | "api_key";
}

/**
 * Authenticate a request via JWT (Supabase Auth) or API key.
 * Returns the user ID and auth method used.
 */
export async function authenticateRequest(
  req: Request,
  db: SupabaseClient,
): Promise<AuthResult> {
  // 1. Check for API key (x-api-key header)
  const apiKey = req.headers.get("x-api-key");
  if (apiKey) {
    return await validateApiKey(apiKey, db);
  }

  // 2. Fall back to JWT (Authorization: Bearer <token>)
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new AuthError("Missing authorization: provide Bearer token or x-api-key header");
  }

  const token = authHeader.replace("Bearer ", "");
  return await validateJwt(token);
}

async function validateJwt(token: string): Promise<AuthResult> {
  const authClient = createClient(
    SUPABASE_URL,
    ANON_KEY,
    { global: { headers: { Authorization: `Bearer ${token}` } } },
  );
  const { data: { user }, error } = await authClient.auth.getUser();
  if (error || !user) throw new AuthError("Invalid or expired token");
  return { userId: user.id, authMethod: "jwt" };
}

async function validateApiKey(key: string, db: SupabaseClient): Promise<AuthResult> {
  // Hash the key and look it up
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(key));
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const { data, error } = await db.rpc("validate_api_key", {
    p_key_hash: hashHex,
  });

  if (error || !data?.length) {
    throw new AuthError("Invalid or revoked API key");
  }

  return { userId: data[0].user_id, authMethod: "api_key" };
}
