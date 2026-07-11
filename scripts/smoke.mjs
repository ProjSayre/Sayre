// Dev-only smoke test: drives both routes in headless Edge/Chrome with REAL
// coordinate mouse clicks (no synthetic element.click() — that bypasses the
// pointer pipeline and masks capture/targeting bugs). Fails on any console
// error/warning, page error, or broken interaction.
// Usage: start `npm run dev` (port 5173), then `node scripts/smoke.mjs`.

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:5173";
const SHOT_DIR = process.env.SMOKE_SHOTS ?? "scripts/.shots";

const CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

const executablePath = CANDIDATES.find((p) => existsSync(p));
if (!executablePath) {
  console.error("no chrome/edge found");
  process.exit(1);
}

const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--window-size=1440,900"] });

/** real mouse click at the center of the element matching an aria-label/selector probe */
async function clickReal(page, findExpr, what) {
  const box = await page.evaluate(findExpr);
  if (!box) {
    problems.push(`could not locate ${what}`);
    return false;
  }
  await page.mouse.click(box.x, box.y);
  return true;
}

const centerOf = (selectorExpr) => `(() => {
  const el = ${selectorExpr};
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

/** center of just the node's circle glyph (labels extend right of the dot) */
const glyphCenterOf = (gExpr) => `(() => {
  const g = ${gExpr};
  if (!g) return null;
  const c = g.querySelector("circle");
  const r = (c ?? g).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      problems.push(`console.${msg.type()}: ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
  page.on("requestfailed", (req) => {
    if (!req.url().startsWith("data:")) problems.push(`requestfailed: ${req.url()} ${req.failure()?.errorText}`);
  });

  await mkdir(SHOT_DIR, { recursive: true });

  // ---- landing ----
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });
  await sleep(1500);
  await page.screenshot({ path: `${SHOT_DIR}/landing.png` });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(900);
  await page.screenshot({ path: `${SHOT_DIR}/landing-bottom.png` });

  // ---- demo: REAL canvas node click ----
  await page.goto(BASE + "/demo", { waitUntil: "networkidle0" });
  await sleep(1800);
  await page.screenshot({ path: `${SHOT_DIR}/demo-filetree.png` });

  await clickReal(
    page,
    glyphCenterOf(`[...document.querySelectorAll("g.tree-node")].find((n) => n.getAttribute("aria-label")?.includes("PaymentForm.tsx"))`),
    "PaymentForm.tsx canvas node",
  );
  await sleep(700);
  let path = await page.evaluate(() => document.querySelector(".nodepanel__path")?.textContent ?? "");
  if (!path.includes("PaymentForm.tsx")) problems.push(`REAL canvas click did not select PaymentForm.tsx (sidebar: "${path}")`);
  await page.screenshot({ path: `${SHOT_DIR}/demo-selected.png` });

  // folder click-to-expand via real click (collapsed api/ folder)
  const nodesBefore = await page.evaluate(() => document.querySelectorAll("g.tree-node").length);
  await clickReal(
    page,
    glyphCenterOf(`[...document.querySelectorAll("g.tree-node")].find((n) => n.getAttribute("aria-label")?.startsWith("folder api"))`),
    "api/ canvas folder",
  );
  await sleep(700);
  const nodesAfter = await page.evaluate(() => document.querySelectorAll("g.tree-node").length);
  if (nodesAfter <= nodesBefore) problems.push(`REAL click on api/ folder did not expand it (${nodesBefore} → ${nodesAfter} nodes)`);

  // ---- persona switch via real clicks ----
  await clickReal(page, centerOf(`document.querySelector(".persona__button")`), "persona button");
  await sleep(300);
  await clickReal(
    page,
    centerOf(`[...document.querySelectorAll(".persona__option")].find((o) => o.textContent?.includes("new hire"))`),
    "persona option new hire",
  );
  await sleep(1300);
  const onRelations = await page.evaluate(() => Boolean(document.querySelector(".rel-breadcrumb")));
  if (!onRelations) problems.push("persona switch did not land on relations");
  // last selection before the switch was api/ — it must survive (§8.6)
  const stillSelected = await page.evaluate(() => (document.querySelector(".nodepanel__path")?.textContent ?? "").includes("api"));
  if (!stillSelected) problems.push("selection did not survive persona switch");
  await page.screenshot({ path: `${SHOT_DIR}/demo-relations.png` });

  // ---- relations: select + drill via real clicks ----
  await clickReal(
    page,
    glyphCenterOf(`[...document.querySelectorAll("g.tree-node")].find((n) => n.getAttribute("aria-label")?.startsWith("folder apps"))`),
    "relations apps/ node",
  );
  await sleep(500);
  await clickReal(
    page,
    glyphCenterOf(`[...document.querySelectorAll("g.tree-node")].find((n) => n.getAttribute("aria-label")?.startsWith("folder apps"))`),
    "relations apps/ node (drill)",
  );
  await sleep(900);
  const crumb = await page.evaluate(() => document.querySelector(".rel-breadcrumb")?.textContent ?? "");
  if (!crumb.includes("apps/")) problems.push(`REAL double-select drill failed — breadcrumb: "${crumb}"`);
  await page.screenshot({ path: `${SHOT_DIR}/demo-drilled.png` });

  // ---- features: ring select + bundled dir flyout via real clicks ----
  await clickReal(
    page,
    centerOf(`[...document.querySelectorAll(".topbar__tab")].find((t) => t.textContent?.includes("features"))`),
    "features tab",
  );
  await sleep(1100);
  await clickReal(
    page,
    centerOf(`[...document.querySelectorAll("g.feature-node")].find((r) => r.getAttribute("aria-label")?.includes("feature checkout"))`),
    "checkout feature ring",
  );
  await sleep(600);
  const panelText = await page.evaluate(() => document.querySelector(".featurepanel")?.textContent ?? "");
  if (!panelText.includes("3 open tickets")) problems.push("REAL ring click did not open the checkout feature panel");

  await clickReal(
    page,
    centerOf(`document.querySelector(".bundle-dir__ring")`),
    "bundled dir glyph",
  );
  await sleep(500);
  const flyout = await page.evaluate(() => document.querySelector(".feature-flyout__path")?.textContent ?? "");
  if (!flyout.includes("/")) problems.push("REAL bundled-dir click did not open the path flyout");
  await page.screenshot({ path: `${SHOT_DIR}/demo-features.png` });
  const rowClicked = await page.evaluate(() => {
    const row = document.querySelector(".feature-flyout__row");
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (rowClicked) {
    await page.mouse.click(rowClicked.x, rowClicked.y);
    await sleep(500);
    const nowFile = await page.evaluate(() => (document.querySelector(".nodepanel__path")?.textContent ?? "").length > 0);
    if (!nowFile) problems.push("flyout row click did not select the file");
  }

  // ---- ⌘k ----
  await page.keyboard.down("Control");
  await page.keyboard.press("k");
  await page.keyboard.up("Control");
  await sleep(300);
  await page.keyboard.type("currency");
  await sleep(300);
  const cmdkRows = await page.evaluate(() => document.querySelectorAll(".cmdk__row").length);
  if (cmdkRows === 0) problems.push("⌘k returned no rows for 'currency'");
  await page.keyboard.press("Enter");
  await sleep(600);

  // status line sanity
  const status = await page.evaluate(() => document.querySelector(".statusline__text")?.textContent ?? "");
  if (!status.includes("sample data")) problems.push(`status line missing sample data marker: "${status}"`);

  // waitlist modal via real CTA click
  await clickReal(page, centerOf(`[...document.querySelectorAll("button")].find((b) => b.textContent?.includes("get early access"))`), "top bar CTA");
  await sleep(400);
  const modalOpen = await page.evaluate(() => Boolean(document.querySelector(".waitlist-form")));
  if (!modalOpen) problems.push("waitlist modal did not open");
  await page.keyboard.press("Escape");
  await sleep(300);

  // drag-pan must NOT deselect (click-vs-drag discrimination)
  await clickReal(
    page,
    glyphCenterOf(`[...document.querySelectorAll("g.feature-node")].find((r) => r.getAttribute("aria-label")?.includes("feature checkout"))`),
    "checkout ring (re-select)",
  );
  await sleep(400);
  const svgBox = await page.evaluate(() => {
    const r = document.querySelector(".demo-canvas").getBoundingClientRect();
    return { x: r.left + r.width * 0.8, y: r.top + r.height * 0.8 };
  });
  await page.mouse.move(svgBox.x, svgBox.y);
  await page.mouse.down();
  await page.mouse.move(svgBox.x - 120, svgBox.y - 60, { steps: 8 });
  await page.mouse.up();
  await sleep(400);
  const selSurvivedPan = await page.evaluate(() => Boolean(document.querySelector(".featurepanel")));
  if (!selSurvivedPan) problems.push("drag-pan on background cleared the selection (should be click-only)");

  // ---- mobile ----
  await page.setViewport({ width: 390, height: 800 });
  await page.goto(BASE + "/demo", { waitUntil: "networkidle0" });
  await sleep(1400);
  const sheetVisible = await page.evaluate(() => Boolean(document.querySelector(".sheet__bar")));
  if (!sheetVisible) problems.push("mobile bottom sheet missing at 390px");
  await page.screenshot({ path: `${SHOT_DIR}/demo-mobile.png` });
} finally {
  await browser.close();
}

if (problems.length > 0) {
  console.error("SMOKE PROBLEMS:");
  for (const p of problems) console.error(" - " + p);
  process.exit(1);
}
console.log("smoke ok (real clicks) — screenshots in " + SHOT_DIR);
