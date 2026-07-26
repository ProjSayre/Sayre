import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('MCP settings surface', () => {
  it('makes one-time token handling, scope, revocation, and rate policy explicit', () => {
    const component = readFileSync(
      new URL('../../workspace/settings/McpSettings.tsx', import.meta.url),
      'utf8',
    );
    const shell = readFileSync(
      new URL('../../workspace/settings/SettingsPanel.tsx', import.meta.url),
      'utf8',
    );
    const dataSource = readFileSync(
      new URL('../../workspace/dataSource.ts', import.meta.url),
      'utf8',
    );
    const page = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8');
    const combined = `${component}\n${shell}\n${dataSource}\n${page}`;

    expect(combined).toMatch(/shown once/i);
    expect(combined).toMatch(/Repository UUID/);
    expect(combined).toMatch(/Path prefix/);
    expect(combined).toMatch(/Revoke/);
    expect(combined).toMatch(/Calls per minute/);
    expect(combined).toMatch(/read-only/i);
    expect(page).toMatch(/settings=mcp/);
    expect(combined).not.toMatch(
      /localStorage|sessionStorage|document\.cookie|console\.log/,
    );
  });
});
