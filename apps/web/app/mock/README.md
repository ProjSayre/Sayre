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
status, backend availability, GitHub installation outcome, and the
Agent/Skill MD conflict case. Nothing in that panel ships.

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
                              reserved Ask Sayre dock, mock controls
  canvas/                     React Flow canvases + tree layout
  drawer/                     node overlay modules and the feature drawer
  settings/                   GitHub Integrations, Model Providers
```

The shell is assembled from view, toolbar, canvas, drawer, panel, and
status-banner slots so a later custom-view mechanism can compose it without an
MVP-facing view builder.

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
say so rather than pretending to work: contextual **Ask Sayre** (dock under the
canvas), the **Standards** overlay module, detailed **GitHub installation
management**, **Jira/Linear connection management**, **branch switching**, and
the **realtime sync indicator**, which reports state and controls nothing.

## Not in the mock

Onboarding Tree and sandboxed setup execution, dynamic test-coverage badges,
MCP tools and key management, organization/member/permission administration,
the macro project-to-repository view, LLM-created custom views and the preset
marketplace, raw API-key entry, Jira/Linear connection setup, full repository
sync control, and a working chatbot.
