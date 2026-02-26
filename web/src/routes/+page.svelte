<script lang="ts">
	import { PUBLIC_SUPABASE_PROJECT_URL } from '$env/static/public';
	import { goto, invalidate } from '$app/navigation';

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

	interface SearchResult {
		query_id: string;
		sources: Source[];
		connections: Connection[];
		synthesis: string;
		gaps: string[];
		follow_up_questions: string[];
	}

	async function search() {
		if (!query.trim() || loading) return;
		loading = true;
		error = null;
		result = null;

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
		} catch (e: any) {
			error = e.message;
		} finally {
			loading = false;
		}
	}

	async function logout() {
		await data.supabase.auth.signOut();
		goto('/auth');
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			search();
		}
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
		query = q;
		search();
	}
</script>

<div class="min-h-screen bg-void text-text">
	<!-- Header -->
	<header class="border-b border-edge/50 px-6 py-4">
		<div class="mx-auto max-w-4xl flex items-center justify-between">
			<div>
				<h1 class="text-2xl font-light tracking-wide text-bright">
					hai<span class="text-accent">light</span>
				</h1>
				<p class="mt-1 text-sm text-muted">the space between the stars</p>
			</div>
			<div class="flex items-center gap-4">
				<span class="text-xs text-muted">{data.user?.email}</span>
				<button
					onclick={logout}
					class="rounded-md border border-edge px-3 py-1.5 text-xs text-muted
						transition-colors hover:border-edge hover:text-text"
				>
					Log out
				</button>
			</div>
		</div>
	</header>

	<!-- Search -->
	<main class="mx-auto max-w-4xl px-6 py-12">
		<div class="relative">
			<input
				type="text"
				bind:value={query}
				onkeydown={handleKeydown}
				placeholder="What do you want to explore?"
				disabled={loading}
				class="w-full rounded-lg border border-edge bg-surface px-5 py-4 text-lg text-bright
					placeholder-muted outline-none transition-colors
					focus:border-accent/50 focus:ring-1 focus:ring-accent/25
					disabled:opacity-50"
			/>
			<button
				onclick={search}
				disabled={loading || !query.trim()}
				class="absolute right-2 top-1/2 -translate-y-1/2 rounded-md bg-accent px-4 py-2
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
				<p class="text-sm">Searching sources and mapping connections...</p>
			</div>
		{/if}

		{#if result}
			<!-- Synthesis -->
			<section class="mt-10">
				<h2 class="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">Synthesis</h2>
				<div class="rounded-lg border border-edge bg-deep p-5 text-[15px] leading-relaxed text-text">
					{result.synthesis}
				</div>
			</section>

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
					{#each result.sources as source}
						<a
							href={source.url}
							target="_blank"
							rel="noopener noreferrer"
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
