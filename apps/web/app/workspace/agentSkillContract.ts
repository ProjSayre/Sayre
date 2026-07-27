export const AGENT_SKILL_MAX_CHARACTERS = 32_768;
export const AGENT_SKILL_REQUIRED_SECTIONS = [
  'Allowed Tools',
  'Required Context',
  'Guardrails',
] as const;

interface Heading {
  title: string;
  index: number;
  end: number;
}

function levelTwoHeadings(content: string): Heading[] {
  return [...content.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)].map((match) => ({
    title: match[1]?.trim() ?? '',
    index: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

/**
 * Mirrors Core's Agent/Skill MD validation so the editor never offers a save
 * that the service is guaranteed to reject.
 */
export function agentSkillDraftIssues(value: string): string[] {
  const content = value.replace(/\r\n?/g, '\n').trim();
  const issues: string[] = [];
  if (content.length === 0) issues.push('The document cannot be blank.');
  if (content.includes('\0')) issues.push('Remove the NUL character.');
  if (content.length > AGENT_SKILL_MAX_CHARACTERS) {
    issues.push(
      `Keep the document at or below ${AGENT_SKILL_MAX_CHARACTERS.toLocaleString()} characters.`,
    );
  }

  const headings = levelTwoHeadings(content);
  if (
    headings.length !== AGENT_SKILL_REQUIRED_SECTIONS.length ||
    headings.some(
      (heading, index) =>
        heading.title !== AGENT_SKILL_REQUIRED_SECTIONS[index],
    )
  ) {
    issues.push(
      'Use exactly these level-two sections, in order: Allowed Tools, Required Context, Guardrails.',
    );
    return issues;
  }

  headings.forEach((heading, index) => {
    const body = content
      .slice(heading.end, headings[index + 1]?.index ?? content.length)
      .trim();
    if (body.length === 0) {
      issues.push(`${heading.title} needs at least one Markdown instruction.`);
    }
  });
  return issues;
}

export function starterAgentSkillContent(nodeName: string): string {
  return `# ${nodeName}

## Allowed Tools

- Read repository files and graph context relevant to this node.

## Required Context

- Review this node, its dependencies, and repository guidance before editing.

## Guardrails

- Preserve authorization, tenant boundaries, and existing repository invariants.
`;
}
