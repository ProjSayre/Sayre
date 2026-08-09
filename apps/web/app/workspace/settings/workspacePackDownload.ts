export interface WorkspacePackDownloadEnvironment {
  createBlob(json: string): Blob;
  createObjectUrl(blob: Blob): string;
  createLink(): Pick<HTMLAnchorElement, 'href' | 'download' | 'click'>;
  revokeObjectUrl(url: string): void;
}

export function browserWorkspacePackDownloadEnvironment(): WorkspacePackDownloadEnvironment | null {
  if (typeof document === 'undefined' || typeof Blob === 'undefined'
    || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function'
    || typeof URL.revokeObjectURL !== 'function') return null;
  return {
    createBlob: (json) => new Blob([json], { type: 'application/json' }),
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    createLink: () => document.createElement('a'),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  };
}

export function downloadWorkspacePack(
  json: string,
  filename: string,
  environment: WorkspacePackDownloadEnvironment | null = browserWorkspacePackDownloadEnvironment(),
): void {
  if (environment === null) throw new Error('This browser cannot create Workspace Pack downloads. No file was produced.');
  let objectUrl: string | null = null;
  try {
    const link = environment.createLink();
    objectUrl = environment.createObjectUrl(environment.createBlob(json));
    link.href = objectUrl;
    link.download = filename;
    link.click();
  } finally {
    if (objectUrl !== null) environment.revokeObjectUrl(objectUrl);
  }
}
