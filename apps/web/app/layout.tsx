import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@xyflow/react/dist/style.css';
import './globals.css';
import './workspace/workspace.css';
import './workspace/layout/workspace-layout.css';
import './workspace/theme/workspace-theme.css';
import './workspace/editor/editor.css';

export const metadata: Metadata = {
  title: 'Sayre — Engineering memory graph',
  description: 'Explore the structure and context of your codebase.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
