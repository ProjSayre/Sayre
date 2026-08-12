#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const ALLOWLIST = new Set([
  'packages/config/src/config.ts',
  'packages/config/src/secrets.ts',
  'services/workers/sayre_workers/config/config.py',
  'services/workers/sayre_workers/config/secrets.py',
  // Controlled child-process env injection IS the tested behavior: the [C4-mirror]
  // cases point TMP/TEMP/TMPDIR inside the checkout for the spawned guard while
  // inheriting PATH/SystemRoot from the parent via `{ ...process.env, ...env }`.
  // No per-name loader can express "inherit the parent environment". Reads no
  // secret-class values. Same precedent as jiraConnectionStore.rls.test.ts on
  // the org-secret-access gate (7981c21).
  'scripts/guard-checker-readonly.test.mjs',
  // dict(os.environ): a cross-runtime test harness spawns a real Node subprocess and must
  // hand it the parent's full environment (PATH, etc.) -- no per-name loader can express
  // "inherit the parent environment". The three genuinely config-backed values
  // (SQS_ENDPOINT_URL, SNS_ENDPOINT_URL, AWS_REGION) already route through get_config();
  // the two AWS credential names left as direct os.environ reads are LocalStack-only dummy
  // values ("localstack-test") the test fixture sets itself, never a real secret store, and
  // have no synchronous secrets-loader accessor available in a test harness. Same precedent
  // as scripts/guard-checker-readonly.test.mjs above.
  'services/workers/tests/test_cross_runtime_roundtrip.py',
]);

const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/i;
const EXCLUDED_SEGMENT = /(?:^|\/)(?:node_modules|\.venv|venv|__pycache__|dist|build|coverage|generated|vendor)(?:\/|$)/i;
const JS_IDENTIFIER_START_PATTERN = '[$_\\p{ID_Start}]';
const JS_IDENTIFIER_PART_PATTERN = '[$\\u200c\\u200d\\p{ID_Continue}]';
const JS_IDENTIFIER_PART_OR_DOT_PATTERN = '[.$\\u200c\\u200d\\p{ID_Continue}]';
const JS_IDENTIFIER = JS_IDENTIFIER_START_PATTERN + JS_IDENTIFIER_PART_PATTERN + '*';
const PYTHON_IDENTIFIER_START_PATTERN = '[_\\p{XID_Start}]';
const PYTHON_IDENTIFIER_PART_PATTERN = '[_\\p{XID_Continue}]';
const PYTHON_IDENTIFIER_PART_OR_DOT_PATTERN = '[._\\p{XID_Continue}]';
const PYTHON_IDENTIFIER =
  PYTHON_IDENTIFIER_START_PATTERN + PYTHON_IDENTIFIER_PART_PATTERN + '*';
const DIRECT_FORBIDDEN = [
  new RegExp(
    '(?<!' +
      JS_IDENTIFIER_PART_PATTERN +
      ')process\\s*(?:\\.|\\?\\.)\\s*env(?!' +
      JS_IDENTIFIER_PART_PATTERN +
      ')',
    'gu',
  ),
  new RegExp(
    '(?<!' +
      JS_IDENTIFIER_PART_PATTERN +
      ')process\\s*(?:\\?\\.\\s*)?\\[\\s*([\'"`])env\\1\\s*\\]',
    'gu',
  ),
  /\b(?:const|let|var)\s*\{[^}]*\benv\b[^}]*\}\s*=\s*process\b/g,
  /\b(?:from|import|require)\s*(?:\(\s*)?(['"`])(?:node:)?process\1\s*\)?/g,
  /os\s*\.\s*environ\b/g,
  /os\s*\.\s*getenv\s*\(/g,
];

// Python imports can bind the forbidden APIs under arbitrary local names. Flag the
// import boundary itself, including parenthesized and backslash-continued imports;
// this avoids attempting to infer every later alias use.
const PYTHON_FROM_OS_IMPORT = new RegExp(
  '(?<!' +
    PYTHON_IDENTIFIER_PART_PATTERN +
    ')from\\s+os\\s+import\\s+(\\([^)]*\\)|(?:\\f\\r?\\n|[^\\r\\n])*)',
  'gu',
);
const PYTHON_IMPORT = new RegExp(
  '(?<!' +
    PYTHON_IDENTIFIER_PART_PATTERN +
    ')import\\s+((?:\\f\\r?\\n|[^\\r\\n#;])*)',
  'gu',
);
const NODE_PROCESS_ALIAS = new RegExp(
  '\\b(?:const|let|var)\\s+(' +
    JS_IDENTIFIER +
    ')\\s*=\\s*process(?!' +
    JS_IDENTIFIER_PART_PATTERN +
    ')',
  'gu',
);

function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  return output.split('\0').filter(Boolean).map((file) => file.replaceAll('\\', '/'));
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pythonIdentifierKey(identifier) {
  return identifier.normalize('NFKC');
}

function javascriptLexicalView(source) {
  const normalized = source.split('');
  const code = new Uint8Array(source.length);
  const regexPrefixKeywords = new Set([
    'await',
    'case',
    'delete',
    'do',
    'else',
    'in',
    'instanceof',
    'new',
    'of',
    'return',
    'throw',
    'typeof',
    'void',
    'yield',
  ]);
  const controlParenKeywords = new Set(['catch', 'for', 'if', 'switch', 'while', 'with']);
  const blockPrefixKeywords = new Set(['do', 'else', 'finally', 'try']);
  const asiBoundaryKeywords = new Set(['break', 'continue', 'debugger']);
  const declarationModifiers = new Set(['async', 'declare', 'default', 'export']);

  function blankRange(start, end) {
    for (let index = start; index < end; index += 1) {
      if (source[index] !== '\n' && source[index] !== '\r') normalized[index] = ' ';
    }
  }

  function markCode(start, end) {
    for (let index = start; index < end; index += 1) code[index] = 1;
  }

  function scanString(start, quote) {
    let index = start + 1;
    while (index < source.length) {
      if (source[index] === '\\') {
        index += 2;
        continue;
      }
      if (source[index] === quote) return index + 1;
      if (source[index] === '\n' || source[index] === '\r') return index;
      index += 1;
    }
    return index;
  }

  function scanRegex(start) {
    let index = start + 1;
    let inCharacterClass = false;
    while (index < source.length) {
      if (source[index] === '\n' || source[index] === '\r') return null;
      if (source[index] === '\\') {
        index += 2;
        continue;
      }
      if (source[index] === '[') {
        inCharacterClass = true;
        index += 1;
        continue;
      }
      if (source[index] === ']' && inCharacterClass) {
        inCharacterClass = false;
        index += 1;
        continue;
      }
      if (source[index] === '/' && !inCharacterClass) {
        index += 1;
        while (index < source.length && /[dgimsuvy]/.test(source[index])) index += 1;
        blankRange(start, index);
        return index;
      }
      index += 1;
    }
    return null;
  }

  function scanTemplate(start) {
    let index = start + 1;
    while (index < source.length) {
      if (source[index] === '\\') {
        index += 2;
        continue;
      }
      if (source[index] === String.fromCharCode(96)) return index + 1;
      if (source[index] === '$' && source[index + 1] === '{') {
        index = scanCode(index + 2, true);
        continue;
      }
      index += 1;
    }
    return index;
  }

  function scanCode(start, stopAtTemplateBrace = false) {
    let braceDepth = 0;
    let index = start;
    let canStartRegex = true;
    let atStatementStart = true;
    let pendingControlParen = false;
    let pendingFunctionKind = null;
    let functionBraceKind = null;
    let pendingClassKind = null;
    let pendingArrowBody = false;
    let immediateBlockExpected = false;
    let asiBoundaryKeyword = null;
    const parenKinds = [];
    const braceKinds = [];
    while (index < source.length) {
      if (stopAtTemplateBrace && source[index] === '}' && braceDepth === 0) {
        return index + 1;
      }
      if (source[index] === '/' && source[index + 1] === '/') {
        const commentStart = index;
        index += 2;
        while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
          index += 1;
        }
        blankRange(commentStart, index);
        continue;
      }
      if (source[index] === '/' && source[index + 1] === '*') {
        const commentStart = index;
        index += 2;
        while (
          index < source.length &&
          !(source[index] === '*' && source[index + 1] === '/')
        ) {
          index += 1;
        }
        if (index < source.length) index += 2;
        blankRange(commentStart, index);
        if (
          asiBoundaryKeyword !== null &&
          /[\r\n]/.test(source.slice(commentStart, index))
        ) {
          asiBoundaryKeyword = null;
          canStartRegex = true;
          atStatementStart = true;
        }
        continue;
      }
      if (source[index] === "'" || source[index] === '"') {
        immediateBlockExpected = false;
        pendingArrowBody = false;
        asiBoundaryKeyword = null;
        index = scanString(index, source[index]);
        canStartRegex = false;
        atStatementStart = false;
        pendingControlParen = false;
        continue;
      }
      if (source[index] === String.fromCharCode(96)) {
        immediateBlockExpected = false;
        pendingArrowBody = false;
        asiBoundaryKeyword = null;
        index = scanTemplate(index);
        canStartRegex = false;
        atStatementStart = false;
        pendingControlParen = false;
        continue;
      }
      if (source[index] === '/' && canStartRegex) {
        immediateBlockExpected = false;
        pendingArrowBody = false;
        asiBoundaryKeyword = null;
        const regexEnd = scanRegex(index);
        if (regexEnd !== null) {
          index = regexEnd;
          canStartRegex = false;
          atStatementStart = false;
          pendingControlParen = false;
          continue;
        }
      }
      if (/[A-Za-z_$]/.test(source[index])) {
        immediateBlockExpected = false;
        pendingArrowBody = false;
        const tokenStart = index;
        index += 1;
        while (index < source.length && /[\w$]/.test(source[index])) index += 1;
        markCode(tokenStart, index);
        const token = source.slice(tokenStart, index);
        const startedAtStatement = atStatementStart;
        if (token === 'function') {
          pendingFunctionKind = startedAtStatement
            ? 'function-declaration'
            : 'function-expression';
          pendingControlParen = false;
          canStartRegex = false;
          atStatementStart = false;
        } else if (token === 'class') {
          pendingClassKind = startedAtStatement ? 'class-declaration' : 'class-expression';
          pendingControlParen = false;
          canStartRegex = false;
          atStatementStart = false;
        } else if (controlParenKeywords.has(token)) {
          pendingControlParen = true;
          immediateBlockExpected = token === 'catch';
          canStartRegex = false;
          atStatementStart = false;
        } else if (blockPrefixKeywords.has(token)) {
          pendingControlParen = false;
          immediateBlockExpected = true;
          canStartRegex = true;
          atStatementStart = true;
        } else if (asiBoundaryKeywords.has(token)) {
          pendingControlParen = false;
          asiBoundaryKeyword = token;
          canStartRegex = false;
          atStatementStart = false;
        } else {
          pendingControlParen = false;
          asiBoundaryKeyword = null;
          canStartRegex = regexPrefixKeywords.has(token);
          atStatementStart = startedAtStatement && declarationModifiers.has(token);
        }
        continue;
      }
      if (/[0-9]/.test(source[index])) {
        immediateBlockExpected = false;
        pendingArrowBody = false;
        asiBoundaryKeyword = null;
        const tokenStart = index;
        index += 1;
        while (index < source.length && /[\w.]/.test(source[index])) index += 1;
        markCode(tokenStart, index);
        canStartRegex = false;
        atStatementStart = false;
        pendingControlParen = false;
        continue;
      }

      code[index] = 1;
      if (/\s/.test(source[index])) {
        if (
          asiBoundaryKeyword !== null &&
          (source[index] === '\n' || source[index] === '\r')
        ) {
          asiBoundaryKeyword = null;
          canStartRegex = true;
          atStatementStart = true;
        }
        index += 1;
        continue;
      }
      if (source[index] !== '{') immediateBlockExpected = false;
      if (source[index] !== '{') pendingArrowBody = false;
      if (source[index] !== ';') asiBoundaryKeyword = null;
      if (source[index] === '(') {
        if (pendingFunctionKind !== null) {
          parenKinds.push({ kind: 'function-params', result: pendingFunctionKind });
          pendingFunctionKind = null;
        } else {
          parenKinds.push({
            kind: pendingControlParen ? 'control' : 'expression',
            result: null,
          });
        }
        canStartRegex = true;
        atStatementStart = false;
        pendingControlParen = false;
      } else if (source[index] === ')') {
        const paren = parenKinds.pop() ?? { kind: 'expression', result: null };
        if (paren.kind === 'control') {
          canStartRegex = true;
          atStatementStart = true;
          immediateBlockExpected = true;
        } else if (paren.kind === 'function-params') {
          functionBraceKind = paren.result;
          canStartRegex = false;
          atStatementStart = false;
        } else {
          canStartRegex = false;
          atStatementStart = false;
        }
        pendingControlParen = false;
      } else if (source[index] === '{') {
        let braceKind;
        if (functionBraceKind !== null) {
          braceKind = functionBraceKind;
          functionBraceKind = null;
        } else if (pendingClassKind !== null) {
          braceKind = pendingClassKind;
          pendingClassKind = null;
        } else if (pendingArrowBody) {
          braceKind = 'function-expression';
        } else if (immediateBlockExpected || atStatementStart) {
          braceKind = 'block';
        } else {
          braceKind = 'object';
        }
        braceKinds.push(braceKind);
        if (stopAtTemplateBrace) braceDepth += 1;
        canStartRegex = true;
        atStatementStart = braceKind !== 'object';
        pendingControlParen = false;
        immediateBlockExpected = false;
        pendingArrowBody = false;
      } else if (source[index] === '[') {
        canStartRegex = true;
        atStatementStart = false;
        pendingControlParen = false;
      } else if (source[index] === '}') {
        if (stopAtTemplateBrace) braceDepth -= 1;
        const braceKind = braceKinds.pop() ?? 'block';
        const producesValue =
          braceKind === 'object' ||
          braceKind === 'function-expression' ||
          braceKind === 'class-expression';
        canStartRegex = !producesValue;
        atStatementStart = !producesValue;
        pendingControlParen = false;
      } else if (source[index] === ']') {
        canStartRegex = false;
        atStatementStart = false;
        pendingControlParen = false;
      } else if (source[index] === '.') {
        canStartRegex = false;
        atStatementStart = false;
        pendingControlParen = false;
      } else if (
        (source[index] === '+' || source[index] === '-') &&
        source[index + 1] === source[index]
      ) {
        code[index + 1] = 1;
        index += 1;
        canStartRegex = false;
        atStatementStart = false;
        pendingControlParen = false;
      } else if (source[index] === '=' && source[index + 1] === '>') {
        code[index + 1] = 1;
        index += 1;
        pendingArrowBody = true;
        canStartRegex = true;
        atStatementStart = false;
        pendingControlParen = false;
      } else if (source[index] === ';') {
        canStartRegex = true;
        atStatementStart = true;
        pendingControlParen = false;
      } else if (',?:=+-%*<>&|^!~'.includes(source[index])) {
        canStartRegex = true;
        atStatementStart = false;
        pendingControlParen = false;
      } else if (source[index] === '/') {
        if (source[index + 1] === '=') {
          code[index + 1] = 1;
          index += 1;
        }
        canStartRegex = true;
        atStatementStart = false;
        pendingControlParen = false;
      } else {
        canStartRegex = false;
        atStatementStart = false;
        pendingControlParen = false;
      }
      index += 1;
    }
    return index;
  }

  scanCode(0);
  return { normalized: normalized.join(''), code };
}

function pythonLexicalView(source) {
  const normalized = source.split('');

  function blankRange(start, end) {
    for (let index = start; index < end; index += 1) {
      if (source[index] !== '\n' && source[index] !== '\r') normalized[index] = ' ';
    }
  }

  function stringTokenAt(start) {
    const match = /^(?:(?:[rR][fF]|[fF][rR]|[rR][bB]|[bB][rR]|[rRuUbBfF]))?(?:'''|"""|'|")/.exec(
      source.slice(start),
    );
    if (match === null) return null;
    const quoteOffset = match[0].search(/['"]/);
    const prefix = match[0].slice(0, quoteOffset);
    if (prefix.length > 0 && start > 0 && /[A-Za-z0-9_]/.test(source[start - 1])) {
      return null;
    }
    const delimiter = match[0].slice(quoteOffset);
    return {
      start,
      prefix,
      delimiter,
      contentStart: start + match[0].length,
      isFormatted: /f/i.test(prefix),
      isRaw: /r/i.test(prefix),
    };
  }

  function scanOrdinaryString(token) {
    let index = token.contentStart;
    while (index < source.length) {
      if (source[index] === '\\') {
        index += 2;
        continue;
      }
      if (source.startsWith(token.delimiter, index)) {
        index += token.delimiter.length;
        blankRange(token.start, index);
        return index;
      }
      if (
        token.delimiter.length === 1 &&
        (source[index] === '\n' || source[index] === '\r')
      ) {
        blankRange(token.start, index);
        return index;
      }
      index += 1;
    }
    blankRange(token.start, index);
    return index;
  }

  function scanFormattedSpec(start) {
    let index = start;
    while (index < source.length) {
      if (source[index] === '{') {
        blankRange(index, index + 1);
        index = scanFormattedExpression(index + 1);
        continue;
      }
      if (source[index] === '}') {
        blankRange(index, index + 1);
        return index + 1;
      }
      blankRange(index, index + 1);
      index += 1;
    }
    return index;
  }

  function scanFormattedExpression(start) {
    const stack = [];
    const closing = { '(': ')', '[': ']', '{': '}' };
    let index = start;
    while (index < source.length) {
      if (source[index] === '#') {
        const commentStart = index;
        while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
          index += 1;
        }
        blankRange(commentStart, index);
        continue;
      }
      const token = stringTokenAt(index);
      if (token !== null) {
        index = token.isFormatted ? scanFormattedString(token) : scanOrdinaryString(token);
        continue;
      }
      if (Object.hasOwn(closing, source[index])) {
        stack.push(closing[source[index]]);
        index += 1;
        continue;
      }
      if (stack.length > 0 && source[index] === stack.at(-1)) {
        stack.pop();
        index += 1;
        continue;
      }
      if (stack.length === 0 && source[index] === '}') {
        blankRange(index, index + 1);
        return index + 1;
      }
      if (stack.length === 0 && source[index] === ':') {
        blankRange(index, index + 1);
        return scanFormattedSpec(index + 1);
      }
      if (
        stack.length === 0 &&
        source[index] === '!' &&
        (source[index + 1] === 's' ||
          source[index + 1] === 'r' ||
          source[index + 1] === 'a')
      ) {
        blankRange(index, index + 2);
        index += 2;
        if (source[index] === ':') {
          blankRange(index, index + 1);
          return scanFormattedSpec(index + 1);
        }
        if (source[index] === '}') {
          blankRange(index, index + 1);
          return index + 1;
        }
        return index;
      }
      index += 1;
    }
    return index;
  }

  function scanFormattedString(token) {
    blankRange(token.start, token.contentStart);
    let index = token.contentStart;
    while (index < source.length) {
      if (source.startsWith(token.delimiter, index)) {
        blankRange(index, index + token.delimiter.length);
        return index + token.delimiter.length;
      }
      if (source[index] === '\\') {
        blankRange(index, index + 1);
        const escapedIndex = index + 1;
        if (source[escapedIndex] === '{' || source[escapedIndex] === '}') {
          index = escapedIndex;
          continue;
        }
        if (source[escapedIndex] === token.delimiter[0]) {
          blankRange(escapedIndex, escapedIndex + 1);
          index = escapedIndex + 1;
          continue;
        }
        if (!token.isRaw && escapedIndex < source.length) {
          blankRange(escapedIndex, escapedIndex + 1);
          index = escapedIndex + 1;
          continue;
        }
        index = escapedIndex;
        continue;
      }
      if (
        (source[index] === '{' && source[index + 1] === '{') ||
        (source[index] === '}' && source[index + 1] === '}')
      ) {
        blankRange(index, index + 2);
        index += 2;
        continue;
      }
      if (source[index] === '{') {
        blankRange(index, index + 1);
        index = scanFormattedExpression(index + 1);
        continue;
      }
      blankRange(index, index + 1);
      index += 1;
    }
    return index;
  }

  let index = 0;
  while (index < source.length) {
    if (source[index] === '#') {
      const commentStart = index;
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
        index += 1;
      }
      blankRange(commentStart, index);
      continue;
    }
    const token = stringTokenAt(index);
    if (token !== null) {
      index = token.isFormatted ? scanFormattedString(token) : scanOrdinaryString(token);
      continue;
    }
    index += 1;
  }

  // An explicit continuation joins one logical Python line. Replace only the
  // backslash with whitespace and retain the physical newline so diagnostics
  // keep their original line numbers. Import rules can still distinguish this
  // form-feed/newline pair from an ordinary statement boundary.
  for (let continuation = 0; continuation < source.length; continuation += 1) {
    if (
      source[continuation] === '\\' &&
      (source[continuation + 1] === '\n' ||
        (source[continuation + 1] === '\r' && source[continuation + 2] === '\n')) &&
      normalized[continuation] !== ' '
    ) {
      normalized[continuation] = '\f';
    }
  }

  return normalized.join('');
}

function codeMatches(source, pattern, code) {
  pattern.lastIndex = 0;
  return [...source.matchAll(pattern)].filter((match) => code === null || code[match.index] === 1);
}

const TS_TYPE_PATTERN =
  '(?:typeof\\s+)?' +
  JS_IDENTIFIER +
  '(?:\\s*\\.\\s*' +
  JS_IDENTIFIER +
  ')*' +
  '(?:\\s*<[^;(){}]+>)?(?:\\s*\\[\\s*\\])*';
const JS_IDENTIFIER_START_CHARACTER = /[$_\p{ID_Start}]/u;
const JS_IDENTIFIER_PART_CHARACTER = /[$\u200c\u200d\p{ID_Continue}]/u;
const JS_EXPRESSION_PREFIX_KEYWORDS = new Set([
  'await',
  'case',
  'delete',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);

function isJavascriptIdentifierStart(character) {
  return character !== undefined && JS_IDENTIFIER_START_CHARACTER.test(character);
}

function isJavascriptIdentifierPart(character) {
  return character !== undefined && JS_IDENTIFIER_PART_CHARACTER.test(character);
}

function unicodeIdentifierEscapeAt(source, code, start) {
  if (source[start] !== '\\' || source[start + 1] !== 'u' || code[start] !== 1) return null;
  let end;
  let digits;
  if (source[start + 2] === '{') {
    const close = source.indexOf('}', start + 3);
    if (close === -1) return null;
    digits = source.slice(start + 3, close);
    if (!/^[0-9A-Fa-f]{1,6}$/.test(digits)) return null;
    end = close + 1;
  } else {
    digits = source.slice(start + 2, start + 6);
    if (!/^[0-9A-Fa-f]{4}$/.test(digits)) return null;
    end = start + 6;
  }
  for (let index = start; index < end; index += 1) {
    if (code[index] !== 1) return null;
  }
  const point = Number.parseInt(digits, 16);
  if (point > 0x10ffff) return null;
  const value = String.fromCodePoint(point);
  return { value, end };
}

function javascriptIdentifierTokenAt(source, code, start) {
  let index = start;
  let name = '';
  const originalIndexes = [];
  let first = true;
  while (index < source.length) {
    const escaped = unicodeIdentifierEscapeAt(source, code, index);
    if (escaped !== null) {
      const valid = first
        ? isJavascriptIdentifierStart(escaped.value)
        : isJavascriptIdentifierPart(escaped.value);
      if (!valid) break;
      name += escaped.value;
      for (let offset = 0; offset < escaped.value.length; offset += 1) {
        originalIndexes.push(index);
      }
      index = escaped.end;
      first = false;
      continue;
    }
    const point = source.codePointAt(index);
    if (point === undefined) break;
    const character = String.fromCodePoint(point);
    let isCode = true;
    for (let offset = 0; offset < character.length; offset += 1) {
      if (code[index + offset] !== 1) isCode = false;
    }
    if (!isCode) break;
    const valid = first
      ? isJavascriptIdentifierStart(character)
      : isJavascriptIdentifierPart(character);
    if (!valid) break;
    name += character;
    for (let offset = 0; offset < character.length; offset += 1) {
      originalIndexes.push(index + offset);
    }
    index += character.length;
    first = false;
  }
  return first ? null : { name, start, end: index, originalIndexes };
}

function canonicalizeJavascriptIdentifiers(source, code) {
  const normalized = [];
  const normalizedCode = [];
  const originalIndexes = [];
  let index = 0;
  while (index < source.length) {
    const token = javascriptIdentifierTokenAt(source, code, index);
    if (token !== null) {
      for (let offset = 0; offset < token.name.length; offset += 1) {
        normalized.push(token.name[offset]);
        normalizedCode.push(1);
        originalIndexes.push(token.originalIndexes[offset]);
      }
      index = token.end;
      continue;
    }
    normalized.push(source[index]);
    normalizedCode.push(code[index]);
    originalIndexes.push(index);
    index += 1;
  }
  originalIndexes.push(source.length);
  return {
    normalized: normalized.join(''),
    code: Uint8Array.from(normalizedCode),
    originalIndexes: Uint32Array.from(originalIndexes),
  };
}

function identifierAlternation(names) {
  return [...names]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join('|');
}

function wrappedIdentifiers(names) {
  return (
    '(?<!' +
    JS_IDENTIFIER_PART_OR_DOT_PATTERN +
    ')(?:\\(\\s*)*(?:<\\s*' +
    TS_TYPE_PATTERN +
    '\\s*>\\s*)?(?:' +
    identifierAlternation(names) +
    ')(?!' +
    JS_IDENTIFIER_PART_PATTERN +
    ')(?:\\s*!)*(?:\\s+(?:as|satisfies)\\s+' +
    TS_TYPE_PATTERN +
    ')*(?:\\s*\\))*(?:\\s*!)*'
  );
}

function caseInsensitiveHexPattern(value) {
  return [...value]
    .map((character) =>
      /[a-f]/i.test(character)
        ? '[' + character.toLowerCase() + character.toUpperCase() + ']'
        : character,
    )
    .join('');
}

function staticStringSpellingPattern(value) {
  return [...value]
    .map((character) => {
      const point = character.codePointAt(0);
      const shortHex = caseInsensitiveHexPattern(point.toString(16).padStart(2, '0'));
      const unicodeHex = caseInsensitiveHexPattern(point.toString(16).padStart(4, '0'));
      const codePointHex = caseInsensitiveHexPattern(point.toString(16));
      return (
        '(?:' +
        escapeRegExp(character) +
        '|\\\\x' +
        shortHex +
        '|\\\\u' +
        unicodeHex +
        '|\\\\u\\{0*' +
        codePointHex +
        '\\})'
      );
    })
    .join('');
}

function fixedPropertyAccess(name) {
  const tick = String.fromCharCode(96);
  const spelling = staticStringSpellingPattern(name);
  const quoted = "(?:'" + spelling + "'|\"" + spelling + '\"|' + tick + spelling + tick + ')';
  return (
    '(?:(?:\\?\\.|\\.)\\s*' +
    name +
    '(?!' +
    JS_IDENTIFIER_PART_PATTERN +
    ')|(?:\\?\\.\\s*)?\\[\\s*' +
    quoted +
    '\\s*\\])'
  );
}

function skipJavascriptWhitespace(source, start) {
  let index = start;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  return index;
}

function javascriptIdentifierAt(source, code, start) {
  return javascriptIdentifierTokenAt(source, code, start);
}

function staticQuotedKeyAt(source, start) {
  const quote = source[start];
  const tick = String.fromCharCode(96);
  if (quote !== "'" && quote !== '"' && quote !== tick) return null;
  let index = start + 1;
  let value = '';
  let staticValue = true;
  const simpleEscapes = new Map([
    ['b', '\b'],
    ['f', '\f'],
    ['n', '\n'],
    ['r', '\r'],
    ['t', '\t'],
    ['v', '\v'],
  ]);
  while (index < source.length) {
    if (source[index] === '\\') {
      const escaped = source[index + 1];
      if (escaped === '\n') {
        index += 2;
        continue;
      }
      if (escaped === '\r') {
        index += source[index + 2] === '\n' ? 3 : 2;
        continue;
      }
      if (escaped === 'x' && /^[0-9A-Fa-f]{2}$/.test(source.slice(index + 2, index + 4))) {
        value += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 4), 16));
        index += 4;
        continue;
      }
      if (escaped === 'u' && source[index + 2] === '{') {
        const close = source.indexOf('}', index + 3);
        const digits = close === -1 ? '' : source.slice(index + 3, close);
        const point = /^[0-9A-Fa-f]{1,6}$/.test(digits)
          ? Number.parseInt(digits, 16)
          : Number.NaN;
        if (close !== -1 && point <= 0x10ffff) {
          value += String.fromCodePoint(point);
          index = close + 1;
          continue;
        }
      }
      if (escaped === 'u' && /^[0-9A-Fa-f]{4}$/.test(source.slice(index + 2, index + 6))) {
        value += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 6), 16));
        index += 6;
        continue;
      }
      if (escaped === '0' && !/[0-9]/.test(source[index + 2] ?? '')) {
        value += '\0';
        index += 2;
        continue;
      }
      if (simpleEscapes.has(escaped)) {
        value += simpleEscapes.get(escaped);
        index += 2;
        continue;
      }
      if (escaped === undefined) return null;
      value += escaped;
      index += 2;
      continue;
    }
    if (quote === tick && source[index] === '$' && source[index + 1] === '{') {
      staticValue = false;
    }
    if (source[index] === quote) {
      return { value: staticValue ? value : null, start, end: index + 1 };
    }
    if (source[index] === '\n' || source[index] === '\r') return null;
    value += source[index];
    index += 1;
  }
  return null;
}

function skipBalancedJavascript(source, code, start) {
  const closing = { '(': ')', '[': ']', '{': '}' };
  const stack = [];
  for (let index = start; index < source.length; index += 1) {
    if (code[index] !== 1) continue;
    if (Object.hasOwn(closing, source[index])) {
      stack.push(closing[source[index]]);
      continue;
    }
    if (stack.length > 0 && source[index] === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return index + 1;
    }
  }
  return source.length;
}

function skipPatternExpression(source, code, start) {
  const closing = { '(': ')', '[': ']', '{': '}' };
  const stack = [];
  let index = start;
  while (index < source.length) {
    if (code[index] !== 1) {
      index += 1;
      continue;
    }
    if (Object.hasOwn(closing, source[index])) {
      stack.push(closing[source[index]]);
      index += 1;
      continue;
    }
    if (stack.length > 0 && source[index] === stack.at(-1)) {
      stack.pop();
      index += 1;
      continue;
    }
    if (stack.length === 0 && (source[index] === ',' || source[index] === '}')) {
      return index;
    }
    index += 1;
  }
  return index;
}

function staticPatternKeyAt(source, code, start) {
  let index = skipJavascriptWhitespace(source, start);
  if (source[index] === '[' && code[index] === 1) {
    const computedEnd = skipBalancedJavascript(source, code, index);
    let content = skipJavascriptWhitespace(source, index + 1);
    const quoted = staticQuotedKeyAt(source, content);
    if (quoted !== null) content = skipJavascriptWhitespace(source, quoted.end);
    const isStaticQuoted =
      quoted !== null &&
      quoted.value !== null &&
      source[content] === ']' &&
      code[content] === 1;
    return {
      key: isStaticQuoted ? quoted.value : null,
      shorthand: false,
      start: index,
      end: computedEnd,
    };
  }
  const quoted = staticQuotedKeyAt(source, index);
  if (quoted !== null) {
    return {
      key: quoted.value,
      shorthand: false,
      start: index,
      end: quoted.end,
    };
  }
  const identifier = javascriptIdentifierAt(source, code, index);
  if (identifier !== null) {
    return {
      key: identifier.name,
      shorthand: true,
      start: identifier.start,
      end: identifier.end,
    };
  }
  return null;
}

function objectPatternAt(source, code, start) {
  if (source[start] !== '{' || code[start] !== 1) return null;
  const properties = [];
  let index = start + 1;
  while (index < source.length) {
    index = skipJavascriptWhitespace(source, index);
    if (source[index] === '}' && code[index] === 1) {
      return { kind: 'object', start, end: index + 1, properties };
    }
    if (
      source.slice(index, index + 3) === '...' &&
      code[index] === 1 &&
      code[index + 1] === 1 &&
      code[index + 2] === 1
    ) {
      index = skipPatternExpression(source, code, index + 3);
    } else {
      const property = staticPatternKeyAt(source, code, index);
      if (property === null) {
        index = skipPatternExpression(source, code, index);
      } else {
        index = skipJavascriptWhitespace(source, property.end);
        let target = null;
        if (source[index] === ':' && code[index] === 1) {
          index = skipJavascriptWhitespace(source, index + 1);
          if (source[index] === '{' && code[index] === 1) {
            target = objectPatternAt(source, code, index);
          } else {
            const identifier = javascriptIdentifierAt(source, code, index);
            if (identifier !== null) {
              target = { kind: 'identifier', ...identifier };
            } else if (
              (source[index] === '[' || source[index] === '(') &&
              code[index] === 1
            ) {
              target = {
                kind: 'other',
                start: index,
                end: skipBalancedJavascript(source, code, index),
              };
            }
          }
        } else if (property.shorthand && property.key !== null) {
          target = {
            kind: 'identifier',
            name: property.key,
            start: property.start,
            end: property.end,
          };
        }
        if (target === null) {
          index = skipPatternExpression(source, code, index);
        } else {
          index = skipJavascriptWhitespace(source, target.end);
          if (
            source[index] === '=' &&
            code[index] === 1 &&
            source[index + 1] !== '=' &&
            source[index + 1] !== '>'
          ) {
            index = skipPatternExpression(source, code, index + 1);
          }
          properties.push({ key: property.key, start: property.start, target });
        }
      }
    }
    index = skipJavascriptWhitespace(source, index);
    if (source[index] === ',' && code[index] === 1) {
      index += 1;
      continue;
    }
    if (source[index] === '}' && code[index] === 1) continue;
    index = skipPatternExpression(source, code, index);
  }
  return null;
}

function skipTypeScriptType(source, code, start) {
  const closing = { '(': ')', '[': ']', '{': '}', '<': '>' };
  const stack = [];
  let index = skipJavascriptWhitespace(source, start);
  let hasContent = false;
  while (index < source.length) {
    if (code[index] !== 1) {
      index += 1;
      continue;
    }
    if (
      stack.length === 0 &&
      hasContent &&
      (source[index] === '\n' || source[index] === '\r')
    ) {
      return index;
    }
    const identifier = javascriptIdentifierAt(source, code, index);
    if (identifier !== null) {
      if (
        stack.length === 0 &&
        hasContent &&
        (identifier.name === 'as' || identifier.name === 'satisfies')
      ) {
        return index;
      }
      hasContent = true;
      index = identifier.end;
      continue;
    }
    if (Object.hasOwn(closing, source[index])) {
      stack.push(closing[source[index]]);
      hasContent = true;
      index += 1;
      continue;
    }
    if (stack.length > 0 && source[index] === stack.at(-1)) {
      stack.pop();
      index += 1;
      continue;
    }
    if (
      stack.length === 0 &&
      (source[index] === ')' ||
        source[index] === ',' ||
        source[index] === ';' ||
        source[index] === '!' ||
        source[index] === '}')
    ) {
      return index;
    }
    if (!/\s/.test(source[index])) hasContent = true;
    index += 1;
  }
  return index;
}

function skipAngleTypeAssertion(source, code, start) {
  if (source[start] !== '<' || code[start] !== 1) return null;
  const closing = { '(': ')', '[': ']', '{': '}', '<': '>' };
  const stack = ['>'];
  let index = start + 1;
  let hasContent = false;
  while (index < source.length) {
    if (code[index] !== 1) {
      index += 1;
      continue;
    }
    if (Object.hasOwn(closing, source[index])) {
      stack.push(closing[source[index]]);
      hasContent = true;
      index += 1;
      continue;
    }
    if (source[index] === stack.at(-1)) {
      stack.pop();
      index += 1;
      if (stack.length === 0) return hasContent ? index : null;
      continue;
    }
    if (source[index] === '\n' || source[index] === '\r' || source[index] === ';') {
      return null;
    }
    if (!/\s/.test(source[index])) hasContent = true;
    index += 1;
  }
  return null;
}

function skipTrackedExpressionPrefixes(source, code, start) {
  let index = skipJavascriptWhitespace(source, start);
  let groupingDepth = 0;
  while (index < source.length) {
    if (source[index] === '(' && code[index] === 1) {
      groupingDepth += 1;
      index = skipJavascriptWhitespace(source, index + 1);
      continue;
    }
    const assertionEnd = skipAngleTypeAssertion(source, code, index);
    if (assertionEnd !== null) {
      index = skipJavascriptWhitespace(source, assertionEnd);
      continue;
    }
    break;
  }
  return { index, groupingDepth };
}

function skipTrackedExpressionWrappers(source, code, start, initialGroupingDepth) {
  let index = start;
  let groupingDepth = initialGroupingDepth;
  while (index < source.length) {
    index = skipJavascriptWhitespace(source, index);
    if (source[index] === '!' && code[index] === 1 && source[index + 1] !== '=') {
      index += 1;
      continue;
    }
    if (source[index] === ')' && code[index] === 1 && groupingDepth > 0) {
      groupingDepth -= 1;
      index += 1;
      continue;
    }
    const assertion = javascriptIdentifierAt(source, code, index);
    if (
      assertion !== null &&
      (assertion.name === 'as' || assertion.name === 'satisfies')
    ) {
      const typeEnd = skipTypeScriptType(source, code, assertion.end);
      if (typeEnd === skipJavascriptWhitespace(source, assertion.end)) {
        return { index, groupingDepth };
      }
      index = typeEnd;
      continue;
    }
    break;
  }
  return { index, groupingDepth };
}

function staticPropertyAccessAt(source, code, start) {
  let index = skipJavascriptWhitespace(source, start);
  if (
    source[index] === '?' &&
    source[index + 1] === '.' &&
    code[index] === 1 &&
    code[index + 1] === 1
  ) {
    index = skipJavascriptWhitespace(source, index + 2);
  } else if (source[index] === '.' && code[index] === 1) {
    index = skipJavascriptWhitespace(source, index + 1);
  } else if (source[index] !== '[' || code[index] !== 1) {
    return null;
  }
  if (source[index] === '[' && code[index] === 1) {
    index = skipJavascriptWhitespace(source, index + 1);
    const quoted = staticQuotedKeyAt(source, index);
    if (quoted === null || quoted.value === null) return null;
    index = skipJavascriptWhitespace(source, quoted.end);
    if (source[index] !== ']' || code[index] !== 1) return null;
    return { name: quoted.value, end: index + 1 };
  }
  const property = javascriptIdentifierAt(source, code, index);
  return property === null ? null : { name: property.name, end: property.end };
}

function wrappedIdentifierAt(source, code, start) {
  const prefix = skipTrackedExpressionPrefixes(source, code, start);
  let index = prefix.index;
  let groupingDepth = prefix.groupingDepth;
  const identifier = javascriptIdentifierAt(source, code, index);
  if (identifier === null) return null;
  const wrapped = skipTrackedExpressionWrappers(
    source,
    code,
    identifier.end,
    groupingDepth,
  );
  index = wrapped.index;
  groupingDepth = wrapped.groupingDepth;
  if (groupingDepth !== 0) return null;
  if (
    index < source.length &&
    source[index] !== ';' &&
    source[index] !== ',' &&
    source[index] !== ')' &&
    source[index] !== '}' &&
    source[index] !== '\n' &&
    source[index] !== '\r'
  ) {
    return null;
  }
  return { name: identifier.name, end: index };
}

function trackedExpressionAt(source, code, start, globalAliases, processAliases) {
  const prefix = skipTrackedExpressionPrefixes(source, code, start);
  let index = prefix.index;
  let groupingDepth = prefix.groupingDepth;
  const identifier = javascriptIdentifierAt(source, code, index);
  if (identifier === null) return null;
  let kind;
  if (globalAliases.has(identifier.name)) kind = 'global';
  else if (processAliases.has(identifier.name)) kind = 'process';
  else return null;
  index = identifier.end;
  while (index < source.length) {
    const wrapped = skipTrackedExpressionWrappers(
      source,
      code,
      index,
      groupingDepth,
    );
    index = wrapped.index;
    groupingDepth = wrapped.groupingDepth;
    const property = staticPropertyAccessAt(source, code, index);
    if (property === null) break;
    if (kind === 'global' && property.name === 'process') {
      kind = 'process';
      index = property.end;
      continue;
    }
    if (kind === 'process' && property.name === 'env') {
      return { kind: 'environment', end: property.end, groupingDepth };
    }
    return { kind: 'other', end: property.end, groupingDepth };
  }
  return { kind, end: index, groupingDepth };
}

function objectPatternAssignments(source, code) {
  const assignments = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '{' || code[index] !== 1) continue;
    const pattern = objectPatternAt(source, code, index);
    if (pattern === null) continue;
    let cursor = skipJavascriptWhitespace(source, pattern.end);
    if (source[cursor] === ':' && code[cursor] === 1) {
      const closing = { '(': ')', '[': ']', '{': '}', '<': '>' };
      const stack = [];
      cursor += 1;
      while (cursor < source.length) {
        if (code[cursor] !== 1) {
          cursor += 1;
          continue;
        }
        if (Object.hasOwn(closing, source[cursor])) {
          stack.push(closing[source[cursor]]);
          cursor += 1;
          continue;
        }
        if (stack.length > 0 && source[cursor] === stack.at(-1)) {
          stack.pop();
          cursor += 1;
          continue;
        }
        if (
          stack.length === 0 &&
          source[cursor] === '=' &&
          source[cursor + 1] !== '=' &&
          source[cursor + 1] !== '>'
        ) {
          break;
        }
        if (
          stack.length === 0 &&
          (source[cursor] === ';' || source[cursor] === '\n' || source[cursor] === '\r')
        ) {
          break;
        }
        cursor += 1;
      }
      cursor = skipJavascriptWhitespace(source, cursor);
    }
    if (
      source[cursor] !== '=' ||
      code[cursor] !== 1 ||
      source[cursor + 1] === '=' ||
      source[cursor + 1] === '>'
    ) {
      continue;
    }
    cursor = skipJavascriptWhitespace(source, cursor + 1);
    const rhsStart = cursor;
    const rhs = wrappedIdentifierAt(source, code, cursor);
    assignments.push({ pattern, rhs: rhs?.name ?? null, rhsStart });
  }
  return assignments;
}

function analyzeStaticPattern(pattern, sourceKind, processAliases, lines, lineAt) {
  let changed = false;
  for (const property of pattern.properties) {
    if (sourceKind === 'process' && property.key === 'env') {
      lines.add(lineAt(property.start));
      continue;
    }
    if (sourceKind !== 'global' || property.key !== 'process') continue;
    if (property.target.kind === 'identifier') {
      if (!processAliases.has(property.target.name)) {
        processAliases.add(property.target.name);
        changed = true;
      }
    } else if (property.target.kind === 'object') {
      changed =
        analyzeStaticPattern(property.target, 'process', processAliases, lines, lineAt) ||
        changed;
    }
  }
  return changed;
}

function assignmentAliases(searchable, code, aliases, rhs) {
  const patterns = [
    new RegExp(
      '(?<!' +
        JS_IDENTIFIER_PART_OR_DOT_PATTERN +
        ')(' +
        JS_IDENTIFIER +
        ')\\s*=(?!=|>)\\s*' +
        rhs +
        '(?=\\s*(?:[;,\\n)]|$))',
      'gu',
    ),
    new RegExp(
      '\\b(?:const|let|var)\\s+(' +
        JS_IDENTIFIER +
        ')\\s*:\\s*' +
        TS_TYPE_PATTERN +
        '\\s*=(?!=|>)\\s*' +
        rhs +
        '(?=\\s*(?:[;,\\n)]|$))',
      'gu',
    ),
  ];
  let changed = false;
  for (const pattern of patterns) {
    for (const match of codeMatches(searchable, pattern, code)) {
      if (!aliases.has(match[1])) {
        aliases.add(match[1]);
        changed = true;
      }
    }
  }
  return changed;
}

function trackedAssignmentAliases(searchable, code, globalAliases, processAliases) {
  const patterns = [
    new RegExp(
      '(?<!' + JS_IDENTIFIER_PART_OR_DOT_PATTERN + ')(' + JS_IDENTIFIER + ')\\s*=(?!=|>)',
      'gu',
    ),
    new RegExp(
      '\\b(?:const|let|var)\\s+(' +
        JS_IDENTIFIER +
        ')\\s*:\\s*' +
        TS_TYPE_PATTERN +
        '\\s*=(?!=|>)',
      'gu',
    ),
  ];
  let changed = false;
  for (const pattern of patterns) {
    for (const match of codeMatches(searchable, pattern, code)) {
      const expression = trackedExpressionAt(
        searchable,
        code,
        match.index + match[0].length,
        globalAliases,
        processAliases,
      );
      if (expression === null || (expression.kind !== 'global' && expression.kind !== 'process')) {
        continue;
      }
      const end = skipJavascriptWhitespace(searchable, expression.end);
      if (
        end < searchable.length &&
        searchable[end] !== ';' &&
        searchable[end] !== ',' &&
        searchable[end] !== ')' &&
        searchable[end] !== '}' &&
        searchable[end] !== '\n' &&
        searchable[end] !== '\r'
      ) {
        continue;
      }
      const aliases = expression.kind === 'global' ? globalAliases : processAliases;
      if (!aliases.has(match[1])) {
        aliases.add(match[1]);
        changed = true;
      }
    }
  }
  return changed;
}

function canStartWrappedJavascriptExpression(source, code, start) {
  let index = start - 1;
  while (index >= 0 && /\s/.test(source[index])) index -= 1;
  if (index < 0) return true;
  if (code[index] !== 1) return false;
  if ('([{:;,=!?&|+-*%<>~'.includes(source[index])) return true;
  if (source[index] === '>') return source[index - 1] === '=';
  if (!/[A-Za-z_$]/.test(source[index])) return false;
  const end = index + 1;
  while (index >= 0 && /[\w$]/.test(source[index])) index -= 1;
  const keyword = source.slice(index + 1, end);
  return JS_EXPRESSION_PREFIX_KEYWORDS.has(keyword);
}

function parsedNodeEnvironmentAccessLines(source, code, globalAliases, processAliases, lineAt) {
  const lines = new Set();
  let index = 0;
  while (index < source.length) {
    if (
      (source[index] === '(' || source[index] === '<') &&
      code[index] === 1 &&
      canStartWrappedJavascriptExpression(source, code, index)
    ) {
      const expression = trackedExpressionAt(
        source,
        code,
        index,
        globalAliases,
        processAliases,
      );
      if (expression?.kind === 'environment') {
        lines.add(lineAt(index));
      }
    }
    const identifier = javascriptIdentifierAt(source, code, index);
    if (identifier === null) {
      index += 1;
      continue;
    }
    if (globalAliases.has(identifier.name) || processAliases.has(identifier.name)) {
      const expression = trackedExpressionAt(
        source,
        code,
        identifier.start,
        globalAliases,
        processAliases,
      );
      if (expression?.kind === 'environment') {
        lines.add(lineAt(identifier.start));
      }
    }
    index = identifier.end;
  }
  return lines;
}

function nodeEnvironmentAccessLines(searchable, code, lineAt) {
  const globalAliases = new Set(['globalThis', 'global']);
  const processAliases = new Set(['process']);
  const lines = new Set();
  const patternAssignments = objectPatternAssignments(searchable, code);
  let changed = true;
  while (changed) {
    changed = false;
    changed =
      assignmentAliases(
        searchable,
        code,
        globalAliases,
        wrappedIdentifiers(globalAliases),
      ) || changed;
    changed =
      assignmentAliases(
        searchable,
        code,
        processAliases,
        wrappedIdentifiers(processAliases),
      ) || changed;
    changed =
      assignmentAliases(
        searchable,
        code,
        processAliases,
        wrappedIdentifiers(globalAliases) + '\\s*' + fixedPropertyAccess('process'),
      ) || changed;
    changed =
      trackedAssignmentAliases(searchable, code, globalAliases, processAliases) || changed;
    for (const assignment of patternAssignments) {
      const expression = trackedExpressionAt(
        searchable,
        code,
        assignment.rhsStart,
        globalAliases,
        processAliases,
      );
      let sourceKind = null;
      if (
        (assignment.rhs !== null && globalAliases.has(assignment.rhs)) ||
        expression?.kind === 'global'
      ) {
        sourceKind = 'global';
      } else if (
        (assignment.rhs !== null && processAliases.has(assignment.rhs)) ||
        expression?.kind === 'process'
      ) {
        sourceKind = 'process';
      }
      if (sourceKind === 'global') {
        changed =
          analyzeStaticPattern(
            assignment.pattern,
            'global',
            processAliases,
            lines,
            lineAt,
          ) || changed;
      }
      if (sourceKind === 'process') {
        changed =
          analyzeStaticPattern(
            assignment.pattern,
            'process',
            processAliases,
            lines,
            lineAt,
          ) || changed;
      }
    }
  }

  const unwrappedAccessPatterns = [
    new RegExp(
      '(?<!' +
        JS_IDENTIFIER_PART_OR_DOT_PATTERN +
        ')(?:' +
        identifierAlternation(globalAliases) +
        ')(?!' +
        JS_IDENTIFIER_PART_PATTERN +
        ')\\s*' +
        fixedPropertyAccess('process') +
        '\\s*' +
        fixedPropertyAccess('env'),
      'gu',
    ),
    new RegExp(
      '(?<!' +
        JS_IDENTIFIER_PART_OR_DOT_PATTERN +
        ')(?:' +
        identifierAlternation(processAliases) +
        ')(?!' +
        JS_IDENTIFIER_PART_PATTERN +
        ')\\s*' +
        fixedPropertyAccess('env'),
      'gu',
    ),
  ];
  for (const pattern of unwrappedAccessPatterns) {
    for (const match of codeMatches(searchable, pattern, code)) {
      lines.add(lineAt(match.index));
    }
  }
  for (const line of parsedNodeEnvironmentAccessLines(
    searchable,
    code,
    globalAliases,
    processAliases,
    lineAt,
  )) {
    lines.add(line);
  }

  return lines;
}

function pythonOsAccessLines(source, searchable) {
  const aliases = new Set();
  PYTHON_IMPORT.lastIndex = 0;
  for (const match of searchable.matchAll(PYTHON_IMPORT)) {
    const bindings = match[1].replaceAll('\\', ' ');
    const osBinding = new RegExp(
      '(?:^|,)\\s*os(?:\\s+as\\s+(' +
        PYTHON_IDENTIFIER +
        '))?(?=\\s*(?:,|$))',
      'gu',
    );
    for (const binding of bindings.matchAll(osBinding)) {
      aliases.add(pythonIdentifierKey(binding[1] ?? 'os'));
    }
  }

  let changed = aliases.size > 0;
  while (changed) {
    changed = false;
    const assignmentChain = new RegExp(
      '(?:^|[;\\n])\\s*' +
        '((?:' +
        PYTHON_IDENTIFIER +
        '(?:\\s*:\\s*[^=;\\r\\n]+)?\\s*=\\s*)+)' +
        '(?:\\(\\s*)*(' +
        PYTHON_IDENTIFIER +
        ')(?!' +
        PYTHON_IDENTIFIER_PART_PATTERN +
        ')(?:\\s*\\))*\\s*(?=[;\\r\\n]|$)',
      'gmu',
    );
    for (const match of searchable.matchAll(assignmentChain)) {
      if (!aliases.has(pythonIdentifierKey(match[2]))) continue;
      const leftHandSide = new RegExp(
        '(' +
          PYTHON_IDENTIFIER +
          ')\\s*(?::\\s*[^=;\\r\\n]+)?\\s*=',
        'gu',
      );
      for (const binding of match[1].matchAll(leftHandSide)) {
        const alias = pythonIdentifierKey(binding[1]);
        if (!aliases.has(alias)) {
          aliases.add(alias);
          changed = true;
        }
      }
    }
  }

  const lines = new Set();
  const access = new RegExp(
    '(?<!' +
      PYTHON_IDENTIFIER_PART_OR_DOT_PATTERN +
      ')(' +
      PYTHON_IDENTIFIER +
      ')(?!' +
      PYTHON_IDENTIFIER_PART_PATTERN +
      ')\\s*\\.\\s*(' +
      PYTHON_IDENTIFIER +
      ')(?!' +
      PYTHON_IDENTIFIER_PART_PATTERN +
      ')(\\s*\\()?',
    'gu',
  );
  for (const match of searchable.matchAll(access)) {
    if (!aliases.has(pythonIdentifierKey(match[1]))) continue;
    const property = pythonIdentifierKey(match[2]);
    if (property === 'environ' || (property === 'getenv' && match[3] !== undefined)) {
      lines.add(lineNumberAt(source, match.index));
    }
  }
  return lines;
}

function violationLines(source, isPython) {
  const javascriptLexical = isPython ? null : javascriptLexicalView(source);
  const lexical = isPython
    ? { normalized: pythonLexicalView(source), code: null, originalIndexes: null }
    : canonicalizeJavascriptIdentifiers(
        javascriptLexical.normalized,
        javascriptLexical.code,
      );
  const searchable = lexical.normalized;
  const lineAt = (index) => {
    const originalIndex =
      lexical.originalIndexes === null
        ? index
        : lexical.originalIndexes[
            Math.min(Math.max(index, 0), lexical.originalIndexes.length - 1)
          ];
    return lineNumberAt(source, originalIndex);
  };
  const lines = new Set();
  for (const pattern of DIRECT_FORBIDDEN) {
    for (const match of codeMatches(searchable, pattern, lexical.code)) {
      lines.add(lineAt(match.index));
    }
  }

  for (const match of codeMatches(searchable, NODE_PROCESS_ALIAS, lexical.code)) {
    const alias = escapeRegExp(match[1]);
    const access = new RegExp(
      '(?<!' +
        JS_IDENTIFIER_PART_PATTERN +
        ')' +
        alias +
        '(?!' +
        JS_IDENTIFIER_PART_PATTERN +
        ')\\s*(?:(?:\\.|\\?\\.)\\s*env(?!' +
        JS_IDENTIFIER_PART_PATTERN +
        ')|(?:\\?\\.\\s*)?\\[\\s*([\'"`])env\\1\\s*\\])',
      'gu',
    );
    for (const aliasMatch of codeMatches(searchable, access, lexical.code)) {
      lines.add(lineAt(aliasMatch.index));
    }
  }

  if (!isPython) {
    for (const line of nodeEnvironmentAccessLines(searchable, lexical.code, lineAt)) {
      lines.add(line);
    }
    return lines;
  }

  PYTHON_FROM_OS_IMPORT.lastIndex = 0;
  for (const match of searchable.matchAll(PYTHON_FROM_OS_IMPORT)) {
    const imported = match[1]
      .replace(/#[^\r\n]*/g, (comment) => ' '.repeat(comment.length))
      .replaceAll('\\', ' ');
    // Match the imported symbol, not an unrelated symbol merely aliased *to*
    // the same local name (for example, `path as getenv`).
    const forbiddenName = /(?:^|[,(])\s*(getenv\b|environ\b|\*)/.exec(imported);
    if (forbiddenName) {
      const nameOffset = forbiddenName.index + forbiddenName[0].lastIndexOf(forbiddenName[1]);
      const offset = match[0].indexOf(match[1]) + nameOffset;
      lines.add(lineNumberAt(source, match.index + offset));
    }
  }

  for (const line of pythonOsAccessLines(source, searchable)) {
    lines.add(line);
  }
  return lines;
}

const violations = [];
for (const file of trackedFiles()) {
  if (!SOURCE_EXTENSION.test(file) || EXCLUDED_SEGMENT.test(file) || ALLOWLIST.has(file)) continue;
  if (!existsSync(file)) continue;
  const source = readFileSync(file, 'utf8');
  const lines = violationLines(source, file.toLowerCase().endsWith('.py'));
  for (const line of [...lines].sort((a, b) => a - b)) violations.push(`${file}:${line}`);
}

if (violations.length > 0) {
  console.error('Direct environment access is restricted to the central loaders:');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exitCode = 1;
} else {
  console.log('Secret-access gate passed.');
}
