import { withRetry, resilientFetch, isRetryable } from "./retry.ts";
import { ExternalServiceError } from "./errors.ts";
import { Logger } from "./logger.ts";

const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const ANALYSIS_MODEL = "anthropic/claude-sonnet-4";

export interface LLMAnalysis {
  connections: {
    source_a_index: number;
    source_b_index: number;
    relationship: string;
    explanation: string;
    strength: number;
  }[];
  synthesis: string;
  gaps: string[];
  follow_up_questions: string[];
}

export interface SourceSummary {
  title: string;
  url: string;
  summary: string;
  highlights: string[];
}

export async function analyzeConnections(
  query: string,
  sources: SourceSummary[],
  log: Logger,
): Promise<LLMAnalysis> {
  log.info("llm_analysis_start", { source_count: sources.length, model: ANALYSIS_MODEL });

  const sourceSummaries = sources
    .map(
      (s, i) =>
        `[${i + 1}] "${s.title}" (${s.url})\nSummary: ${s.summary}\nHighlights: ${s.highlights.join(" | ")}`,
    )
    .join("\n\n");

  const prompt = `You are a research analyst for Hailight, a tool that surfaces connections and gaps between knowledge sources.

Given this research query: "${query}"

And these sources:
${sourceSummaries}

Analyze the relationships between these sources. For each meaningful pair of sources, identify:
1. The relationship type: "agrees", "contradicts", "extends", or "gap" (where gap means something important is missing between them)
2. A clear explanation of the connection
3. A strength score from 0.0 to 1.0

Then provide:
- A synthesis that weaves these sources together, emphasizing what's BETWEEN them (connections, contradictions, gaps)
- A list of gaps: what important aspects of "${query}" are NOT covered by these sources?
- 3-5 follow-up questions that would fill those gaps

Respond in this exact JSON format:
{
  "connections": [
    {
      "source_a_index": 0,
      "source_b_index": 1,
      "relationship": "agrees|contradicts|extends|gap",
      "explanation": "...",
      "strength": 0.8
    }
  ],
  "synthesis": "...",
  "gaps": ["...", "..."],
  "follow_up_questions": ["...", "..."]
}

Only output valid JSON. No markdown fences.`;

  const resp = await withRetry(
    () =>
      resilientFetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: ANALYSIS_MODEL,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.3,
            max_tokens: 4000,
          }),
        },
        "OpenRouter/chat",
      ),
    { maxAttempts: 2, shouldRetry: isRetryable },
  ).catch((err) => {
    const statusCode = (err as any).statusCode ?? 0;
    throw new ExternalServiceError("OpenRouter/chat", statusCode, err.message);
  });

  const data = await resp.json();
  const content: string = data.choices[0].message.content;

  const analysis = parseJsonResponse<LLMAnalysis>(content);
  log.info("llm_analysis_done", { connections: analysis.connections.length });
  return analysis;
}

export async function generateTopicLabel(
  queryText: string,
  log: Logger,
): Promise<string> {
  log.debug("topic_label_start");

  try {
    const resp = await withRetry(
      () =>
        resilientFetch(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${OPENROUTER_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: ANALYSIS_MODEL,
              messages: [
                {
                  role: "user",
                  content: `Generate a short, evocative research topic label (2-5 words) for this query. The label should capture the broader research area, not just restate the query. Be specific but not verbose. Examples: "Quantum Error Correction", "CRISPR Ethics Landscape", "Neural Architecture Search", "Ocean Acidification Feedback".

Query: "${queryText}"

Respond with ONLY the label, nothing else.`,
                },
              ],
              temperature: 0.5,
              max_tokens: 30,
            }),
          },
          "OpenRouter/chat",
        ),
      { maxAttempts: 2, shouldRetry: isRetryable },
    );

    const data = await resp.json();
    return data.choices[0].message.content.trim().replace(/^["']|["']$/g, "");
  } catch {
    // Graceful degradation: use truncated query as label
    log.warn("topic_label_fallback", { reason: "LLM call failed" });
    return queryText.slice(0, 50);
  }
}

function parseJsonResponse<T>(content: string): T {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Failed to parse LLM response as JSON: ${content.slice(0, 200)}`);
  }
}
