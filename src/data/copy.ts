// Landing-page copy — verbatim from spec §11. Do not edit without a team decision.

export const HERO = {
  eyebrow: "early access · 2026",
  h1: "Your codebase, mapped.",
  sub: "Sayre parses a repository into a living graph every role can actually read — engineers trace dependencies, product managers see features, new hires find their footing.",
  ctaPrimary: "explore the live demo",
  ctaSecondary: "join the waitlist",
  teaserChip: "click to drive →",
};

export const PROBLEM = {
  h2: "A codebase is a kitchen without labels.",
  body: 'Everything is somewhere. Nobody can say where. Every onboarding, every handoff, every "which file is checkout actually in?" pays the tax.',
};

export const LENSES = {
  h2: "One graph. Three lenses.",
  cards: [
    {
      eyebrow: "view as: new hire",
      h3: "new hire",
      body: "Start from how the pieces lean on each other — which services call which, one level at a time — with setup steps and guardrails attached to the exact files they concern.",
    },
    {
      eyebrow: "view as: tech lead",
      h3: "tech lead",
      body: "Ownership, churn, failing tests, and module boundaries on one canvas. See boundaries drift before they break.",
    },
    {
      eyebrow: "view as: product manager",
      h3: "product manager",
      body: "Features drawn as real boundaries across the code — with tickets and shipping progress pinned to them, no engineer required to translate.",
    },
  ],
};

export const HOW_IT_WORKS = {
  h2: "How it works.",
  rows: [
    { num: "01", h3: "connect your repo", body: "A read-only GitHub app watches your default branch." },
    {
      num: "02",
      h3: "the graph builds itself",
      body: "Tree-sitter parsing plus LLM enrichment turn files into an ontology: features, owners, styles, tests.",
    },
    {
      num: "03",
      h3: "everyone reads it their way",
      body: "Three views over one graph, live within seconds of every push.",
    },
  ],
};

export const DEEP_DIVES = [
  {
    view: "filetree",
    h3: "The shape of the repo, at a glance.",
    body: "Hollow circles are folders, filled dots are files, and the path to anything you select lights up. Your repo's actual hierarchy — not a metaphor for it.",
  },
  {
    view: "features",
    h3: "The map product managers keep asking for.",
    body: "Features become first-class shapes — sized by how much of the repo they wrap, holding their directories and files inside, with tickets and shipping progress attached.",
  },
  {
    view: "relations",
    h3: "See how the pieces lean on each other.",
    body: "Start at the repo: four directories and the lines between them. Click into one and the graph re-draws a level down — the connections a new hire needs, without reading a single import.",
  },
] as const;

export const WAITLIST_BAND = {
  h2: "Want this on your codebase?",
  body: "We're onboarding design partners now. Early teams get white-glove setup and a real say in what ships.",
  fine: "no spam · one email when your invite is ready",
};

export const REPO_OVERVIEW =
  "storefront, api, admin tool, and shared packages for acme's e-commerce stack. a checkout revamp is mid-flight; the search indexer is on a flaky streak.";
