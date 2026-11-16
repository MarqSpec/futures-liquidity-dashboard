#!/usr/bin/env node
// Opt-in NFR-2 measurement against the synthetic feed. Not a CI gate.
//
//   ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS=http://127.0.0.1:5080 \
//     dotnet run --project src/MarqSpec.FuturesLiquidityDashboard.Api --no-launch-profile
//   pnpm --filter dashboard dev --host 127.0.0.1 --port 5173
//   node scripts/measure-frames.mjs
//
// Uses the dashboard's ?perf=1 probe (window.__dashPerf) in headless Chrome. Prints one JSON object.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const api = process.env.API_URL ?? "http://127.0.0.1:5080";
const pageUrl = process.env.PAGE_URL ?? "http://127.0.0.1:5173/?perf=1";
const chromeBin = process.env.CHROME ?? "/opt/google/chrome/chrome";
const streamMs = Number(process.env.STREAM_MS ?? 12000);
const gestureMs = Number(process.env.GESTURE_MS ?? 12000);
const debugPort = Number(process.env.CHROME_PORT ?? 9333);

/** Nearest-rank percentile, matching src/dashboard/src/lib/perfProbe.ts. */
function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? null;
}

function summarize(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  return {
    n: finite.length,
    p50: round(percentile(finite, 50)),
    p95: round(percentile(finite, 95)),
    p99: round(percentile(finite, 99)),
    max: finite.length === 0 ? null : round(Math.max(...finite)),
  };
}

function round(value) {
  return value === null || value === undefined ? null : Math.round(value * 10) / 10;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.next++;
    const result = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify({ id, method, params }));
    return result;
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(JSON.stringify(result.exceptionDetails));
    }
    return result.result?.value;
  }
}

async function waitForOk(url, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.status;
    } catch {
      // The server is still starting.
    }
    await delay(500);
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function measureInstruments() {
  const samples = [];
  let products = 0;
  let levelCounts = [];
  let byteFields = null;
  for (let index = 0; index < 8; index++) {
    const started = performance.now();
    const response = await fetch(`${api}/api/instruments`);
    const body = Buffer.from(await response.arrayBuffer());
    const elapsed = performance.now() - started;
    if (!response.ok) throw new Error(`GET /api/instruments answered ${response.status}`);
    if (index === 0) {
      const rows = JSON.parse(body.toString("utf8"));
      products = rows.length;
      levelCounts = rows.map((row) => (Array.isArray(row.levels) ? row.levels.length : 0));
      const first = rows[0] ?? {};
      byteFields = {
        total: body.length,
        perProduct: Math.round(body.length / Math.max(1, rows.length)),
        levelsShare: share(body, rows, "levels"),
        statusShare: share(body, rows, "status"),
        summaryShare: share(body, rows, "summary"),
        firstKeys: Object.keys(first),
      };
    }
    samples.push({ ms: elapsed, bytes: body.length });
    await delay(150);
  }
  const warm = samples.slice(1);
  return {
    products,
    levelsPerProduct: {
      min: levelCounts.length === 0 ? null : Math.min(...levelCounts),
      max: levelCounts.length === 0 ? null : Math.max(...levelCounts),
    },
    bytes: byteFields,
    payloadBytes: summarize(warm.map((sample) => sample.bytes)),
    latencyMs: summarize(warm.map((sample) => sample.ms)),
  };
}

function share(body, rows, field) {
  const slice = Buffer.byteLength(JSON.stringify(rows.map((row) => row[field] ?? null)));
  return Math.round((1000 * slice) / Math.max(1, body.length)) / 10;
}

function openSocket(url) {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error(`websocket failed: ${url}`)));
  });
}

async function main() {
  const live = await waitForOk(`${api}/health/live`);
  const instruments = await measureInstruments();
  await waitForOk(new URL("/", pageUrl).toString());

  const userData = `/tmp/dash-perf-chrome-${process.pid}`;
  const chrome = spawn(
    chromeBin,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userData}`,
      "--window-size=1600,1000",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  try {
    let version = null;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        version = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then((response) => response.json());
        break;
      } catch {
        await delay(200);
      }
    }
    if (!version?.webSocketDebuggerUrl) throw new Error("Chrome's debugger did not open");

    const browserWs = await openSocket(version.webSocketDebuggerUrl);
    const browser = new Cdp(browserWs);
    const created = await browser.send("Target.createTarget", { url: pageUrl });
    let pageSocket = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
      pageSocket = targets.find((target) => target.id === created.targetId)?.webSocketDebuggerUrl ?? null;
      if (pageSocket) break;
      await delay(200);
    }
    if (!pageSocket) throw new Error("the dashboard target has no debugger socket");

    const pageWs = await openSocket(pageSocket);
    const page = new Cdp(pageWs);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 1600,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const deadline = Date.now() + 90_000;
    let chartReady = false;
    while (Date.now() < deadline) {
      chartReady = await page.evaluate(
        `Boolean(document.querySelector(".pane-overlay-interactive")) && (window.__dashPerf?.frames.length ?? 0) > 8`,
      );
      if (chartReady) break;
      await delay(500);
    }
    if (!chartReady) {
      const text = await page.evaluate(`(document.body && document.body.innerText || "").slice(0, 600)`);
      throw new Error(`the chart did not become ready: ${text}`);
    }

    const streaming = await sample(page, streamMs, false);
    const panZoom = await sample(page, gestureMs, true);
    await page.evaluate(`(() => {
      const button = [...document.querySelectorAll("button")].find((element) => element.textContent.trim() === "1h");
      button?.click();
      for (const name of ["Footprint", "CVD", "RSI", "MACD", "ATR"]) {
        const pane = [...document.querySelectorAll("button")].find(
          (element) => element.textContent.trim() === name && element.getAttribute("aria-pressed") === "false",
        );
        pane?.click();
      }
    })()`);
    await delay(1500);
    const nfr = await sample(page, streamMs, false);
    await page.evaluate(`(() => {
      const button = [...document.querySelectorAll('[role="tab"]')].find((element) => element.textContent.trim() === "Overview");
      button?.click();
    })()`);
    await delay(800);
    const overview = await sample(page, 8000, false);
    const userAgent = await page.evaluate("navigator.userAgent");

    console.log(
      JSON.stringify(
        {
          at: new Date().toISOString(),
          liveStatus: live,
          pageUrl,
          api,
          userAgent,
          viewport: "1600x1000 headless",
          probe: "window.__dashPerf, last 600 frames and draws",
          instruments,
          detailStreaming: { frames: summarize(streaming.frames), draws: summarize(streaming.draws) },
          detailPanZoom: { frames: summarize(panZoom.frames), draws: summarize(panZoom.draws) },
          detail60mLowerPanes: { frames: summarize(nfr.frames), draws: summarize(nfr.draws) },
          overview: { frames: summarize(overview.frames), draws: summarize(overview.draws) },
        },
        null,
        2,
      ),
    );
  } finally {
    chrome.kill("SIGKILL");
  }
}

async function sample(page, durationMs, gesture) {
  await page.evaluate("window.__dashPerf && window.__dashPerf.reset()");
  const started = Date.now();
  if (!gesture) {
    await delay(durationMs);
  } else {
    while (Date.now() - started < durationMs) {
      const box = await page.evaluate(`(() => {
        const canvas = document.querySelector(".pane-overlay-interactive");
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
      if (!box) break;
      await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: -100 });
      await delay(70);
      await page.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: box.x,
        y: box.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await page.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: box.x - 140,
        y: box.y,
        button: "left",
        buttons: 1,
      });
      await page.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: box.x - 140,
        y: box.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      await delay(70);
      await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: 100 });
      await delay(70);
    }
  }
  return page.evaluate(`(() => {
    const probe = window.__dashPerf;
    return { frames: probe ? probe.frames.slice() : [], draws: probe ? probe.draws.slice() : [] };
  })()`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
