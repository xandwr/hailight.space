<script lang="ts">
	import { onMount } from 'svelte';
	import {
		forceSimulation,
		forceLink,
		forceManyBody,
		forceCollide,
		forceX,
		forceY,
	} from 'd3-force';
	import { drag } from 'd3-drag';
	import { zoom } from 'd3-zoom';
	import { select, selectAll } from 'd3-selection';
	import type { GraphNode, GraphEdge } from '$lib/types/graph';

	let {
		nodes,
		edges,
		onGapClick,
		onNodeClick,
	}: {
		nodes: GraphNode[];
		edges: GraphEdge[];
		onGapClick: (edge: GraphEdge) => void;
		onNodeClick: (node: GraphNode) => void;
	} = $props();

	let containerEl: HTMLDivElement;
	let hoveredNode: GraphNode | null = $state(null);
	let hoveredEdge: GraphEdge | null = $state(null);
	let mousePos = $state({ x: 0, y: 0 });

	let simulation: ReturnType<typeof forceSimulation<GraphNode>> | null = null;

	function truncate(s: string, max: number): string {
		return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
	}

	function nodeGlowOpacity(n: GraphNode): number {
		return Math.min(0.4, 0.08 + n.queryCount * 0.015);
	}

	function sourceNode(e: GraphEdge): GraphNode {
		return e.source as GraphNode;
	}

	function targetNode(e: GraphEdge): GraphNode {
		return e.target as GraphNode;
	}

	onMount(() => {
		let cleanup: (() => void) | undefined;

		// Wait a frame so the container has layout dimensions from CSS calc()
		requestAnimationFrame(() => {
			cleanup = initGraph();
		});

		return () => cleanup?.();
	});

	function initGraph(): (() => void) | undefined {
		const rect = containerEl.getBoundingClientRect();
		const width = rect.width;
		const height = rect.height;

		if (nodes.length === 0 || width === 0 || height === 0) return;

		const cx = width / 2;
		const cy = height / 2;

		// Clone data for D3 mutation
		const simNodes: GraphNode[] = nodes.map((n) => ({
			...n,
			x: cx + (Math.random() - 0.5) * 200,
			y: cy + (Math.random() - 0.5) * 200,
		}));
		const simEdges: GraphEdge[] = edges.map((e) => ({ ...e }));

		// Build SVG structure with D3
		const svg = select(containerEl)
			.append('svg')
			.attr('width', width)
			.attr('height', height)
			.style('width', '100%')
			.style('height', '100%');

		// Defs for glow filters
		const defs = svg.append('defs');

		const glowFilter = defs.append('filter').attr('id', 'glow');
		glowFilter.append('feGaussianBlur').attr('stdDeviation', '6').attr('result', 'blur');
		const glowMerge = glowFilter.append('feMerge');
		glowMerge.append('feMergeNode').attr('in', 'blur');
		glowMerge.append('feMergeNode').attr('in', 'SourceGraphic');

		const gapFilter = defs.append('filter').attr('id', 'glow-gap');
		gapFilter.append('feGaussianBlur').attr('stdDeviation', '3').attr('result', 'blur');
		const gapMerge = gapFilter.append('feMerge');
		gapMerge.append('feMergeNode').attr('in', 'blur');
		gapMerge.append('feMergeNode').attr('in', 'SourceGraphic');

		// Main group for zoom/pan
		const g = svg.append('g');

		// Zoom behavior
		const zoomBehavior = zoom<SVGSVGElement, unknown>()
			.scaleExtent([0.2, 4])
			.on('zoom', (event) => {
				g.attr('transform', event.transform.toString());
			});
		svg.call(zoomBehavior as any);

		// Draw edges
		const bridgeEdges = simEdges.filter((e) => e.type === 'bridge');
		const gapEdges = simEdges.filter((e) => e.type === 'gap');

		const bridgeLines = g
			.selectAll('.edge-bridge')
			.data(bridgeEdges)
			.enter()
			.append('line')
			.attr('class', 'edge-bridge')
			.attr('stroke-linecap', 'round')
			.attr('stroke', (d) => `rgba(124,111,247,${0.15 + d.strength * 0.5})`)
			.attr('stroke-width', (d) => 1 + d.strength * 3);

		const gapLines = g
			.selectAll('.edge-gap')
			.data(gapEdges)
			.enter()
			.append('line')
			.attr('class', 'edge-gap animate-pulse-slow')
			.attr('stroke', 'rgba(251,191,36,0.35)')
			.attr('stroke-width', 2)
			.attr('stroke-dasharray', '8 5')
			.attr('filter', 'url(#glow-gap)')
			.style('cursor', 'pointer')
			.on('click', (_event, d) => onGapClick(d))
			.on('mouseenter', (_event, d) => { hoveredEdge = d; })
			.on('mouseleave', () => { hoveredEdge = null; });

		// Draw nodes
		const nodeGroups = g
			.selectAll('.graph-node')
			.data(simNodes)
			.enter()
			.append('g')
			.attr('class', 'graph-node')
			.style('cursor', 'pointer')
			.on('mouseenter', (_event, d) => { hoveredNode = d; })
			.on('mouseleave', () => { hoveredNode = null; })
			.on('click', (_event, d) => onNodeClick(d));

		// Outer glow circle
		nodeGroups
			.append('circle')
			.attr('r', (d) => d.radius + 8)
			.attr('fill', 'none')
			.attr('stroke', (d) => `rgba(124,111,247,${nodeGlowOpacity(d)})`)
			.attr('stroke-width', 12)
			.attr('filter', 'url(#glow)');

		// Main circle
		nodeGroups
			.append('circle')
			.attr('class', 'node-main')
			.attr('r', (d) => d.radius)
			.attr('fill', 'rgba(18,18,26,0.92)')
			.attr('stroke', '#7c6ff7')
			.attr('stroke-width', 1.5);

		// Source count ring
		nodeGroups
			.filter((d) => d.sourceCount > 0)
			.append('circle')
			.attr('r', (d) => d.radius * 0.35)
			.attr('fill', 'none')
			.attr('stroke', 'rgba(124,111,247,0.25)')
			.attr('stroke-width', 1)
			.attr('stroke-dasharray', (d) => `${Math.min(d.sourceCount, 20)} 3`);

		// Label
		nodeGroups
			.append('text')
			.attr('y', (d) => d.radius + 18)
			.attr('text-anchor', 'middle')
			.attr('fill', '#e0e0f0')
			.attr('font-size', '11')
			.attr('font-weight', '300')
			.style('pointer-events', 'none')
			.style('user-select', 'none')
			.text((d) => truncate(d.label, 24));

		// Query count badge
		nodeGroups
			.append('text')
			.attr('text-anchor', 'middle')
			.attr('dominant-baseline', 'central')
			.attr('fill', '#9d8fff')
			.attr('font-size', (d) => (d.radius > 30 ? '14' : '11'))
			.attr('font-weight', '500')
			.text((d) => d.queryCount);

		// Drag behavior
		const dragBehavior = drag<SVGGElement, GraphNode>()
			.on('start', (event, d) => {
				if (!event.active) sim.alphaTarget(0.3).restart();
				d.fx = d.x;
				d.fy = d.y;
			})
			.on('drag', (event, d) => {
				d.fx = event.x;
				d.fy = event.y;
			})
			.on('end', (event, d) => {
				if (!event.active) sim.alphaTarget(0);
				d.fx = null;
				d.fy = null;
			});

		nodeGroups.call(dragBehavior as any);

		// Force simulation
		const sim = forceSimulation<GraphNode>(simNodes)
			.force(
				'link',
				forceLink<GraphNode, GraphEdge>(simEdges)
					.id((d) => d.id)
					.distance((d) => {
						const s = typeof d.strength === 'number' ? d.strength : 0.5;
						return 120 + 180 * (1 - s);
					})
					.strength(0.4),
			)
			.force('charge', forceManyBody().strength(-400))
			.force('x', forceX(cx).strength(0.05))
			.force('y', forceY(cy).strength(0.05))
			.force(
				'collision',
				forceCollide<GraphNode>().radius((d) => d.radius + 12),
			)
			.alphaDecay(0.02)
			.on('tick', () => {
				// Update positions directly via D3
				bridgeLines
					.attr('x1', (d) => (d.source as GraphNode).x!)
					.attr('y1', (d) => (d.source as GraphNode).y!)
					.attr('x2', (d) => (d.target as GraphNode).x!)
					.attr('y2', (d) => (d.target as GraphNode).y!);

				gapLines
					.attr('x1', (d) => (d.source as GraphNode).x!)
					.attr('y1', (d) => (d.source as GraphNode).y!)
					.attr('x2', (d) => (d.target as GraphNode).x!)
					.attr('y2', (d) => (d.target as GraphNode).y!);

				nodeGroups.attr('transform', (d) => `translate(${d.x},${d.y})`);
			});

		simulation = sim;

		// Handle resize
		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const w = entry.contentRect.width;
				const h = entry.contentRect.height;
				svg.attr('width', w).attr('height', h);
				sim.force('x', forceX(w / 2).strength(0.05));
				sim.force('y', forceY(h / 2).strength(0.05));
				sim.alpha(0.1).restart();
			}
		});
		observer.observe(containerEl);

		return () => {
			observer.disconnect();
			sim.stop();
			svg.remove();
		};
	}

	function handleMouseMove(e: MouseEvent) {
		mousePos = { x: e.clientX, y: e.clientY };
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	bind:this={containerEl}
	class="relative h-full w-full overflow-hidden rounded-xl border border-edge bg-void"
	onmousemove={handleMouseMove}
>
	<!-- SVG is created by D3 in onMount -->

	<!-- Tooltip (Svelte-managed overlay) -->
	{#if hoveredNode}
		<div
			class="pointer-events-none fixed z-50 rounded-lg border border-edge bg-deep/95
				backdrop-blur-sm px-4 py-3 text-sm shadow-xl max-w-72"
			style="left: {mousePos.x + 16}px; top: {mousePos.y - 12}px;"
		>
			<div class="font-medium text-bright mb-1">{hoveredNode.label}</div>
			<div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
				<span>{hoveredNode.queryCount} queries</span>
				<span>{hoveredNode.sourceCount} sources</span>
				{#if hoveredNode.avgSimilarity > 0}
					<span>coherence: {hoveredNode.avgSimilarity.toFixed(3)}</span>
				{/if}
			</div>
		</div>
	{:else if hoveredEdge}
		{@const s = sourceNode(hoveredEdge)}
		{@const t = targetNode(hoveredEdge)}
		<div
			class="pointer-events-none fixed z-50 rounded-lg border border-edge bg-deep/95
				backdrop-blur-sm px-4 py-3 text-sm shadow-xl max-w-72"
			style="left: {mousePos.x + 16}px; top: {mousePos.y - 12}px;"
		>
			{#if hoveredEdge.type === 'bridge'}
				<div class="text-accent mb-1">Bridge</div>
				<div class="text-xs text-muted">
					{s.label} &harr; {t.label}
				</div>
				<div class="text-xs text-muted mt-1">
					Score: {hoveredEdge.strength.toFixed(3)}
					{#if hoveredEdge.bridgeCount}
						&middot; {hoveredEdge.bridgeCount} source{hoveredEdge.bridgeCount > 1 ? 's' : ''}
					{/if}
				</div>
			{:else}
				<div class="text-gap mb-1">Gap &mdash; click to research</div>
				<div class="text-xs text-muted">
					{s.label} &harr; {t.label}
				</div>
				<div class="text-xs text-muted mt-1">
					Similarity: {hoveredEdge.topicSimilarity?.toFixed(3)}
				</div>
			{/if}
		</div>
	{/if}

	<!-- Legend -->
	<div class="absolute bottom-4 left-4 flex items-center gap-5 text-[11px] text-muted">
		<span class="flex items-center gap-1.5">
			<span class="inline-block h-2 w-5 rounded-full bg-accent/50"></span>
			Bridge
		</span>
		<span class="flex items-center gap-1.5">
			<span class="inline-block h-[2px] w-5 border-t-2 border-dashed border-gap/50"></span>
			Gap
		</span>
		<span>Scroll to zoom &middot; Drag nodes</span>
	</div>
</div>
