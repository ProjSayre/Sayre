# Workspace Pack authoring

This is an experimental, runtime-neutral procedure for a developer or LLM operating inside a reviewed checkout. The visual-editor gate must pass first. This workflow is not a production agent or publication path.

1. Inspect the current pack with `npm run workspace-pack -- inspect <pack-directory> --json`.
2. Inspect the trusted catalog with `npm run workspace-pack -- catalog --json`.
3. Translate the request only into documented `WorkspaceEditOperation` values.
4. Run semantic edit with `--dry-run --json` and review the prospective result.
5. Validate the result, then apply the same operation file without `--dry-run`.
6. Run diff and report every changed contract path.
7. Preview the result in the fixture lab at compact, standard, and wide sizes.
8. Fork to a new identity before export or coworker sharing.

Write commands are confined to `apps/web/workspace-packs` by default. For a
reviewed alternate authoring directory, pass `--root <absolute-or-relative-root>`;
the pack directory, fork destination, and export destination must resolve under
that root. This is a filesystem boundary, not a way to authorize new component
or capability IDs.

If the request cannot be expressed by the catalog, stop with a **trusted-catalog-extension** proposal naming the missing component/capability contract. Do not fall back to low-level patch, and do not edit TSX, CSS, authentication, transport, data-source, graph, or authorization code under this authoring procedure. Never invent IDs, embed code, weaken the validator, or use repository/customer credentials.
