<svelte:head>
	<title>About Hailight — How it works</title>
	<meta name="description" content="Hailight is a research platform that indexes academic papers from arXiv and OpenAlex, embeds them as vectors, and maps connections, contradictions, and gaps across your research." />
	<link rel="canonical" href="https://hailight.space/about" />

	<meta property="og:type" content="website" />
	<meta property="og:url" content="https://hailight.space/about" />
	<meta property="og:title" content="About Hailight — How it works" />
	<meta property="og:description" content="Hailight indexes arXiv and OpenAlex papers, embeds them as vectors, and maps connections, contradictions, and gaps across your research." />
	<meta property="og:site_name" content="Hailight" />

	<meta name="twitter:card" content="summary" />
	<meta name="twitter:title" content="About Hailight — How it works" />
	<meta name="twitter:description" content="Research platform that maps semantic relationships across academic and web sources." />

	{@html `<script type="application/ld+json">${JSON.stringify({
		"@context": "https://schema.org",
		"@type": "AboutPage",
		"name": "About Hailight",
		"url": "https://hailight.space/about",
		"mainEntity": {
			"@type": "WebApplication",
			"name": "Hailight",
			"url": "https://hailight.space"
		}
	})}</script>`}
</svelte:head>

<div class="min-h-screen bg-void text-text">
	<header class="px-6 py-5">
		<div class="mx-auto max-w-3xl flex items-center justify-between">
			<a href="/" class="group">
				<h1 class="text-2xl font-light tracking-wide text-bright">
					hai<span class="text-accent group-hover:text-accent-glow transition-colors">light</span>
				</h1>
			</a>
			<a
				href="/"
				class="rounded-md border border-edge px-4 py-2 text-sm text-bright
					hover:border-accent/30 transition-colors"
			>
				Back to home
			</a>
		</div>
	</header>

	<main class="mx-auto max-w-3xl px-6 py-12">
		<article class="space-y-10">
			<header>
				<h2 class="text-3xl font-light text-bright">What is Hailight?</h2>
				<p class="mt-4 text-lg leading-relaxed text-text/80">
					Hailight is a research platform that finds the space between what you know. Instead of returning
					a ranked list of results, it maps <strong class="text-bright">connections</strong>,
					<strong class="text-bright">contradictions</strong>, and <strong class="text-bright">gaps</strong>
					across sources — surfacing relationships that traditional search engines miss.
				</p>
			</header>

			<section>
				<h3 class="text-xl font-medium text-bright mb-4">How it works</h3>
				<p class="text-sm leading-relaxed text-text/80 mb-4">
					When you search on Hailight, your query goes through a multi-stage pipeline:
				</p>
				<ol class="space-y-4 text-sm leading-relaxed text-text/80">
					<li class="flex gap-3">
						<span class="shrink-0 text-accent font-medium">1.</span>
						<div>
							<strong class="text-bright">Source retrieval.</strong> We search the web and academic databases simultaneously
							using the Exa search API, which returns results with highlights and summaries rather than just links.
						</div>
					</li>
					<li class="flex gap-3">
						<span class="shrink-0 text-accent font-medium">2.</span>
						<div>
							<strong class="text-bright">Vector embedding.</strong> Every source is embedded into a 1,536-dimensional
							vector space using Qwen3-Embedding-8B. This captures semantic meaning — not just keywords, but concepts,
							relationships, and implications.
						</div>
					</li>
					<li class="flex gap-3">
						<span class="shrink-0 text-accent font-medium">3.</span>
						<div>
							<strong class="text-bright">Cross-query matching.</strong> New sources are compared against everything
							you've searched before using cosine similarity on pgvector with HNSW indexing. Sources from previous
							queries that are semantically close surface as "echoes" — connections you didn't ask for but are relevant.
						</div>
					</li>
					<li class="flex gap-3">
						<span class="shrink-0 text-accent font-medium">4.</span>
						<div>
							<strong class="text-bright">Topic clustering.</strong> Your queries are automatically grouped into research
							topics based on embedding similarity. Each topic maintains a centroid — a running average of its query
							embeddings — that updates as you explore. New queries are classified against existing topic centroids
							at a threshold of 0.71 cosine similarity.
						</div>
					</li>
					<li class="flex gap-3">
						<span class="shrink-0 text-accent font-medium">5.</span>
						<div>
							<strong class="text-bright">LLM analysis.</strong> Claude Sonnet 4 analyzes the source set to identify
							which sources agree, contradict, extend, or leave gaps relative to each other. This produces a structured
							synthesis with color-coded connection types.
						</div>
					</li>
				</ol>
			</section>

			<section>
				<h3 class="text-xl font-medium text-bright mb-4">Data sources</h3>
				<p class="text-sm leading-relaxed text-text/80 mb-4">
					Hailight maintains a growing shared knowledge graph fed by multiple sources:
				</p>
				<ul class="space-y-3 text-sm leading-relaxed text-text/80">
					<li class="flex gap-3">
						<span class="shrink-0 text-accent">&#10022;</span>
						<div>
							<strong class="text-bright">arXiv</strong> — Computer science, mathematics, and physics papers harvested
							via OAI-PMH protocol. Papers are deduplicated by arXiv ID and DOI, then batch-embedded and stored.
							Harvesting runs every 3 hours across all three subject sets.
						</div>
					</li>
					<li class="flex gap-3">
						<span class="shrink-0 text-accent">&#10022;</span>
						<div>
							<strong class="text-bright">OpenAlex</strong> — Scholarly works from the open catalog of academic metadata.
							Filtered to computer science, mathematics, and physics. Abstracts are reconstructed from OpenAlex's
							inverted index format. Harvesting runs every 2 hours with cursor-based pagination.
						</div>
					</li>
					<li class="flex gap-3">
						<span class="shrink-0 text-accent">&#10022;</span>
						<div>
							<strong class="text-bright">Web search</strong> — Live results from the Exa search API when you make a query.
							These are embedded alongside academic sources in the same vector space, enabling cross-source connections
							between web content and published research.
						</div>
					</li>
				</ul>
				<p class="mt-4 text-sm leading-relaxed text-text/80">
					Cross-source deduplication runs twice daily using embedding cosine similarity at a threshold of 0.95,
					plus DOI matching during ingestion. When duplicates are found, the higher-quality source (arXiv &gt;
					OpenAlex &gt; web search) is kept and the other's connections are merged in.
				</p>
			</section>

			<section>
				<h3 class="text-xl font-medium text-bright mb-4">The knowledge graph</h3>
				<p class="text-sm leading-relaxed text-text/80 mb-4">
					All sources share a single embedding space. Every user's searches feed the same graph, but
					reads are scoped per user via row-level security. This means:
				</p>
				<ul class="space-y-2 text-sm leading-relaxed text-text/80">
					<li class="flex gap-3">
						<span class="text-agree">&#9650;</span>
						<span>Network effects — each search makes the graph richer for everyone</span>
					</li>
					<li class="flex gap-3">
						<span class="text-agree">&#9650;</span>
						<span>Caching — sources already in the graph don't need re-embedding</span>
					</li>
					<li class="flex gap-3">
						<span class="text-agree">&#9650;</span>
						<span>Cross-pollination — your query might find relevant sources originally found by someone else's research</span>
					</li>
				</ul>
			</section>

			<section>
				<h3 class="text-xl font-medium text-bright mb-4">Auto-research</h3>
				<p class="text-sm leading-relaxed text-text/80">
					Hailight doesn't just wait for you to search. An auto-research daemon runs twice daily, analyzing
					the topic graph to identify pairs of topics that are semantically close but lack connecting sources
					(semantic bridges). It then generates targeted queries to fill those gaps, runs them through the full
					search pipeline, and measures whether the bridge score improved. This means the knowledge graph
					gets smarter even when no one is actively searching.
				</p>
			</section>

			<section>
				<h3 class="text-xl font-medium text-bright mb-4">Analytics and insights</h3>
				<p class="text-sm leading-relaxed text-text/80">
					Beyond search, Hailight tracks your research trajectory — whether you're deepening into a topic,
					pivoting to a new area, or circling back. The insights page synthesizes your entire research landscape
					into a narrative that identifies your strongest areas, blindspots, surprising connections, and
					recommended next queries. This is powered by several Postgres RPCs that compute semantic bridges,
					knowledge density, topic gaps, query trajectories, and contradictions, then feed them to Claude
					Sonnet 4 for synthesis.
				</p>
			</section>

			<section>
				<h3 class="text-xl font-medium text-bright mb-4">Technical stack</h3>
				<p class="text-sm leading-relaxed text-text/80 mb-4">
					Hailight is built on:
				</p>
				<ul class="space-y-2 text-sm text-text/80">
					<li><strong class="text-bright">Frontend:</strong> SvelteKit with Tailwind CSS v4, hosted on Cloudflare Pages</li>
					<li><strong class="text-bright">Backend:</strong> Supabase (Postgres with pgvector extension, row-level security, edge functions)</li>
					<li><strong class="text-bright">Embeddings:</strong> Qwen3-Embedding-8B via OpenRouter — 1,536 dimensions via Matryoshka truncation from native 4,096</li>
					<li><strong class="text-bright">LLM:</strong> Claude Sonnet 4 via OpenRouter for analysis and synthesis</li>
					<li><strong class="text-bright">Search:</strong> Exa API for web and academic retrieval</li>
					<li><strong class="text-bright">Vector indexing:</strong> HNSW indexes on pgvector for approximate nearest neighbor search</li>
					<li><strong class="text-bright">Scheduling:</strong> pg_cron + pg_net for automated harvesting and research</li>
				</ul>
			</section>

			<section>
				<h3 class="text-xl font-medium text-bright mb-4">API access</h3>
				<p class="text-sm leading-relaxed text-text/80">
					Hailight exposes a search API authenticated via API keys. You can generate keys from your account,
					then pass them as an <code class="rounded bg-surface px-1.5 py-0.5 text-accent text-xs">x-api-key</code>
					header. Rate limiting is enforced at 10 requests per minute per user via a database-backed sliding window.
					The API returns structured JSON with sources, connections, synthesis, gaps, follow-up questions, and
					topic classification.
				</p>
			</section>

			<section class="border-t border-edge pt-10">
				<p class="text-sm text-muted">
					Hailight is built by <a href="https://github.com/xandwr" class="text-accent hover:text-accent-glow transition-colors">Xander</a>.
					The source data comes from arXiv, OpenAlex, and the open web. We don't sell data — we build tools.
				</p>
			</section>
		</article>
	</main>

	<footer class="py-8 text-center text-xs text-muted/40">
		hailight.space
	</footer>
</div>
