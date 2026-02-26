import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const EXA_API_KEY = Deno.env.get("EXA_API_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- Exa Search ---
async function searchExa(query: string): Promise<ExaResult[]> {
  const resp = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "x-api-key": EXA_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      numResults: 10,
      type: "auto",
      contents: {
        text: { maxCharacters: 3000 },
        highlights: { numSentences: 3, highlightsPerUrl: 3 },
        summary: { query },
      },
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Exa search failed: ${resp.status} ${err}`);
  }

  const data = await resp.json();
  return data.results.map((r: any) => ({
    url: r.url,
    title: r.title,
    author: r.author ?? null,
    publishedDate: r.publishedDate ?? null,
    text: r.text ?? "",
    summary: r.summary ?? "",
    highlights: r.highlights ?? [],
    score: r.score ?? null,
  }));
}

interface ExaResult {
  url: string;
  title: string;
  author: string | null;
  publishedDate: string | null;
  text: string;
  summary: string;
  highlights: string[];
  score: number | null;
}

// --- OpenRouter LLM ---
async function analyzeConnections(
  query: string,
  sources: ExaResult[],
): Promise<LLMAnalysis> {
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

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "anthropic/claude-sonnet-4",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 4000,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenRouter failed: ${resp.status} ${err}`);
  }

  const data = await resp.json();
  const content = data.choices[0].message.content;

  try {
    return JSON.parse(content);
  } catch {
    // Try to extract JSON from the response if it has extra text
    const match = content.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Failed to parse LLM response as JSON: ${content.slice(0, 200)}`);
  }
}

interface LLMAnalysis {
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

// --- Main Handler ---
Deno.serve(async (req) => {
  // CORS
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
      },
    });
  }

  if (req.method !== "POST") {
    return Response.json({ error: "POST only" }, { status: 405 });
  }

  try {
    const { query } = await req.json();
    if (!query || typeof query !== "string") {
      return Response.json({ error: "Missing 'query' string" }, { status: 400 });
    }

    // 1. Create query record
    const { data: queryRow, error: queryErr } = await supabase
      .from("queries")
      .insert({ raw_input: query })
      .select("id")
      .single();

    if (queryErr) throw queryErr;
    const queryId = queryRow.id;

    // 2. Search with Exa
    const exaResults = await searchExa(query);

    // 3. Store sources
    const sourceRows = exaResults.map((r) => ({
      query_id: queryId,
      url: r.url,
      title: r.title,
      author: r.author,
      published_at: r.publishedDate,
      snippet: r.summary,
      full_text: r.text,
      exa_score: r.score,
    }));

    const { data: insertedSources, error: sourceErr } = await supabase
      .from("sources")
      .insert(sourceRows)
      .select("id");

    if (sourceErr) throw sourceErr;

    // 4. Analyze connections with LLM
    const analysis = await analyzeConnections(query, exaResults);

    // 5. Store connections
    if (analysis.connections.length > 0) {
      const connectionRows = analysis.connections
        .filter(
          (c) =>
            c.source_a_index < insertedSources.length &&
            c.source_b_index < insertedSources.length &&
            c.source_a_index !== c.source_b_index,
        )
        .map((c) => ({
          query_id: queryId,
          source_a_id: insertedSources[c.source_a_index].id,
          source_b_id: insertedSources[c.source_b_index].id,
          relationship: c.relationship,
          explanation: c.explanation,
          strength: Math.max(0, Math.min(1, c.strength)),
        }));

      if (connectionRows.length > 0) {
        const { error: connErr } = await supabase
          .from("connections")
          .insert(connectionRows);
        if (connErr) throw connErr;
      }
    }

    // 6. Store synthesis
    const { error: synthErr } = await supabase.from("syntheses").insert({
      query_id: queryId,
      summary: analysis.synthesis,
      gaps_identified: analysis.gaps,
      follow_up_questions: analysis.follow_up_questions,
      model: "anthropic/claude-sonnet-4",
    });

    if (synthErr) throw synthErr;

    // 7. Return everything
    return Response.json(
      {
        query_id: queryId,
        sources: exaResults.map((r, i) => ({
          id: insertedSources[i].id,
          url: r.url,
          title: r.title,
          summary: r.summary,
          highlights: r.highlights,
          score: r.score,
        })),
        connections: analysis.connections.map((c) => ({
          source_a: exaResults[c.source_a_index]?.title,
          source_b: exaResults[c.source_b_index]?.title,
          relationship: c.relationship,
          explanation: c.explanation,
          strength: c.strength,
        })),
        synthesis: analysis.synthesis,
        gaps: analysis.gaps,
        follow_up_questions: analysis.follow_up_questions,
      },
      {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        },
      },
    );
  } catch (err) {
    console.error("Search pipeline error:", err);
    return Response.json(
      { error: err.message ?? "Internal error" },
      {
        status: 500,
        headers: { "Access-Control-Allow-Origin": "*" },
      },
    );
  }
});
