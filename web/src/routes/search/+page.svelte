<script lang="ts">
	import { PUBLIC_SUPABASE_PROJECT_URL } from '$env/static/public';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import Header from '$lib/components/Header.svelte';
	import { track } from '$lib/analytics';

	let { data } = $props();

	let query = $state('');
	let loading = $state(false);
	let result: SearchResult | null = $state(null);
	let error: string | null = $state(null);

	interface Source {
		id: string;
		url: string;
		title: string;
		summary: string;
		highlights: string[];
		score: number | null;
	}

	interface Connection {
		source_a: string;
		source_b: string;
		relationship: 'agrees' | 'contradicts' | 'extends' | 'gap';
		explanation: string;
		strength: number;
	}

	interface TopicInfo {
		id: string;
		label: string;
		is_new: boolean;
	}

	interface SearchResult {
		query_id: string;
		topic: TopicInfo;
		sources: Source[];
		connections: Connection[];
		cross_query_connections: {
			current_source: string;
			related_source: string;
			related_url: string;
			from_query: string;
			similarity: number;
		}[];
		synthesis: string;
		gaps: string[];
		follow_up_questions: string[];
	}

	// Handle ?q= param for pre-filled searches from follow-up clicks
	$effect(() => {
		const q = $page.url.searchParams.get('q');
		if (q && !result && !loading) {
			query = q;
			search();
			// Clean URL
			const url = new URL($page.url);
			url.searchParams.delete('q');
			history.replaceState({}, '', url.toString());
		}
	});

	async function search() {
		if (!query.trim() || loading) return;
		loading = true;
		error = null;
		result = null;

		const searchStart = Date.now();
		track('search', { query: query.trim() });

		try {
			const session = data.session;
			const resp = await fetch(`${PUBLIC_SUPABASE_PROJECT_URL}/functions/v1/search`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${session?.access_token}`,
				},
				body: JSON.stringify({ query: query.trim() }),
			});

			if (!resp.ok) {
				const data = await resp.json();
				throw new Error(data.error || `Request failed: ${resp.status}`);
			}

			result = await resp.json();
			track('search_result', {
				query: query.trim(),
				query_id: result?.query_id,
				topic_id: result?.topic?.id,
				topic_label: result?.topic?.label,
				is_new_topic: result?.topic?.is_new,
				source_count: result?.sources?.length,
				connection_count: result?.connections?.length,
				echo_count: result?.cross_query_connections?.length,
				gap_count: result?.gaps?.length,
				duration_ms: Date.now() - searchStart,
			});
		} catch (e: any) {
			error = e.message;
			track('search_error', { query: query.trim(), error: e.message });
		} finally {
			loading = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			search();
		}
	}

	function autoResize(e: Event) {
		const el = e.target as HTMLTextAreaElement;
		el.style.height = 'auto';
		el.style.height = el.scrollHeight + 'px';
	}

	function relationshipColor(rel: string): string {
		const colors: Record<string, string> = {
			agrees: 'text-agree',
			contradicts: 'text-contradict',
			extends: 'text-extend',
			gap: 'text-gap',
		};
		return colors[rel] ?? 'text-muted';
	}

	function relationshipBorder(rel: string): string {
		const colors: Record<string, string> = {
			agrees: 'border-agree/30',
			contradicts: 'border-contradict/30',
			extends: 'border-extend/30',
			gap: 'border-gap/30',
		};
		return colors[rel] ?? 'border-edge';
	}

	function followUp(q: string) {
		track('follow_up_click', { question: q, from_query: query.trim() });
		query = q;
		search();
	}

	function trackSourceClick(source: Source, index: number) {
		track('source_click', {
			source_url: source.url,
			source_title: source.title,
			position: index,
			query_id: result?.query_id,
		});
	}

	function trackEchoClick(cq: SearchResult['cross_query_connections'][0]) {
		track('echo_click', {
			related_url: cq.related_url,
			related_source: cq.related_source,
			from_query: cq.from_query,
			similarity: cq.similarity,
			query_id: result?.query_id,
		});
	}
</script>

<div class="min-h-screen bg-void text-text">
	<Header user={data.user} supabase={data.supabase} />

	<main class="mx-auto max-w-4xl px-6 py-12">
		<div class="relative">
			<textarea
				bind:value={query}
				onkeydown={handleKeydown}
				oninput={autoResize}
				placeholder="What do you want to explore?"
				disabled={loading}
				rows="1"
				class="w-full resize-none overflow-hidden rounded-lg border border-edge bg-surface px-5 py-4 pr-24 text-lg text-bright
					placeholder-muted outline-none transition-colors
					focus:border-accent/50 focus:ring-1 focus:ring-accent/25
					disabled:opacity-50"
			></textarea>
			<button
				onclick={search}
				disabled={loading || !query.trim()}
				class="absolute bottom-3 right-3 rounded-md bg-accent px-4 py-2
					text-sm font-medium text-bright transition-opacity
					hover:bg-accent-glow disabled:opacity-30"
			>
				{loading ? 'Searching...' : 'Search'}
			</button>
		</div>

		{#if error}
			<div class="mt-6 rounded-lg border border-contradict/30 bg-contradict/5 px-4 py-3 text-sm text-contradict">
				{error}
			</div>
		{/if}

		{#if loading}
			<div class="mt-16 flex flex-col items-center gap-4 text-muted">
				<div class="h-8 w-8 animate-spin rounded-full border-2 border-edge border-t-accent"></div>
				<p class="text-sm">Searching sources and mapping connections... (this might take a bit!)</p>
			</div>
		{/if}

		{#if result}
			<!-- Topic badge -->
			{#if result.topic}
				<div class="mt-6 flex items-center gap-3">
					<a
						href="/dashboard/topic/{result.topic.id}"
						class="inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/5
							px-4 py-1.5 text-sm text-accent transition-all
							hover:bg-accent/10 hover:border-accent/50 hover:shadow-[0_0_12px_rgba(124,111,247,0.15)]"
					>
						<span class="text-xs">&#10022;</span>
						{result.topic.label}
						{#if result.topic.is_new}
							<span class="rounded-full bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider">new</span>
						{/if}
					</a>
				</div>
			{/if}

			<!-- Synthesis -->
			<section class="mt-6">
				<h2 class="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">Synthesis</h2>
				<div class="rounded-lg border border-edge bg-deep p-5 text-[15px] leading-relaxed text-text">
					{result.synthesis}
				</div>
			</section>

			<!-- Cross-query connections -->
			{#if result.cross_query_connections?.length > 0}
				<section class="mt-8">
					<h2 class="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">
						<span class="text-accent">&#10022;</span> Echoes from past research
					</h2>
					<div class="space-y-2">
						{#each result.cross_query_connections as cq}
							<div class="rounded-lg border border-accent/15 bg-accent/3 p-4">
								<div class="flex items-start justify-between gap-3">
									<div class="min-w-0">
										<p class="text-sm text-text/90">
											<span class="font-medium text-bright">{cq.current_source}</span>
											<span class="text-muted mx-1">&harr;</span>
											<a href={cq.related_url} target="_blank" rel="noopener noreferrer"
												onclick={() => trackEchoClick(cq)}
												class="font-medium text-accent hover:text-accent-glow transition-colors"
											>{cq.related_source}</a>
										</p>
										<p class="mt-1 text-xs text-muted">
											from &ldquo;{cq.from_query}&rdquo;
										</p>
									</div>
									<span class="shrink-0 text-xs text-accent/70">
										{Math.round(cq.similarity * 100)}%
									</span>
								</div>
							</div>
						{/each}
					</div>
				</section>
			{/if}

			<!-- Connections -->
			{#if result.connections.length > 0}
				<section class="mt-8">
					<h2 class="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">
						Connections ({result.connections.length})
					</h2>
					<div class="space-y-3">
						{#each result.connections as conn}
							<div class="rounded-lg border {relationshipBorder(conn.relationship)} bg-deep p-4">
								<div class="mb-2 flex items-center gap-2 text-sm">
									<span class="font-medium {relationshipColor(conn.relationship)} uppercase text-xs tracking-wider">
										{conn.relationship}
									</span>
									<span class="text-muted">|</span>
									<span class="text-muted">strength {Math.round(conn.strength * 100)}%</span>
								</div>
								<div class="mb-2 flex items-center gap-2 text-sm text-muted">
									<span class="truncate text-text/80">{conn.source_a}</span>
									<span class="text-edge">&harr;</span>
									<span class="truncate text-text/80">{conn.source_b}</span>
								</div>
								<p class="text-sm leading-relaxed text-text/90">{conn.explanation}</p>
							</div>
						{/each}
					</div>
				</section>
			{/if}

			<!-- Gaps -->
			{#if result.gaps.length > 0}
				<section class="mt-8">
					<h2 class="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">
						Gaps in the research
					</h2>
					<ul class="space-y-2">
						{#each result.gaps as gap}
							<li class="flex items-start gap-2 rounded-lg border border-gap/20 bg-deep px-4 py-3 text-sm text-text/90">
								<span class="mt-0.5 text-gap">&#9672;</span>
								{gap}
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			<!-- Follow-up questions -->
			{#if result.follow_up_questions.length > 0}
				<section class="mt-8">
					<h2 class="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">
						Go deeper
					</h2>
					<div class="flex flex-wrap gap-2">
						{#each result.follow_up_questions as q}
							<button
								onclick={() => followUp(q)}
								class="rounded-full border border-accent/30 bg-accent/5 px-4 py-2 text-sm text-accent
									transition-colors hover:bg-accent/10 hover:border-accent/50"
							>
								{q}
							</button>
						{/each}
					</div>
				</section>
			{/if}

			<!-- Sources -->
			<section class="mt-8">
				<h2 class="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">
					Sources ({result.sources.length})
				</h2>
				<div class="space-y-3">
					{#each result.sources as source, i}
						<a
							href={source.url}
							target="_blank"
							rel="noopener noreferrer"
							onclick={() => trackSourceClick(source, i)}
							class="block rounded-lg border border-edge bg-deep p-4 transition-colors hover:border-edge hover:bg-surface"
						>
							<h3 class="text-sm font-medium text-bright">{source.title}</h3>
							<p class="mt-1 text-xs text-muted truncate">{source.url}</p>
							{#if source.summary}
								<p class="mt-2 text-sm leading-relaxed text-text/80">{source.summary}</p>
							{/if}
						</a>
					{/each}
				</div>
			</section>
		{/if}
	</main>
</div>
