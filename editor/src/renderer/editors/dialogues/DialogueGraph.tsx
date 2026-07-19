import {
  Background,
  Controls,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type Viewport,
} from '@xyflow/react';
import type {
  DialogueBlockData,
  DialogueEdgeData,
} from '../../../shared/project-schema/authoring-dialogues';

export interface DialogueGraphProps {
  blocks: DialogueBlockData[];
  edges: DialogueEdgeData[];
  positions: Record<string, { x: number; y: number }>;
  selectedBlockId: string | null;
  onSelectBlock: (blockId: string) => void;
  onMoveBlock: (blockId: string, position: { x: number; y: number }) => void;
  onConnectBlocks: (fromBlockId: string, toBlockId: string) => void;
  viewport?: Viewport | null;
  onViewportChange?: (viewport: Viewport) => void;
}

function edgeLabel(edge: DialogueEdgeData): string {
  if (edge.kind === 'next') return 'Next';
  if (edge.label.source.kind === 'inline') return edge.label.source.text || 'Choice';
  if (edge.label.source.kind === 'localized') return edge.label.source.key;
  return 'Lua choice';
}

export function DialogueGraph({
  blocks,
  edges,
  positions,
  selectedBlockId,
  onSelectBlock,
  onMoveBlock,
  onConnectBlocks,
  viewport,
  onViewportChange,
}: DialogueGraphProps) {
  const nodes: Node[] = blocks.map((block, index) => ({
    id: block.id,
    position: positions[block.id] ?? { x: (index % 3) * 240, y: Math.floor(index / 3) * 140 },
    data: {
      label: `${block.label}${block.type === 'sequence' && block.segments.length > 0 ? ` (${block.segments.length})` : ''}`,
    },
    selected: block.id === selectedBlockId,
  }));
  const flowEdges: Edge[] = edges.map((edge) => ({
    id: edge.id,
    source: edge.fromBlockId,
    target: edge.toBlockId,
    label: edgeLabel(edge),
    animated: edge.kind === 'choice',
  }));
  for (const block of blocks) {
    if (block.type !== 'redirect') continue;
    flowEdges.push({
      id: `redirect:${block.id}`,
      source: block.id,
      target: block.targetBlockId,
      label: 'Redirect',
      animated: true,
    });
  }

  function handleConnect(connection: Connection) {
    if (!connection.source || !connection.target) return;
    onConnectBlocks(connection.source, connection.target);
  }

  return (
    <div className="h-72 min-h-0 overflow-hidden rounded border bg-muted/20" data-dialogue-graph>
      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        fitView={!viewport}
        defaultViewport={viewport ?? undefined}
        onConnect={handleConnect}
        onNodeClick={(_, node) => onSelectBlock(node.id)}
        onNodeDragStop={(_, node) => onMoveBlock(node.id, node.position)}
        onViewportChange={onViewportChange}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
