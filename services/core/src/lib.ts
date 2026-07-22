// Library entry point for OTHER Sayre services (currently: services/gateway,
// W2-03) that need to reuse a piece of Core's implementation without pulling
// in the Express app, Postgres/Drizzle, or the Neo4j driver.
//
// package.json's "main"/"types" point at this file's compiled output
// (dist/lib.js / dist/lib.d.ts) -- deliberately NOT src/index.ts, which has
// the side effect of starting the HTTP listener at import time.
//
// W2-03 O-4: the gateway needs `verifySessionToken`/`SessionClaims` (WS
// connection auth) and `assertValidEnvelope`/`MessageEnvelope` (validating
// the `graph-updated-realtime` SQS payload) without a second, divergent
// implementation of either. This module is that single reuse point. Keep
// this export list narrow and deliberate -- do not re-export app.ts, the
// route/service/db layers, or the graph-query client from here.
export { verifySessionToken, SessionTokenError, type SessionClaims } from './auth/sessionToken';
export { assertValidEnvelope, EnvelopeValidationError, type MessageEnvelope } from './queue/envelope';
