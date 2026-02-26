<script lang="ts">
	import Header from '$lib/components/Header.svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';

	let { data } = $props();

	let topicId = $derived($page.params.id);

	interface TopicQuery {
		query_id: string;
		raw_input: string;
		created_at: string;
		synthesis: string | null;
		gaps_identified: string[] | null;
		follow_up_questions: string[] | null;
		source_count: number;
		connection_count: number;
	}

	interface TopicInfo {
		id: string;
		label: string;
		description: string | null;
		query_count: number;
		created_at: string;
		updated_at: string;
	}

	let topic: TopicInfo | null = $state(null);
	let queries: TopicQuery[] = $state([]);
	let loading = $state(true);
	let error: string | null = $state(null);
	let expandedQuery: string | null = $state(null);

	$effect(() => {
		loadTopic();
	});

	async function loadTopic() {
		loading = true;
		error = null;
		try {
			// Load topic metadata
			const { data: topicData, error: topicErr } = await data.supabase
				.from('topics')
				.select('id, label, description, query_count, created_at, updated_at')
				.eq('id', topicId)
				.single();
			if (topicErr) throw topicErr;
			topic = topicData;

			// Load queries for this topic
			const { data: queryData, error: queryErr } = await data.supabase.rpc('get_topic_queries', {
				p_topic_id: topicId,
				p_user_id: data.user?.id,
			});
			if (queryErr) throw queryErr;
			queries = queryData ?? [];
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

	function formatDate(dateStr: string): string {
		return new Date(dateStr).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
		});
	}

	function toggleExpand(id: string) {
		expandedQuery = expandedQuery === id ? null : id;
	}

	function searchFollowUp(q: string) {
		goto(`/?q=${encodeURIComponent(q)}`);
	}
</script>

<div class="min-h-screen bg-void text-text">
	<Header user={data.user} supabase={data.supabase} />

	<main class="mx-auto max-w-4xl px-6 py-10">
		{#if loading}
			<div class="mt-20 flex flex-col items-center gap-4 text-muted">
				<div class="h-8 w-8 animate-spin rounded-full border-2 border-edge border-t-accent"></div>
				<p class="text-sm">Loading research space...</p>
			</div>
		{:else if error}
			<div class="mt-6 rounded-lg border border-contradict/30 bg-contradict/5 px-4 py-3 text-sm text-contradict">
				{error}
			</div>
		{:else if topic}
			<!-- Topic header -->
			<div class="mb-10">
				<div class="mb-4 flex items-center gap-3">
					<a href="/dashboard" class="text-muted hover:text-text transition-colors text-sm">&larr; Spaces</a>
				</div>
				<h2 class="text-3xl font-light text-bright">{topic.label}</h2>
				<div class="mt-2 flex items-center gap-4 text-sm text-muted">
					<span>{topic.query_count} quer{topic.query_count === 1 ? 'y' : 'ies'}</span>
					<span class="text-edge">&middot;</span>
					<span>Started {timeAgo(topic.created_at)}</span>
					<span class="text-edge">&middot;</span>
					<span>Last active {timeAgo(topic.updated_at)}</span>
				</div>
			</div>

			<!-- Research timeline -->
			{#if queries.length === 0}
				<p class="text-sm text-muted">No queries in this topic yet.</p>
			{:else}
				<div class="relative">
					<!-- Timeline line -->
					<div class="absolute left-[11px] top-2 bottom-2 w-px bg-gradient-to-b from-accent/40 via-edge to-transparent"></div>

					<div class="space-y-6">
						{#each queries as q, i}
							<div class="relative pl-10">
								<!-- Timeline dot -->
								<div class="absolute left-0 top-1.5 h-[23px] w-[23px] rounded-full border-2 border-edge bg-deep
									flex items-center justify-center
									{i === 0 ? 'border-accent bg-accent/10' : ''}">
									<div class="h-2 w-2 rounded-full {i === 0 ? 'bg-accent' : 'bg-edge'}"></div>
								</div>

								<div
									onclick={() => toggleExpand(q.query_id)}
									onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleExpand(q.query_id); }}
									role="button"
									tabindex="0"
									class="w-full text-left group cursor-pointer"
								>
									<div class="rounded-xl border border-edge bg-deep p-5 transition-all duration-200
										hover:border-accent/20 hover:bg-surface
										{expandedQuery === q.query_id ? 'border-accent/30 bg-surface' : ''}">

										<div class="flex items-start justify-between gap-4">
											<h3 class="text-[15px] font-medium text-bright leading-snug group-hover:text-accent-glow transition-colors">
												{q.raw_input}
											</h3>
											<span class="shrink-0 text-xs text-muted">{formatDate(q.created_at)}</span>
										</div>

										<div class="mt-2 flex items-center gap-3 text-xs text-muted">
											<span>{q.source_count} source{q.source_count !== 1 ? 's' : ''}</span>
											<span class="text-edge">&middot;</span>
											<span>{q.connection_count} connection{q.connection_count !== 1 ? 's' : ''}</span>
										</div>

										{#if expandedQuery === q.query_id}
											<div class="mt-4 space-y-4 border-t border-edge/50 pt-4">
												{#if q.synthesis}
													<div>
														<h4 class="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted">Synthesis</h4>
														<p class="text-sm leading-relaxed text-text/80">{q.synthesis}</p>
													</div>
												{/if}

												{#if q.gaps_identified?.length}
													<div>
														<h4 class="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted">Gaps</h4>
														<ul class="space-y-1">
															{#each q.gaps_identified as gap}
																<li class="flex items-start gap-2 text-sm text-text/70">
																	<span class="mt-0.5 text-gap text-xs">&#9672;</span>
																	{gap}
																</li>
															{/each}
														</ul>
													</div>
												{/if}

												{#if q.follow_up_questions?.length}
													<div>
														<h4 class="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted">Go deeper</h4>
														<div class="flex flex-wrap gap-2">
															{#each q.follow_up_questions as fq}
																<button
																	onclick={(e) => { e.stopPropagation(); searchFollowUp(fq); }}
																	class="rounded-full border border-accent/30 bg-accent/5 px-3 py-1.5 text-xs text-accent
																		transition-colors hover:bg-accent/10 hover:border-accent/50"
																>
																	{fq}
																</button>
															{/each}
														</div>
													</div>
												{/if}
											</div>
										{/if}
									</div>
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		{/if}
	</main>
</div>
