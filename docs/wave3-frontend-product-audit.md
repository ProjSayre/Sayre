# Wave 3 frontend product audit

Date: 2026-07-26

## Decision

Sayre is useful today as a relationship lens after a developer or PM already
knows what they are looking for. It is not yet a replacement for an IDE,
GitHub, Jira, Linear, or repository documentation, and it should not require
graph literacy for basic workflows.

The intended presentation hierarchy is:

1. **Technical:** Explorer and search for navigation; graph for structure,
   dependencies, and focused impact.
2. **Onboarding:** ordered, copyable guidance and repository essentials first;
   graph as secondary orientation.
3. **Product:** inventory/overview for scanning; feature map for relationships
   and code evidence.

## Method

Three independent read-only persona audits covered:

- a working developer finding code, tracing dependencies, and assessing a
  change;
- a newly onboarding engineer finding documentation, setup steps, and recovery
  paths;
- a nontechnical PM identifying scope, ownership, relationships, activity,
  delivery state, and risk.

The root verification pass then exercised the live public build and the fixture
lab in a browser before and after the frontend fixes.

## Live evidence

Repository: `kanbn/kan`, ref `main`.

- Technical Tree: 762 nodes, 614 files, 1,033 relationships, including 272
  imports.
- Test coverage: all 614 files are unknown/unmeasured.
- Product Tree: 11 inferred features and 26 unique mapped files.
- Product mapping completeness: 26/614 files (4.2%); 588 files are unmapped.
- Feature relationships: two detected cross-feature links; eight features are
  isolated in the current projection.
- Feature activity: zero recent edits in all 11 feature records.
- Sampled Product member overlays: no generated node descriptions, activity,
  tickets, or Agent/Skill documents; ten of 26 have dependency data.
- Onboarding: 762 authorized repository nodes and zero generated setup steps.
- Onboarding provider state: absent for the live revision.

These are data-availability facts, not proof that the repository has no tests,
activity, tickets, documentation, setup requirements, or technical
relationships.

## Frontend changes made now

- Added visible `Files`, `Tech`, `Product`, and `Start` navigation labels.
- Removed renderer implementation names and the permanently disabled Ask Sayre
  dock from primary chrome.
- Changed the Technical overview to show top-level folder landmarks instead of
  a root-file starburst.
- Made a Technical folder's primary canvas action expand/collapse it and
  enlarged graph hit targets.
- Added a computed folder overview with descendant and import counts.
- Added a Technical relationship legend, import arrows, direct-neighbor
  highlighting, and bounded one-hop reveal for a selected file.
- Added contextual search labels, explicit result counts, a zero-result state,
  and a clear action; search no longer leaks across view changes.
- Added source handoff, copy-path feedback, shareable `nodeId`/`featureId`
  state, and a return-to-feature action.
- Split dependencies into “this file imports” and “other files import this,”
  and route Product-only dependency targets into the complete Technical Tree.
- Withheld drawer empty claims until metadata has loaded, ranked useful modules
  first, collapsed empty modules, hid the reserved Standards module, and
  disclosed context availability.
- Labeled Product as an AI-inferred partial map and disclosed 26/614 mapped
  files plus the 588 unmapped files.
- Added a Product feature inventory, code-area summary, honest unknown activity
  state, related-feature explanations, directional import arrows, and an
  explicit Technical handoff.
- Increased Product file and directory hit areas without changing the visual
  dot/ring grammar.
- Queried the onboarding-specific provider-state surface and stopped using
  product generation state as onboarding truth.
- Reframed Onboarding as a suggested setup plan rather than proof the
  repository runs.
- Added README, AGENTS, CONTRIBUTING, manifest, environment, workspace, and
  Compose landmarks to the live zero-step fallback.
- Added purpose/expected-result guidance, copy actions, member guidance,
  admin-only sandbox separation, and session-scoped progress persistence.
- Added view-correct loading copy and recovery actions for unavailable views.

## Post-demo product and backend work

### P0 — Make onboarding real

- Generate from bounded README, manifest, workspace, environment-template, and
  Compose content, not paths/languages alone.
- Return a structured title, purpose, working directory, expected result,
  verification, related files, provenance, and troubleshooting for every step.
- Either run checks against an immutable sanitized repository snapshot or
  narrow the sandbox promise. The current empty, networkless container cannot
  validate a repository build/install/migration.
- Persist progress server-side by organization, repository, ref, revision, and
  user.

### P0 — Make Product trustworthy and decision-ready

- Improve feature membership coverage and import resolution.
- Return confidence, evidence, provenance, freshness, and correction history
  for descriptions, teams, membership, and relationships.
- Model explicit directional feature relationships rather than inferring all
  product semantics from file imports.
- Aggregate delivery status, milestones, tickets, changes, reviews,
  deployments, blockers, test health, and risk at feature level.
- Distinguish connected-and-empty from not connected, not ingested, stale, and
  failed.

### P1 — Make developer impact analysis a first-class task

- Add a server-authorized impact projection with bounded transitive callers,
  dependencies, cycles, changed contracts, covering tests, and affected
  deployables.
- Add source/symbol/line context and canonical provider URLs.
- Add branch/PR scope, navigation history, and shareable task state.
- Preserve graph direction and evidence across package aliases and workspace
  boundaries.

### P1 — Complete the integration layer

- Make Jira/Linear connection state and issue ingestion browser-accessible.
- Add CODEOWNERS/team ownership, PR/change history, test coverage, standards,
  ADR/document links, and freshness timestamps.
- Enable Ask Sayre only when its authorized API is available, and return cited
  context nodes with each answer.

### P1 — Add workflow regression coverage

Add browser-level tests for:

1. cold navigation and folder expansion without an empty drawer;
2. search, result count, focus, and clear;
3. Product coverage disclosure and inventory-to-feature flow;
4. Product dependency handoff to Technical and return;
5. live zero-step onboarding landmarks;
6. member copy/admin sandbox behavior and persisted progress;
7. selected-node and selected-feature deep links;
8. keyboard and narrow-screen completion of the same journeys.

## Verification completed

- Web TypeScript check
- 157 web unit/contract tests
- Next.js production build
- Browser passes against the live public repository and fixture onboarding
  workflow

