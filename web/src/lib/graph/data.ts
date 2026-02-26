import { scaleSqrt } from 'd3-scale';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { GraphNode, GraphEdge, TopicRow, BridgeRow, GapRow, DensityRow } from '$lib/types/graph';

export interface GraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

export async function loadGraphData(supabase: SupabaseClient, userId: string): Promise<GraphData> {
	const [topicsRes, bridgesRes, gapsRes, densityRes] = await Promise.all([
		supabase.rpc('get_user_topics', { p_user_id: userId }),
		supabase.rpc('semantic_bridges', { p_user_id: userId, p_min_similarity: 0.4, p_limit: 200 }),
		supabase.rpc('topic_gaps', { p_user_id: userId, p_limit: 50 }),
		supabase.rpc('knowledge_density', { p_user_id: userId }),
	]);

	const topics: TopicRow[] = topicsRes.data ?? [];
	const bridges: BridgeRow[] = bridgesRes.data ?? [];
	const gaps: GapRow[] = gapsRes.data ?? [];
	const density: DensityRow[] = densityRes.data ?? [];

	// Build density lookup
	const densityMap = new Map<string, DensityRow>();
	for (const d of density) {
		densityMap.set(d.topic_id, d);
	}

	// Compute node radius scale
	const maxQueryCount = Math.max(1, ...topics.map((t) => t.query_count));
	const radiusScale = scaleSqrt().domain([1, maxQueryCount]).range([20, 52]);

	// Build nodes
	const nodes: GraphNode[] = topics.map((t) => {
		const d = densityMap.get(t.id);
		return {
			id: t.id,
			label: t.label,
			queryCount: t.query_count,
			sourceCount: d?.source_count ?? 0,
			avgSimilarity: d?.avg_similarity ?? 0,
			radius: radiusScale(Math.max(1, t.query_count)),
		};
	});

	const nodeIds = new Set(nodes.map((n) => n.id));

	// Aggregate bridges: group by topic pair, take max bridge_score
	const bridgeMap = new Map<string, { score: number; count: number }>();
	for (const b of bridges) {
		if (!nodeIds.has(b.topic_a_id) || !nodeIds.has(b.topic_b_id)) continue;
		const key = [b.topic_a_id, b.topic_b_id].sort().join('::');
		const existing = bridgeMap.get(key);
		if (!existing || b.bridge_score > existing.score) {
			bridgeMap.set(key, {
				score: b.bridge_score,
				count: (existing?.count ?? 0) + 1,
			});
		} else {
			existing.count++;
		}
	}

	// Build bridge edges
	const edges: GraphEdge[] = [];
	const edgePairs = new Set<string>();

	for (const [key, val] of bridgeMap) {
		const [a, b] = key.split('::');
		edgePairs.add(key);
		edges.push({
			source: a,
			target: b,
			type: 'bridge',
			strength: val.score,
			bridgeCount: val.count,
		});
	}

	// Build gap edges (only if not already bridged)
	for (const g of gaps) {
		if (!nodeIds.has(g.topic_a_id) || !nodeIds.has(g.topic_b_id)) continue;
		const key = [g.topic_a_id, g.topic_b_id].sort().join('::');
		if (edgePairs.has(key)) continue;
		edges.push({
			source: g.topic_a_id,
			target: g.topic_b_id,
			type: 'gap',
			strength: g.topic_similarity,
			topicSimilarity: g.topic_similarity,
		});
	}

	return { nodes, edges };
}
