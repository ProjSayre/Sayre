// Permanent regression proof for the REST/MCP service-layer boundary. The
// suite invokes the installed ESLint JavaScript entrypoint through the current
// Node executable, so it exercises the real CI gate without a shell or a
// platform-specific npx/.bin shim.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';

const CORE_ROOT = path.resolve(__dirname, '..', '..');
const CORE_REQUIRE = createRequire(path.join(CORE_ROOT, 'package.json'));
const SURFACES = ['routes', 'mcp'] as const;
type Surface = (typeof SURFACES)[number];

const RESERVED_LOADER_ROOTS = ['require', 'module', 'globalThis', 'global', 'process'] as const;
type ReservedLoaderRoot = (typeof RESERVED_LOADER_ROOTS)[number];
const AMBIENT_VARIABLE_KINDS = ['const', 'let', 'var'] as const;
const AMBIENT_NAMED_DECLARATION_KINDS = ['class', 'enum', 'namespace'] as const;
const TYPE_ONLY_IMPORT_FORMS = ['named', 'default', 'namespace', 'inline named'] as const;
const STATIC_MODULE_FORMS = ['import', 'named re-export', 'star re-export'] as const;
const NTFS_SHORT_NAME_SPECIFIERS = [
  'DRIZZL~1',
  'drizzl~1',
  'DRIZZL~1/node-postgres',
  '../GRAPH-~1',
  '../graph-~1',
  '../GRAPH-~1/index',
] as const;
const ADJACENT_NTFS_SHORT_NAME_SPECIFIERS = [
  'NEO4J-~2',
  '@aws-sdk/CLIENT~1',
  '@aws-sdk/CLIENT~2',
  '../../dist/GRAPH-~1',
  '@sayre/core/src/GRAPH-~1',
  '@sayre/core/dist/GRAPH-~1',
] as const;
const TILDE_FREE_SERVICE_HTTP_CONTROLS = [
  '../services/DRIZZL-1',
  '../services/drizzl-1/node-postgres',
  '../http/GRAPH-1',
  '@sayre/core/src/services/GRAPH-1',
] as const;
const AMBIENT_BINDING_PATTERN_KINDS = [
  'object shorthand',
  'object rename',
  'object nested',
  'object rest',
  'array element',
  'array rest',
] as const;

const GLOBAL_AUGMENTATION_TYPES: Record<ReservedLoaderRoot, string> = {
  require: 'NodeRequire',
  module: 'NodeModule',
  globalThis: 'typeof global',
  global: 'typeof globalThis',
  process: 'NodeJS.Process',
};

function loaderAccess(root: ReservedLoaderRoot): string {
  if (root === 'require') return `(require as unknown as NodeRequire)('pg')`;
  if (root === 'process') {
    return `(process as unknown as { getBuiltinModule(name: string): { createRequire(filename: string): NodeRequire } }).getBuiltinModule('node:module').createRequire(__filename)('pg')`;
  }
  return `(${root} as unknown as { require: NodeRequire }).require('pg')`;
}

function ambientNamedDeclaration(
  kind: (typeof AMBIENT_NAMED_DECLARATION_KINDS)[number],
  root: ReservedLoaderRoot,
): string {
  if (kind === 'class') return `declare class ${root} {}`;
  if (kind === 'enum') return `declare enum ${root} { Loader }`;
  return `declare namespace ${root} { const loader: NodeRequire; }`;
}

function ambientBindingPattern(
  pattern: (typeof AMBIENT_BINDING_PATTERN_KINDS)[number],
  root: ReservedLoaderRoot,
): string {
  if (pattern === 'object shorthand') return `{ ${root} }: { ${root}: unknown }`;
  if (pattern === 'object rename') return `{ value: ${root} }: { value: unknown }`;
  if (pattern === 'object nested') {
    return `{ value: { ${root} } }: { value: { ${root}: unknown } }`;
  }
  if (pattern === 'object rest') return `{ ...${root} }: Record<string, unknown>`;
  if (pattern === 'array element') return `[${root}]: readonly unknown[]`;
  return `[...${root}]: readonly unknown[]`;
}

function typeOnlyImportStatement(
  form: (typeof TYPE_ONLY_IMPORT_FORMS)[number],
  localName: string,
): string {
  if (form === 'named') {
    return `import type { NamedType as ${localName} } from './protocolTypes';`;
  }
  if (form === 'default') return `import type ${localName} from './protocolTypes';`;
  if (form === 'namespace') return `import type * as ${localName} from './protocolTypes';`;
  return `import { type NamedType as ${localName} } from './protocolTypes';`;
}

function allowedTypeOnlyImportSource(form: (typeof TYPE_ONLY_IMPORT_FORMS)[number]): string {
  const localName = form === 'namespace' ? 'ProtocolTypes' : 'ProtocolType';
  const typeName = form === 'namespace' ? `${localName}.NamedType` : localName;
  return (
    `${typeOnlyImportStatement(form, localName)}\n` +
    `export const handler = (value: ${typeName}) => value;\n`
  );
}

function erasedTypeImportLoaderSource(
  form: (typeof TYPE_ONLY_IMPORT_FORMS)[number],
  root: ReservedLoaderRoot,
): string {
  const declarationSuppression =
    form === 'namespace' && root === 'require'
      ? `// @ts-expect-error -- Node reserves require in a CommonJS module scope.\n`
      : '';
  const valueSuppression =
    form === 'namespace'
      ? `// @ts-expect-error -- demonstrates an erased type-only namespace used as a value.\n`
      : '';
  return (
    declarationSuppression +
    `${typeOnlyImportStatement(form, root)}\n` +
    valueSuppression +
    `export const value = ${loaderAccess(root)};\n`
  );
}

function erasedConstEnumLoaderSource(root: ReservedLoaderRoot): string {
  const declarationSuppression =
    root === 'require'
      ? `// @ts-expect-error -- Node reserves require in a CommonJS module scope.\n`
      : '';
  return (
    declarationSuppression +
    `const enum ${root} { Loader }\n` +
    `// @ts-expect-error -- demonstrates an erased const-enum binding used as a value.\n` +
    `export const value = ${loaderAccess(root)};\n`
  );
}

function staticModuleSource(
  form: (typeof STATIC_MODULE_FORMS)[number],
  moduleSpecifier: string,
): string {
  const literal = moduleSpecifier.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
  if (form === 'import') {
    return `import value from '${literal}';\nexport const result = value;\n`;
  }
  if (form === 'named re-export') return `export { value } from '${literal}';\n`;
  return `export * from '${literal}';\n`;
}

function resolveInstalledCaseVariantOnWindows(moduleSpecifier: string): {
  node: string;
  typescript: string | undefined;
} {
  const containingFile = path.join(CORE_ROOT, 'src', 'routes', '__case_resolution_probe__.ts');
  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
  };

  return {
    node: CORE_REQUIRE.resolve(moduleSpecifier),
    typescript: ts.resolveModuleName(moduleSpecifier, containingFile, compilerOptions, ts.sys)
      .resolvedModule?.resolvedFileName,
  };
}

function resolveTypeScriptModuleOnWindows(
  moduleSpecifier: string,
  containingFile: string,
): string | undefined {
  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
  };

  return ts.resolveModuleName(moduleSpecifier, containingFile, compilerOptions, ts.sys)
    .resolvedModule?.resolvedFileName;
}

function canonicalRealPath(target: string): string {
  return realpathSync.native(target).replaceAll('\\', '/').toLowerCase();
}

function discoverNtfsShortName(
  parentDirectory: string,
  canonicalName: string,
  shortPrefix: string,
): string {
  const canonicalTarget = canonicalRealPath(path.join(parentDirectory, canonicalName));

  for (let suffix = 1; suffix <= 9; suffix += 1) {
    const candidate = `${shortPrefix}~${suffix}`;
    try {
      if (canonicalRealPath(path.join(parentDirectory, candidate)) === canonicalTarget) {
        return candidate;
      }
    } catch {
      continue;
    }
  }

  throw new Error(`Could not discover the NTFS short name for ${canonicalName}.`);
}

function expectResolutionWithin(
  resolvedFile: string | undefined,
  canonicalDirectory: string,
): void {
  expect(resolvedFile).toBeDefined();
  const resolved = canonicalRealPath(resolvedFile as string);
  const directory = canonicalRealPath(canonicalDirectory);
  expect(resolved === directory || resolved.startsWith(`${directory}/`)).toBe(true);
}

const SAFE_AMBIENT_VALUE_CASES = [
  ['variable', `declare const protocolValue: string;\nexport const value = protocolValue;\n`],
  ['function', `declare function loadProtocolValue(): string;\nexport const value = loadProtocolValue();\n`],
  ['class', `declare class ProtocolContext { readonly value: string; }\nexport const value = ProtocolContext;\n`],
  ['enum', `declare enum ProtocolMode { Default }\nexport const value = ProtocolMode.Default;\n`],
  ['namespace', `declare namespace ProtocolValues { const value: string; }\nexport const result = ProtocolValues.value;\n`],
  [
    'global augmentation',
    `export {};\ndeclare global { var protocolRegistry: string; }\n` +
      `export const value = protocolRegistry;\n`,
  ],
] as const;

const TYPE_ONLY_DECLARATION_CASES = [
  [
    'safe-name interface',
    `interface ProtocolContext { permission: string; }\n` +
      `export const handler = (context: ProtocolContext) => context.permission;\n`,
  ],
  [
    'reserved-name interface',
    `interface require { permission: string; }\n` +
      `export const handler = (context: require) => context.permission;\n`,
  ],
  [
    'safe-name type alias',
    `type ProtocolContext = { permission: string };\n` +
      `export const handler = (context: ProtocolContext) => context.permission;\n`,
  ],
  [
    'reserved-name type alias',
    `type process = { permission: string };\n` +
      `export const handler = (context: process) => context.permission;\n`,
  ],
] as const;

const FIXTURE_PREFIX = '__lintgate_fixture_';

const BANNED_DRIVER_ROOTS = [
  'neo4j-driver',
  'pg',
  'drizzle-orm',
  'bullmq',
  'ioredis',
  '@aws-sdk/client-sqs',
  '@aws-sdk/client-sns',
  'pgvector',
  '@opensearch-project/opensearch',
] as const;

const EXACT_RESTRICTED_PATH_MESSAGES = {
  'neo4j-driver': 'Protocol handlers must not touch the graph driver — call src/services/',
  pg: 'Protocol handlers must not query Postgres directly — call src/services/',
  'drizzle-orm': 'Protocol handlers must not query the DB directly — call src/services/',
  bullmq: 'Protocol handlers must not enqueue directly — call src/services/',
  ioredis: 'Protocol handlers must not touch Redis directly — call src/services/',
  '@aws-sdk/client-sqs':
    'Protocol handlers must not publish SQS work directly — call src/services/',
  '@aws-sdk/client-sns':
    'Protocol handlers must not publish SNS events directly — call src/services/',
} as const;

const CASE_INSENSITIVE_RESTRICTED_IMPORT_MESSAGE =
  'Protocol handlers must not import storage, queue, or alternate loader subpaths — call src/services/';
const NTFS_SHORT_NAME_IMPORT_MESSAGE =
  'NTFS short-name aliases are forbidden in protocol handlers — use canonical module specifiers through src/services/';

const CASE_VARIANT_EXTERNAL_ROOTS = [
  {
    root: 'neo4j-driver',
    mixed: 'NeO4J-DrIvEr',
    upper: 'NEO4J-DRIVER',
    subpath: 'lib/driver',
    installed: true,
  },
  { root: 'pg', mixed: 'Pg', upper: 'PG', subpath: 'lib/client', installed: true },
  {
    root: 'drizzle-orm',
    mixed: 'DrIzZlE-OrM',
    upper: 'DRIZZLE-ORM',
    subpath: 'node-postgres',
    installed: true,
  },
  { root: 'bullmq', mixed: 'BuLlMq', upper: 'BULLMQ', subpath: 'dist/cjs', installed: true },
  {
    root: 'ioredis',
    mixed: 'IoReDiS',
    upper: 'IOREDIS',
    subpath: 'built/Redis',
    installed: true,
  },
  {
    root: '@aws-sdk/client-sqs',
    mixed: '@AwS-SdK/ClIeNt-SqS',
    upper: '@AWS-SDK/CLIENT-SQS',
    subpath: 'dist-cjs/index.js',
    installed: true,
  },
  {
    root: '@aws-sdk/client-sns',
    mixed: '@AwS-SdK/ClIeNt-SnS',
    upper: '@AWS-SDK/CLIENT-SNS',
    subpath: 'dist-cjs/index.js',
    installed: true,
  },
  { root: 'pgvector', mixed: 'PgVeCtOr', upper: 'PGVECTOR', subpath: 'pg', installed: false },
  {
    root: '@opensearch-project/opensearch',
    mixed: '@OpEnSeArCh-PrOjEcT/OpEnSeArCh',
    upper: '@OPENSEARCH-PROJECT/OPENSEARCH',
    subpath: 'lib/Client',
    installed: false,
  },
] as const;

const CASE_VARIANT_EXTERNAL_IMPORTS = CASE_VARIANT_EXTERNAL_ROOTS.flatMap(
  ({ root, mixed, upper, subpath, installed }) =>
    ([
      ['mixed', mixed],
      ['upper', upper],
    ] as const).flatMap(([caseStyle, variant]) => [
      [root, caseStyle, 'exact', variant, installed] as const,
      [root, caseStyle, 'subpath', `${variant}/${subpath}`, false] as const,
    ]),
);

const RESTRICTED_INTERNAL_LAYERS = [
  'graph-query',
  'db',
  'queue',
  'messaging',
  'vector',
  'vector-store',
] as const;

const REPEATED_SEPARATOR_PREFIXES = [
  '..//',
  '../../src//',
  '../../dist//',
  '@sayre/core/src//',
  '@sayre/core/dist//',
] as const;

const REPEATED_SEPARATOR_INTERNAL_PATHS = RESTRICTED_INTERNAL_LAYERS.flatMap((layer) =>
  REPEATED_SEPARATOR_PREFIXES.map((prefix) => `${prefix}${layer}/client`),
);

const REVIEWER_REPEATED_SEPARATOR_EXAMPLES = [
  '..//db/client',
  '../../src//graph-query',
] as const;

const RESOLVABLE_BACKSLASH_SPECIFIERS = ['..\\db\\client', '../../src\\graph-query'] as const;

const CANONICAL_SERVICE_HTTP_SPECIFIERS = [
  '../services/db',
  '../http/queue',
  '../../src/services/db',
  '../../src/http/queue',
  '../../dist/services/db',
  '../../dist/http/queue',
  '@sayre/core/src/services/db',
  '@sayre/core/src/http/queue',
  '@sayre/core/dist/services/db',
  '@sayre/core/dist/http/queue',
] as const;

const DOT_SEGMENT_PREFIXES = [
  '../.',
  '../../src/.',
  '../../dist/.',
  '@sayre/core/src/.',
  '@sayre/core/dist/.',
] as const;

const DOT_SEGMENT_INTERNAL_DETOURS = RESTRICTED_INTERNAL_LAYERS.flatMap((layer) =>
  DOT_SEGMENT_PREFIXES.map((prefix) => `${prefix}/${layer}/client`),
);

const DOT_SEGMENT_ALLOWED_PATHS = DOT_SEGMENT_PREFIXES.flatMap((prefix) => [
  `${prefix}/services/db`,
  `${prefix}/http/queue`,
]);

interface EslintPackage {
  bin?: string | Record<string, string>;
}

const eslintPackagePath = require.resolve('eslint/package.json');
const eslintPackage = JSON.parse(readFileSync(eslintPackagePath, 'utf8')) as EslintPackage;
const eslintBin =
  typeof eslintPackage.bin === 'string' ? eslintPackage.bin : eslintPackage.bin?.eslint;
if (!eslintBin) throw new Error('Installed eslint package does not declare its CLI entrypoint.');
const ESLINT_ENTRYPOINT = path.resolve(path.dirname(eslintPackagePath), eslintBin);

interface EslintResult {
  status: number;
  output: string;
}

function runEslintSource(relativePath: string, source: string): EslintResult {
  try {
    const output = execFileSync(
      process.execPath,
      [ESLINT_ENTRYPOINT, '--stdin', '--stdin-filename', relativePath],
      { cwd: CORE_ROOT, encoding: 'utf8', input: source },
    );
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

function lintFixture(surface: Surface, kind: string, body: string): EslintResult {
  const filename = `${FIXTURE_PREFIX}${kind}_${randomUUID().replaceAll('-', '')}.ts`;
  return runEslintSource(`src/${surface}/${filename}`, body);
}

const PROTOCOL_TYPES_SOURCE =
  `export interface NamedType { permission: string; }\n` +
  `export default interface DefaultType { permission: string; }\n`;

interface TypeScriptEmitResult {
  diagnostics: string[];
  output: string;
}

function canonicalVirtualPath(fileName: string): string {
  return path.resolve(fileName).replaceAll('\\', '/').toLowerCase();
}

function compileCommonJsSource(
  surface: Surface,
  kind: string,
  source: string,
): TypeScriptEmitResult {
  const sourceFile = path.resolve(CORE_ROOT, 'src', surface, `${FIXTURE_PREFIX}${kind}.ts`);
  const typesFile = path.resolve(CORE_ROOT, 'src', surface, 'protocolTypes.ts');
  const virtualSources = new Map([
    [canonicalVirtualPath(sourceFile), source],
    [canonicalVirtualPath(typesFile), PROTOCOL_TYPES_SOURCE],
  ]);
  const options: ts.CompilerOptions = {
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    types: ['node'],
    preserveConstEnums: false,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  const virtualSource = (fileName: string): string | undefined =>
    virtualSources.get(canonicalVirtualPath(fileName));

  host.fileExists = (fileName) => virtualSource(fileName) !== undefined || fileExists(fileName);
  host.readFile = (fileName) => virtualSource(fileName) ?? readFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const contents = virtualSource(fileName);
    return contents === undefined
      ? getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(fileName, contents, languageVersion, true);
  };

  const outputs = new Map<string, string>();
  host.writeFile = (fileName, contents) => {
    outputs.set(canonicalVirtualPath(fileName), contents);
  };
  const program = ts.createProgram([sourceFile], options, host);
  const preEmitDiagnostics = ts.getPreEmitDiagnostics(program);
  const emitResult = program.emit();
  const diagnostics = [...preEmitDiagnostics, ...emitResult.diagnostics].map(
    (diagnostic) =>
      `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
  );
  const outputFile = sourceFile.replace(/\.ts$/, '.js');

  return {
    diagnostics,
    output: outputs.get(canonicalVirtualPath(outputFile)) ?? '',
  };
}

function loaderEmitPattern(root: ReservedLoaderRoot): RegExp {
  if (root === 'require') return /(?:^|[^\w.])require\(['"]pg['"]\)/;
  if (root === 'process') return /\bprocess\.getBuiltinModule\(['"]node:module['"]\)/;
  return new RegExp(`\\b${root}\\.require\\(['"]pg['"]\\)`);
}

function loaderDeclarationPattern(root: ReservedLoaderRoot): RegExp {
  return new RegExp(`\\b(?:const|let|var|class)\\s+${root}\\b`);
}

function hasLoaderEmit(output: string): boolean {
  return RESERVED_LOADER_ROOTS.some((root) => loaderEmitPattern(root).test(output));
}

describe.runIf(process.platform === 'win32')('real NTFS short-name resolution', () => {
  it('resolves discovered installed-package aliases through Node and TypeScript', () => {
    const workspaceNodeModules = path.resolve(CORE_ROOT, '..', '..', 'node_modules');
    const coreNodeModules = path.join(CORE_ROOT, 'node_modules');
    const awsSdkDirectory = path.join(workspaceNodeModules, '@aws-sdk');
    const containingFile = path.join(CORE_ROOT, 'src', 'routes', '__short_name_probe__.ts');
    const drizzleShortName = discoverNtfsShortName(
      coreNodeModules,
      'drizzle-orm',
      'DRIZZL',
    );
    const neo4jShortName = discoverNtfsShortName(
      workspaceNodeModules,
      'neo4j-driver',
      'NEO4J-',
    );
    const snsShortName = discoverNtfsShortName(awsSdkDirectory, 'client-sns', 'CLIENT');
    const sqsShortName = discoverNtfsShortName(awsSdkDirectory, 'client-sqs', 'CLIENT');
    const cases = [
      [drizzleShortName, path.join(coreNodeModules, 'drizzle-orm')],
      [drizzleShortName.toLowerCase(), path.join(coreNodeModules, 'drizzle-orm')],
      [
        `${drizzleShortName}/node-postgres`,
        path.join(coreNodeModules, 'drizzle-orm', 'node-postgres'),
      ],
      [neo4jShortName, path.join(workspaceNodeModules, 'neo4j-driver')],
      [`@aws-sdk/${snsShortName}`, path.join(awsSdkDirectory, 'client-sns')],
      [`@aws-sdk/${sqsShortName}`, path.join(awsSdkDirectory, 'client-sqs')],
    ] as const;

    expect(drizzleShortName).toMatch(/^DRIZZL~\d+$/);
    expect(neo4jShortName).toMatch(/^NEO4J-~\d+$/);
    expect(snsShortName).toMatch(/^CLIENT~\d+$/);
    expect(sqsShortName).toMatch(/^CLIENT~\d+$/);
    for (const [moduleSpecifier, canonicalDirectory] of cases) {
      expectResolutionWithin(CORE_REQUIRE.resolve(moduleSpecifier), canonicalDirectory);
      expectResolutionWithin(
        resolveTypeScriptModuleOnWindows(moduleSpecifier, containingFile),
        canonicalDirectory,
      );
    }
  });

  it('resolves discovered src/dist graph aliases through TypeScript and Node', () => {
    const srcDirectory = path.join(CORE_ROOT, 'src');
    const distDirectory = path.join(CORE_ROOT, 'dist');
    const srcGraphDirectory = path.join(srcDirectory, 'graph-query');
    const distGraphDirectory = path.join(distDirectory, 'graph-query');
    const srcShortName = discoverNtfsShortName(srcDirectory, 'graph-query', 'GRAPH-');
    const distShortName = discoverNtfsShortName(distDirectory, 'graph-query', 'GRAPH-');
    const sourceFile = path.join(srcDirectory, 'routes', '__short_name_probe__.ts');
    const sourceRequire = createRequire(sourceFile);
    const distRequire = createRequire(
      path.join(distDirectory, 'routes', '__short_name_probe__.js'),
    );
    const typescriptCases = [
      [`../${srcShortName}`, srcGraphDirectory],
      [`../${srcShortName.toLowerCase()}`, srcGraphDirectory],
      [`../${srcShortName}/index`, srcGraphDirectory],
      [`../../dist/${distShortName}`, distGraphDirectory],
      [`@sayre/core/src/${srcShortName}`, srcGraphDirectory],
      [`@sayre/core/dist/${distShortName}`, distGraphDirectory],
    ] as const;

    expect(srcShortName).toMatch(/^GRAPH-~\d+$/);
    expect(distShortName).toMatch(/^GRAPH-~\d+$/);
    for (const [moduleSpecifier, canonicalDirectory] of typescriptCases) {
      expectResolutionWithin(
        resolveTypeScriptModuleOnWindows(moduleSpecifier, sourceFile),
        canonicalDirectory,
      );
    }
    for (const moduleSpecifier of [
      `../${distShortName}`,
      `../${distShortName.toLowerCase()}`,
      `../${distShortName}/index`,
    ]) {
      expectResolutionWithin(distRequire.resolve(moduleSpecifier), distGraphDirectory);
    }
    expectResolutionWithin(
      sourceRequire.resolve(`../../dist/${distShortName}`),
      distGraphDirectory,
    );
    expectResolutionWithin(
      CORE_REQUIRE.resolve(`@sayre/core/dist/${distShortName}`),
      distGraphDirectory,
    );
  });
});

describe.each(SURFACES)('thin-handler lint gate: src/%s/**', (surface) => {
  it('rejects a handler file over 15 effective lines', () => {
    const properties = Array.from({ length: 16 }, (_, index) => `  p${index}: ${index},`).join(
      '\n',
    );
    const result = lintFixture(surface, 'long', `export const tooLong = {\n${properties}\n};\n`);

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/max-lines/);
  });

  it('rejects a handler function over 10 statements', () => {
    const statements = Array.from({ length: 11 }, (_, index) => `  let v${index} = ${index};`).join(
      '\n',
    );
    const result = lintFixture(
      surface,
      'fat',
      `export function tooMuchLogic() {\n${statements}\n  return v0;\n}\n`,
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/max-statements/);
  });

  it.each([
    ...BANNED_DRIVER_ROOTS,
    'pg/lib/client',
    'drizzle-orm/node-postgres',
    'neo4j-driver/lib/driver',
    'bullmq/dist/cjs',
    'ioredis/built/Redis',
    '@aws-sdk/client-sqs/dist-cjs/index.js',
    '@aws-sdk/client-sns/dist-cjs/index.js',
    'pgvector',
    'pgvector/pg',
    '@opensearch-project/opensearch',
    '@opensearch-project/opensearch/lib/Client',
  ])('rejects the external driver import %s', (bannedPackage) => {
    const result = lintFixture(
      surface,
      'import',
      `import forbidden from '${bannedPackage}';\nexport const value = forbidden;\n`,
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/no-restricted-imports/);
    const exactMessage =
      EXACT_RESTRICTED_PATH_MESSAGES[
        bannedPackage as keyof typeof EXACT_RESTRICTED_PATH_MESSAGES
      ];
    if (exactMessage !== undefined) expect(result.output).toContain(exactMessage);
  });

  it.each(CASE_VARIANT_EXTERNAL_IMPORTS)(
    'rejects the %s %s-case %s external import %s',
    (root, _caseStyle, pathKind, moduleSpecifier, proveResolution) => {
      if (proveResolution && process.platform === 'win32') {
        const resolved = resolveInstalledCaseVariantOnWindows(moduleSpecifier);
        const normalizedRoot = root.toLocaleLowerCase();
        expect(resolved.node.replaceAll('\\', '/').toLocaleLowerCase()).toContain(normalizedRoot);
        expect(resolved.typescript?.replaceAll('\\', '/').toLocaleLowerCase()).toContain(
          normalizedRoot,
        );
      }

      const result = lintFixture(
        surface,
        `case-variant-${pathKind}-external-import`,
        `import forbidden from '${moduleSpecifier}';\nexport const value = forbidden;\n`,
      );

      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/no-restricted-imports/);
      expect(result.output).toContain(CASE_INSENSITIVE_RESTRICTED_IMPORT_MESSAGE);
    },
  );

  it.each(BANNED_DRIVER_ROOTS)(
    'rejects a relative node_modules detour to %s',
    (bannedPackage) => {
      const result = lintFixture(
        surface,
        'node-modules-detour',
        `import forbidden from '../../../../node_modules/${bannedPackage}';\n` +
          `export const value = forbidden;\n`,
      );

      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/no-restricted-imports/);
    },
  );

  it.each(
    STATIC_MODULE_FORMS.flatMap((form) =>
      [...new Set([...REPEATED_SEPARATOR_INTERNAL_PATHS, ...REVIEWER_REPEATED_SEPARATOR_EXAMPLES])]
        .map((moduleSpecifier) => [form, moduleSpecifier] as const),
    ),
  )('rejects a non-canonical repeated-separator %s from %s', (form, moduleSpecifier) => {
    const result = lintFixture(
      surface,
      'repeated-static-module-separator',
      staticModuleSource(form, moduleSpecifier),
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/no-restricted-syntax/);
  });

  it.each(
    STATIC_MODULE_FORMS.flatMap((form) =>
      RESOLVABLE_BACKSLASH_SPECIFIERS.map(
        (moduleSpecifier) => [form, moduleSpecifier] as const,
      ),
    ),
  )('rejects a resolvable backslash-separator %s from %s', (form, moduleSpecifier) => {
    const result = lintFixture(
      surface,
      'backslash-static-module-separator',
      staticModuleSource(form, moduleSpecifier),
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/no-restricted-syntax/);
  });

  it.each(
    STATIC_MODULE_FORMS.flatMap((form) =>
      NTFS_SHORT_NAME_SPECIFIERS.map((moduleSpecifier) => [form, moduleSpecifier] as const),
    ),
  )('rejects an NTFS short-name %s from %s', (form, moduleSpecifier) => {
    const result = lintFixture(
      surface,
      'ntfs-short-name-static-module',
      staticModuleSource(form, moduleSpecifier),
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/no-restricted-syntax/);
    expect(result.output).toContain(NTFS_SHORT_NAME_IMPORT_MESSAGE);
  });

  it.each(ADJACENT_NTFS_SHORT_NAME_SPECIFIERS)(
    'rejects the adjacent NTFS short-name import %s',
    (moduleSpecifier) => {
      const result = lintFixture(
        surface,
        'adjacent-ntfs-short-name-import',
        staticModuleSource('import', moduleSpecifier),
      );

      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/no-restricted-syntax/);
      expect(result.output).toContain(NTFS_SHORT_NAME_IMPORT_MESSAGE);
    },
  );

  it.each(TILDE_FREE_SERVICE_HTTP_CONTROLS)(
    'allows the tilde-free service/HTTP near-miss import %s',
    (moduleSpecifier) => {
      const result = lintFixture(
        surface,
        'tilde-free-short-name-near-miss',
        staticModuleSource('import', moduleSpecifier),
      );

      expect(result.status).toBe(0);
    },
  );

  it.each(
    STATIC_MODULE_FORMS.flatMap((form) =>
      CANONICAL_SERVICE_HTTP_SPECIFIERS.map(
        (moduleSpecifier) => [form, moduleSpecifier] as const,
      ),
    ),
  )('allows a canonical service/HTTP %s from %s', (form, moduleSpecifier) => {
    const result = lintFixture(
      surface,
      'canonical-static-module-separator',
      staticModuleSource(form, moduleSpecifier),
    );

    expect(result.status).toBe(0);
  });

  it.each(['../db/client', '../queue/bullmq', 'drizzle-orm/node-postgres'])(
    'rejects the dynamic import %s',
    (bannedModule) => {
      const result = lintFixture(
        surface,
        'dynamic',
        `export const load = () => import('${bannedModule}');\n`,
      );

      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/no-restricted-syntax/);
    },
  );

  it('rejects TypeScript import-equals require syntax', () => {
    const result = lintFixture(
      surface,
      'import-equals',
      `import forbidden = require('../db/client');\nexport const value = forbidden;\n`,
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/no-restricted-syntax/);
  });

  it('rejects CommonJS require calls with the boundary rule', () => {
    const result = lintFixture(
      surface,
      'require',
      `export const forbidden = require('../queue/bullmq');\n`,
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/no-restricted-globals/);
  });

  it.each(
    AMBIENT_VARIABLE_KINDS.flatMap((kind) =>
      RESERVED_LOADER_ROOTS.map((root) => [kind, root] as const),
    ),
  )('rejects ambient %s declarations of loader root %s', (kind, root) => {
    const result = lintFixture(
      surface,
      'ambient-variable-loader-root',
      `declare ${kind} ${root}: unknown;\nexport const value = ${loaderAccess(root)};\n`,
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/no-restricted-syntax/);
  });

  it.each(RESERVED_LOADER_ROOTS)(
    'rejects ambient function declarations of loader root %s',
    (root) => {
      const result = lintFixture(
        surface,
        'ambient-function-loader-root',
        `declare function ${root}(): unknown;\nexport const value = ${loaderAccess(root)};\n`,
      );

      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/no-restricted-syntax/);
    },
  );

  it.each(
    AMBIENT_NAMED_DECLARATION_KINDS.flatMap((kind) =>
      RESERVED_LOADER_ROOTS.map((root) => [kind, root] as const),
    ),
  )('rejects ambient %s declarations of loader root %s', (kind, root) => {
    const result = lintFixture(
      surface,
      'ambient-named-loader-root',
      `${ambientNamedDeclaration(kind, root)}\nexport const value = ${loaderAccess(root)};\n`,
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/no-restricted-syntax/);
  });

  it.each(RESERVED_LOADER_ROOTS)('rejects global augmentation of loader root %s', (root) => {
    const result = lintFixture(
      surface,
      'ambient-global-loader-root',
      `export {};\ndeclare global { var ${root}: ${GLOBAL_AUGMENTATION_TYPES[root]}; }\n` +
        `export const value = ${loaderAccess(root)};\n`,
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/no-restricted-syntax/);
  });

  it.each(
    AMBIENT_VARIABLE_KINDS.flatMap((kind) =>
      AMBIENT_BINDING_PATTERN_KINDS.flatMap((pattern) =>
        RESERVED_LOADER_ROOTS.map((root) => [kind, pattern, root] as const),
      ),
    ),
  )('rejects ambient %s %s binding of loader root %s', (kind, pattern, root) => {
    const result = lintFixture(
      surface,
      'ambient-pattern-loader-root',
      `declare ${kind} ${ambientBindingPattern(pattern, root)};\n` +
        `export const value = ${loaderAccess(root)};\n`,
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/no-restricted-syntax/);
  });

  it.each(SAFE_AMBIENT_VALUE_CASES)(
    'rejects the safe-name ambient value form %s',
    (_kind, source) => {
      const result = lintFixture(surface, 'ambient-safe-name-value', source);

      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/no-restricted-syntax/);
    },
  );

  it.each(
    TYPE_ONLY_IMPORT_FORMS.flatMap((form) =>
      RESERVED_LOADER_ROOTS.map((root) => [form, root] as const),
    ),
  )('rejects %s type-only imports locally bound as %s', (form, root) => {
    const source = erasedTypeImportLoaderSource(form, root);
    const compiled = compileCommonJsSource(surface, 'erased-type-import-loader-root', source);
    const result = lintFixture(
      surface,
      'erased-type-import-loader-root',
      source,
    );

    expect(ts.version).toMatch(/^5\.5\./);
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.output).toMatch(loaderEmitPattern(root));
    expect(compiled.output).not.toContain('protocolTypes');
    expect(compiled.output).not.toMatch(loaderDeclarationPattern(root));
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/no-restricted-syntax/);
  });

  it.each(RESERVED_LOADER_ROOTS)('rejects const enums named loader root %s', (root) => {
    const source = erasedConstEnumLoaderSource(root);
    const compiled = compileCommonJsSource(surface, 'erased-const-enum-loader-root', source);
    const result = lintFixture(
      surface,
      'erased-const-enum-loader-root',
      source,
    );

    expect(ts.version).toMatch(/^5\.5\./);
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.output).toMatch(loaderEmitPattern(root));
    expect(compiled.output).not.toMatch(loaderDeclarationPattern(root));
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/no-restricted-syntax/);
  });

  it('rejects a safe-name const enum', () => {
    const source =
      `const enum ProtocolMode { Read = 'read' }\n` +
      `export const value = ProtocolMode.Read;\n`;
    const compiled = compileCommonJsSource(surface, 'erased-safe-name-const-enum', source);
    const result = lintFixture(
      surface,
      'erased-safe-name-const-enum',
      source,
    );

    expect(ts.version).toMatch(/^5\.5\./);
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.output).not.toMatch(/\bvar\s+ProtocolMode\b/);
    expect(compiled.output).toMatch(/exports\.value\s*=\s*['"]read['"]/);
    expect(hasLoaderEmit(compiled.output)).toBe(false);
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/no-restricted-syntax/);
  });

  it.each([
    [
      'aliased require',
      `const load = require;\nexport const value = load('../db/client');\n`,
      'no-restricted-globals',
    ],
    [
      'module.require',
      `export const value = module.require('../db/client');\n`,
      'no-restricted-globals',
    ],
    [
      'require.call',
      `export const value = require.call(null, '../db/client');\n`,
      'no-restricted-globals',
    ],
    [
      'globalThis.require',
      `export const value = globalThis.require('../db/client');\n`,
      'no-restricted-globals',
    ],
    [
      'computed globalThis require',
      `export const value = globalThis['require']('../db/client');\n`,
      'no-restricted-globals',
    ],
    [
      'global.require',
      `export const value = global.require('../db/client');\n`,
      'no-restricted-globals',
    ],
    [
      'computed global require',
      `export const value = global['require']('../db/client');\n`,
      'no-restricted-globals',
    ],
    [
      'destructured globalThis require',
      `const { require: load } = globalThis;\nexport const value = load('../db/client');\n`,
      'no-restricted-globals',
    ],
    [
      'computed destructured globalThis require',
      `const { ['require']: load } = globalThis;\n` +
        `export const value = load('../db/client');\n`,
      'no-restricted-globals',
    ],
    [
      'destructured global require',
      `const { require: load } = global;\nexport const value = load('../db/client');\n`,
      'no-restricted-globals',
    ],
    [
      'computed destructuring assignment from global',
      `let load: NodeRequire;\n({ ['require']: load } = global);\n` +
        `export const value = load('../db/client');\n`,
      'no-restricted-globals',
    ],
    [
      'destructured default parameter from globalThis',
      `export const value = ({ require: load } = globalThis) => load('../db/client');\n`,
      'no-restricted-globals',
    ],
    [
      'destructured TypeScript-wrapped globalThis require',
      `const { require: load } = globalThis as typeof globalThis;\n` +
        `export const value = load('../db/client');\n`,
      'no-restricted-globals',
    ],
    [
      'TypeScript-aliased globalThis loader root',
      `const root = globalThis as typeof globalThis & { require: NodeRequire };\n` +
        `export const value = root.require('pg');\n`,
      'no-restricted-globals',
    ],
    [
      'inline TypeScript-wrapped globalThis loader root',
      `export const value =\n` +
        `  (globalThis as typeof globalThis & { require: NodeRequire }).require('pg');\n`,
      'no-restricted-globals',
    ],
    [
      'destructured asserted globalThis loader root',
      `const { require: load } =\n` +
        `  globalThis as unknown as { require: NodeRequire };\n` +
        `export const value = load('pg');\n`,
      'no-restricted-globals',
    ],
    [
      'Reflect access through globalThis loader root',
      `const load: NodeRequire = Reflect.get(globalThis, 'require');\n` +
        `export const value = load('pg');\n`,
      'no-restricted-globals',
    ],
    [
      'process.getBuiltinModule loader root',
      `const load = process.getBuiltinModule('node:module').createRequire(__filename);\n` +
        `export const value = load('pg');\n`,
      'no-restricted-globals',
    ],
    [
      'createRequire',
      `import { createRequire } from 'node:module';\n` +
        `const load = createRequire(__filename);\n` +
        `export const value = load('../db/client');\n`,
      'no-restricted-imports',
    ],
  ])('rejects the indirect loader form %s', (_label, source, ruleName) => {
    const result = lintFixture(surface, 'indirect-loader', source);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(ruleName);
  });

  it.each(['process', 'node:process', 'process/promises', 'node:process/promises'])(
    'rejects the process-module loader root import %s',
    (processModule) => {
      const result = lintFixture(
        surface,
        'process-module-import',
        `import processModule from '${processModule}';\n` +
          `export const value = processModule;\n`,
      );

      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/no-restricted-imports/);
    },
  );

  it('rejects TypeScript import-type expressions', () => {
    const result = lintFixture(
      surface,
      'import-type',
      `export type Forbidden = import('../db/client').Db;\n`,
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/no-restricted-syntax/);
  });

  it('rejects static re-exports from a restricted layer', () => {
    const result = lintFixture(
      surface,
      're-export',
      `export { createPool } from '../db/client';\n`,
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/no-restricted-imports/);
  });

  it.each([
    '../graph-query',
    '../db/client',
    '../queue/bullmq',
    '../messaging/client',
    '../vector-store/query',
  ])('rejects the internal data/queue import %s', (bannedModule) => {
    const result = lintFixture(
      surface,
      'import',
      `import forbidden from '${bannedModule}';\nexport const value = forbidden;\n`,
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/no-restricted-imports/);
  });

  it.each([
    '../services/db',
    '../services/queue',
    '../services/vector-store',
    '../services/graph-query',
    '../http/db',
    '../http/queue',
  ])('allows a service or HTTP helper whose name contains %s', (allowedModule) => {
    const result = lintFixture(
      surface,
      'allowed-name',
      `import allowed from '${allowedModule}';\nexport const value = allowed;\n`,
    );

    expect(result.status).toBe(0);
  });

  it.each([
    ['../../db/client', 'src/' + surface + '/nested/handler.ts'],
    ['../../../queue/bullmq', 'src/' + surface + '/nested/deep/handler.ts'],
    ['src/vector-store/query', 'src/' + surface + '/nested/alias.ts'],
    ['@sayre/core/src/graph-query', 'src/' + surface + '/nested/package-alias.ts'],
  ])('rejects nested-handler/alias access to %s', (bannedModule, filename) => {
    const result = runEslintSource(
      filename,
      `import forbidden from '${bannedModule}';\nexport const value = forbidden;\n`,
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/no-restricted-imports/);
  });

  it.each([
    '../../src/db/client',
    '../../src/graph-query',
    '../../src/queue/bullmq',
    '../../src/messaging/client',
    '../../src/vector-store/query',
    '../../../core/src/db/client',
    '../../dist/db/client',
    '../../dist/graph-query',
    '../../dist/queue/bullmq',
    '../../dist/messaging/client',
    '../../dist/vector-store/query',
    '@sayre/core/dist/db/client',
    '@sayre/core/dist/graph-query',
    '@sayre/core/dist/queue/bullmq',
    '@sayre/core/dist/messaging/client',
    '@sayre/core/dist/vector-store/query',
  ])('rejects a source/distribution path detour to %s', (bannedModule) => {
    const result = lintFixture(
      surface,
      'internal-detour',
      `import forbidden from '${bannedModule}';\nexport const value = forbidden;\n`,
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/no-restricted-imports/);
  });

  it.each(DOT_SEGMENT_INTERNAL_DETOURS)(
    'rejects a dot-segment path detour to %s',
    (bannedModule) => {
      const result = lintFixture(
        surface,
        'dot-segment-detour',
        `import forbidden from '${bannedModule}';\nexport const value = forbidden;\n`,
      );

      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/no-restricted-imports/);
    },
  );

  it.each([
    '../../src/services/db',
    '../../src/http/queue',
    '../../dist/services/db',
    '../../dist/http/queue',
    '@sayre/core/dist/services/db',
    '@sayre/core/dist/http/queue',
  ])('allows a source/distribution service or HTTP path %s', (allowedModule) => {
    const result = lintFixture(
      surface,
      'allowed-internal-detour',
      `import allowed from '${allowedModule}';\nexport const value = allowed;\n`,
    );

    expect(result.status).toBe(0);
  });

  it.each(DOT_SEGMENT_ALLOWED_PATHS)(
    'allows a dot-segment service or HTTP path %s',
    (allowedModule) => {
      const result = lintFixture(
        surface,
        'allowed-dot-segment',
        `import allowed from '${allowedModule}';\nexport const value = allowed;\n`,
      );

      expect(result.status).toBe(0);
    },
  );

  it.each([
    ['../../services/db', 'src/' + surface + '/nested/service.ts'],
    ['../../http/queue', 'src/' + surface + '/nested/http.ts'],
  ])('allows nested handlers to import the permitted module %s', (allowedModule, filename) => {
    const result = runEslintSource(
      filename,
      `import allowed from '${allowedModule}';\nexport const value = allowed;\n`,
    );

    expect(result.status).toBe(0);
  });

  it('allows a local domain variable named module', () => {
    const result = lintFixture(
      surface,
      'local-module',
      `export function serialize(module: string) {\n  return module;\n}\n`,
    );

    expect(result.status).toBe(0);
  });

  it('allows locally bound domain identifiers named global, globalThis, and process', () => {
    const result = lintFixture(
      surface,
      'local-loader-root-names',
      `export function serialize(global: string, globalThis: string, process: string) {\n` +
        `  return [global, globalThis, process];\n` +
        `}\n`,
    );

    expect(result.status).toBe(0);
  });

  it('allows service imports bound as global, globalThis, and process', () => {
    const result = lintFixture(
      surface,
      'service-loader-root-names',
      `import { global, globalThis, process } from '../services/context';\n` +
        `export const values = [global, globalThis, process];\n`,
    );

    expect(result.status).toBe(0);
  });

  it.each([
    [
      'locally declared global with dotted access',
      `const context = { require: (permission: string) => permission };\n` +
        `const global = context;\n` +
        `export const value = global.require('read');\n`,
    ],
    [
      'locally declared globalThis with computed access',
      `const context = { require: (permission: string) => permission };\n` +
        `const globalThis = context;\n` +
        `export const value = globalThis['require']('read');\n`,
    ],
    [
      'locally declared global with destructured access',
      `const context = { require: (permission: string) => permission };\n` +
        `const global = context;\n` +
        `const { require: check } = global;\n` +
        `export const value = check('read');\n`,
    ],
    [
      'locally declared globalThis with assigned access',
      `const context = { require: (permission: string) => permission };\n` +
        `const globalThis = context;\n` +
        `let check = context.require;\n` +
        `({ ['require']: check } = globalThis);\n` +
        `export const value = check('read');\n`,
    ],
    [
      'locally declared global with defaulted access',
      `const context = { require: (permission: string) => permission };\n` +
        `const global = context;\n` +
        `export const value = ({ require: check } = global) => check('read');\n`,
    ],
    [
      'locally declared globalThis with reflected access',
      `const context = { require: (permission: string) => permission };\n` +
        `const globalThis = context;\n` +
        `const check = Reflect.get(globalThis, 'require');\n` +
        `export const value = check('read');\n`,
    ],
    [
      'locally declared global with TypeScript-wrapped access',
      `const context = { require: (permission: string) => permission };\n` +
        `const global = context;\n` +
        `const wrapped = global as typeof context;\n` +
        `export const value = wrapped.require('read');\n`,
    ],
    [
      'imported global with dotted access',
      `import { permissions as global } from '../services/permissions';\n` +
        `export const value = global.require('read');\n`,
    ],
    [
      'imported globalThis with computed access',
      `import { permissions as globalThis } from '../services/permissions';\n` +
        `export const value = globalThis['require']('read');\n`,
    ],
    [
      'imported global with destructured access',
      `import { permissions as global } from '../services/permissions';\n` +
        `const { require: check } = global;\n` +
        `export const value = check('read');\n`,
    ],
    [
      'imported globalThis with assigned access',
      `import { permissions as globalThis } from '../services/permissions';\n` +
        `let check = globalThis.require;\n` +
        `({ require: check } = globalThis);\n` +
        `export const value = check('read');\n`,
    ],
    [
      'imported global with defaulted access',
      `import { permissions as global } from '../services/permissions';\n` +
        `export const value = ({ require: check } = global) => check('read');\n`,
    ],
    [
      'imported globalThis with reflected access',
      `import { permissions as globalThis } from '../services/permissions';\n` +
        `const check = Reflect.get(globalThis, 'require');\n` +
        `export const value = check('read');\n`,
    ],
    [
      'imported global with TypeScript-wrapped access',
      `import { permissions as global } from '../services/permissions';\n` +
        `const wrapped = global as typeof global;\n` +
        `export const value = wrapped.require('read');\n`,
    ],
  ])('allows shadowed loader-root service access (%s)', (_label, source) => {
    const result = lintFixture(surface, 'shadowed-loader-root', source);

    expect(result.status).toBe(0);
  });

  it.each([
    [
      'dotted',
      `import { permissions } from '../services/permissions';\n` +
        `export const handler = () => permissions.require('read');\n`,
    ],
    [
      'computed',
      `import { permissions } from '../services/permissions';\n` +
        `export const handler = () => permissions['require']('read');\n`,
    ],
    [
      'destructured',
      `import { permissions } from '../services/permissions';\n` +
        `const { require: requirePermission } = permissions;\n` +
        `export const handler = () => requirePermission('read');\n`,
    ],
    [
      'computed destructuring assignment',
      `import { permissions } from '../services/permissions';\n` +
        `let requirePermission = permissions.require;\n` +
        `({ ['require']: requirePermission } = permissions);\n` +
        `export const handler = () => requirePermission('read');\n`,
    ],
    [
      'destructured default parameter',
      `import { permissions } from '../services/permissions';\n` +
        `export const handler = ({ require: check } = permissions) => check('read');\n`,
    ],
  ])('allows a service method named require (%s)', (_kind, source) => {
    const result = lintFixture(surface, 'service-require', source);

    expect(result.status).toBe(0);
  });

  it.each([
    [
      'locally declared',
      `function require(permission: string) { return permission; }\n` +
        `export const handler = () => require('read');\n`,
    ],
    [
      'imported',
      `import { require } from '../services/permissions';\n` +
        `export const handler = () => require('read');\n`,
    ],
  ])('allows a %s service function named require', (_kind, source) => {
    const result = lintFixture(surface, 'service-function-require', source);

    expect(result.status).toBe(0);
  });

  it.each(TYPE_ONLY_DECLARATION_CASES)(
    'allows the type-only declaration %s',
    (_kind, source) => {
      const result = lintFixture(surface, 'type-only-declaration', source);

      expect(result.status).toBe(0);
    },
  );

  it.each([
    [
      'local',
      `const require = (permission: string) => permission;\n` +
        `const module = require;\n` +
        `const globalThis = module;\n` +
        `const global = globalThis;\n` +
        `const process = global;\n` +
        `export const handler = () => process('read');\n`,
    ],
    [
      'imported service',
      `import { require, module, globalThis, global, process } from '../services/context';\n` +
        `export const handler = () => [require, module, globalThis, global, process];\n`,
    ],
  ])('allows real %s bindings for every loader-root name', (_kind, source) => {
    const result = lintFixture(surface, 'real-loader-root-bindings', source);

    expect(result.status).toBe(0);
  });

  it.each(TYPE_ONLY_IMPORT_FORMS)('allows a safe-name %s type-only import', (form) => {
    const source = allowedTypeOnlyImportSource(form);
    const compiled = compileCommonJsSource(surface, 'safe-name-type-only-import', source);
    const result = lintFixture(
      surface,
      'safe-name-type-only-import',
      source,
    );

    expect(ts.version).toMatch(/^5\.5\./);
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.output).toContain('exports.handler');
    expect(compiled.output).not.toContain('protocolTypes');
    expect(hasLoaderEmit(compiled.output)).toBe(false);
    expect(result.status).toBe(0);
  });

  it('allows a safe-name ordinary emitted enum', () => {
    const source =
      `enum ProtocolMode { Read = 'read' }\nexport const value = ProtocolMode.Read;\n`;
    const compiled = compileCommonJsSource(surface, 'ordinary-emitted-safe-name-enum', source);
    const result = lintFixture(
      surface,
      'ordinary-emitted-safe-name-enum',
      source,
    );

    expect(ts.version).toMatch(/^5\.5\./);
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.output).toMatch(/\bvar\s+ProtocolMode\b/);
    expect(compiled.output).toMatch(/\(function \(ProtocolMode\)/);
    expect(hasLoaderEmit(compiled.output)).toBe(false);
    expect(result.status).toBe(0);
  });

  it('accepts a thin adapter that imports only a service', () => {
    const result = lintFixture(
      surface,
      'clean',
      `import { getHealthStatus } from '../services/health';\n` +
        `export const handleHealth = getHealthStatus;\n`,
    );

    expect(result.status).toBe(0);
  });
});
