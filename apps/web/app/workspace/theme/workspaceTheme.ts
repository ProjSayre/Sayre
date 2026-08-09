import type { CSSProperties } from 'react';
import type { WorkspaceThemeTokens } from '../../../../../packages/workspace-packs/src/runtime';

const fonts: Record<WorkspaceThemeTokens['typography']['ui'], string> = {
  'sayre-grotesk': '"Familjen Grotesk", ui-sans-serif, system-ui, sans-serif',
  'system-sans': 'ui-sans-serif, system-ui, -apple-system, sans-serif',
  'system-mono': 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

const monoFonts: Record<WorkspaceThemeTokens['typography']['mono'], string> = fonts;
type ThemeStyle = CSSProperties & Record<`--${string}`, string>;

export function workspaceThemeVariables(theme: WorkspaceThemeTokens): ThemeStyle {
  return {
    '--bg': theme.colors.canvas,
    '--bg-raised': theme.colors.raised,
    '--bg-hover': theme.colors.hover,
    '--border': theme.colors.border,
    '--border-bright': theme.colors.borderStrong,
    '--edge': theme.colors.edge,
    '--node-stroke': theme.colors.node,
    '--node-fill': theme.colors.node,
    '--text-faint': theme.colors.textFaint,
    '--text-muted': theme.colors.textMuted,
    '--text': theme.colors.text,
    '--text-bright': theme.colors.textStrong,
    '--accent': theme.colors.accent,
    '--accent-text': theme.colors.accentText,
    '--accent-btn-text': theme.colors.accentContent,
    '--warn': theme.colors.warning,
    '--danger': theme.colors.danger,
    '--ui': fonts[theme.typography.ui],
    '--mono': monoFonts[theme.typography.mono],
    '--workspace-density': theme.density,
    '--workspace-radius': theme.radius,
  };
}
