// W3-04 gapfill (GAP-1, AC-3). CI wiring lives in a file, not behavior — asserted as
// file content on purpose, mirroring the existing W0-04 acceptance-wiring pattern
// (services/core/src/queue/__tests__/w0-04.acceptance-wiring.test.ts) and the `workers`
// job's own Neo4j service + zero-skip gate (.github/workflows/ci.yml:346-355, :491-498).
//
// spec.md's Approach step 11 requires:
//   - a `neo4j: image: neo4j:5.24-community` service on the `node` job
//   - a step running the graph-backed git-sync tests with GRAPH_INTEGRATION_REQUIRED:
//     'true' and a junit reporter
//   - a follow-up "zero skips" assertion step gating on that junit output
//
// Broker-free: reads .github/workflows/ci.yml as text only.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..', '..');

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

function nodeJobBlock(workflow: string): string {
  // The `node` job runs first; slice from its `node:` heading to the next top-level
  // job heading (`  workers:`), mirroring how other CI-wiring tests in this repo
  // isolate a single job's YAML rather than parsing the whole file as YAML.
  const start = workflow.indexOf('\n  node:\n');
  const end = workflow.indexOf('\n  workers:\n');
  expect(start, 'the `node` job must exist in ci.yml').toBeGreaterThan(-1);
  expect(end, 'the `workers` job must exist in ci.yml').toBeGreaterThan(-1);
  return workflow.slice(start, end);
}

function workflowSteps(block: string): string[] {
  return block.split(/\n {6}- name: /).slice(1);
}

describe('W3-04 CI wiring (GAP-1, AC-3)', () => {
  // @spec AC-3
  it('the `node` job gains a `neo4j` service, alongside its existing `redis`/`postgres` services', () => {
    const workflow = read('.github/workflows/ci.yml');
    const nodeJob = nodeJobBlock(workflow);
    expect(nodeJob).toMatch(/\n {6}neo4j:\n/);
    expect(nodeJob).toMatch(/image:\s*neo4j:5\.24-community/);
  });

  // @spec AC-3
  it('a dedicated step runs the graph-backed git-sync tests with GRAPH_INTEGRATION_REQUIRED: \'true\' and a junit reporter', () => {
    const workflow = read('.github/workflows/ci.yml');
    const nodeJob = nodeJobBlock(workflow);
    const steps = workflowSteps(nodeJob);

    const graphStep = steps.find(
      (step) =>
        step.includes('ownershipGraph.integration.test.ts') ||
        step.includes('w3-04.acceptance.integration.test.ts'),
    );
    expect(
      graphStep,
      'a step must run the git-sync graph-integration test files',
    ).toBeDefined();
    expect(graphStep).toContain("GRAPH_INTEGRATION_REQUIRED: 'true'");
    expect(graphStep).toMatch(/--reporter[= ]junit/);
  });

  // @spec AC-3
  it('a zero-skip assertion step gates on the graph-integration step\'s junit output', () => {
    const workflow = read('.github/workflows/ci.yml');
    const nodeJob = nodeJobBlock(workflow);
    const steps = workflowSteps(nodeJob);

    const graphStep = steps.find(
      (step) =>
        step.includes('ownershipGraph.integration.test.ts') ||
        step.includes('w3-04.acceptance.integration.test.ts'),
    );
    expect(graphStep).toBeDefined();

    const junitMatch = /--(?:outputFile|reporter-options)[= ]?[^\s]*junit[^\s]*/.exec(graphStep ?? '');
    // Looser fallback: any *.xml path mentioned in the step is the junit report target.
    const xmlMatch = /([\w./-]+\.xml)/.exec(graphStep ?? '');
    expect(junitMatch ?? xmlMatch, 'the graph-integration step must emit a junit report to gate on').not
      .toBeNull();

    const gateStep = steps.find(
      (step) => step.toLowerCase().includes('no git-sync graph tests skipped') || (
        step.includes('skipped == 0') &&
        xmlMatch !== null &&
        step.includes(xmlMatch[1])
      ),
    );
    expect(
      gateStep,
      'a step must assert skipped == 0 for the git-sync graph-integration junit report',
    ).toBeDefined();
  });
});
