import { Background, Controls, ReactFlow, type Connection, type Edge, type Node } from '@xyflow/react';
import type { DialogueBlockData, DialogueEdgeData } from '../../../shared/project-schema/authoring-dialogues';

export interface DialogueGraphProps {
  blocks: DialogueBlockData[];
  edges: DialogueEdgeData[];
  selectedBlockId: string | null;
  onSelectBlock: (blockId: string) => void;
  onMoveBlock: (blockId: string, position: { x: number; y: number }) => void;
  onConnectBlocks: (fromBlockId: string, toBlockId: string) => void;
}

export function DialogueGraph({ blocks, edges, selectedBlockId, onSelectBlock, onMoveBlock, onConnectBlocks }: DialogueGraphProps) {
  const nodes: Node[] = blocks.map((block) => ({
    id: block.id,
    position: block.graph,
    data: {
      label: `${block.label}${block.segments.length > 1 ? ` (${block.segments.length} lines)` : ''}`,
    },
    selected: block.id === selectedBlockId,
  }));
  const flowEdges: Edge[] = edges.map((edge) => ({
    id: edge.id,
    source: edge.fromBlockId,
    target: edge.toBlockId,
    label: edge.label || edge.kind,
    animated: edge.kind === 'choice',
  }));

  function handleConnect(connection: Connection) {
    if (!connection.source || !connection.target) return;
    onConnectBlocks(connection.source, connection.target);
  }

  return (
    <div className="h-72 min-h-0 overflow-hidden rounded border bg-muted/20">
      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        fitView
        onConnect={handleConnect}
        onNodeClick={(_, node) => onSelectBlock(node.id)}
        onNodeDragStop={(_, node) => onMoveBlock(node.id, node.position)}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
