<script lang="ts">
	import Header from '$lib/components/Header.svelte';
	import { goto } from '$app/navigation';
	import { track } from '$lib/analytics';

	let { data } = $props();

	interface Topic {
		id: string;
		label: string;
		description: string | null;
		query_count: number;
		created_at: string;
		updated_at: string;
		latest_query: string | null;
		latest_query_at: string | null;
	}

	let topics: Topic[] = $state([]);
	let loading = $state(true);
	let error: string | null = $state(null);

	$effect(() => {
		loadTopics();
	});

	async function loadTopics() {
		loading = true;
		error = null;
		try {
			const { data: topicData, error: err } = await data.supabase.rpc('get_user_topics', {
				p_user_id: data.user?.id,
			});
			if (err) throw err;
			topics = topicData ?? [];
		} catch (e: any) {
			error = e.message;
		} finally {
			loading = false;
		}
	}

	function timeAgo(dateStr: string): string {
		const diff = Date.now() - new Date(dateStr).getTime();
		const mins = Math.floor(diff / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		if (days < 30) return `${days}d ago`;
		const months = Math.floor(days / 30);
		return `${months}mo ago`;
	}

	function depthLabel(count: number): string {
		if (count >= 20) return 'Deep';
		if (count >= 10) return 'Explored';
		if (count >= 5) return 'Growing';
		if (count >= 2) return 'Emerging';
		return 'Seeded';
	}

	function depthColor(count: number): string {
		if (count >= 20) return 'text-accent-glow';
		if (count >= 10) return 'text-accent';
		if (count >= 5) return 'text-extend';
		if (count >= 2) return 'text-agree';
		return 'text-muted';
	}

	function depthGlow(count: number): string {
		if (count >= 10) return 'shadow-[0_0_20px_rgba(124,111,247,0.15)]';
		if (count >= 5) return 'shadow-[0_0_12px_rgba(124,111,247,0.08)]';
		return '';
	}

	function depthBarWidth(count: number): string {
		const pct = Math.min(100, (count / 20) * 100);
		return `${pct}%`;
	}
</script>

<div class="min-h-screen bg-void text-text">
	<Header user={data.user} supabase={data.supabase} />

	<main class="mx-auto max-w-5xl px-6 py-10">
		<div class="mb-10 flex items-end justify-between">
			<div>
				<h2 class="text-2xl font-light text-bright">Research Spaces</h2>
				<p class="mt-1 text-sm text-muted">
					{topics.length} topic{topics.length !== 1 ? 's' : ''} &middot; your queries auto-cluster into research threads
				</p>
			</div>
			<div class="flex items-center gap-3">
				<a
					href="/dashboard/graph"
					class="rounded-lg border border-edge px-4 py-2 text-sm text-muted
						transition-all hover:border-accent/30 hover:text-bright"
				>
					View graph
				</a>
				<a
					href="/search"
					class="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bright
						transition-all hover:bg-accent-glow hover:shadow-[0_0_20px_rgba(124,111,247,0.3)]"
				>
					New search
				</a>
			</div>
		</div>

		{#if loading}
			<div class="mt-20 flex flex-col items-center gap-4 text-muted">
				<div class="h-8 w-8 animate-spin rounded-full border-2 border-edge border-t-accent"></div>
				<p class="text-sm">Loading your research spaces...</p>
			</div>
		{:else if error}
			<div class="mt-6 rounded-lg border border-contradict/30 bg-contradict/5 px-4 py-3 text-sm text-contradict">
				{error}
			</div>
		{:else if topics.length === 0}
			<div class="mt-20 flex flex-col items-center gap-6 text-center">
				<div class="text-6xl opacity-20">&#10022;</div>
				<div>
					<p class="text-lg text-bright/80">No research spaces yet</p>
					<p class="mt-2 text-sm text-muted max-w-md">
						Every search you make gets clustered into a research space automatically.
						The more you search, the more connections emerge.
					</p>
				</div>
				<a
					href="/search"
					class="rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-bright
						transition-all hover:bg-accent-glow"
				>
					Start exploring
				</a>
			</div>
		{:else}
			<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{#each topics as topic}
					<button
						onclick={() => {
							track('topic_click', { topic_id: topic.id, topic_label: topic.label, query_count: topic.query_count });
							goto(`/dashboard/topic/${topic.id}`);
						}}
						class="group relative overflow-hidden rounded-xl border border-edge bg-deep p-5
							text-left transition-all duration-300
							hover:border-accent/30 hover:bg-surface {depthGlow(topic.query_count)}
							hover:shadow-[0_0_30px_rgba(124,111,247,0.2)]"
					>
						<!-- Depth indicator bar -->
						<div class="absolute bottom-0 left-0 h-0.5 bg-gradient-to-r from-accent/60 to-accent-glow/40
							transition-all duration-500 group-hover:h-1"
							style="width: {depthBarWidth(topic.query_count)}"
						></div>

						<div class="mb-3 flex items-start justify-between gap-2">
							<h3 class="text-base font-medium text-bright leading-tight group-hover:text-accent-glow transition-colors">
								{topic.label}
							</h3>
							<span class="shrink-0 rounded-full border border-edge bg-void px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider {depthColor(topic.query_count)}">
								{depthLabel(topic.query_count)}
							</span>
						</div>

						<div class="mb-3 flex items-center gap-3 text-xs text-muted">
							<span>{topic.query_count} quer{topic.query_count === 1 ? 'y' : 'ies'}</span>
							<span class="text-edge">&middot;</span>
							<span>{timeAgo(topic.updated_at)}</span>
						</div>

						{#if topic.latest_query}
							<p class="text-sm text-text/60 line-clamp-2 leading-relaxed">
								&ldquo;{topic.latest_query}&rdquo;
							</p>
						{/if}
					</button>
				{/each}
			</div>
		{/if}
	</main>
</div>
