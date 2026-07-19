# MCP handlers

W4-06 owns Sayre's MCP server and tool handlers. This directory exists now so
the service boundary is established before that work begins.

An MCP handler is a thin protocol adapter: validate/adapt tool input, obtain the
server-resolved `{ orgId, roles }` context, call one function from
`../services/`, and serialize the result. Business logic, authorization policy,
graph traversal, database/vector access, and queue publication do not belong
here. The same service function must remain reusable from REST routes, future
GraphQL resolvers, and MCP tools.

The ESLint override in `services/core/.eslintrc.json` applies the same line,
statement, and restricted-import gates to `src/mcp/**/*.ts` and
`src/routes/**/*.ts`.
