// Regenerates .sdd/ledger/index.json from every .sdd/ledger/<run-id>/entry.md on disk (PL-03c).
//
// Usage:
//   node scripts/build-ledger-index.mjs            # writes .sdd/ledger/index.json
//   node scripts/build-ledger-index.mjs --check    # exit 1 + diff if index.json is stale
//
// index.json maps a repo-relative file path to every ledger run that touched it:
//   { "services/core/src/graph-query/index.ts": [ { runId, ticket, date, spec }, ... ] }
// This is the file-granularity query path spec.md describes: buggy file -> index.json -> the
// spec(s) that mandated it (the same shape as generate-agent-shims.mjs's --check contract — never
// hand-edit index.json, regenerate it and commit the result).
//
// entry.md is parsed with plain `## Heading` section splitting, not a markdown parser — the shape
// is fixed by this script and by ledger-append.mjs together (see .sdd/ledger/README.md), so a
// hand-authored entry (e.g. the PL-03a migration) just has to follow the same headings.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const ledgerDir = join(repoRoot, '.sdd', 'ledger');
const indexPath = join(ledgerDir, 'index.json');

function fail(message) {
  process.stderr.write(`build-ledger-index: ${message}\n`);
  process.exit(1);
}

function relFromRoot(path) {
  return path.split(repoRoot + '\\').join('').split(repoRoot + '/').join('').replace(/^[\\/]/, '').split('\\').join('/');
}

/** Every immediate subdirectory of .sdd/ledger/ is one run — README.md sits alongside them as a
 * file, not a directory, so it's excluded by the isDirectory() filter without special-casing it. */
function listRunDirs() {
  if (!existsSync(ledgerDir)) return [];
  return readdirSync(ledgerDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Escapes a string for literal use inside a RegExp — headings passed to extractSection are
 * ordinary words today ("Verdict", "Files touched") but at least one real heading contains regex
 * metacharacters ("Content hashes (SHA-256)", used by check-red-integrity.mjs), so this is not
 * defensive-for-no-reason: without it, the parentheses are interpreted as a capturing group and the
 * literal "(" / ")" in the actual markdown are never matched at all. */
function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Returns the 1-based line numbers of every line that is *exactly* an ATX "## <heading>" line
 * (line-start, exactly two `#`, at least one space/tab, optional trailing whitespace, nothing
 * else). Splitting on `\r?\n` first (rather than a `^`/`m`-flag regex over the whole string) means
 * each candidate line is tested in isolation, so counting is unaffected by anything upstream or
 * downstream of it on the page — including a fenced code block or an HTML comment the line happens
 * to sit inside, since this function has no concept of either. That is deliberate: see
 * extractSection's own comment for why counting occurrences (not parsing markdown structure) is
 * this round's fix. */
function findHeadingLineNumbers(markdown, escapedHeading) {
  const headingLinePattern = new RegExp(`^##[ \\t]+${escapedHeading}[ \\t]*$`);
  const lines = markdown.split(/\r?\n/);
  const lineNumbers = [];
  lines.forEach((line, index) => {
    if (headingLinePattern.test(line)) lineNumbers.push(index + 1);
  });
  return lineNumbers;
}

/** Returns the text between "## <heading>" (a heading, not a substring — see below) and the next
 * "## " heading (or end of file), or null if the heading isn't present. Deliberately simple
 * line-based parsing, not a markdown parser — see file header. Exported so ledger-append.mjs
 * (which writes and needs to re-derive parts of entry.md/spec.md/review.md/security-report.md) and
 * check-red-integrity.mjs share one implementation rather than a second, possibly-drifting copy.
 *
 * The heading is located by findHeadingLineNumbers — the exact same line-by-line, exactly-two-`#`-
 * plus-whitespace test used to *count* occurrences (below) — and the section is then sliced out by
 * line index: everything after that heading's line, up to (but not including) the next line that is
 * itself an ATX "## " heading of any name, or end of document. Locating and slicing through one
 * shared predicate is load-bearing, not a style choice (PL-03c round 4, review Critical 1): this
 * function used to run a second, independently-configured `RegExp` here (`im` flags, matched over
 * the whole document rather than line-by-line) that disagreed with the counter in two ways a
 * document's author never has to think about — case (the old extractor was case-insensitive; the
 * counter was not) and line terminators (the old extractor's `^`, under `m`, also matched after a
 * lone `\r`, `U+2028`, or `U+2029`; the counter only ever split on `\r?\n`). A heading shadow
 * exploiting either mismatch was invisible to the counter (which still saw exactly one heading — the
 * real one — and so never refused) while still fully matchable by the old extractor, which silently
 * resolved to the shadow instead of the real section. Reproduced end-to-end: a live
 * ledger-append.mjs run recorded `review: PASS` for a review.md whose real `## Verdict` was
 * `NEEDS_FIXES`, through exactly that gap. The fix removes the second regex rather than patching it
 * to match the first one's flags/splitting — one function decides what a heading line is, for both
 * jobs, so there is nothing left to drift. The invariant this establishes is **"the counter and the
 * extractor share a single predicate for what counts as a heading line,"** not "a count check closes
 * the class of shadowing bugs" — the latter was this round's incorrect reasoning, and is exactly what
 * let the case/line-terminator gap through unnoticed while every count-based test still passed.
 *
 * The shared predicate anchors to the true start of a line and requires exactly two `#` followed by
 * whitespace (unchanged since round 2). That is what rules out `### Verdict`/`#### Verdict`
 * subheadings and mid-line prose ("see ## Verdict" followed by a line reading "PASS") from ever
 * counting as a match, and it is also why a nested `### Subsection` inside the real section is
 * correctly treated as content rather than a terminator — only a line-start "## " (any heading) ends
 * the slice.
 *
 * PL-03c round 3: fenced-code-block headings, HTML-comment headings, and genuine duplicate headings
 * are still just "a second matching line" to this predicate — findHeadingLineNumbers has no concept
 * of fences or comments — so any of those still throws (count > 1) rather than silently resolving.
 * Full fence/comment-aware parsing that could instead *resolve* to the one real heading is out of
 * scope here — tracked as PL-03h. */
export function extractSection(markdown, heading) {
  const escapedHeading = escapeForRegExp(heading);
  const headingLines = findHeadingLineNumbers(markdown, escapedHeading);
  if (headingLines.length > 1) {
    throw new Error(
      `extractSection: "## ${heading}" appears ${headingLines.length} times (line(s) ${headingLines.join(', ')}) ` +
      '— expected exactly one. Refusing rather than guessing which is real (a fenced code block, an ' +
      'HTML comment, or a genuine duplicate heading can all produce a second match); see PL-03h for ' +
      'fence/comment-aware parsing that could resolve this instead of refusing.',
    );
  }
  if (headingLines.length === 0) return null;

  // Slice by line index, using the same `\r?\n` split findHeadingLineNumbers used to find this
  // heading in the first place — this is what makes counting and extraction agree by construction,
  // rather than by keeping two separately-configured regexes in sync.
  const lines = markdown.split(/\r?\n/);
  const startIndex = headingLines[0]; // 1-based heading line number == 0-based index of the first content line
  const anyHeadingLinePattern = /^##[ \t]/;
  let endIndex = lines.length;
  for (let index = startIndex; index < lines.length; index++) {
    if (anyHeadingLinePattern.test(lines[index])) {
      endIndex = index;
      break;
    }
  }
  return lines.slice(startIndex, endIndex).join('\n').trim();
}

export function extractFirstLine(markdown, heading) {
  const section = extractSection(markdown, heading);
  if (!section) return null;
  const firstLine = section.split(/\r?\n/)[0].trim();
  return firstLine.length > 0 ? firstLine : null;
}

function parseFilesTouched(entryMarkdown) {
  const section = extractSection(entryMarkdown, 'Files touched');
  if (!section) return [];
  return [...section.matchAll(/^-[ \t]+(\S.*)$/gm)].map((match) => match[1].trim());
}

/** A ledger entry only exists because ledger-append.mjs already re-verified both gates showed
 * `PASS` (or, for the one hand-authored migration, because a human did the equivalent check by
 * hand) — so an entry's own "## Verdicts" section must read exactly this, always. This is the
 * `.sdd/ledger/README.md` Warning 1 fix: hand-authoring is a documented affordance, and this
 * assertion is what stops a hand-authored (or corrupted) entry from ever claiming a pass that
 * didn't happen, closing the last gap left once extractSection's own anchoring bug (above) is
 * fixed. Runs on every buildIndex() call — write and --check alike — not only in --check mode,
 * since an entry this malformed should never make it into index.json at all. */
function assertVerdictsAreClean(entryMarkdown, runId) {
  const expected = '- review: PASS\n- security: PASS';
  const section = extractSection(entryMarkdown, 'Verdicts');
  if (section !== expected) {
    fail(
      `.sdd/ledger/${runId}/entry.md's "## Verdicts" section must read exactly:\n${expected}\n` +
      `but found: ${section === null ? '(no "## Verdicts" section at all)' : JSON.stringify(section)}\n` +
      'A ledger entry only exists because both gates passed — this one claims something the script cannot verify, or is malformed, and must not be indexed.',
    );
  }
}

/** Builds the in-memory index (file path -> sorted array of run references) from every ledger run
 * directory on disk. Exported so ledger-append.mjs can call it directly after writing a new entry,
 * rather than shelling out to this file as a subprocess. */
export function buildIndex() {
  const index = {};
  for (const runId of listRunDirs()) {
    const entryPath = join(ledgerDir, runId, 'entry.md');
    const specPath = join(ledgerDir, runId, 'spec.md');
    if (!existsSync(entryPath)) fail(`.sdd/ledger/${runId}/ has no entry.md`);
    if (!existsSync(specPath)) fail(`.sdd/ledger/${runId}/ has no spec.md`);

    const entry = readFileSync(entryPath, 'utf8');
    assertVerdictsAreClean(entry, runId);
    const ticket = extractFirstLine(entry, 'Ticket') ?? '(unknown ticket)';
    const date = extractFirstLine(entry, 'Date') ?? '(unknown date)';
    const files = parseFilesTouched(entry);

    for (const file of files) {
      if (!index[file]) index[file] = [];
      index[file].push({ runId, ticket, date, spec: `.sdd/ledger/${runId}/spec.md` });
    }
  }

  // Deterministic ordering so regeneration is byte-stable: sort file keys, and sort each file's
  // runs by runId (every run id begins with a sortable UTC timestamp, so this is also chronological).
  const sorted = {};
  for (const file of Object.keys(index).sort()) {
    sorted[file] = index[file].slice().sort((a, b) => a.runId.localeCompare(b.runId));
  }
  return sorted;
}

/** Unconditional `\n` line endings and a trailing newline, same reasoning as
 * generate-agent-shims.mjs: .gitattributes pins LF on this path so --check is byte-stable across
 * Windows and Linux checkouts. */
export function serializeIndex(index) {
  return JSON.stringify(index, null, 2) + '\n';
}

/** Builds the index and writes it to .sdd/ledger/index.json. Exported so ledger-append.mjs can
 * regenerate the index itself immediately after writing a new ledger entry, in the same process. */
export function writeIndex() {
  const index = buildIndex();
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(indexPath, serializeIndex(index), 'utf8');
  return index;
}

function main() {
  const checkMode = process.argv.includes('--check');
  const index = buildIndex();
  const content = serializeIndex(index);
  const fileCount = Object.keys(index).length;
  const runCount = listRunDirs().length;

  if (checkMode) {
    const current = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null;
    if (current === content) {
      console.log(`build-ledger-index --check: ${relFromRoot(indexPath)} is up to date (${fileCount} file(s), ${runCount} run(s)).`);
      process.exit(0);
    }
    process.stderr.write(`build-ledger-index --check: ${relFromRoot(indexPath)} is stale.\n\n`);
    process.stderr.write(`-- expected (regenerated from .sdd/ledger/*/entry.md) --\n${content}\n`);
    process.stderr.write(`-- actual (on disk) --\n${current ?? '(file does not exist)\n'}\n`);
    process.stderr.write('Run `node scripts/build-ledger-index.mjs` to regenerate, or `npm run generate:ledger-index`.\n');
    process.exit(1);
  }

  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(indexPath, content, 'utf8');
  console.log(`build-ledger-index: wrote ${relFromRoot(indexPath)} (${fileCount} file(s), ${runCount} run(s)).`);
}

// Only run as a CLI entry point — importing buildIndex/writeIndex (e.g. from ledger-append.mjs)
// must not also trigger this file's own --check/write side effects against the importer's argv.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    // extractSection (via assertVerdictsAreClean/parseFilesTouched/extractFirstLine) throws rather
    // than exiting directly when a heading is ambiguous (see extractSection's own comment) — catch
    // it here so the CLI still prints one clean, prefixed message and exits 1, instead of a raw
    // Node stack trace.
    fail(error.message);
  }
}
