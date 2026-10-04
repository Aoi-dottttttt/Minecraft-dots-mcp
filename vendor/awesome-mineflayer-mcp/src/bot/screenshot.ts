/**
 * Real first-person screenshots of what the bot actually sees.
 *
 * Pipeline: prismarine-viewer's web server renders the ACTUAL textured world
 * (client-side WebGL, streamed from bot.world), and a headless browser
 * (Playwright driving system Chrome/Edge — no native build) screenshots the
 * first-person canvas. Both packages are OPTIONAL (lazy-loaded); when absent the
 * tool returns a clear UNSUPPORTED error with install guidance, and the rest of
 * the server is unaffected.
 */

import net from "node:net";
import type { Bot } from "mineflayer";
import { ToolError } from "../util/errors.js";
import { SCREENSHOT_BROWSER_CHANNEL, SCREENSHOT_EXECUTABLE_PATH } from "../config.js";

type AnyObj = Record<string, any>;

interface ViewerState {
  bot: Bot;
  port: number;
  firstPerson: boolean;
  viewDistance: number;
  close: () => void;
  onEnd: () => void;
}

let viewer: ViewerState | null = null;
let browser: AnyObj | null = null;
let page: AnyObj | null = null;
let pageUrl = "";
let captureQueue: Promise<unknown> = Promise.resolve();
let stdoutProtected = false;

/** prismarine-viewer logs via console.log; stdout is the MCP channel. Route to stderr (once). */
function protectStdout(): void {
  if (stdoutProtected) return;
  stdoutProtected = true;
  const toErr = (...a: unknown[]): void => {
    process.stderr.write(a.map(String).join(" ") + "\n");
  };
  console.log = toErr;
  console.info = toErr;
  console.debug = toErr;
}

// Dynamic (non-literal) specifiers so tsc/bundlers don't hard-require these
// optional packages at build time.
async function loadViewer(): Promise<(bot: Bot, opts: AnyObj) => void> {
  const name = "prismarine-viewer";
  let mod: AnyObj;
  try {
    mod = (await import(name)) as AnyObj;
  } catch {
    throw new ToolError(
      "UNSUPPORTED",
      "Screenshots need the optional 'prismarine-viewer' package, which isn't installed.",
      ["Install the screenshot extras: npm install prismarine-viewer playwright-core (see README → Vision)."],
    );
  }
  const mineflayer = mod.mineflayer ?? mod.default?.mineflayer;
  if (typeof mineflayer !== "function") {
    throw new ToolError("UNSUPPORTED", "prismarine-viewer is installed but has no 'mineflayer' export.");
  }
  return mineflayer;
}

async function loadChromium(): Promise<AnyObj> {
  const name = "playwright-core";
  try {
    const mod = (await import(name)) as AnyObj;
    return mod.chromium ?? mod.default?.chromium;
  } catch {
    throw new ToolError(
      "UNSUPPORTED",
      "Screenshots need the optional 'playwright-core' package, which isn't installed.",
      [
        "Install it: npm install playwright-core.",
        "Then ensure a browser is available: have Chrome/Edge installed, or run `npx playwright install chromium`.",
      ],
    );
  }
}

function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Resolve once the viewer port accepts a TCP connection (or throw after timeoutMs). */
function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const attempt = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", reject);
    });
  const loop = async (): Promise<void> => {
    for (;;) {
      try {
        await attempt();
        return;
      } catch {
        if (Date.now() >= deadline) {
          throw new ToolError("INTERNAL", "The viewer server did not start listening. Try get_screenshot again.");
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  };
  return loop();
}

async function launchBrowser(chromium: AnyObj): Promise<AnyObj> {
  const args = [
    "--no-sandbox",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
  ];
  const attempts: AnyObj[] = [];
  if (SCREENSHOT_EXECUTABLE_PATH) {
    attempts.push({ executablePath: SCREENSHOT_EXECUTABLE_PATH });
  } else if (SCREENSHOT_BROWSER_CHANNEL) {
    attempts.push({ channel: SCREENSHOT_BROWSER_CHANNEL });
  } else {
    attempts.push({ channel: "chrome" }, { channel: "msedge" }, {}); // system Chrome/Edge, then bundled chromium
  }
  let lastErr: unknown;
  for (const opt of attempts) {
    try {
      return await chromium.launch({ headless: true, args, ...opt });
    } catch (e) {
      lastErr = e;
    }
  }
  throw new ToolError("UNSUPPORTED", "Could not launch a browser for screenshots.", [
    "Install Google Chrome or Microsoft Edge, or run `npx playwright install chromium`.",
    "Or set MCP_SCREENSHOT_EXECUTABLE_PATH / MCP_SCREENSHOT_BROWSER_CHANNEL.",
    `Last launch error: ${String((lastErr as Error)?.message ?? lastErr)}`,
  ]);
}

function closeViewer(): void {
  if (!viewer) return;
  try {
    viewer.close();
  } catch {
    /* ignore */
  }
  try {
    (viewer.bot as AnyObj).removeListener?.("end", viewer.onEnd);
  } catch {
    /* ignore */
  }
  viewer = null;
}

/** Start (or reuse) a viewer server for this bot + render settings; returns its port. */
async function ensureViewer(bot: Bot, firstPerson: boolean, viewDistance: number): Promise<number> {
  if (
    viewer &&
    viewer.bot === bot &&
    viewer.firstPerson === firstPerson &&
    viewer.viewDistance === viewDistance
  ) {
    return viewer.port;
  }
  closeViewer(); // bot or settings changed — drop the old server + its listener

  const mineflayer = await loadViewer();
  protectStdout();
  const port = await freePort();
  try {
    mineflayer(bot, { viewDistance, firstPerson, port });
  } catch (e) {
    throw new ToolError("INTERNAL", `Failed to start the viewer: ${String((e as Error)?.message ?? e)}`);
  }
  const close = ((bot as AnyObj).viewer?.close as (() => void) | undefined) ?? ((): void => {});
  const onEnd = (): void => {
    if (viewer?.bot === bot) closeViewer();
  };
  try {
    (bot as AnyObj).once?.("end", onEnd);
  } catch {
    /* ignore */
  }
  viewer = { bot, port, firstPerson, viewDistance, close, onEnd };
  try {
    await waitForPort(port, 4000);
  } catch (e) {
    closeViewer(); // never became ready (e.g. port race) — drop it so the next call retries fresh
    throw e;
  }
  return port;
}

export interface ScreenshotOptions {
  width: number;
  height: number;
  firstPerson: boolean;
  waitMs: number;
  viewDistance: number;
}

/** Capture a PNG of the bot's view. Serialized; throws ToolError on missing deps/browser. */
export function captureScreenshot(bot: Bot, opts: ScreenshotOptions): Promise<Buffer> {
  // Serialize captures so concurrent calls can't interleave on the shared page.
  const run = captureQueue.then(() => doCapture(bot, opts));
  captureQueue = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function doCapture(bot: Bot, opts: ScreenshotOptions): Promise<Buffer> {
  // Acquire the browser FIRST so a missing dep / unlaunchable browser never
  // leaves an orphaned viewer server running.
  const chromium = await loadChromium();
  if (browser && browser.isConnected && !browser.isConnected()) {
    browser = null;
    page = null;
    pageUrl = "";
  }
  if (!browser) {
    browser = await launchBrowser(chromium);
    page = null;
    pageUrl = "";
  }
  if (page && page.isClosed && page.isClosed()) {
    page = null;
    pageUrl = "";
  }
  if (!page) {
    page = await browser.newPage();
    pageUrl = "";
  }
  const pg = page as AnyObj;

  const port = await ensureViewer(bot, opts.firstPerson, opts.viewDistance);
  const url = `http://127.0.0.1:${port}/`;
  try {
    await pg.setViewportSize({ width: opts.width, height: opts.height });
    if (pageUrl !== url) {
      await pg.goto(url, { waitUntil: "domcontentloaded" });
      pageUrl = url;
    } else {
      await pg.reload({ waitUntil: "domcontentloaded" });
    }
    // Force a look/position emit so the first-person camera matches the bot's
    // actual yaw/pitch even if the bot is standing still.
    try {
      await bot.look(bot.entity.yaw, bot.entity.pitch, true);
    } catch {
      /* best-effort */
    }
    await pg.waitForTimeout(opts.waitMs);
    return (await pg.screenshot({ type: "png" })) as Buffer;
  } catch (e) {
    // Reset the page (and the browser on a target/connection death) so the next
    // call rebuilds cleanly instead of reusing a poisoned handle forever.
    try {
      await pg.close();
    } catch {
      /* ignore */
    }
    page = null;
    pageUrl = "";
    const msg = String((e as Error)?.message ?? e);
    if (/target closed|browser has been closed|disconnected|crash|websocket/i.test(msg)) {
      try {
        await browser?.close();
      } catch {
        /* ignore */
      }
      browser = null;
    }
    if (e instanceof ToolError) throw e;
    throw new ToolError("INTERNAL", `Screenshot failed: ${msg}`);
  }
}

/** Release the browser + viewer server (called on shutdown). */
export async function disposeScreenshot(): Promise<void> {
  try {
    if (page) await page.close();
  } catch {
    /* ignore */
  }
  try {
    if (browser) await browser.close();
  } catch {
    /* ignore */
  }
  closeViewer();
  page = null;
  browser = null;
  pageUrl = "";
}
