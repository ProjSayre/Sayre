// W0-04 — the parts of the acceptance line that live in files rather than in behaviour:
// the CI zero-skip wiring for the new broker tests (AC-9, EC-12), the documented BullMQ
// lane contract (AC-10), the documented rollout caveat in bullmq.ts's header (EC-4), and
// the corrected acceptance citations on the three tests that currently describe
// themselves as W0-04's proof (AC-8).
//
// These are asserted as file content on purpose. A CI gate and a "this is the acceptance
// evidence" docstring are exactly the kind of thing that rots silently — GAP-4/4a exist
// because three test files have been citing docs/backlog.md's superseded reword as the
// acceptance criterion since W0-04 landed, and nothing failed when they did.
//
// Broker-free: reads files only.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

/** Every `- name:` step in the workflow, as raw text. */
function workflowSteps(workflow: string): string[] {
  return workflow.split(/\n {6}- name: /).slice(1);
}

describe('W0-04 acceptance wiring', () => {
  // @spec AC-9 EC-12
  it('AC-9/EC-12: CI runs the BullMQ priority test in the Redis-required (zero broker skips) step', () => {
    const workflow = read('.github/workflows/ci.yml');
    const steps = workflowSteps(workflow);

    const redisStep = steps.find((step) => step.startsWith('core messaging — Redis required'));
    expect(redisStep, 'the existing Redis-required step must still exist').toBeDefined();
    expect(redisStep).toContain("MESSAGING_INTEGRATION_REQUIRED: 'true'");
    expect(redisStep).toContain('src/queue/__tests__/bullmq.roundtrip.test.ts');
    expect(redisStep).toContain('src/queue/__tests__/bullmq.priority.test.ts');

    // EC-12: the test file itself must hard-fail rather than skip under required mode,
    // or the CI step above would pass on a run that measured nothing.
    const prioritySource = read('services/core/src/queue/__tests__/bullmq.priority.test.ts');
    expect(prioritySource).toContain('MESSAGING_INTEGRATION_REQUIRED');
    expect(prioritySource).toMatch(/throw new Error\(\s*`\[bullmq\.priority\] Redis is required/);
  });

  // @spec AC-9 EC-12
  it('AC-9/EC-12: CI runs the cross-runtime round-trip under a junit `skipped == 0` gate', () => {
    const workflow = read('.github/workflows/ci.yml');
    const steps = workflowSteps(workflow);

    const crossRuntimeStep = steps.find((step) =>
      step.includes('tests/test_cross_runtime_roundtrip.py'),
    );
    expect(
      crossRuntimeStep,
      'the workers job must run tests/test_cross_runtime_roundtrip.py in its own step',
    ).toBeDefined();
    expect(crossRuntimeStep).toContain("MESSAGING_INTEGRATION_REQUIRED: 'true'");

    const junitMatch = /--junitxml=([\w./-]+\.xml)/.exec(crossRuntimeStep!);
    expect(junitMatch, 'the cross-runtime step must emit a junit report to gate on').not.toBeNull();

    const junitFile = junitMatch![1];
    const gateStep = steps.find(
      (step) => step.includes(junitFile) && step.includes('skipped == 0'),
    );
    expect(
      gateStep,
      `a step must assert skipped == 0 against ${junitFile}, matching the existing messaging and graph-migration gates`,
    ).toBeDefined();

    // EC-12 again, Python side: a missing broker is a collection-time error, not a skip.
    const crossRuntimeSource = read('services/workers/tests/test_cross_runtime_roundtrip.py');
    expect(crossRuntimeSource).toContain('MESSAGING_INTEGRATION_REQUIRED');
    expect(crossRuntimeSource).toContain('raise RuntimeError');
  });

  // @spec AC-10
  it('AC-10: the BullMQ lane contract is recorded alongside the SQS enrichment-lane paragraph', () => {
    const contracts = read('docs/wave0-foundation-contracts.md');
    const paragraphs = contracts.split(/\n\s*\n/);

    const laneParagraph = paragraphs.find(
      (paragraph) => /BullMQ/.test(paragraph) && /lane/i.test(paragraph),
    );
    expect(
      laneParagraph,
      'wave0-foundation-contracts.md documents only the SQS priority lanes today',
    ).toBeDefined();

    expect(laneParagraph).toMatch(/priority/i);
    expect(laneParagraph).toMatch(/default/i);
    // Both lanes are deliberately non-zero; that is the whole contract.
    expect(laneParagraph).toMatch(/non-?zero/i);
    // No job type is assigned to the priority lane by policy yet.
    expect(laneParagraph).toMatch(/policy/i);

    // Still recorded next to the SQS enrichment lanes it mirrors.
    expect(contracts).toContain('enrichment-onboarding-priority');
  });

  // @spec EC-4
  it("EC-4: bullmq.ts's header documents the lane split and the pre-change `wait` backlog caveat", () => {
    const source = read('services/core/src/queue/bullmq.ts');
    const header = source.slice(0, source.indexOf('\nimport '));

    expect(header).toMatch(/lane/i);
    expect(header).toMatch(/non-?zero/i);
    expect(header).toMatch(/\bwait\b/);
    expect(header).toMatch(/prioritized/i);
    // The one window in which AC-4's guarantee does not hold: jobs already sitting in
    // `wait` from a pre-change deploy still drain first. Documented, not fixed.
    expect(header).toMatch(/rollout|already|in-flight|pre-change|existing jobs/i);
  });

  // @spec AC-8
  it('AC-8: the three superseded-citation tests now cite the canonical ticket and the cross-runtime test', () => {
    const files = [
      'services/core/src/queue/__tests__/initialParse.fixture.test.ts',
      'services/workers/tests/test_initial_parse_wire_fixture.py',
      'services/workers/tests/test_sqs_roundtrip.py',
    ];

    for (const relativePath of files) {
      const source = read(relativePath);
      expect(source, `${relativePath} must cite the canonical ticket text`).toContain(
        'docs/product/Ticket-Backlog-by-Feature-2.md',
      );
      expect(source, `${relativePath} must name the ticket it belongs to`).toContain('W0-04');
      expect(source, `${relativePath} must name docs/backlog.md as the superseded reword`).toContain(
        'docs/backlog.md',
      );
      expect(source, `${relativePath} must say docs/backlog.md is superseded`).toMatch(/supersed/i);
      expect(
        source,
        `${relativePath} must point at the new cross-language evidence`,
      ).toContain('test_cross_runtime_roundtrip');
    }

    // The exact self-descriptions on disk today that claim W0-04's acceptance criterion.
    expect(read('services/workers/tests/test_sqs_roundtrip.py')).not.toContain(
      'Acceptance criterion 1',
    );
    const fixtureTest = read('services/core/src/queue/__tests__/initialParse.fixture.test.ts');
    expect(fixtureTest).not.toContain('in the acceptance criteria means');
    // Re-labelled as what it is: a wire-shape regression test, not the cross-language proof.
    expect(fixtureTest).toMatch(/regression/i);
  });
});
