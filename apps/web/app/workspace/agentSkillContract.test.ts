import { describe, expect, it } from 'vitest';
import {
  AGENT_SKILL_MAX_CHARACTERS,
  agentSkillDraftIssues,
  starterAgentSkillContent,
} from './agentSkillContract';

describe('Agent/Skill editor contract', () => {
  it('creates a saveable node-specific starter document', () => {
    const content = starterAgentSkillContent('README.md');

    expect(content).toContain('# README.md');
    expect(agentSkillDraftIssues(content)).toEqual([]);
  });

  it.each([
    [
      'missing section',
      '## Allowed Tools\nRead\n\n## Required Context\nRules',
    ],
    [
      'wrong order',
      '## Required Context\nRules\n\n## Allowed Tools\nRead\n\n## Guardrails\nSafe',
    ],
    [
      'extra section',
      '## Allowed Tools\nRead\n\n## Required Context\nRules\n\n## Guardrails\nSafe\n\n## Notes\nExtra',
    ],
    [
      'empty body',
      '## Allowed Tools\n\n## Required Context\nRules\n\n## Guardrails\nSafe',
    ],
  ])('rejects a %s before sending it to Core', (_name, content) => {
    expect(agentSkillDraftIssues(content)).not.toEqual([]);
  });

  it('enforces the service character and NUL limits', () => {
    expect(
      agentSkillDraftIssues(
        `${starterAgentSkillContent('node')}${'x'.repeat(
          AGENT_SKILL_MAX_CHARACTERS,
        )}`,
      ),
    ).toContain(
      `Keep the document at or below ${AGENT_SKILL_MAX_CHARACTERS.toLocaleString()} characters.`,
    );
    expect(
      agentSkillDraftIssues(`${starterAgentSkillContent('node')}\0`),
    ).toContain('Remove the NUL character.');
  });
});
