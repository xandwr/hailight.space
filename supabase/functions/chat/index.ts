import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import {
  AppError,
  ExternalServiceError,
  RateLimitError,
  ValidationError,
} from "../_shared/errors.ts";
import { Logger, createRequestId } from "../_shared/logger.ts";
import { corsOptions, CORS_HEADERS } from "../_shared/cors.ts";
import { corsResponse } from "../_shared/cors.ts";
import { authenticateRequest, getServiceClient } from "../_shared/auth.ts";
import { embedTexts } from "../_shared/embeddings.ts";

const db = getServiceClient();
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const CHAT_MODEL = "anthropic/claude-sonnet-4";
const MAX_HISTORY_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 4000;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  ts: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsOptions();

  const requestId = req.headers.get("x-request-id") ?? createRequestId();
  const log = new Logger({ request_id: requestId, endpoint: "chat" });
  const started = performance.now();

  if (req.method !== "POST") {
    return corsResponse(
      { error: { code: "METHOD_NOT_ALLOWED", message: "POST only" } },
      405,
      { "x-request-id": requestId },
    );
  }

  try {
    // --- Auth ---
    const { userId, authMethod } = await authenticateRequest(req, db);
    log.info("authenticated", { auth_method: authMethod });

    // --- Rate limit ---
    const { data: rl, error: rlErr } = await db.rpc("check_rate_limit", {
      p_user_id: userId,
      p_endpoint: "chat",
      p_window_seconds: 60,
      p_max_requests: 20,
    });

    if (rlErr) log.warn("rate_limit_check_failed", { error: rlErr.message });

    if (rl?.[0] && !rl[0].allowed) {
      throw new RateLimitError(rl[0].retry_after_seconds, 0);
    }

    // --- Input validation ---
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new ValidationError("Request body must be valid JSON");
    }

    const message = (body as any)?.message;
    const conversationId = (body as any)?.conversation_id;

    if (!message || typeof message !== "string") {
      throw new ValidationError("Missing 'message' string in request body");
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw new ValidationError(
        `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer`,
      );
    }
    if (message.trim().length < 1) {
      throw new ValidationError("Message cannot be empty");
    }

    const trimmedMessage = message.trim();
    log.info("chat_start", {
      user_id: userId,
      message_length: trimmedMessage.length,
      has_conversation: !!conversationId,
    });

    // --- Load or create conversation ---
    let convId: string;
    let existingMessages: ChatMessage[] = [];

    if (conversationId) {
      const { data: conv, error: convErr } = await db
        .from("conversations")
        .select("id, user_id, messages")
        .eq("id", conversationId)
        .single();

      if (convErr || !conv) {
        throw new ValidationError("Conversation not found");
      }
      if (conv.user_id !== userId) {
        throw new ValidationError("Conversation not found");
      }

      existingMessages = (conv.messages as ChatMessage[]) ?? [];
      convId = conv.id;
    } else {
      // Create new conversation
      const title =
        trimmedMessage.length > 60
          ? trimmedMessage.slice(0, 57) + "..."
          : trimmedMessage;

      const { data: newConv, error: createErr } = await db
        .from("conversations")
        .insert({
          user_id: userId,
          title,
          messages: [],
        })
        .select("id")
        .single();

      if (createErr || !newConv) {
        throw new Error(`Failed to create conversation: ${createErr?.message}`);
      }

      convId = newConv.id;
      log.info("conversation_created", { conversation_id: convId });
    }

    // Append user message
    const userMessage: ChatMessage = {
      role: "user",
      content: trimmedMessage,
      ts: new Date().toISOString(),
    };
    const allMessages = [...existingMessages, userMessage];

    // Update DB with user message immediately
    await db
      .from("conversations")
      .update({
        messages: allMessages,
        updated_at: new Date().toISOString(),
      })
      .eq("id", convId);

    // --- Context gathering (parallel) ---
    const [topicsResult, recentQueriesResult, relevantSourcesResult] =
      await Promise.all([
        db.rpc("get_user_topics", { p_user_id: userId }),

        db
          .from("queries")
          .select("raw_input, created_at")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(10),

        embedAndMatchSources(trimmedMessage, log),
      ]);

    // Build context strings (graceful degradation)
    const topics = topicsResult.data ?? [];
    const recentQueries = recentQueriesResult.data ?? [];
    const relevantSources = relevantSourcesResult;

    if (topicsResult.error)
      log.warn("topics_fetch_failed", { error: topicsResult.error.message });
    if (recentQueriesResult.error)
      log.warn("queries_fetch_failed", {
        error: recentQueriesResult.error.message,
      });

    // Store topic_ids on conversation
    if (topics.length > 0) {
      const topicIds = topics.map((t: any) => t.id);
      await db
        .from("conversations")
        .update({ topic_ids: topicIds })
        .eq("id", convId);
    }

    // --- Build system prompt ---
    const systemPrompt = buildSystemPrompt(
      topics,
      recentQueries,
      relevantSources,
    );

    // --- Build message history for LLM ---
    const historyMessages = allMessages.slice(-MAX_HISTORY_MESSAGES);
    const llmMessages = [
      { role: "system", content: systemPrompt },
      ...historyMessages.map((m) => ({ role: m.role, content: m.content })),
    ];

    log.info("llm_call_start", {
      history_length: historyMessages.length,
      topics: topics.length,
      sources: relevantSources.length,
    });

    // --- Stream from OpenRouter ---
    const openRouterResp = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: CHAT_MODEL,
          messages: llmMessages,
          temperature: 0.4,
          max_tokens: 4000,
          stream: true,
        }),
      },
    );

    if (!openRouterResp.ok) {
      const errBody = await openRouterResp.text();
      throw new ExternalServiceError(
        "OpenRouter/chat",
        openRouterResp.status,
        errBody,
      );
    }

    // Proxy SSE stream to client, accumulating full response for DB storage
    let fullContent = "";
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const stream = new ReadableStream({
      async start(controller) {
        const reader = openRouterResp.body!.getReader();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            controller.enqueue(encoder.encode(chunk));

            // Parse content deltas for DB storage
            const lines = chunk.split("\n");
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6).trim();
              if (data === "[DONE]") continue;
              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) fullContent += delta;
              } catch {
                // skip unparseable lines
              }
            }
          }

          // Stream complete — update conversation in DB
          const assistantMessage: ChatMessage = {
            role: "assistant",
            content: fullContent,
            ts: new Date().toISOString(),
          };

          const updatedMessages = [...allMessages, assistantMessage];

          const { error: updateErr } = await db
            .from("conversations")
            .update({
              messages: updatedMessages,
              updated_at: new Date().toISOString(),
            })
            .eq("id", convId);

          if (updateErr) {
            log.error("conversation_update_failed", updateErr);
          }

          const elapsed = Math.round(performance.now() - started);
          log.info("chat_done", {
            conversation_id: convId,
            response_length: fullContent.length,
            message_count: updatedMessages.length,
            elapsed_ms: elapsed,
          });

          controller.close();
        } catch (err) {
          log.error("stream_error", err);
          controller.error(err);
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "x-request-id": requestId,
        "x-conversation-id": convId,
      },
    });
  } catch (err) {
    const elapsed = Math.round(performance.now() - started);

    if (err instanceof AppError) {
      log.warn("request_failed", {
        status: err.statusCode,
        code: err.code,
        elapsed_ms: elapsed,
      });
      const headers: Record<string, string> = { "x-request-id": requestId };
      if (err instanceof RateLimitError) {
        headers["retry-after"] = String(err.retryAfter);
        headers["x-ratelimit-remaining"] = "0";
      }
      return corsResponse(err.toJSON(), err.statusCode, headers);
    }

    log.error("unhandled_error", err, { elapsed_ms: elapsed });
    return corsResponse(
      { error: { code: "INTERNAL_ERROR", message: "An internal error occurred" } },
      500,
      { "x-request-id": requestId },
    );
  }
});

// --- Helpers ---

async function embedAndMatchSources(
  message: string,
  log: Logger,
): Promise<Array<{ title: string; url: string; snippet: string }>> {
  try {
    const [embedding] = await embedTexts([message], log);

    const { data: sources, error } = await db.rpc("match_sources", {
      query_embedding: `[${embedding.join(",")}]`,
      match_threshold: 0.54,
      match_count: 8,
    });

    if (error) {
      log.warn("match_sources_failed", { error: error.message });
      return [];
    }

    return (sources ?? []).map((s: any) => ({
      title: s.title ?? "Untitled",
      url: s.url ?? "",
      snippet: s.snippet ?? s.full_text?.slice(0, 300) ?? "",
    }));
  } catch (err) {
    log.warn("context_sources_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

function buildSystemPrompt(
  topics: any[],
  recentQueries: any[],
  relevantSources: Array<{ title: string; url: string; snippet: string }>,
): string {
  let prompt = `You are Hailight, a research assistant that helps users explore the space between knowledge — connections, contradictions, and gaps across sources.

You have access to the user's research context:`;

  if (topics.length > 0) {
    prompt += `\n\n## User's Research Topics (${topics.length})
${topics.map((t: any) => `- "${t.label}" (${t.query_count} queries)`).join("\n")}`;
  }

  if (recentQueries.length > 0) {
    prompt += `\n\n## Recent Research Queries
${recentQueries.map((q: any) => `- "${q.raw_input}"`).join("\n")}`;
  }

  if (relevantSources.length > 0) {
    prompt += `\n\n## Relevant Sources (matched to current message)
${relevantSources.map((s, i) => `[${i + 1}] "${s.title}" (${s.url})\n${s.snippet}`).join("\n\n")}`;
  }

  prompt += `\n\n## Guidelines
- Reference specific sources by number when relevant.
- Surface connections between sources and the user's existing research topics.
- Point out gaps or contradictions when you notice them.
- Suggest follow-up research directions when appropriate.
- Be concise and direct. You are a research advisor, not a chatbot.
- When you don't have enough context, say so rather than hallucinating.
- Use markdown formatting for readability.`;

  return prompt;
}
