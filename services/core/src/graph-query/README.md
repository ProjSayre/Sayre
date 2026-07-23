# Graph Query Service

This module is the sole node-level authorization boundary for graph reads.

- `permissions.ts` resolves direct-user/role (and future agent-key) permission
  rows through Postgres RLS and normalizes repo/ref/path scopes.
- `index.ts` embeds allow/deny scopes in static, parameterized openCypher and
  repeats the authorization decision while mapping results as defense in depth.
- `neo4j.ts` owns instrumented read sessions and lazy secret-backed driver setup.

Only Folder/File nodes and CONTAINS/IMPORTS edges can leave this layer. Every
public method requires the complete server-derived `AuthContext`; callers must
never construct tenant identity from request parameters or bodies.
