import type { Ticket } from "./types";

export const TICKETS: Ticket[] = [
  { id: "LIN-482", source: "linear", title: "stripe payment-intent migration", status: "in progress" },
  { id: "LIN-471", source: "linear", title: "rounding error on multi-currency carts", status: "open" },
  { id: "LIN-490", source: "linear", title: "promo codes double-apply on cart merge", status: "open" },
  { id: "LIN-455", source: "linear", title: "session refresh loop on safari", status: "done" },
  { id: "LIN-467", source: "linear", title: "oauth state mismatch on mobile safari", status: "open" },
  { id: "LIN-458", source: "linear", title: "input masks for card fields", status: "in progress" },
  { id: "LIN-440", source: "linear", title: "modal focus trap escapes on ios", status: "done" },
  { id: "ACME-2201", source: "jira", title: "search results flicker on refine", status: "in progress" },
  { id: "ACME-2188", source: "jira", title: "indexer retries exhaust queue", status: "open" },
  { id: "ACME-2144", source: "jira", title: "synonym support for plurals", status: "done" },
  { id: "ACME-2210", source: "jira", title: "dark mode token audit", status: "open" },
  { id: "ACME-2216", source: "jira", title: "order export times out over 10k rows", status: "open" },
];
