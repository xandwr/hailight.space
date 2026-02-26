<script lang="ts">
	import { goto } from '$app/navigation';
	import Header from '$lib/components/Header.svelte';
	import KnowledgeGraph from '$lib/components/KnowledgeGraph.svelte';
	import { loadGraphData } from '$lib/graph/data';
	import type { GraphNode, GraphEdge } from '$lib/types/graph';
	import { PUBLIC_SUPABASE_PROJECT_URL } from '$env/static/public';

	let { data } = $props();

	let nodes: GraphNode[] = $state([]);
	let edges: GraphEdge[] = $state([]);
	let loading = $state(true);
	let error: string | null = $state(null);
	let researchingGap: string | null = $state(null);

	$effect(() => {
		loadGraph();
	});

	async function loadGraph() {
		loading = true;
		error = null;
		try {
			const result = await loadGraphData(data.supabase, data.user!.id);
			nodes = result.nodes;
			edges = result.edges;
		} catch (e: any) {
			error = e.message;
		} finally {
			loading = false;
		}
	}

	async function handleGapClick(edge: GraphEdge) {
		const s = typeof edge.source === 'string' ? edge.source : (edge.source as GraphNode).label;
		const t = typeof edge.target === 'string' ? edge.target : (edge.target as GraphNode).label;

		// Use labels if we have resolved nodes
		const labelA =
			typeof edge.source !== 'string' ? (edge.source as GraphNode).label : s;
		const labelB =
			typeof edge.target !== 'string' ? (edge.target as GraphNode).label : t;

		const bridgeQuery = `connections between ${labelA} and ${labelB}`;
		const edgeKey = `${s}::${t}`;
		researchingGap = edgeKey;

		try {
			const resp = await fetch(`${PUBLIC_SUPABASE_PROJECT_URL}/functions/v1/search`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${data.session?.access_token}`,
				},
				body: JSON.stringify({ query: bridgeQuery }),
			});
			if (!resp.ok) {
				const body = await resp.json().catch(() => ({}));
				throw new Error(body.error?.message ?? `Search failed (${resp.status})`);
			}
			// Reload the graph to reflect new data
			await loadGraph();
		} catch (e: any) {
			error = e.message;
		} finally {
			researchingGap = null;
		}
	}

	function handleNodeClick(node: GraphNode) {
		goto(`/dashboard/topic/${node.id}`);
	}

	let bridgeCount = $derived(edges.filter((e) => e.type === 'bridge').length);
	let gapCount = $derived(edges.filter((e) => e.type === 'gap').length);
</script>

<div class="flex min-h-screen flex-col bg-void text-text">
	<Header user={data.user} supabase={data.supabase} />

	<main class="flex flex-1 flex-col px-6 py-6">
		<div class="mx-auto mb-4 flex w-full max-w-7xl items-end justify-between">
			<div>
				<h2 class="text-2xl font-light text-bright">Knowledge Graph</h2>
				<p class="mt-1 text-sm text-muted">
					{nodes.length} topic{nodes.length !== 1 ? 's' : ''}
					&middot; {bridgeCount} bridge{bridgeCount !== 1 ? 's' : ''}
					&middot; {gapCount} gap{gapCount !== 1 ? 's' : ''}
					{#if researchingGap}
						&middot; <span class="text-gap">researching gap&hellip;</span>
					{/if}
				</p>
			</div>
			<div class="flex items-center gap-3">
				<a
					href="/dashboard"
					class="rounded-lg border border-edge px-4 py-2 text-sm text-muted
						transition-all hover:border-accent/30 hover:text-bright"
				>
					Grid view
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
			<div class="flex flex-1 items-center justify-center">
				<div class="flex flex-col items-center gap-4 text-muted">
					<div class="h-8 w-8 animate-spin rounded-full border-2 border-edge border-t-accent"></div>
					<p class="text-sm">Loading knowledge graph&hellip;</p>
				</div>
			</div>
		{:else if error}
			<div class="mx-auto mt-6 w-full max-w-7xl rounded-lg border border-contradict/30 bg-contradict/5 px-4 py-3 text-sm text-contradict">
				{error}
			</div>
		{:else if nodes.length === 0}
			<div class="flex flex-1 items-center justify-center">
				<div class="flex flex-col items-center gap-6 text-center">
					<div class="text-6xl opacity-20">&#10038;</div>
					<div>
						<p class="text-lg text-bright/80">No topics yet</p>
						<p class="mt-2 max-w-md text-sm text-muted">
							Your knowledge graph grows as you search. Each query clusters into a
							topic, and connections between topics appear as bridges.
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
			</div>
		{:else if nodes.length === 1}
			<div class="flex flex-1 items-center justify-center">
				<div class="flex flex-col items-center gap-6 text-center">
					<div
						class="flex h-24 w-24 items-center justify-center rounded-full border-2 border-accent/40
							bg-deep shadow-[0_0_30px_rgba(124,111,247,0.15)]"
					>
						<span class="text-sm text-accent">{nodes[0].queryCount}</span>
					</div>
					<div>
						<p class="text-lg text-bright/80">{nodes[0].label}</p>
						<p class="mt-2 max-w-md text-sm text-muted">
							One topic so far. Search more to see connections form between your research areas.
						</p>
					</div>
					<a
						href="/search"
						class="rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-bright
							transition-all hover:bg-accent-glow"
					>
						Keep exploring
					</a>
				</div>
			</div>
		{:else}
			<div class="mx-auto w-full max-w-7xl" style="height: calc(100vh - 160px); min-height: 400px;">
				<KnowledgeGraph
					{nodes}
					{edges}
					onGapClick={handleGapClick}
					onNodeClick={handleNodeClick}
				/>
			</div>
		{/if}
	</main>
</div>
