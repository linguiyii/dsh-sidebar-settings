/**
 * Optional end-to-end check against a running DSH Web UI, driven over Chrome
 * DevTools Protocol — proves the button really renders in the real shell and
 * that clicking it opens the settings panel.
 *
 * Prereqs:
 *   1. a DSH web instance is serving a profile that has this plugin installed;
 *   2. Chrome or Edge is started with `--headless=new --remote-debugging-port=<port>`
 *      and the app URL (`http://127.0.0.1:<appPort>/?token=<token>`) as its page.
 *
 * Usage:
 *   node scripts/probe-ui.mjs --cdp 9333 [--shot lib/screenshot.png] [--no-click]
 *
 * Writes `<shot>-sidebar.png` (the footer strip, 2×) before clicking, then
 * `<shot>` (whole window) with the settings panel open.
 *
 * Node 22+ only (global WebSocket).
 */
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : argv[at + 1];
};
const cdpPort = Number(flag("--cdp", "9333"));
const shotPath = flag("--shot", undefined);
const openSettings = !argv.includes("--no-click");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal CDP client over the browser's global WebSocket. */
class Cdp {
  #ws;
  #next = 1;
  #pending = new Map();
  static async attach(wsUrl) {
    const client = new Cdp();
    client.#ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      client.#ws.addEventListener("open", resolve, { once: true });
      client.#ws.addEventListener("error", () => reject(new Error(`cannot open ${wsUrl}`)), { once: true });
    });
    client.#ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const pending = client.#pending.get(message.id);
      if (pending === undefined) return;
      client.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
      else pending.resolve(message.result);
    });
    return client;
  }
  send(method, params = {}) {
    const id = this.#next++;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }
  close() {
    this.#ws.close();
  }
}

async function pageTarget(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await response.json();
  const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl !== undefined);
  if (page === undefined) throw new Error("no debuggable page target — start Chrome with the app URL");
  return page;
}

const target = await pageTarget(cdpPort);
const cdp = await Cdp.attach(target.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
await cdp.send("Page.reload", { ignoreCache: true });
await sleep(800);

/** Evaluate in the page, retrying while the app mounts. */
async function waitFor(expression, describe, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    last = result.result?.value;
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${describe} (last = ${JSON.stringify(last)})`);
}

const found = await waitFor(
  `(() => {
    const button = document.querySelector('.dss-btn');
    if (!button) return null;
    const row = button.closest('.dss-foot-row');
    const footer = row && row.parentElement;
    const settingsRow = footer && footer.querySelector('[aria-haspopup="menu"]')?.closest('div');
    return {
      label: button.getAttribute('aria-label'),
      title: button.getAttribute('title'),
      rail: button.dataset.rail,
      text: (button.textContent || '').trim(),
      footerClass: footer ? footer.className : null,
      buttonY: Math.round(button.getBoundingClientRect().top),
      settingsRowY: settingsRow ? Math.round(settingsRow.getBoundingClientRect().top) : null,
      interactive: button.tagName + (button.disabled ? ' disabled' : ''),
    };
  })()`,
  "the sidebar settings button",
);
console.log("button:", JSON.stringify(found));

/** Screenshot helper: full window, or a clip rectangle at 2× for readable crops. */
async function screenshot(path, clip) {
  const { writeFileSync } = await import("node:fs");
  const params = { format: "png" };
  if (clip !== undefined) Object.assign(params, { clip: { ...clip, scale: 2 } });
  const shot = await cdp.send("Page.captureScreenshot", params);
  writeFileSync(path, Buffer.from(shot.data, "base64"));
  console.log(`screenshot: ${path}`);
}

if (openSettings) {
  console.log(
    "onboarding dismissed:",
    await cdp.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const labels = ['继续', 'Continue'];
        const button = [...document.querySelectorAll('button')].find((b) => labels.includes((b.textContent || '').trim()));
        if (!button) return false;
        button.click();
        return true;
      })()`,
    }).then((r) => r.result?.value),
  );
  await sleep(600);
  if (shotPath !== undefined) {
    const box = await cdp.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const button = document.querySelector('.dss-btn');
        if (!button) return null;
        const rect = button.getBoundingClientRect();
        // The seat wrappers use \`display: contents\` (0×0 boxes), so clip from
        // the button outwards: the row itself plus the settings row below it.
        return { x: 0, y: Math.max(0, Math.round(rect.top) - 16), width: Math.round(rect.right) + 16, height: Math.round(rect.height) + 96 };
      })()`,
    });
    await screenshot(shotPath.replace(/\.png$/, "-sidebar.png"), box.result?.value ?? undefined);
  }

  await cdp.send("Runtime.evaluate", { expression: `document.querySelector('.dss-btn').click()` });
  const opened = await waitFor(
    `(() => {
      // The panel renders its own slot surface; before the click only the
      // sidebar trigger seat exists, so a header/section seat is the signature.
      const header = document.querySelector('[data-slot="settings.header"]');
      const section = document.querySelector('[data-slot="settings.section"]');
      if (header === null && section === null) return null;
      let panel = header ?? section;
      for (let depth = 0; depth < 10 && panel !== null; depth += 1) {
        const rect = panel.getBoundingClientRect();
        if (rect.width > 400 && rect.height > 300 && panel.tagName !== 'BODY' && panel.tagName !== 'HTML') break;
        panel = panel.parentElement;
      }
      const rect = (panel ?? header ?? section).getBoundingClientRect();
      return {
        tag: (panel ?? header ?? section).tagName,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        slots: [...new Set([...document.querySelectorAll('[data-slot^="settings."]')].map((node) => node.dataset.slot))],
      };
    })()`,
    "the settings panel after clicking",
    8000,
  ).catch(() => null);
  await sleep(500);
  if (shotPath !== undefined) await screenshot(shotPath);
  if (opened === null) {
    console.log("settings panel: NOT detected");
    process.exitCode = 1;
  } else {
    console.log(`settings panel: ${JSON.stringify(opened)}`);
    process.exitCode = 0;
  }
}

cdp.close();
