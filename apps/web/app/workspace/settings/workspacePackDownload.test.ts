import { describe, expect, it, vi } from 'vitest';
import { downloadWorkspacePack, type WorkspacePackDownloadEnvironment } from './workspacePackDownload';

describe('Workspace Pack browser download boundary', () => {
  // @spec AC-29 EC-33
  it('refuses unavailable browser APIs without producing a file', () => {
    expect(() => downloadWorkspacePack('{}', 'pack.json', null)).toThrow(/No file was produced/i);
  });

  // @spec AC-32 EC-33
  it('revokes the object URL after a successful canonical download', () => {
    const click = vi.fn();
    const revokeObjectUrl = vi.fn();
    const link = { href: '', download: '', click };
    const environment: WorkspacePackDownloadEnvironment = {
      createBlob: (json) => new Blob([json]),
      createObjectUrl: () => 'blob:workspace-pack',
      createLink: () => link,
      revokeObjectUrl,
    };
    downloadWorkspacePack('{"schemaVersion":1}', 'sayre.workspace.json', environment);
    expect(link).toMatchObject({ href: 'blob:workspace-pack', download: 'sayre.workspace.json' });
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:workspace-pack');
  });
});
