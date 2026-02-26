/**
 * Test script for ingest-openalex edge function.
 * Tests core logic (abstract reconstruction, parsing) and live API connectivity.
 *
 * Run: deno run --allow-net supabase/functions/ingest-openalex/test.ts
 */

// ── Abstract Reconstruction ──

function reconstructAbstract(
  invertedIndex: Record<string, number[]> | null,
): string {
  if (!invertedIndex) return "";
  let maxPos = 0;
  for (const positions of Object.values(invertedIndex)) {
    for (const pos of positions) {
      if (pos > maxPos) maxPos = pos;
    }
  }
  const words = new Array<string>(maxPos + 1).fill("");
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) {
      words[pos] = word;
    }
  }
  return words.join(" ").trim();
}

function extractId(url: string): string {
  return url.split("/").pop() ?? url;
}

// ── Unit Tests ──

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

console.log("\n=== Abstract Reconstruction ===");

// Basic case
const basic = reconstructAbstract({
  "Hello": [0],
  "world,": [1],
  "this": [2],
  "is": [3, 7],
  "a": [4],
  "test.": [5],
  "It": [6],
  "great.": [8],
});
assert(
  basic === "Hello world, this is a test. It is great.",
  `basic reconstruction: "${basic}"`,
);

// Null input
assert(reconstructAbstract(null) === "", "null returns empty string");

// Empty object
assert(reconstructAbstract({}) === "", "empty object returns empty string");

// Single word
assert(
  reconstructAbstract({ "Hello": [0] }) === "Hello",
  "single word",
);

// Words with punctuation (OpenAlex stores "word," as a single token)
const withPunct = reconstructAbstract({
  "We": [0],
  "study": [1],
  "algorithms,": [2],
  "data": [3],
  "structures,": [4],
  "and": [5],
  "systems.": [6],
});
assert(
  withPunct === "We study algorithms, data structures, and systems.",
  `punctuation preserved: "${withPunct}"`,
);

// Repeated word at multiple positions
const repeated = reconstructAbstract({
  "the": [0, 3],
  "cat": [1],
  "and": [2],
  "dog": [4],
});
assert(
  repeated === "the cat and the dog",
  `repeated words: "${repeated}"`,
);

console.log("\n=== ID Extraction ===");

assert(
  extractId("https://openalex.org/W2741809807") === "W2741809807",
  "extracts W-ID from URL",
);
assert(
  extractId("W123") === "W123",
  "passes through bare ID",
);

// ── Live API Test ──

console.log("\n=== Live API Connectivity ===");

const OPENALEX_BASE = "https://api.openalex.org/works";
const filter = "concepts.id:C41008148,has_abstract:true,from_publication_date:2024-01-01";
const params = new URLSearchParams({
  filter,
  per_page: "5",
  cursor: "*",
  select: "id,doi,display_name,abstract_inverted_index,authorships,topics,type,cited_by_count,primary_location,publication_date",
  mailto: "test@hailight.space",
});

try {
  const resp = await fetch(`${OPENALEX_BASE}?${params}`, {
    headers: { "User-Agent": "HailightTest/1.0 (mailto:test@hailight.space)" },
  });

  assert(resp.ok, `API responds OK (${resp.status})`);

  const data = await resp.json();
  const meta = data.meta;

  assert(typeof meta.count === "number" && meta.count > 0, `total count: ${meta.count}`);
  assert(typeof meta.next_cursor === "string", `has next_cursor`);
  assert(Array.isArray(data.results), "results is array");
  assert(data.results.length === 5, `got ${data.results.length} results (expected 5)`);

  // Test parsing each result
  let validWorks = 0;
  for (const work of data.results) {
    const id = extractId(work.id);
    assert(id.startsWith("W"), `work ID format: ${id}`);

    const abstract = reconstructAbstract(work.abstract_inverted_index);
    if (abstract.length >= 50) {
      validWorks++;
    }

    const authors = (work.authorships ?? [])
      .map((a: any) => a.author?.display_name)
      .filter(Boolean);
    // Just log, don't assert — some works may have no authors
    console.log(`    ${id}: "${work.display_name?.slice(0, 60)}..." (${authors.length} authors, abstract: ${abstract.length} chars)`);
  }

  assert(validWorks > 0, `at least one work has abstract >= 50 chars (${validWorks}/5)`);

  // Test cursor pagination (fetch page 2)
  console.log("\n=== Cursor Pagination ===");
  const params2 = new URLSearchParams({
    filter,
    per_page: "2",
    cursor: meta.next_cursor,
    select: "id,display_name",
    mailto: "test@hailight.space",
  });
  const resp2 = await fetch(`${OPENALEX_BASE}?${params2}`, {
    headers: { "User-Agent": "HailightTest/1.0" },
  });
  assert(resp2.ok, `page 2 responds OK (${resp2.status})`);
  const data2 = await resp2.json();
  assert(data2.results.length === 2, `page 2 has ${data2.results.length} results`);
  assert(data2.meta.next_cursor !== null, "page 2 has next cursor");

  // Verify no overlap between pages
  const page1Ids = new Set(data.results.map((w: any) => w.id));
  const page2Ids = data2.results.map((w: any) => w.id);
  const overlap = page2Ids.filter((id: string) => page1Ids.has(id));
  assert(overlap.length === 0, `no overlap between pages (${overlap.length} dupes)`);

} catch (err) {
  console.error(`  ✗ API test failed: ${err}`);
  failed++;
}

// ── Summary ──

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
Deno.exit(failed > 0 ? 1 : 0);
