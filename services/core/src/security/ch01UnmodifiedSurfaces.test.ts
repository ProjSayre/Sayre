// CH-01 red suite — AC-11 made mechanical.
//
// The whole reason CH-01 puts the ephemeral credential in `mcp_client_keys`
// with a `kind` discriminator is that the most security-sensitive surfaces in
// the service then need ZERO changes: `graph-query/permissions.ts` already
// implements "key ceiling INTERSECT issuer's live scope" for an `agent_key`
// subject, the gateway already resolves a bearer token through one code path,
// and every tool handler is already a thin pass-through of that context. If any
// of those files changes for this ticket, the design's central claim is no
// longer true and the change needs review on its own terms.
//
// Hashes are taken over LF-normalized content so a CRLF checkout on Windows and
// an LF checkout in CI agree. If a LATER ticket legitimately changes one of
// these files, update its digest here in that same commit — never silently.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HANDLERS_DIR = fileURLToPath(new URL('../mcp/handlers/', import.meta.url));

/** Repo-relative path -> SHA-256 of its LF-normalized content, as of CH-01's red stage. */
const UNMODIFIED: Record<string, string> = {
  'mcp/handlers/checkLiveness.ts':
    '1b50248f052ef7f126f01d51a50fe427b56a48fa8fd108d42d9c3db0407d8cf5',
  'mcp/handlers/findRelevantNodes.ts':
    '2eaf977b066c307571eb5eb8073b7e80354303edec2b870e1acf7513868f5124',
  'mcp/handlers/getAgentSkillMd.ts':
    '71f2d65d6910ecb85b739320a3768630392eb8e43005516caaed4cb5c6b0922f',
  'mcp/handlers/getCoveringTests.ts':
    '70a4674d7b77e60e03917f8446cc3195538f993ef3825b20d7a6b2c9e4f968da',
  'mcp/handlers/getFeatureCluster.ts':
    '42a86111fcfea3f6db17d78b63a84bfd88bbe45b3606bc011a90a993a341734a',
  'mcp/handlers/getNodeContext.ts':
    '7d502053d36d8893a35bc9eab3b8b84fe90a9ea5cf56c6f37db9ce523188010e',
  'mcp/handlers/getRecentChanges.ts':
    '63185041a58317e78600921bce0d030f18d0ccb2166d122fd2b769761fd77b57',
  'mcp/handlers/getStyleRules.ts':
    '7f195dd8d7c905065a653b5f9569331158912ec0ccfa51d2455a4c5fdc37a6a0',
  'mcp/handlers/traverseFrom.ts':
    '3f851e3cd146fb93e3f7f755b8b93fc3757b3ff3e56206639a438c300139d2f1',
  // Updated by CH-02, per this file's own header rule ("if a LATER ticket
  // legitimately changes one of these files, update its digest here in that
  // same commit — never silently"). CH-02 registers the `get_ready_tickets`
  // read-only tool in the gateway; CH-01 itself still left this file
  // byte-identical, which its own commit history remains the record of.
  'mcp/gateway.ts': '345714cbab7ae1ac94bbfdd2f2fcd23fb370ad35b29a820d8840c4e2dd72bf92',
  'graph-query/permissions.ts':
    '9214393292ab24cb90eaf26278b19ba9cadc626d43590d07b3f3c33d9a86ce69',
  'auth/context.ts': 'c4d3003a7b4861b233a4e9a4c50886b20e67a14bf25583c2bf48720ef9063163',
};

function digestOf(relativePath: string): string {
  const content = readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    'utf8',
  ).replace(/\r\n/g, '\n');
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

describe('CH-01 deliberately unmodified surfaces', () => {
  // @spec AC-11
  it('leaves every tool handler, the gateway, permissions, and the auth context byte-identical', () => {
    const actual = Object.fromEntries(
      Object.keys(UNMODIFIED).map((path) => [path, digestOf(path)]),
    );
    expect(actual).toEqual(UNMODIFIED);
  });

  // @spec AC-11
  //
  // `getReadyTickets.ts` was added by CH-02, not CH-01, and is listed here for
  // the same reason the gateway digest above was updated: this assertion pins
  // the handler surface so no handler is ever added silently, and a later
  // ticket that legitimately adds one records it here in that same commit.
  // CH-01's own claim — that it added no handler — is unchanged and remains
  // verifiable from its commit range.
  it('adds no new handler file to the read-only tool surface', () => {
    expect(
      readdirSync(HANDLERS_DIR)
        .filter((name) => name.endsWith('.ts'))
        .sort(),
    ).toEqual([
      'checkLiveness.ts',
      'findRelevantNodes.ts',
      'getAgentSkillMd.ts',
      'getCoveringTests.ts',
      'getFeatureCluster.ts',
      'getNodeContext.ts',
      'getReadyTickets.ts',
      'getRecentChanges.ts',
      'getStyleRules.ts',
      'traverseFrom.ts',
    ]);
  });
});
