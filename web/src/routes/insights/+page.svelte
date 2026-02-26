<script lang="ts">
	import { PUBLIC_SUPABASE_PROJECT_URL } from '$env/static/public';
	import Header from '$lib/components/Header.svelte';
	import { track } from '$lib/analytics';

	let { data } = $props();

	interface TopicGap {
		topic_a_id: string;
		topic_a_label: string;
		topic_b_id: string;
		topic_b_label: string;
		topic_similarity: number;
	}

	interface Bridge {
		source_title: string;
		source_url: string;
		topic_a_label: string;
		topic_b_label: string;
		bridge_score: number;
	}

	interface TopicDensity {
		topic_id: string;
		topic_label: string;
		query_count: number;
		source_count: number;
		avg_similarity: number;
		stddev_similarity: number;
	}

	interface TrajectoryPoint {
		raw_input: string;
		topic_label: string;
		movement_type: string;
		similarity_to_previous: number | null;
	}

	interface Contradiction {
		source_a_title: string;
		source_b_title: string;
		explanation: string;
		strength: number;
	}

	interface RecentDirection {
		topic_a_label: string;
		topic_b_label: string;
		bridge_query: string;
		sources_found: number;
		bridge_score_before: number;
		bridge_score_after: number;
		status: string;
		completed_at: string;
	}

	interface Synthesis {
		narrative: string;
		strongest_areas: string[];
		blindspots: string[];
		surprising_connections: string[];
		recommended_queries: string[];
	}

	interface InsightResponse {
		synthesis: Synthesis;
		data: {
			topic_count: number;
			gap_count: number;
			bridge_count: number;
			contradiction_count: number;
			gaps: TopicGap[];
			bridges: Bridge[];
			density: TopicDensity[];
			trajectory: TrajectoryPoint[];
			contradictions: Contradiction[];
			recent_research: RecentDirection[];
		};
		elapsed_ms: number;
	}

	let loading = $state(false);
	let error: string | null = $state(null);
	let insights: InsightResponse | null = $state(null);

	$effect(() => {
		loadInsights();
	});

	async function loadInsights() {
		loading = true;
		error = null;

		try {
			const session = data.session;
			if (!session?.access_token) {
				error = 'You need to be signed in to view insights.';
				return;
			}

			const resp = await fetch(`${PUBLIC_SUPABASE_PROJECT_URL}/functions/v1/insights`, {
				headers: {
					Authorization: `Bearer ${session.access_token}`,
				},
			});

			if (!resp.ok) {
				const body = await resp.json();
				throw new Error(body.error?.message || `Request failed: ${resp.status}`);
			}

			insights = await resp.json();
			track('page_view', { page: 'insights', topic_count: insights?.data.topic_count });
		} catch (e: any) {
			error = e.message;
		} finally {
			loading = false;
		}
	}

	function movementIcon(type: string): string {
		switch (type) {
			case 'deepening': return '&#8595;';
			case 'pivoting': return '&#8634;';
			case 'circling': return '&#8635;';
			case 'start': return '&#9679;';
			default: return '&#8594;';
		}
	}

	function movementColor(type: string): string {
		switch (type) {
			case 'deepening': return 'text-accent';
			case 'pivoting': return 'text-extend';
			case 'circling': return 'text-gap';
			case 'start': return 'text-muted';
			default: return 'text-text';
		}
	}

	function densitySorted(density: TopicDensity[]): TopicDensity[] {
		return [...density].sort((a, b) => b.source_count - a.source_count);
	}

	function bridgeImproved(d: RecentDirection): boolean {
		return d.bridge_score_after > d.bridge_score_before;
	}
</script>

<div class="min-h-screen bg-void text-text">
	<Header user={data.user} supabase={data.supabase} />

	<main class="mx-auto max-w-4xl px-6 py-10">
		<div class="mb-10">
			<h2 class="text-2xl font-light text-bright">Insights</h2>
			<p class="mt-1 text-sm text-muted">
				A synthesis of your research landscape — gaps, bridges, blindspots, and trajectories.
			</p>
		</div>

		{#if loading}
			<div class="mt-20 flex flex-col items-center gap-4 text-muted">
				<div class="h-8 w-8 animate-spin rounded-full border-2 border-edge border-t-accent"></div>
				<p class="text-sm">Analyzing your knowledge graph...</p>
				<p class="text-xs text-muted/60">This calls an LLM to synthesize your research — may take 10-20s</p>
			</div>
		{:else if error}
			<div class="mt-6 rounded-lg border border-contradict/30 bg-contradict/5 px-4 py-3 text-sm text-contradict">
				{error}
			</div>
		{:else if insights}
			{@const { synthesis, data: d } = insights}

			<!-- Stats bar -->
			<div class="mb-8 flex flex-wrap gap-4">
				{#each [
					{ label: 'Topics', value: d.topic_count, color: 'text-accent' },
					{ label: 'Bridges', value: d.bridge_count, color: 'text-agree' },
					{ label: 'Gaps', value: d.gap_count, color: 'text-gap' },
					{ label: 'Contradictions', value: d.contradiction_count, color: 'text-contradict' },
				] as stat}
					<div class="rounded-lg border border-edge bg-deep px-4 py-3 min-w-[100px]">
						<div class="text-2xl font-light {stat.color}">{stat.value}</div>
						<div class="text-xs text-muted">{stat.label}</div>
					</div>
				{/each}
			</div>

			<!-- Narrative -->
			<section class="mb-10">
				<h3 class="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">Narrative</h3>
				<div class="rounded-lg border border-edge bg-deep p-6 text-[15px] leading-relaxed text-text whitespace-pre-line">
					{synthesis.narrative}
				</div>
			</section>

			<!-- Strongest areas + Blindspots side by side -->
			<div class="mb-10 grid gap-6 sm:grid-cols-2">
				{#if synthesis.strongest_areas.length > 0}
					<section>
						<h3 class="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">
							<span class="text-agree">&#9650;</span> Strongest areas
						</h3>
						<ul class="space-y-2">
							{#each synthesis.strongest_areas as area}
								<li class="rounded-lg border border-agree/20 bg-deep px-4 py-3 text-sm text-text/90">
									{area}
								</li>
							{/each}
						</ul>
					</section>
				{/if}

				{#if synthesis.blindspots.length > 0}
					<section>
						<h3 class="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">
							<span class="text-gap">&#9660;</span> Blindspots
						</h3>
						<ul class="space-y-2">
							{#each synthesis.blindspots as spot}
								<li class="rounded-lg border border-gap/20 bg-deep px-4 py-3 text-sm text-text/90">
									{spot}
								</li>
							{/each}
						</ul>
					</section>
				{/if}
			</div>

			<!-- Surprising connections -->
			{#if synthesis.surprising_connections.length > 0}
				<section class="mb-10">
					<h3 class="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">
						<span class="text-accent">&#10022;</span> Surprising connections
					</h3>
					<div class="space-y-2">
						{#each synthesis.surprising_connections as conn}
							<div class="rounded-lg border border-accent/20 bg-accent/3 px-4 py-3 text-sm text-text/90">
								{conn}
							</div>
						{/each}
					</div>
				</section>
			{/if}

			<!-- Recommended queries -->
			{#if synthesis.recommended_queries.length > 0}
				<section class="mb-10">
					<h3 class="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">
						Recommended searches
					</h3>
					<div class="flex flex-wrap gap-2">
						{#each synthesis.recommended_queries as q}
							<a
								href="/search?q={encodeURIComponent(q)}"
								class="rounded-full border border-accent/30 bg-accent/5 px-4 py-2 text-sm text-accent
									transition-colors hover:bg-accent/10 hover:border-accent/50"
							>
								{q}
							</a>
						{/each}
					</div>
				</section>
			{/if}

			<!-- Topic gaps -->
			{#if d.gaps.length > 0}
				<section class="mb-10">
					<h3 class="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">
						Topic gaps <span class="text-muted font-normal normal-case tracking-normal">— close topics with no bridges</span>
					</h3>
					<div class="space-y-2">
						{#each d.gaps as gap}
							<div class="flex items-center gap-3 rounded-lg border border-gap/20 bg-deep px-4 py-3 text-sm">
								<span class="text-bright">{gap.topic_a_label}</span>
								<span class="text-gap text-xs">&#8646;</span>
								<span class="text-bright">{gap.topic_b_label}</span>
								<span class="ml-auto text-xs text-muted">{(gap.topic_similarity * 100).toFixed(0)}% similar</span>
							</div>
						{/each}
					</div>
				</section>
			{/if}

			<!-- Bridges -->
			{#if d.bridges.length > 0}
				<section class="mb-10">
					<h3 class="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">
						Semantic bridges <span class="text-muted font-normal normal-case tracking-normal">— sources connecting topics</span>
					</h3>
					<div class="space-y-2">
						{#each d.bridges as bridge}
							<div class="rounded-lg border border-agree/20 bg-deep px-4 py-3">
								<div class="flex items-start justify-between gap-3">
									<div class="min-w-0">
										<a
											href={bridge.source_url}
											target="_blank"
											rel="noopener noreferrer"
											class="text-sm font-medium text-bright hover:text-accent transition-colors"
										>{bridge.source_title}</a>
										<p class="mt-1 text-xs text-muted">
											{bridge.topic_a_label} &#8646; {bridge.topic_b_label}
										</p>
									</div>
									<span class="shrink-0 text-xs text-agree">{(bridge.bridge_score * 100).toFixed(0)}%</span>
								</div>
							</div>
						{/each}
					</div>
				</section>
			{/if}

			<!-- Contradictions -->
			{#if d.contradictions.length > 0}
				<section class="mb-10">
					<h3 class="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">
						Contradictions
					</h3>
					<div class="space-y-2">
						{#each d.contradictions as c}
							<div class="rounded-lg border border-contradict/20 bg-deep px-4 py-3">
								<div class="flex items-center gap-2 text-sm text-bright">
									<span class="truncate">{c.source_a_title}</span>
									<span class="text-contradict text-xs shrink-0">vs</span>
									<span class="truncate">{c.source_b_title}</span>
								</div>
								<p class="mt-1 text-xs text-text/70">{c.explanation}</p>
							</div>
						{/each}
					</div>
				</section>
			{/if}

			<!-- Knowledge density -->
			{#if d.density.length > 0}
				<section class="mb-10">
					<h3 class="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">
						Knowledge density
					</h3>
					<div class="space-y-2">
						{#each densitySorted(d.density) as topic}
							<div class="rounded-lg border border-edge bg-deep px-4 py-3">
								<div class="flex items-center justify-between mb-2">
									<span class="text-sm font-medium text-bright">{topic.topic_label}</span>
									<span class="text-xs text-muted">
										{topic.source_count} sources &middot; {topic.query_count} queries
									</span>
								</div>
								<div class="h-1.5 rounded-full bg-void overflow-hidden">
									<div
										class="h-full rounded-full bg-gradient-to-r from-accent/60 to-accent-glow/40"
										style="width: {Math.min(100, (topic.source_count / Math.max(...d.density.map(t => t.source_count))) * 100)}%"
									></div>
								</div>
							</div>
						{/each}
					</div>
				</section>
			{/if}

			<!-- Research trajectory -->
			{#if d.trajectory.length > 0}
				<section class="mb-10">
					<h3 class="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">
						Recent trajectory
					</h3>
					<div class="space-y-1">
						{#each d.trajectory as point}
							<div class="flex items-center gap-3 rounded-lg px-4 py-2 text-sm hover:bg-deep transition-colors">
								<span class="{movementColor(point.movement_type)} text-xs w-4 text-center">{@html movementIcon(point.movement_type)}</span>
								<span class="text-text/90 truncate flex-1">{point.raw_input}</span>
								<span class="text-xs text-muted shrink-0">{point.topic_label}</span>
								<span class="text-xs text-muted/50 shrink-0 w-10 text-right capitalize">{point.movement_type}</span>
							</div>
						{/each}
					</div>
				</section>
			{/if}

			<!-- Auto-research activity -->
			{#if d.recent_research.length > 0}
				<section class="mb-10">
					<h3 class="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">
						Auto-research activity
					</h3>
					<div class="space-y-2">
						{#each d.recent_research as r}
							<div class="rounded-lg border border-edge bg-deep px-4 py-3">
								<div class="flex items-center gap-2 text-sm text-bright mb-1">
									<span>{r.topic_a_label}</span>
									<span class="text-muted text-xs">&#8646;</span>
									<span>{r.topic_b_label}</span>
									{#if bridgeImproved(r)}
										<span class="ml-auto text-xs text-agree">+{((r.bridge_score_after - r.bridge_score_before) * 100).toFixed(0)}%</span>
									{:else}
										<span class="ml-auto text-xs text-muted">no change</span>
									{/if}
								</div>
								<p class="text-xs text-muted truncate">&ldquo;{r.bridge_query}&rdquo; &middot; {r.sources_found} sources &middot; {r.status}</p>
							</div>
						{/each}
					</div>
				</section>
			{/if}

			<!-- Footer -->
			<div class="mt-6 text-center text-xs text-muted/50">
				Generated in {(insights.elapsed_ms / 1000).toFixed(1)}s
			</div>
		{/if}
	</main>
</div>
