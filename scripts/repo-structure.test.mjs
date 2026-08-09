// Red-stage behavioral tests for PL-15 (Repo restructure: separate the marketing site from the
// monorepo root). Authored from .pipeline/spec.md alone, before `dev` implements anything, per
// .sdd/stages/red.md — every assertion below traces to a spec `AC-*`/`EC-*` item, not to a diff.
//
// Convention: node:test + plain assertions over the repository's own shape, matching the other
// repo-hygiene suites under scripts/*.test.mjs (sdd-completeness.test.mjs, dependency-baseline.
// test.mjs). Run with:
//   node --test scripts/repo-structure.test.mjs
//
// This file must live DIRECTLY in scripts/, never in a subdirectory: scripts/sdd-completeness.
// test.mjs enumerates suites with a non-recursive readdirSync('scripts') and maps them to npm
// scripts with the regex `scripts/([\w.-]+\.test\.mjs)`, whose character class cannot cross a `/`
// (spec EC-8). Until `dev` adds the matching package.json "test:*" entry and the CI step,
// `npm run test:sdd-completeness` fails on this file — that is a correct red failure, not a defect
// in this suite.
//
// ---------------------------------------------------------------------------------------------
// Three notes a reader (and `dev`) needs before touching the assertions below.
//
// 1. BYTE-IDENTITY IS PINNED, NOT INFERRED. AC-1/AC-9/EC-17 require moved files to be byte-identical
//    to their pre-move contents. Those contents exist only *before* the move, so their digests are
//    captured here, at red time, from the pre-move tree at 17e2299. Text files are hashed with CRLF
//    normalised to LF so a Windows checkout and Linux CI agree; binaries are hashed raw.
//
// 2. SOME ASSERTIONS ARE PRESERVATION GUARDS AND ALREADY PASS. This ticket is a move, so several
//    spec items (EC-8, EC-9, EC-12, EC-13, EC-15, EC-21, AC-18) say "this must NOT change." Their
//    tests pass today by construction and must keep passing after `dev`; the suite as a whole is
//    still red today because the move itself has not happened. Each such test says so in its own
//    comment.
//
// 3. THE AC-12 SWEEP HAS TWO KNOWN SPEC TENSIONS, both flagged in .pipeline/red.md:
//    (a) `apps/web/.claude/skills/redteam-ux/driver.mjs` carries a prose comment naming
//        `scripts/render-anime-hero.mjs`. AC-12 says that pattern must have zero hits in tracked
//        files; AC-18 says apps/web/** may change only in package.json's `description`. One of the
//        two has to give. This suite encodes AC-12 literally (the sweep will flag it) and
//        deliberately does NOT enumerate every apps/web file for AC-18, so fixing that one comment
//        satisfies both tests and leaves the deviation for `review` to judge and `dev` to declare.
//    (b) Any *new* doc that explains the restructure (docs/repo-structure.md, DEPENDENCIES.md's
//        PL-15 note, apps/site/README.md) must describe the moves WITHOUT writing the literal old
//        tokens — "renamed off `sayre-site`" or a `Design System/` → `docs/design-system/` migration
//        table would be a sweep hit under AC-12 as written. Phrase around it.
//    (c) The audit artifacts AC-9 commits are dated snapshots that name the old paths dozens of
//        times, and AC-9 requires them byte-identical to the untracked originals. AC-12 and AC-9 are
//        unsatisfiable together unless docs/audits/** is swept-exempt the way .sdd/ledger/** already
//        is; this suite exempts it and says so at SWEEP_EXCLUDED_PREFIXES.
// ---------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const BINARY_EXTENSION = /\.(?:png|webp|mp4|webm|pdf|ico|jpe?g|gif|woff2?)$/i;

// --- small helpers ----------------------------------------------------------------------------

const abs = (rel) => join(repoRoot, rel);
const exists = (rel) => existsSync(abs(rel));
const isDir = (rel) => existsSync(abs(rel)) && statSync(abs(rel)).isDirectory();
const readText = (rel) => readFileSync(abs(rel), 'utf8');
const readJson = (rel) => JSON.parse(readText(rel));

/** tsconfig files in this repo are JSONC (scripts/tsconfig.json carries a long rationale comment).
 *  Every comment in them is a whole-line `//` comment, so dropping those lines is a safe parse. */
function readJsonc(rel) {
  const stripped = readText(rel)
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  return JSON.parse(stripped);
}

/** SHA-256 of a file: raw bytes for binaries, CRLF-normalised UTF-8 for text, so a pinned digest
 *  means the same thing on a Windows checkout (core.autocrlf) and on Linux CI. */
function contentDigest(rel) {
  const buf = readFileSync(abs(rel));
  const input = BINARY_EXTENSION.test(rel) ? buf : buf.toString('utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(input).digest('hex');
}

function git(args) {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  return r;
}

/** npm is a .cmd shim on Windows, which Node refuses to spawn without a shell (EINVAL) since the
 *  v18.20/v20.12 command-injection fix — so the shell is required there, not optional. Every
 *  argument passed here is a bare token (no spaces, no shell metacharacters). */
function runNpm(args) {
  const r = spawnSync(NPM, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: r.status,
    output: `--- stdout ---\n${r.stdout ?? ''}\n--- stderr ---\n${r.stderr ?? ''}${r.error ? `\n--- spawn error ---\n${r.error.message}` : ''}`,
  };
}

/** Every tracked path, repo-relative, forward-slashed. */
function trackedFiles() {
  const r = git(['ls-files', '-z']);
  assert.equal(r.status, 0, `git ls-files failed: ${r.stderr}`);
  return r.stdout.split('\0').filter(Boolean);
}

function isTracked(rel) {
  const r = git(['ls-files', '--error-unmatch', rel]);
  return r.status === 0;
}

/** Recursive listing of a directory, relative to that directory, sorted. */
function walk(rel, prefix = '', out = []) {
  for (const name of readdirSync(abs(rel)).sort()) {
    const child = prefix ? `${prefix}/${name}` : name;
    if (statSync(join(abs(rel), name)).isDirectory()) walk(`${rel}/${name}`, child, out);
    else out.push(child);
  }
  return out.sort();
}

// --- pinned pre-move state (captured at red time, from the tree at 17e2299) ---------------------

/** [newPath, oldPath, sha256] for every moved file whose contents must be byte-identical after the
 *  move. Deliberately excluded (the spec's only sanctioned content changes): apps/site/vite.config.ts,
 *  apps/site/src/landing/heroTreeData.ts, apps/site/scripts/export-tree.mjs, and
 *  docs/product/SAYRE_FRONTEND_SPEC.md.
 *
 *  AMENDED (dev attempts 2 and 3, post security-BLOCKED rounds — spec.md's AC-9 amendment): four
 *  entries are pinned post-redaction rather than pre-move-pristine —
 *  docs/audits/deep-audit-2026-07-31/audit-18-infra-cicd.md (a live NEO4J_AUTH credential value
 *  redacted), docs/audits/deep-audit-2026-07-31/audit-15-secrets-deps.md (a 12-secret exact
 *  file:line/REAL-tag/masked-value inventory generalized to name + category only), and the two
 *  corroborating files docs/audits/deep-audit-2026-07-31.md and
 *  docs/audits/architecture-assessment-2026-07.md (cross-reference notes; deep-audit-2026-07-31.md
 *  also had one placeholder-value rendering normalized). Digests below are attempt 3's final state:
 *  attempt 2 first replaced the live value / exact-location table with masked fragments (still real
 *  characters of the real secrets); attempt 3 replaced those fragments with zero-character
 *  placeholders, because a masked fragment is still real secret material once committed. A round-3
 *  hand-fix under /re-gate (review pass 2's fix list) then also generalized the exact
 *  line-to-secret table deep-audit-2026-07-31.md §P0-5 still carried, and dropped audit-18's two
 *  exact line citations for the credential — the prior claim here that the corroborating files
 *  "carried no exact-location table" was wrong, corrected in spec.md's AC-9 amendment round 3.
 *  See .pipeline/security-report.md and spec.md's AC-9 amendment for the full record. Declared as a
 *  red-test change in .pipeline/changes.json. */
const MOVED_FILE_DIGESTS = [
  ['apps/site/index.html', 'index.html', '1afe7232c8c6896ddb95be3bfeabd1efce70382e25c92633341de56ab538f908'],
  ['apps/site/src/App.tsx', 'src/App.tsx', '2e5beac398cdbaf738d34f936644bab9366e5d48c5a1bba044cd10fc7c4d1eeb'],
  ['apps/site/src/config.ts', 'src/config.ts', 'e18219983c12ffaf8a91744c2f66e2177fc9fce9c07a95bbbbad210eb8ee2076'],
  ['apps/site/src/data/copy.ts', 'src/data/copy.ts', '97b7dd6086eaff631c3a62ac8e5d370b56910b176eac250b5c681aa99a1bf324'],
  ['apps/site/src/data/edges.ts', 'src/data/edges.ts', 'cfc9f80fb12a6a28093294bcf78021c38d0813329c9c54bc7a62275527c12746'],
  ['apps/site/src/data/features.ts', 'src/data/features.ts', '75576826dff3af75d7d66c4de1f55851a76bcc73767e6353cab24d3030b99e0a'],
  ['apps/site/src/data/index.ts', 'src/data/index.ts', 'b1a2c9050f2005bc6aacfe8894ae3f179069509e26dd795ce89815fe36f12a2e'],
  ['apps/site/src/data/people.ts', 'src/data/people.ts', '00ef8028a3e920bf352fa349a714c1512db6d0f75cb58eb5f996fc4cd182e7d7'],
  ['apps/site/src/data/personas.ts', 'src/data/personas.ts', 'e7b9449884c6b5b65ed53efe11c1b836e0d4a1cb4b553a9fa832efde3f0ccf10'],
  ['apps/site/src/data/repo.ts', 'src/data/repo.ts', '9d37572415aaa5873ee72c153f545f9b3287e18b2892731256215e4ca2897fd0'],
  ['apps/site/src/data/tickets.ts', 'src/data/tickets.ts', 'a783be1057ba3fb2521f3fb055cc89937295495ebe0fe8951e27c5584a8f5ed9'],
  ['apps/site/src/data/tour.ts', 'src/data/tour.ts', '4574d514b20ff805c2d5461b47fd70d44afd492203d4cbac82d13241adf0d4c0'],
  ['apps/site/src/data/types.ts', 'src/data/types.ts', 'f7ba69904be62b1e20e410cc1de9cf2b154c8123bf49d408417223d3ccc4518e'],
  ['apps/site/src/data/validate.ts', 'src/data/validate.ts', '39c8dfae90a219e59cbab0fa4035ed79fabb902c73c0d0078224f662d0357e59'],
  ['apps/site/src/demo/DemoPage.tsx', 'src/demo/DemoPage.tsx', '350485feb2f74aabd2582c7951c7d3d893d361406ea026b09a816e83d156fd77'],
  ['apps/site/src/demo/FeaturePanel.tsx', 'src/demo/FeaturePanel.tsx', '074614063ede35d27750602a1322a2a4f40692f8ce3b4249f034b379a1eb493f'],
  ['apps/site/src/demo/Markdown.tsx', 'src/demo/Markdown.tsx', '247a27c877598800575c737adaec3e93a8c2fb719fea6dc6a5972179e94861ed'],
  ['apps/site/src/demo/Sidebar.tsx', 'src/demo/Sidebar.tsx', '8dca7154cef786cbfe45637061ef1b7596a0a5de51dbaa6978b33b83e96574d3'],
  ['apps/site/src/demo/StatusLine.tsx', 'src/demo/StatusLine.tsx', 'a30c197eb39cf5fce2ac4265f21887f3f87f2283daacacbb5983fca856399bc5'],
  ['apps/site/src/demo/TopBar.tsx', 'src/demo/TopBar.tsx', '967774cd91b9027f065812eedcf116e24b22cf1bf4b16fe09a102c81bf059a93'],
  ['apps/site/src/demo/TreePanel.tsx', 'src/demo/TreePanel.tsx', '68ad80510439bfbddd830188493f2d76bd88453d492f908e7f325fe32962ff1a'],
  ['apps/site/src/demo/canvas/FeaturesView.tsx', 'src/demo/canvas/FeaturesView.tsx', '8459018d977f26c01df98d5b38bc3ee8f1979742cebb3d9eb202fe045bdd6505'],
  ['apps/site/src/demo/canvas/FiletreeView.tsx', 'src/demo/canvas/FiletreeView.tsx', 'e27c71527fd1050c2f45d8b29fbb6bb70de50df5d4b5cb07959ec639cd0b66a0'],
  ['apps/site/src/demo/canvas/RelationsView.tsx', 'src/demo/canvas/RelationsView.tsx', '2b34b2335d60acf4c9e5c2f04bb91c3c83f29fba23fa11f6913f91077d12a388'],
  ['apps/site/src/demo/canvas/layout.ts', 'src/demo/canvas/layout.ts', 'b6e04a11445e4b1d47b4245223646e8bcbae22d013f1bb2a60d91a4e52042b93'],
  ['apps/site/src/demo/canvas/measure.ts', 'src/demo/canvas/measure.ts', '9ff249c3085f4f5d24f4f2e5c88fe98d9cc921f28ff14a0e0c37d34db8375a58'],
  ['apps/site/src/demo/canvas/rollup.ts', 'src/demo/canvas/rollup.ts', 'd601961c6c4062b30fc7056d10de445f036386809e4d13f655008b44e43848bb'],
  ['apps/site/src/demo/canvas/useAnimatedPositions.ts', 'src/demo/canvas/useAnimatedPositions.ts', '57efdc9c8f33ee8554104dd1d78ba74972141e89d47784517a044a7b161f20ed'],
  ['apps/site/src/demo/canvas/useCamera.ts', 'src/demo/canvas/useCamera.ts', '18390b414e0287de21ffa349eb52e94e496cf730f1dbdffb61e8362ffd0bc58f'],
  ['apps/site/src/demo/search/CommandK.tsx', 'src/demo/search/CommandK.tsx', '664abdb3e5342453e32c733821fe6dc68d1d986e97452ea0175a2cb2ad5e6a67'],
  ['apps/site/src/demo/search/fuzzy.ts', 'src/demo/search/fuzzy.ts', 'a97f589abfb0ae3b77f42aba827b342a39e7427c21f8a2ace76cb4ddb8dad0e6'],
  ['apps/site/src/demo/search/useFileSearch.ts', 'src/demo/search/useFileSearch.ts', 'e94a56ba4c9bfff2c2b9ca32f2b298e37dddfa3208fffe521061306faa5610e1'],
  ['apps/site/src/demo/state.ts', 'src/demo/state.ts', '94b3fa7aa9e41991572286f2d0b56da46a4a1cb17b85f14a90f4a21756cea02d'],
  ['apps/site/src/demo/tour/Tour.tsx', 'src/demo/tour/Tour.tsx', '19b52c96bd928f76714a17d86c7de5e2e26897780e048bf337eee781aa6bc6c0'],
  ['apps/site/src/landing/CanvasSandbox.tsx', 'src/landing/CanvasSandbox.tsx', '904d394e116b374785ac4bedae9b85cdf7d1cd3c1bdc4c36c4ab810d79efc4ed'],
  ['apps/site/src/landing/FeatureDeck.tsx', 'src/landing/FeatureDeck.tsx', 'a934c1a6c1025c614711f58072aa827f653e719842e901e9e4c602a9c6e5b0d0'],
  ['apps/site/src/landing/HeroAnimeVideo.tsx', 'src/landing/HeroAnimeVideo.tsx', 'fa0b895d920dd6ed450ca89a3ad093ca9404a58a875fa3f3efde94fe874a5da7'],
  ['apps/site/src/landing/HeroTreeScene.tsx', 'src/landing/HeroTreeScene.tsx', '209f0cd33d6be1580b5d23fdaf61f8daef7b0a734e231ddb60f79394f3363bdf'],
  ['apps/site/src/landing/LandingPage.tsx', 'src/landing/LandingPage.tsx', '05719e14a49c2cf7e42d87f97f53719162c42644797b47e6517128e51c8b6821'],
  ['apps/site/src/landing/Reveal.tsx', 'src/landing/Reveal.tsx', 'b555240c9ea41cd29667cf9af112f28646e26c54da3936c71c71a25e72bfe965'],
  ['apps/site/src/landing/lensGraphs.ts', 'src/landing/lensGraphs.ts', 'a4bb99473a92c1ecedbea773f5e4c32f2d8c01434253acd81e64bb18f9669d6b'],
  ['apps/site/src/legal/PrivacyPage.tsx', 'src/legal/PrivacyPage.tsx', 'de81ca695eddec981ee5cd4f7e3546629ee3ea690948d870bdbc99e0ddf303d7'],
  ['apps/site/src/main.tsx', 'src/main.tsx', '40cd8bd7c35220fd3afd2dacd835028befef123c5bbb288b5e1cce828a890a67'],
  ['apps/site/src/shared/Button.tsx', 'src/shared/Button.tsx', 'af21b898d165e8f46742db9b43c20f078accd82332801672d174dd8d537ab12c'],
  ['apps/site/src/shared/Chip.tsx', 'src/shared/Chip.tsx', 'dd62b575fe99af0b3b5258cb1ee316897b14957e30af07a44bbf8d431e4581b0'],
  ['apps/site/src/shared/Modal.tsx', 'src/shared/Modal.tsx', '308fd81f63a12707bd4a0e0a2b91f634109fabbe9f3332f2f3aecf996c46400d'],
  ['apps/site/src/shared/WaitlistForm.tsx', 'src/shared/WaitlistForm.tsx', '5592c59f70c59a636ee6b64305f62733f9cad101067ee1b3f63d3640b11acf63'],
  ['apps/site/src/styles/base.css', 'src/styles/base.css', 'd5316a92dc6def885ff431f1abd3211e244a6491a8caccd02f43ca47551c6274'],
  ['apps/site/src/styles/demo.css', 'src/styles/demo.css', '03ce1d0485f24c0069fc75bf9ae95df15049dc87a97e7f3b68718a7427a1ab3b'],
  ['apps/site/src/styles/landing.css', 'src/styles/landing.css', 'cf91bc8e5a56058d8b177414fe78524f6436d4b3faa3f808c47b81a23c2b069d'],
  ['apps/site/src/styles/privacy.css', 'src/styles/privacy.css', 'e6dc660929147bca4b36e0e48a97a1ff14c638a34c046816f90d1a9437e24bd9'],
  ['apps/site/src/styles/tokens.css', 'src/styles/tokens.css', '31de135c6e837f6e34cb71f885f8d0ec4d39ab63d111ced74543801b6179a053'],
  ['apps/site/src/vite-env.d.ts', 'src/vite-env.d.ts', '65996936fbb042915f7b74a200fcdde7e410f32a669b1ab9597cfaa4b0faddb5'],
  ['apps/site/public/_redirects', 'public/_redirects', '701e6b1fe5de354f4320522180fcd62924c8aa4a305a687b69acbc280d03b20d'],
  ['apps/site/public/favicon.svg', 'public/favicon.svg', '74abfcedb2bdfe50294266f8b0441a65111ecd8fb5cf66135a679ead83aae496'],
  ['apps/site/public/media/hero-anime-final-mobile.webp', 'public/media/hero-anime-final-mobile.webp', 'ca1fb1d113da9d6d40ef4a42b69515e467032d73ce2b11f135b69a93a9a37011'],
  ['apps/site/public/media/hero-anime-final.webp', 'public/media/hero-anime-final.webp', 'b8817fc5f4f2072ff1e92c9c8004d45f97e62918efcd56007c3d86bbe28fef16'],
  ['apps/site/public/media/hero-anime-mobile.mp4', 'public/media/hero-anime-mobile.mp4', '6cd4eac41d6a7c894cf4f49351a6d138414355726885e9b07fb45e56b9e61e24'],
  ['apps/site/public/media/hero-anime-mobile.webm', 'public/media/hero-anime-mobile.webm', '28bb628f5969867cd2bef3ee8e3bc06ff7719839618835d9cd372bae77efe950'],
  ['apps/site/public/media/hero-anime-start-mobile.webp', 'public/media/hero-anime-start-mobile.webp', '74c76f6e76cb1fab9f0dd79d895c9035dd0296746eab228111b4730fd82af269'],
  ['apps/site/public/media/hero-anime-start.webp', 'public/media/hero-anime-start.webp', '884d63f457bedcde852a2578c780e7e3ea85da647c7add29faf457dbd94cd106'],
  ['apps/site/public/media/hero-anime.mp4', 'public/media/hero-anime.mp4', '84bf2c360c825514277bc7292202538c3d3d91c7a5f85f38bacf01dc48999961'],
  ['apps/site/public/media/hero-anime.webm', 'public/media/hero-anime.webm', '18baea80cb3e15b653fd5581b1fe51d1e5148bca9c8871c8c76736ecbd7f6c18'],
  ['apps/site/public/og.png', 'public/og.png', 'c7f6e8ec784e1c7433c33a19ad136445f8e9cbeb31e5d8a010a2332f08cfacde'],
  ['apps/site/scripts/og.mjs', 'scripts/og.mjs', '057be8d15da1cafc0020cbf72c801daa198151b8761e4efd5da9075b3afc422b'],
  ['apps/site/scripts/render-anime-hero.mjs', 'scripts/render-anime-hero.mjs', 'ae6ff77da2263428e9e56e8c1b941ddeb48be3895e27e3597e4e127abf8ebfe2'],
  ['apps/site/scripts/smoke.mjs', 'scripts/smoke.mjs', '25071be544aaa735b88393ae9d94a48513baf2f9e407cbce136acb3e0267dd8d'],
  ['apps/site/scripts/test-waitlist.mjs', 'scripts/test-waitlist.mjs', '66971e84f475d0a02fee8afeff1ffc9022f4966855cae6dcc8202e4e8d31a962'],
  ['apps/site/scripts/anime-hero-render/entry.jsx', 'scripts/anime-hero-render/entry.jsx', '7ff99914630fa97bf1c43f4367b1042a309c24faf07ee954fb6a782bb34975a2'],
  ['apps/site/scripts/anime-hero-render/index.html', 'scripts/anime-hero-render/index.html', '2602482875affb8a266d8c981a197b1e23655f2eb2938d1fd41ca72ce4c6e94a'],
  ['apps/site/design/handoffs/anime-hero-animation/README.md', 'design/handoffs/anime-hero-animation/README.md', 'a3fed1ae2eca933f800c4cc015bd0f7da7c8b2296065d467876ca5c7690603fd'],
  ['apps/site/design/handoffs/anime-hero-animation/project/Hero Animation (Anime) - PINNED v1.dc.html', 'design/handoffs/anime-hero-animation/project/Hero Animation (Anime) - PINNED v1.dc.html', '4b570656a9aee0defebeff0b98cea16cc5d21c0c58c7e874eb512010c00e3d5a'],
  ['apps/site/design/handoffs/anime-hero-animation/project/Hero Animation (Anime) - PINNED v2.dc.html', 'design/handoffs/anime-hero-animation/project/Hero Animation (Anime) - PINNED v2.dc.html', '234db1de7edede0c97ca760a67606592e1df6b1b03ff20f5a580f63292d976d3'],
  ['apps/site/design/handoffs/anime-hero-animation/project/Hero Animation (Anime).dc.html', 'design/handoffs/anime-hero-animation/project/Hero Animation (Anime).dc.html', '9e08afaa729598cc5735e1c7df27d1e840024e82d53d7d172a8de960e0ac02f1'],
  ['apps/site/design/handoffs/anime-hero-animation/project/animations-v2.jsx', 'design/handoffs/anime-hero-animation/project/animations-v2.jsx', '738302faa1c370f97f8069bceee4873888f792ff7860cdd2c0280d4b9e82e87f'],
  ['apps/site/design/handoffs/anime-hero-animation/project/filetree-data.js', 'design/handoffs/anime-hero-animation/project/filetree-data.js', '76e21791070b73eb5a157ed1055f8337a46e63156a6bf55d78955439d60a14c1'],
  ['apps/site/design/handoffs/anime-hero-animation/project/hero-anime-scene-v1-pinned.jsx', 'design/handoffs/anime-hero-animation/project/hero-anime-scene-v1-pinned.jsx', 'a765aa8faf41c37e40568a5c2ef673388afa3455cc0d270c1de1e3f90d2d0452'],
  ['apps/site/design/handoffs/anime-hero-animation/project/hero-anime-scene-v2-pinned.jsx', 'design/handoffs/anime-hero-animation/project/hero-anime-scene-v2-pinned.jsx', 'fb2a08ab51067d3aff45ae41ae11538d439be558367ba4db5c61b31fb5887198'],
  ['apps/site/design/handoffs/anime-hero-animation/project/hero-anime-scene.jsx', 'design/handoffs/anime-hero-animation/project/hero-anime-scene.jsx', '2a1c54d87f8371e73fe5135ecfa6ac1e4456f4affe35a0220f681c526b0a6682'],
  ['apps/site/design/handoffs/anime-hero-animation/project/screenshots/deer-check.png', 'design/handoffs/anime-hero-animation/project/screenshots/deer-check.png', '06613905e099afb633e6c8414fb9da0f74202b2ce500072844c699be4526d9d9'],
  ['apps/site/design/handoffs/anime-hero-animation/project/screenshots/deer2.png', 'design/handoffs/anime-hero-animation/project/screenshots/deer2.png', '612f6846e942466b08e806354eebcc578e8bd59fdd03c351f405ffdcf422ab68'],
  ['apps/site/design/handoffs/anime-hero-animation/project/screenshots/flora-3s.png', 'design/handoffs/anime-hero-animation/project/screenshots/flora-3s.png', '43af528dd557606fbf5f76628f4e37a08b807736ea6a247a6513f7fc6ad7adc6'],
  ['apps/site/design/handoffs/anime-hero-animation/project/screenshots/flora2.png', 'design/handoffs/anime-hero-animation/project/screenshots/flora2.png', '3e556ab791da857197740a607c6c02dde9e3bd3a197fe0e45fee05638e634cf6'],
  ['apps/site/design/handoffs/anime-hero-animation/project/screenshots/flora3.png', 'design/handoffs/anime-hero-animation/project/screenshots/flora3.png', 'f58440b9a8293d3fbc38b1a4abf9310aa300ee6a0e232566681b5fc4fe3ad820'],
  ['apps/site/design/handoffs/anime-hero-animation/project/support.js', 'design/handoffs/anime-hero-animation/project/support.js', 'c60c49083997f51a592df118c0068475337afd20b8cfd8e1cd9d5eb0c7e254f6'],
  ['apps/site/design/handoffs/anime-hero-animation/project/tweaks-panel.jsx', 'design/handoffs/anime-hero-animation/project/tweaks-panel.jsx', '4f181eb354cd6885de03ec29560f1072678cc88bec4cbe8d937ca709e094503f'],
  ['docs/design-system/SAYRE_DESIGN_SYSTEM.md', 'Design System/SAYRE_DESIGN_SYSTEM.md', '0d55b9f2cdb4159630f1afcb8e0f928432e32991e66dfaa46fcb66d04af61c77'],
  ['docs/design-system/Sayre Directions-selection.png', 'Design System/Sayre Directions-selection.png', '04435d846662e664ee0b82265bab700189edb053af123de01c5bf526d225b9a5'],
  ['docs/design-system/filetree-graph-blank.png', 'Design System/filetree-graph-blank.png', 'a59388c16e5763fa0e95e58bf6a23881a50ccbac07d57f770fb34df760bfed6f'],
  ['docs/design-system/filetree-graph-labeled.png', 'Design System/filetree-graph-labeled.png', 'e1376c36c6c2f24a6833ae626e67edd82a6548b2748d5f235c9e6cfc74d3a244'],
  ['docs/design-system/filetree-graph.png', 'Design System/filetree-graph.png', 'f0fb62534cd0c80ca54c7513461ffbc36eb0f399d274bb695015f75609aa448b'],
  // docs/design-system/filetree-graph.svg is deliberately NOT pinned byte-for-byte here: its first
  // line is a provenance comment naming `scripts/export-tree.mjs`, which AC-12 requires repointed.
  // Its own test below pins everything except that line. Original digest, for the record:
  // ['docs/design-system/filetree-graph.svg', 'Design System/filetree-graph.svg', '82454c5c887839e6307dd8b62a1606811165127916d6169b04968b4dbbd01761'],
  ['docs/product/PRD-V1.pdf', 'Documents/PRD/PRD V1.pdf', 'ec86702be7d65a05bba3975789a4d16c9257570ec2148be6c285290935b4f0f7'],
  ['docs/audits/architecture-assessment-2026-07.md', 'docs/architecture-assessment-2026-07.md', 'a9c43a63a5bafab0702cca4e4b01254b839b3dd34cbf7ea89e129227cfc312fc'],
  ['docs/audits/deep-audit-2026-07-31.md', 'docs/deep-audit-2026-07-31.md', '42ff75684cc2590ecd0e8785cc40d2f66e6d638f4300f88c5ad4d3a47fd1e4d1'],
  ['docs/audits/deep-audit-2026-07-31/audit-01-tenant-rbac.md', 'docs/deep-audit-2026-07-31/audit-01-tenant-rbac.md', '8f732339c8d70de92a44bdae88e6c8545fa4a6fae86ec4074a08345636809612'],
  ['docs/audits/deep-audit-2026-07-31/audit-02-auth-mcp-keys.md', 'docs/deep-audit-2026-07-31/audit-02-auth-mcp-keys.md', '16c23885f983338627a79aeadaf51c62b1b86eb1d341a986f236f6e633e135e5'],
  ['docs/audits/deep-audit-2026-07-31/audit-03-routes-http.md', 'docs/deep-audit-2026-07-31/audit-03-routes-http.md', '56975355973f11e6d718cbd1692745c1c802048c197c396bee799f0eb37b8e13'],
  ['docs/audits/deep-audit-2026-07-31/audit-04-webhooks-git.md', 'docs/deep-audit-2026-07-31/audit-04-webhooks-git.md', '9899a5ba92860893aa7914363057de66ff5bdd2d4c0730904d0236ecc4258c71'],
  ['docs/audits/deep-audit-2026-07-31/audit-05-ticket-integrations.md', 'docs/deep-audit-2026-07-31/audit-05-ticket-integrations.md', 'edcf72afc101945de23d8d167d5fd14aa6a7c6f00b0c1dfbee0d71d36b58c743'],
  ['docs/audits/deep-audit-2026-07-31/audit-06-db-schema.md', 'docs/deep-audit-2026-07-31/audit-06-db-schema.md', 'c8d84d108422804e34c152ea188300cc4e0778e9dcd54934de46b249fe8311ab'],
  ['docs/audits/deep-audit-2026-07-31/audit-07-queues-messaging.md', 'docs/deep-audit-2026-07-31/audit-07-queues-messaging.md', '8ffd6f868ac90b5a8daab624c984322bc0a6bacbefcf9685fba2ad101a30d091'],
  ['docs/audits/deep-audit-2026-07-31/audit-08-gateway-ws.md', 'docs/deep-audit-2026-07-31/audit-08-gateway-ws.md', '68ada5682b89c85a2abeac66ec88e374eef01611aafef3d3c140a48ebf80098b'],
  ['docs/audits/deep-audit-2026-07-31/audit-09-python-ingestion-parsing.md', 'docs/deep-audit-2026-07-31/audit-09-python-ingestion-parsing.md', 'e36710036b42af05ab31d7a56326b87db4577de81147bb819a758c261df97d88'],
  ['docs/audits/deep-audit-2026-07-31/audit-10-ai-enrichment.md', 'docs/deep-audit-2026-07-31/audit-10-ai-enrichment.md', '2d931c463112bea9537500c98b25ac3f5f933350678dd5f1dc76607a96d16410'],
  ['docs/audits/deep-audit-2026-07-31/audit-11-retrieval-telemetry.md', 'docs/deep-audit-2026-07-31/audit-11-retrieval-telemetry.md', '0b01985ed8645c3c9feb55fcae7aace71af3879f2d8ababee9b3eade10a91031'],
  ['docs/audits/deep-audit-2026-07-31/audit-12-web-frontend.md', 'docs/deep-audit-2026-07-31/audit-12-web-frontend.md', '9fe0e4b124afa717943c6c97bc3f305a258b3ca4830f16a56c2c0c5d55121e1d'],
  ['docs/audits/deep-audit-2026-07-31/audit-13-test-coverage.md', 'docs/deep-audit-2026-07-31/audit-13-test-coverage.md', '522b11ac65ca088578ea7f21ca1f850d8f4256ef6ac9c5e2acee40cce65550b4'],
  ['docs/audits/deep-audit-2026-07-31/audit-14-dead-code-hygiene.md', 'docs/deep-audit-2026-07-31/audit-14-dead-code-hygiene.md', 'f2383abbe36a9a4b3c29dcdceedcb3f40c0a876448ebca3ab29b44a14228eb62'],
  ['docs/audits/deep-audit-2026-07-31/audit-15-secrets-deps.md', 'docs/deep-audit-2026-07-31/audit-15-secrets-deps.md', 'd1338290850d8b4ab6b69c6e83bceecc27b270c0587567f304f903acf4f72a96'],
  ['docs/audits/deep-audit-2026-07-31/audit-16-core-correctness.md', 'docs/deep-audit-2026-07-31/audit-16-core-correctness.md', 'd7c78ae26098993e0fe6ebc042ab68659e841ba88451bfcb1d7f93daceb481f0'],
  ['docs/audits/deep-audit-2026-07-31/audit-17-build-verification.md', 'docs/deep-audit-2026-07-31/audit-17-build-verification.md', '17855a0cf737143779914491259132e6557cdae3bf27f38f50a191d6a5383082'],
  ['docs/audits/deep-audit-2026-07-31/audit-18-infra-cicd.md', 'docs/deep-audit-2026-07-31/audit-18-infra-cicd.md', '373e20bbaf9526caf3b0d435947b9c83f79ca28fc9370c64515857d7547aecf9'],
];

/** The emitted set of a pre-change repo-root build (`npm run build` at 17e2299), with Vite's
 *  content-hashed asset filenames normalised — AC-4's "same set as a pre-change build". */
const PRE_CHANGE_DIST_PATHS = [
  '_redirects',
  'assets/index-<hash>.css',
  'assets/index-<hash>.js',
  'favicon.svg',
  'index.html',
  'media/hero-anime-final-mobile.webp',
  'media/hero-anime-final.webp',
  'media/hero-anime-mobile.mp4',
  'media/hero-anime-mobile.webm',
  'media/hero-anime-start-mobile.webp',
  'media/hero-anime-start.webp',
  'media/hero-anime.mp4',
  'media/hero-anime.webm',
  'og.png',
];

/** Root package.json scripts that AC-2 requires carried over VERBATIM (key and value), i.e. every
 *  entry today except the six marketing-site ones (dev/build/preview become delegating aliases;
 *  og/hero:render/test:waitlist move to @sayre/site). */
const ROOT_SCRIPTS_VERBATIM = {
  'check:secret-access': 'node scripts/check-secret-access.mjs',
  'test:secret-access': 'node --test scripts/check-secret-access.test.mjs',
  'check:org-secret-access': 'node scripts/check-org-secret-access.mjs',
  'test:org-secret-access': 'node --test scripts/check-org-secret-access.test.mjs',
  'check:security-audit-agents': 'node scripts/validate-security-audit-agents.mjs',
  'test:security-audit-agents': 'node --test scripts/validate-security-audit-agents.test.mjs',
  'check:security-audit-run': 'node scripts/validate-security-audit-run.mjs',
  'test:security-audit-run': 'node --test scripts/validate-security-audit-run.test.mjs',
  'generate:agent-shims': 'node scripts/generate-agent-shims.mjs',
  'check:agent-shims': 'node scripts/generate-agent-shims.mjs --check',
  'test:agent-shims': 'node --test scripts/generate-agent-shims.test.mjs',
  'generate:agent-ignore': 'node scripts/generate-secret-denylist.mjs',
  'check:agent-ignore': 'node scripts/generate-secret-denylist.mjs --check',
  'test:agent-ignore': 'node --test scripts/generate-secret-denylist.test.mjs',
  'test:sdd-completeness': 'node --test scripts/sdd-completeness.test.mjs',
  'generate:ledger-index': 'node scripts/build-ledger-index.mjs',
  'check:ledger-index': 'node scripts/build-ledger-index.mjs --check',
  'test:ledger-index': 'node --test scripts/build-ledger-index.test.mjs',
  'ledger:append': 'node scripts/ledger-append.mjs',
  'test:ledger-append': 'node --test scripts/ledger-append.test.mjs',
  'check:red-integrity': 'node scripts/check-red-integrity.mjs',
  'test:red-integrity': 'node --test scripts/check-red-integrity.test.mjs',
  'test:product-workspace-ux': 'node scripts/test-product-workspace-ux.mjs',
  'workspace-pack': 'vite-node packages/workspace-packs/src/cli-entry.ts',
  'test:pipeline-contracts': 'node --test scripts/pipeline-contracts.test.mjs',
  stamp: 'node scripts/write-stamp.mjs',
  'test:write-stamp': 'node --test scripts/write-stamp.test.mjs',
  'check:stamp-freshness': 'node scripts/check-stamp-freshness.mjs',
  'test:stamp-freshness': 'node --test scripts/check-stamp-freshness.test.mjs',
  'check:bounds': 'node scripts/check-bounds.mjs',
  'test:bounds': 'node --test scripts/check-bounds.test.mjs',
  'check:lite-eligible': 'node scripts/check-lite-eligible.mjs',
  'test:lite-eligible': 'node --test scripts/check-lite-eligible.test.mjs',
  'test:readonly-guard': 'node --test scripts/guard-checker-readonly.test.mjs',
  'test:dependency-baseline': 'node --test scripts/dependency-baseline.test.mjs',
  'test:dependency-install': 'node --test scripts/dependency-install.test.mjs',
  'typecheck:scripts': 'tsc --noEmit -p scripts/tsconfig.json',
  'dev:workspaces': 'turbo run dev --parallel',
  'build:workspaces': 'turbo run build',
  'lint:workspaces': 'turbo run lint',
  'typecheck:workspaces': 'turbo run typecheck',
  'test:workspaces': 'turbo run test',
};

/** Version specs AC-2 requires carried over verbatim from today's root manifest into @sayre/site. */
const SITE_DEPENDENCIES = {
  'd3-hierarchy': '^3.1.2',
  react: '^18.3.1',
  'react-dom': '^18.3.1',
  'react-router-dom': '^6.30.0',
};
const SITE_DEV_DEPENDENCIES = {
  '@resvg/resvg-js': '^2.6.2',
  '@types/d3-hierarchy': '^3.1.7',
  '@types/react': '^18.3.12',
  '@types/react-dom': '^18.3.1',
  '@vitejs/plugin-react': '^4.3.4',
  'puppeteer-core': '^25.3.0',
  vite: '^5.4.11',
};
const ROOT_DEV_DEPENDENCIES = {
  '@types/node': '20.x',
  'js-yaml': '^4.3.0',
  'puppeteer-core': '^25.3.0',
  turbo: '2.1.x',
  typescript: '~5.6.3',
};

/** The marketing-site family that must leave scripts/ (AC-7), and where each lands. */
const MOVED_SITE_SCRIPTS = [
  ['scripts/og.mjs', 'apps/site/scripts/og.mjs'],
  ['scripts/render-anime-hero.mjs', 'apps/site/scripts/render-anime-hero.mjs'],
  ['scripts/smoke.mjs', 'apps/site/scripts/smoke.mjs'],
  ['scripts/test-waitlist.mjs', 'apps/site/scripts/test-waitlist.mjs'],
  ['scripts/export-tree.mjs', 'apps/site/scripts/export-tree.mjs'],
  ['scripts/anime-hero-render/index.html', 'apps/site/scripts/anime-hero-render/index.html'],
  ['scripts/anime-hero-render/entry.jsx', 'apps/site/scripts/anime-hero-render/entry.jsx'],
];

/** Every scripts/*.test.mjs suite present before this ticket — none may move (AC-7, EC-8). */
const SCRIPTS_TEST_SUITES = [
  'build-ledger-index.test.mjs',
  'check-bounds.test.mjs',
  'check-lite-eligible.test.mjs',
  'check-org-secret-access.test.mjs',
  'check-red-integrity.test.mjs',
  'check-secret-access.test.mjs',
  'check-stamp-freshness.test.mjs',
  'dependency-baseline.test.mjs',
  'dependency-install.test.mjs',
  'generate-agent-shims.test.mjs',
  'generate-secret-denylist.test.mjs',
  'guard-checker-readonly.test.mjs',
  'ledger-append.test.mjs',
  'pipeline-contracts.test.mjs',
  'sdd-completeness.test.mjs',
  'validate-security-audit-agents.test.mjs',
  'validate-security-audit-run.test.mjs',
  'write-stamp.test.mjs',
];

/** The SDD control plane (+ the one product QA script, D8) that stays in scripts/ (AC-7). */
const SCRIPTS_CONTROL_PLANE = [
  'build-ledger-index.mjs',
  'check-bounds.mjs',
  'check-lite-eligible.mjs',
  'check-org-secret-access.mjs',
  'check-red-integrity.mjs',
  'check-secret-access.mjs',
  'check-stamp-freshness.mjs',
  'generate-agent-shims.mjs',
  'generate-secret-denylist.mjs',
  'guard-checker-readonly.mjs',
  'ledger-append.mjs',
  'pipeline-contracts.mjs',
  'test-product-workspace-ux.mjs',
  'validate-security-audit-agents.mjs',
  'validate-security-audit-run.mjs',
  'write-stamp.mjs',
];

/** scripts/tsconfig.json's compilerOptions + include, which AC-7 requires unchanged. */
const SCRIPTS_TSCONFIG_COMPILER_OPTIONS = {
  target: 'ES2022',
  lib: ['ES2022'],
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  allowJs: true,
  checkJs: true,
  noEmit: true,
  skipLibCheck: true,
  resolveJsonModule: true,
  forceConsistentCasingInFileNames: true,
  types: ['node'],
};
const SCRIPTS_TSCONFIG_INCLUDE = [
  'build-ledger-index.mjs',
  'build-ledger-index.test.mjs',
  'check-bounds.mjs',
  'check-bounds.test.mjs',
  'check-lite-eligible.mjs',
  'check-lite-eligible.test.mjs',
  'check-red-integrity.mjs',
  'check-red-integrity.test.mjs',
  'check-stamp-freshness.mjs',
  'check-stamp-freshness.test.mjs',
  'generate-agent-shims.mjs',
  'generate-agent-shims.test.mjs',
  'guard-checker-readonly.mjs',
  'guard-checker-readonly.test.mjs',
  'ledger-append.mjs',
  'ledger-append.test.mjs',
  'pipeline-contracts.mjs',
  'pipeline-contracts.test.mjs',
  'sdd-completeness.test.mjs',
  'validate-security-audit-agents.mjs',
  'validate-security-audit-agents.test.mjs',
  'validate-security-audit-run.mjs',
  'validate-security-audit-run.test.mjs',
  'write-stamp.mjs',
  'write-stamp.test.mjs',
];

/** Files outside the ticket's blast radius whose exact contents must survive it (AC-18, EC-9,
 *  EC-12, EC-13). Digests captured pre-change, same normalisation as MOVED_FILE_DIGESTS. */
const UNTOUCHED_FILE_DIGESTS = {
  'turbo.json': 'd471ec5d7040df7cde7212ea08c51bfaef351addfb3e6a4a558eeae9659b50e2',
  'vercel.json': '690b262b3770fbf22f5cb9b926781ae8c5f8dfd8816123c855af513d88094fdd',
  '.claude/settings.json': 'af271863f8831287734f3c752f350ef7e8cbdde907d0ddcb0196358d80704e71',
  '.sdd/bounds.yml': '26546f63a2c0ba774f40dd99992a3a9c63f60c2f7a22cadd88d40c6f3f42c3b5',
  'scripts/guard-checker-readonly.mjs': '9bf02b14eb85c542ab41b11c58eb25be2c6b60ef90b9802ecef0964fd3c3330b',
  'infra/docker-compose.yml': 'c712c006a4f335fa45c69be9cbca592c19e98a172337c879b3d61dd09dab4c50',
};

/** Historical records that mention the pre-move paths and must NOT be rewritten by the sweep
 *  (EC-12) — a find-and-replace here corrupts a content-hashed ledger entry. */
const HISTORICAL_RECORD_DIGESTS = {
  '.sdd/ledger/20260731T230940936Z-90330fb19231-PR_DELTA-bf73ea/spec.md':
    '0af1c4384a72b5f1b040cf719ba6dd64038cd407fa8ecfad646f94e0ff387a93',
  '.sdd/ledger/20260809T073006612Z-010b2fe50c72-PR_DELTA-7ff0f1/spec.md':
    '7d3fdd50b8db0d7daa4f25d4f4e4ff0da42f7e30bd8204ac5281620ee5919e07',
  '.sdd/ledger/20260809T073006612Z-010b2fe50c72-PR_DELTA-7ff0f1/security/results.json':
    '553c7f5dc3d931113d2372ebc060ac0616016fffa9704b4471d5fc83c6198cb4',
};

// =================================================================================================
// AC-1 — the marketing site's sources live under apps/site/ and nowhere else.
// =================================================================================================

// @spec AC-1
test('[AC-1] the site sources moved: no index.html/src/public/vite.config.ts at the repo root, all four tracked under apps/site/', () => {
  const stray = git(['ls-files', 'index.html', 'src', 'public', 'vite.config.ts']);
  assert.equal(stray.status, 0, `git ls-files failed: ${stray.stderr}`);
  assert.equal(
    stray.stdout.trim(),
    '',
    `these marketing-site paths are still tracked at the repo root:\n${stray.stdout.trim()}`,
  );

  for (const rel of [
    'apps/site/index.html',
    'apps/site/vite.config.ts',
    'apps/site/src/main.tsx',
    'apps/site/src/App.tsx',
    'apps/site/src/config.ts',
    'apps/site/public/_redirects',
    'apps/site/public/og.png',
    'apps/site/public/favicon.svg',
  ]) {
    assert.ok(exists(rel), `${rel} must exist after the move`);
    assert.ok(isTracked(rel), `${rel} must be tracked by git (use \`git mv\`, not delete-and-recreate)`);
  }
  assert.ok(isDir('apps/site/public/media'), 'apps/site/public/media/ must exist');
  assert.equal(walk('apps/site/public/media').length, 8, 'all 8 media files must move with public/');
});

// @spec AC-1 AC-9 EC-17
test('[AC-1][AC-9][EC-17] every moved file is byte-identical to its pre-move contents (binaries moved, never regenerated)', () => {
  const mismatched = [];
  const missing = [];
  for (const [newPath, oldPath, expected] of MOVED_FILE_DIGESTS) {
    if (!exists(newPath)) {
      missing.push(`${oldPath} -> ${newPath}`);
      continue;
    }
    const actual = contentDigest(newPath);
    if (actual !== expected) mismatched.push(`${newPath} (was ${oldPath}): expected ${expected}, got ${actual}`);
  }
  assert.deepEqual(missing, [], `moved file(s) not found at their new path:\n  ${missing.join('\n  ')}`);
  assert.deepEqual(
    mismatched,
    [],
    `moved file(s) changed content — this ticket relocates files, it does not edit or regenerate them:\n  ${mismatched.join('\n  ')}`,
  );
});

// @spec AC-1
test('[AC-1] heroTreeData.ts changes on exactly one line — its Design-System comment repointed at docs/design-system/', () => {
  const rel = 'apps/site/src/landing/heroTreeData.ts';
  assert.ok(exists(rel), `${rel} must exist after the move`);
  const lines = readText(rel).replace(/\r\n/g, '\n').split('\n');
  const comment = lines[1] ?? '';
  assert.match(
    comment,
    /docs\/design-system\/filetree-graph/,
    `${rel} line 2 must point at docs/design-system/filetree-graph*, got: ${comment}`,
  );
  assert.doesNotMatch(comment, /Design System\//, `${rel} line 2 must no longer name the old directory`);
  // The rest of the file is a large hand-copied geometry table; nothing else may drift.
  const restDigest = createHash('sha256')
    .update([...lines.slice(0, 1), ...lines.slice(2)].join('\n'))
    .digest('hex');
  assert.equal(
    restDigest,
    '965377242547cb9a9e95165da3684396a561d70d7d510f5739f8efe43cae0ff1',
    `${rel} changed somewhere other than line 2 — AC-1 allows only the comment repoint here`,
  );
});

// =================================================================================================
// AC-2 / EC-22 / EC-24 — the two manifests.
// =================================================================================================

// @spec AC-2 EC-22
test('[AC-2][EC-22] the root package.json is a workspace root: named sayre, no dependencies, apps/* workspace, every non-site script verbatim, dev/build/preview delegating', () => {
  const root = readJson('package.json');

  assert.equal(root.name, 'sayre', 'the workspace root must no longer be named after the marketing site');
  assert.equal(root.private, true);
  assert.equal(root.dependencies, undefined, 'the workspace root ships no runtime code — it must have no "dependencies" key at all');
  assert.ok(Array.isArray(root.workspaces), 'root package.json must declare a workspaces array');
  assert.ok(root.workspaces.includes('apps/*'), `workspaces must include "apps/*" so @sayre/site is a real workspace (got ${JSON.stringify(root.workspaces)})`);

  const drifted = [];
  for (const [key, value] of Object.entries(ROOT_SCRIPTS_VERBATIM)) {
    if (root.scripts?.[key] !== value) drifted.push(`${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(root.scripts?.[key])}`);
  }
  assert.deepEqual(drifted, [], `root script(s) must be carried over verbatim:\n  ${drifted.join('\n  ')}`);

  // EC-22: `npm run dev` / `build` / `preview` are load-bearing outside this repo (the deploy) and
  // in muscle memory — they keep their names and their observable behaviour, as thin delegations.
  assert.equal(root.scripts.dev, 'npm run dev --workspace @sayre/site');
  assert.equal(root.scripts.build, 'npm run build --workspace @sayre/site');
  assert.equal(root.scripts.preview, 'npm run preview --workspace @sayre/site');

  for (const gone of ['og', 'hero:render', 'test:waitlist']) {
    assert.equal(root.scripts[gone], undefined, `root script "${gone}" moved to @sayre/site and must not remain at the root`);
  }

  assert.deepEqual(
    root.devDependencies,
    ROOT_DEV_DEPENDENCIES,
    'the root devDependencies must be exactly the tooling the root itself still runs (puppeteer-core for test-product-workspace-ux.mjs, js-yaml for generate-agent-shims.mjs)',
  );
});

// @spec AC-2 EC-24
test('[AC-2][EC-24] apps/site/package.json is @sayre/site with every version spec carried over verbatim and the site scripts it owns', () => {
  assert.ok(exists('apps/site/package.json'), 'apps/site/package.json must exist');
  const site = readJson('apps/site/package.json');

  assert.equal(site.name, '@sayre/site');
  assert.equal(site.private, true);
  assert.equal(site.type, 'module');
  assert.match(site.description ?? '', /marketing site/i, 'the site manifest must describe itself as the marketing site');

  assert.deepEqual(site.scripts, {
    dev: 'vite',
    build: 'tsc --noEmit && vite build',
    preview: 'vite preview',
    typecheck: 'tsc --noEmit',
    og: 'node scripts/og.mjs',
    'hero:render': 'node scripts/render-anime-hero.mjs',
    smoke: 'node scripts/smoke.mjs',
    'export-tree': 'node scripts/export-tree.mjs',
    'test:waitlist': 'node scripts/test-waitlist.mjs',
  });

  assert.deepEqual(site.dependencies, SITE_DEPENDENCIES, 'this ticket relocates dependencies, it does not upgrade any');
  assert.deepEqual(site.devDependencies, SITE_DEV_DEPENDENCIES, 'this ticket relocates dependencies, it does not upgrade any');

  // typescript/@types/node stay root devDeps and resolve by hoisting — declaring them here would
  // introduce a second TypeScript version.
  for (const shared of ['typescript', '@types/node']) {
    assert.equal(site.devDependencies[shared], undefined, `${shared} must stay a root devDependency and resolve by hoisting`);
  }

  // EC-24: the engines range is declared deliberately; under Node outside it, npm emits a
  // non-fatal EBADENGINE warning (no engine-strict here). Its presence is the testable half.
  assert.deepEqual(site.engines, { node: '>=20 <21' });
});

// @spec AC-3 EC-1
test('[AC-3][EC-1] package-lock.json was regenerated for the split manifests (the lockfile-stale failure mode that turns every CI job red at once)', () => {
  const lock = readJson('package-lock.json');
  assert.equal(lock.name, 'sayre', 'the lockfile still records the pre-split root package name — it was not regenerated');

  const rootEntry = lock.packages?.[''];
  assert.ok(rootEntry, 'package-lock.json must carry a root ("") package entry');
  assert.equal(rootEntry.name, 'sayre');
  assert.equal(rootEntry.dependencies, undefined, 'the lockfile\'s root entry still lists runtime dependencies — it mirrors the pre-split manifest');
  assert.ok(rootEntry.workspaces?.includes('apps/*'), 'the lockfile\'s root entry must record the apps/* workspace glob');

  assert.ok(lock.packages?.['apps/site'], 'package-lock.json must contain an "apps/site" workspace entry');
  assert.equal(lock.packages['apps/site'].name, '@sayre/site');
  assert.ok(
    lock.packages?.['node_modules/@sayre/site']?.link,
    'package-lock.json must link node_modules/@sayre/site to the workspace',
  );
});

// =================================================================================================
// AC-4 / AC-5 / EC-6 / EC-16 — the deploy contract: repo-root build, repo-root dist/.
// =================================================================================================

// @spec AC-4 EC-6
test('[AC-4][EC-6] apps/site/vite.config.ts carries the deploy-compatibility shim (outDir ../../dist, emptyOutDir true)', () => {
  const rel = 'apps/site/vite.config.ts';
  assert.ok(exists(rel), `${rel} must exist after the move`);
  const cfg = readText(rel);
  assert.match(cfg, /@vitejs\/plugin-react/, 'the react plugin must survive the move');
  assert.match(cfg, /outDir\s*:\s*["'`]\.\.\/\.\.\/dist["'`]/, 'build.outDir must be "../../dist" so the site still emits to repo-root dist/');
  assert.match(cfg, /emptyOutDir\s*:\s*true/, 'emptyOutDir must be explicitly true — Vite refuses to clear an outDir outside its root otherwise (EC-6)');
});

// @spec AC-4 EC-6 EC-16
test('[AC-4][EC-6][EC-16] `npm run build --workspace @sayre/site` emits the same set of paths into repo-root dist/, having emptied stale content first', () => {
  const distDir = abs('dist');
  const sentinel = join(distDir, '__pl15-stale-sentinel.txt');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(sentinel, 'stale content from a previous build (EC-6 fixture)\n');

  let built;
  try {
    built = runNpm(['run', 'build', '--workspace', '@sayre/site']);
  } finally {
    if (existsSync(sentinel)) rmSync(sentinel);
  }

  assert.equal(built.status, 0, `the repo-root site build must succeed:\n${built.output}`);
  assert.ok(!existsSync(sentinel), 'emptyOutDir must have cleared stale content from repo-root dist/ (EC-6)');

  const emitted = walk('dist')
    .map((p) => p.replace(/^assets\/index-[A-Za-z0-9_-]+\.(js|css)$/, 'assets/index-<hash>.$1'))
    .sort();
  assert.deepEqual(emitted, PRE_CHANGE_DIST_PATHS, 'the emitted path set must match a pre-change build exactly');

  // EC-16: _redirects carries both the SPA fallback and the /demo redirect. If it does not reach
  // dist/, /privacy 404s on Cloudflare Pages — a break a zero exit code will not reveal.
  const redirects = readText('dist/_redirects').replace(/\r\n/g, '\n');
  assert.match(redirects, /^\/demo \/ 302$/m, 'dist/_redirects must keep the /demo redirect');
  assert.match(redirects, /^\/\* \/index\.html 200$/m, 'dist/_redirects must keep the SPA fallback that makes /privacy resolve');
});

// @spec AC-5
test('[AC-5] the root tsconfig include is retargeted at apps/site/src and `tsc --noEmit` at the repo root still exits 0 over that non-empty set', () => {
  const rootTsconfig = readJsonc('tsconfig.json');
  assert.deepEqual(rootTsconfig.include, ['apps/site/src'], 'the root tsconfig must type-check exactly the file set it checked before the move');

  const siteTsconfig = readJsonc('apps/site/tsconfig.json');
  assert.equal(siteTsconfig.extends, '../../tsconfig.json');
  assert.deepEqual(siteTsconfig.include, ['src']);

  const tscBin = createRequire(join(repoRoot, 'package.json')).resolve('typescript/bin/tsc');
  const r = spawnSync(process.execPath, [tscBin, '--noEmit'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(r.status, 0, `npx tsc --noEmit at the repo root must exit 0:\n${r.stdout}\n${r.stderr}`);
});

// @spec AC-6
test('[AC-6] CI builds the marketing site: a `site — build` step running the workspace build, after the root install', () => {
  const ci = readText('.github/workflows/ci.yml');
  const installAt = ci.indexOf('Install dependencies (root, single pass)');
  const stepAt = ci.indexOf('site — build');
  assert.ok(installAt !== -1, 'the root install step must still exist in ci.yml');
  assert.ok(stepAt !== -1, 'ci.yml must add a `site — build` step — the marketing site has never been built in CI');
  assert.ok(stepAt > installAt, 'the `site — build` step must come after the root install step');
  assert.ok(
    ci.includes('npm run build --workspace @sayre/site'),
    'the CI step must run `npm run build --workspace @sayre/site` (the site\'s real tsc + vite build, not a turbo filter)',
  );
});

// =================================================================================================
// AC-7 / EC-8 / EC-9 — scripts/ de-mixed, control plane untouched.
// =================================================================================================

// @spec AC-7
test('[AC-7] scripts/ holds no marketing-site script, and every SDD control-plane script and test suite is still there', () => {
  for (const [oldPath, newPath] of MOVED_SITE_SCRIPTS) {
    assert.ok(!exists(oldPath), `${oldPath} must have moved out of scripts/`);
    assert.ok(exists(newPath), `${oldPath} must exist at ${newPath}`);
  }
  assert.ok(!exists('scripts/anime-hero-render'), 'scripts/anime-hero-render/ must be gone from scripts/');

  for (const name of [...SCRIPTS_TEST_SUITES, ...SCRIPTS_CONTROL_PLANE]) {
    assert.ok(exists(`scripts/${name}`), `scripts/${name} must stay in scripts/ (deferred item D1: splitting scripts/ further is out of scope)`);
  }

  const tsconfig = readJsonc('scripts/tsconfig.json');
  assert.deepEqual(tsconfig.compilerOptions, SCRIPTS_TSCONFIG_COMPILER_OPTIONS, 'scripts/tsconfig.json compilerOptions must be unchanged');
  assert.deepEqual(tsconfig.include, SCRIPTS_TSCONFIG_INCLUDE, 'scripts/tsconfig.json include must be unchanged — only its rationale comment is corrected');
});

// @spec EC-8
// Preservation guard: passes today by construction. Moving any scripts/*.test.mjs into a
// subdirectory would break sdd-completeness.test.mjs's non-recursive readdirSync enumeration and
// its `scripts/([\w.-]+\.test\.mjs)` package.json-value regex, whose character class cannot cross a
// `/`. The de-mix must therefore leave every suite directly in scripts/, and must not deposit a new
// .test.mjs into any scripts/ subdirectory or into apps/site/scripts/.
test('[EC-8] every test suite is still enumerable by a non-recursive readdirSync of scripts/, and no .test.mjs hides in a subdirectory', () => {
  const enumerated = readdirSync(abs('scripts')).filter((n) => n.endsWith('.test.mjs')).sort();
  for (const name of SCRIPTS_TEST_SUITES) {
    assert.ok(enumerated.includes(name), `${name} is no longer enumerable by readdirSync('scripts') — sdd-completeness.test.mjs would silently stop checking it`);
  }

  const buried = [];
  for (const entry of readdirSync(abs('scripts'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const nested of walk(`scripts/${entry.name}`)) {
      if (nested.endsWith('.test.mjs')) buried.push(`scripts/${entry.name}/${nested}`);
    }
  }
  assert.deepEqual(buried, [], `test suite(s) buried in a scripts/ subdirectory, invisible to the non-recursive enumeration:\n  ${buried.join('\n  ')}`);

  if (isDir('apps/site/scripts')) {
    const siteSuites = walk('apps/site/scripts').filter((p) => p.endsWith('.test.mjs'));
    assert.deepEqual(siteSuites, [], 'the moved marketing scripts must not carry .test.mjs siblings into apps/site/scripts/');
  }
});

// @spec EC-9
// Preservation guard: passes today. The read-only guard for review/security-checker/pr-review is
// wired as the cwd-relative command `node scripts/guard-checker-readonly.mjs`; if that script ever
// moved, the hook would fail to load (exit 1) and silently stop enforcing, because only exit 2
// blocks a tool call.
test('[EC-9] the read-only guard script stays at scripts/guard-checker-readonly.mjs and .claude/settings.json still points at it', () => {
  assert.ok(exists('scripts/guard-checker-readonly.mjs'), 'the read-only guard script must not move');
  const settings = readJson('.claude/settings.json');
  const commands = (settings.hooks?.PreToolUse ?? []).flatMap((entry) => (entry.hooks ?? []).map((h) => h.command));
  assert.ok(
    commands.includes('node scripts/guard-checker-readonly.mjs'),
    `the PreToolUse hook command must stay exactly "node scripts/guard-checker-readonly.mjs" (got ${JSON.stringify(commands)})`,
  );
});

// =================================================================================================
// AC-8 / EC-4 / EC-5 / EC-18 — the loose top-level directories.
// =================================================================================================

// @spec AC-8 EC-4
test('[AC-8][EC-4] the loose top-level directories are placed, and no repo-root directory name contains a space', () => {
  for (const gone of ['Design System', 'Documents', 'design']) {
    assert.ok(!exists(gone), `${gone}/ must no longer exist at the repo root`);
  }

  const spaced = readdirSync(repoRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.includes(' '))
    .map((e) => e.name);
  assert.deepEqual(spaced, [], `repo-root directory name(s) containing a space: ${spaced.join(', ')}`);

  // EC-4: `git mv "Design System" …` must be quoted; an unquoted invocation moves the wrong thing.
  // All six files landing intact, including the one whose basename still contains a space (D7),
  // is what proves the quoting held.
  assert.deepEqual(walk('docs/design-system'), [
    'SAYRE_DESIGN_SYSTEM.md',
    'Sayre Directions-selection.png',
    'filetree-graph-blank.png',
    'filetree-graph-labeled.png',
    'filetree-graph.png',
    'filetree-graph.svg',
  ]);

  assert.deepEqual(walk('docs/product'), [
    'Audit-Rebuild-Cheat-Sheet.md',
    'PRD-V1.pdf',
    'SAYRE_FRONTEND_SPEC.md',
    'Ticket-Backlog-by-Feature-2.md',
  ]);

  // The exported SVG is a generated artifact whose first line records its generator. AC-12 requires
  // that reference repointed; nothing else in the 147-line file may drift (it is a design asset, and
  // a hand-edited path in its geometry would be an unreviewable diff — the EC-17 hazard).
  const svgLines = readText('docs/design-system/filetree-graph.svg').replace(/\r\n/g, '\n').split('\n');
  assert.doesNotMatch(
    svgLines[0] ?? '',
    /(?<!apps\/site\/)scripts\/export-tree\.mjs/,
    'filetree-graph.svg\'s provenance comment must name the generator\'s new path',
  );
  assert.equal(
    createHash('sha256').update(svgLines.slice(1).join('\n')).digest('hex'),
    '5c858d9387a2180dac0bdb6690c618ac1c9d94409b3f221884fe338bf460bca2',
    'filetree-graph.svg changed below its provenance comment — the exported geometry must move untouched',
  );

  assert.ok(isDir('apps/site/design/handoffs/anime-hero-animation'), 'the design handoff must land under apps/site/design/ (entry.jsx\'s ../../design/… imports depend on it)');
  assert.equal(walk('apps/site/design').length, 16, 'all 16 files of the former design/ tree must move');
});

// @spec EC-5
test('[EC-5] the Documents/ -> docs/product/ move lost nothing to the case-insensitive filesystem', () => {
  const tracked = trackedFiles();
  const leftovers = tracked.filter((p) => p.startsWith('Documents/'));
  assert.deepEqual(leftovers, [], `paths still tracked under Documents/: ${leftovers.join(', ')}`);

  assert.equal(tracked.filter((p) => p === 'docs/product/SAYRE_FRONTEND_SPEC.md').length, 1);
  assert.equal(tracked.filter((p) => p === 'docs/product/PRD-V1.pdf').length, 1);

  // A silent case-merge shows up as two tracked paths that differ only in case.
  const byLower = new Map();
  const collisions = [];
  for (const p of tracked) {
    const key = p.toLowerCase();
    if (byLower.has(key) && byLower.get(key) !== p) collisions.push(`${byLower.get(key)} vs ${p}`);
    else byLower.set(key, p);
  }
  assert.deepEqual(collisions, [], `tracked paths differing only in case (a case-insensitive-filesystem hazard): ${collisions.join(', ')}`);
});

// @spec EC-18
test('[EC-18] no emptied directory is left behind on disk (git does not track them, so only a file listing shows them)', () => {
  const leftovers = [
    'src',
    'public',
    'Design System',
    'Documents',
    'Documents/PRD',
    'Documents/Spec',
    'design',
    'scripts/anime-hero-render',
  ].filter((rel) => exists(rel));
  assert.deepEqual(leftovers, [], `emptied directories still on disk — the exact complaint this ticket exists to answer: ${leftovers.join(', ')}`);
});

// =================================================================================================
// AC-9 / EC-20 — the orphaned audit artifacts become tracked history.
// =================================================================================================

// @spec AC-9
test('[AC-9] the audit artifacts are committed under docs/audits/ and gone from their former docs/ locations', () => {
  const tracked = new Set(trackedFiles());

  assert.ok(
    tracked.has('docs/audits/architecture-assessment-2026-07.md'),
    'docs/audits/architecture-assessment-2026-07.md must be tracked — these artifacts are untracked on disk today, so the move must be followed by `git add docs/audits/`',
  );
  assert.ok(
    tracked.has('docs/audits/deep-audit-2026-07-31.md'),
    'docs/audits/deep-audit-2026-07-31.md must be tracked (moved on disk, then `git add`)',
  );

  const bundle = [...tracked].filter((p) => p.startsWith('docs/audits/deep-audit-2026-07-31/'));
  assert.equal(bundle.length, 18, `docs/audits/deep-audit-2026-07-31/ must hold all 18 audit files (got ${bundle.length})`);

  for (const former of ['docs/architecture-assessment-2026-07.md', 'docs/deep-audit-2026-07-31.md', 'docs/deep-audit-2026-07-31']) {
    assert.ok(!exists(former), `${former} must not remain at its former docs/ location`);
    assert.ok(!tracked.has(former), `${former} must not be tracked at its former location`);
  }
});

// @spec EC-20
// CORRECTED (dev, PL-15): EC-20's spec text assumed docs/deep-audit-2026-07-31.md contains markdown
// hyperlinks into its own bundle ("the index's links ... should survive"). Verified against the
// actual pre-move file content, which AC-9 pins byte-identical (so this file cannot be edited to
// manufacture a link that would make the original assertion pass): the file contains zero markdown
// link syntax anywhere in its 580 lines, nor does any of the 18 bundle files link to another. The
// bundle is described only in prose ("Per-agent reports with full evidence are in the session
// scratchpad as `audit-NN-*.md`") — there was never a hyperlink for a move to break. This guard now
// asserts the real invariant instead of a false premise about the file's structure: IF this file
// ever carries a markdown link into its own bundle, that link must resolve after the move; today
// that set is empty, which is a pass, not a vacuous test — a stray future edit that adds a broken
// link would still be caught. Declared as a red-test change in .pipeline/changes.json.
test('[EC-20] the audit index carries no broken intra-audit link after both it and its bundle move', () => {
  const rel = 'docs/audits/deep-audit-2026-07-31.md';
  assert.ok(exists(rel), `${rel} must exist`);
  const md = readText(rel);
  const targets = [...md.matchAll(/\]\(([^)\s]+\.md)(?:#[^)]*)?\)/g)].map((m) => m[1]);
  const intra = targets.filter((t) => t.includes('deep-audit-2026-07-31/'));

  const broken = intra.filter((t) => {
    const cleaned = t.replace(/^\.\//, '').replace(/^docs\//, '');
    return !exists(`docs/${cleaned}`) && !exists(`docs/audits/${cleaned.replace(/^audits\//, '')}`);
  });
  assert.deepEqual(broken, [], `broken intra-audit link(s) after the move: ${broken.join(', ')}`);
});

// =================================================================================================
// AC-10 / EC-21 — hygiene and .gitignore.
// =================================================================================================

// @spec AC-10
test('[AC-10] debug.log is gone and .gitignore generalises the scratch-directory rules without losing the ones that matter', () => {
  assert.ok(!exists('debug.log'), 'debug.log must be deleted from the repo root');

  const gitignore = readText('.gitignore');
  for (const pattern of ['**/.fontcache/', '**/.shots/', '**/.tmp/', '.playwright-mcp/', '.pipeline-backup-*/']) {
    assert.ok(gitignore.includes(pattern), `.gitignore must contain ${pattern}`);
  }
  for (const stale of ['scripts/.fontcache/', 'scripts/.shots/']) {
    assert.ok(!gitignore.includes(stale), `.gitignore must no longer pin ${stale} to scripts/ — the scratch dirs moved with the scripts`);
  }
  for (const kept of ['dist/', '.pipeline/**', '!.pipeline/README.md', '.codex/']) {
    assert.ok(gitignore.includes(kept), `.gitignore must still contain ${kept}`);
  }

  const ledgerIgnored = git(['check-ignore', '-q', '.sdd/ledger/index.json']);
  assert.equal(ledgerIgnored.status, 1, 'the ledger must stay trackable — no broadened pattern may swallow .sdd/ledger/');
});

// @spec EC-21
// Preservation guard: passes today (no tracked path currently matches an ignore rule). The point is
// that broadening to **/.fontcache/, **/.shots/, **/.tmp/ must not start matching one.
test('[EC-21] no tracked file is matched by an ignore rule after the .gitignore broadening', () => {
  const r = spawnSync('git', ['check-ignore', '--stdin', '-z'], {
    cwd: repoRoot,
    input: trackedFiles().join('\0'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const nowIgnored = (r.stdout ?? '').split('\0').filter(Boolean);
  assert.deepEqual(nowIgnored, [], `tracked file(s) newly matched by a .gitignore rule:\n  ${nowIgnored.join('\n  ')}`);
});

// =================================================================================================
// AC-11 / EC-7 — the moved scripts still resolve where they mean to.
// =================================================================================================

// @spec AC-11
test('[AC-11] export-tree.mjs writes its four outputs into repo-root docs/design-system/, and entry.jsx is untouched', () => {
  const rel = 'apps/site/scripts/export-tree.mjs';
  assert.ok(exists(rel), `${rel} must exist after the move`);
  const src = readText(rel);

  assert.match(src, /path\.resolve\(\s*root\s*,\s*["']\.\.["']\s*,\s*["']\.\.["']\s*\)/, 'export-tree.mjs must derive the repo root two levels up from apps/site');
  assert.match(src, /["']docs["']\s*,\s*["']design-system["']|docs\/design-system/, 'its output directory must be the repo root\'s docs/design-system/');
  for (const out of ['filetree-graph.png', 'filetree-graph-labeled.png', 'filetree-graph-blank.png', 'filetree-graph.svg']) {
    assert.ok(src.includes(out), `export-tree.mjs must still emit ${out}`);
  }
  assert.doesNotMatch(src, /Design System/, 'export-tree.mjs must no longer name the old Design System/ directory');

  assert.equal(
    contentDigest('apps/site/scripts/anime-hero-render/entry.jsx'),
    '7ff99914630fa97bf1c43f4367b1042a309c24faf07ee954fb6a782bb34975a2',
    'entry.jsx must be unmodified — moving design/ to apps/site/design/ is what keeps its ../../design/… imports resolving',
  );
});

// @spec EC-7
test('[EC-7] every path a moved script resolves relative to its own location exists at the new location', () => {
  // Each of these scripts computes its "root" as `resolve(dirname(import.meta.url), "..")`, which
  // becomes apps/site after the move. Verified by checking the resolved targets exist, not by
  // assuming — the failure mode is a path silently resolving somewhere else that also exists.
  for (const target of [
    'apps/site/public/media',            // og.mjs / render-anime-hero.mjs output
    'apps/site/public/og.png',           // og.mjs output
    'apps/site/src/config.ts',           // test-waitlist.mjs imports ../src/config.ts
    'apps/site/scripts/anime-hero-render/index.html', // render-anime-hero.mjs's RENDER_PATH
    'apps/site/index.html',              // smoke.mjs / the dev server root
  ]) {
    assert.ok(exists(target), `${target} must exist — a moved script resolves to it relative to apps/site`);
  }

  // The scratch directories those scripts write now live under apps/site, which is why the
  // .gitignore rules had to be generalised away from scripts/ (AC-10).
  assert.ok(!exists('scripts/.fontcache'), 'the font cache belongs to the moved script, not to the control plane');
  assert.ok(!exists('scripts/.shots'), 'the screenshot scratch dir belongs to the moved script, not to the control plane');
});

// =================================================================================================
// AC-12 / EC-12 — the reference sweep, and the historical records it must not touch.
// =================================================================================================

/** AC-12's patterns. Each is anchored so a *corrected* reference (apps/site/scripts/og.mjs) is not
 *  itself reported as a stale one. */
const SWEEP_PATTERNS = [
  /Design System\//,
  /Documents\//,
  /(?<!apps\/site\/)design\/handoffs\//,
  /(?<!apps\/site\/)scripts\/og\.mjs/,
  /(?<!apps\/site\/)scripts\/smoke\.mjs/,
  /(?<!apps\/site\/)scripts\/export-tree\.mjs/,
  /(?<!apps\/site\/)scripts\/test-waitlist\.mjs/,
  /(?<!apps\/site\/)scripts\/render-anime-hero\.mjs/,
  /(?<!apps\/site\/)scripts\/anime-hero-render\//,
  /sayre-site/,
];

/** Exclusions, each one spec-derived rather than invented:
 *  - .sdd/ledger/** and any .pipeline* path — AC-12 names both (they are immutable history, EC-12).
 *  - the two PL-15 red-suite files — they hold the sweep's own pattern list and the pre-move digest
 *    table, so the old paths necessarily appear in them as data.
 *  - three moved scripts AC-1/AC-11 require byte-identical: their own relative self-references
 *    ("/scripts/anime-hero-render/index.html", "node scripts/smoke.mjs", "../../design/handoffs/…")
 *    are correct after the move and may not be edited.
 *  - apps/site/package.json (CORRECTED, dev, PL-15): the same self-reference category as the three
 *    files above, just not caught by the negative lookbehind, because a package.json script VALUE
 *    ("node scripts/og.mjs") is written relative to the package's own directory — npm always runs a
 *    workspace member's scripts with cwd set to that member — so it never repeats an "apps/site/"
 *    prefix the way a file path or a from-repo-root comment would. AC-2's Interfaces shape (which
 *    this file matches verbatim) requires exactly these five script values; excluding this one file
 *    from the sweep is the same reasoning already applied to the three above, extended to a fourth
 *    file this list originally missed. */
const SWEEP_EXCLUDED = new Set([
  'scripts/repo-structure.test.mjs',
  'scripts/repo-structure-verify.mjs',
  'apps/site/scripts/anime-hero-render/entry.jsx',
  'apps/site/scripts/render-anime-hero.mjs',
  'apps/site/scripts/smoke.mjs',
  'apps/site/package.json',
]);

/** docs/audits/** is excluded for the same reason .sdd/ledger/** is, and the exclusion is forced by
 *  AC-9 rather than chosen: those files are dated point-in-time audit records (2026-07, 2026-07-31)
 *  that describe the tree as it was, they reference the old paths dozens of times, and AC-9 requires
 *  their committed contents to be byte-identical to the untracked originals. Sweeping them would
 *  make AC-9 and AC-12 unsatisfiable together; AC-9 is the more specific requirement, so it wins.
 *  Flagged as a spec tension in .pipeline/red.md. */
const SWEEP_EXCLUDED_PREFIXES = ['docs/audits/'];

// @spec AC-12
test('[AC-12] the reference sweep is clean: no tracked, non-historical file still points at a pre-move path', () => {
  const hits = [];
  for (const rel of trackedFiles()) {
    if (rel.startsWith('.sdd/ledger/') || rel.startsWith('.pipeline')) continue;
    if (SWEEP_EXCLUDED.has(rel)) continue;
    if (SWEEP_EXCLUDED_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue;
    if (BINARY_EXTENSION.test(rel)) continue;

    let text;
    try {
      text = readText(rel);
    } catch {
      continue; // deleted-but-still-indexed during a partial move; the AC-1/AC-7 tests cover that
    }
    const lines = text.split(/\r?\n/);
    for (const pattern of SWEEP_PATTERNS) {
      lines.forEach((line, i) => {
        if (pattern.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
    }
  }
  assert.deepEqual(
    hits,
    [],
    'stale pre-move reference(s) in tracked files.\n' +
      'A doc that *explains* the restructure still counts as a hit under AC-12 as written — phrase the\n' +
      'explanation without the literal old token rather than adding an exclusion here.\n  ' +
      hits.join('\n  '),
  );
});

// @spec EC-12
// Preservation guard: passes today. A "helpful" find-and-replace across .sdd/ledger/** would corrupt
// content-hashed ledger entries and fail test:sdd-completeness's pinned-hash assertions.
test('[EC-12] the historical records that mention the old paths are byte-unchanged by the sweep', () => {
  const rewritten = [];
  for (const [rel, expected] of Object.entries(HISTORICAL_RECORD_DIGESTS)) {
    if (!exists(rel)) {
      rewritten.push(`${rel} (missing)`);
      continue;
    }
    const actual = contentDigest(rel);
    if (actual !== expected) rewritten.push(`${rel}: expected ${expected}, got ${actual}`);
  }
  assert.deepEqual(rewritten, [], `historical record(s) rewritten by the reference sweep:\n  ${rewritten.join('\n  ')}`);
});

// =================================================================================================
// AC-13 / EC-19 — documentation that matches reality.
// =================================================================================================

// @spec AC-13
test('[AC-13] the root README.md is the monorepo README, not the marketing site\'s', () => {
  const readme = readText('README.md');

  for (const entry of [
    'apps/site',
    'apps/web',
    'services/core',
    'services/gateway',
    'services/workers',
    'packages/',
    'infra/',
    'docs/',
    'scripts/',
    '.sdd/',
    'security-attacker-agents/',
  ]) {
    assert.ok(readme.includes(entry), `the root README's repo-layout table must have a line for ${entry}`);
  }

  for (const command of ['npm run dev', 'npm run dev:workspaces', 'npm run build', 'npm run test:workspaces']) {
    assert.ok(readme.includes(command), `the root README's "Run it" section must name ${command}`);
  }

  for (const pointer of ['docs/repo-structure.md', 'CLAUDE.md', 'AGENTS.md']) {
    assert.ok(readme.includes(pointer), `the root README must point at ${pointer}`);
  }

  // It must not retain marketing-site specifics. Only the unambiguous markers are asserted — a
  // monorepo README may legitimately mention Cloudflare Pages once when describing apps/site.
  for (const marketing of ['WAITLIST_ENDPOINT', 'GOOGLE_FORM_ENTRIES', 'Google Form', 'PLAUSIBLE_DOMAIN', 'npm run og']) {
    assert.ok(!readme.includes(marketing), `the root README must not retain the marketing-site specific "${marketing}" — that content belongs in apps/site/README.md`);
  }
});

// @spec AC-13
test('[AC-13] apps/site/README.md carries the site content with every pointer repointed', () => {
  const rel = 'apps/site/README.md';
  assert.ok(exists(rel), `${rel} must exist`);
  const readme = readText(rel);

  // Carried over from today's root README.
  assert.ok(readme.includes('WAITLIST_ENDPOINT'), 'the site README must keep the config table');
  assert.ok(readme.includes('Google Form'), 'the site README must keep the waitlist tradeoff section');

  // Repointed.
  assert.ok(readme.includes('docs/product/SAYRE_FRONTEND_SPEC.md'), 'the Spec pointer must be repointed');
  assert.ok(readme.includes('docs/design-system/SAYRE_DESIGN_SYSTEM.md'), 'the Design system pointer must be repointed');
  assert.ok(readme.includes('apps/site/design/handoffs/anime-hero-animation/'), 'the Anime handoff archive pointer must be repointed');
  assert.ok(readme.includes('apps/site/src/config.ts'), 'the config heading must name the new path');
  assert.ok(
    readme.includes('--workspace @sayre/site') || /from\s+`apps\/site\/?`/.test(readme),
    'the npm examples must either be workspace-qualified or carry a "run these from apps/site/" note',
  );

  // The Deploy section must state the shim, not the pre-move story.
  assert.ok(readme.includes('docs/repo-structure.md'), 'the Deploy section must point at docs/repo-structure.md (D2)');
  assert.match(readme, /repo root/i, 'the Deploy section must say Cloudflare Pages builds from the repo root into repo-root dist/');
});

// @spec AC-13
test('[AC-13] docs/repo-structure.md documents the layout, the shims, and all ten deferred items', () => {
  const rel = 'docs/repo-structure.md';
  assert.ok(exists(rel), `${rel} must exist`);
  const doc = readText(rel);

  assert.ok(doc.includes('apps/site'), 'the directory map must name apps/site');
  assert.ok(doc.includes('dist'), 'the shim section must name the repo-root dist/ output');
  assert.match(doc, /Cloudflare/i, 'the shim section must explain the Cloudflare Pages contract it preserves');

  const missing = [];
  for (let i = 1; i <= 10; i += 1) {
    const marker = new RegExp(`\\bD${i}\\b`);
    if (!marker.test(doc)) missing.push(`D${i}`);
  }
  assert.deepEqual(missing, [], `docs/repo-structure.md must record every deferred item with its reason; missing: ${missing.join(', ')}`);
});

// @spec AC-13
test('[AC-13] AGENTS.md, CLAUDE.md and DEPENDENCIES.md stop describing the repo root as a marketing site', () => {
  const agents = readText('AGENTS.md');
  assert.ok(
    !agents.includes('Both of these are true at once'),
    'AGENTS.md\'s "Repo shape" section must drop the "the root is a Vite marketing site AND a monorepo" framing — it is now false',
  );
  assert.ok(agents.includes('apps/site'), 'AGENTS.md\'s "Repo shape" section must name apps/site as the marketing site\'s home');
  assert.ok(
    !/`test:waitlist`/.test(agents),
    'AGENTS.md still lists test:waitlist among the root scripts; it is now a @sayre/site script',
  );

  const claude = readText('CLAUDE.md');
  assert.ok(claude.includes('apps/site/'), 'CLAUDE.md\'s Structure section must list apps/site/');
  assert.ok(claude.includes('dev:workspaces'), 'CLAUDE.md\'s Commands section must distinguish `npm run dev` (marketing site) from `npm run dev:workspaces` (platform)');

  const deps = readText('DEPENDENCIES.md');
  assert.ok(deps.includes('**PL-15:**'), 'DEPENDENCIES.md must carry a **PL-15:** amendment note recording the manifest split');
  assert.ok(deps.includes('apps/site'), 'DEPENDENCIES.md must name apps/site as the marketing site\'s manifest home');
});

// @spec EC-19
test('[EC-19] apps/web\'s description no longer claims the repo root is a Vite marketing site', () => {
  const web = readJson('apps/web/package.json');
  assert.ok(!/root Vite marketing site/i.test(web.description ?? ''), 'apps/web\'s description became false the moment the site moved');
  assert.match(web.description ?? '', /Next\.js/i, 'apps/web must still describe itself as the Next.js product client');
});

// =================================================================================================
// AC-18 / EC-11 / EC-13 / EC-14 / EC-15 — everything the ticket promised not to disturb.
// =================================================================================================

// @spec AC-18 EC-13
// Preservation guard: passes today. `review` judges the full diff scope; this pins the specific
// files a restructure is most likely to touch "while it's in there", including .sdd/bounds.yml,
// whose frontend lane deliberately does NOT gain apps/site/** (D9 — root src/** is in no fenced
// lane today either, so leaving it alone preserves the fence rather than widening it).
test('[AC-18][EC-13] the out-of-scope surfaces are byte-unchanged, and no fenced lane silently widens to apps/site', () => {
  const changed = [];
  for (const [rel, expected] of Object.entries(UNTOUCHED_FILE_DIGESTS)) {
    if (!exists(rel)) {
      changed.push(`${rel} (missing)`);
      continue;
    }
    const actual = contentDigest(rel);
    if (actual !== expected) changed.push(`${rel}: expected ${expected}, got ${actual}`);
  }
  assert.deepEqual(changed, [], `out-of-scope file(s) modified by this ticket:\n  ${changed.join('\n  ')}`);

  const bounds = readText('.sdd/bounds.yml');
  assert.ok(!bounds.includes('apps/site'), 'apps/site/** must stay in no fenced lane (D9), exactly as root src/** is today');
});

// @spec AC-18
test('[AC-18] apps/web/package.json changes in its description string and nowhere else', () => {
  const web = readJson('apps/web/package.json');
  delete web.description;
  assert.equal(
    createHash('sha256').update(JSON.stringify(web, null, 2)).digest('hex'),
    '7892df97ed0695176517db9ef162448b373f5fdd4469c91671de88c619fa0bf3',
    'apps/web/package.json changed somewhere other than its description string',
  );
});

// @spec EC-11
// Preservation guard on the gate's verdict, plus the reason it holds: every moved file stays in
// scope (none lands under an excluded path segment), and the gate's ALLOWLIST names no moved path.
test('[EC-11] the secret-access boundary gate — CI\'s first step, run before npm ci — still passes with the moved files in scope', () => {
  const r = spawnSync(process.execPath, [abs('scripts/check-secret-access.mjs')], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `check:secret-access must still exit 0:\n${r.stdout}\n${r.stderr}`);

  const EXCLUDED_SEGMENT = /(?:^|\/)(?:node_modules|\.venv|venv|__pycache__|dist|build|coverage|generated|vendor)(?:\/|$)/i;
  const scanned = trackedFiles().filter((p) => /\.(?:ts|tsx|js|jsx|mjs|cjs|py)$/i.test(p) && p.startsWith('apps/site/'));
  assert.ok(scanned.length > 0, 'the moved site sources must be tracked and scannable by the gate');
  const escaped = scanned.filter((p) => EXCLUDED_SEGMENT.test(p));
  assert.deepEqual(escaped, [], `moved file(s) landed under a path segment the gate excludes, silently leaving its scope: ${escaped.join(', ')}`);
});

// @spec EC-14
test('[EC-14] apps/site/turbo.json opts the site build out of turbo\'s cache, because it writes outside its own package', () => {
  const rel = 'apps/site/turbo.json';
  assert.ok(exists(rel), `${rel} must exist`);
  const cfg = readJson(rel);
  assert.deepEqual(cfg.extends, ['//'], 'the site turbo config must extend the root one');
  assert.deepEqual(cfg.tasks?.build?.outputs, [], 'build must declare no outputs — the emitted dist/ is outside this package');
  assert.equal(cfg.tasks?.build?.cache, false, 'build must not be cached, or turbo reports a cache hit for a build that produced nothing it tracked');
});

// @spec EC-15
// Preservation guard: passes today because vite is a root devDependency. After the split it must
// still hold, resolved transitively through vitest — `npm run workspace-pack` has no declared
// vite-node dependency anywhere and relies entirely on hoisting.
test('[EC-15] vite-node still resolves from the repo root after vite leaves the root devDependencies', () => {
  const req = createRequire(join(repoRoot, 'package.json'));
  for (const spec of ['vite-node/package.json', 'vite/package.json']) {
    assert.doesNotThrow(
      () => req.resolve(spec),
      `${spec} must still resolve from the repo root — npm run workspace-pack depends on it by hoisting alone`,
    );
  }
});
