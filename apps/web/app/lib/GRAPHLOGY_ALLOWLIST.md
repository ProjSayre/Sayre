# Graphology client-operation allowlist

Graphology receives only the Folder/File payload already authorized and stripped by
the server-side Graph Query Service. Its client-side use is limited to:

- constructing an in-memory graph from that server-filtered payload;
- reading or updating presentation attributes such as position, color, and size;
- extracting an induced subgraph from an explicit server-supplied node-ID set; and
- applying local layout coordinates.

It must not perform RBAC decisions, tenant filtering, permission-derived node
stripping, deep traversal, neighborhood expansion, or fetch additional nodes. Those
operations remain server-side. A client filter can hide authorized data for display;
it can never establish that data is authorized.
