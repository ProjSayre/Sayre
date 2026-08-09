import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const require = createRequire(import.meta.url);

function cliOption(name) {
  const inlinePrefix = `${name}=`;
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument.startsWith(inlinePrefix)) {
      const value = argument.slice(inlinePrefix.length);
      if (value.length === 0) throw new Error(`${name} requires a value.`);
      return value;
    }
    if (argument === name) {
      const value = process.argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
      return value;
    }
  }
  return undefined;
}

const requestedBaseUrl = cliOption('--base-url');
const requestedChromePath = cliOption('--chrome-path');

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 736, height: 800 },
  { width: 320, height: 720 },
];
const failures = [];
const pageErrors = [];
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const defaultWorkspacePackJson = readFileSync(
  path.resolve(process.cwd(), 'apps', 'web', 'workspace-packs', 'default', 'sayre.workspace.json'),
  'utf8',
);

function chromeCandidates() {
  const candidates = [
    requestedChromePath,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const cacheRoot = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome-headless-shell');
  if (existsSync(cacheRoot)) {
    for (const version of readdirSync(cacheRoot)) {
      candidates.push(path.join(cacheRoot, version, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
      candidates.push(path.join(cacheRoot, version, 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
    }
  }
  return [...new Set(candidates)].filter((candidate) => existsSync(candidate));
}

async function openPort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') return reject(new Error('Could not allocate a product-workspace test port.'));
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(baseUrl, processState) {
  const deadline = Date.now() + 60_000;
  let lastError = 'not ready';
  while (Date.now() < deadline) {
    if (processState !== null && processState !== undefined && processState.exitCode !== null) {
      throw new Error(`Product fixture server exited early (${processState.exitCode}).`);
    }
    try {
      const response = await fetch(`${baseUrl}/mock`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(300);
  }
  throw new Error(`Product fixture server did not become ready: ${lastError}`);
}

function record(viewport, condition, message, details = '') {
  if (!condition) failures.push(`[${viewport.width}x${viewport.height}] ${message}${details ? ` — ${details}` : ''}`);
}

async function center(page, selector) {
  return await page.$eval(selector, (element) => {
    const rectangle = element.getBoundingClientRect();
    return { x: rectangle.left + rectangle.width / 2, y: rectangle.top + rectangle.height / 2 };
  }).catch(() => null);
}

async function realClick(page, selector) {
  const point = await center(page, selector);
  if (point === null) return false;
  await page.mouse.click(point.x, point.y);
  return true;
}

async function buttonSelectorByText(page, expression) {
  return await page.evaluate((source) => {
    const matcher = new RegExp(source, 'i');
    const button = [...document.querySelectorAll('button')].find((candidate) => matcher.test(candidate.textContent ?? ''));
    if (!button) return null;
    if (!button.dataset.uxProbe) button.dataset.uxProbe = `probe-${Math.random().toString(36).slice(2)}`;
    return `button[data-ux-probe="${button.dataset.uxProbe}"]`;
  }, expression);
}

async function topmostAtCenter(page, selector) {
  return await page.$eval(selector, (element) => {
    const rectangle = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rectangle.left + rectangle.width / 2, rectangle.top + rectangle.height / 2);
    return hit === element || (hit !== null && element.contains(hit));
  }).catch(() => false);
}

async function openMockControls(page) {
  if (await page.$('[data-fixture-control="session"]')) return true;
  const selector = await buttonSelectorByText(page, '^Mock controls$');
  if (!selector) return false;
  await page.$eval(selector, (button) => button.click());
  await page.waitForSelector('[data-fixture-control="session"]', { timeout: 5_000 });
  return true;
}

async function selectFixtureControl(page, key, value) {
  const selector = `[data-fixture-control="${key}"]`;
  await page.select(selector, value);
  await sleep(80);
}

async function runLayoutGeometryFixture(page, baseUrl) {
  const viewport = { width: 1280, height: 800 };
  await page.setViewport(viewport);
  await page.goto(`${baseUrl}/mock?layoutProbe=same-slot-axis-matrix`, { waitUntil: 'networkidle0', timeout: 60_000 });
  await page.waitForSelector('[data-review-layout-fixture="same-slot-axis-matrix"]', { timeout: 20_000 });
  const result = await page.evaluate(() => {
    const slots = ['top', 'bottom', 'navigation', 'explorer', 'inspector'];
    const expectedSizes = {
      'top.a': 56, 'top.b': 64,
      'bottom.a': 52, 'bottom.b': 68,
      'navigation.a': 60, 'navigation.b': 72,
      'explorer.a': 76, 'explorer.b': 84,
      'inspector.a': 80, 'inspector.b': 88,
    };
    const owns = (owner, hit) => hit === owner || (hit !== null && owner.contains(hit));
    const failures = [];
    const handles = [];
    for (const slot of slots) {
      const group = document.querySelector(`[data-workspace-slot-group="${slot}"]`);
      const docks = group ? [...group.querySelectorAll(':scope > [data-workspace-dock]')] : [];
      if (docks.length !== 2) failures.push(`${slot} expected two docks, got ${docks.length}`);
      const axis = slot === 'top' || slot === 'bottom' ? 'block' : 'inline';
      const rectangles = docks.map((dock) => ({ dock, box: dock.getBoundingClientRect() }));
      for (let index = 1; index < rectangles.length; index += 1) {
        const previous = rectangles[index - 1].box;
        const current = rectangles[index].box;
        const previousEnd = axis === 'block' ? previous.bottom : previous.right;
        const currentStart = axis === 'block' ? current.top : current.left;
        if (Math.abs(previousEnd - currentStart) > 1) failures.push(`${slot} docks do not share a stable non-overlapping seam`);
      }
      for (const { dock, box } of rectangles) {
        const id = dock.dataset.workspaceDock;
        const expected = expectedSizes[id];
        const actual = axis === 'block' ? box.height : box.width;
        if (Math.abs(actual - expected) > 1) failures.push(`${id} declared size ${expected} rendered as ${actual}`);
        const handle = dock.querySelector('[role="separator"]');
        if (!handle) {
          failures.push(`${id} has no separator`);
          continue;
        }
        const target = handle.getBoundingClientRect();
        const edge = handle.dataset.resizeEdge;
        const vertical = handle.getAttribute('aria-orientation') === 'horizontal';
        if (target.width < 44 || target.height < 44) failures.push(`${id} target is ${target.width}x${target.height}`);
        const seam = edge === 'block-start' ? box.top
          : edge === 'block-end' ? box.bottom
            : edge === 'inline-start' ? box.left
              : box.right;
        const targetCenter = vertical ? target.top + target.height / 2 : target.left + target.width / 2;
        if (Math.abs(targetCenter - seam) > 1) failures.push(`${id} ${edge} target is not centered on its dock seam`);
        const samples = vertical
          ? [[target.left + target.width / 2, target.top + 2], [target.left + target.width / 2, target.bottom - 2]]
          : [[target.left + 2, target.top + target.height / 2], [target.right - 2, target.top + target.height / 2]];
        if (!samples.every(([x, y]) => owns(handle, document.elementFromPoint(x, y)))) {
          failures.push(`${id} ${edge} target is clipped or covered before its full 44px extent`);
        }
        handles.push({ id, edge, width: target.width, height: target.height });
      }
    }
    return {
      failures,
      handles,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  record(viewport, result.failures.length === 0, 'same-slot/axis/handle geometry fixture failed', result.failures.join('; '));
  record(viewport, result.handles.length === 10, 'geometry fixture did not exercise every normal slot separator', `handles=${result.handles.length}`);
  record(viewport, result.overflow <= 1, 'geometry fixture introduced horizontal overflow', `overflow=${result.overflow}`);
}

async function runCollapseFocusCoverage(page, baseUrl) {
  const viewport = { width: 1280, height: 800 };
  const separator = '[aria-label="Resize region.explorer"]';
  const restore = '[data-workspace-restore="region.explorer"]';
  await page.setViewport(viewport);
  await page.goto(`${baseUrl}/mock`, { waitUntil: 'networkidle0', timeout: 60_000 });
  await page.waitForSelector(separator, { timeout: 20_000 });
  const originalSize = await page.$eval(separator, (element) => element.getAttribute('aria-valuenow'));
  await page.focus(separator);
  await page.keyboard.press('Enter');
  await page.waitForSelector(restore, { timeout: 5_000 });
  await page.waitForFunction((selector) => document.activeElement?.matches(selector), { timeout: 5_000 }, restore).catch(() => undefined);
  record(
    viewport,
    await page.$eval(restore, (element) => document.activeElement === element),
    'collapse did not move focus to the rendered restore control',
  );
  await realClick(page, restore);
  await page.waitForSelector(separator, { timeout: 5_000 });
  await page.waitForFunction((selector) => document.activeElement?.matches(selector), { timeout: 5_000 }, separator).catch(() => undefined);
  const restored = await page.$eval(separator, (element, previous) => ({
    focused: document.activeElement === element,
    retained: element.getAttribute('aria-valuenow') === previous,
    value: element.getAttribute('aria-valuenow'),
  }), originalSize);
  record(viewport, restored.focused, 'expand did not return focus to the restored resize handle');
  record(viewport, restored.retained, 'collapse/expand did not retain the region size', JSON.stringify({ originalSize, restored }));
}

async function installLongWorkspacePack(page) {
  const pack = JSON.parse(defaultWorkspacePackJson);
  pack.metadata.id = 'sayre.long-review-pack';
  pack.metadata.version = '1.0.0';
  pack.metadata.name = 'A very long reusable workspace setup name that must wrap safely at compact width';
  pack.metadata.description = 'Long validation and descriptive content must remain contained while every management action stays reachable on a narrow product surface.'.repeat(3);
  const raw = JSON.stringify(pack);
  await page.$eval('input[type="file"][accept*="application/json"]', (input, value) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([value], 'long-review.workspace.json', { type: 'application/json' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, raw);
  await sleep(150);
}

async function runSystemStateCoverage(page, baseUrl) {
  const viewport = { width: 320, height: 720 };
  await page.setViewport(viewport);
  await page.goto(`${baseUrl}/mock`, { waitUntil: 'networkidle0', timeout: 60_000 });
  await page.waitForSelector('.workspace-product-frame', { timeout: 20_000 });
  const reducedMotion = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  record(viewport, reducedMotion, 'browser did not enable reduced-motion coverage');

  const productSelector = 'button[aria-label="Product Tree"]';
  record(viewport, await realClick(page, productSelector), 'could not select Product for global-state coverage');
  record(viewport, await openMockControls(page), 'could not open stable mock controls for global-state coverage');

  const globalCases = [
    ['session', 'signed-out', '[data-global-state="signed-out"]'],
    ['session', 'session-expired', '[data-global-state="session-expired"]'],
    ['backend', 'unavailable', '[data-global-state="backend-unavailable"]'],
    ['access', 'forbidden', '[data-global-state="organization-forbidden"]'],
  ];
  for (const [key, value, selector] of globalCases) {
    await selectFixtureControl(page, key, value);
    record(viewport, await page.$(selector) !== null, `${key}=${value} did not render its global state`);
    record(viewport, await page.$('[data-workspace-recovery-trigger="true"]') !== null, `${key}=${value} removed system recovery`);
    record(viewport, (await page.$$('.react-flow__node')).length === 0, `${key}=${value} exposed graph nodes`);
    if (key === 'session') await selectFixtureControl(page, 'session', 'authenticated');
    if (key === 'backend') await selectFixtureControl(page, 'backend', 'available');
    if (key === 'access') await selectFixtureControl(page, 'access', 'authorized');
  }

  const canvasCases = [
    ['loading', 'loading'],
    ['empty', 'empty'],
    ['unavailable', 'graph-unavailable'],
  ];
  for (const [value, state] of canvasCases) {
    await selectFixtureControl(page, 'canvasData', value);
    const containedState = await page.evaluate((canvasState) => {
      const canvas = document.querySelector('.mock-canvas');
      const stateElement = document.querySelector(`[data-canvas-state="${canvasState}"]`);
      if (canvas === null || stateElement === null) return false;
      const canvasBox = canvas.getBoundingClientRect();
      const stateBox = stateElement.getBoundingClientRect();
      return stateBox.left >= canvasBox.left - 1
        && stateBox.top >= canvasBox.top - 1
        && stateBox.right <= canvasBox.right + 1
        && stateBox.bottom <= canvasBox.bottom + 1;
    }, state);
    record(viewport, containedState, `canvasData=${value} did not render its contained canvas state`);
    record(viewport, await topmostAtCenter(page, '[data-workspace-recovery-trigger="true"]'), `canvasData=${value} covered system recovery`);
    if (value === 'unavailable') {
      await realClick(page, 'button[aria-label="Close mock controls"]');
      await sleep(50);
      const reload = '[data-canvas-recovery-action="reload-graph"]';
      const reloadBox = await page.$eval(reload, (element) => {
        const box = element.getBoundingClientRect();
        return { width: box.width, height: box.height };
      }).catch(() => null);
      record(viewport, reloadBox !== null && reloadBox.width >= 44 && reloadBox.height >= 44, 'graph unavailable reload action is smaller than 44x44', JSON.stringify(reloadBox));
      record(viewport, await topmostAtCenter(page, reload), 'graph unavailable reload action is covered at its visual center');
    }
  }
  await openMockControls(page);
  await selectFixtureControl(page, 'canvasData', 'normal');
  for (const value of ['generating', 'failed']) {
    await selectFixtureControl(page, 'semantic', value);
    record(viewport, await page.$(`[data-canvas-state="product-${value}"]`) !== null, `semantic=${value} did not render its Product state`);
    record(viewport, await page.$('[data-workspace-recovery-trigger="true"]') !== null, `semantic=${value} removed system recovery`);
  }
  await selectFixtureControl(page, 'semantic', 'ready');

  const closeControls = 'button[aria-label="Close mock controls"]';
  await realClick(page, closeControls);
  const recoveryTrigger = '[data-workspace-recovery-trigger="true"]';
  await realClick(page, recoveryTrigger);
  await page.mouse.click(8, viewport.height - 8);
  await sleep(50);
  record(viewport, await page.$('[data-workspace-recovery-menu="true"]') === null, 'outside activation did not close recovery');

  await realClick(page, recoveryTrigger);
  await realClick(page, '[data-workspace-recovery-action="workspace-pack-settings"]');
  await page.waitForSelector('input[type="file"][accept*="application/json"]', { timeout: 5_000 });
  await installLongWorkspacePack(page);
  const compactPack = await page.evaluate(() => {
    const card = document.querySelector('[data-pack-name^="A very long reusable"]');
    const settings = document.querySelector('.workspace-pack-settings');
    const box = card?.getBoundingClientRect();
    const settingsBox = settings?.getBoundingClientRect();
    const actions = card ? [...card.querySelectorAll('button')].map((button) => button.getBoundingClientRect()) : [];
    return {
      found: card !== null,
      feedback: document.querySelector('.workspace-pack-feedback')?.textContent ?? '',
      contained: box && settingsBox ? box.left >= settingsBox.left - 1 && box.right <= settingsBox.right + 1 : false,
      actionsContained: actions.length > 0 && actions.every((action) => action.left >= 0 && action.right <= window.innerWidth + 1),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  record(viewport, compactPack.found && /installed/i.test(compactPack.feedback), 'long Workspace Pack did not install through the rendered settings surface', JSON.stringify(compactPack));
  record(viewport, compactPack.contained && compactPack.actionsContained && compactPack.overflow <= 1, 'long compact Workspace Pack content/actions overflowed', JSON.stringify(compactPack));

  const backToGraph = await buttonSelectorByText(page, '^Back to graph$');
  record(viewport, backToGraph !== null && await realClick(page, backToGraph), 'could not leave Workspace Pack settings for dirty-draft recovery coverage');
  await realClick(page, recoveryTrigger);
  record(viewport, await realClick(page, '[data-workspace-recovery-action="open-editor"]'), 'could not open the layout editor for dirty-draft recovery coverage');
  await page.waitForSelector('[aria-label="Layout Edit Mode"]', { timeout: 5_000 });
  const range = await page.$('.workspace-editor__range input[type="range"]');
  if (range === null) {
    record(viewport, false, 'layout editor exposed no rendered size control for dirty-draft recovery coverage');
  } else {
    await range.focus();
    await page.keyboard.press('ArrowRight');
    await sleep(50);
    await realClick(page, recoveryTrigger);
    const dirtyRecovery = await page.evaluate(() => ({
      switchDisabled: document.querySelector('[data-workspace-recovery-action="switch-default"]')?.hasAttribute('disabled') ?? false,
      resetDisabled: document.querySelector('[data-workspace-recovery-action="reset-layout"]')?.hasAttribute('disabled') ?? false,
      exitText: document.querySelector('[data-workspace-recovery-action="exit-editor"]')?.textContent ?? '',
      notice: document.querySelector('[data-workspace-recovery-menu="true"]')?.textContent ?? '',
    }));
    record(
      viewport,
      dirtyRecovery.switchDisabled
        && dirtyRecovery.resetDisabled
        && /Discard draft/i.test(dirtyRecovery.exitText)
        && /Finish or discard/i.test(dirtyRecovery.notice),
      'dirty editor draft did not lock destructive recovery actions and offer an explicit discard exit',
      JSON.stringify(dirtyRecovery),
    );
  }
}

// @spec AC-18 EC-23 EC-24
async function runBlockedInteractionCoverage(page, baseUrl) {
  const viewport = { width: 1280, height: 800 };
  const recoveryTrigger = '[data-workspace-recovery-trigger="true"]';
  const cases = [
    { label: 'signed out', key: 'session', value: 'signed-out', marker: '[data-global-state="signed-out"]', input: 'pointer', announcement: 'session changed' },
    { label: 'expired session', key: 'session', value: 'session-expired', marker: '[data-global-state="session-expired"]', input: 'keyboard', announcement: 'session changed' },
    { label: 'backend unavailable', key: 'backend', value: 'unavailable', marker: '[data-global-state="backend-unavailable"]', input: 'pointer', announcement: 'service became unavailable' },
    { label: 'organization forbidden', key: 'access', value: 'forbidden', marker: '[data-global-state="organization-forbidden"]', input: 'keyboard', announcement: 'organization access changed' },
    { label: 'repository forbidden', key: 'access', value: 'repository-restricted', marker: '[data-canvas-state="repository-forbidden"]', input: 'pointer', announcement: 'repository access changed' },
  ];
  await page.setViewport(viewport);

  for (const testCase of cases) {
    await page.goto(`${baseUrl}/mock`, { waitUntil: 'networkidle0', timeout: 60_000 });
    await page.waitForSelector('.workspace-product-frame', { timeout: 20_000 });
    await realClick(page, recoveryTrigger);
    record(viewport, await realClick(page, '[data-workspace-recovery-action="open-editor"]'), `${testCase.label}: could not open the layout editor`);
    await page.waitForSelector('[aria-label="Layout Edit Mode"]', { timeout: 5_000 });
    record(viewport, await openMockControls(page), `${testCase.label}: could not open fixture controls while editing`);

    const range = await page.$('.workspace-editor__range input[type="range"]');
    if (range !== null) {
      await range.focus();
      await page.keyboard.press('ArrowRight');
    } else record(viewport, false, `${testCase.label}: no rendered size control was available to make the draft dirty`);

    const source = 'button[aria-label="Move region.explorer"]';
    record(viewport, await topmostAtCenter(page, source), `${testCase.label}: drag source was covered before pickup`);
    if (testCase.input === 'pointer') {
      const sourceCenter = await center(page, source);
      if (sourceCenter === null) record(viewport, false, `${testCase.label}: pointer drag source was missing`);
      else {
        await page.mouse.move(sourceCenter.x, sourceCenter.y);
        await page.mouse.down();
      }
    } else {
      await page.focus(source);
      await page.keyboard.press('Space');
    }
    await page.waitForSelector('[data-workspace-drop-slot]', { timeout: 5_000 });
    await page.evaluate(() => {
      window.__workspaceStorageWrites = 0;
      window.__workspaceStorageWriteKeys = [];
    });

    await selectFixtureControl(page, testCase.key, testCase.value);
    await page.waitForSelector(testCase.marker, { timeout: 5_000 });
    await page.waitForSelector('[data-workspace-interruption-status="true"]', { timeout: 5_000 });
    if (testCase.input === 'pointer') await page.mouse.up();
    await page.waitForFunction(
      (selector) => document.activeElement === document.querySelector(selector),
      { timeout: 5_000 },
      recoveryTrigger,
    ).catch(() => undefined);

    const state = await page.evaluate(({ marker, expectedAnnouncement }) => {
      const recovery = document.querySelector('[data-workspace-recovery-trigger="true"]');
      const recoveryBox = recovery?.getBoundingClientRect();
      const status = document.querySelector('[data-workspace-interruption-status="true"]')?.textContent ?? '';
      return {
        marker: document.querySelector(marker) !== null,
        editorCount: document.querySelectorAll('[aria-label="Layout Edit Mode"]').length,
        dropTargetCount: document.querySelectorAll('[data-workspace-drop-slot]').length,
        dockCount: document.querySelectorAll('[data-workspace-dock]').length,
        graphNodeCount: document.querySelectorAll('.react-flow__node').length,
        activeRecovery: document.activeElement === recovery,
        recoverySize: recoveryBox ? { width: recoveryBox.width, height: recoveryBox.height } : null,
        safeAnnouncement: status.toLowerCase().includes(expectedAnnouncement),
        movedAnnouncement: /Moved region\.explorer/i.test(document.body.textContent ?? ''),
        writes: (window.__workspaceStorageWriteKeys ?? [])
          .filter((entry) => entry.startsWith('local:sayre.workspace-packs.')).length,
      };
    }, { marker: testCase.marker, expectedAnnouncement: testCase.announcement });
    record(viewport, state.marker, `${testCase.label}: blocked state marker disappeared`, JSON.stringify(state));
    record(
      viewport,
      state.editorCount === 0 && state.dropTargetCount === 0 && state.dockCount === 0 && state.graphNodeCount === 0,
      `${testCase.label}: blocked transition retained editor targets or unauthorized workspace content`,
      JSON.stringify(state),
    );
    record(viewport, state.safeAnnouncement && !state.movedAnnouncement, `${testCase.label}: cancellation was not safely announced or a move committed`, JSON.stringify(state));
    record(viewport, state.writes === 0, `${testCase.label}: blocked transition persisted the interrupted draft`, `writes=${state.writes}`);
    record(viewport, state.activeRecovery, `${testCase.label}: focus did not recover to the Workspace control`, JSON.stringify(state));
    record(
      viewport,
      state.recoverySize !== null && state.recoverySize.width >= 44 && state.recoverySize.height >= 44,
      `${testCase.label}: recovery control is smaller than 44x44`,
      JSON.stringify(state.recoverySize),
    );
    record(viewport, await topmostAtCenter(page, recoveryTrigger), `${testCase.label}: recovery control was not topmost after interruption`);
    await realClick(page, recoveryTrigger);
    record(
      viewport,
      await page.$('[data-workspace-recovery-action="open-editor"]') === null,
      `${testCase.label}: recovery allowed layout editing to restart while the workspace remained blocked`,
    );
    await page.keyboard.press('Escape');
  }
}

// @spec AC-1 AC-2 AC-3 AC-4 AC-5 AC-8 AC-9 AC-11 AC-12
// @spec AC-6 AC-7 AC-10 AC-13 AC-14 AC-15 AC-16 AC-18 AC-20 AC-22 AC-23 AC-24 AC-25
// @spec EC-4 EC-5 EC-6 EC-7 EC-8 EC-9 EC-10 EC-11 EC-12 EC-15 EC-16 EC-17 EC-19 EC-21 EC-22 EC-23 EC-24 EC-25
async function runViewport(page, baseUrl, viewport) {
  await page.setViewport(viewport);
  await page.goto(`${baseUrl}/mock`, { waitUntil: 'networkidle0', timeout: 60_000 });
  await page.waitForSelector('.workspace-product-frame', { timeout: 20_000 });
  await sleep(250);

  const geometry = await page.evaluate(() => {
    const rectangle = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const value = element.getBoundingClientRect();
      return { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height };
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      frame: rectangle('.workspace-product-frame'),
      content: rectangle('.workspace-product-frame__content'),
      primary: rectangle('.workspace-layout__dock--primary'),
      view: rectangle('[data-workspace-view]'),
      root: rectangle('.mock-root'),
      inspectorCount: document.querySelectorAll('.workspace-layout__dock--inspector').length,
      recoveryText: document.querySelector('[aria-label="Workspace recovery"]')?.textContent ?? '',
      recoveryTriggerCount: document.querySelectorAll('[aria-label="Workspace recovery"] button[aria-haspopup="menu"]').length,
    };
  });
  const contained = (inner, outer) => inner !== null && outer !== null
    && inner.left >= outer.left - 1 && inner.top >= outer.top - 1 && inner.right <= outer.right + 1 && inner.bottom <= outer.bottom + 1;
  record(viewport, geometry.scrollWidth <= geometry.viewport.width + 1, 'product frame has horizontal page overflow', `${geometry.scrollWidth}px > ${geometry.viewport.width}px`);
  record(viewport, geometry.primary !== null && geometry.primary.width > 0 && geometry.primary.height > 0, 'primary region has no usable area');
  record(viewport, contained(geometry.view, geometry.primary), 'workspace view escaped its primary region', JSON.stringify({ view: geometry.view, primary: geometry.primary }));
  record(viewport, contained(geometry.root, geometry.content), 'legacy product root escaped product content', JSON.stringify({ root: geometry.root, content: geometry.content }));
  record(viewport, geometry.inspectorCount === 0, 'inactive inspector still allocates/intercepts a dock', `count=${geometry.inspectorCount}`);
  record(viewport, geometry.recoveryTriggerCount === 1, 'recovery is not one compact menu trigger', `count=${geometry.recoveryTriggerCount}`);
  record(viewport, !/@\d+\.\d+\.\d+/.test(geometry.recoveryText), 'closed recovery chrome exposes a raw pack id/version', geometry.recoveryText.trim());

  const recoveryTrigger = '[data-workspace-recovery-trigger="true"]';
  const recoveryBox = await page.$eval(recoveryTrigger, (element) => {
    const box = element.getBoundingClientRect();
    return { width: box.width, height: box.height };
  }).catch(() => null);
  record(viewport, recoveryBox !== null && recoveryBox.width >= 44 && recoveryBox.height >= 44, 'recovery trigger is smaller than 44x44', JSON.stringify(recoveryBox));
  if (await realClick(page, recoveryTrigger)) {
    await sleep(50);
    const menuText = await page.$eval('[aria-label="Workspace recovery"]', (element) => element.textContent ?? '');
    record(viewport, /Switch to default/i.test(menuText) && /Reset layout/i.test(menuText) && /Workspace Pack settings/i.test(menuText), 'recovery menu actions are not reachable');
    await page.keyboard.press('Escape');
    record(viewport, await page.$eval(recoveryTrigger, (element) => document.activeElement === element).catch(() => false), 'Escape did not return focus to recovery trigger');
  }

  const settingsSelector = await buttonSelectorByText(page, '^Settings$');
  record(viewport, settingsSelector !== null && await topmostAtCenter(page, settingsSelector), 'Settings is not the topmost hit target at its visual center');
  if (settingsSelector && await realClick(page, settingsSelector)) {
    await sleep(100);
    const backSelector = await buttonSelectorByText(page, 'Back to graph');
    record(viewport, backSelector !== null && await topmostAtCenter(page, backSelector), 'Back to graph is not the topmost hit target at its visual center');
    if (backSelector) {
      await realClick(page, backSelector);
      await sleep(100);
      record(viewport, (await page.$('[aria-label="Settings"]')) === null, 'Back to graph did not close Settings');
    }
  }

  const filesSelector = 'button[aria-label="Repository explorer"]';
  if (await realClick(page, filesSelector)) {
    await sleep(50);
    const explorerAfterClose = await page.$$('.workspace-layout__dock--explorer');
    record(viewport, explorerAfterClose.length === 0, 'Files toggle left an explorer dock after close', `count=${explorerAfterClose.length}`);
    await realClick(page, filesSelector);
  } else record(viewport, false, 'Files toggle is not clickable');

  const separator = await page.$('[aria-label="Resize region.explorer"]');
  if (separator) {
    const info = await separator.boundingBox();
    record(viewport, info !== null && info.width >= 44 && info.height >= 44, 'resize separator target is smaller than 44x44', JSON.stringify(info));
    if (info) {
      const separatorHit = await page.evaluate(({ x, y }) => {
        const element = document.elementFromPoint(x, y);
        return element === null ? null : {
          tag: element.tagName,
          className: typeof element.className === 'string' ? element.className : '',
          label: element.getAttribute('aria-label'),
        };
      }, { x: info.x + info.width / 2, y: info.y + info.height / 2 });
      await page.evaluate(() => { window.__workspaceStorageWrites = 0; });
      await page.mouse.move(info.x + info.width / 2, info.y + info.height / 2);
      await page.mouse.down();
      await page.mouse.move(info.x + info.width / 2 + 48, info.y + info.height / 2, { steps: 6 });
      await page.mouse.up();
      await sleep(100);
      const writes = await page.evaluate(() => window.__workspaceStorageWrites ?? 0);
      record(viewport, writes === 1, 'pointer resize did not persist exactly once on commit', `writes=${writes}; hit=${JSON.stringify(separatorHit)}; box=${JSON.stringify(info)}`);
    }
  } else record(viewport, false, 'no rendered resize separator was available');

  const productSelector = 'button[aria-label="Product Tree"]';
  if (await realClick(page, productSelector)) {
    await sleep(300);
    const featureSelector = await page.evaluate(() => {
      const element = [...document.querySelectorAll('.react-flow__node, button, [role="button"]')]
        .find((candidate) => /Checkout|payments/i.test(candidate.textContent ?? ''));
      if (!element) return null;
      element.setAttribute('data-ux-feature', 'checkout');
      return '[data-ux-feature="checkout"]';
    });
    if (featureSelector && await realClick(page, featureSelector)) {
      await sleep(100);
      const exploreSelector = await buttonSelectorByText(page, 'Explore code');
      if (exploreSelector && await realClick(page, exploreSelector)) {
        await sleep(200);
        const state = await page.evaluate(() => ({
          technical: document.querySelector('button[aria-label="Technical Tree"]')?.getAttribute('aria-current') === 'page',
          inspector: document.querySelectorAll('.workspace-layout__dock--inspector').length,
          back: [...document.querySelectorAll('button')].some((button) => /Back to feature/i.test(button.textContent ?? '')),
        }));
        record(viewport, state.technical && state.inspector === 1 && state.back, 'Explore code lost the selected file/inspector/return path', JSON.stringify(state));
      } else record(viewport, false, 'mapped Product feature did not expose Explore code');
    } else record(viewport, false, 'could not activate a mapped Product feature');
  } else record(viewport, false, 'Product view control is not clickable');

  if (await realClick(page, recoveryTrigger)) {
    const editorSelector = await buttonSelectorByText(page, 'Layout editor|Edit workspace layout');
    if (editorSelector && await realClick(page, editorSelector)) {
      await sleep(100);
      const editor = await page.evaluate(() => {
        const toolbar = document.querySelector('[aria-label="Layout Edit Mode"]');
        const preview = document.querySelector('.workspace-editor__preview');
        const productContent = document.querySelector('.workspace-product-frame__content');
        const bounds = (element) => element ? element.getBoundingClientRect() : null;
        const toolbarBox = bounds(toolbar);
        const previewBox = bounds(preview);
        const contentBox = bounds(productContent);
        return {
          toolbar: toolbarBox && { width: toolbarBox.width, height: toolbarBox.height },
          preview: previewBox && { width: previewBox.width, height: previewBox.height },
          content: contentBox && { width: contentBox.width, height: contentBox.height },
          primaryMove: [...document.querySelectorAll('button')].some((button) => /Move region\.primary|Drag.*region\.primary/i.test(`${button.getAttribute('aria-label') ?? ''} ${button.textContent ?? ''}`)),
        };
      });
      record(viewport, !editor.primaryMove, 'immutable primary exposes a move affordance');
      if (viewport.width === 320) {
        record(viewport, editor.preview !== null && editor.content !== null && editor.preview.height >= editor.content.height * 0.4, 'compact editor preview is below 40% of product-content height', JSON.stringify(editor));
        record(viewport, editor.toolbar !== null && editor.toolbar.width <= viewport.width, 'compact editor toolbar requires horizontal scrolling', JSON.stringify(editor.toolbar));
      }
      const dragSource = await page.$('button[aria-label="Move region.explorer"]');
      if (dragSource) {
        const sourceBox = await dragSource.boundingBox();
        if (sourceBox) {
          await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
          await page.mouse.down();
          await sleep(50);
          const target = await page.$('[data-workspace-drop-slot]');
          const targetBox = await target?.boundingBox();
          if (targetBox) {
            await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2);
            await page.mouse.up();
            const announcement = await page.$eval('[role="status"][aria-live]', (element) => element.textContent ?? '').catch(() => '');
            record(viewport, /Moved/i.test(announcement), 'rendered pointer drag did not commit and announce a move', announcement);
          } else {
            await page.mouse.up();
            record(viewport, false, 'rendered pointer drag exposed no compatible target');
          }
        }
      } else record(viewport, false, 'rendered editor exposed no mutable drag source');
    } else record(viewport, false, 'recovery menu did not expose Layout editor');
  }
}

const candidates = chromeCandidates();
if (candidates.length === 0) {
  console.error('PRODUCT WORKSPACE UX HARNESS ERROR: no installed Chromium/Chrome/Edge executable was found.');
  process.exit(1);
}

let serverProcess = null;
let fixtureDistDirectory = null;
let baseUrl = requestedBaseUrl?.replace(/\/$/, '');
let browser;
try {
  if (!baseUrl) {
    const port = await openPort();
    baseUrl = `http://127.0.0.1:${port}`;
    const fixtureDistName = `.next-product-workspace-ux-${port}`;
    fixtureDistDirectory = path.resolve(process.cwd(), 'apps', 'web', fixtureDistName);
    const nextEntry = require.resolve('next/dist/bin/next');
    serverProcess = spawn(process.execPath, [nextEntry, 'dev', 'apps/web', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    serverProcess.stdout.on('data', () => undefined);
    serverProcess.stderr.on('data', () => undefined);
  }
  await waitForServer(baseUrl, serverProcess);
  console.log(`Product workspace fixture ready at ${baseUrl}.`);
  console.log(`Launching Chromium from ${candidates[0]}.`);
  browser = await puppeteer.launch({ executablePath: candidates[0], headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluateOnNewDocument(() => {
    const original = Storage.prototype.setItem;
    window.__workspaceStorageWrites = 0;
    window.__workspaceStorageWriteKeys = [];
    Storage.prototype.setItem = function (...args) {
      window.__workspaceStorageWrites += 1;
      const scope = this === window.localStorage ? 'local' : this === window.sessionStorage ? 'session' : 'storage';
      window.__workspaceStorageWriteKeys.push(`${scope}:${String(args[0])}`);
      return original.apply(this, args);
    };
  });
  page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.stack ?? error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      const location = message.location().url;
      const isKnownFixtureFavicon = message.type() === 'error'
        && message.text() === 'Failed to load resource: the server responded with a status of 404 (Not Found)'
        && location.endsWith('/favicon.ico');
      if (isKnownFixtureFavicon) return;
      pageErrors.push(`console.${message.type()}: ${message.text()}${location ? ` (${location})` : ''}`);
    }
  });
  for (const viewport of VIEWPORTS) {
    console.log(`Checking ${viewport.width}x${viewport.height}…`);
    await runViewport(page, baseUrl, viewport);
  }
  console.log('Checking same-slot geometry and resize-focus retention…');
  await runLayoutGeometryFixture(page, baseUrl);
  await runCollapseFocusCoverage(page, baseUrl);
  console.log('Checking active-edit interruption boundaries…');
  await runBlockedInteractionCoverage(page, baseUrl);
  console.log('Checking reduced-motion, failure states, and compact Workspace Pack management…');
  await runSystemStateCoverage(page, baseUrl);
} catch (error) {
  console.error(`PRODUCT WORKSPACE UX HARNESS ERROR: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (serverProcess !== null && serverProcess.exitCode === null) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(serverProcess.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      serverProcess.kill();
    }
    await Promise.race([
      new Promise((resolve) => serverProcess.once('exit', resolve)),
      sleep(2_000),
    ]);
  }
  if (fixtureDistDirectory !== null) {
    const expectedParent = path.resolve(process.cwd(), 'apps', 'web');
    const fixtureName = path.basename(fixtureDistDirectory);
    if (path.dirname(fixtureDistDirectory) === expectedParent && fixtureName.startsWith('.next-product-workspace-ux-')) {
      rmSync(fixtureDistDirectory, { recursive: true, force: true });
    }
  }
}

for (const error of pageErrors) failures.push(`[browser] unexpected ${error}`);
if (failures.length > 0) {
  console.error('PRODUCT WORKSPACE UX FAILURES:');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exitCode = 1;
} else if (process.exitCode !== 1) {
  console.log('Product workspace UX passed at 1280x800, 736x800, and 320x720.');
}
