#!/usr/bin/env node
// UX red-team driver for apps/web. Drives a real Chrome (headless by default)
// against the dev server and reports everything a red-teamer wants: screenshots,
// console noise, page errors, failed requests, the a11y tree, and tab order.
//
// Usage (run from repo root or apps/web — cwd does not matter):
//   node apps/web/.claude/skills/redteam-ux/driver.mjs ss /mock
//   node apps/web/.claude/skills/redteam-ux/driver.mjs flow steps.json
//   echo '[{"goto":"/mock"},{"ss":"home"}]' | node .../driver.mjs flow -
//
// Flow steps (executed in order, one browser session):
//   {"goto": "/mock"}                     navigate (path or full URL)
//   {"resize": [390, 844]}                set viewport (mobile: 390x844)
//   {"dark": true}                        emulate prefers-color-scheme: dark
//   {"click": "button.foo"}               click first match (CSS selector)
//   {"clickText": "Mock controls"}        click first element whose visible text matches
//   {"type": "input[name=q]", "text": "hello"}
//   {"press": "Tab", "times": 5}          keyboard
//   {"hover": ".node"}
//   {"waitFor": ".drawer"}                wait for selector (10s timeout)
//   {"wait": 500}                         sleep ms
//   {"eval": "document.title"}            run JS in page, result logged
//   {"ss": "after-click"}                 screenshot -> shots/<name>.png
//   {"a11y": true}                        dump accessibility tree snapshot
//   {"taborder": 25}                      press Tab N times, log focus path
//   {"text": ".banner"}                   log innerText of first match
//
// Options: --base http://localhost:3100 (default), --headed, --keep-open <ms>
// Config: PUPPETEER_EXECUTABLE_PATH (via @sayre/config) overrides browser binary discovery.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { ConfigError, getOptionalConfig } from '@sayre/config';

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const SHOTS_DIR = join(SKILL_DIR, 'shots');

// Same shape as scripts/render-anime-hero.mjs's optionalConfig(): an unset or
// empty override is "no override", never a crash in a diagnostics driver.
function optionalConfig(name) {
  try {
    return getOptionalConfig(name);
  } catch (error) {
    if (error instanceof ConfigError) return undefined;
    throw error;
  }
}

function findChrome() {
  const override = optionalConfig('PUPPETEER_EXECUTABLE_PATH');
  if (override && existsSync(override)) {
    return override;
  }
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(homedir(), 'AppData', 'Local', 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) {
    console.error('No Chrome/Edge binary found. Set PUPPETEER_EXECUTABLE_PATH (see @sayre/config).');
    process.exit(1);
  }
  return found;
}

function parseArgs(argv) {
  const args = { _: [], base: 'http://localhost:3100', headed: false, keepOpen: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') args.base = argv[++i];
    else if (a === '--headed') args.headed = true;
    else if (a === '--keep-open') args.keepOpen = Number(argv[++i]);
    else args._.push(a);
  }
  return args;
}

const log = [];
function record(entry) {
  log.push(entry);
  console.log(JSON.stringify(entry));
}

async function runFlow(page, base, steps) {
  for (const [i, step] of steps.entries()) {
    const label = Object.keys(step).filter((k) => k !== 'text' && k !== 'times')[0];
    try {
      if (step.goto !== undefined) {
        // Accept "mock" as well as "/mock" — Git Bash's MSYS path conversion
        // rewrites leading-slash args into C:/Program Files/Git/..., so bare
        // names are the safe CLI form on Windows.
        const url = step.goto.startsWith('http')
          ? step.goto
          : base + (step.goto.startsWith('/') ? step.goto : '/' + step.goto);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        record({ step: i, goto: url, title: await page.title() });
      } else if (step.resize) {
        const [width, height] = step.resize;
        await page.setViewport({ width, height });
        record({ step: i, resize: step.resize });
      } else if (step.dark !== undefined) {
        await page.emulateMediaFeatures([
          { name: 'prefers-color-scheme', value: step.dark ? 'dark' : 'light' },
        ]);
        record({ step: i, dark: step.dark });
      } else if (step.click) {
        await page.click(step.click);
        record({ step: i, click: step.click });
      } else if (step.clickText) {
        const clicked = await page.evaluate((needle) => {
          const els = [...document.querySelectorAll('button, a, [role=button], [role=tab], [role=menuitem], label, summary')];
          const el = els.find((e) => e.textContent?.trim().toLowerCase().includes(needle.toLowerCase()));
          if (!el) return null;
          el.click();
          return el.textContent?.trim().slice(0, 80) ?? '';
        }, step.clickText);
        if (clicked === null) throw new Error(`no clickable element with text ~ "${step.clickText}"`);
        record({ step: i, clickText: step.clickText, matched: clicked });
      } else if (step.selectByLabel) {
        // Find the <select> whose label/heading text matches, tag it, then use
        // puppeteer's select() so React receives a real change event.
        const tagged = await page.evaluate((needle) => {
          document.querySelectorAll('[data-rt-target]').forEach((el) => el.removeAttribute('data-rt-target'));
          const selects = [...document.querySelectorAll('select')];
          const el = selects.find((s) => {
            const label =
              s.labels?.[0]?.textContent ??
              s.getAttribute('aria-label') ??
              s.closest('label,div,fieldset')?.textContent ??
              '';
            return label.toLowerCase().includes(needle.toLowerCase());
          });
          if (!el) return null;
          el.setAttribute('data-rt-target', '1');
          return [...el.options].map((o) => o.value);
        }, step.selectByLabel);
        if (!tagged) throw new Error(`no <select> labeled ~ "${step.selectByLabel}"`);
        if (!tagged.includes(step.value)) {
          throw new Error(`"${step.value}" not in options [${tagged.join(', ')}] — page.select would silently no-op`);
        }
        await page.select('[data-rt-target]', step.value);
        record({ step: i, selectByLabel: step.selectByLabel, value: step.value, options: tagged });
      } else if (step.type) {
        await page.type(step.type, step.text ?? '');
        record({ step: i, type: step.type, text: step.text });
      } else if (step.press) {
        for (let n = 0; n < (step.times ?? 1); n++) await page.keyboard.press(step.press);
        record({ step: i, press: step.press, times: step.times ?? 1 });
      } else if (step.hover) {
        await page.hover(step.hover);
        record({ step: i, hover: step.hover });
      } else if (step.waitFor) {
        await page.waitForSelector(step.waitFor, { timeout: 10000 });
        record({ step: i, waitFor: step.waitFor });
      } else if (step.wait) {
        await new Promise((r) => setTimeout(r, step.wait));
        record({ step: i, wait: step.wait });
      } else if (step.eval) {
        const result = await page.evaluate(step.eval);
        record({ step: i, eval: step.eval, result });
      } else if (step.ss) {
        mkdirSync(SHOTS_DIR, { recursive: true });
        const file = join(SHOTS_DIR, `${step.ss}.png`);
        await page.screenshot({ path: file, fullPage: step.fullPage ?? false });
        record({ step: i, ss: file });
      } else if (step.a11y) {
        const snapshot = await page.accessibility.snapshot();
        const file = join(SHOTS_DIR, `a11y-${i}.json`);
        mkdirSync(SHOTS_DIR, { recursive: true });
        writeFileSync(file, JSON.stringify(snapshot, null, 2));
        record({ step: i, a11y: file });
      } else if (step.taborder) {
        const path = [];
        for (let n = 0; n < step.taborder; n++) {
          await page.keyboard.press('Tab');
          path.push(
            await page.evaluate(() => {
              const el = document.activeElement;
              if (!el || el === document.body) return '(body)';
              const label =
                el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 60) ?? '';
              return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} "${label}"`;
            }),
          );
        }
        record({ step: i, taborder: path });
      } else if (step.text) {
        const value = await page.$eval(step.text, (el) => el.innerText.slice(0, 2000));
        record({ step: i, text: step.text, value });
      } else {
        record({ step: i, error: `unknown step: ${JSON.stringify(step)}` });
      }
    } catch (err) {
      record({ step: i, action: label, error: String(err.message ?? err) });
    }
  }
}

const args = parseArgs(process.argv.slice(2));
const [command, target] = args._;

if (!command || !['ss', 'flow'].includes(command)) {
  console.error('Usage: driver.mjs ss <path> | flow <steps.json|->  [--base URL] [--headed] [--keep-open ms]');
  process.exit(1);
}

let steps;
if (command === 'ss') {
  const name = (target ?? '/').replace(/[^a-z0-9-]+/gi, '-').replace(/^-|-$/g, '') || 'root';
  steps = [{ goto: target ?? '/' }, { ss: name }];
} else {
  const raw = target === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(target), 'utf8');
  steps = JSON.parse(raw);
}

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: !args.headed,
  args: ['--disable-gpu', '--no-first-run', '--window-size=1440,900'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

const consoleMessages = [];
page.on('console', (msg) => {
  if (['error', 'warning'].includes(msg.type())) {
    consoleMessages.push({ type: msg.type(), text: msg.text().slice(0, 500) });
  }
});
page.on('pageerror', (err) => consoleMessages.push({ type: 'pageerror', text: String(err).slice(0, 500) }));
page.on('requestfailed', (req) =>
  consoleMessages.push({ type: 'requestfailed', text: `${req.method()} ${req.url()} ${req.failure()?.errorText ?? ''}` }),
);

await runFlow(page, args.base, steps);

if (consoleMessages.length) {
  console.log(JSON.stringify({ consoleAndNetwork: consoleMessages }, null, 2));
} else {
  console.log(JSON.stringify({ consoleAndNetwork: 'clean' }));
}

if (args.keepOpen) await new Promise((r) => setTimeout(r, args.keepOpen));
await browser.close();
