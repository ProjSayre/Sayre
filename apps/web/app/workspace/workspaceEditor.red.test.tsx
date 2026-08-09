import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { WorkspaceShell } from './components/WorkspaceShell';
import { MockProvider } from './state';

(globalThis as unknown as { React: typeof React }).React = React;

function repositoryRoot(): string {
  return existsSync(resolve(process.cwd(), 'apps/web/package.json'))
    ? process.cwd()
    : resolve(process.cwd(), '../..');
}

function repo(relative: string): string {
  return resolve(repositoryRoot(), relative);
}

function requiredSource(relative: string): string {
  const path = repo(relative);
  expect(existsSync(path), `Visual-editor implementation is missing: ${relative}`).toBe(true);
  return readFileSync(path, 'utf8');
}

async function renderWorkspace(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(
      <MockProvider>
        <WorkspaceShell />
      </MockProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer!;
}

function accessibleText(node: TestRenderer.ReactTestInstance): string {
  return `${String(node.props['aria-label'] ?? '')} ${JSON.stringify(node.props.children ?? '')}`;
}

async function enterEditMode(
  renderer: TestRenderer.ReactTestRenderer,
): Promise<void> {
  const buttons = renderer.root.findAll(
    (node) => node.type === 'button' && /edit.*(layout|workspace)|(layout|workspace).*edit/i.test(accessibleText(node)),
  );
  expect(buttons.length, 'Authenticated workspace has no accessible Layout Edit Mode entry.').toBeGreaterThan(0);
  await act(async () => {
    buttons[0]!.props.onClick();
    await Promise.resolve();
  });
}

describe('Constrained visual workspace editor — leading red', () => {
  // @spec AC-51 EC-56 EC-64
  it('enters/exits a transactional edit mode and requires save or discard for dirty changes', async () => {
    requiredSource('apps/web/app/workspace/editor/WorkspaceEditorProvider.tsx');
    requiredSource('apps/web/app/workspace/editor/LayoutEditMode.tsx');
    const renderer = await renderWorkspace();
    await enterEditMode(renderer);
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toMatch(/save personal/i);
    expect(text).toMatch(/discard/i);
    expect(text).toMatch(/materialize|fork/i);
    expect(text).toMatch(/editing (pack|workspace)|layout edit mode/i);
    await act(async () => renderer.unmount());
  });

  // @spec AC-52 AC-53 EC-51 EC-53 EC-54
  it('offers compatible pointer/touch drop targets and an announced keyboard pickup/drop/cancel path', async () => {
    requiredSource('apps/web/app/workspace/editor/dragController.ts');
    const renderer = await renderWorkspace();
    await enterEditMode(renderer);
    const handles = renderer.root.findAll((node) =>
      node.type === 'button' &&
      /move|drag|reorder/i.test(accessibleText(node)) &&
      typeof node.props.onKeyDown === 'function' &&
      typeof node.props.onPointerDown === 'function',
    );
    expect(handles.length, 'No accessible region drag handle is rendered.').toBeGreaterThan(0);
    expect(handles[0]!.props.onTouchStart ?? handles[0]!.props.onPointerDown).toEqual(expect.any(Function));
    await act(async () => {
      handles[0]!.props.onKeyDown({ key: ' ', preventDefault: () => undefined });
      await Promise.resolve();
    });
    const liveRegions = renderer.root.findAll((node) =>
      node.props['aria-live'] === 'polite' || node.props.role === 'status',
    );
    expect(liveRegions.length).toBeGreaterThan(0);
    expect(JSON.stringify(renderer.toJSON())).toMatch(/picked up|drop target|move/i);
    await act(async () => {
      handles[0]!.props.onKeyDown({ key: 'Escape', preventDefault: () => undefined });
      await Promise.resolve();
      renderer.unmount();
    });
  });

  // @spec AC-54 AC-55 EC-52 EC-55 EC-61 EC-62
  it('filters replacement/hide controls by slot, role, capability, and primary/recovery invariants', async () => {
    const palette = requiredSource('apps/web/app/workspace/editor/ComponentPalette.tsx');
    const editMode = requiredSource('apps/web/app/workspace/editor/LayoutEditMode.tsx');
    expect(palette).toMatch(/allowedSlots|accepts|slot/);
    expect(palette).toMatch(/minimumRole|role/);
    expect(palette).toMatch(/requiredCapabilities|capabilit/);
    expect(palette).toMatch(/no compatible/i);
    expect(editMode).toMatch(/hidden-region|hidden region|restore/i);
    expect(editMode).toMatch(/primary/);
    expect(editMode).toMatch(/SystemRecovery|recovery/);
  });

  // @spec AC-56 EC-60
  it('edits only closed semantic theme tokens and withholds incomplete hex input from preview', async () => {
    const themeEditor = requiredSource('apps/web/app/workspace/editor/ThemeTokenEditor.tsx');
    expect(themeEditor).toMatch(/type=["']color["']/);
    expect(themeEditor).toMatch(/#[0-9A-Fa-f]{6}|hex/i);
    expect(themeEditor).toMatch(/typography|density|radius/);
    expect(themeEditor).toMatch(/reset/i);
    expect(themeEditor).not.toMatch(/dangerouslySetInnerHTML|cssText|style\.setProperty\([^,]*input/i);
  });

  // @spec AC-57 AC-58 EC-59 EC-63
  it('validates before preview and provides bounded, revalidated undo/redo/discard history', () => {
    const provider = requiredSource('apps/web/app/workspace/editor/WorkspaceEditorProvider.tsx');
    expect(provider).toMatch(/applyWorkspaceEditOperation/);
    expect(provider).toMatch(/violations/);
    expect(provider).toMatch(/undo/);
    expect(provider).toMatch(/redo/);
    expect(provider).toMatch(/50/);
    expect(provider).toMatch(/discard/);
    expect(provider).toMatch(/catalog|capabilit|role/);
  });

  // @spec AC-59 AC-60 EC-57 EC-58 EC-66
  it('saves a separate exact-version personal override and atomically materializes a fork', () => {
    const provider = requiredSource('apps/web/app/workspace/editor/WorkspaceEditorProvider.tsx');
    const storage = requiredSource('apps/web/app/workspace/packs/packStorage.ts');
    expect(provider).toMatch(/savePersonalOverride|savePersonal/);
    expect(provider).toMatch(/materializeFork/);
    expect(provider).toMatch(/derivedFrom/);
    expect(storage).toMatch(/personalOverride/);
    expect(storage).toMatch(/pack[^\n]*(version|ref)/i);
    expect(storage).toMatch(/quota|catch|storage/i);
  });

  // @spec AC-61 AC-62
  it('uses the shared semantic reducer without data loads or realtime reconnection during editing', () => {
    const provider = requiredSource('apps/web/app/workspace/editor/WorkspaceEditorProvider.tsx');
    const editMode = requiredSource('apps/web/app/workspace/editor/LayoutEditMode.tsx');
    expect(provider).toMatch(/applyWorkspaceEditOperation/);
    const combined = `${provider}\n${editMode}`;
    expect(combined).not.toMatch(/repositories\(|technicalTree\(|productTree\(|nodeOverlay\(|providerState\(|new WebSocket/);
  });

  // @spec AC-63 AC-64
  it('proves pitch reproduction and the visual-editor deployment gate before LLM evaluation', () => {
    const operations = repo('apps/web/workspace-packs/pitch/from-default.operations.json');
    expect(existsSync(operations)).toBe(true);
    const editorTest = requiredSource('apps/web/app/workspace/editor/LayoutEditMode.test.tsx');
    expect(editorTest).toMatch(/pointer|touch/);
    expect(editorTest).toMatch(/keyboard|Escape/);
    expect(editorTest).toMatch(/undo|redo/);
    expect(editorTest).toMatch(/no-refetch|repositories|WebSocket/);
    expect(editorTest).toMatch(/pitch/);
  });
});
