import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('MCP thin-handler contract', () => {
  it('keeps exactly one dependency-free adapter per v1 tool', () => {
    const directory = new URL('./handlers/', import.meta.url);
    const files = readdirSync(directory)
      .filter((name) => name.endsWith('.ts'))
      .sort();
    expect(files).toEqual(
      [
        'findRelevantNodes.ts',
        'getAgentSkillMd.ts',
        'getCoveringTests.ts',
        'getFeatureCluster.ts',
        'getNodeContext.ts',
        'getRecentChanges.ts',
        'getStyleRules.ts',
        'traverseFrom.ts',
      ].sort(),
    );
    for (const file of files) {
      const source = readFileSync(new URL(file, directory), 'utf8');
      expect(source).not.toMatch(
        /(?:drizzle-orm|neo4j-driver|node:fs|node:child_process|\/db\/|\/graph-query\/)/,
      );
      expect(source.split(/\r?\n/).length).toBeLessThan(20);
      expect(source).toMatch(/services\.[A-Za-z]+/);
    }
  });
});
