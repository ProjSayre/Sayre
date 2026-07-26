import type { CSSProperties } from 'react';

export interface WorkspaceTheme {
  id: string;
  label: string;
  colors: {
    background: string;
    raised: string;
    border: string;
    edge: string;
    nodeStroke: string;
    textFaint: string;
    textMuted: string;
    text: string;
    textBright: string;
    accent: string;
    accentText: string;
    accentButtonText: string;
    warning: string;
    danger: string;
  };
}

export const warmGraphiteTheme = {
  id: 'warm-graphite',
  label: 'Warm Graphite',
  colors: {
    background: '#131412',
    raised: '#1b1c19',
    border: '#34352f',
    edge: '#41423b',
    nodeStroke: '#68685f',
    textFaint: '#77776e',
    textMuted: '#9b9b91',
    text: '#b9b9af',
    textBright: '#e8e6e1',
    accent: '#4f7f5d',
    accentText: '#7fb18e',
    accentButtonText: '#edece7',
    warning: '#b09a69',
    danger: '#b87b70',
  },
} satisfies WorkspaceTheme;

type ThemeVariables = CSSProperties & Record<`--${string}`, string>;

export function themeVariables(theme: WorkspaceTheme): ThemeVariables {
  return {
    '--bg': theme.colors.background,
    '--bg-raised': theme.colors.raised,
    '--border': theme.colors.border,
    '--edge': theme.colors.edge,
    '--node-stroke': theme.colors.nodeStroke,
    '--text-faint': theme.colors.textFaint,
    '--text-muted': theme.colors.textMuted,
    '--text': theme.colors.text,
    '--text-bright': theme.colors.textBright,
    '--accent': theme.colors.accent,
    '--accent-text': theme.colors.accentText,
    '--accent-btn-text': theme.colors.accentButtonText,
    '--warn': theme.colors.warning,
    '--danger': theme.colors.danger,
  };
}
