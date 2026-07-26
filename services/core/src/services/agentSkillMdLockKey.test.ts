import { describe, expect, it } from 'vitest';
import type { AgentSkillMdNodeScope } from '../db/agentSkillMdStore';
import { agentSkillMdLockKey } from '../db/agentSkillMdStore';

const scope: AgentSkillMdNodeScope = {
  orgId: '00000000-0000-4000-8000-000000000001',
  repositoryId: '11111111-1111-4111-8111-111111111111',
  refName: 'refs/heads/main',
  nodeId: 'file-node',
  nodePath: 'src/file.ts',
  nodeLabel: 'File',
  revisionSha: 'a'.repeat(40),
};

describe('Agent/Skill MD advisory lock key', () => {
  it('is valid PostgreSQL text and preserves every lock boundary', () => {
    const key = agentSkillMdLockKey(scope);

    expect(key).not.toContain('\0');
    expect(JSON.parse(key)).toEqual([
      scope.orgId,
      scope.repositoryId,
      scope.refName,
      scope.nodeId,
    ]);
  });

  it('does not collapse adjacent field values into the same key', () => {
    const left = agentSkillMdLockKey({
      ...scope,
      refName: 'refs/heads/a',
      nodeId: 'bc',
    });
    const right = agentSkillMdLockKey({
      ...scope,
      refName: 'refs/heads/ab',
      nodeId: 'c',
    });

    expect(left).not.toBe(right);
  });
});
