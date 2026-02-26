import type { SimulationNodeDatum, SimulationLinkDatum } from 'd3-force';

export interface GraphNode extends SimulationNodeDatum {
	id: string;
	label: string;
	queryCount: number;
	sourceCount: number;
	avgSimilarity: number;
	radius: number;
}

export interface GraphEdge extends SimulationLinkDatum<GraphNode> {
	source: string | GraphNode;
	target: string | GraphNode;
	type: 'bridge' | 'gap';
	strength: number;
	bridgeCount?: number;
	topicSimilarity?: number;
}

export interface TopicRow {
	id: string;
	label: string;
	description: string | null;
	query_count: number;
	created_at: string;
	updated_at: string;
	latest_query: string | null;
	latest_query_at: string | null;
}

export interface BridgeRow {
	source_id: string;
	source_title: string;
	source_url: string;
	query_raw_input: string;
	topic_a_id: string;
	topic_a_label: string;
	topic_b_id: string;
	topic_b_label: string;
	similarity_a: number;
	similarity_b: number;
	bridge_score: number;
}

export interface GapRow {
	topic_a_id: string;
	topic_a_label: string;
	topic_b_id: string;
	topic_b_label: string;
	topic_similarity: number;
}

export interface DensityRow {
	topic_id: string;
	topic_label: string;
	query_count: number;
	source_count: number;
	avg_similarity: number;
	stddev_similarity: number;
	min_similarity: number;
	max_similarity: number;
}
