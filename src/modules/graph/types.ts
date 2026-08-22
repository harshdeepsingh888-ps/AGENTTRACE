export type NodeId = string;

export interface GraphNode {
  id: NodeId;
}

export interface GraphEdge {
  from: NodeId;
  to: NodeId;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
