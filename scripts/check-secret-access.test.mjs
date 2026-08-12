import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

const checker = resolve(dirname(fileURLToPath(import.meta.url)), 'check-secret-access.mjs');
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roots = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function fixtureRepo(files) {
  const root = mkdtempSync(resolve(tmpdir(), 'sayre-secret-gate-'));
  roots.push(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'gate@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Gate Test'], { cwd: root });
  for (const [path, contents] of Object.entries(files)) {
    const destination = resolve(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  }
  execFileSync('git', ['add', '--force', '.'], { cwd: root });
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8' });
}

function assertNodeSyntax(files) {
  for (const [path, contents] of Object.entries(files)) {
    const result = spawnSync(process.execPath, ['--check', '-'], {
      input: contents,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, path + ': ' + result.stderr);
  }
}

function runPython(source, input = undefined) {
  for (const executable of ['python', 'python3']) {
    const result = spawnSync(executable, ['-I', '-X', 'utf8', '-c', source], {
      encoding: 'utf8',
      input,
    });
    if (result.error?.code !== 'ENOENT') return result;
  }
  assert.fail('Python 3 is required for the runtime-backed f-string semantics test.');
}

function assertPythonSyntax(files) {
  for (const [path, contents] of Object.entries(files)) {
    const result = runPython("import sys; compile(sys.stdin.read(), '<gate-fixture>', 'exec')", contents);
    assert.equal(result.status, 0, path + ': ' + result.stderr);
  }
}

const nodeAccess = ['process', 'env'].join('.');
const nodeSpacedAccess = ['process', 'env'].join(' . ');
const pythonMapping = ['os', 'environ'].join('.');
const pythonGetter = ['os', 'getenv'].join('.');
const pythonSpacedGetter = ['os', 'getenv'].join(' . ');
const pythonFromOs = ['from', 'os', 'import'].join(' ');
const pythonGetenvName = ['get', 'env'].join('');
const pythonEnvironName = ['envir', 'on'].join('');
const nodeComputedDouble = ['process', '[ "env" ]'].join(' ');
const nodeComputedSingle = ['process', "[ 'env' ]"].join(' ');
const nodeOptionalComputed = ['process', '?.', '[ "env" ]'].join(' ');
const nodeComputedBacktick = ['process', '[', '`env`', ']'].join(' ');
const nodeDestructure = ['const {', 'env: runtimeEnvironment', '} = process;'].join(' ');
const nodeRuntimeAlias = ['const runtime', '=', 'process;'].join(' ');
const nodeRuntimeEnv = ['runtime', 'env'].join('.');
const pythonCombinedAliasImport = ['import sys, os as', 'operating_system'].join(' ');
const nodeProcessModule = ['node:', 'process'].join('');

// @spec AC-1
test('ignores tracked source files deleted from the worktree', () => {
  const root = fixtureRepo({
    'src/deleted.ts': `export const token = ${nodeAccess}.TOKEN;`,
    'src/clean.ts': 'export const answer = 42;',
  });
  rmSync(resolve(root, 'src/deleted.ts'));

  const result = run(root);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passed/);
});
const bareProcessModule = ['pro', 'cess'].join('');

test('allows only the four exact loader paths', () => {
  const root = fixtureRepo({
    'packages/config/src/config.ts': `const x = ${nodeAccess}.SAFE;`,
    'packages/config/src/secrets.ts': `const x = ${nodeSpacedAccess} . SAFE;`,
    'services/workers/sayre_workers/config/config.py': `x = ${pythonMapping}.get("SAFE")`,
    'services/workers/sayre_workers/config/secrets.py': `x = ${pythonSpacedGetter} ("SAFE")`,
  });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
});

// @spec AC-1 AC-2 AC-3 EC-1 EC-2 EC-3 EC-4
test('scans executable TypeScript module extensions without widening the loader allowlist', () => {
  const root = fixtureRepo({
    'src/direct.mts': `const value = ${nodeAccess}.MTS_PRIVATE_VALUE;`,
    'src/direct.cts': `const value = ${nodeAccess}.CTS_PRIVATE_VALUE;`,
    'src/case-insensitive.MTS': `const value = ${nodeAccess}.UPPERCASE_PRIVATE_VALUE;`,
    'src/not-source.mts.txt': `const value = ${nodeAccess}.TEXT_PRIVATE_VALUE;`,
    'packages/config/src/secrets.mts':
      `const value = ${nodeAccess}.UNLISTED_LOADER_PRIVATE_VALUE;`,
  });

  const result = run(root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/direct\.mts:1/);
  assert.match(result.stderr, /src\/direct\.cts:1/);
  assert.match(result.stderr, /src\/case-insensitive\.MTS:1/);
  assert.match(result.stderr, /packages\/config\/src\/secrets\.mts:1/);
  assert.doesNotMatch(result.stderr, /src\/not-source\.mts\.txt/);
  assert.doesNotMatch(result.stderr, /PRIVATE_VALUE/);
  assert.doesNotMatch(result.stderr, /const value/);
});

test('reports every forbidden form with file and line and exits non-zero', () => {
  const root = fixtureRepo({
    'src/node.ts': `const ok = 1;\nconst bad = ${nodeSpacedAccess} . TOKEN;`,
    'tests/mapping.py': `value = ${pythonMapping}["TOKEN"]`,
    'tests/getter.py': `value = ${pythonGetter} ("TOKEN")`,
  });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/node\.ts:2/);
  assert.match(result.stderr, /tests\/mapping\.py:1/);
  assert.match(result.stderr, /tests\/getter\.py:1/);
  assert.doesNotMatch(result.stderr, /TOKEN/);
});

test('blocks computed Node access and Python imported aliases', () => {
  const root = fixtureRepo({
    'src/computed-double.ts': `const value = ${nodeComputedDouble}.SECRET;`,
    'src/computed-single.ts': `const value = ${nodeComputedSingle} ["SECRET"];`,
    'src/computed-optional.ts': `const value = ${nodeOptionalComputed}.SECRET;`,
    'src/computed-backtick.ts': `const value = ${nodeComputedBacktick}.SECRET;`,
    'src/destructure.ts': nodeDestructure,
    'src/process-alias.ts': `${nodeRuntimeAlias}\nconst value = ${nodeRuntimeEnv}.SECRET;`,
    'src/process-alias-computed.ts': `${nodeRuntimeAlias}\nconst value = runtime ${nodeComputedSingle.slice('process'.length)}.SECRET;`,
    'src/from-direct.py': `${pythonFromOs} ${pythonGetenvName}, ${pythonEnvironName}\nx = ${pythonGetenvName}("SECRET")`,
    'src/from-alias.py': `${pythonFromOs} ${pythonGetenvName} as read_value, ${pythonEnvironName} as values\nx = read_value("SECRET")`,
    'src/from-grouped.py': `${pythonFromOs} (\n    ${pythonGetenvName} as read_value,\n    ${pythonEnvironName} as values,\n)\nx = values["SECRET"]`,
    'src/from-continued.py': `${pythonFromOs} path, \\\n    ${pythonGetenvName} as read_value\nx = read_value("SECRET")`,
    'src/from-star.py': `${pythonFromOs} *\nx = ${pythonGetenvName}("SECRET")`,
    'src/module-alias.py': `import os as operating_system\nx = operating_system . ${pythonGetenvName} ("SECRET")\ny = operating_system.${pythonEnvironName}["SECRET"]`,
    'src/module-combined-alias.py': `${pythonCombinedAliasImport}\nx = operating_system.${pythonEnvironName}["SECRET"]`,
  });
  const result = run(root);
  assert.equal(result.status, 1);
  for (const path of [
    'src/computed-double.ts:1',
    'src/computed-single.ts:1',
    'src/computed-optional.ts:1',
    'src/computed-backtick.ts:1',
    'src/destructure.ts:1',
    'src/process-alias.ts:2',
    'src/process-alias-computed.ts:2',
    'src/from-direct.py:1',
    'src/from-alias.py:1',
    'src/from-grouped.py:2',
    'src/from-continued.py:2',
    'src/from-star.py:1',
    'src/module-alias.py:2',
    'src/module-alias.py:3',
    'src/module-combined-alias.py:2',
  ]) {
    assert.match(result.stderr, new RegExp(path.replace('.', '\\.')));
  }
  assert.doesNotMatch(result.stderr, /SECRET/);
});

test('masks Python comments and ordinary string literal families', () => {
  const files = {
    'src/python-comment.py':
      '# os.getenv("SECRET")\n# os.environ["SECRET"]\nvalue = 1',
    'src/python-single.py':
      "text = 'os.getenv(\"SECRET\") and os.environ[\"SECRET\"]'",
    'src/python-double.py':
      'text = "from os import getenv; os.environ[\'SECRET\']"',
    'src/python-triple-single.py':
      "text = '''os.getenv(\"SECRET\")\nfrom os import environ'''",
    'src/python-triple-double.py':
      'text = """import os\nruntime = os\nruntime.getenv(\'SECRET\')"""',
    'src/python-raw.py':
      "text = r'os.getenv(\"SECRET\") and os.environ'",
    'src/python-raw-triple.py':
      'text = R"""from os import getenv\nos.getenv(\'SECRET\')"""',
    'src/python-bytes.py':
      "text = b'os.getenv(\"SECRET\") and os.environ'",
    'src/python-raw-bytes.py':
      'text = br"os.getenv(\'SECRET\')"',
    'src/python-f-literal.py':
      "text = f'os.getenv(\"SECRET\") and os.environ'",
    'src/python-f-escaped-braces.py':
      "text = f'{{os.getenv(\"SECRET\")}}'",
    'src/python-f-format-spec.py':
      "text = f'{value:os.getenv}'",
    'src/python-f-static-format-spec.py':
      'import os\ntext = f"{\'x\': os.getenv(\'SECRET\')}"',
    'src/python-f-escaped-dict-text.py':
      'import os\ntext = f"{{\'x\': os.getenv(\'SECRET\')}}"',
    'src/python-untracked-alias.py':
      "import application\nruntime = application\nvalue = runtime.getenv('SECRET')",
    'src/python-import-lookalike.py':
      "import operating_system\nruntime = operating_system\nvalue = runtime.environ",
  };
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passed/);
});

test('blocks fixed-point Python os aliases and executable f-string expressions', () => {
  const files = {
    'src/python-os-assignment-alias.py':
      "import os\nruntime = os\nvalue = runtime.getenv('SECRET')",
    'src/python-os-chain.py':
      "import os\nruntime = os\nruntime2 = runtime\nvalue = runtime2.environ['SECRET']",
    'src/python-os-annotated-alias.py':
      "import os\nruntime: object = os\nvalue = runtime.getenv('SECRET')",
    'src/python-os-parenthesized-alias.py':
      "import os\nruntime = (os)\nvalue = runtime.environ['SECRET']",
    'src/python-imported-os-alias-chain.py':
      "import sys, os as operating_system\nruntime = operating_system\n" +
      "value = runtime.getenv('SECRET')",
    'src/python-semicolon-alias.py':
      "import os; runtime = os; value = runtime.environ['SECRET']",
    'src/python-f-expression-getenv.py':
      "import os\ntext = f\"value={os.getenv('SECRET')}\"",
    'src/python-f-expression-environ.py':
      "import os\ntext = f\"value={os.environ['SECRET']}\"",
    'src/python-f-alias-expression.py':
      "import os\nruntime = os\ntext = f\"value={runtime.getenv('SECRET')}\"",
    'src/python-raw-f-expression.py':
      "import os\ntext = rf\"value={os.getenv('SECRET')}\"",
    'src/python-triple-f-expression.py':
      "import os\ntext = f\"\"\"value={os.getenv('SECRET')}\"\"\"",
    'src/python-nested-format-expression.py':
      "import os\ntext = f\"{value:{os.getenv('SECRET')}}\"",
    'src/python-commented-f-expression.py':
      'import os\ntext = f"""{os.getenv(\n    # expression comment\n    \'SECRET\'\n)}"""',
  };
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 1);
  for (const path of Object.keys(files)) {
    assert.match(result.stderr, new RegExp(path.replaceAll('.', '\\.')));
  }
  assert.doesNotMatch(result.stderr, /SECRET|expression comment/);
});

test('blocks Unicode Python os import and assignment aliases', () => {
  const files = {
    'src/python-unicode-import-alias.py':
      "import os as π\nvalue = π.getenv('IMPORT_ALIAS')",
    'src/python-unicode-assignment-alias.py':
      "import os\nπ = os\nvalue = π.environ['ASSIGNMENT_ALIAS']",
    'src/python-normalized-import-alias.py':
      "import os as K\nvalue = K.getenv('NORMALIZED_ALIAS')",
  };
  assertPythonSyntax(files);
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 1);
  for (const path of [
    'src/python-unicode-import-alias.py:2',
    'src/python-unicode-assignment-alias.py:3',
    'src/python-normalized-import-alias.py:2',
  ]) {
    assert.match(result.stderr, new RegExp(path.replaceAll('.', '\\.')));
  }
  assert.doesNotMatch(result.stderr, /IMPORT_ALIAS|ASSIGNMENT_ALIAS|NORMALIZED_ALIAS/);
});

test('allows a normal non-os Unicode Python alias', () => {
  const files = {
    'src/python-unicode-control.py':
      "import application as π\nvalue = π.getenv('CONTROL')",
  };
  assertPythonSyntax(files);
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passed/);
});

test('blocks backslash-prefixed f-string fields, inequality, and valid conversions', () => {
  const files = {
    'src/python-raw-f-backslash-field.py':
      'import os\ntext = rf"\\{os.getenv(\'RAW\')}"',
    'src/python-f-backslash-field.py':
      'import os\ntext = f"\\{os.getenv(\'NON_RAW\')}"',
    'src/python-raw-triple-f-backslash-field.py':
      'import os\ntext = rf"""\\{os.getenv(\'RAW_TRIPLE\')}"""',
    'src/python-f-not-equal.py':
      'import os\ntext = f"{False != os.getenv(\'NEQ\')}"',
    'src/python-f-not-equal-alias.py':
      'import os\nruntime = os\ntext = rf"\\{False != runtime.getenv(\'RAW_NEQ\')}"',
    'src/python-f-conversion-string.py':
      'import os\ntext = f"{os.getenv(\'CONVERT_S\')!s}"',
    'src/python-f-conversion-repr.py':
      'import os\ntext = f"{os.getenv(\'CONVERT_R\')!r}"',
    'src/python-f-conversion-ascii.py':
      'import os\ntext = f"{os.getenv(\'CONVERT_A\')!a}"',
    'src/python-f-parenthesized-not-equal-conversion.py':
      'import os\ntext = f"{(False != os.getenv(\'NESTED_NEQ\'))!s}"',
  };
  assertPythonSyntax(files);
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 1);
  for (const path of Object.keys(files)) {
    assert.match(result.stderr, new RegExp(path.replaceAll('.', '\\.')));
  }
  assert.doesNotMatch(result.stderr, /RAW|NEQ|CONVERT/);
});

test('allows non-formatted and doubled-brace backslash controls', () => {
  const files = {
    'src/python-raw-ordinary-backslash.py':
      'text = r"\\{os.getenv(\'ORDINARY_RAW\')}"',
    'src/python-ordinary-backslash.py':
      'text = "\\{os.getenv(\'ORDINARY\')}"',
    'src/python-raw-f-doubled-brace-backslash.py':
      'text = rf"\\{{os.getenv(\'RAW_LITERAL\')}}"',
    'src/python-f-doubled-brace-backslash.py':
      'text = f"\\{{os.getenv(\'LITERAL\')}}"',
    'src/python-operator-text.py':
      "text = 'f\"{False != os.getenv(\"TEXT\")}\"'",
  };
  assertPythonSyntax(files);
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passed/);
});

test('confirms backslash fields and inequality execute while literal controls do not', () => {
  const result = runPython(String.raw`
import json
import os

calls = []
def fake_getenv(name):
    calls.append(name)
    return 'hit'
os.getenv = fake_getenv

raw = rf"\{os.getenv('RAW')}"
non_raw = f"\{os.getenv('NON_RAW')}"
not_equal = f"{False != os.getenv('NEQ')}"
conversion = f"{os.getenv('CONVERSION')!r}"
raw_literal = rf"\{{os.getenv('RAW_LITERAL')}}"
ordinary = r"\{os.getenv('ORDINARY')}"
try:
    literal_format_spec = f"{'x': os.getenv('LITERAL')}"
    literal_format_error = None
except ValueError as error:
    literal_format_spec = None
    literal_format_error = type(error).__name__

print(json.dumps({
    'raw': raw,
    'non_raw': non_raw,
    'not_equal': not_equal,
    'conversion': conversion,
    'raw_literal': raw_literal,
    'ordinary': ordinary,
    'literal_format_spec': literal_format_spec,
    'literal_format_error': literal_format_error,
    'calls': calls,
}))
`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    raw: '\\hit',
    non_raw: '\\hit',
    not_equal: 'True',
    conversion: "'hit'",
    raw_literal: "\\{os.getenv('RAW_LITERAL')}",
    ordinary: "\\{os.getenv('ORDINARY')}",
    literal_format_spec: null,
    literal_format_error: 'ValueError',
    calls: ['RAW', 'NON_RAW', 'NEQ', 'CONVERSION'],
  });
});

test('blocks executable set and dictionary fields inside a Python format spec', () => {
  const files = {
    'src/python-f-format-set-field.py':
      `import os\ntext = f"{'x':{{os.getenv('FORMAT_SET')}}}"`,
    'src/python-f-format-dict-field.py':
      `import os\ntext = f"{'x':{{'k': os.getenv('FORMAT_DICT')}}}"`,
  };
  assertPythonSyntax(files);
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/python-f-format-set-field\.py:2/);
  assert.match(result.stderr, /src\/python-f-format-dict-field\.py:2/);
  assert.doesNotMatch(result.stderr, /FORMAT_SET|FORMAT_DICT/);
});

test('confirms nested format-spec fields execute while literal spec text does not', () => {
  const result = runPython(`
import json
import os

calls = []
def fake_getenv(name):
    calls.append(name)
    return name
os.getenv = fake_getenv

try:
    format_set = f"{'x':{{os.getenv('FORMAT_SET')}}}"
    format_set_error = None
except ValueError as error:
    format_set = None
    format_set_error = type(error).__name__
format_set_calls = list(calls)

calls.clear()
try:
    format_dict = f"{'x':{{'k': os.getenv('FORMAT_DICT')}}}"
    format_dict_error = None
except ValueError as error:
    format_dict = None
    format_dict_error = type(error).__name__
format_dict_calls = list(calls)

calls.clear()
try:
    literal_spec = f"{'x': os.getenv('LITERAL')}"
    literal_spec_error = None
except ValueError as error:
    literal_spec = None
    literal_spec_error = type(error).__name__

print(json.dumps({
    'format_set': format_set,
    'format_set_error': format_set_error,
    'format_set_calls': format_set_calls,
    'format_dict': format_dict,
    'format_dict_error': format_dict_error,
    'format_dict_calls': format_dict_calls,
    'literal_spec': literal_spec,
    'literal_spec_error': literal_spec_error,
    'literal_spec_calls': calls,
}))
`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    format_set: null,
    format_set_error: 'ValueError',
    format_set_calls: ['FORMAT_SET'],
    format_dict: null,
    format_dict_error: 'ValueError',
    format_dict_calls: ['FORMAT_DICT'],
    literal_spec: null,
    literal_spec_error: 'ValueError',
    literal_spec_calls: [],
  });
});

test('blocks explicit-continuation and chained Python os aliases plus real dict expressions', () => {
  const files = {
    'src/python-os-explicit-continuation.py':
      "import os\nruntime = \\\n    os\nvalue = runtime.getenv('SECRET')",
    'src/python-os-crlf-continuation.py':
      "import os\r\nruntime = \\\r\n    os\r\nvalue = runtime.getenv('SECRET')",
    'src/python-os-chained-assignment.py':
      "import os\nruntime2 = runtime = os\nvalue = runtime2.environ['SECRET']",
    'src/python-os-continued-chain.py':
      "import os\nruntime2 = \\\n    runtime = \\\n    os\nvalue = runtime.getenv('SECRET')",
    'src/python-import-alias-continued-chain.py':
      "import os as operating_system\nruntime2 = \\\n    runtime = operating_system\n" +
      "value = runtime2.getenv('SECRET')",
    'src/python-f-dict-expression.py':
      'import os\ntext = f"{ {\'x\': os.getenv(\'SECRET\')} }"',
    'src/python-f-parenthesized-dict-expression.py':
      'import os\ntext = f"{({\'x\': os.getenv(\'SECRET\')})}"',
    'src/python-f-nested-dict-format-expression.py':
      'import os\ntext = f"{value:{ {\'x\': os.getenv(\'SECRET\')} }}"',
  };
  assertPythonSyntax(files);
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 1);
  for (const path of Object.keys(files)) {
    assert.match(result.stderr, new RegExp(path.replaceAll('.', '\\.')));
  }
  assert.doesNotMatch(result.stderr, /SECRET/);
});

test('allows mapping and untracked Python chains across explicit continuations', () => {
  const files = {
    'src/python-mapping-assignment.py':
      "import os\nmapping = {}\nmapping['runtime'] = os\nvalue = mapping['runtime']",
    'src/python-attribute-assignment.py':
      'import os\ncontainer.runtime = os\nvalue = container.runtime',
    'src/python-untracked-chained-assignment.py':
      "import application\nruntime2 = runtime = application\nvalue = runtime2.getenv('SECRET')",
    'src/python-untracked-continuation.py':
      "import application\nruntime = \\\n    application\nvalue = runtime.getenv('SECRET')",
    'src/python-continuation-string-comment.py':
      'text = "runtime = \\\\n os.getenv(\'SECRET\')"\n# runtime = \\\n# os.getenv(\'SECRET\')',
  };
  assertPythonSyntax(files);
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passed/);
});

test('confirms Python f-string format-spec and dict-expression runtime semantics', () => {
  const result = runPython(`
import json
import os

calls = []
def fake_getenv(name):
    calls.append(name)
    return name + '-value'
os.getenv = fake_getenv

try:
    top_level = f"{'x': os.getenv('TOP')}"
    top_error = None
except ValueError as error:
    top_level = None
    top_error = type(error).__name__
top_calls = list(calls)

calls.clear()
escaped_dictionary = f"{{'x': os.getenv('ESCAPED')}}"
escaped_dictionary_calls = list(calls)

calls.clear()
dictionary = f"{ {'x': os.getenv('DICT')} }"
dictionary_calls = list(calls)

class Probe:
    def __format__(self, spec):
        return spec

calls.clear()
nested = f"{Probe():{os.getenv('NESTED')}}"
nested_calls = list(calls)

calls.clear()
nested_dictionary = f"{Probe():{ {'x': os.getenv('NESTED_DICT')} }}"
nested_dictionary_calls = list(calls)

print(json.dumps({
    'top_level': top_level,
    'top_error': top_error,
    'top_calls': top_calls,
    'escaped_dictionary': escaped_dictionary,
    'escaped_dictionary_calls': escaped_dictionary_calls,
    'dictionary': dictionary,
    'dictionary_calls': dictionary_calls,
    'nested': nested,
    'nested_calls': nested_calls,
    'nested_dictionary': nested_dictionary,
    'nested_dictionary_calls': nested_dictionary_calls,
}))
`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    top_level: null,
    top_error: 'ValueError',
    top_calls: [],
    escaped_dictionary: "{'x': os.getenv('ESCAPED')}",
    escaped_dictionary_calls: [],
    dictionary: "{'x': 'DICT-value'}",
    dictionary_calls: ['DICT'],
    nested: 'NESTED-value',
    nested_calls: ['NESTED'],
    nested_dictionary: "{'x': 'NESTED_DICT-value'}",
    nested_dictionary_calls: ['NESTED_DICT'],
  });
});

test('blocks every process-module import, re-export, require, and dynamic-import form', () => {
  const root = fixtureRepo({
    'src/esm-named.ts': `import { env } from '${nodeProcessModule}';\nvoid env;`,
    'src/esm-aliased.ts': `import { env as runtimeEnvironment } from '${bareProcessModule}';\nvoid runtimeEnvironment;`,
    'src/esm-default.ts': `import processModule from '${nodeProcessModule}';\nvoid processModule;`,
    'src/esm-namespace.ts': `import * as processModule from '${bareProcessModule}';\nvoid processModule;`,
    'src/esm-side-effect.ts': `import '${nodeProcessModule}';`,
    'src/reexport-named.ts': `export { env as runtimeEnvironment } from '${bareProcessModule}';`,
    'src/reexport-star.ts': `export * from '${nodeProcessModule}';`,
    'src/cjs-destructure.cjs': `const { env } = require('${nodeProcessModule}');\nvoid env;`,
    'src/cjs-alias.cjs': `const processModule = require('${bareProcessModule}');\nvoid processModule;`,
    'src/cjs-default.cjs': `const processModule = require('${nodeProcessModule}').default;\nvoid processModule;`,
    'src/dynamic-destructure.mjs': `const { env } = await import('${nodeProcessModule}');\nvoid env;`,
    'src/dynamic-alias.mjs': `const processModule = await import('${bareProcessModule}');\nvoid processModule;`,
    'src/dynamic-default.mjs': `const { default: processModule } = await import('${nodeProcessModule}');\nvoid processModule;`,
  });
  const result = run(root);
  assert.equal(result.status, 1);
  for (const path of [
    'src/esm-named.ts:1',
    'src/esm-aliased.ts:1',
    'src/esm-default.ts:1',
    'src/esm-namespace.ts:1',
    'src/esm-side-effect.ts:1',
    'src/reexport-named.ts:1',
    'src/reexport-star.ts:1',
    'src/cjs-destructure.cjs:1',
    'src/cjs-alias.cjs:1',
    'src/cjs-default.cjs:1',
    'src/dynamic-destructure.mjs:1',
    'src/dynamic-alias.mjs:1',
    'src/dynamic-default.mjs:1',
  ]) {
    assert.match(result.stderr, new RegExp(path.replace('.', '\\.')));
  }
});

test('blocks block-comment and line-comment separators across every Node access family', () => {
  const files = {};
  const blockSeparated = (...tokens) => tokens.join('/* gate split\ncontinues */');
  const lineSeparated = (...tokens) => tokens.join('// gate split\n');
  const moduleLiteral = (name) => "'" + name + "'";
  const tick = String.fromCharCode(96);

  function addCommentPair(label, extension, factory) {
    files['src/' + label + '-block.' + extension] = factory(blockSeparated);
    files['src/' + label + '-line.' + extension] = factory(lineSeparated);
  }

  addCommentPair(
    'direct',
    'ts',
    (separate) => 'const value = ' + separate('process', '.', 'env') + '.SECRET;',
  );
  addCommentPair(
    'computed',
    'ts',
    (separate) =>
      'const value = ' + separate('process', '[', '"env"', ']') + '.SECRET;',
  );
  addCommentPair(
    'destructured',
    'ts',
    (separate) =>
      separate('const', '{ env: runtimeEnvironment }', '=', 'process') +
      '; void runtimeEnvironment;',
  );
  addCommentPair(
    'aliased',
    'ts',
    (separate) =>
      separate('const', 'runtime', '=', 'process') +
      ';\nconst value = ' +
      separate('runtime', '.', 'env') +
      '.SECRET;',
  );
  addCommentPair(
    'template-expression',
    'ts',
    (separate) =>
      'const value = ' +
      tick +
      'prefix $' +
      '{' +
      separate('process', '.', 'env') +
      '.SECRET}' +
      tick +
      ';',
  );
  addCommentPair(
    'esm-named',
    'ts',
    (separate) =>
      separate('import', '{ env as runtimeEnvironment }', 'from', moduleLiteral(nodeProcessModule)) +
      '; void runtimeEnvironment;',
  );
  addCommentPair(
    'esm-default',
    'ts',
    (separate) =>
      separate('import', 'processModule', 'from', moduleLiteral(bareProcessModule)) +
      '; void processModule;',
  );
  addCommentPair(
    'esm-namespace',
    'ts',
    (separate) =>
      separate('import', '*', 'as', 'processModule', 'from', moduleLiteral(nodeProcessModule)) +
      '; void processModule;',
  );
  addCommentPair(
    'esm-side-effect',
    'ts',
    (separate) => separate('import', moduleLiteral(bareProcessModule)) + ';',
  );
  addCommentPair(
    'reexport',
    'ts',
    (separate) =>
      separate('export', '{ env as runtimeEnvironment }', 'from', moduleLiteral(nodeProcessModule)) +
      ';',
  );
  addCommentPair(
    'cjs-destructured',
    'cjs',
    (separate) =>
      separate(
        'const',
        '{ env: runtimeEnvironment }',
        '=',
        'require',
        '(',
        moduleLiteral(bareProcessModule),
        ')',
      ) + '; void runtimeEnvironment;',
  );
  addCommentPair(
    'cjs-aliased',
    'cjs',
    (separate) =>
      separate(
        'const',
        'processModule',
        '=',
        'require',
        '(',
        moduleLiteral(nodeProcessModule),
        ')',
      ) + '; void processModule;',
  );
  addCommentPair(
    'cjs-default',
    'cjs',
    (separate) =>
      separate(
        'const',
        'processModule',
        '=',
        'require',
        '(',
        moduleLiteral(bareProcessModule),
        ')',
        '.',
        'default',
      ) + '; void processModule;',
  );
  addCommentPair(
    'dynamic-destructured',
    'mjs',
    (separate) =>
      separate(
        'const',
        '{ env: runtimeEnvironment }',
        '=',
        'await',
        'import',
        '(',
        moduleLiteral(nodeProcessModule),
        ')',
      ) + '; void runtimeEnvironment;',
  );
  addCommentPair(
    'dynamic-aliased',
    'mjs',
    (separate) =>
      separate(
        'const',
        'processModule',
        '=',
        'await',
        'import',
        '(',
        moduleLiteral(bareProcessModule),
        ')',
      ) + '; void processModule;',
  );
  addCommentPair(
    'dynamic-default',
    'mjs',
    (separate) =>
      separate(
        'const',
        '{ default: processModule }',
        '=',
        'await',
        'import',
        '(',
        moduleLiteral(nodeProcessModule),
        ')',
      ) + '; void processModule;',
  );

  const result = run(fixtureRepo(files));
  assert.equal(result.status, 1);
  for (const path of Object.keys(files)) {
    assert.match(result.stderr, new RegExp(path.replaceAll('.', '\\.')));
  }
  assert.doesNotMatch(result.stderr, /SECRET/);
});

test('ignores forbidden-looking Node text confined to comments, strings, and template text', () => {
  const directText = nodeAccess + '.SECRET';
  const importText =
    'import { env as runtimeEnvironment } from ' + "'" + nodeProcessModule + "';";
  const requireText = 'require(' + "'" + bareProcessModule + "'" + ')';
  const tick = String.fromCharCode(96);
  const root = fixtureRepo({
    'src/comment-only.ts':
      '// ' + directText + '\n/* ' + importText + '\n' + requireText + ' */\nexport const ok = 1;',
    'src/string-only.ts':
      'const direct = ' +
      JSON.stringify(directText) +
      ';\nconst imported = ' +
      JSON.stringify(importText) +
      ';\nconst required = ' +
      JSON.stringify(requireText) +
      ';',
    'src/template-text-only.ts':
      'const text = ' + tick + directText + '\n' + importText + '\n' + requireText + tick + ';',
  });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passed/);
});

test('blocks exact global misses plus optional, assigned, and destructured alias chains', () => {
  const files = {
    'src/exact-computed-process.ts': "globalThis['process'].env.SECRET;",
    'src/exact-computed-both.ts': "globalThis['process']['env'].SECRET;",
    'src/exact-root-alias.ts':
      "const root = globalThis; root['process']['env'].SECRET;",
    'src/exact-parenthesized.ts': '(globalThis.process).env.SECRET;',
    'src/exact-global.ts': "global['process']['env'].SECRET;",
    'src/optional-global.ts': "globalThis?.['process']?.['env'].SECRET;",
    'src/optional-global-dot.ts': 'global?.process?.env.SECRET;',
    'src/parenthesized-computed.ts':
      "((globalThis).process)?.['env'].SECRET;",
    'src/fixed-point-declaration.ts':
      'const root = globalThis; const root2 = root; const proc = root2.process; ' +
      'const proc2 = proc; proc2.env.SECRET;',
    'src/fixed-point-assignment.ts':
      "let root; root = global; let proc; proc = root['process']; " +
      "proc['env'].SECRET;",
    'src/destructured-declaration.ts':
      'const { process: proc } = globalThis; const { env: runtimeEnvironment } = proc;',
    'src/destructured-assignment.ts':
      'let proc; ({ process: proc } = global); ' +
      'let runtimeEnvironment; ({ env: runtimeEnvironment } = proc);',
    'src/nested-destructuring.ts':
      'const { process: { env: runtimeEnvironment } } = globalThis;',
    'src/bare-process-assignment-alias.ts':
      "let proc; proc = process; proc['env'].SECRET;",
    'src/dollar-alias-chain.ts':
      'const $root = globalThis; const $proc = $root.process; $proc.env.SECRET;',
  };
  assertNodeSyntax(files);
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 1);
  for (const path of Object.keys(files)) {
    assert.match(result.stderr, new RegExp(path.replaceAll('.', '\\.')));
  }
  assert.doesNotMatch(result.stderr, /SECRET/);
});

test('blocks recursive static-key global and process destructuring', () => {
  const tick = String.fromCharCode(96);
  const files = {
    'src/exact-nested-assignment.ts':
      'let e; ({process:{env:e}}=globalThis); void e;',
    'src/exact-computed-process.ts':
      "const {['process']:p}=globalThis; p.env.X;",
    'src/exact-quoted-process.ts':
      "const {'process':p}=globalThis; p.env.X;",
    'src/double-quoted-process.ts':
      'const {"process": processAlias}=global; processAlias["env"].X;',
    'src/backtick-computed-process.ts':
      'const {[' + tick + 'process' + tick + ']: processAlias}=globalThis; ' +
      'processAlias.env.X;',
    'src/escaped-quoted-process.ts':
      "const {'pro\\u0063ess': processAlias}=globalThis; processAlias.env.X;",
    'src/escaped-computed-env.ts':
      "const {process: processAlias}=globalThis; const {['\\x65nv']: e}=processAlias; void e;",
    'src/global-alias-static-pattern.ts':
      "const root=globalThis; const {'process':p}=root; const {'env':e}=p; void e;",
    'src/assignment-static-pattern.ts':
      "let p; ({['process']:p}=global); let e; ({['env']:e}=p); void e;",
    'src/default-and-rest.ts':
      'const {process: p = process, ...remainingGlobals}=globalThis; ' +
      'const {env: e = {}, ...remainingProcess}=p; void e; void remainingGlobals; ' +
      'void remainingProcess;',
    'src/nested-default-and-rest.ts':
      'const {process: {env: e = {}, ...processRest} = {}, ...globalRest}=globalThis; ' +
      'void e; void processRest; void globalRest;',
    'src/process-alias-shorthand-env.ts':
      'const root=globalThis; const {process:p}=root; const {env}=p; void env;',
  };
  assertNodeSyntax(files);
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 1);
  for (const path of Object.keys(files)) {
    assert.match(result.stderr, new RegExp(path.replaceAll('.', '\\.')));
  }
  assert.doesNotMatch(result.stderr, /remainingGlobals|remainingProcess|processRest|globalRest/);
});

test('blocks comment-separated recursive static-key destructuring', () => {
  const files = {};
  const blockSeparated = (...tokens) => tokens.join('/* pattern split\ncontinues */');
  const lineSeparated = (...tokens) => tokens.join('// pattern split\n');

  for (const [kind, separate] of [
    ['block', blockSeparated],
    ['line', lineSeparated],
  ]) {
    files['src/nested-assignment-' + kind + '.ts'] =
      'let e; ' +
      separate('(', '{', 'process', ':', '{', 'env', ':', 'e', '}', '}', '=', 'globalThis', ')') +
      '; void e;';
    files['src/computed-process-' + kind + '.ts'] =
      separate('const', '{', '[', "'process'", ']', ':', 'p', '}', '=', 'globalThis') +
      '; ' +
      separate('p', '.', 'env') +
      '.X;';
    files['src/quoted-process-' + kind + '.ts'] =
      separate('const', '{', "'process'", ':', 'p', '}', '=', 'global') +
      '; ' +
      separate('p', '[', "'env'", ']') +
      '.X;';
  }

  assertNodeSyntax(files);
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 1);
  for (const path of Object.keys(files)) {
    assert.match(result.stderr, new RegExp(path.replaceAll('.', '\\.')));
  }
});

test('blocks TypeScript annotations, assertions, non-null access, and escaped static keys', () => {
  const files = {
    'src/typed-process-destructure.ts':
      'const {env}: {env: Record<string, string | undefined>} = process; void env;',
    'src/typed-global-destructure.ts':
      'const {process: runtime}: {process: NodeJS.Process} = globalThis; runtime.env.X;',
    'src/typed-nested-destructure.ts':
      'const {process: {env: runtimeEnvironment}}: ' +
      '{process: {env: NodeJS.ProcessEnv}} = globalThis; void runtimeEnvironment;',
    'src/as-assertion.ts': '(process as NodeJS.Process).env.X;',
    'src/chained-as-assertion.ts':
      '(process as unknown as NodeJS.Process).env.X;',
    'src/satisfies-assertion.ts':
      '(process satisfies NodeJS.Process).env.X;',
    'src/angle-assertion.ts': '(<NodeJS.Process>process).env.X;',
    'src/non-null-process.ts': 'process!.env.X;',
    'src/parenthesized-non-null-process.ts': '(process!)!["env"].X;',
    'src/escaped-hex-env.ts': "process['\\x65nv'].X;",
    'src/escaped-unicode-env.ts': 'process["\\u0065nv"].X;',
    'src/escaped-codepoint-env.ts': "process['\\u{65}nv'].X;",
    'src/escaped-global-chain.ts':
      "globalThis['\\x70rocess']['\\x65nv'].X;",
    'src/typed-alias.ts':
      'const runtime: NodeJS.Process = process; runtime.env.X;',
    'src/rhs-as-alias.ts':
      'const runtime = process as NodeJS.Process; runtime.env.X;',
    'src/rhs-satisfies-alias.ts':
      'const runtime = process satisfies NodeJS.Process; runtime.env.X;',
    'src/rhs-angle-alias.ts':
      'const runtime = <NodeJS.Process>process; runtime.env.X;',
    'src/adjacent-typed-alias-chain.ts':
      'const root: typeof globalThis = globalThis; ' +
      'const runtime: NodeJS.Process = root.process; runtime.env.X;',
  };
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 1);
  for (const path of Object.keys(files)) {
    assert.match(result.stderr, new RegExp(path.replaceAll('.', '\\.')));
  }
  assert.doesNotMatch(result.stderr, /NodeJS|Record|unknown/);
});

test('blocks Unicode-escaped IdentifierNames and wrappers around global-process expressions', () => {
  const syntaxFiles = {
    'src/unicode-properties.js':
      'globalThis.\\u0070rocess.\\u0065nv.X;',
    'src/unicode-codepoint-properties.js':
      'globalThis.\\u{70}rocess.\\u{65}nv.X;',
    'src/unicode-root-and-properties.js':
      '\\u0067lobalThis.\\u0070rocess.\\u0065nv.X;',
    'src/unicode-alias.js':
      'const r\\u0075ntime = globalThis.\\u0070rocess; r\\u0075ntime.\\u0065nv.X;',
    'src/unicode-destructuring.js':
      'const {\\u0070rocess: runtime}=globalThis; const {\\u0065nv:e}=runtime; void e;',
  };
  assertNodeSyntax(syntaxFiles);
  const files = {
    ...syntaxFiles,
    'src/global-as-wrapper.ts':
      '(globalThis as typeof globalThis).process.env.X;',
    'src/global-satisfies-wrapper.ts':
      '(globalThis satisfies typeof globalThis)!.process.env.X;',
    'src/global-chained-wrapper.ts':
      '((globalThis as unknown as typeof globalThis)!).process.env.X;',
    'src/global-complex-type-wrapper.ts':
      '((globalThis as unknown) satisfies (typeof globalThis & object))!.process.env.X;',
    'src/process-expression-wrapper.ts':
      '(globalThis.process as unknown as NodeJS.Process)!.env.X;',
    'src/process-generic-type-wrapper.ts':
      '(globalThis.process satisfies Readonly<NodeJS.Process>)!.env.X;',
    'src/wrapped-global-alias.ts':
      'const root = (globalThis as typeof globalThis)!; ' +
      'const runtime = (root.process satisfies NodeJS.Process)!; runtime.env.X;',
    'src/wrapped-process-alias-use.ts':
      'const runtime = (globalThis.process as NodeJS.Process)!; ' +
      '(runtime as unknown as NodeJS.Process)!.env.X;',
    'src/unparenthesized-chained-alias.ts':
      'const root = globalThis as unknown as typeof globalThis; ' +
      'const runtime = root.process as unknown as NodeJS.Process; runtime!.env.X;',
    'src/angle-and-chained-alias.ts':
      'const runtime = (<NodeJS.Process>(<typeof globalThis>globalThis).process)!; ' +
      '(<NodeJS.Process>runtime)!.env.X;',
    'src/wrapped-process-destructure.ts':
      'const {env: runtimeEnvironment} = (globalThis.process as NodeJS.Process)!; ' +
      'void runtimeEnvironment;',
    'src/wrapped-global-destructure.ts':
      'const {process: runtime} = (globalThis satisfies typeof globalThis)!; ' +
      '(runtime satisfies NodeJS.Process)!.env.X;',
  };
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 1);
  for (const path of Object.keys(files)) {
    assert.match(result.stderr, new RegExp(path.replaceAll('.', '\\.')));
  }
  assert.doesNotMatch(result.stderr, /NodeJS|unknown|runtimeEnvironment/);
});

test('blocks non-ASCII IdentifierName aliases across every fixed-point path', () => {
  const syntaxFiles = {
    'src/non-ascii-escaped-alias.js':
      'const \\u03c0 = process; \\u03c0.env.X;',
    'src/non-ascii-codepoint-alias.ts':
      'const \\u{3c3} = process; \\u{3c3}["env"].X;',
    'src/non-ascii-raw-alias.js':
      'const π = process; π.env.X;',
    'src/non-ascii-astral-alias.js':
      'const \\u{10400} = process; \\u{10400}.env.X;',
    'src/non-ascii-global-chain.ts':
      'const \\u03c0 = globalThis; const \\u03c3 = \\u03c0.process; \\u03c3.env.X;',
    'src/non-ascii-assignment.js':
      'let \\u03c0; \\u03c0 = process; \\u03c0.env.X;',
    'src/non-ascii-destructure.ts':
      'const {process: \\u03c0} = globalThis; \\u03c0.env.X;',
  };
  assertNodeSyntax(syntaxFiles);
  const files = {
    ...syntaxFiles,
    'src/non-ascii-typed-alias.ts':
      'const π: NodeJS.Process = process; π.env.X;',
    'src/non-ascii-wrapped-alias.ts':
      'const \\u03c0 = process as NodeJS.Process; (\\u03c0 as NodeJS.Process).env.X;',
  };
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 1);
  for (const path of Object.keys(files)) {
    assert.match(result.stderr, new RegExp(path.replaceAll('.', '\\.')));
  }
  assert.doesNotMatch(result.stderr, /NodeJS|\.X/);
});

test('keeps non-ASCII aliases precise in strings, regexes, comments, and unrelated code', () => {
  const files = {
    'src/non-ascii-string.js':
      'const text = "const \\\\u03c0 = process; \\\\u03c0.env.X"; void text;',
    'src/non-ascii-regex.js':
      'const pattern = /const \\u03c0 = process; π\\.env/; void pattern;',
    'src/non-ascii-comment.js':
      '// const \\u03c0 = process; \\u03c0.env.X;\nconst value = 1;',
    'src/non-ascii-untracked.js':
      'const \\u03c0 = application; \\u03c0.env.X;',
    'src/non-ascii-process-property.js':
      'const value = process.π; void value;',
    'src/non-ascii-env-prefix.js':
      'const value = process.envπ; void value;',
    'src/non-ascii-related-alias.js':
      'const πprocess = application; πprocess.env.X;',
    'src/non-ascii-process-alias-pid.js':
      'const π = process; const value = π.pid; void value;',
  };
  assertNodeSyntax(files);
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passed/);
});

test('maps canonicalized JavaScript diagnostics to only their original physical lines', () => {
  const files = {
    'src/unicode-offset.js':
      'const \\u03c0 = application;\nvoid \\u03c0;\nconst value = 1;\nprocess.env.X;',
    'src/unicode-offset.ts':
      'const \\u{10400} = application;\nvoid \\u{10400};\nconst value = 1;\nprocess.env.X;',
  };
  assertNodeSyntax(files);
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 1);
  for (const path of Object.keys(files)) {
    const escapedPath = path.replaceAll('.', '\\.');
    assert.deepEqual(result.stderr.match(new RegExp(escapedPath + ':\\d+', 'g')), [path + ':4']);
  }
  assert.doesNotMatch(result.stderr, /\.X/);
});

test('allows TypeScript wrappers and static keys that do not select an environment', () => {
  const files = {
    'src/as-process-pid.ts': 'const pid = (process as NodeJS.Process).pid; void pid;',
    'src/non-null-process-pid.ts': 'const pid = process!.pid; void pid;',
    'src/escaped-static-pid.ts': "const pid = process['\\x70id']; void pid;",
    'src/typed-process-pid-destructure.ts':
      'const {pid}: {pid: number} = process; void pid;',
    'src/untracked-typed-alias.ts':
      'const runtime: ApplicationRuntime = application; runtime.env.X;',
    'src/untracked-as-assertion.ts': '(application as ApplicationRuntime).env.X;',
    'src/untracked-satisfies.ts':
      '(application satisfies ApplicationRuntime).env.X;',
    'src/dynamic-process-key.ts':
      'const key: string = chooseKey(); const value = process[key]; void value;',
    'src/typed-global-location.ts':
      'const root: typeof globalThis = globalThis; const location = root.location; void location;',
    'src/typed-text-controls.ts':
      "const text = '(process as NodeJS.Process).env.X'; " +
      'const pattern = /process!\\.env/; void text; void pattern;',
  };
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passed/);
});

test('allows escaped IdentifierNames and wrapper chains that select unrelated properties', () => {
  const syntaxFiles = {
    'src/unicode-process-pid.js': 'process.\\u0070id;',
    'src/unicode-global-location.js': 'globalThis.\\u006cocation;',
    'src/unicode-untracked-env.js': 'application.\\u0065nv.X;',
    'src/unicode-text.js':
      'const text = "globalThis.\\\\u0070rocess.\\\\u0065nv.X"; ' +
      'const pattern = /globalThis\\.\\\\u0070rocess\\.\\\\u0065nv/; void text; void pattern;',
  };
  assertNodeSyntax(syntaxFiles);
  const files = {
    ...syntaxFiles,
    'src/wrapped-global-location.ts':
      'const root = ((globalThis as unknown) satisfies typeof globalThis)!; ' +
      'const location = root.location; void location;',
    'src/wrapped-process-pid.ts':
      'const runtime = (globalThis.process as unknown as NodeJS.Process)!; ' +
      'const pid = (runtime satisfies NodeJS.Process)!.pid; void pid;',
    'src/wrapped-untracked-env.ts':
      'const runtime = (application as unknown as ApplicationRuntime)!; ' +
      '(runtime satisfies ApplicationRuntime)!.env.X;',
    'src/process-call-result-env.ts':
      'consume(process).env.X; consume(globalThis.process).env.X;',
    'src/grouped-process-call-result-env.ts':
      'consume((process as NodeJS.Process)).env.X; ' +
      'consume(((globalThis.process satisfies NodeJS.Process)!)).env.X;',
    'src/process-call-result-alias.ts':
      'const runtime = consume((process as NodeJS.Process)!); runtime.env.X;',
  };
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passed/);
});

test('blocks block and line comment variants of all five reported global misses', () => {
  const files = {};
  const blockSeparated = (...tokens) => tokens.join('/* global split\ncontinues */');
  const lineSeparated = (...tokens) => tokens.join('// global split\n');

  function addPair(label, factory) {
    files['src/' + label + '-block.ts'] = factory(blockSeparated);
    files['src/' + label + '-line.ts'] = factory(lineSeparated);
  }

  addPair(
    'reported-computed-process',
    (separate) =>
      separate('globalThis', '[', "'process'", ']', '.', 'env') + '.SECRET;',
  );
  addPair(
    'reported-computed-both',
    (separate) =>
      separate('globalThis', '[', "'process'", ']', '[', "'env'", ']') +
      '.SECRET;',
  );
  addPair(
    'reported-root-alias',
    (separate) =>
      separate('const', 'root', '=', 'globalThis') +
      ';\n' +
      separate('root', '[', "'process'", ']', '[', "'env'", ']') +
      '.SECRET;',
  );
  addPair(
    'reported-parenthesized',
    (separate) =>
      separate('(', 'globalThis', '.', 'process', ')', '.', 'env') + '.SECRET;',
  );
  addPair(
    'reported-global',
    (separate) =>
      separate('global', '[', "'process'", ']', '[', "'env'", ']') + '.SECRET;',
  );
  addPair(
    'global-process-alias-chain',
    (separate) =>
      separate('const', 'root', '=', 'globalThis') +
      ';\n' +
      separate('const', 'proc', '=', 'root', '[', "'process'", ']') +
      ';\n' +
      separate('proc', '[', "'env'", ']') +
      '.SECRET;',
  );

  assertNodeSyntax(files);
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 1);
  for (const path of Object.keys(files)) {
    assert.match(result.stderr, new RegExp(path.replaceAll('.', '\\.')));
  }
  assert.doesNotMatch(result.stderr, /SECRET/);
});

test('allows global and process aliases that never reach environment access', () => {
  const files = {
      'src/global-location.ts': 'const location = globalThis.location; void location;',
      'src/global-property.ts': 'const value = global.foo; void value;',
      'src/root-location.ts':
        'const root = globalThis; const location = root.location; void location;',
      'src/process-pid.ts':
        'const root = globalThis; const proc = root.process; const pid = proc.pid; void pid;',
      'src/process-title.ts':
        "let root; root = global; let proc; proc = root['process']; proc.title = 'worker';",
      'src/destructured-process-version.ts':
        'const { process: proc } = globalThis; const version = proc.version; void version;',
      'src/dynamic-global-key.ts':
        'const key = chooseKey(); const {[key]: maybeProcess}=globalThis; ' +
        'maybeProcess.env.X;',
      'src/dynamic-process-key.ts':
        'const key = chooseKey(); const {[key]: maybeEnvironment}=process; ' +
        'void maybeEnvironment;',
      'src/static-process-key-from-untracked-source.ts':
        "const {'process': proc}=applicationState; proc.env.X;",
      'src/non-process-static-key.ts':
        "const {['processId']: proc}=globalThis; proc.env.X;",
      'src/non-env-static-key.ts':
        "const {'pid': environment}=process; void environment;",
      'src/global-pattern-rest-control.ts':
        'const {location, ...remainingGlobals}=globalThis; void location; ' +
        'void remainingGlobals;',
    };
  assertNodeSyntax(files);
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passed/);
});

test('masks regex literals in assignment, return, calls, control flow, and templates', () => {
  const tick = String.fromCharCode(96);
  const files = {
    'src/regex-assignment.ts':
      "const direct = /process.env.SECRET/dg; " +
      "const imported = /import { env } from 'node:process'/i; " +
      "const required = /require('process')/m; void direct; void imported; void required;",
    'src/regex-escapes-classes.ts':
      "const pattern = /[/'\"]+process.env\\/SECRET[/'\"]/gimsuy; void pattern;",
    'src/regex-return.ts':
      'function pattern() { return /process.env.SECRET/giu; } void pattern;',
    'src/regex-call.ts':
      "consume(/require('node:process')/g);",
    'src/regex-arrow-ternary.ts':
      "const make = () => /process.env.SECRET/v; " +
      "const chosen = ok ? /process.env.SECRET/ : /require('process')/; void make; void chosen;",
    'src/regex-control.ts':
      'if (enabled) /process.env.SECRET/.test(input);',
    'src/regex-template-expression.ts':
      'const matched = ' +
      tick +
      'result=$' +
      '{/process.env.SECRET/.test(input)}' +
      tick +
      '; void matched;',
    'src/division-clean.ts':
      'let ratio = total / count; ratio /= scale; const nested = (total + offset) / count;',
  };
  assertNodeSyntax(files);
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passed/);
});

test('masks regex expression statements at all reported block and ASI boundaries', () => {
  const files = {
    'src/regex-after-if-block.ts':
      "if (true) {} /process.env.SECRET/.test('x');",
    'src/regex-after-standalone-block.ts':
      "{} /process.env.SECRET/.test('x');",
    'src/regex-after-function-declaration.ts':
      "function f() {} /process.env.SECRET/.test('x');",
    'src/regex-after-class-declaration.ts':
      "class C {} /process.env.SECRET/.test('x');",
    'src/regex-after-try-catch.ts':
      "try {} catch {} /process.env.SECRET/.test('x');",
    'src/regex-after-switch.ts':
      "switch (1) { default: break; } /process.env.SECRET/.test('x');",
    'src/regex-after-break-asi.ts':
      "while (true) { break\n/process.env.SECRET/.test('x'); }",
    'src/regex-after-continue-asi.ts':
      "while (true) { continue\n/process.env.SECRET/.test('x'); }",
    'src/regex-after-debugger-asi.ts':
      "debugger\n/process.env.SECRET/.test('x');",
  };
  assertNodeSyntax(files);
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passed/);
});

test('honors ASI line terminators inside block comments', () => {
  const files = {
    'src/regex-after-break-comment-asi.ts':
      "while (true) { break/* boundary\ncontinues */ /process.env.SECRET/.test('x'); }",
    'src/regex-after-continue-comment-asi.ts':
      "while (true) { continue/* boundary\ncontinues */ /process.env.SECRET/.test('x'); }",
    'src/regex-after-debugger-comment-asi.ts':
      "debugger/* boundary\ncontinues */ /process.env.SECRET/.test('x');",
  };
  assertNodeSyntax(files);
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passed/);
});

test('keeps division after object, function, and class expressions as code', () => {
  const files = {
    'src/division-direct-object-expression.ts':
      'const ratio = {value: total} / process.env.DENOMINATOR / scale;',
    'src/division-direct-function-expression.ts':
      'const ratio = function () {} / process.env.DENOMINATOR / scale;',
    'src/division-direct-class-expression.ts':
      'const ratio = class {} / process.env.DENOMINATOR / scale;',
    'src/division-after-object-expression.ts':
      'const ratio = ({value: total}).value / process.env.DENOMINATOR / scale;',
    'src/division-after-function-expression.ts':
      'const ratio = (function () { return total; })() / process.env.DENOMINATOR / scale;',
    'src/division-after-class-expression.ts':
      'const ratio = (class { static value = total; }).value / ' +
      'process.env.DENOMINATOR / scale;',
    'src/division-after-arrow-object-expression.ts':
      'const ratio = (() => ({value: total}))().value / process.env.DENOMINATOR / scale;',
  };
  assertNodeSyntax(files);
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 1);
  for (const path of Object.keys(files)) {
    assert.match(result.stderr, new RegExp(path.replaceAll('.', '\\.')));
  }
  assert.doesNotMatch(result.stderr, /DENOMINATOR/);
});

test('keeps division as code and still catches real environment reads around it', () => {
  const files = {
    'src/division-after-env.ts': 'const ratio = process.env.NUMERATOR / 2;',
    'src/division-before-env.ts': 'const ratio = total / process.env.DENOMINATOR;',
    'src/division-after-parens.ts':
      'const ratio = (total + offset) / process.env.DENOMINATOR;',
    'src/division-chain.ts':
      'const ratio = total / 2 / process.env.DENOMINATOR;',
  };
  assertNodeSyntax(files);
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 1);
  for (const path of Object.keys(files)) {
    assert.match(result.stderr, new RegExp(path.replaceAll('.', '\\.')));
  }
  assert.doesNotMatch(result.stderr, /NUMERATOR|DENOMINATOR/);
});

test('ignores tracked generated, dependency, cache, build, and coverage paths', () => {
  const files = {};
  for (const path of [
    'node_modules/a.js',
    '.venv/a.py',
    'venv/a.py',
    '__pycache__/a.py',
    'dist/a.js',
    'build/a.js',
    'coverage/a.js',
    'generated/a.ts',
    'vendor/a.py',
  ]) {
    files[path] = path.endsWith('.py') ? `x = ${pythonMapping}` : `x = ${nodeAccess}.TOKEN`;
  }
  const result = run(fixtureRepo(files));
  assert.equal(result.status, 0, result.stderr);
});

test('clean tracked sources pass', () => {
  const result = run(
    fixtureRepo({
      'src/clean.ts': 'export const answer = 42;',
      'src/clean-process.ts': `${nodeRuntimeAlias}\nconst value = runtime.pid;\nconst platform = process["platform"];`,
      'src/clean-process-label.ts': `const label = '${bareProcessModule}';\nexport { label };`,
      'src/clean-process-helper.ts': `import helper from '${bareProcessModule}-helper';\nvoid helper;`,
      'src/clean.py': `${pythonFromOs} path\n${pythonFromOs} path as ${pythonGetenvName}\nvalue = ${pythonGetenvName}.join("a", "b")`,
      'src/clean-alias.py': 'import os as operating_system\nvalue = operating_system.name',
      'src/clean-combined-alias.py': `${pythonCombinedAliasImport}\nvalue = operating_system.name`,
    }),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passed/);
});

test('runs the built-in-only production gate and fixtures before npm ci', () => {
  const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
  const gate = workflow.indexOf('- name: Secret-access boundary');
  const install = workflow.indexOf('- name: Install dependencies (root, single pass)');
  assert.notEqual(gate, -1, 'secret-access boundary step is missing');
  assert.notEqual(install, -1, 'npm ci step is missing');
  assert.ok(gate < install, 'secret-access boundary must run before npm ci');
  assert.match(
    workflow.slice(gate, install),
    /npm run check:secret-access && npm run test:secret-access/,
  );
});
