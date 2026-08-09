import React, { useState } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { fixtureWorkspaceDataSource } from '../dataSource';
import { WorkspaceProvider } from './WorkspaceProvider';
import { useWorkspaceOperations } from './operations';
import { useWorkspaceQueries } from './queries';
import { useWorkspaceRealtime } from './realtime';
import { useWorkspaceSession } from './session';

(globalThis as unknown as { React: typeof React }).React = React;

describe('focused workspace state providers', () => {
  // @spec AC-24
  it('preserves remote/session context identities across a layout-only child update', async () => {
    const snapshots: Array<{
      session: ReturnType<typeof useWorkspaceSession>;
      queries: ReturnType<typeof useWorkspaceQueries>;
      realtime: ReturnType<typeof useWorkspaceRealtime>;
      operations: ReturnType<typeof useWorkspaceOperations>;
    }> = [];
    function Probe() {
      const [layoutRevision, setLayoutRevision] = useState(0);
      const session = useWorkspaceSession();
      const queries = useWorkspaceQueries();
      const realtime = useWorkspaceRealtime();
      const operations = useWorkspaceOperations();
      snapshots.push({ session, queries, realtime, operations });
      return <button type="button" onClick={() => setLayoutRevision((value) => value + 1)}>Layout {layoutRevision}</button>;
    }

    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <WorkspaceProvider source={fixtureWorkspaceDataSource}><Probe /></WorkspaceProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const before = snapshots.at(-1)!;
    await act(async () => renderer!.root.findByType('button').props.onClick());
    const after = snapshots.at(-1)!;
    expect(after.session).toBe(before.session);
    expect(after.queries).toBe(before.queries);
    expect(after.realtime).toBe(before.realtime);
    expect(after.operations).toBe(before.operations);
    await act(async () => renderer!.unmount());
  });
});
