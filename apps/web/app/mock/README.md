# MVP UI mock

A clickable wireframe of the Sayre MVP workspace at `/mock`. Everything it
shows comes from `fixtures.ts` — no API is called, no repository is read, and
nothing it renders depends on a running backend.

It exists so the shell, its modular slots, and every state the MVP has to
handle can be reviewed before the real client is wired to the service layer.
It does not replace anything: `/`, `/product`, and `/settings/providers` are
untouched, and `mock.css` is scoped under `.mock-root` so its palette cannot
leak into them.

## Reaching the states

Open **Mock controls** in the top bar. The dials there drive session, role,
repository access, readiness, graph data, semantic processing, realtime
status, backend availability, GitHub installation outcome, the Agent/Skill MD
conflict case, Workspace Pack selection, and 320/736/desktop layout previews.
The pack and layout controls use the same resolver and trusted catalog as the
live product; the surrounding scenario panel remains fixture-only.

## Layout

```
apps/web/app/mock/
  page.tsx                    route entry
  mock.css                    Warm Graphite tokens + all mock styles
  types.ts                    shapes, mirroring the real app/lib contracts
  fixtures.ts                 the fictional acme/atlas repository
  state.tsx                   scenario + UI state (context + reducer)
  components/                 shell slots: top bar, view rail, toolbar,
                              status banner, canvas states, global states,
                              the Ask Sayre dock shell, mock controls
  canvas/                     React Flow canvases + tree layout
  drawer/                     node overlay modules and the feature drawer
  settings/                   GitHub Integrations, Model Providers
```

The shell is assembled from versioned Workspace Pack regions backed by a
trusted component/capability catalog. Open **Workspace recovery → Edit
workspace layout** to exercise drag/reorder, replacement, hide/restore,
resizing, and semantic theme tokens without changing product code.

## Rules the mock holds to

- **Only Folder and File nodes reach the canvas**, with CONTAINS and IMPORTS
  edges. Function and Class nodes stay internal; CALLS and INHERITS are never
  drawn.
- **Background work is described in user language.** Preparing repository,
  Technical Tree ready, Generating Product Tree, semantic features degraded,
  refreshing after a significant change, reconnecting to live updates. No
  queues, workers, retries, embeddings, or infrastructure controls.
- **Nothing offers an action the product cannot perform.** There is no Retry,
  Reindex, or Force-sync button, because no user-facing endpoint backs them.
- **Admin-only actions are absent for members**, not disabled — Settings does
  not appear in the top bar at all.
- **RBAC is shown by omission.** Unauthorized repositories and nodes are simply
  not present; the UI never describes what it is hiding.
- **No raw credentials.** Model provider settings choose an approved credential
  reference and an approved endpoint from lists. A key is never typed or shown.

## Reserved, not functional

These have backends but no browser-callable route yet, so they hold space and
say so rather than pretending to work: the **Standards** overlay module,
detailed **GitHub installation management**, **Jira/Linear connection
management**, **branch switching**, and the **realtime sync indicator**,
which reports state and controls nothing. Contextual **Ask Sayre** (dock
under the canvas) is real now; in the fixture workspace specifically its
composer stays disabled and says why, because there is no chat backend
behind the mock.

## Not in the mock

Onboarding Tree and sandboxed setup execution, dynamic test-coverage badges,
MCP tools and key management, organization/member/permission administration,
the macro project-to-repository view, deployable LLM authoring, marketplace
transport/publication, raw API-key entry, Jira/Linear connection setup, full
repository sync control, and a working chatbot. Workspace Packs are locally
importable/exportable; marketplace ingestion remains a separately scoped trust
and distribution layer.
