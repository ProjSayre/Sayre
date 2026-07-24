import { describe, expect, it } from 'vitest';
import { GraphOrgScopeError, assertOrgScopedCypher, referencesOrgIdPredicate } from './graphOrgGuard';

const ORG_A = 'aaaaaaaa-1111-1111-1111-111111111111';
const ORG_B = 'bbbbbbbb-2222-2222-2222-222222222222';
const SCOPED_CYPHER = 'MATCH (n {org_id: $org_id, uid: $uid}) RETURN n';

describe('assertOrgScopedCypher', () => {
  it('does not throw when the Cypher references $org_id and params.org_id strictly equals orgId', () => {
    expect(() =>
      assertOrgScopedCypher(ORG_A, SCOPED_CYPHER, { org_id: ORG_A, uid: 'x' }),
    ).not.toThrow();
  });

  it('throws GraphOrgScopeError when the Cypher omits $org_id entirely', () => {
    expect(() =>
      assertOrgScopedCypher(ORG_A, 'MATCH (n {uid: $uid}) RETURN n', {
        org_id: ORG_A,
        uid: 'x',
      }),
    ).toThrow(GraphOrgScopeError);
  });

  it('throws when params.org_id is absent', () => {
    expect(() => assertOrgScopedCypher(ORG_A, SCOPED_CYPHER, { uid: 'x' })).toThrow(
      GraphOrgScopeError,
    );
  });

  it('throws when params.org_id is undefined', () => {
    expect(() =>
      assertOrgScopedCypher(ORG_A, SCOPED_CYPHER, { org_id: undefined, uid: 'x' }),
    ).toThrow(GraphOrgScopeError);
  });

  it('throws when params.org_id is not a UUID', () => {
    expect(() =>
      assertOrgScopedCypher(ORG_A, SCOPED_CYPHER, { org_id: 'not-a-uuid' }),
    ).toThrow(GraphOrgScopeError);
  });

  it('throws when params.org_id is a non-string type', () => {
    expect(() =>
      assertOrgScopedCypher(ORG_A, SCOPED_CYPHER, { org_id: 12345 as unknown as string }),
    ).toThrow(GraphOrgScopeError);
  });

  it('throws when params.org_id diverges from the server-resolved orgId (forged/mismatched bound org)', () => {
    expect(() =>
      assertOrgScopedCypher(ORG_A, SCOPED_CYPHER, { org_id: ORG_B }),
    ).toThrow(GraphOrgScopeError);
  });

  it('rejects a non-UUID server-resolved orgId (defensive: never reached in practice since requireOrgId/ctx.orgId are already UUIDs)', () => {
    expect(() => assertOrgScopedCypher('not-a-uuid', SCOPED_CYPHER, { org_id: ORG_A })).toThrow(
      GraphOrgScopeError,
    );
  });

  it('is case-insensitive for UUID matching but requires strict string equality between orgId and params.org_id', () => {
    // Different casing of the SAME uuid must not silently pass as "equal" if
    // the raw strings differ -- strict equality, not a case-insensitive compare.
    expect(() =>
      assertOrgScopedCypher(ORG_A, SCOPED_CYPHER, { org_id: ORG_A.toUpperCase() }),
    ).toThrow(GraphOrgScopeError);
  });

  it('does not auto-inject or rewrite -- passing a well-formed but unbound query still throws (assert-only, Resolved decision Q5)', () => {
    // Cypher references $org_id textually but the caller never bound it.
    expect(() => assertOrgScopedCypher(ORG_A, SCOPED_CYPHER, {})).toThrow(GraphOrgScopeError);
  });

  it('passes for a realistic multi-clause write Cypher shape (graphOwnershipStore-style)', () => {
    const cypher = `
      MERGE (file:File {org_id: $org_id, uid: $file_uid})
      MERGE (person:Person {org_id: $org_id, uid: $person_uid})
      MERGE (person)-[owns:OWNS {org_id: $org_id}]->(file)
    `;
    expect(() =>
      assertOrgScopedCypher(ORG_A, cypher, {
        org_id: ORG_A,
        file_uid: 'f1',
        person_uid: 'p1',
      }),
    ).not.toThrow();
  });

  it('passes for a realistic read Cypher shape (RbacGraphQueryService-style, extra scope params present)', () => {
    const cypher = `
      MATCH (node)
      WHERE node.org_id = $org_id AND node.repo_id = $repo_id
      RETURN node
    `;
    expect(() =>
      assertOrgScopedCypher(ORG_A, cypher, {
        org_id: ORG_A,
        repo_id: 'repo-1',
        allow_rules: [],
        deny_rules: [],
      }),
    ).not.toThrow();
  });

  it('passes for a SET-clause predicate shape (graphTicketStore/graphOwnershipStore-style: `SET link.org_id = $org_id`)', () => {
    const cypher = `
      MATCH (ticket:Ticket {org_id: $org_id, uid: $ticket_uid})
      MATCH (target {org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name})
      MERGE (ticket)-[link:REFERENCES]->(target)
      SET link.org_id = $org_id
    `;
    expect(() =>
      assertOrgScopedCypher(ORG_A, cypher, {
        org_id: ORG_A,
        ticket_uid: 't1',
        repo_id: 'repo-1',
        ref_name: 'main',
      }),
    ).not.toThrow();
  });

  // --- Regression tests for FND-5da52fce61f4 (2026-07-23 adversarial audit) ---
  // The original guard did a raw `cypher.includes('$org_id')` substring test.
  // These prove the class of bypass the audit demonstrated -- a comment-only
  // or non-predicate reference to `$org_id`, with a bound-but-unused
  // `params.org_id` and no real filter anywhere in the query -- is now
  // rejected, and that the audit's exact reproduction string throws.

  it('[FND-5da52fce61f4] throws on the audit-reproduction string: $org_id mentioned ONLY in a // comment, no real filter, bound-but-unused org_id param', () => {
    const cypher = `
      // TODO: this should filter by $org_id but the WHERE clause was never added
      MATCH (n:File)
      RETURN n
    `;
    expect(() => assertOrgScopedCypher(ORG_A, cypher, { org_id: ORG_A })).toThrow(
      GraphOrgScopeError,
    );
  });

  it('[FND-5da52fce61f4] throws when $org_id is mentioned only inside a /* */ block comment', () => {
    const cypher = `
      /* filter by $org_id here eventually */
      MATCH (n:File)
      RETURN n
    `;
    expect(() => assertOrgScopedCypher(ORG_A, cypher, { org_id: ORG_A })).toThrow(
      GraphOrgScopeError,
    );
  });

  it('[FND-5da52fce61f4] throws when $org_id is bound and mentioned in the query text but never used as a filter/property predicate (e.g. only in a RETURN projection)', () => {
    const cypher = `MATCH (n:File {uid: $uid}) RETURN n, $org_id AS debugOrgId`;
    expect(() =>
      assertOrgScopedCypher(ORG_A, cypher, { org_id: ORG_A, uid: 'x' }),
    ).toThrow(GraphOrgScopeError);
  });

  it('[FND-5da52fce61f4] a multi-line comment followed by a genuine predicate on the next line still passes (comment-stripping does not eat real code)', () => {
    const cypher = `
      // returns files for the given org
      MATCH (n:File {org_id: $org_id, uid: $uid})
      RETURN n
    `;
    expect(() =>
      assertOrgScopedCypher(ORG_A, cypher, { org_id: ORG_A, uid: 'x' }),
    ).not.toThrow();
  });

  // --- Regression tests for the tester-found residual gap (escalated to
  // blocking by review, remediation-verification pass #2, 2026-07-23) ---
  // `referencesOrgIdPredicate` previously stripped Cypher COMMENTS but did
  // NOT strip Cypher STRING LITERALS before applying the predicate regex. A
  // Cypher string containing the literal text `org_id: $org_id` /
  // `org_id = $org_id` *inside a quoted string value* (e.g. a decoy debug
  // property, unrelated to any real filter/property-match predicate) used to
  // satisfy the check, because the regex had no way to distinguish "this text
  // is inside a WHERE/property-match clause" from "this text is inside a
  // string literal payload". Same bug class as FND-5da52fce61f4
  // (textual-presence check standing in for structural-predicate proof),
  // recurring via a different textual carrier. Fixed by
  // `stripCypherStringLiterals`, applied before `stripCypherComments`. These
  // decoy shapes must now throw.
  it('[Gap 1, was TESTER-FOUND residual] throws for a decoy double-quoted string literal containing "org_id: $org_id" text with no real predicate (string-literal-stripping fix)', () => {
    const cypher = `MATCH (n:File) SET n.debugNote = "org_id: $org_id" RETURN n`;
    expect(() => assertOrgScopedCypher(ORG_A, cypher, { org_id: ORG_A })).toThrow(
      GraphOrgScopeError,
    );
  });

  it('[Gap 1, was TESTER-FOUND residual] throws for a decoy single-quoted string literal containing "org_id = $org_id" text with no real predicate (string-literal-stripping fix)', () => {
    const cypher = `MATCH (n:File) SET n.debugNote = 'the org_id = $org_id filter was removed' RETURN n`;
    expect(() => assertOrgScopedCypher(ORG_A, cypher, { org_id: ORG_A })).toThrow(
      GraphOrgScopeError,
    );
  });

  it('[Gap 1] does not over-strict: a query with a REAL predicate plus an unrelated string literal containing a colon/equals sign still passes (string-content stripping must not eat a real predicate, which lives outside any string literal)', () => {
    const cypher = `
      MATCH (n:File {org_id: $org_id, uid: $uid})
      SET n.debugNote = "unrelated note: status = pending"
      RETURN n
    `;
    expect(() =>
      assertOrgScopedCypher(ORG_A, cypher, { org_id: ORG_A, uid: 'x' }),
    ).not.toThrow();
  });

  it('[Gap 1] does not over-strict: a single-quoted unrelated string literal containing a colon/equals sign alongside a real predicate still passes', () => {
    const cypher = `
      MATCH (n:File {org_id: $org_id, uid: $uid})
      SET n.debugNote = 'unrelated note: status = pending'
      RETURN n
    `;
    expect(() =>
      assertOrgScopedCypher(ORG_A, cypher, { org_id: ORG_A, uid: 'x' }),
    ).not.toThrow();
  });

  it('[FND-5da52fce61f4] regression: all previously-passing legitimate cases (write, read, SET-clause) still pass after the comment-stripping/structural-predicate fix', () => {
    const writeCypher = `
      MERGE (file:File {org_id: $org_id, uid: $file_uid})
      MERGE (person:Person {org_id: $org_id, uid: $person_uid})
      MERGE (person)-[owns:OWNS {org_id: $org_id}]->(file)
    `;
    const readCypher = `
      MATCH (node)
      WHERE node.org_id = $org_id AND node.repo_id = $repo_id
      RETURN node
    `;
    expect(() =>
      assertOrgScopedCypher(ORG_A, writeCypher, {
        org_id: ORG_A,
        file_uid: 'f1',
        person_uid: 'p1',
      }),
    ).not.toThrow();
    expect(() =>
      assertOrgScopedCypher(ORG_A, readCypher, { org_id: ORG_A, repo_id: 'repo-1' }),
    ).not.toThrow();
  });

  // --- Gap 3 (found during the second remediation-verification pass,
  // FIXED this pass via the structural rewrite -- 2026-07-23) ---
  //
  // The prior fix (`stripCypherStringLiterals`) ran a DOUBLE-quote pass, then
  // a SINGLE-quote pass, each an independent global regex with no awareness
  // of which quote type was "currently open." A single-quoted literal
  // containing an UNESCAPED embedded double-quote character (e.g. `'y"z'`,
  // ordinary, plausible real content -- a quoted phrase inside a note)
  // positioned BEFORE a genuine double-quoted decoy literal desynced the
  // double-quote pass: it paired the embedded `"` with the decoy's OPENING
  // `"` instead of its own closing `"`, leaving the decoy's payload text
  // completely unstripped. Same bug class as Gap 1 / FND-5da52fce61f4
  // (textual-presence check standing in for structural proof), recurring via
  // quote-type desync between two independent passes.
  //
  // Fixed by replacing the two-regex-pass design with `stripCypherNoise`, a
  // single left-to-right linear scan (state machine) that tracks exactly one
  // active lexical mode at a time -- there is no second pass to desync
  // against. See graphOrgGuard.ts's "Third-round hardening" comment for the
  // full rationale (this is a class-level fix, not a fifth special case).
  it('[Gap 3, FIXED] a single-quoted literal containing an embedded unescaped double-quote, placed BEFORE a double-quoted decoy, no longer desyncs the stripper -- the decoy is correctly stripped and the guard throws', () => {
    const cypher = `SET n.a = 'y"z' SET n.debug = "org_id: $org_id" RETURN n`;
    expect(() => assertOrgScopedCypher(ORG_A, cypher, { org_id: ORG_A })).toThrow(
      GraphOrgScopeError,
    );
    expect(referencesOrgIdPredicate(cypher)).toBe(false);
  });

  it('[Gap 3] sanity: without the earlier cross-quote-type string, the identical decoy is still correctly rejected (isolates the fix as addressing the desync, not accidentally changing the decoy-detection logic itself)', () => {
    const cypherWithoutDesyncTrigger = `SET n.debug = "org_id: $org_id" RETURN n`;
    expect(() =>
      assertOrgScopedCypher(ORG_A, cypherWithoutDesyncTrigger, { org_id: ORG_A }),
    ).toThrow(GraphOrgScopeError);
  });

  it('[Gap 3, fix-list item 1] not-over-strict: a genuine predicate positioned AFTER a cross-quote-type string literal still passes (the exact ordering review\'s fix list asked for a companion test on)', () => {
    const cypher = `SET n.a = 'y"z' MATCH (n:File {org_id: $org_id, uid: $uid}) RETURN n`;
    expect(() =>
      assertOrgScopedCypher(ORG_A, cypher, { org_id: ORG_A, uid: 'x' }),
    ).not.toThrow();
  });

  // --- Additional adversarial fixtures (dev-authored, this pass) closing out
  // the quote/comment/whitespace combinations not already exercised above,
  // per review's request to build confidence the CLASS is closed, not just
  // the reproduced instance. ---

  it('[Gap 3, adversarial] the reverse quote-type pairing (double-quoted literal with an embedded unescaped single-quote, BEFORE a single-quoted decoy) is also correctly rejected', () => {
    const cypher = `SET n.a = "y'z" SET n.debug = 'org_id: $org_id' RETURN n`;
    expect(() => assertOrgScopedCypher(ORG_A, cypher, { org_id: ORG_A })).toThrow(
      GraphOrgScopeError,
    );
  });

  it('[Gap 3, adversarial] a backslash-escaped quote inside a string does not end the string early, so a decoy predicate hidden inside an escaped-quote string is still stripped', () => {
    const cypher = `SET n.a = "she said \\"org_id: $org_id\\" loudly" RETURN n`;
    expect(() => assertOrgScopedCypher(ORG_A, cypher, { org_id: ORG_A })).toThrow(
      GraphOrgScopeError,
    );
  });

  it('[Gap 3, adversarial] not-over-strict: an escaped-quote string containing decoy text does not eat a REAL predicate that appears after it', () => {
    const cypher = `SET n.a = "she said \\"org_id: $org_id\\" loudly" MATCH (n:File {org_id: $org_id, uid: $uid}) RETURN n`;
    expect(() =>
      assertOrgScopedCypher(ORG_A, cypher, { org_id: ORG_A, uid: 'x' }),
    ).not.toThrow();
  });

  it('[Gap 3, adversarial] a quote character embedded inside a // line comment does not get mistaken for a string boundary that swallows the real predicate following it', () => {
    const cypher = `// this comment contains a "quote and 'another one\n      MATCH (n:File {org_id: $org_id, uid: $x}) RETURN n`;
    expect(() =>
      assertOrgScopedCypher(ORG_A, cypher, { org_id: ORG_A, x: 'x' }),
    ).not.toThrow();
  });

  it('[Gap 3, adversarial] an unmatched quote character inside a /* */ block comment does not get mistaken for a string boundary that swallows the real predicate following it', () => {
    const cypher = `/* an unmatched " quote */ MATCH (n:File {org_id: $org_id, uid: $x}) RETURN n`;
    expect(() =>
      assertOrgScopedCypher(ORG_A, cypher, { org_id: ORG_A, x: 'x' }),
    ).not.toThrow();
  });

  it('[Gap 3, adversarial] a string literal containing text that LOOKS like a block comment ("/* ... */") is not misread as an actual comment boundary -- the decoy predicate inside it is still stripped as string content', () => {
    const cypher = `SET n.a = "/* not a comment */ org_id: $org_id" RETURN n`;
    expect(() => assertOrgScopedCypher(ORG_A, cypher, { org_id: ORG_A })).toThrow(
      GraphOrgScopeError,
    );
  });

  it('[Gap 3, adversarial] a line comment with no trailing newline (comment runs to end of input) is still fully stripped, not left dangling', () => {
    const cypher = `MATCH (n:File) RETURN n // trailing comment mentions org_id: $org_id`;
    expect(() => assertOrgScopedCypher(ORG_A, cypher, { org_id: ORG_A })).toThrow(
      GraphOrgScopeError,
    );
  });

  it('[Gap 3, adversarial] regression: all previously-passing legitimate write/read/SET-clause shapes still pass through the new single-pass stripper', () => {
    const writeCypher = `
      MERGE (file:File {org_id: $org_id, uid: $file_uid})
      MERGE (person:Person {org_id: $org_id, uid: $person_uid})
      MERGE (person)-[owns:OWNS {org_id: $org_id}]->(file)
    `;
    const readCypher = `
      MATCH (node)
      WHERE node.org_id = $org_id AND node.repo_id = $repo_id
      RETURN node
    `;
    const setCypher = `
      MATCH (ticket:Ticket {org_id: $org_id, uid: $ticket_uid})
      MATCH (target {org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name})
      MERGE (ticket)-[link:REFERENCES]->(target)
      SET link.org_id = $org_id
    `;
    expect(() =>
      assertOrgScopedCypher(ORG_A, writeCypher, {
        org_id: ORG_A,
        file_uid: 'f1',
        person_uid: 'p1',
      }),
    ).not.toThrow();
    expect(() =>
      assertOrgScopedCypher(ORG_A, readCypher, { org_id: ORG_A, repo_id: 'repo-1' }),
    ).not.toThrow();
    expect(() =>
      assertOrgScopedCypher(ORG_A, setCypher, {
        org_id: ORG_A,
        ticket_uid: 't1',
        repo_id: 'repo-1',
        ref_name: 'main',
      }),
    ).not.toThrow();
  });

  // --- Gap 7 (found during the THIRD remediation-verification pass, 2026-07-23,
  // adversarially probing the new stripCypherNoise/ORG_ID_PREDICATE_RE combo).
  // NOT fixed this pass -- per the "document, don't silently fix" convention
  // tester has followed every prior round (Gap 1/Gap 2a/Gap 2b/Gap 3/Gap 4/
  // Gap 5/Gap 6), this documents the CURRENT (vulnerable) behavior so the
  // suite stays green while making the gap visible to review/dev.
  //
  // This is a DIFFERENT root cause than Gap 1 and Gap 3, and arguably more
  // severe: Gap 1/Gap 3 both required the attacker/author to plant the decoy
  // text INSIDE a string literal or exploit a lexical (quote/comment)
  // scanning bug -- `stripCypherNoise` genuinely, correctly strips those.
  // This gap needs no string-literal trick and no lexical desync at all: a
  // `{org_id: $org_id}` map literal that is LEXICALLY IDENTICAL whether it
  // sits inside a MATCH/MERGE node pattern (a real filter) or inside a
  // RETURN/WITH/UNWIND projection (pure decoy data, filtering nothing) is
  // genuine "code" mode to the state machine -- there is no noise to strip.
  // `ORG_ID_PREDICATE_RE` (`\borg_id\s*[:=]\s*\$org_id\b`) has no concept of
  // Cypher CLAUSE structure: it cannot distinguish "this org_id:$org_id text
  // sits inside a pattern/WHERE/SET that actually constrains the query's
  // result set" from "this org_id:$org_id text sits inside an unrelated
  // RETURN/WITH/UNWIND expression that is computed but never used to filter
  // anything." Closing this class structurally would require actually
  // parsing Cypher clause structure (a real openCypher parser), not just a
  // lexical scan -- a materially bigger lift than the Gap 3 fix, which is why
  // this is being surfaced rather than attempted inline by tester.
  //
  // Practical severity: no unusual authoring is required -- an author (or
  // attacker) who writes a query with NO real org filter can make it pass
  // BOTH the runtime guard and the static scan by appending a syntactically
  // trivial, semantically inert `, {org_id: $org_id} AS _debug` (or an
  // UNWIND/WITH equivalent) to an existing RETURN clause. This is the same
  // "textual presence standing in for structural proof" bug class as
  // FND-5da52fce61f4, Gap 1, and Gap 3 -- recurring a fourth time, this time
  // without needing a string literal or a lexical edge case at all.
  describe('[TESTER-FOUND, Gap 7, NOT fixed, round 3] decoy {org_id: $org_id} map literal in a RETURN/WITH/UNWIND projection defeats the guard with zero real filtering effect', () => {
    it('a MATCH with NO org filter on the returned node, plus a decoy {org_id: $org_id} map in the RETURN clause, is NOT rejected (documents the gap)', () => {
      const cypher = `MATCH (n:File {uid: $uid}) RETURN n, {org_id: $org_id} AS debugMap`;
      expect(
        referencesOrgIdPredicate(cypher),
        'expected the current predicate check to be satisfied by the decoy map literal (documenting the gap)',
      ).toBe(true);
      expect(
        () => assertOrgScopedCypher(ORG_A, cypher, { org_id: ORG_A, uid: 'x' }),
        'expected the current guard to NOT throw, despite `n` (the actual returned entity) never being filtered by org_id anywhere in this query',
      ).not.toThrow();
    });

    it('the same decoy shape via WITH (unused binding) also defeats the guard', () => {
      const cypher = `MATCH (n:File {uid: $uid}) WITH n, {org_id: $org_id} AS junk RETURN n`;
      expect(referencesOrgIdPredicate(cypher)).toBe(true);
      expect(() =>
        assertOrgScopedCypher(ORG_A, cypher, { org_id: ORG_A, uid: 'x' }),
      ).not.toThrow();
    });

    it('the same decoy shape via UNWIND (a single-element decoy list, never joined to the MATCH pattern) also defeats the guard', () => {
      const cypher = `MATCH (n:File {uid: $uid}) UNWIND [{org_id: $org_id}] AS ignored RETURN n`;
      expect(referencesOrgIdPredicate(cypher)).toBe(true);
      expect(() =>
        assertOrgScopedCypher(ORG_A, cypher, { org_id: ORG_A, uid: 'x' }),
      ).not.toThrow();
    });

    it('sanity: confirms this is a genuinely different root cause than Gap 3 -- the decoy here sits in plain "code" mode (no string literal, no comment, no quote-type desync involved at all)', () => {
      const cypher = `MATCH (n:File {uid: $uid}) RETURN n, {org_id: $org_id} AS debugMap`;
      // No quote character and no comment marker appears anywhere in this
      // fixture, so stripCypherNoise's string/comment-stripping logic (the
      // mechanism Gap 1 and Gap 3 hardened) is not exercised or implicated at
      // all -- the text reaches ORG_ID_PREDICATE_RE completely unmodified.
      expect(cypher.includes('"') || cypher.includes("'") || cypher.includes('//') || cypher.includes('/*')).toBe(
        false,
      );
      expect(referencesOrgIdPredicate(cypher)).toBe(true);
    });
  });
});
