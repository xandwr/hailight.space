import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { generateTopicLabel } from "./llm.ts";
import { parseEmbedding } from "./embeddings.ts";
import { Logger } from "./logger.ts";

export interface TopicResult {
  topic_id: string;
  topic_label: string;
  is_new: boolean;
}

/**
 * Classify a query embedding into an existing topic or create a new one.
 * Uses probe-derived threshold of 0.71 for topic matching.
 */
export async function classifyIntoTopic(
  queryText: string,
  queryEmbedding: number[],
  userId: string,
  queryId: string,
  db: SupabaseClient,
  log: Logger,
): Promise<TopicResult> {
  const vecStr = `[${queryEmbedding.join(",")}]`;

  // Check for existing topic match
  const { data: match, error: matchErr } = await db.rpc("match_user_topic", {
    p_user_id: userId,
    p_embedding: vecStr,
    p_threshold: 0.71,
  });

  if (!matchErr && match?.length > 0) {
    const topic = match[0];
    log.info("topic_matched", { topic_id: topic.id, label: topic.label, similarity: topic.similarity });

    // Update centroid as running average
    const { data: existing } = await db
      .from("topics")
      .select("embedding, query_count")
      .eq("id", topic.id)
      .single();

    if (existing?.embedding) {
      const oldEmb = parseEmbedding(existing.embedding);
      const n = existing.query_count;
      const newCentroid = oldEmb.map(
        (v: number, i: number) => (v * n + queryEmbedding[i]) / (n + 1),
      );
      await db
        .from("topics")
        .update({
          embedding: JSON.stringify(newCentroid),
          query_count: n + 1,
          updated_at: new Date().toISOString(),
        })
        .eq("id", topic.id);
    }

    await db.from("queries").update({ topic_id: topic.id }).eq("id", queryId);
    return { topic_id: topic.id, topic_label: topic.label, is_new: false };
  }

  // No match — create new topic
  log.info("topic_new", { reason: matchErr ? "rpc_error" : "below_threshold" });
  const label = await generateTopicLabel(queryText, log);

  const { data: newTopic, error: insertErr } = await db
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

  await db.from("queries").update({ topic_id: newTopic.id }).eq("id", queryId);
  return { topic_id: newTopic.id, topic_label: label, is_new: true };
}
