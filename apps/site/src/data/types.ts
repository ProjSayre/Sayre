export type Tab = "filetree" | "features" | "relations";
export type NodeType = "root" | "folder" | "file";

export interface RepoNode {
  id: string; // path-like, stable: "apps/web/src/checkout/PaymentForm.tsx"
  name: string; // display name; folders rendered with trailing "/"
  type: NodeType;
  parentId: string | null; // null only for root
  fileCount?: number; // folders only: TOTAL files contained (incl. unauthored)
  expandedByDefault?: boolean;
  meta: NodeMeta;
}

export interface NodeMeta {
  description?: string; // canned "AI-generated" summary, 1–2 sentences
  loc?: number; // files only
  lang?: string; // "ts" | "tsx" | "css" | ...
  owners?: string[]; // Person ids
  recentChanges?: Change[]; // newest first, max 3
  dependencies?: Dependency[];
  featureIds?: string[];
  ticketIds?: string[];
  agentMd?: string; // markdown, 4–10 lines
  tests?: { status: "pass" | "fail"; coveredBy: string[] }; // coveredBy = test file paths (COVERS edges)
}

export interface Change {
  sha: string;
  message: string;
  author: string;
  when: string;
  pr?: number;
}

export interface Dependency {
  name: string;
  kind: "tool" | "package";
  install?: string; // copyable command
}

export interface RepoEdge {
  from: string;
  to: string;
  kind: "imports" | "calls"; // files only
}

export interface Feature {
  id: string;
  name: string;
  description: string;
  team: string;
  memberIds: string[]; // FILE node ids only (dirs are implied via parents)
  workspaces: string[]; // authored display grouping, e.g. ["apps/web", "apps/api", "packages"]
  stats: { openTickets: number; mergedPrs: number; lastShip: string };
  recentEdits: Change[]; // authored, newest first, exactly 3
  ticketIds: string[];
}

export interface Ticket {
  id: string;
  source: "linear" | "jira";
  title: string;
  status: "open" | "in progress" | "done";
}

export interface Person {
  id: string;
  name: string;
  handle: string;
}

export type PersonaId = "new-hire" | "tech-lead" | "pm";

export type LayerKey =
  | "description"
  | "dependencies"
  | "recentChanges"
  | "features"
  | "tickets"
  | "agentMd"
  | "tests";

export interface Persona {
  id: PersonaId;
  label: string;
  defaultTab: Tab;
  layers: LayerKey[];
}
