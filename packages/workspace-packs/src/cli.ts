import { link, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalizeWorkspacePack, diffWorkspacePacks } from './canonicalize';
import { applyWorkspaceEditOperations } from './edit';
import { applyWorkspacePackPatch } from './patch';
import { parseWorkspacePack, validateWorkspacePackCompatibility } from './parse';
import type { JsonObject, WorkspaceComponentCatalogContract, WorkspaceEditOperation, WorkspacePackDocument, WorkspacePackPatchOperation } from './contracts';

export interface WorkspacePackCliIo {
  stdout(value: string): void; stderr(value: string): void;
  readFile(path: string): Promise<string>; writeFileAtomic(path: string, value: string, overwrite?: boolean): Promise<void>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  rename(source: string, destination: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export const CLI_CATALOG: WorkspaceComponentCatalogContract = {
  runtimeContractVersion: 1,
  components: [
    { id: 'sayre.primary-surface', version: 1, allowedSlots: ['primary'], requiredCapabilities: [], minimumRole: 'member' },
    { id: 'sayre.explorer', version: 1, allowedSlots: ['explorer', 'navigation'], requiredCapabilities: ['sayre.technical'], minimumRole: 'member' },
    { id: 'sayre.inspector', version: 1, allowedSlots: ['inspector'], requiredCapabilities: [], minimumRole: 'member' },
    { id: 'sayre.pitch-summary', version: 1, allowedSlots: ['inspector'], requiredCapabilities: ['sayre.product'], minimumRole: 'member' },
  ],
  capabilities: [{ id: 'sayre.technical', version: 1 }, { id: 'sayre.product', version: 1 }, { id: 'sayre.onboarding', version: 1 }],
};

function defaultIo(): WorkspacePackCliIo {
  return {
    stdout: (value) => process.stdout.write(value), stderr: (value) => process.stderr.write(value),
    readFile: (path) => readFile(path, 'utf8'),
    writeFileAtomic: async (path, value, overwrite = false) => {
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, value, { encoding: 'utf8', flag: 'wx' });
      if (overwrite) {
        try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
        return;
      }
      try { await link(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
      await rm(temporary, { force: true }).catch(() => undefined);
    },
    mkdir: async (path) => { await mkdir(path, { recursive: false }); },
    exists: async (path) => stat(path).then(() => true, (error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? false : Promise.reject(error)),
    rename,
    remove: async (path) => { await rm(path, { recursive: true, force: true }); },
  };
}

function emit(io: WorkspacePackCliIo, command: string, json: boolean, ok: boolean, value: unknown): number {
  const envelope = ok ? { command, ok, result: value } : { command, ok, violations: value };
  io.stdout(json ? `${JSON.stringify(envelope)}\n` : `${JSON.stringify(envelope, null, 2)}\n`);
  return ok ? 0 : 1;
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function approvedRoot(argv: readonly string[]): string {
  return resolve(option(argv, '--root') ?? join(process.cwd(), 'apps', 'web', 'workspace-packs'));
}

function withinRoot(target: string, root: string): string {
  const absolute = resolve(target);
  const remainder = relative(root, absolute);
  if (remainder === '' || (!remainder.startsWith('..') && !isAbsolute(remainder))) return absolute;
  throw [{ code: 'outside-root', path: absolute, message: 'Write target must remain inside the approved Workspace Pack root.' }];
}

async function loadPack(directory: string, io: WorkspacePackCliIo): Promise<WorkspacePackDocument> {
  const raw = await io.readFile(join(resolve(directory), 'sayre.workspace.json'));
  const parsed = parseWorkspacePack(JSON.parse(raw));
  if (!parsed.ok) throw parsed.violations;
  const compatible = validateWorkspacePackCompatibility(parsed.pack, CLI_CATALOG);
  if (!compatible.ok) throw compatible.violations;
  return compatible.pack;
}

export async function runWorkspacePackCli(argv: readonly string[], provided?: WorkspacePackCliIo): Promise<number> {
  const io = provided ?? defaultIo();
  const command = argv[0] ?? 'help';
  const json = argv.includes('--json');
  try {
    if (command === 'catalog') return emit(io, command, json, true, {
      ...CLI_CATALOG,
      components: CLI_CATALOG.components.map((component) => ({ ...component, acceptedPropFields: [] })),
      themeTokenKeys: ['colors', 'typography.ui', 'typography.mono', 'density', 'radius'],
    });
    if (command === 'inspect' || command === 'validate') {
      const pack = await loadPack(argv[1]!, io);
      return emit(io, command, json, true, command === 'inspect' ? pack : { ref: { id: pack.metadata.id, version: pack.metadata.version } });
    }
    if (command === 'diff') {
      const left = await loadPack(argv[1]!, io); const right = await loadPack(argv[2]!, io);
      return emit(io, command, json, true, { changes: diffWorkspacePacks(left, right) });
    }
    if (command === 'patch' || command === 'edit') {
      const directory = withinRoot(argv[1]!, approvedRoot(argv)); const pack = await loadPack(directory, io);
      const operationFile = option(argv, '--operations');
      if (!operationFile) throw [{ code: 'missing-option', path: '', message: '--operations is required' }];
      const operations = JSON.parse(await io.readFile(resolve(operationFile))) as WorkspacePackPatchOperation[] | WorkspaceEditOperation[];
      const roleOption = option(argv, '--role');
      if (roleOption !== undefined && !['member', 'admin', 'owner'].includes(roleOption)) throw [{ code: 'invalid-role', path: '--role', message: '--role must be member, admin, or owner.' }];
      const result = command === 'patch'
        ? applyWorkspacePackPatch(pack, operations as WorkspacePackPatchOperation[], CLI_CATALOG)
        : applyWorkspaceEditOperations(pack, operations as WorkspaceEditOperation[], {
            catalog: CLI_CATALOG,
            role: (roleOption as 'member' | 'admin' | 'owner' | undefined) ?? 'member',
            availableCapabilities: CLI_CATALOG.capabilities.map((item) => item.id),
          });
      if ('ok' in result && !result.ok) return emit(io, command, json, false, result.violations);
      const next = 'ok' in result ? result.pack : result.pack;
      const changedPaths = result.changedPaths;
      if (!argv.includes('--dry-run') && changedPaths.length > 0) await io.writeFileAtomic(join(directory, 'sayre.workspace.json'), canonicalizeWorkspacePack(next), true);
      return emit(io, command, json, true, { changedPaths, pack: next, dryRun: argv.includes('--dry-run') });
    }
    if (command === 'fork') {
      const root = approvedRoot(argv);
      const sourceDirectory = withinRoot(argv[1]!, root);
      const source = await loadPack(sourceDirectory, io); const destination = withinRoot(argv[2]!, root);
      const id = option(argv, '--id'); const name = option(argv, '--name'); const version = option(argv, '--version'); const author = option(argv, '--author');
      if (!id || !name || !version || !author) throw [{ code: 'missing-option', path: '', message: 'fork identity options are required' }];
      const fork: WorkspacePackDocument = { ...source, metadata: { ...source.metadata, id, name, version, author, derivedFrom: { id: source.metadata.id, version: source.metadata.version } } };
      const validated = validateWorkspacePackCompatibility(fork, CLI_CATALOG); if (!validated.ok) throw validated.violations;
      if (await io.exists(destination)) throw [{ code: 'destination-exists', path: destination, message: 'Fork destination already exists.' }];
      const staging = `${destination}.${randomUUID()}.tmp`;
      await io.mkdir(staging);
      try {
        await io.writeFileAtomic(join(staging, 'sayre.workspace.json'), canonicalizeWorkspacePack(validated.pack));
        if (await io.exists(destination)) throw new Error('Fork destination already exists.');
        await io.rename(staging, destination);
      } catch (error) {
        await io.remove(staging);
        throw error;
      }
      return emit(io, command, json, true, { destination, ref: { id, version } });
    }
    if (command === 'export') {
      const root = approvedRoot(argv);
      const pack = await loadPack(withinRoot(argv[1]!, root), io); const destination = option(argv, '--out');
      if (!destination) throw [{ code: 'missing-option', path: '', message: '--out is required' }];
      const output = withinRoot(destination, root);
      if (await io.exists(output)) throw [{ code: 'destination-exists', path: output, message: 'Export destination already exists.' }];
      await io.writeFileAtomic(output, canonicalizeWorkspacePack(pack));
      return emit(io, command, json, true, { out: output });
    }
    return emit(io, command, json, false, [{ code: 'unknown-command', path: '', message: 'Unknown command.' }]);
  } catch (error) {
    const violations = Array.isArray(error) ? error : [{ code: 'command-failed', path: '', message: error instanceof Error ? error.message : String(error) }];
    return emit(io, command, json, false, violations);
  }
}
