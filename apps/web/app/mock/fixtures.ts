/**
 * Hand-authored fixtures for the MVP UI mock.
 *
 * A fictional monorepo (`acme/atlas`). No repository is ever cloned or parsed
 * here — this module exists so every surface, empty state, and failure state in
 * the wireframe has something concrete to render.
 */

import type {
  Feature,
  GraphEdge,
  GraphNode,
  NodeOverlay,
  ProviderSetting,
  Repository,
} from './types';

export const REPOSITORIES: Repository[] = [
  {
    id: 'repo_atlas',
    provider: 'github',
    owner: 'acme',
    name: 'atlas',
    defaultBranch: 'main',
    currentRef: 'main',
    readiness: 'graph-ready',
    fileCount: 1204,
  },
  {
    id: 'repo_ledger',
    provider: 'github',
    owner: 'acme',
    name: 'ledger-service',
    defaultBranch: 'main',
    currentRef: 'main',
    readiness: 'technical-ready',
    fileCount: 312,
  },
  {
    id: 'repo_pilot',
    provider: 'github',
    owner: 'acme',
    name: 'pilot-web',
    defaultBranch: 'develop',
    currentRef: 'develop',
    readiness: 'registered',
    fileCount: 88,
  },
  {
    id: 'repo_vault',
    provider: 'github',
    owner: 'acme',
    name: 'vault-infra',
    defaultBranch: 'main',
    currentRef: 'main',
    readiness: 'graph-ready',
    fileCount: 640,
    restricted: true,
  },
];

export const DEFAULT_REPOSITORY_ID = 'repo_atlas';

/**
 * Folder and File nodes only. Function/Class nodes exist in the graph but are
 * folded into File metadata and never rendered on canvas.
 */
export const GRAPH_NODES: GraphNode[] = [
  { id: 'n_root', kind: 'Folder', name: 'atlas/', path: 'atlas', parentId: null },

  { id: 'n_apps', kind: 'Folder', name: 'apps/', path: 'apps', parentId: 'n_root' },
  {
    id: 'n_apps_web',
    kind: 'Folder',
    name: 'web/',
    path: 'apps/web',
    parentId: 'n_apps',
  },
  {
    id: 'n_checkout',
    kind: 'Folder',
    name: 'checkout/',
    path: 'apps/web/checkout',
    parentId: 'n_apps_web',
  },
  {
    id: 'n_checkout_page',
    kind: 'File',
    name: 'CheckoutPage.tsx',
    path: 'apps/web/checkout/CheckoutPage.tsx',
    parentId: 'n_checkout',
  },
  {
    id: 'n_payment_form',
    kind: 'File',
    name: 'PaymentForm.tsx',
    path: 'apps/web/checkout/PaymentForm.tsx',
    parentId: 'n_checkout',
  },
  {
    id: 'n_use_cart',
    kind: 'File',
    name: 'useCart.ts',
    path: 'apps/web/checkout/useCart.ts',
    parentId: 'n_checkout',
  },
  {
    id: 'n_account',
    kind: 'Folder',
    name: 'account/',
    path: 'apps/web/account',
    parentId: 'n_apps_web',
  },
  {
    id: 'n_profile_page',
    kind: 'File',
    name: 'ProfilePage.tsx',
    path: 'apps/web/account/ProfilePage.tsx',
    parentId: 'n_account',
  },
  {
    id: 'n_session_banner',
    kind: 'File',
    name: 'SessionBanner.tsx',
    path: 'apps/web/account/SessionBanner.tsx',
    parentId: 'n_account',
  },

  {
    id: 'n_services',
    kind: 'Folder',
    name: 'services/',
    path: 'services',
    parentId: 'n_root',
  },
  {
    id: 'n_billing',
    kind: 'Folder',
    name: 'billing/',
    path: 'services/billing',
    parentId: 'n_services',
  },
  {
    id: 'n_invoice',
    kind: 'File',
    name: 'invoice.ts',
    path: 'services/billing/invoice.ts',
    parentId: 'n_billing',
  },
  {
    id: 'n_stripe_client',
    kind: 'File',
    name: 'stripeClient.ts',
    path: 'services/billing/stripeClient.ts',
    parentId: 'n_billing',
  },
  {
    id: 'n_refunds',
    kind: 'File',
    name: 'refunds.ts',
    path: 'services/billing/refunds.ts',
    parentId: 'n_billing',
  },
  {
    id: 'n_identity',
    kind: 'Folder',
    name: 'identity/',
    path: 'services/identity',
    parentId: 'n_services',
  },
  {
    id: 'n_session',
    kind: 'File',
    name: 'session.ts',
    path: 'services/identity/session.ts',
    parentId: 'n_identity',
  },
  {
    id: 'n_rbac',
    kind: 'File',
    name: 'rbac.ts',
    path: 'services/identity/rbac.ts',
    parentId: 'n_identity',
  },

  {
    id: 'n_packages',
    kind: 'Folder',
    name: 'packages/',
    path: 'packages',
    parentId: 'n_root',
  },
  {
    id: 'n_ui',
    kind: 'Folder',
    name: 'ui/',
    path: 'packages/ui',
    parentId: 'n_packages',
  },
  {
    id: 'n_button',
    kind: 'File',
    name: 'Button.tsx',
    path: 'packages/ui/Button.tsx',
    parentId: 'n_ui',
  },
  {
    id: 'n_modal',
    kind: 'File',
    name: 'Modal.tsx',
    path: 'packages/ui/Modal.tsx',
    parentId: 'n_ui',
  },
  {
    id: 'n_shared',
    kind: 'Folder',
    name: 'shared/',
    path: 'packages/shared',
    parentId: 'n_packages',
  },
  {
    id: 'n_money',
    kind: 'File',
    name: 'money.ts',
    path: 'packages/shared/money.ts',
    parentId: 'n_shared',
  },
  {
    id: 'n_logger',
    kind: 'File',
    name: 'logger.ts',
    path: 'packages/shared/logger.ts',
    parentId: 'n_shared',
  },
];

const containsEdges: GraphEdge[] = GRAPH_NODES.filter(
  (node) => node.parentId !== null,
).map((node) => ({
  id: `contains:${node.parentId}->${node.id}`,
  type: 'CONTAINS' as const,
  source: node.parentId as string,
  target: node.id,
}));

const importPairs: Array<[string, string]> = [
  ['n_payment_form', 'n_stripe_client'],
  ['n_payment_form', 'n_button'],
  ['n_checkout_page', 'n_payment_form'],
  ['n_use_cart', 'n_money'],
  ['n_invoice', 'n_money'],
  ['n_refunds', 'n_invoice'],
  ['n_session_banner', 'n_session'],
  ['n_profile_page', 'n_modal'],
  ['n_rbac', 'n_logger'],
];

export const GRAPH_EDGES: GraphEdge[] = [
  ...containsEdges,
  ...importPairs.map(([source, target]) => ({
    id: `imports:${source}->${target}`,
    type: 'IMPORTS' as const,
    source,
    target,
  })),
];

export const FEATURES: Feature[] = [
  {
    id: 'feat_checkout',
    name: 'Checkout & payments',
    description:
      'Cart-to-confirmation flow: card capture, payment intent creation, and the confirmation receipt.',
    team: 'Payments',
    fileIds: [
      'n_checkout_page',
      'n_payment_form',
      'n_use_cart',
      'n_stripe_client',
      'n_money',
    ],
    recentEdits: [
      {
        filePath: 'apps/web/checkout/PaymentForm.tsx',
        editorName: 'Dana Whitfield',
        editedAt: '2026-07-23T15:42:00Z',
        pullRequestTitle: 'Split card capture from payment intent creation',
        pullRequestUrl: 'https://github.com/acme/atlas/pull/2184',
      },
      {
        filePath: 'services/billing/stripeClient.ts',
        editorName: 'Marco Reyes',
        editedAt: '2026-07-21T09:05:00Z',
        pullRequestTitle: 'Retry idempotency keys on gateway timeout',
        pullRequestUrl: 'https://github.com/acme/atlas/pull/2171',
      },
    ],
  },
  {
    id: 'feat_refunds',
    name: 'Refunds & disputes',
    description:
      'Partial and full refunds, dispute intake, and the ledger entries each one writes.',
    team: 'Payments',
    fileIds: ['n_invoice', 'n_refunds'],
    recentEdits: [
      {
        filePath: 'services/billing/refunds.ts',
        editorName: 'Priya Nair',
        editedAt: '2026-07-24T11:18:00Z',
        pullRequestTitle: 'Reject refunds above the original capture amount',
        pullRequestUrl: 'https://github.com/acme/atlas/pull/2190',
      },
    ],
  },
  {
    id: 'feat_account',
    name: 'Account & session',
    description:
      'Sign-in surface, session lifetime, and the role checks that gate every authenticated screen.',
    team: 'Identity',
    fileIds: ['n_profile_page', 'n_session_banner', 'n_session', 'n_rbac'],
    recentEdits: [
      {
        filePath: 'services/identity/rbac.ts',
        editorName: 'Alex Kwon',
        editedAt: '2026-07-22T17:33:00Z',
        pullRequestTitle: 'Deny-by-default on unknown permission strings',
        pullRequestUrl: 'https://github.com/acme/atlas/pull/2179',
      },
    ],
  },
  {
    id: 'feat_design_system',
    name: 'Design system',
    description:
      'Shared primitives every product surface composes from — buttons, modals, and their tokens.',
    team: 'Platform UI',
    fileIds: ['n_button', 'n_modal'],
    recentEdits: [
      {
        filePath: 'packages/ui/Modal.tsx',
        editorName: 'Jules Fontaine',
        editedAt: '2026-07-19T08:47:00Z',
        pullRequestTitle: 'Trap focus inside modal on open',
        pullRequestUrl: 'https://github.com/acme/atlas/pull/2160',
      },
    ],
  },
];

const PAYMENT_FORM_SKILL_MD = `# PaymentForm.tsx

## Allowed Tools
- read_file, edit_file within \`apps/web/checkout/\`
- run_tests scoped to \`apps/web/checkout/__tests__\`

## Required Context
- \`services/billing/stripeClient.ts\` — payment intent contract
- \`packages/shared/money.ts\` — every amount is minor units, never floats
- ADR-114: card data never touches Atlas servers

## Guardrails
- Never log or persist raw card fields, even redacted.
- Amount formatting goes through \`money.ts\`; no inline currency math.
- Changing the submit path requires a Payments team reviewer.
`;

const SESSION_SKILL_MD = `# session.ts

## Allowed Tools
- read_file across \`services/identity/\`
- edit_file within \`services/identity/\`

## Required Context
- \`services/identity/rbac.ts\` — role resolution runs after session load
- Session lifetime is 12h; refresh is server-driven only

## Guardrails
- Never widen a session's org scope from client input.
- Token values never enter a log line.
`;

/** Overlay payloads keyed by node id. Nodes without an entry render empty states. */
export const NODE_OVERLAYS: Record<string, NodeOverlay> = {
  n_payment_form: {
    nodeId: 'n_payment_form',
    description:
      'Renders the card capture form and hands a tokenized payment method to the billing service. Owns validation and submit-state, not the payment intent lifecycle.',
    agentSkillMd: {
      version: 7,
      content: PAYMENT_FORM_SKILL_MD,
      editorLabel: 'Dana Whitfield',
      updatedAt: '2026-07-23T15:48:00Z',
    },
    agentSkillHistory: [
      {
        version: 6,
        content: PAYMENT_FORM_SKILL_MD.replace(
          '- Changing the submit path requires a Payments team reviewer.\n',
          '',
        ),
        editorLabel: 'Marco Reyes',
        updatedAt: '2026-07-11T13:02:00Z',
      },
      {
        version: 5,
        content: '# PaymentForm.tsx\n\n## Allowed Tools\n- read_file\n',
        editorLabel: 'Dana Whitfield',
        updatedAt: '2026-06-28T10:26:00Z',
      },
    ],
    recentChanges: [
      {
        sha: '9f3c2ab',
        message: 'Split card capture from payment intent creation',
        authorName: 'Dana Whitfield',
        timestamp: '2026-07-23T15:42:00Z',
        pullRequestTitle: 'Split card capture from payment intent creation',
        pullRequestUrl: 'https://github.com/acme/atlas/pull/2184',
      },
      {
        sha: '41d80e6',
        message: 'Disable submit while a prior attempt is in flight',
        authorName: 'Marco Reyes',
        timestamp: '2026-07-18T12:11:00Z',
        pullRequestTitle: 'Guard double-submit on slow networks',
        pullRequestUrl: 'https://github.com/acme/atlas/pull/2158',
      },
      {
        sha: 'c7b1904',
        message: 'Move currency formatting to shared money helper',
        authorName: 'Priya Nair',
        timestamp: '2026-07-09T16:54:00Z',
        pullRequestTitle: null,
        pullRequestUrl: null,
      },
    ],
    tickets: [
      {
        externalId: 'ATL-482',
        provider: 'jira',
        title: 'Card errors should keep the entered amount',
        status: 'In Progress',
        url: 'https://acme.atlassian.net/browse/ATL-482',
      },
      {
        externalId: 'PAY-119',
        provider: 'linear',
        title: '3DS challenge returns the user to an empty cart',
        status: 'Triage',
        url: 'https://linear.app/acme/issue/PAY-119',
      },
    ],
    standards: {
      codingStyle: 'TypeScript strict · named exports · no default exports',
      commentStyle: 'JSDoc on exported symbols only; no inline narration',
      inheritedFrom: 'apps/web',
      overridden: false,
    },
  },
  n_session: {
    nodeId: 'n_session',
    description:
      'Loads and validates the caller session, then stamps org scope on the request context for every downstream check.',
    agentSkillMd: {
      version: 3,
      content: SESSION_SKILL_MD,
      editorLabel: 'Alex Kwon',
      updatedAt: '2026-07-22T17:40:00Z',
    },
    agentSkillHistory: [
      {
        version: 2,
        content: '# session.ts\n\n## Allowed Tools\n- read_file\n\n## Required Context\n- rbac.ts\n',
        editorLabel: 'Alex Kwon',
        updatedAt: '2026-06-30T09:12:00Z',
      },
    ],
    recentChanges: [
      {
        sha: 'b20fe51',
        message: 'Deny-by-default on unknown permission strings',
        authorName: 'Alex Kwon',
        timestamp: '2026-07-22T17:33:00Z',
        pullRequestTitle: 'Deny-by-default on unknown permission strings',
        pullRequestUrl: 'https://github.com/acme/atlas/pull/2179',
      },
    ],
    tickets: [
      {
        externalId: 'ATL-455',
        provider: 'jira',
        title: 'Session expiry banner shows the wrong remaining time',
        status: 'Done',
        url: 'https://acme.atlassian.net/browse/ATL-455',
      },
    ],
    standards: {
      codingStyle: 'TypeScript strict · service layer owns all data access',
      commentStyle: 'Explain why, not what; security invariants always commented',
      inheritedFrom: 'services',
      overridden: true,
    },
  },
  n_checkout: {
    nodeId: 'n_checkout',
    description:
      'Everything the buyer touches between cart review and the confirmation screen.',
    agentSkillMd: null,
    agentSkillHistory: [],
    recentChanges: [
      {
        sha: '9f3c2ab',
        message: 'Split card capture from payment intent creation',
        authorName: 'Dana Whitfield',
        timestamp: '2026-07-23T15:42:00Z',
        pullRequestTitle: 'Split card capture from payment intent creation',
        pullRequestUrl: 'https://github.com/acme/atlas/pull/2184',
      },
    ],
    tickets: [],
    standards: null,
  },
};

export const PROVIDER_SETTINGS: ProviderSetting[] = [
  {
    purpose: 'generation',
    provider: 'Anthropic',
    model: 'claude-sonnet-4-5',
    credentialReference: 'sayre/generation/anthropic#v3',
    endpoint: 'https://api.anthropic.com',
    hosting: 'hosted',
    status: 'configured',
  },
  {
    purpose: 'embedding',
    provider: 'Self-hosted (OpenAI-compatible)',
    model: 'bge-large-en-v1.5',
    credentialReference: 'sayre/embedding/internal#v1',
    endpoint: 'https://embeddings.internal.acme.dev/v1',
    hosting: 'self-hosted',
    status: 'configured',
  },
];

export const GITHUB_INSTALLATION = {
  accountName: 'acme',
  repositoriesSynced: 3,
  repositoriesTotal: 4,
};

export const CURRENT_USER = {
  name: 'Alex Kwon',
  initials: 'AK',
  email: 'alex.kwon@acme.dev',
  org: 'Acme Engineering',
};
