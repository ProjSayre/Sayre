import type { RepoEdge } from "./types";

// ---------------------------------------------------------------------------
// Authored file-level edges (spec §5.2). Invariants:
// - currency.ts: exactly 6 in, 1 out (pinned in appendix A.1).
// - no sibling pair at any authored scope has aggregate edges in both directions.
// - packages/ scope rolls up to exactly one aggregate edge (ui → core), and it
//   does NOT route through currency.ts.
// - ~10 `calls` edges model the frontend-calls-backend runtime flows.
// ---------------------------------------------------------------------------

const imp = (from: string, to: string): RepoEdge => ({ from, to, kind: "imports" });
const call = (from: string, to: string): RepoEdge => ({ from, to, kind: "calls" });

export const REPO_EDGES: RepoEdge[] = [
  // checkout cluster ---------------------------------------------------------
  imp("apps/web/src/checkout/CheckoutPage.tsx", "apps/web/src/checkout/PaymentForm.tsx"),
  imp("apps/web/src/checkout/CheckoutPage.tsx", "apps/web/src/checkout/CartSummary.tsx"),
  imp("apps/web/src/checkout/CheckoutPage.tsx", "packages/ui/src/Button.tsx"),
  imp("apps/web/src/checkout/CheckoutPage.tsx", "apps/web/src/components/Layout.tsx"),
  imp("apps/web/src/checkout/PaymentForm.tsx", "apps/web/src/checkout/useCheckout.ts"),
  imp("apps/web/src/checkout/PaymentForm.tsx", "packages/core/src/currency.ts"),
  imp("apps/web/src/checkout/PaymentForm.tsx", "packages/ui/src/PriceTag.tsx"),
  imp("apps/web/src/checkout/PaymentForm.tsx", "packages/ui/src/Input.tsx"),
  imp("apps/web/src/checkout/PaymentForm.tsx", "packages/core/src/flags.ts"),
  imp("apps/web/src/checkout/CartSummary.tsx", "apps/web/src/checkout/useCheckout.ts"),
  imp("apps/web/src/checkout/CartSummary.tsx", "packages/core/src/currency.ts"),
  imp("apps/web/src/checkout/CartSummary.tsx", "packages/ui/src/PriceTag.tsx"),
  imp("apps/web/src/checkout/OrderConfirmation.tsx", "apps/web/src/checkout/useCheckout.ts"),
  imp("apps/web/src/checkout/useCheckout.ts", "packages/core/src/analytics.ts"),
  imp("apps/web/src/checkout/useCheckout.test.ts", "apps/web/src/checkout/useCheckout.ts"),

  // search cluster -----------------------------------------------------------
  imp("apps/web/src/search/SearchPage.tsx", "apps/web/src/search/SearchBox.tsx"),
  imp("apps/web/src/search/SearchPage.tsx", "apps/web/src/search/useSearchResults.ts"),
  imp("apps/web/src/search/SearchPage.tsx", "apps/web/src/components/ProductCard.tsx"),
  imp("apps/web/src/search/SearchBox.tsx", "packages/ui/src/Input.tsx"),
  imp("apps/web/src/search/useSearchResults.ts", "packages/core/src/analytics.ts"),

  // indexer service ----------------------------------------------------------
  imp("services/search-indexer/src/indexer.ts", "packages/core/src/currency.ts"),
  imp("services/search-indexer/src/indexer.ts", "services/search-indexer/src/queue.ts"),
  imp("services/search-indexer/src/indexer.ts", "services/search-indexer/src/retry.ts"),
  imp("services/search-indexer/src/indexer.ts", "services/search-indexer/src/mapping.ts"),
  imp("services/search-indexer/src/retry.ts", "services/search-indexer/src/queue.ts"),
  imp("services/search-indexer/src/retry.test.ts", "services/search-indexer/src/retry.ts"),
  imp("services/search-indexer/src/indexer.test.ts", "services/search-indexer/src/indexer.ts"),

  // auth cluster --------------------------------------------------------------
  imp("apps/web/src/account/SettingsPage.tsx", "apps/web/src/account/useSession.ts"),
  imp("apps/web/src/account/SettingsPage.tsx", "packages/ui/src/Modal.tsx"),
  imp("apps/web/src/account/SignInPage.tsx", "apps/web/src/account/useSession.ts"),
  imp("apps/web/src/account/SignInPage.tsx", "packages/ui/src/Button.tsx"),
  imp("apps/web/src/account/useSession.ts", "packages/core/src/session.ts"),
  imp("apps/api/src/routes/auth.ts", "packages/core/src/session.ts"),
  imp("apps/api/src/routes/middleware.ts", "packages/core/src/session.ts"),

  // api routes → shared middleware --------------------------------------------
  imp("apps/api/src/routes/payments.ts", "apps/api/src/routes/middleware.ts"),
  imp("apps/api/src/routes/orders.ts", "apps/api/src/routes/middleware.ts"),
  imp("apps/api/src/routes/search.ts", "apps/api/src/routes/middleware.ts"),
  imp("apps/api/src/routes/auth.ts", "apps/api/src/routes/middleware.ts"),
  imp("apps/api/src/routes/payments.ts", "packages/core/src/currency.ts"),
  imp("apps/api/src/routes/orders.ts", "packages/core/src/currency.ts"),
  imp("apps/api/src/routes/payments.test.ts", "apps/api/src/routes/payments.ts"),
  imp("apps/api/src/routes/orders.test.ts", "apps/api/src/routes/orders.ts"),
  imp("apps/api/src/routes/auth.test.ts", "apps/api/src/routes/auth.ts"),
  imp("apps/api/src/routes/middleware.test.ts", "apps/api/src/routes/middleware.ts"),

  // admin ----------------------------------------------------------------------
  imp("apps/admin/src/AdminApp.tsx", "apps/admin/src/OrdersTable.tsx"),
  imp("apps/admin/src/OrdersTable.tsx", "packages/ui/src/Button.tsx"),

  // packages/core internals (pinned: currency.ts exactly 1 out, test → subject)
  imp("packages/core/src/currency.ts", "packages/core/src/flags.ts"),
  imp("packages/core/src/currency.test.ts", "packages/core/src/currency.ts"),
  imp("packages/core/src/session.test.ts", "packages/core/src/session.ts"),
  imp("packages/core/src/flags.test.ts", "packages/core/src/flags.ts"),

  // packages/ui internals + the single ui → core aggregate ---------------------
  imp("packages/ui/src/Button.tsx", "packages/core/src/analytics.ts"),
  imp("packages/ui/src/Modal.tsx", "packages/ui/src/Button.tsx"),
  imp("packages/ui/src/Button.test.tsx", "packages/ui/src/Button.tsx"),
  imp("packages/ui/src/PriceTag.test.tsx", "packages/ui/src/PriceTag.tsx"),

  // web components / product ----------------------------------------------------
  imp("apps/web/src/components/Header.tsx", "packages/ui/src/Button.tsx"),
  imp("apps/web/src/components/ProductCard.tsx", "packages/ui/src/PriceTag.tsx"),

  // runtime http flows (calls) ---------------------------------------------------
  call("apps/web/src/checkout/useCheckout.ts", "apps/api/src/routes/payments.ts"),
  call("apps/web/src/checkout/CheckoutPage.tsx", "apps/api/src/routes/orders.ts"),
  call("apps/web/src/search/SearchPage.tsx", "apps/api/src/routes/search.ts"),
  call("apps/web/src/search/SearchBox.tsx", "apps/api/src/routes/search.ts"),
  call("apps/web/src/account/SettingsPage.tsx", "apps/api/src/routes/auth.ts"),
  call("apps/web/src/account/SignInPage.tsx", "apps/api/src/routes/auth.ts"),
  call("apps/admin/src/OrdersTable.tsx", "apps/api/src/routes/orders.ts"),
  call("apps/admin/src/OrdersTable.tsx", "apps/api/src/routes/payments.ts"),
  call("apps/admin/src/AdminApp.tsx", "apps/api/src/routes/auth.ts"),
  call("apps/api/src/routes/search.ts", "services/search-indexer/src/indexer.ts"),
];
