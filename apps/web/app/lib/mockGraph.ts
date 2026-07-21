import { MarkerType, Position, type Edge, type Node } from '@xyflow/react';

export interface GraphNodeData extends Record<string, unknown> {
  label: string;
  kind: 'Folder' | 'File';
  path: string;
  language?: string;
}

const folder = (id: string, label: string, path: string, x: number, y: number): Node<GraphNodeData> => ({
  id,
  position: { x, y },
  sourcePosition: Position.Right,
  targetPosition: Position.Left,
  className: 'graph-node-folder',
  data: { label, kind: 'Folder', path },
});

const file = (
  id: string,
  label: string,
  path: string,
  language: string,
  x: number,
  y: number,
): Node<GraphNodeData> => ({
  id,
  position: { x, y },
  sourcePosition: Position.Right,
  targetPosition: Position.Left,
  className: 'graph-node-file',
  data: { label, kind: 'File', path, language },
});

export const mockNodes: Node<GraphNodeData>[] = [
  folder('root', 'sayre', '', 0, 330),
  folder('apps', 'apps', 'apps', 230, 70),
  folder('packages', 'packages', 'packages', 230, 330),
  folder('services', 'services', 'services', 230, 590),
  folder('web', 'web', 'apps/web', 470, 30),
  file('layout', 'layout.tsx', 'apps/web/app/layout.tsx', 'TypeScript', 700, 0),
  file('canvas', 'GraphCanvas.tsx', 'apps/web/app/components/GraphCanvas.tsx', 'TypeScript', 700, 80),
  file('page', 'page.tsx', 'apps/web/app/page.tsx', 'TypeScript', 700, 160),
  folder('config', 'config', 'packages/config', 470, 260),
  file('config-ts', 'config.ts', 'packages/config/src/config.ts', 'TypeScript', 700, 240),
  file('secrets-ts', 'secrets.ts', 'packages/config/src/secrets.ts', 'TypeScript', 700, 320),
  folder('shared', 'shared-types', 'packages/shared-types', 470, 410),
  file('types-ts', 'index.ts', 'packages/shared-types/src/index.ts', 'TypeScript', 700, 410),
  folder('core', 'core', 'services/core', 470, 520),
  file('app-ts', 'app.ts', 'services/core/src/app.ts', 'TypeScript', 700, 500),
  file('webhook-ts', 'githubWebhookService.ts', 'services/core/src/services/githubWebhookService.ts', 'TypeScript', 700, 580),
  folder('workers', 'workers', 'services/workers', 470, 700),
  file('parser-py', 'parser.py', 'services/workers/sayre_workers/parsing/parser.py', 'Python', 700, 660),
  file('sqs-py', 'sqs_client.py', 'services/workers/messaging/sqs_client.py', 'Python', 700, 740),
  file('main-py', 'main.py', 'services/workers/app/main.py', 'Python', 700, 820),
];

const contains = (source: string, target: string): Edge => ({
  id: `contains-${source}-${target}`,
  source,
  target,
  type: 'smoothstep',
  markerEnd: { type: MarkerType.ArrowClosed, color: '#3b4653', width: 14, height: 14 },
});

export const mockEdges: Edge[] = [
  contains('root', 'apps'),
  contains('root', 'packages'),
  contains('root', 'services'),
  contains('apps', 'web'),
  contains('web', 'layout'),
  contains('web', 'canvas'),
  contains('web', 'page'),
  contains('packages', 'config'),
  contains('config', 'config-ts'),
  contains('config', 'secrets-ts'),
  contains('packages', 'shared'),
  contains('shared', 'types-ts'),
  contains('services', 'core'),
  contains('services', 'workers'),
  contains('core', 'app-ts'),
  contains('core', 'webhook-ts'),
  contains('workers', 'parser-py'),
  contains('workers', 'sqs-py'),
  contains('workers', 'main-py'),
];
