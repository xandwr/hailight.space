<script lang="ts">
	import { PUBLIC_SUPABASE_PROJECT_URL } from '$env/static/public';
	import Header from '$lib/components/Header.svelte';
	import { goto } from '$app/navigation';

	let { data } = $props();

	interface HarvestState {
		source_type: string;
		resumption_token: string | null;
		last_from_date: string | null;
		last_harvested_at: string | null;
		total_ingested: number;
		is_complete: boolean;
	}

	interface SourceCount {
		source_type: string;
		count: number;
	}

	interface ResearchSummary {
		status: string;
		count: number;
		avg_sources_found: number;
		avg_bridge_improvement: number;
	}

	interface UserStats {
		total_users: number;
		total_queries: number;
		total_events: number;
		total_sources: number;
		total_topics: number;
	}

	interface RecentEvent {
		event_type: string;
		properties: Record<string, unknown>;
		page: string;
		created_at: string;
	}

	interface CronHealth {
		job_name: string;
		last_run_at: string | null;
		last_status: string;
		last_duration_ms: number | null;
		last_error: string | null;
		success_count_24h: number;
		fail_count_24h: number;
		success_count_7d: number;
		fail_count_7d: number;
		avg_duration_ms_24h: number | null;
		expected_interval_mins: number;
	}

	interface CronRecent {
		job_name: string;
		status: string;
		http_status: number | null;
		started_at: string;
		completed_at: string | null;
		duration_ms: number | null;
		result: Record<string, unknown> | null;
		error: string | null;
	}

	interface TopicInfo {
		topic_id: string;
		label: string;
		query_count: number;
		user_email: string;
	}

	interface AdminData {
		harvest: HarvestState[];
		source_counts: SourceCount[];
		research_directions: ResearchSummary[];
		user_stats: UserStats[];
		recent_events: RecentEvent[];
		cron_health: CronHealth[];
		cron_recent: CronRecent[];
		top_topics: TopicInfo[];
		elapsed_ms: number;
	}

	let loading = $state(true);
	let error: string | null = $state(null);
	let stats: AdminData | null = $state(null);

	$effect(() => {
		loadStats();
	});

	async function loadStats() {
		loading = true;
		error = null;

		try {
			const session = data.session;
			if (!session?.access_token) {
				goto('/auth');
				return;
			}

			const resp = await fetch(`${PUBLIC_SUPABASE_PROJECT_URL}/functions/v1/admin-stats`, {
				headers: {
					Authorization: `Bearer ${session.access_token}`,
				},
			});

			if (resp.status === 401) {
				error = 'Not authorized. Admin access required.';
				return;
			}

			if (!resp.ok) {
				const body = await resp.json();
				throw new Error(body.error?.message || `Request failed: ${resp.status}`);
			}

			stats = await resp.json();
		} catch (e: any) {
			error = e.message;
		} finally {
			loading = false;
		}
	}

	function timeAgo(dateStr: string | null): string {
		if (!dateStr) return 'never';
		const diff = Date.now() - new Date(dateStr).getTime();
		const mins = Math.floor(diff / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		return `${days}d ago`;
	}

	function statusColor(status: string): string {
		switch (status) {
			case 'completed': return 'text-agree';
			case 'failed': return 'text-contradict';
			case 'pending': case 'searching': return 'text-gap';
			case 'exhausted': return 'text-muted';
			default: return 'text-text';
		}
	}

	function eventColor(type: string): string {
		if (type.includes('error')) return 'text-contradict';
		if (type === 'search') return 'text-accent';
		if (type.includes('click')) return 'text-extend';
		return 'text-muted';
	}

	function formatNumber(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
		return n.toString();
	}

	function formatDuration(ms: number | null): string {
		if (ms === null) return '—';
		if (ms < 1000) return `${ms}ms`;
		const secs = ms / 1000;
		if (secs < 60) return `${secs.toFixed(1)}s`;
		const mins = Math.floor(secs / 60);
		const remainSecs = Math.round(secs % 60);
		return `${mins}m${remainSecs}s`;
	}

	function isStale(job: CronHealth): boolean {
		if (!job.last_run_at) return true;
		const msSince = Date.now() - new Date(job.last_run_at).getTime();
		return msSince > job.expected_interval_mins * 60_000 * 2;
	}

	function cronStatusColor(status: string): string {
		switch (status) {
			case 'completed': return 'text-agree';
			case 'failed': return 'text-contradict';
			case 'timeout': return 'text-contradict';
			case 'running': return 'text-gap';
			case 'never': return 'text-muted/50';
			default: return 'text-text';
		}
	}

	let expandedJob: string | null = $state(null);
</script>

<div class="min-h-screen bg-void text-text">
	<Header user={data.user} supabase={data.supabase} />

	<main class="mx-auto max-w-6xl px-6 py-10">
		<div class="mb-8 flex items-center justify-between">
			<div>
				<h2 class="text-2xl font-light text-bright">Admin</h2>
				<p class="mt-1 text-sm text-muted">System health, harvest progress, and platform stats.</p>
			</div>
			<button
				onclick={() => loadStats()}
				disabled={loading}
				class="rounded-lg border border-edge px-4 py-2 text-sm text-muted
					transition-all hover:border-accent/30 hover:text-bright disabled:opacity-30"
			>
				{loading ? 'Loading...' : 'Refresh'}
			</button>
		</div>

		{#if loading && !stats}
			<div class="mt-20 flex flex-col items-center gap-4 text-muted">
				<div class="h-8 w-8 animate-spin rounded-full border-2 border-edge border-t-accent"></div>
				<p class="text-sm">Loading admin stats...</p>
			</div>
		{:else if error}
			<div class="mt-6 rounded-lg border border-contradict/30 bg-contradict/5 px-4 py-3 text-sm text-contradict">
				{error}
			</div>
		{:else if stats}
			{@const u = stats.user_stats[0]}

			<!-- Overview counters -->
			<div class="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-5">
				{#each [
					{ label: 'Sources', value: u?.total_sources ?? 0, color: 'text-bright' },
					{ label: 'Topics', value: u?.total_topics ?? 0, color: 'text-accent' },
					{ label: 'Queries', value: u?.total_queries ?? 0, color: 'text-extend' },
					{ label: 'Events', value: u?.total_events ?? 0, color: 'text-muted' },
					{ label: 'Users', value: u?.total_users ?? 0, color: 'text-agree' },
				] as stat}
					<div class="rounded-lg border border-edge bg-deep px-4 py-3">
						<div class="text-2xl font-light {stat.color}">{formatNumber(stat.value)}</div>
						<div class="text-xs text-muted">{stat.label}</div>
					</div>
				{/each}
			</div>

			<!-- Source breakdown + Harvest state side by side -->
			<div class="mb-8 grid gap-6 lg:grid-cols-2">
				<!-- Source counts by type -->
				<section>
					<h3 class="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">Sources by type</h3>
					<div class="rounded-lg border border-edge bg-deep p-4">
						{#each stats.source_counts as sc}
							<div class="flex items-center justify-between py-2 {stats.source_counts.indexOf(sc) > 0 ? 'border-t border-edge/50' : ''}">
								<span class="text-sm text-bright capitalize">{sc.source_type}</span>
								<span class="text-sm text-muted">{formatNumber(sc.count)}</span>
							</div>
						{/each}
					</div>
				</section>

				<!-- Harvest state -->
				<section>
					<h3 class="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">Harvest state</h3>
					<div class="space-y-3">
						{#each stats.harvest as h}
							<div class="rounded-lg border border-edge bg-deep p-4">
								<div class="flex items-center justify-between mb-2">
									<span class="text-sm font-medium text-bright capitalize">{h.source_type}</span>
									<span class="text-xs {h.is_complete ? 'text-agree' : 'text-gap'}">
										{h.is_complete ? 'Complete' : 'In progress'}
									</span>
								</div>
								<div class="grid grid-cols-2 gap-2 text-xs text-muted">
									<div>Ingested: <span class="text-text">{formatNumber(h.total_ingested)}</span></div>
									<div>Last run: <span class="text-text">{timeAgo(h.last_harvested_at)}</span></div>
								</div>
								{#if h.resumption_token}
									<div class="mt-2 text-xs text-muted/50 truncate" title={h.resumption_token}>
										Token: {h.resumption_token.slice(0, 40)}...
									</div>
								{/if}
							</div>
						{/each}
					</div>
				</section>
			</div>

			<!-- Cron Health -->
			<section class="mb-8">
				<h3 class="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">Cron health</h3>
				<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{#each stats.cron_health as job}
						{@const stale = isStale(job)}
						<button
							class="rounded-lg border bg-deep p-4 text-left transition-all
								{stale ? 'border-contradict/40' : 'border-edge'}
								hover:border-accent/30"
							onclick={() => expandedJob = expandedJob === job.job_name ? null : job.job_name}
						>
							<div class="flex items-center justify-between mb-2">
								<span class="text-sm font-medium text-bright">{job.job_name}</span>
								{#if stale}
									<span class="text-xs text-contradict font-medium">STALE</span>
								{:else}
									<span class="text-xs {cronStatusColor(job.last_status)} capitalize">{job.last_status}</span>
								{/if}
							</div>

							<div class="grid grid-cols-2 gap-y-1.5 text-xs">
								<div class="text-muted">Last run</div>
								<div class="text-right text-text">{timeAgo(job.last_run_at)}</div>

								<div class="text-muted">Duration</div>
								<div class="text-right text-text">{formatDuration(job.last_duration_ms)}</div>

								<div class="text-muted">24h</div>
								<div class="text-right">
									<span class="text-agree">{job.success_count_24h}</span>
									{#if job.fail_count_24h > 0}
										<span class="text-muted">/</span>
										<span class="text-contradict">{job.fail_count_24h}</span>
									{/if}
								</div>

								<div class="text-muted">7d</div>
								<div class="text-right">
									<span class="text-agree">{job.success_count_7d}</span>
									{#if job.fail_count_7d > 0}
										<span class="text-muted">/</span>
										<span class="text-contradict">{job.fail_count_7d}</span>
									{/if}
								</div>

								{#if job.avg_duration_ms_24h}
									<div class="text-muted">Avg</div>
									<div class="text-right text-text">{formatDuration(job.avg_duration_ms_24h)}</div>
								{/if}
							</div>

							{#if job.last_error}
								<p class="mt-2 text-xs text-contradict truncate" title={job.last_error}>{job.last_error}</p>
							{/if}

							<!-- Expanded: recent executions for this job -->
							{#if expandedJob === job.job_name}
								{@const jobRecent = (stats.cron_recent ?? []).filter(r => r.job_name === job.job_name)}
								{#if jobRecent.length > 0}
									<div class="mt-3 border-t border-edge/50 pt-2 space-y-1.5">
										<div class="text-xs text-muted font-medium mb-1">Recent runs</div>
										{#each jobRecent as run}
											<div class="flex items-center justify-between text-xs gap-2">
												<span class="{cronStatusColor(run.status)} capitalize">{run.status}</span>
												<span class="text-muted truncate flex-1 text-center">{formatDuration(run.duration_ms)}</span>
												<span class="text-muted">{timeAgo(run.started_at)}</span>
											</div>
											{#if run.error}
												<p class="text-xs text-contradict/70 truncate pl-2">{run.error}</p>
											{/if}
										{/each}
									</div>
								{:else}
									<p class="mt-3 border-t border-edge/50 pt-2 text-xs text-muted">No execution history yet.</p>
								{/if}
							{/if}
						</button>
					{/each}
				</div>
				{#if stats.cron_health.length === 0}
					<p class="text-sm text-muted mt-2">No cron jobs configured.</p>
				{/if}
			</section>

			<!-- Research directions summary -->
			<section class="mb-8">
				<h3 class="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">Auto-research summary</h3>
				<div class="rounded-lg border border-edge bg-deep p-4">
					{#if stats.research_directions.length === 0}
						<p class="text-sm text-muted">No research directions yet.</p>
					{:else}
						{#each stats.research_directions as rd}
							<div class="flex items-center justify-between py-2 {stats.research_directions.indexOf(rd) > 0 ? 'border-t border-edge/50' : ''}">
								<span class="text-sm {statusColor(rd.status)} capitalize">{rd.status}</span>
								<div class="flex items-center gap-4 text-xs text-muted">
									<span>{rd.count} runs</span>
									<span>avg {rd.avg_sources_found ?? 0} sources</span>
									<span class="{(rd.avg_bridge_improvement ?? 0) > 0 ? 'text-agree' : 'text-muted'}">
										{(rd.avg_bridge_improvement ?? 0) > 0 ? '+' : ''}{((rd.avg_bridge_improvement ?? 0) * 100).toFixed(1)}% bridge
									</span>
								</div>
							</div>
						{/each}
					{/if}
				</div>
			</section>

			<!-- Topics -->
			<section class="mb-8">
				<h3 class="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">Topics</h3>
				<div class="rounded-lg border border-edge bg-deep overflow-hidden">
					<table class="w-full text-sm">
						<thead>
							<tr class="border-b border-edge text-xs text-muted uppercase tracking-wider">
								<th class="px-4 py-2 text-left">Topic</th>
								<th class="px-4 py-2 text-left">User</th>
								<th class="px-4 py-2 text-right">Queries</th>
							</tr>
						</thead>
						<tbody>
							{#each stats.top_topics as topic}
								<tr class="border-t border-edge/30 hover:bg-surface transition-colors">
									<td class="px-4 py-2 text-bright">{topic.label}</td>
									<td class="px-4 py-2 text-muted text-xs">{topic.user_email}</td>
									<td class="px-4 py-2 text-right text-muted">{topic.query_count}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>

			<!-- Recent events -->
			<section class="mb-8">
				<h3 class="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">Recent events</h3>
				<div class="rounded-lg border border-edge bg-deep overflow-hidden max-h-[400px] overflow-y-auto">
					<table class="w-full text-sm">
						<thead class="sticky top-0 bg-deep">
							<tr class="border-b border-edge text-xs text-muted uppercase tracking-wider">
								<th class="px-4 py-2 text-left">Type</th>
								<th class="px-4 py-2 text-left">Page</th>
								<th class="px-4 py-2 text-left">Details</th>
								<th class="px-4 py-2 text-right">When</th>
							</tr>
						</thead>
						<tbody>
							{#each stats.recent_events as event}
								<tr class="border-t border-edge/30 hover:bg-surface transition-colors">
									<td class="px-4 py-2 {eventColor(event.event_type)} text-xs font-medium">{event.event_type}</td>
									<td class="px-4 py-2 text-muted text-xs">{event.page ?? '—'}</td>
									<td class="px-4 py-2 text-xs text-muted/70 truncate max-w-[300px]">
										{#if event.properties?.query}
											{event.properties.query}
										{:else if event.properties?.source_title}
											{event.properties.source_title}
										{:else}
											—
										{/if}
									</td>
									<td class="px-4 py-2 text-right text-xs text-muted">{timeAgo(event.created_at)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>

			<!-- Footer -->
			<div class="text-center text-xs text-muted/50">
				Loaded in {stats.elapsed_ms}ms
			</div>
		{/if}
	</main>
</div>
