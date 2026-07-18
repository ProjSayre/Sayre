import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { createServer as createViteServer } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = path.join(ROOT, "public", "media");
const FRAME_DIR = path.join(ROOT, ".tmp", "anime-hero-frames");
const RENDER_PATH = "/scripts/anime-hero-render/index.html";
const FPS = 30;
const DURATION = 10.2;
const FRAME_COUNT = Math.round(FPS * DURATION);
const HEADLESS_SHELL_ROOT = path.join(os.homedir(), ".cache", "puppeteer", "chrome-headless-shell");
const HEADLESS_SHELL_PATHS = existsSync(HEADLESS_SHELL_ROOT)
  ? readdirSync(HEADLESS_SHELL_ROOT)
      .sort()
      .reverse()
      .map((version) => path.join(HEADLESS_SHELL_ROOT, version, "chrome-headless-shell-win64", "chrome-headless-shell.exe"))
  : [];
const CHROMIUM_PATHS = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  ...HEADLESS_SHELL_PATHS,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

const executablePaths = [...new Set(CHROMIUM_PATHS.filter((candidate) => existsSync(candidate)))];
if (executablePaths.length === 0) {
  throw new Error("No Chromium browser found. Set PUPPETEER_EXECUTABLE_PATH and retry.");
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const finalArgs = command === "ffmpeg" ? ["-hide_banner", "-loglevel", "error", ...args] : args;
    const child = spawn(command, finalArgs, { cwd: ROOT, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

function framePath(index) {
  return path.join(FRAME_DIR, `frame-${String(index).padStart(4, "0")}.png`);
}

async function fileSize(file) {
  return (await stat(file)).size;
}

async function launchBrowser() {
  const failures = [];
  for (const executablePath of executablePaths) {
    try {
      return await puppeteer.launch({
        executablePath,
        headless: true,
        pipe: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-gpu",
          "--hide-scrollbars",
          "--font-render-hinting=none",
        ],
      });
    } catch (error) {
      failures.push(`${executablePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Unable to launch a Chromium renderer:\n${failures.join("\n")}`);
}

await mkdir(OUTPUT_DIR, { recursive: true });
await rm(FRAME_DIR, { recursive: true, force: true });
await mkdir(FRAME_DIR, { recursive: true });

const vite = await createViteServer({
  root: ROOT,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

let browser;
let succeeded = false;
try {
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Could not determine the render server port.");
  const url = `http://127.0.0.1:${address.port}${RENDER_PATH}`;

  browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1124, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: "networkidle0", timeout: 60_000 });
  await page.waitForFunction(() => window.__ANIME_HERO_READY__ === true, { timeout: 60_000 });
  await page.waitForSelector("[data-om-exportable-video-with-duration-secs]", { timeout: 60_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await document.fonts.load('11px "Fragment Mono"');
  });
  await page.waitForFunction(() => {
    const el = document.querySelector("[data-om-exportable-video-with-duration-secs]");
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return Math.abs(rect.width - 1920) < 1 && Math.abs(rect.height - 1080) < 1;
  }, { timeout: 30_000 });

  const stage = await page.$("[data-om-exportable-video-with-duration-secs]");
  if (!stage) throw new Error("The render stage disappeared before capture.");

  for (let index = 0; index < FRAME_COUNT; index += 1) {
    const time = index === FRAME_COUNT - 1 ? DURATION : (index / (FRAME_COUNT - 1)) * DURATION;
    await page.evaluate((seekTime) => {
      const el = document.querySelector("[data-om-exportable-video-with-duration-secs]");
      el.dispatchEvent(new CustomEvent("data-om-seek-to-time-frame", {
        detail: { time: seekTime, sync: true },
      }));
    }, time);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
    await stage.screenshot({ path: framePath(index), type: "png" });
    if (index % FPS === 0 || index === FRAME_COUNT - 1) {
      process.stdout.write(`captured ${index + 1}/${FRAME_COUNT} frames\n`);
    }
  }

  const desktopVideo = path.join(OUTPUT_DIR, "hero-anime.mp4");
  const mobileVideo = path.join(OUTPUT_DIR, "hero-anime-mobile.mp4");
  const desktopWebm = path.join(OUTPUT_DIR, "hero-anime.webm");
  const mobileWebm = path.join(OUTPUT_DIR, "hero-anime-mobile.webm");
  const startStill = path.join(OUTPUT_DIR, "hero-anime-start.webp");
  const finalStill = path.join(OUTPUT_DIR, "hero-anime-final.webp");
  const mobileStartStill = path.join(OUTPUT_DIR, "hero-anime-start-mobile.webp");
  const mobileFinalStill = path.join(OUTPUT_DIR, "hero-anime-final-mobile.webp");

  await run("ffmpeg", [
    "-y", "-framerate", String(FPS), "-i", path.join(FRAME_DIR, "frame-%04d.png"),
    "-an", "-c:v", "libx264", "-preset", "slow", "-tune", "animation", "-crf", "18",
    "-profile:v", "high", "-level", "4.1", "-refs", "4", "-pix_fmt", "yuv420p",
    "-g", String(FPS * 2), "-keyint_min", String(FPS * 2), "-sc_threshold", "0",
    "-x264-params", `colorprim=bt709:transfer=bt709:colormatrix=bt709`,
    "-movflags", "+faststart", desktopVideo,
  ]);

  await run("ffmpeg", [
    "-y", "-i", desktopVideo,
    "-vf", "crop=608:1080:656:0,scale=720:1280:flags=lanczos",
    "-an", "-c:v", "libx264", "-preset", "slow", "-tune", "animation", "-crf", "19",
    "-profile:v", "high", "-level", "4.0", "-refs", "4", "-pix_fmt", "yuv420p",
    "-g", String(FPS * 2), "-keyint_min", String(FPS * 2), "-sc_threshold", "0",
    "-x264-params", `colorprim=bt709:transfer=bt709:colormatrix=bt709`,
    "-movflags", "+faststart", mobileVideo,
  ]);

  const webmArgs = (filter, output, crf) => [
    "-y", "-framerate", String(FPS), "-i", path.join(FRAME_DIR, "frame-%04d.png"),
    ...(filter ? ["-vf", filter] : []),
    "-an", "-c:v", "libvpx-vp9", "-deadline", "good", "-cpu-used", "3",
    "-row-mt", "1", "-tile-columns", "2", "-b:v", "0", "-crf", String(crf),
    "-pix_fmt", "yuv420p", "-g", String(FPS * 2),
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
    output,
  ];
  await run("ffmpeg", webmArgs(null, desktopWebm, 28));
  await run("ffmpeg", webmArgs("crop=608:1080:656:0,scale=720:1280:flags=lanczos", mobileWebm, 29));

  const stillArgs = (input, output, filter) => [
    "-y", "-i", input, ...(filter ? ["-vf", filter] : []), "-frames:v", "1",
    "-c:v", "libwebp", "-quality", "90", "-compression_level", "6", output,
  ];
  await run("ffmpeg", stillArgs(framePath(0), startStill));
  await run("ffmpeg", stillArgs(framePath(FRAME_COUNT - 1), finalStill));
  await run("ffmpeg", stillArgs(framePath(0), mobileStartStill, "crop=608:1080:656:0,scale=720:1280:flags=lanczos"));
  await run("ffmpeg", stillArgs(framePath(FRAME_COUNT - 1), mobileFinalStill, "crop=608:1080:656:0,scale=720:1280:flags=lanczos"));

  const outputs = [desktopVideo, mobileVideo, desktopWebm, mobileWebm, startStill, finalStill, mobileStartStill, mobileFinalStill];
  for (const file of outputs) {
    process.stdout.write(`${path.relative(ROOT, file)} ${(await fileSize(file) / 1024 / 1024).toFixed(2)} MB\n`);
  }
  succeeded = true;
} finally {
  if (browser) await browser.close();
  await vite.close();
  if (succeeded) await rm(FRAME_DIR, { recursive: true, force: true });
}
