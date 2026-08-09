# Workspace Packs

Workspace Pack schema version 1 is a portable, declarative, code-free description of Sayre's product workspace. A pack directory contains `sayre.workspace.json` and a README. The JSON selects trusted component IDs, view contributions, dock regions, semantic theme tokens, and defaults; it never contains JavaScript, module paths, URLs, queries, raw HTML, or raw CSS.

Resolution order is immutable safety defaults, an exact pinned installed pack, a future organization override, a local personal override, and transient per-pack/layout/viewport size and collapse preferences. Built-ins are immutable. Imported versions install side by side and never update an active pin automatically. Editing either kind creates a personal override until the user materializes a fork with a new identity and `derivedFrom` reference.

Exports are canonical JSON and contain only materialized pack configuration. Repository/ref state, graph data, sessions, tenant/user identity, local storage keys, editor history, personal overrides, and transient preferences are excluded. Coworker sharing is file-based: export, transfer, validate, install, then explicitly activate the exact version.

The runtime, schema, components, and capabilities are versioned separately. Incompatible schema/runtime bounds or missing required catalog versions fail closed to the safety pack with recovery UI. A future marketplace may ingest the same canonical artifact, but hosting, signing, moderation, discovery, organization synchronization, payments, and executable extensions are outside version 1. New executable React elements require a normal source-code review and a new trusted catalog version.
