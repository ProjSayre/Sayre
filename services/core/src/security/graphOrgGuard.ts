// Fail-closed org-scoping guard for the Neo4j path (W2-06). Neo4j has NO
// engine-level RLS analog -- see docs/tenant-isolation.md "Neo4j has no
// engine backstop". This is the one structural backstop shared by BOTH Neo4j
// executors: `graph-write/neo4j.ts::InstrumentedNeo4jWriteExecutor.run` and
// `graph-query/neo4j.ts::InstrumentedNeo4jReadExecutor.run`.
//
// Pure string/param check, no data-store import -- reusable by the static
// scan test (cypherOrgIdScan.test.ts) and both executors without creating an
// import cycle or a driver dependency.
//
// Does NOT authorize node-level access -- that is W2-02's permission store
// (graph-query/permissions.ts, canReadResource). This only enforces the
// tenant invariant: no Neo4j query can run without being bound to the
// server-resolved org id.
//
// Resolved decision Q5: assert-only, never auto-inject or rewrite the
// Cypher/params. Auto-injection is strictly weaker -- it can mask a query
// that forgot to reference $org_id while still binding the parameter, which
// is exactly the failure this guard exists to catch.
//
// Post-security-audit hardening (FND-5da52fce61f4, 2026-07-23): the original
// check was `cypher.includes('$org_id')`, a raw substring test. An
// adversarial audit proved this passes for a Cypher string where `$org_id`
// appears ONLY inside a `//` comment (with a bound-but-unused `params.org_id`
// and no real filter predicate anywhere in the query) -- and demonstrated an
// actual end-to-end cross-tenant leak against real Neo4j from that shape.
// The check now requires `$org_id` to appear immediately adjacent to a
// property-match predicate (`org_id: $org_id` / `org_id = $org_id`), outside
// of a comment or string literal, not merely anywhere in the string.
//
// Second-round hardening (tester-found residual gap, escalated blocking by
// review, remediation-verification pass #2): comment-stripping alone was not
// enough -- a decoy Cypher **string literal** containing the text
// `org_id: $org_id` (e.g. `SET n.debugNote = "org_id: $org_id"`) satisfied
// the predicate regex with zero real filter. Fixed (at the time) by adding a
// second, independent string-literal-stripping regex pass ahead of the
// comment-stripping pass.
//
// Third-round hardening -- STRUCTURAL rewrite, not another regex
// (2026-07-23, review.md's explicit class-level recommendation): the
// second-round fix itself had a bug of the exact same *shape* as the first
// two -- `stripCypherStringLiterals` ran a DOUBLE-quote global `.replace()`
// pass, then an independent SINGLE-quote global `.replace()` pass, with no
// shared "which quote type is currently open" state. A single-quoted literal
// containing an embedded, unescaped double-quote character (ordinary,
// plausible content -- a quoted phrase inside a note) positioned BEFORE a
// genuine double-quoted decoy literal desynced the double-quote pass: it
// paired the embedded `"` with the decoy's OPENING `"` instead of the
// decoy's own closing `"`, leaving the decoy's payload completely unstripped
// (`SET n.a = 'y"z' SET n.debug = "org_id: $org_id" RETURN n` did not
// throw). Review's diagnosis, after three consecutive rounds of "fix one
// adversarial shape, the next pass finds a structurally-similar neighbor" in
// this exact function: composing independent regex/`.replace()` passes over
// a context-sensitive grammar (nested/alternating quote types, comments) is
// the wrong *category* of tool -- each pass is blind to what the other pass
// is doing, so they can desync in exactly the way two independently-running
// state machines over the same shared input always can. The fix is not a
// fourth regex, it is a single LEFT-TO-RIGHT LINEAR SCAN (`stripCypherNoise`
// below): one character-by-character state machine with exactly ONE active
// mode at any position -- "in a double-quoted string", "in a single-quoted
// string", "in a line comment", "in a block comment", or "code" -- so there
// is no second pass to desync against. Backslash-escaped quotes (`\"` inside
// `"..."`, `\'` inside `'...'`) are consumed as a pair and never end the
// string early, mirroring Cypher's actual escaping rules. This closes the
// bug *class* (not just the reproduced instance): a linear scan cannot
// misattribute a quote/comment boundary to the wrong lexical context the way
// two independently-scanning regexes can, because there is only ever one
// pass, one position, one mode.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ScanMode = 'code' | 'doubleString' | 'singleString' | 'lineComment' | 'blockComment';

/**
 * Single left-to-right linear scan over `cypher` that strips the CONTENTS of
 * single- and double-quoted string literals (leaving an empty literal of the
 * same quote type in place) AND strips `//` line comments and `/* *\/` block
 * comments (replacing each comment run with a single space) -- in one pass,
 * tracking exactly one active mode at a time.
 *
 * This replaces the prior two-independent-regex-pass design
 * (`stripCypherStringLiterals` then `stripCypherComments`), which could
 * desync when a string literal of one quote type contained an embedded,
 * unescaped quote character of the OTHER type positioned before a later
 * literal of that other type -- see the "Third-round hardening" comment
 * above for the exact reproduction. A single linear scan cannot desync
 * against itself: there is exactly one mode ("which lexical context is the
 * scanner in right now") at every position, so a quote or comment marker is
 * always interpreted in the context the scanner actually observed it in,
 * never mis-paired with an unrelated marker discovered by a separate pass.
 *
 * Escaping: a backslash inside either string mode consumes the following
 * character as part of the string (so `\"` inside a double-quoted literal,
 * or `\'` inside a single-quoted literal, does not end the string early),
 * matching Cypher's string-escaping rules.
 *
 * Unterminated strings/comments: if the scan reaches the end of input while
 * still inside a string or comment mode, everything from that point on was
 * consumed as string/comment content and is not restored to "code". This is
 * a deliberate fail-closed choice -- an unterminated string/comment is not
 * valid Cypher to begin with (it would be rejected by the Neo4j parser
 * itself), so treating trailing text as non-code and therefore unable to
 * satisfy the predicate check is the safe direction for a security guard.
 */
export function stripCypherNoise(cypher: string): string {
  let out = '';
  let mode: ScanMode = 'code';
  const n = cypher.length;
  let i = 0;

  while (i < n) {
    const c = cypher[i];
    const next = i + 1 < n ? cypher[i + 1] : '';

    switch (mode) {
      case 'code': {
        if (c === '"') {
          out += '"';
          mode = 'doubleString';
          i += 1;
        } else if (c === "'") {
          out += "'";
          mode = 'singleString';
          i += 1;
        } else if (c === '/' && next === '/') {
          mode = 'lineComment';
          i += 2;
        } else if (c === '/' && next === '*') {
          mode = 'blockComment';
          i += 2;
        } else {
          out += c;
          i += 1;
        }
        break;
      }
      case 'doubleString': {
        if (c === '\\') {
          i += 2; // consume the escaped character too; string stays open
        } else if (c === '"') {
          out += '"';
          mode = 'code';
          i += 1;
        } else {
          i += 1; // discard string content
        }
        break;
      }
      case 'singleString': {
        if (c === '\\') {
          i += 2;
        } else if (c === "'") {
          out += "'";
          mode = 'code';
          i += 1;
        } else {
          i += 1;
        }
        break;
      }
      case 'lineComment': {
        if (c === '\n') {
          // Emit a single space for the whole comment run, then let 'code'
          // mode process the newline itself on the next iteration (without
          // consuming it here) so line structure outside the comment is
          // preserved, matching the prior regex's `[^\n]*` (non-greedy up to
          // but not including the newline).
          out += ' ';
          mode = 'code';
        } else {
          i += 1;
        }
        break;
      }
      case 'blockComment': {
        if (c === '*' && next === '/') {
          out += ' ';
          mode = 'code';
          i += 2;
        } else {
          i += 1;
        }
        break;
      }
    }
  }

  // Reached end of input still "inside" a comment: emit the trailing space
  // for the unterminated comment run (mirrors the terminated case). An
  // unterminated string intentionally emits nothing further -- see the
  // "Unterminated strings/comments" doc above.
  if (mode === 'lineComment' || mode === 'blockComment') {
    out += ' ';
  }

  return out;
}

// Requires `org_id` to sit directly next to `$org_id` via `:` (property-match
// pattern, e.g. `{org_id: $org_id}`) or `=` (WHERE/SET predicate, e.g.
// `node.org_id = $org_id` / `SET link.org_id = $org_id`). A bare `$org_id`
// substring elsewhere (a comment, a RETURN projection, an unused bound
// parameter, or inside a string literal) does not match this and is treated
// as unscoped.
const ORG_ID_PREDICATE_RE = /\borg_id\s*[:=]\s*\$org_id\b/;

/**
 * Returns true only if `cypher` references `$org_id` as part of an actual
 * property-match / filter predicate, outside of any Cypher comment AND
 * outside of any Cypher string literal. This is the shared structural check
 * used by both `assertOrgScopedCypher` (runtime guard) and the static scan
 * (`cypherOrgIdScan.test.ts`), so both mechanisms agree on what "org-scoped"
 * means.
 */
export function referencesOrgIdPredicate(cypher: string): boolean {
  return ORG_ID_PREDICATE_RE.test(stripCypherNoise(cypher));
}

export class GraphOrgScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphOrgScopeError';
  }
}

/**
 * Fail-closed guard for the Neo4j path. Throws `GraphOrgScopeError` unless
 * ALL of the following hold:
 *   - `cypher` references `$org_id` as part of an actual property-match/
 *     filter predicate (`org_id: $org_id` or `x.org_id = $org_id`), outside
 *     of any `//` or `/* *\/` comment AND outside of any quoted string
 *     literal -- see `referencesOrgIdPredicate`, and
 *   - `params.org_id` is a UUID string, and
 *   - `params.org_id` STRICTLY EQUALS the server-resolved `orgId` (blocks a
 *     caller passing metrics orgId="A" but a query bound to org_id="B" --
 *     `ctx.orgId` is authoritative; a divergent `params.org_id` cannot win).
 *
 * Called as the first statement inside both `InstrumentedNeo4jWriteExecutor.run`
 * and `InstrumentedNeo4jReadExecutor.run`, before a session is opened.
 */
export function assertOrgScopedCypher(
  orgId: string,
  cypher: string,
  params: Readonly<Record<string, unknown>>,
): void {
  if (!UUID_RE.test(orgId)) {
    throw new GraphOrgScopeError(
      'assertOrgScopedCypher: orgId must be a server-resolved UUID.',
    );
  }
  if (!referencesOrgIdPredicate(cypher)) {
    throw new GraphOrgScopeError(
      'assertOrgScopedCypher: Cypher does not reference $org_id as part of an actual ' +
        'property-match/filter predicate (e.g. `org_id: $org_id` or `x.org_id = $org_id`) ' +
        'outside of a comment or string literal; refusing to execute an unscoped graph query.',
    );
  }
  const boundOrgId = params.org_id;
  if (typeof boundOrgId !== 'string' || !UUID_RE.test(boundOrgId)) {
    throw new GraphOrgScopeError(
      'assertOrgScopedCypher: params.org_id is missing or not a UUID; refusing to execute.',
    );
  }
  if (boundOrgId !== orgId) {
    throw new GraphOrgScopeError(
      'assertOrgScopedCypher: params.org_id does not match the server-resolved org id; refusing to execute.',
    );
  }
}
