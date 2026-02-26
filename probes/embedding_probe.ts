/**
 * Qwen3-Embedding-8B Similarity Probe
 *
 * Characterizes the cosine similarity distribution across semantic tiers
 * to derive data-driven thresholds for topic clustering and source matching.
 *
 * Tiers:
 *   1. SAME_TOPIC    — queries that belong to the same research space
 *   2. ADJACENT      — queries that share a concept but are different topics
 *   3. UNRELATED     — queries with no meaningful connection
 *
 * Runs against local ollama (qwen3-embedding:8b) at 1536 dims to match production.
 */

const OLLAMA_URL = "http://localhost:11434/api/embed";
const MODEL = "qwen3-embedding:8b";
const DIMS = 1536; // match production (OpenRouter truncation)

// --- Test pairs organized by semantic tier ---

interface QueryPair {
  a: string;
  b: string;
  tier: "same_topic" | "adjacent" | "unrelated";
  note: string;
}

const pairs: QueryPair[] = [
  // === SAME TOPIC: should cluster together ===
  {
    a: "CRISPR off-target effects in human cells",
    b: "CRISPR gene editing unintended mutations",
    tier: "same_topic",
    note: "same mechanism, same concern",
  },
  {
    a: "how do transformers handle long context windows",
    b: "attention mechanism scaling for long sequences",
    tier: "same_topic",
    note: "same technical concept, different phrasing",
  },
  {
    a: "ocean acidification effects on coral reefs",
    b: "coral bleaching from changing ocean pH levels",
    tier: "same_topic",
    note: "same phenomenon, different angle",
  },
  {
    a: "rust ownership model explained",
    b: "borrow checker rules in rust programming",
    tier: "same_topic",
    note: "same language feature",
  },
  {
    a: "dark matter detection methods",
    b: "experiments searching for weakly interacting massive particles",
    tier: "same_topic",
    note: "same research area",
  },
  {
    a: "microplastics in drinking water health effects",
    b: "nanoplastic contamination human health risks",
    tier: "same_topic",
    note: "same environmental health concern",
  },
  {
    a: "kubernetes horizontal pod autoscaling",
    b: "k8s HPA configuration and scaling policies",
    tier: "same_topic",
    note: "same devops concept, abbrev vs full",
  },
  {
    a: "sleep deprivation effects on memory consolidation",
    b: "how lack of sleep impairs long-term memory formation",
    tier: "same_topic",
    note: "same neuroscience topic",
  },
  {
    a: "supply chain attacks in open source software",
    b: "npm package hijacking and dependency confusion",
    tier: "same_topic",
    note: "same security domain, specific example",
  },
  {
    a: "mRNA vaccine mechanism of action",
    b: "how lipid nanoparticles deliver mRNA vaccines",
    tier: "same_topic",
    note: "same biotech, mechanism detail",
  },

  // === ADJACENT: share a concept but different topics ===
  {
    a: "CRISPR ethics in human germline editing",
    b: "nuclear energy ethical considerations",
    tier: "adjacent",
    note: "both ethics, different domains",
  },
  {
    a: "transformer architecture in NLP",
    b: "electrical transformer design principles",
    tier: "adjacent",
    note: "same word, completely different fields",
  },
  {
    a: "rust programming memory safety",
    b: "C++ smart pointers and memory management",
    tier: "adjacent",
    note: "same concern (memory), different languages",
  },
  {
    a: "dark matter in cosmology",
    b: "dark patterns in UX design",
    tier: "adjacent",
    note: "share 'dark' but unrelated fields",
  },
  {
    a: "ocean acidification research",
    b: "air pollution effects on respiratory health",
    tier: "adjacent",
    note: "both environmental, different systems",
  },
  {
    a: "kubernetes container orchestration",
    b: "docker container security best practices",
    tier: "adjacent",
    note: "related tech ecosystem, different focus",
  },
  {
    a: "sleep and memory consolidation",
    b: "meditation effects on cognitive performance",
    tier: "adjacent",
    note: "both cognition, different mechanisms",
  },
  {
    a: "supply chain attacks in software",
    b: "physical supply chain logistics optimization",
    tier: "adjacent",
    note: "same phrase, different domains",
  },
  {
    a: "mRNA vaccine technology",
    b: "traditional attenuated virus vaccines",
    tier: "adjacent",
    note: "same field (vaccines), different tech",
  },
  {
    a: "microplastics in the ocean",
    b: "heavy metal water contamination",
    tier: "adjacent",
    note: "both water pollution, different pollutants",
  },

  // === UNRELATED: should never cluster ===
  {
    a: "CRISPR gene editing techniques",
    b: "Renaissance oil painting techniques",
    tier: "unrelated",
    note: "biology vs art",
  },
  {
    a: "transformer neural network architecture",
    b: "sourdough bread fermentation process",
    tier: "unrelated",
    note: "ML vs cooking",
  },
  {
    a: "kubernetes cluster management",
    b: "ancient Roman military formations",
    tier: "unrelated",
    note: "devops vs history",
  },
  {
    a: "dark matter particle physics",
    b: "contemporary jazz improvisation theory",
    tier: "unrelated",
    note: "physics vs music",
  },
  {
    a: "ocean acidification chemistry",
    b: "venture capital term sheet negotiation",
    tier: "unrelated",
    note: "chemistry vs finance",
  },
  {
    a: "rust borrow checker semantics",
    b: "19th century whaling industry economics",
    tier: "unrelated",
    note: "programming vs history",
  },
  {
    a: "mRNA lipid nanoparticle delivery",
    b: "competitive speed cubing algorithms",
    tier: "unrelated",
    note: "biotech vs puzzles",
  },
  {
    a: "sleep deprivation cognitive effects",
    b: "orbital mechanics of Mars transfer windows",
    tier: "unrelated",
    note: "neuroscience vs aerospace",
  },
  {
    a: "microplastic environmental contamination",
    b: "baroque harpsichord tuning temperaments",
    tier: "unrelated",
    note: "env science vs music theory",
  },
  {
    a: "npm supply chain security vulnerabilities",
    b: "traditional Japanese joinery woodworking",
    tier: "unrelated",
    note: "infosec vs craftsmanship",
  },
];

// --- Embedding + similarity ---

async function embed(text: string): Promise<number[]> {
  const resp = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      input: text,
      truncate: true,
      options: { num_ctx: 512 },
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Embed failed: ${resp.status} ${err}`);
  }

  const data = await resp.json();
  const raw = data.embeddings[0];

  // Matryoshka truncation: take first N dims, re-normalize (matches OpenRouter behavior)
  const truncated = raw.slice(0, DIMS);
  const mag = Math.sqrt(truncated.reduce((s: number, v: number) => s + v * v, 0));
  return truncated.map((v: number) => v / mag);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// --- Stats helpers ---

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  const std = Math.sqrt(variance);
  const median = sorted[Math.floor(sorted.length / 2)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const p25 = sorted[Math.floor(sorted.length * 0.25)];
  const p75 = sorted[Math.floor(sorted.length * 0.75)];
  return { mean, std, median, min, max, p25, p75, sorted };
}

// --- Main ---

async function main() {
  console.log("=== Qwen3-Embedding-8B Similarity Probe ===\n");
  console.log(`Model: ${MODEL}`);
  console.log(`Pairs: ${pairs.length} (${pairs.filter(p => p.tier === "same_topic").length} same, ${pairs.filter(p => p.tier === "adjacent").length} adjacent, ${pairs.filter(p => p.tier === "unrelated").length} unrelated)\n`);

  // Collect unique texts to embed (deduplicate)
  const textSet = new Set<string>();
  for (const p of pairs) {
    textSet.add(p.a);
    textSet.add(p.b);
  }
  const texts = [...textSet];
  console.log(`Unique texts to embed: ${texts.length}`);

  // Embed all texts
  console.log("Embedding...");
  const embeddings = new Map<string, number[]>();
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    process.stdout.write(`  [${i + 1}/${texts.length}] ${text.slice(0, 50)}...`);
    const emb = await embed(text);
    embeddings.set(text, emb);
    console.log(` ✓ (${emb.length} dims)`);
  }

  console.log(`\nEmbedding dimension: ${embeddings.values().next().value!.length}\n`);

  // Compute similarities per tier
  const results: { tier: string; sim: number; note: string; a: string; b: string }[] = [];

  for (const p of pairs) {
    const embA = embeddings.get(p.a)!;
    const embB = embeddings.get(p.b)!;
    const sim = cosineSimilarity(embA, embB);
    results.push({ tier: p.tier, sim, note: p.note, a: p.a, b: p.b });
  }

  // Group by tier
  const tiers = ["same_topic", "adjacent", "unrelated"] as const;
  const grouped = Object.fromEntries(
    tiers.map(t => [t, results.filter(r => r.tier === t).map(r => r.sim)])
  );

  // Print distribution per tier
  console.log("═══════════════════════════════════════════════");
  console.log(" TIER DISTRIBUTIONS");
  console.log("═══════════════════════════════════════════════\n");

  for (const tier of tiers) {
    const s = stats(grouped[tier]);
    console.log(`  ${tier.toUpperCase()}`);
    console.log(`    mean:   ${s.mean.toFixed(4)}`);
    console.log(`    std:    ${s.std.toFixed(4)}`);
    console.log(`    median: ${s.median.toFixed(4)}`);
    console.log(`    range:  [${s.min.toFixed(4)}, ${s.max.toFixed(4)}]`);
    console.log(`    IQR:    [${s.p25.toFixed(4)}, ${s.p75.toFixed(4)}]`);
    console.log();
  }

  // Print all individual results sorted by similarity
  console.log("═══════════════════════════════════════════════");
  console.log(" ALL PAIRS (sorted by similarity)");
  console.log("═══════════════════════════════════════════════\n");

  const sorted = results.sort((a, b) => b.sim - a.sim);
  for (const r of sorted) {
    const tag = r.tier === "same_topic" ? "🟢" : r.tier === "adjacent" ? "🟡" : "🔴";
    console.log(`  ${tag} ${r.sim.toFixed(4)}  [${r.tier.padEnd(12)}]  ${r.note}`);
  }

  // Derive thresholds
  console.log("\n═══════════════════════════════════════════════");
  console.log(" THRESHOLD ANALYSIS");
  console.log("═══════════════════════════════════════════════\n");

  const sameStats = stats(grouped["same_topic"]);
  const adjStats = stats(grouped["adjacent"]);
  const unrelStats = stats(grouped["unrelated"]);

  // Topic threshold: separates same_topic from adjacent
  // Use the midpoint between same_topic min and adjacent max
  const topicGapLow = adjStats.max;
  const topicGapHigh = sameStats.min;
  const topicThreshold = (topicGapLow + topicGapHigh) / 2;

  // Source threshold: separates adjacent from unrelated
  const sourceGapLow = unrelStats.max;
  const sourceGapHigh = adjStats.min;
  const sourceThreshold = (sourceGapLow + sourceGapHigh) / 2;

  console.log(`  Topic clustering (same vs adjacent):`);
  console.log(`    same_topic min:  ${sameStats.min.toFixed(4)}`);
  console.log(`    adjacent max:    ${adjStats.max.toFixed(4)}`);
  console.log(`    gap:             ${(topicGapHigh - topicGapLow).toFixed(4)}`);
  if (topicGapHigh > topicGapLow) {
    console.log(`    ✓ CLEAN SEPARATION — threshold: ${topicThreshold.toFixed(4)}`);
  } else {
    console.log(`    ⚠ OVERLAP — tiers bleed into each other`);
    console.log(`    suggested threshold (conservative): ${(sameStats.p25).toFixed(4)}`);
  }

  console.log();
  console.log(`  Source matching (adjacent vs unrelated):`);
  console.log(`    adjacent min:    ${adjStats.min.toFixed(4)}`);
  console.log(`    unrelated max:   ${unrelStats.max.toFixed(4)}`);
  console.log(`    gap:             ${(sourceGapHigh - sourceGapLow).toFixed(4)}`);
  if (sourceGapHigh > sourceGapLow) {
    console.log(`    ✓ CLEAN SEPARATION — threshold: ${sourceThreshold.toFixed(4)}`);
  } else {
    console.log(`    ⚠ OVERLAP — tiers bleed into each other`);
    console.log(`    suggested threshold (conservative): ${(adjStats.p25).toFixed(4)}`);
  }

  // Final recommendations
  console.log("\n═══════════════════════════════════════════════");
  console.log(" RECOMMENDED THRESHOLDS");
  console.log("═══════════════════════════════════════════════\n");

  const recTopic = topicGapHigh > topicGapLow
    ? topicThreshold
    : sameStats.p25;
  const recSource = sourceGapHigh > sourceGapLow
    ? sourceThreshold
    : adjStats.p25;

  console.log(`  match_user_topic threshold:  ${recTopic.toFixed(4)}  (currently 0.78)`);
  console.log(`  match_sources threshold:     ${recSource.toFixed(4)}  (currently 0.82)`);
  console.log();

  // Write results to JSON for reference
  const output = {
    model: MODEL,
    timestamp: new Date().toISOString(),
    embedding_dims: embeddings.values().next().value!.length,
    pair_count: pairs.length,
    distributions: {
      same_topic: { ...sameStats, sorted: sameStats.sorted },
      adjacent: { ...adjStats, sorted: adjStats.sorted },
      unrelated: { ...unrelStats, sorted: unrelStats.sorted },
    },
    thresholds: {
      topic_clustering: {
        value: recTopic,
        gap_clean: topicGapHigh > topicGapLow,
        same_min: sameStats.min,
        adjacent_max: adjStats.max,
      },
      source_matching: {
        value: recSource,
        gap_clean: sourceGapHigh > sourceGapLow,
        adjacent_min: adjStats.min,
        unrelated_max: unrelStats.max,
      },
    },
    all_pairs: sorted.map(r => ({
      similarity: Math.round(r.sim * 10000) / 10000,
      tier: r.tier,
      note: r.note,
      a: r.a,
      b: r.b,
    })),
  };

  const outPath = new URL("./results.json", import.meta.url).pathname;
  Deno.writeTextFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`  Full results written to: ${outPath}`);
}

main();
