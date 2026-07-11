// Geometry for the hero tree scene — the demo's initial filetree laid out in
// the 1794.1×735 export frame (same coordinates as Design System/filetree-graph*).
// Imported from the claude.ai/design project's filetree-data.js verbatim; the
// scene's silhouette/camera constants in HeroTreeScene.tsx are tuned to these
// exact numbers — regenerate both together or neither.

export interface HeroNode {
  cx: number;
  cy: number;
  r: number;
  type: "root" | "folder" | "file";
  path: string;
  depth: number;
}

export interface HeroEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  ghost: boolean;
  path: string;
  depth: number;
}

export interface HeroBadge {
  cx: number;
  cy: number;
  r: number;
  kind: "pass" | "fail";
  path: string;
}

export interface HeroLabel {
  x: number;
  y: number;
  fs: number;
  cls: "folder" | "file" | "ghost";
  path: string;
  depth: number;
  text: string;
}

export const HERO_EDGES: HeroEdge[] = [
  { x1: 1066.5, y1: 94, x2: 530.3, y2: 204, ghost: false, path: "apps", depth: 1 },
  { x1: 530.3, y1: 204, x2: 455.2, y2: 314, ghost: false, path: "apps/admin", depth: 2 },
  { x1: 530.3, y1: 204, x2: 533.9, y2: 314, ghost: false, path: "apps/api", depth: 2 },
  { x1: 530.3, y1: 204, x2: 605.4, y2: 314, ghost: false, path: "apps/web", depth: 2 },
  { x1: 605.4, y1: 314, x2: 518.2, y2: 424, ghost: false, path: "apps/web/e2e", depth: 3 },
  { x1: 605.4, y1: 314, x2: 589.8, y2: 424, ghost: false, path: "apps/web/src", depth: 3 },
  { x1: 589.8, y1: 424, x2: 370.4, y2: 534, ghost: false, path: "apps/web/src/account", depth: 4 },
  { x1: 589.8, y1: 424, x2: 474.1, y2: 534, ghost: false, path: "apps/web/src/checkout", depth: 4 },
  { x1: 474.1, y1: 534, x2: 85, y2: 644, ghost: false, path: "apps/web/src/checkout/CartSummary.tsx", depth: 5 },
  { x1: 474.1, y1: 534, x2: 229.7, y2: 644, ghost: false, path: "apps/web/src/checkout/CheckoutPage.tsx", depth: 5 },
  { x1: 474.1, y1: 534, x2: 394.9, y2: 644, ghost: false, path: "apps/web/src/checkout/OrderConfirmation.tsx", depth: 5 },
  { x1: 474.1, y1: 534, x2: 556.6, y2: 644, ghost: false, path: "apps/web/src/checkout/PaymentForm.tsx", depth: 5 },
  { x1: 474.1, y1: 534, x2: 711.6, y2: 644, ghost: false, path: "apps/web/src/checkout/useCheckout.test.ts", depth: 5 },
  { x1: 474.1, y1: 534, x2: 863.1, y2: 644, ghost: false, path: "apps/web/src/checkout/useCheckout.ts", depth: 5 },
  { x1: 589.8, y1: 424, x2: 588.4, y2: 534, ghost: false, path: "apps/web/src/components", depth: 4 },
  { x1: 589.8, y1: 424, x2: 695.5, y2: 534, ghost: false, path: "apps/web/src/search", depth: 4 },
  { x1: 589.8, y1: 424, x2: 809.1, y2: 534, ghost: true, path: "apps/web/src//ghost", depth: 4 },
  { x1: 605.4, y1: 314, x2: 692.6, y2: 424, ghost: true, path: "apps/web//ghost", depth: 3 },
  { x1: 1066.5, y1: 94, x2: 937, y2: 204, ghost: false, path: "packages", depth: 1 },
  { x1: 937, y1: 204, x2: 808.7, y2: 314, ghost: false, path: "packages/config", depth: 2 },
  { x1: 937, y1: 204, x2: 894.5, y2: 314, ghost: false, path: "packages/core", depth: 2 },
  { x1: 937, y1: 204, x2: 966, y2: 314, ghost: false, path: "packages/ui", depth: 2 },
  { x1: 937, y1: 204, x2: 1065.3, y2: 314, ghost: true, path: "packages//ghost", depth: 2 },
  { x1: 1066.5, y1: 94, x2: 1399.4, y2: 204, ghost: false, path: "services", depth: 1 },
  { x1: 1399.4, y1: 204, x2: 1328.4, y2: 314, ghost: false, path: "services/search-indexer", depth: 2 },
  { x1: 1328.4, y1: 314, x2: 1278.6, y2: 424, ghost: false, path: "services/search-indexer/src", depth: 3 },
  { x1: 1278.6, y1: 424, x2: 946.8, y2: 534, ghost: false, path: "services/search-indexer/src/indexer.test.ts", depth: 4 },
  { x1: 1278.6, y1: 424, x2: 1071, y2: 534, ghost: false, path: "services/search-indexer/src/indexer.ts", depth: 4 },
  { x1: 1278.6, y1: 424, x2: 1178.2, y2: 534, ghost: false, path: "services/search-indexer/src/mapping.ts", depth: 4 },
  { x1: 1278.6, y1: 424, x2: 1278.6, y2: 534, ghost: false, path: "services/search-indexer/src/queue.ts", depth: 4 },
  { x1: 1278.6, y1: 424, x2: 1389.2, y2: 534, ghost: false, path: "services/search-indexer/src/retry.test.ts", depth: 4 },
  { x1: 1278.6, y1: 424, x2: 1499.8, y2: 534, ghost: false, path: "services/search-indexer/src/retry.ts", depth: 4 },
  { x1: 1278.6, y1: 424, x2: 1610.4, y2: 534, ghost: true, path: "services/search-indexer/src//ghost", depth: 4 },
  { x1: 1328.4, y1: 314, x2: 1378.2, y2: 424, ghost: true, path: "services/search-indexer//ghost", depth: 3 },
  { x1: 1399.4, y1: 204, x2: 1470.5, y2: 314, ghost: true, path: "services//ghost", depth: 2 },
  { x1: 1066.5, y1: 94, x2: 1495.9, y2: 204, ghost: false, path: "tools", depth: 1 },
  { x1: 1066.5, y1: 94, x2: 1602.6, y2: 204, ghost: true, path: "acme//ghost", depth: 1 },
];

export const HERO_NODES: HeroNode[] = [
  { cx: 1066.5, cy: 94, r: 8, type: "root", path: "acme", depth: 0 },
  { cx: 530.3, cy: 204, r: 6.5, type: "folder", path: "apps", depth: 1 },
  { cx: 455.2, cy: 314, r: 6.5, type: "folder", path: "apps/admin", depth: 2 },
  { cx: 533.9, cy: 314, r: 6.5, type: "folder", path: "apps/api", depth: 2 },
  { cx: 605.4, cy: 314, r: 6.5, type: "folder", path: "apps/web", depth: 2 },
  { cx: 518.2, cy: 424, r: 6.5, type: "folder", path: "apps/web/e2e", depth: 3 },
  { cx: 589.8, cy: 424, r: 6.5, type: "folder", path: "apps/web/src", depth: 3 },
  { cx: 370.4, cy: 534, r: 6.5, type: "folder", path: "apps/web/src/account", depth: 4 },
  { cx: 474.1, cy: 534, r: 6.5, type: "folder", path: "apps/web/src/checkout", depth: 4 },
  { cx: 85, cy: 644, r: 4.5, type: "file", path: "apps/web/src/checkout/CartSummary.tsx", depth: 5 },
  { cx: 229.7, cy: 644, r: 4.5, type: "file", path: "apps/web/src/checkout/CheckoutPage.tsx", depth: 5 },
  { cx: 394.9, cy: 644, r: 4.5, type: "file", path: "apps/web/src/checkout/OrderConfirmation.tsx", depth: 5 },
  { cx: 556.6, cy: 644, r: 4.5, type: "file", path: "apps/web/src/checkout/PaymentForm.tsx", depth: 5 },
  { cx: 711.6, cy: 644, r: 4.5, type: "file", path: "apps/web/src/checkout/useCheckout.test.ts", depth: 5 },
  { cx: 863.1, cy: 644, r: 4.5, type: "file", path: "apps/web/src/checkout/useCheckout.ts", depth: 5 },
  { cx: 588.4, cy: 534, r: 6.5, type: "folder", path: "apps/web/src/components", depth: 4 },
  { cx: 695.5, cy: 534, r: 6.5, type: "folder", path: "apps/web/src/search", depth: 4 },
  { cx: 937, cy: 204, r: 6.5, type: "folder", path: "packages", depth: 1 },
  { cx: 808.7, cy: 314, r: 6.5, type: "folder", path: "packages/config", depth: 2 },
  { cx: 894.5, cy: 314, r: 6.5, type: "folder", path: "packages/core", depth: 2 },
  { cx: 966, cy: 314, r: 6.5, type: "folder", path: "packages/ui", depth: 2 },
  { cx: 1399.4, cy: 204, r: 6.5, type: "folder", path: "services", depth: 1 },
  { cx: 1328.4, cy: 314, r: 6.5, type: "folder", path: "services/search-indexer", depth: 2 },
  { cx: 1278.6, cy: 424, r: 6.5, type: "folder", path: "services/search-indexer/src", depth: 3 },
  { cx: 946.8, cy: 534, r: 4.5, type: "file", path: "services/search-indexer/src/indexer.test.ts", depth: 4 },
  { cx: 1071, cy: 534, r: 4.5, type: "file", path: "services/search-indexer/src/indexer.ts", depth: 4 },
  { cx: 1178.2, cy: 534, r: 4.5, type: "file", path: "services/search-indexer/src/mapping.ts", depth: 4 },
  { cx: 1278.6, cy: 534, r: 4.5, type: "file", path: "services/search-indexer/src/queue.ts", depth: 4 },
  { cx: 1389.2, cy: 534, r: 4.5, type: "file", path: "services/search-indexer/src/retry.test.ts", depth: 4 },
  { cx: 1499.8, cy: 534, r: 4.5, type: "file", path: "services/search-indexer/src/retry.ts", depth: 4 },
  { cx: 1495.9, cy: 204, r: 6.5, type: "folder", path: "tools", depth: 1 },
];

export const HERO_BADGES: HeroBadge[] = [
  { cx: 92.5, cy: 636.5, r: 2, kind: "pass", path: "apps/web/src/checkout/CartSummary.tsx" },
  { cx: 237.2, cy: 636.5, r: 2, kind: "pass", path: "apps/web/src/checkout/CheckoutPage.tsx" },
  { cx: 402.4, cy: 636.5, r: 2, kind: "pass", path: "apps/web/src/checkout/OrderConfirmation.tsx" },
  { cx: 564.1, cy: 636.5, r: 2, kind: "pass", path: "apps/web/src/checkout/PaymentForm.tsx" },
  { cx: 870.6, cy: 636.5, r: 2, kind: "fail", path: "apps/web/src/checkout/useCheckout.ts" },
  { cx: 1078.5, cy: 526.5, r: 2, kind: "pass", path: "services/search-indexer/src/indexer.ts" },
  { cx: 1507.3, cy: 526.5, r: 2, kind: "fail", path: "services/search-indexer/src/retry.ts" },
];

export const HERO_LABELS: HeroLabel[] = [
  { x: 1080.5, y: 97.7, fs: 11.5, cls: "folder", path: "acme", depth: 0, text: "acme/" },
  { x: 542.8, y: 207.7, fs: 11.5, cls: "folder", path: "apps", depth: 1, text: "apps/" },
  { x: 467.7, y: 317.7, fs: 11.5, cls: "folder", path: "apps/admin", depth: 2, text: "admin/" },
  { x: 546.4, y: 317.7, fs: 11.5, cls: "folder", path: "apps/api", depth: 2, text: "api/" },
  { x: 617.9, y: 317.7, fs: 11.5, cls: "folder", path: "apps/web", depth: 2, text: "web/" },
  { x: 530.7, y: 427.7, fs: 11.5, cls: "folder", path: "apps/web/e2e", depth: 3, text: "e2e/" },
  { x: 602.3, y: 427.7, fs: 11.5, cls: "folder", path: "apps/web/src", depth: 3, text: "src/" },
  { x: 382.9, y: 537.7, fs: 11.5, cls: "folder", path: "apps/web/src/account", depth: 4, text: "account/" },
  { x: 486.6, y: 537.7, fs: 11.5, cls: "folder", path: "apps/web/src/checkout", depth: 4, text: "checkout/" },
  { x: 95.5, y: 647.5, fs: 11, cls: "file", path: "apps/web/src/checkout/CartSummary.tsx", depth: 5, text: "CartSummary.tsx" },
  { x: 240.2, y: 647.5, fs: 11, cls: "file", path: "apps/web/src/checkout/CheckoutPage.tsx", depth: 5, text: "CheckoutPage.tsx" },
  { x: 405.4, y: 647.5, fs: 11, cls: "file", path: "apps/web/src/checkout/OrderConfirmation.tsx", depth: 5, text: "OrderConfirmation.tsx" },
  { x: 567.1, y: 647.5, fs: 11, cls: "file", path: "apps/web/src/checkout/PaymentForm.tsx", depth: 5, text: "PaymentForm.tsx" },
  { x: 722.1, y: 647.5, fs: 11, cls: "file", path: "apps/web/src/checkout/useCheckout.test.ts", depth: 5, text: "useCheckout.test.ts" },
  { x: 873.6, y: 647.5, fs: 11, cls: "file", path: "apps/web/src/checkout/useCheckout.ts", depth: 5, text: "useCheckout.ts" },
  { x: 600.9, y: 537.7, fs: 11.5, cls: "folder", path: "apps/web/src/components", depth: 4, text: "components/" },
  { x: 708, y: 537.7, fs: 11.5, cls: "folder", path: "apps/web/src/search", depth: 4, text: "search/" },
  { x: 815.1, y: 537.5, fs: 10.5, cls: "ghost", path: "apps/web/src//ghost", depth: 4, text: "… 136 more files" },
  { x: 698.6, y: 427.5, fs: 10.5, cls: "ghost", path: "apps/web//ghost", depth: 3, text: "… 128 more files" },
  { x: 949.5, y: 207.7, fs: 11.5, cls: "folder", path: "packages", depth: 1, text: "packages/" },
  { x: 821.2, y: 317.7, fs: 11.5, cls: "folder", path: "packages/config", depth: 2, text: "config/" },
  { x: 907, y: 317.7, fs: 11.5, cls: "folder", path: "packages/core", depth: 2, text: "core/" },
  { x: 978.5, y: 317.7, fs: 11.5, cls: "folder", path: "packages/ui", depth: 2, text: "ui/" },
  { x: 1071.3, y: 317.5, fs: 10.5, cls: "ghost", path: "packages//ghost", depth: 2, text: "… 106 more files" },
  { x: 1411.9, y: 207.7, fs: 11.5, cls: "folder", path: "services", depth: 1, text: "services/" },
  { x: 1340.9, y: 317.7, fs: 11.5, cls: "folder", path: "services/search-indexer", depth: 2, text: "search-indexer/" },
  { x: 1291.1, y: 427.7, fs: 11.5, cls: "folder", path: "services/search-indexer/src", depth: 3, text: "src/" },
  { x: 957.3, y: 537.5, fs: 11, cls: "file", path: "services/search-indexer/src/indexer.test.ts", depth: 4, text: "indexer.test.ts" },
  { x: 1081.5, y: 537.5, fs: 11, cls: "file", path: "services/search-indexer/src/indexer.ts", depth: 4, text: "indexer.ts" },
  { x: 1188.7, y: 537.5, fs: 11, cls: "file", path: "services/search-indexer/src/mapping.ts", depth: 4, text: "mapping.ts" },
  { x: 1289.1, y: 537.5, fs: 11, cls: "file", path: "services/search-indexer/src/queue.ts", depth: 4, text: "queue.ts" },
  { x: 1399.7, y: 537.5, fs: 11, cls: "file", path: "services/search-indexer/src/retry.test.ts", depth: 4, text: "retry.test.ts" },
  { x: 1510.3, y: 537.5, fs: 11, cls: "file", path: "services/search-indexer/src/retry.ts", depth: 4, text: "retry.ts" },
  { x: 1616.4, y: 537.5, fs: 10.5, cls: "ghost", path: "services/search-indexer/src//ghost", depth: 4, text: "… 28 more files" },
  { x: 1384.2, y: 427.5, fs: 10.5, cls: "ghost", path: "services/search-indexer//ghost", depth: 3, text: "… 54 more files" },
  { x: 1476.5, y: 317.5, fs: 10.5, cls: "ghost", path: "services//ghost", depth: 2, text: "… 148 more files" },
  { x: 1508.4, y: 207.7, fs: 11.5, cls: "folder", path: "tools", depth: 1, text: "tools/" },
  { x: 1608.6, y: 207.5, fs: 10.5, cls: "ghost", path: "acme//ghost", depth: 1, text: "… 12 more files" },
];
