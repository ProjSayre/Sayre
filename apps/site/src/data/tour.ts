import type { PersonaId, Tab } from "./types";

// Guided tour script (spec §9) — steps are data; Tour.tsx executes them through
// the same reducers as user input. Never a canned overlay picture.

export type TourAction =
  | { kind: "deselect" }
  | { kind: "fit" }
  | { kind: "tab"; tab: Tab }
  | { kind: "selectFile"; id: string }
  | { kind: "select"; id: string }
  | { kind: "flyTo"; id: string }
  | { kind: "persona"; id: PersonaId }
  | { kind: "scope"; id: string }
  | { kind: "drill"; id: string }
  | { kind: "selectFeature"; id: string };

export interface TourStep {
  caption: string;
  anchor: { kind: "node"; id: string } | { kind: "center" };
  actions: TourAction[];
  final?: boolean;
}

const PAYMENT_FORM = "apps/web/src/checkout/PaymentForm.tsx";

export const TOUR_SEEN_KEY = "sayre.tourSeen";

export const TOUR_STEPS: TourStep[] = [
  {
    caption:
      "this is acme/monorepo — a 1,204-file sample repo mapped into a living graph. drag, zoom, click — nothing here is a screenshot.",
    anchor: { kind: "node", id: "acme" },
    actions: [{ kind: "persona", id: "tech-lead" }, { kind: "tab", tab: "filetree" }, { kind: "deselect" }, { kind: "fit" }],
  },
  {
    caption:
      "click any node and its ancestry lights up. you're viewing as the tech lead — owners, churn, and failing tests, front and center.",
    anchor: { kind: "node", id: PAYMENT_FORM },
    actions: [
      { kind: "selectFile", id: PAYMENT_FORM },
      { kind: "flyTo", id: PAYMENT_FORM },
    ],
  },
  {
    caption:
      "switch roles and the map itself changes. a new hire starts from how the pieces lean on each other — with setup steps and guardrails in the sidebar instead of ticket noise.",
    anchor: { kind: "center" },
    actions: [{ kind: "scope", id: "acme" }, { kind: "persona", id: "new-hire" }],
  },
  {
    caption:
      "click into any directory and the graph re-draws one level down — web and admin both call into api. connections a readme never explains.",
    anchor: { kind: "node", id: "apps/api" },
    actions: [
      { kind: "select", id: "apps" },
      { kind: "drill", id: "apps" },
      { kind: "select", id: "apps/api" },
    ],
  },
  {
    caption:
      "product managers get features as first-class shapes — checkout wraps 9 files across three workspaces, with its tickets and shipping progress pinned on.",
    anchor: { kind: "node", id: "checkout" },
    actions: [
      { kind: "persona", id: "pm" },
      { kind: "selectFeature", id: "checkout" },
    ],
  },
  {
    caption: "this demo is sample data. your repo is the real one.",
    anchor: { kind: "center" },
    actions: [],
    final: true,
  },
];
