import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("ANON_KEY") ?? "";
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const EXA_API_KEY = Deno.env.get("EXA_API_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const EMBEDDING_MODEL = "qwen/qwen3-embedding-8b";
const EMBEDDING_DIMS = 1536;

// --- Embeddings via OpenRouter ---
async function embedTexts(texts: string[]): Promise<number[][]> {
  const resp = await fetch("https://openrouter.ai/api/v1/embeddings", {
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
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Embedding failed: ${resp.status} ${err}`);
  }

  const data = await resp.json();
  return data.data
    .sort((a: any, b: any) => a.index - b.index)
    .map((d: any) => d.embedding);
}

// --- Cross-query similarity search ---
async function findRelatedSources(
  embeddings: number[][],
  currentQueryId: string,
  threshold = 0.54,
  limit = 5,
): Promise<CrossQueryMatch[]> {
  const matches: CrossQueryMatch[] = [];

  for (let i = 0; i < embeddings.length; i++) {
    const vecStr = `[${embeddings[i].join(",")}]`;
    const { data, error } = await supabase.rpc("match_sources", {
      query_embedding: vecStr,
      match_threshold: threshold,
      match_count: limit,
      exclude_query_id: currentQueryId,
    });
    if (!error && data?.length) {
      matches.push(
        ...data.map((m: any) => ({
          source_index: i,
          matched_source_id: m.id,
          matched_title: m.title,
          matched_url: m.url,
          matched_query: m.raw_input,
          similarity: m.similarity,
        })),
      );
    }
  }

  return matches;
}

interface CrossQueryMatch {
  source_index: number;
  matched_source_id: string;
  matched_title: string;
  matched_url: string;
  matched_query: string;
  similarity: number;
}

// --- Topic Classification ---
async function classifyIntoTopic(
  queryText: string,
  queryEmbedding: number[],
  userId: string,
  queryId: string,
): Promise<{ topic_id: string; topic_label: string; is_new: boolean }> {
  const vecStr = `[${queryEmbedding.join(",")}]`;

  // Check for an existing topic that's close enough
  const { data: match, error: matchErr } = await supabase.rpc(
    "match_user_topic",
    {
      p_user_id: userId,
      p_embedding: vecStr,
      p_threshold: 0.71,
    },
  );

  if (!matchErr && match?.length > 0) {
    const topic = match[0];

    // Update the topic's centroid as a running average and bump count
    const { data: existing } = await supabase
      .from("topics")
      .select("embedding, query_count")
      .eq("id", topic.id)
      .single();

    if (existing?.embedding) {
      const oldEmb = existing.embedding as number[];
      const n = existing.query_count;
      // Running average: new_centroid = (old * n + new) / (n + 1)
      const newCentroid = oldEmb.map(
        (v: number, i: number) => (v * n + queryEmbedding[i]) / (n + 1),
      );
      await supabase
        .from("topics")
        .update({
          embedding: JSON.stringify(newCentroid),
          query_count: n + 1,
          updated_at: new Date().toISOString(),
        })
        .eq("id", topic.id);
    }

    // Assign query to this topic
    await supabase
      .from("queries")
      .update({ topic_id: topic.id })
      .eq("id", queryId);

    return { topic_id: topic.id, topic_label: topic.label, is_new: false };
  }

  // No match — create a new topic with an LLM-generated label
  const label = await generateTopicLabel(queryText);

  const { data: newTopic, error: insertErr } = await supabase
    .from("topics")
    .insert({
      user_id: userId,
      label,
      embedding: JSON.stringify(queryEmbedding),
      query_count: 1,
    })
    .select("id")
    .single();

  if (insertErr) throw insertErr;

  // Assign query to new topic
  await supabase
    .from("queries")
    .update({ topic_id: newTopic.id })
    .eq("id", queryId);

  return { topic_id: newTopic.id, topic_label: label, is_new: true };
}

async function generateTopicLabel(queryText: string): Promise<string> {
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "anthropic/claude-sonnet-4",
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
  });

  if (!resp.ok) {
    // Fallback: use a truncated version of the query
    return queryText.slice(0, 50);
  }

  const data = await resp.json();
  return data.choices[0].message.content.trim().replace(/^["']|["']$/g, "");
}

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
    // Verify JWT
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return Response.json({ error: "Missing authorization" }, {
        status: 401,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const authClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user }, error: authErr } = await authClient.auth.getUser();
    if (authErr || !user) {
      return Response.json({ error: "Invalid or expired token" }, {
        status: 401,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    const { query } = await req.json();
    if (!query || typeof query !== "string") {
      return Response.json({ error: "Missing 'query' string" }, { status: 400 });
    }

    // 1. Create query record
    const { data: queryRow, error: queryErr } = await supabase
      .from("queries")
      .insert({ raw_input: query, user_id: user.id })
      .select("id")
      .single();

    if (queryErr) throw queryErr;
    const queryId = queryRow.id;

    // 2. Search with Exa
    const exaResults = await searchExa(query);

    // 3. Generate embeddings for source texts + query text (batched)
    const textsToEmbed = [
      query, // index 0 = query embedding for topic classification
      ...exaResults.map(
        (r) => `${r.title}\n${r.summary}\n${r.highlights.join(" ")}`,
      ),
    ];
    const allEmbeddings = await embedTexts(textsToEmbed);
    const queryEmbedding = allEmbeddings[0];
    const embeddings = allEmbeddings.slice(1);

    // 4. Store sources with embeddings
    const sourceRows = exaResults.map((r, i) => ({
      query_id: queryId,
      url: r.url,
      title: r.title,
      author: r.author,
      published_at: r.publishedDate,
      snippet: r.summary,
      full_text: r.text,
      exa_score: r.score,
      embedding: JSON.stringify(embeddings[i]),
    }));

    const { data: insertedSources, error: sourceErr } = await supabase
      .from("sources")
      .insert(sourceRows)
      .select("id");

    if (sourceErr) throw sourceErr;

    // 5. Classify into topic + find related sources + analyze (parallel)
    const [topicInfo, crossQueryMatches, analysis] = await Promise.all([
      classifyIntoTopic(query, queryEmbedding, user.id, queryId),
      findRelatedSources(embeddings, queryId),
      analyzeConnections(query, exaResults),
    ]);

    // 7. Store connections
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

    // 8. Store synthesis
    const { error: synthErr } = await supabase.from("syntheses").insert({
      query_id: queryId,
      summary: analysis.synthesis,
      gaps_identified: analysis.gaps,
      follow_up_questions: analysis.follow_up_questions,
      model: "anthropic/claude-sonnet-4",
    });

    if (synthErr) throw synthErr;

    // 9. Return everything
    return Response.json(
      {
        query_id: queryId,
        topic: {
          id: topicInfo.topic_id,
          label: topicInfo.topic_label,
          is_new: topicInfo.is_new,
        },
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
        cross_query_connections: crossQueryMatches.map((m) => ({
          current_source: exaResults[m.source_index]?.title,
          related_source: m.matched_title,
          related_url: m.matched_url,
          from_query: m.matched_query,
          similarity: Math.round(m.similarity * 1000) / 1000,
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
