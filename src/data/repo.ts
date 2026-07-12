import type { NodeMeta, RepoNode } from "./types";

// ---------------------------------------------------------------------------
// acme/monorepo — the hand-authored fictional dataset (spec §5 + appendix A).
// fileCounts are authored per-folder; ghost remainders are derived in index.ts
// and must satisfy: fileCount >= sum(child folder fileCounts) + direct files.
// ---------------------------------------------------------------------------

const nodes: RepoNode[] = [];

function parentOf(id: string): string | null {
  if (id === "acme") return null;
  const i = id.lastIndexOf("/");
  return i === -1 ? "acme" : id.slice(0, i);
}

function nameOf(id: string): string {
  const i = id.lastIndexOf("/");
  return i === -1 ? id : id.slice(i + 1);
}

function dir(id: string, fileCount: number, meta: NodeMeta = {}, expandedByDefault = false): void {
  nodes.push({
    id,
    name: nameOf(id),
    type: id === "acme" ? "root" : "folder",
    parentId: parentOf(id),
    fileCount,
    expandedByDefault,
    meta,
  });
}

function langOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1);
}

/** hero / rich file — full meta object */
function file(id: string, meta: NodeMeta): void {
  nodes.push({
    id,
    name: nameOf(id),
    type: "file",
    parentId: parentOf(id),
    meta: { lang: langOf(id), ...meta },
  });
}

/** standard file — description + owners + loc (spec §5.2 minimum tier) */
function f(id: string, description: string, owners: string[], loc: number): void {
  file(id, { description, owners, loc });
}

// ---------------------------------------------------------------------------
// root
// ---------------------------------------------------------------------------

dir(
  "acme",
  1204,
  {
    description:
      "storefront, api, admin tool, and shared packages for acme's e-commerce stack. a checkout revamp is mid-flight; the search indexer is on a flaky streak.",
    recentChanges: [
      { sha: "a1b2c3f", message: "migrate PaymentForm to payment intents", author: "dana park", when: "2d ago", pr: 482 },
      { sha: "77e0c1d", message: "debounce refine requests to kill result flicker", author: "aisha khan", when: "3d ago", pr: 480 },
      { sha: "20af5b9", message: "bump shared tsconfig to strict everywhere", author: "miguel reyes", when: "4d ago", pr: 477 },
    ],
    agentMd: [
      "#### monorepo ground rules",
      "- pnpm workspaces; never `npm install` inside a package.",
      "- shared logic lives in `packages/` — apps import it, never each other.",
      "- money is integer minor units everywhere (see `packages/core/src/currency.ts`).",
      "- ci runs `turbo run test` on changed workspaces only.",
    ].join("\n"),
  },
  true,
);

// ---------------------------------------------------------------------------
// apps/
// ---------------------------------------------------------------------------

dir(
  "apps",
  640,
  {
    description: "product surfaces: the storefront, the public api, and the internal admin tool.",
    agentMd: [
      "#### apps/",
      "- each app deploys independently; shared code goes through `packages/`.",
      "- apps never import from each other — runtime calls only, via the api.",
    ].join("\n"),
  },
  true,
);

// ---- apps/web -------------------------------------------------------------

dir(
  "apps/web",
  340,
  {
    description: "the customer storefront: react + typescript, vite build, one route tree.",
    owners: ["dpark", "mreyes"],
    agentMd: [
      "#### apps/web",
      "- routes live in `src/router.tsx`; pages own data fetching, components stay pure.",
      "- price display goes through `PriceTag` — never format money inline.",
      "- e2e specs in `e2e/` run against the preview build in ci.",
    ].join("\n"),
  },
  true,
);

dir("apps/web/src", 200, { description: "storefront source: routes, feature folders, shared components and hooks." }, true);

// checkout/ — the hero subtree, fully authored
dir(
  "apps/web/src/checkout",
  6,
  {
    description: "the checkout flow: cart state, payment form, confirmation. mid-migration to stripe payment intents.",
    owners: ["dpark"],
    featureIds: ["checkout"],
    ticketIds: ["LIN-482", "LIN-490"],
    recentChanges: [
      { sha: "a1b2c3f", message: "migrate PaymentForm to payment intents", author: "dana park", when: "2d ago", pr: 482 },
      { sha: "8d91e4a", message: "gate new payment flow behind checkout-v2 flag", author: "miguel reyes", when: "3d ago", pr: 479 },
    ],
    agentMd: [
      "#### checkout/",
      "- all cart state flows through `useCheckout` — components never hold their own.",
      "- amounts are integer minor units until the last render step.",
      "- the payment-intent migration (`LIN-482`) is behind the `checkout-v2` flag.",
    ].join("\n"),
  },
  true,
);

file("apps/web/src/checkout/PaymentForm.tsx", {
  description:
    "Renders the card entry form and owns Stripe tokenization. Talks to useCheckout for cart state; never touches price math directly — that lives in currency.ts.",
  loc: 214,
  owners: ["dpark"],
  featureIds: ["checkout"],
  ticketIds: ["LIN-482"],
  recentChanges: [
    { sha: "a1b2c3f", message: "migrate PaymentForm to payment intents", author: "dana park", when: "2d ago", pr: 482 },
    { sha: "8d91e4a", message: "gate new payment flow behind checkout-v2 flag", author: "miguel reyes", when: "3d ago", pr: 479 },
    { sha: "c3d00e7", message: "surface card errors inline instead of toast", author: "dana park", when: "8d ago", pr: 468 },
  ],
  dependencies: [
    { name: "@stripe/stripe-js", kind: "package" },
    { name: "stripe cli", kind: "tool", install: "stripe listen --forward-to localhost:3000/api/webhooks" },
  ],
  agentMd: [
    "#### PaymentForm.tsx",
    "- tokenization only — order creation belongs to `useCheckout`.",
    "- never log card fields; test cards live in the stripe cli fixtures.",
    "- both payment flows ship until `checkout-v2` is at 100%.",
  ].join("\n"),
  tests: { status: "pass", coveredBy: ["apps/web/e2e/checkout.e2e.ts"] },
});

file("apps/web/src/checkout/CheckoutPage.tsx", {
  description:
    "Top-level checkout route. Composes PaymentForm, CartSummary, and the confirmation step; owns nothing but layout and step state.",
  loc: 168,
  owners: ["dpark"],
  featureIds: ["checkout"],
  recentChanges: [
    { sha: "5f8aa21", message: "collapse step header on mobile", author: "dana park", when: "5d ago", pr: 474 },
    { sha: "f402bb1", message: "extract CartSummary line-item math into currency.ts", author: "sam okafor", when: "6d ago", pr: 471 },
  ],
  agentMd: [
    "#### CheckoutPage.tsx",
    "- step order is data, not jsx — edit `STEPS`, not the render.",
    "- keep this file dumb; logic belongs in `useCheckout`.",
  ].join("\n"),
  tests: { status: "pass", coveredBy: ["apps/web/e2e/checkout.e2e.ts"] },
});

file("apps/web/src/checkout/useCheckout.ts", {
  description:
    "Cart state machine for the whole checkout flow — line items, promo codes, totals. Every checkout component reads from this hook.",
  loc: 342,
  owners: ["dpark", "mreyes"],
  featureIds: ["checkout"],
  ticketIds: ["LIN-490"],
  recentChanges: [
    { sha: "9b7d3c2", message: "merge guest cart into account cart on sign-in", author: "miguel reyes", when: "4d ago", pr: 476 },
    { sha: "f402bb1", message: "extract CartSummary line-item math into currency.ts", author: "sam okafor", when: "6d ago", pr: 471 },
    { sha: "1e6f9d0", message: "quarantine flaky promo-merge timeout in tests", author: "dana park", when: "7d ago", pr: 470 },
  ],
  agentMd: [
    "#### useCheckout.ts",
    "- the reducer is the source of truth; no derived cart state in components.",
    "- promo application must stay idempotent — see `LIN-490` before touching merge.",
    "- totals come from `currency.allocate`; never sum floats.",
  ].join("\n"),
  tests: { status: "fail", coveredBy: ["apps/web/src/checkout/useCheckout.test.ts"] },
});

f(
  "apps/web/src/checkout/useCheckout.test.ts",
  "Unit tests for the cart machine. The promo-merge case times out intermittently since the guest-cart merge landed — currently red.",
  ["dpark"],
  190,
);

file("apps/web/src/checkout/CartSummary.tsx", {
  description:
    "Line-item list and totals sidebar. Formats every amount through currency.ts and renders PriceTag for unit prices.",
  loc: 121,
  owners: ["dpark"],
  featureIds: ["checkout"],
  recentChanges: [
    { sha: "f402bb1", message: "extract CartSummary line-item math into currency.ts", author: "sam okafor", when: "6d ago", pr: 471 },
    { sha: "b8812f4", message: "show per-line promo discounts", author: "dana park", when: "9d ago", pr: 465 },
  ],
  agentMd: ["#### CartSummary.tsx", "- display only: totals are handed in settled, never recomputed here."].join("\n"),
  tests: { status: "pass", coveredBy: ["apps/web/e2e/checkout.e2e.ts"] },
});

file("apps/web/src/checkout/OrderConfirmation.tsx", {
  description: "Post-payment confirmation screen; reads the settled order from useCheckout and clears cart state on unmount.",
  loc: 88,
  owners: ["mreyes"],
  featureIds: ["checkout"],
  recentChanges: [{ sha: "d4c1a08", message: "add order number copy affordance", author: "miguel reyes", when: "11d ago", pr: 462 }],
  agentMd: ["#### OrderConfirmation.tsx", "- cart teardown happens here and only here; don't clear inside PaymentForm."].join("\n"),
  tests: { status: "pass", coveredBy: ["apps/web/e2e/checkout.e2e.ts"] },
});

// search/
dir("apps/web/src/search", 9, {
  description: "storefront search: the box in the header, the results route, and the fetch hook between them.",
  owners: ["akhan"],
  featureIds: ["search"],
});

file("apps/web/src/search/SearchPage.tsx", {
  description:
    "Results route: query state in the url, results from useSearchResults, product cards in a responsive grid. Calls the search api on refine.",
  loc: 176,
  owners: ["akhan"],
  featureIds: ["search"],
  ticketIds: ["ACME-2201"],
  recentChanges: [
    { sha: "77e0c1d", message: "debounce refine requests to kill result flicker", author: "aisha khan", when: "3d ago", pr: 480 },
    { sha: "3a9be55", message: "keep scroll position across refines", author: "aisha khan", when: "10d ago", pr: 463 },
  ],
  agentMd: [
    "#### SearchPage.tsx",
    "- query params are the source of truth; state mirrors the url, not the reverse.",
    "- refines must stay under one request in flight — `ACME-2201` is the history here.",
  ].join("\n"),
  tests: { status: "pass", coveredBy: ["apps/web/e2e/search.e2e.ts"] },
});

file("apps/web/src/search/SearchBox.tsx", {
  description: "Typeahead input in the header. Debounced suggest calls against the search route; keyboard-first.",
  loc: 98,
  owners: ["akhan"],
  featureIds: ["search"],
  recentChanges: [{ sha: "6c2df19", message: "arrow-key selection for suggestions", author: "aisha khan", when: "13d ago", pr: 458 }],
  agentMd: ["#### SearchBox.tsx", "- suggest traffic is debounced 150ms; don't lower it without checking indexer load."].join("\n"),
  tests: { status: "pass", coveredBy: ["apps/web/e2e/search.e2e.ts"] },
});

file("apps/web/src/search/useSearchResults.ts", {
  description: "Fetch-and-cache hook for search results; dedupes in-flight refines and reports result timing to analytics.",
  loc: 132,
  owners: ["akhan"],
  featureIds: ["search"],
  recentChanges: [{ sha: "77e0c1d", message: "debounce refine requests to kill result flicker", author: "aisha khan", when: "3d ago", pr: 480 }],
  agentMd: ["#### useSearchResults.ts", "- cache key is the normalized query string; keep normalization in one place."].join("\n"),
});

// account/
dir("apps/web/src/account", 8, {
  description: "sign-in, session handling, and the account settings surface.",
  owners: ["mreyes"],
  featureIds: ["auth"],
});

file("apps/web/src/account/SettingsPage.tsx", {
  description: "Account settings: profile, email, active sessions. Reads the shared session model; writes go through the auth route.",
  loc: 204,
  owners: ["mreyes"],
  featureIds: ["auth"],
  recentChanges: [
    { sha: "e9a04d6", message: "list active sessions with revoke", author: "miguel reyes", when: "12d ago", pr: 460 },
    { sha: "2b5cc90", message: "stop refresh loop on safari (double-mount)", author: "miguel reyes", when: "14d ago", pr: 455 },
  ],
  agentMd: ["#### SettingsPage.tsx", "- session mutations go through the auth route; never touch tokens directly."].join("\n"),
  tests: { status: "pass", coveredBy: ["apps/web/e2e/account.e2e.ts"] },
});

file("apps/web/src/account/SignInPage.tsx", {
  description: "Email + oauth sign-in. Thin form over the auth route; session persistence lives in useSession.",
  loc: 142,
  owners: ["mreyes"],
  featureIds: ["auth"],
  ticketIds: ["LIN-467"],
  recentChanges: [{ sha: "48d17ae", message: "carry oauth state through redirect", author: "miguel reyes", when: "6d ago", pr: 472 }],
  agentMd: ["#### SignInPage.tsx", "- oauth state param must round-trip untouched — `LIN-467` tracks the mobile safari drop."].join("\n"),
  tests: { status: "pass", coveredBy: ["apps/web/e2e/account.e2e.ts"] },
});

file("apps/web/src/account/useSession.ts", {
  description: "Client session hook — wraps the shared session tokens from packages/core with refresh-on-focus.",
  loc: 87,
  owners: ["mreyes"],
  featureIds: ["auth"],
  ticketIds: ["LIN-455"],
  recentChanges: [{ sha: "2b5cc90", message: "stop refresh loop on safari (double-mount)", author: "miguel reyes", when: "14d ago", pr: 455 }],
  agentMd: ["#### useSession.ts", "- refresh-on-focus is throttled to one call per 30s; safari fires focus twice."].join("\n"),
});

// components/
dir("apps/web/src/components", 41, {
  description: "storefront-only building blocks; anything two apps need graduates to packages/ui.",
  owners: ["mreyes", "jlaurent"],
});

f("apps/web/src/components/Header.tsx", "Site header: nav, search box slot, cart count.", ["mreyes"], 96);
f("apps/web/src/components/Footer.tsx", "Site footer with link columns and locale picker.", ["mreyes"], 54);
f("apps/web/src/components/Layout.tsx", "Page frame: header, footer, main landmark, skip link.", ["mreyes"], 48);
f("apps/web/src/components/ProductCard.tsx", "Grid card for a product: image, title, price tag, rating.", ["akhan"], 84);
f("apps/web/src/components/Badge.tsx", "Small status badge used on cards and order rows.", ["jlaurent"], 22);
f("apps/web/src/components/Breadcrumbs.tsx", "Category breadcrumb trail with structured data.", ["mreyes"], 41);
f("apps/web/src/components/Pagination.tsx", "Numbered pagination with prev/next; url-driven.", ["akhan"], 57);
f("apps/web/src/components/Rating.tsx", "Star rating display, read-only.", ["akhan"], 30);
f("apps/web/src/components/ImageGallery.tsx", "Product image gallery with thumbnails and zoom.", ["akhan"], 132);
f("apps/web/src/components/Skeleton.tsx", "Loading placeholders sized to their content slots.", ["jlaurent"], 26);
f("apps/web/src/components/Toast.tsx", "Transient notifications; single queue, bottom-left.", ["mreyes"], 68);
f("apps/web/src/components/EmptyState.tsx", "Empty results / empty cart illustrations and copy.", ["mreyes"], 34);
f("apps/web/src/components/Tabs.tsx", "Url-synced tab strip for product detail sections.", ["mreyes"], 51);
f("apps/web/src/components/Avatar.tsx", "User initials avatar with deterministic tint.", ["jlaurent"], 24);
f("apps/web/src/components/Spinner.tsx", "Inline loading spinner; respects reduced motion.", ["jlaurent"], 18);
f("apps/web/src/components/ErrorBoundary.tsx", "Route-level error boundary with retry.", ["mreyes"], 44);
f("apps/web/src/components/Drawer.tsx", "Slide-in panel for the mobile cart.", ["mreyes"], 72);
f("apps/web/src/components/Accordion.tsx", "Disclosure list for faq and shipping details.", ["akhan"], 46);
f("apps/web/src/components/Tag.tsx", "Filter tag with remove affordance.", ["akhan"], 20);
f("apps/web/src/components/QuantityStepper.tsx", "Cart quantity stepper with min/max clamps.", ["dpark"], 38);
f("apps/web/src/components/StickyBar.tsx", "Sticky add-to-cart bar on product pages.", ["akhan"], 42);
f("apps/web/src/components/FormField.tsx", "Label + control + error wiring for storefront forms.", ["mreyes"], 36);

// e2e/
dir("apps/web/e2e", 12, { description: "playwright specs that run against the preview build.", owners: ["dpark"] });
f("apps/web/e2e/checkout.e2e.ts", "End-to-end: cart to settled payment with test cards.", ["dpark"], 148);
f("apps/web/e2e/search.e2e.ts", "End-to-end: query, refine, paginate, open a result.", ["akhan"], 96);
f("apps/web/e2e/account.e2e.ts", "End-to-end: sign in, edit profile, revoke a session.", ["mreyes"], 88);

// ---- apps/api -------------------------------------------------------------

dir(
  "apps/api",
  180,
  {
    description: "the public node api: rest routes over postgres, one service, deployed on every merge.",
    owners: ["tberg"],
    dependencies: [{ name: "docker compose", kind: "tool", install: "docker compose up -d postgres" }],
    agentMd: [
      "#### apps/api",
      "- routes stay thin; anything reused belongs in `src/lib` or `packages/core`.",
      "- every route imports `middleware.ts` first — order matters.",
      "- migrations run on deploy; never edit an applied migration.",
    ].join("\n"),
  },
  false,
);

dir("apps/api/src", 140, { description: "api source: routes, models, jobs, shared lib." });

dir("apps/api/src/routes", 16, {
  description: "http surface of the api. one file per resource; middleware.ts is the shared chain.",
  owners: ["tberg"],
  recentChanges: [
    { sha: "b61f7aa", message: "rate-limit suggest endpoint per session", author: "tomas berg", when: "4d ago", pr: 478 },
    { sha: "0d3e9c4", message: "add idempotency keys to payment create", author: "tomas berg", when: "5d ago", pr: 475 },
  ],
  agentMd: [
    "#### routes/",
    "- import `middleware.ts` first in every route file; the chain order is load-bearing.",
    "- responses are snake_case json; money fields are integer minor units.",
  ].join("\n"),
});

file("apps/api/src/routes/payments.ts", {
  description:
    "Payment-intent create/confirm endpoints. Validates amounts through currency.ts and forwards to Stripe; webhooks land in webhooks.ts.",
  loc: 187,
  owners: ["tberg"],
  featureIds: ["checkout"],
  ticketIds: ["LIN-482"],
  dependencies: [{ name: "stripe", kind: "package" }],
  recentChanges: [
    { sha: "0d3e9c4", message: "add idempotency keys to payment create", author: "tomas berg", when: "5d ago", pr: 475 },
    { sha: "8d91e4a", message: "gate new payment flow behind checkout-v2 flag", author: "miguel reyes", when: "3d ago", pr: 479 },
  ],
  agentMd: [
    "#### payments.ts",
    "- every create call carries an idempotency key; retries must be safe.",
    "- amounts are validated with `currency.assertMinorUnits` before stripe sees them.",
  ].join("\n"),
  tests: { status: "pass", coveredBy: ["apps/api/src/routes/payments.test.ts"] },
});

file("apps/api/src/routes/orders.ts", {
  description: "Order crud plus the csv export the admin tool uses. Money fields come back in integer minor units.",
  loc: 156,
  owners: ["tberg"],
  ticketIds: ["ACME-2216"],
  recentChanges: [
    { sha: "4f7c2d1", message: "stream csv export instead of buffering", author: "tomas berg", when: "7d ago", pr: 469 },
    { sha: "aa10f83", message: "filter orders by status and date range", author: "leo tanaka", when: "15d ago", pr: 452 },
  ],
  agentMd: ["#### orders.ts", "- export streams; loading 10k+ rows into memory is how `ACME-2216` happened."].join("\n"),
  tests: { status: "pass", coveredBy: ["apps/api/src/routes/orders.test.ts"] },
});

file("apps/api/src/routes/search.ts", {
  description: "Search endpoint: fans a query out to the index and shapes results for the storefront grid.",
  loc: 112,
  owners: ["tberg"],
  featureIds: ["search"],
  recentChanges: [{ sha: "b61f7aa", message: "rate-limit suggest endpoint per session", author: "tomas berg", when: "4d ago", pr: 478 }],
  agentMd: ["#### search.ts", "- query shaping stays here; index mappings belong to the indexer service."].join("\n"),
});

file("apps/api/src/routes/auth.ts", {
  description: "Sign-in, refresh, and sign-out endpoints over the shared session model.",
  loc: 134,
  owners: ["tberg"],
  featureIds: ["auth"],
  ticketIds: ["LIN-455"],
  recentChanges: [{ sha: "2b5cc90", message: "stop refresh loop on safari (double-mount)", author: "miguel reyes", when: "14d ago", pr: 455 }],
  agentMd: ["#### auth.ts", "- token issue/refresh delegates to `packages/core/src/session.ts`; no local token logic."].join("\n"),
  tests: { status: "pass", coveredBy: ["apps/api/src/routes/auth.test.ts"] },
});

file("apps/api/src/routes/middleware.ts", {
  description: "Route middleware chain: request ids, rate limits, session validation. Every route file imports this first.",
  loc: 98,
  owners: ["tberg"],
  recentChanges: [
    { sha: "b61f7aa", message: "rate-limit suggest endpoint per session", author: "tomas berg", when: "4d ago", pr: 478 },
    { sha: "91c44e0", message: "attach request id before auth so failures correlate", author: "tomas berg", when: "9d ago", pr: 464 },
  ],
  agentMd: [
    "#### middleware.ts",
    "- chain order: request id → rate limit → session. changing it breaks log correlation.",
    "- session validation reads `packages/core/src/session.ts`; keep it the only entry point.",
  ].join("\n"),
  tests: { status: "pass", coveredBy: ["apps/api/src/routes/middleware.test.ts"] },
});

f("apps/api/src/routes/webhooks.ts", "Stripe webhook receiver; verifies signatures and settles orders.", ["tberg"], 84);
f("apps/api/src/routes/health.ts", "Liveness and readiness probes.", ["tberg"], 18);
f("apps/api/src/routes/payments.test.ts", "Route tests for payment create/confirm, including idempotent retries.", ["tberg"], 122);
f("apps/api/src/routes/orders.test.ts", "Route tests for order crud and the streaming export.", ["tberg"], 94);
f("apps/api/src/routes/auth.test.ts", "Route tests for sign-in, refresh, and revoke.", ["tberg"], 87);
f("apps/api/src/routes/middleware.test.ts", "Chain-order and rate-limit tests for the shared middleware.", ["tberg"], 61);

dir("apps/api/src/models", 12, { description: "typed table access; one file per aggregate.", owners: ["tberg"] });
f("apps/api/src/models/order.ts", "Order aggregate: rows, lines, status transitions.", ["tberg"], 118);
f("apps/api/src/models/user.ts", "User rows and credential lookups.", ["tberg"], 76);
f("apps/api/src/models/product.ts", "Product catalog reads with variant expansion.", ["tberg"], 92);
f("apps/api/src/models/cart.ts", "Server-side cart persistence for signed-in users.", ["tberg"], 64);
f("apps/api/src/models/refund.ts", "Refund records tied to payment intents.", ["tberg"], 48);
f("apps/api/src/models/inventory.ts", "Stock levels with reservation windows.", ["tberg"], 71);

dir("apps/api/src/lib", 7, { description: "api-internal plumbing: db pool, logging, config.", owners: ["tberg"] });
f("apps/api/src/lib/db.ts", "Postgres pool and query helper with tracing.", ["tberg"], 66);
f("apps/api/src/lib/logger.ts", "Structured logger; request id aware.", ["tberg"], 42);
f("apps/api/src/lib/config.ts", "Typed env config, fail-fast on boot.", ["tberg"], 38);

dir("apps/api/src/jobs", 9, { description: "scheduled work: receipts, cleanup, inventory sync.", owners: ["tberg"] });
f("apps/api/src/jobs/emailReceipts.ts", "Send receipt emails for settled orders.", ["tberg"], 57);
f("apps/api/src/jobs/cleanupSessions.ts", "Expire stale sessions nightly.", ["tberg"], 33);
f("apps/api/src/jobs/syncInventory.ts", "Pull stock levels from the warehouse feed.", ["tberg"], 78);

f("apps/api/src/server.ts", "Boot: config, db, routes, listen.", ["tberg"], 41);
f("apps/api/src/app.ts", "Express app assembly and error handler.", ["tberg"], 55);

// ---- apps/admin -----------------------------------------------------------

dir("apps/admin", 120, {
  description: "small internal tool for support: order lookup, exports, refunds.",
  owners: ["ltanaka"],
});

dir("apps/admin/src", 104, { description: "admin tool source; a shell and a handful of grids." });

file("apps/admin/src/AdminApp.tsx", {
  description: "Shell for the internal admin tool: auth gate, nav, and route table. Small on purpose.",
  loc: 92,
  owners: ["ltanaka"],
  recentChanges: [{ sha: "e2f60b3", message: "require re-auth for refund actions", author: "leo tanaka", when: "8d ago", pr: 466 }],
  agentMd: ["#### AdminApp.tsx", "- admin auth piggybacks on the api's session model; no separate accounts."].join("\n"),
});

file("apps/admin/src/OrdersTable.tsx", {
  description: "Order search + export grid for support. Reads the orders route directly; refunds post to payments.",
  loc: 164,
  owners: ["ltanaka"],
  ticketIds: ["ACME-2216"],
  recentChanges: [
    { sha: "4f7c2d1", message: "stream csv export instead of buffering", author: "tomas berg", when: "7d ago", pr: 469 },
    { sha: "aa10f83", message: "filter orders by status and date range", author: "leo tanaka", when: "15d ago", pr: 452 },
  ],
  agentMd: ["#### OrdersTable.tsx", "- exports hit the streaming endpoint; keep page size at 500 until `ACME-2216` closes."].join("\n"),
});

// ---------------------------------------------------------------------------
// packages/
// ---------------------------------------------------------------------------

dir(
  "packages",
  264,
  {
    description: "shared code: the design system, core domain logic, and tool configs.",
  },
  true,
);

dir("packages/ui", 96, {
  description: "the design system every acme surface builds from.",
  owners: ["jlaurent"],
  featureIds: ["design-system"],
  agentMd: [
    "#### packages/ui",
    "- primitives only — no product logic, no data fetching.",
    "- every component ships with keyboard and reduced-motion behavior.",
  ].join("\n"),
});

dir("packages/ui/src", 64, { description: "primitive components, one per file." });

file("packages/ui/src/Button.tsx", {
  description: "The primitive every surface leans on: variants, sizes, loading state. Fires a click event into analytics.",
  loc: 84,
  owners: ["jlaurent"],
  featureIds: ["design-system"],
  recentChanges: [
    { sha: "1d9ef07", message: "loading state keeps width to stop layout shift", author: "jules laurent", when: "1d ago", pr: 483 },
    { sha: "73b2a4c", message: "emit analytics click event with variant", author: "jules laurent", when: "6d ago", pr: 473 },
  ],
  agentMd: ["#### Button.tsx", "- variants are closed; new ones need a design-system review, not a prop."].join("\n"),
  tests: { status: "pass", coveredBy: ["packages/ui/src/Button.test.tsx"] },
});

file("packages/ui/src/Input.tsx", {
  description: "Text input with label, error, and mask support — card-field masks are mid-flight.",
  loc: 96,
  owners: ["jlaurent"],
  featureIds: ["design-system"],
  ticketIds: ["LIN-458"],
  recentChanges: [{ sha: "5a30c88", message: "first pass at input masking api", author: "jules laurent", when: "2d ago", pr: 481 }],
  agentMd: ["#### Input.tsx", "- masks are display-only; raw values reach the form untouched."].join("\n"),
});

file("packages/ui/src/Modal.tsx", {
  description: "Focus-trapped dialog primitive. Portal + scroll lock; the ios focus-trap escape was closed out last sprint.",
  loc: 112,
  owners: ["jlaurent"],
  featureIds: ["design-system"],
  ticketIds: ["LIN-440"],
  recentChanges: [{ sha: "90cd41b", message: "contain focus on ios voiceover", author: "jules laurent", when: "16d ago", pr: 450 }],
  agentMd: ["#### Modal.tsx", "- focus restore on close is part of the contract; test it when touching mount order."].join("\n"),
});

file("packages/ui/src/PriceTag.tsx", {
  description:
    "Formats and renders a money amount with currency symbol and sale treatment. Expects integer minor units — pair it with currency.ts.",
  loc: 58,
  owners: ["jlaurent", "dpark"],
  featureIds: ["checkout", "design-system"],
  recentChanges: [
    { sha: "c07d92e", message: "sale strikethrough respects locale digits", author: "jules laurent", when: "4d ago", pr: 477 },
    { sha: "f402bb1", message: "extract CartSummary line-item math into currency.ts", author: "sam okafor", when: "6d ago", pr: 471 },
  ],
  agentMd: [
    "#### PriceTag.tsx",
    "- takes minor units + currency code; formatting only, no math.",
    "- shared by checkout and the design system — changes need both owners.",
  ].join("\n"),
  tests: { status: "pass", coveredBy: ["packages/ui/src/PriceTag.test.tsx"] },
});

f("packages/ui/src/Select.tsx", "Listbox-pattern select with typeahead.", ["jlaurent"], 128);
f("packages/ui/src/Tooltip.tsx", "Hover/focus tooltip with smart placement.", ["jlaurent"], 74);
f("packages/ui/src/Button.test.tsx", "Unit tests for button variants and loading state.", ["jlaurent"], 66);
f("packages/ui/src/PriceTag.test.tsx", "Snapshot + locale tests for price formatting.", ["jlaurent"], 52);

dir("packages/core", 48, {
  description: "shared domain logic: money, sessions, flags, analytics.",
  owners: ["sokafor"],
  agentMd: [
    "#### packages/core",
    "- zero react in here; this package runs in web, api, and workers.",
    "- breaking changes need a coordinated release across all importers.",
  ].join("\n"),
});

dir("packages/core/src", 22, { description: "domain modules, one concern per file." });

file("packages/core/src/currency.ts", {
  description:
    "All money math: integer minor units, allocation, display formatting. Six downstream importers across web, api, and the indexer.",
  loc: 156,
  owners: ["sokafor"],
  featureIds: ["checkout"],
  ticketIds: ["LIN-471"],
  recentChanges: [
    { sha: "f402bb1", message: "extract CartSummary line-item math into currency.ts", author: "sam okafor", when: "6d ago", pr: 471 },
    { sha: "3e88d02", message: "banker's rounding behind rounding-mode flag", author: "sam okafor", when: "10d ago", pr: 461 },
  ],
  agentMd: [
    "#### currency.ts",
    "- all money is integer minor units. never introduce floats.",
    "- any rounding change requires updating property tests in currency.test.ts.",
    "- rounding mode is flag-gated during the rollout — read it from flags.ts.",
    "- breaking: 6 downstream imports.",
  ].join("\n"),
  tests: { status: "pass", coveredBy: ["packages/core/src/currency.test.ts"] },
});

f("packages/core/src/currency.test.ts", "Property tests for allocation and rounding across currencies.", ["sokafor"], 142);

file("packages/core/src/session.ts", {
  description: "Session token model shared by web and api: issue, refresh, revoke. One clock to rule out drift.",
  loc: 124,
  owners: ["sokafor"],
  featureIds: ["auth"],
  ticketIds: ["LIN-455"],
  dependencies: [{ name: "redis", kind: "tool", install: "docker compose up -d redis" }],
  recentChanges: [
    { sha: "2b5cc90", message: "stop refresh loop on safari (double-mount)", author: "miguel reyes", when: "14d ago", pr: 455 },
    { sha: "8cc1d37", message: "rotate refresh tokens on every use", author: "sam okafor", when: "20d ago", pr: 447 },
  ],
  agentMd: [
    "#### session.ts",
    "- refresh tokens rotate on use; reuse of an old token revokes the family.",
    "- the safari refresh loop (`LIN-455`) came from calling refresh in parallel — keep the mutex.",
    "- needs redis locally: `docker compose up -d redis`.",
  ].join("\n"),
  tests: { status: "pass", coveredBy: ["packages/core/src/session.test.ts"] },
});

f("packages/core/src/session.test.ts", "Token rotation and revocation-family tests.", ["sokafor"], 98);

file("packages/core/src/analytics.ts", {
  description: "Typed event emitter for product analytics; batches to the collector and drops cleanly when offline.",
  loc: 88,
  owners: ["sokafor"],
  recentChanges: [{ sha: "73b2a4c", message: "emit analytics click event with variant", author: "jules laurent", when: "6d ago", pr: 473 }],
  agentMd: ["#### analytics.ts", "- events are typed in `EVENTS`; add there first, emit second."].join("\n"),
});

file("packages/core/src/flags.ts", {
  description: "Feature flag reads with typed keys. The checkout-v2 rollout flag lives here.",
  loc: 64,
  owners: ["sokafor"],
  featureIds: ["checkout"],
  ticketIds: ["LIN-482"],
  recentChanges: [{ sha: "8d91e4a", message: "gate new payment flow behind checkout-v2 flag", author: "miguel reyes", when: "3d ago", pr: 479 }],
  agentMd: ["#### flags.ts", "- flags are read-only at runtime; rollout percentages change in the dashboard, not here."].join("\n"),
  tests: { status: "pass", coveredBy: ["packages/core/src/flags.test.ts"] },
});

f("packages/core/src/flags.test.ts", "Flag parsing and default-off behavior tests.", ["sokafor"], 44);
f("packages/core/src/ids.ts", "Sortable unique id generation.", ["sokafor"], 26);
f("packages/core/src/dates.ts", "Utc-only date helpers shared by web and api.", ["sokafor"], 51);

dir("packages/config", 14, { description: "shared eslint, tsconfig, and prettier presets.", owners: ["mreyes"] });
f("packages/config/eslint.config.js", "Flat eslint config shared by every workspace.", ["mreyes"], 82);
f("packages/config/tsconfig.base.json", "Strict base tsconfig all packages extend.", ["mreyes"], 38);
f("packages/config/prettier.config.js", "House formatting rules.", ["mreyes"], 12);

// ---------------------------------------------------------------------------
// services/
// ---------------------------------------------------------------------------

dir(
  "services",
  236,
  {
    description: "long-running workers; today that's mostly the search indexer.",
    owners: ["pnair"],
    dependencies: [{ name: "pnpm workspace", kind: "tool", install: "pnpm --filter search-indexer dev" }],
  },
  true,
);

dir(
  "services/search-indexer",
  88,
  {
    description: "the worker that keeps search results fresh: drains the ingest queue and writes the index.",
    owners: ["pnair"],
    featureIds: ["search"],
    ticketIds: ["ACME-2188"],
    recentChanges: [
      { sha: "c9d20f4", message: "cap retry backoff at 5m", author: "priya nair", when: "2d ago", pr: 481 },
      { sha: "6ba07e2", message: "dead-letter poison docs instead of requeueing", author: "priya nair", when: "5d ago", pr: 474 },
    ],
    agentMd: [
      "#### search-indexer",
      "- run locally with `pnpm --filter search-indexer dev`; it needs the queue container up.",
      "- mapping changes trigger a full reindex — coordinate before merging.",
    ].join("\n"),
  },
  true,
);

dir("services/search-indexer/src", 34, { description: "worker loop, queue client, retry policy, index mappings." }, true);

file("services/search-indexer/src/indexer.ts", {
  description:
    "The worker loop: drains the ingest queue, normalizes product docs, writes the search index. Prices normalize through currency.ts.",
  loc: 178,
  owners: ["pnair"],
  featureIds: ["search"],
  recentChanges: [
    { sha: "6ba07e2", message: "dead-letter poison docs instead of requeueing", author: "priya nair", when: "5d ago", pr: 474 },
    { sha: "f119ac3", message: "batch index writes per 200 docs", author: "priya nair", when: "12d ago", pr: 459 },
  ],
  agentMd: ["#### indexer.ts", "- one doc failing must never stall the batch; poison docs go to the dead letter."].join("\n"),
  tests: { status: "pass", coveredBy: ["services/search-indexer/src/indexer.test.ts"] },
});

f("services/search-indexer/src/indexer.test.ts", "Worker-loop tests with a fake queue and index.", ["pnair"], 104);

file("services/search-indexer/src/retry.ts", {
  description: "Backoff and retry policy for failed index writes. The exhaustion path is what ACME-2188 is about.",
  loc: 92,
  owners: ["pnair"],
  featureIds: ["search"],
  ticketIds: ["ACME-2188"],
  recentChanges: [
    { sha: "c9d20f4", message: "cap retry backoff at 5m", author: "priya nair", when: "2d ago", pr: 481 },
    { sha: "12e77b0", message: "count attempts per doc, not per batch", author: "priya nair", when: "6d ago", pr: 472 },
  ],
  agentMd: [
    "#### retry.ts",
    "- retries are per-doc; batch-level retries are how the queue exhausted (`ACME-2188`).",
    "- the timing tests race a fake clock — fix the clock, not the assertions.",
  ].join("\n"),
  tests: { status: "fail", coveredBy: ["services/search-indexer/src/retry.test.ts"] },
});

f(
  "services/search-indexer/src/retry.test.ts",
  "Covers backoff timing and the queue-exhaustion path — currently red; timing assertions race the fake clock.",
  ["pnair"],
  76,
);

file("services/search-indexer/src/queue.ts", {
  description: "Ingest queue client: batching, acks, dead-letter handoff.",
  loc: 84,
  owners: ["pnair"],
  featureIds: ["search"],
  dependencies: [{ name: "bullmq", kind: "package" }],
  recentChanges: [{ sha: "6ba07e2", message: "dead-letter poison docs instead of requeueing", author: "priya nair", when: "5d ago", pr: 474 }],
  agentMd: ["#### queue.ts", "- acks are explicit; auto-ack hid the exhaustion bug for a week."].join("\n"),
});

file("services/search-indexer/src/mapping.ts", {
  description: "Index field mappings and analyzers; a change here means a full reindex.",
  loc: 66,
  owners: ["pnair"],
  recentChanges: [{ sha: "5c00d9e", message: "add plural-aware analyzer for titles", author: "priya nair", when: "9d ago", pr: 463 }],
  agentMd: ["#### mapping.ts", "- mapping edits require a coordinated full reindex; announce before merging."].join("\n"),
});

// ---------------------------------------------------------------------------
// tools/
// ---------------------------------------------------------------------------

dir("tools", 52, {
  description: "repo scripts: codegen, dependency checks, release plumbing. intentionally boring.",
  owners: ["ltanaka"],
});
f("tools/generate-icons.mjs", "Builds the icon sprite from svg sources.", ["ltanaka"], 64);
f("tools/check-deps.mjs", "Fails ci on undeclared or duplicate dependencies.", ["ltanaka"], 92);
f("tools/release.mjs", "Tags, changelogs, and publishes changed packages.", ["ltanaka"], 118);
f("tools/bump-versions.mjs", "Coordinated version bumps across workspaces.", ["ltanaka"], 47);

export const REPO_NODES: RepoNode[] = nodes;
