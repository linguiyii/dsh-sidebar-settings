/**
 * Contract check for the built bundle — runs in Node, no Electron needed.
 *
 * It evaluates `lib/client.js` in a VM whose globals mimic the DSH shell
 * (`window.__ModuleLoader__`, a document whose <style> tags the loader claims),
 * materializes the factory with a stub platform module table, then applies the
 * returned cordis plugin against stub `slots` / `document` fakes and exercises
 * every way the footer button can reach the settings panel:
 *
 *   1. the shell exposes a settings store on `sidebar.settings` (current shells),
 *   2. the shell renders a plain gear trigger (older shells),
 *   3. the shell renders the account menu instead,
 *   4. nothing at all (must stay a no-op, never throw).
 *
 * Usage: node scripts/verify.mjs
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const bundle = await readFile(join(root, "lib", "client.js"), "utf8");

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};

// ---- fake DOM ----
const styles = [];
const clicks = [];
const menuItems = [{ textContent: "设置", click: () => clicks.push("menu-item") }];
const document = {
  documentElement: { lang: "zh" },
  /** The sidebar settings row currently rendered, or null when the shell has none. */
  settingsRow: null,
  createElement(tag) {
    const el = { tag, textContent: "", dataset: {} };
    if (tag === "style") styles.push(el);
    return el;
  },
  head: { appendChild() {} },
  querySelector(selector) {
    return selector === '[data-slot="sidebar.settings"]' ? this.settingsRow : null;
  },
  querySelectorAll(selector) {
    return selector === '[role="menuitem"]' ? menuItems : [];
  },
};

let registration;
const sandbox = {
  window: { __ModuleLoader__: { load(reg) { registration = reg; } } },
  document,
  Symbol,
  Object,
  console,
  setTimeout,
};
sandbox.globalThis = sandbox;
vm.runInNewContext(bundle, sandbox, { filename: "lib/client.js" });

// ---- platform module table ----
const React = {
  createElement(type, props, ...children) {
    const resolved = children.length === 1 ? children[0] : children;
    return { type, props: { ...(props ?? {}), children: children.length === 0 ? props?.children : resolved } };
  },
};
const seed = new Map([["react", React]]);
const moduleRequire = (spec) => {
  if (seed.has(spec)) return seed.get(spec);
  throw new Error(`client-modules: require("${spec}") missed the module table`);
};

check(registration !== undefined, "bundle registers with window.__ModuleLoader__.load at eval time");
check(registration?.id === "dsh-sidebar-settings", `registration id = package name (got ${registration?.id})`);
const mod = registration.factory(moduleRequire);
check(styles.length === 1 && styles[0].dataset.plugin === "dsh-sidebar-settings", "factory body injects one claimed <style>");
check(typeof mod?.apply === "function", "factory returns exports.apply");
check(Array.isArray(mod?.inject) && mod.inject.includes("slots"), `exports.inject includes "slots" (got ${JSON.stringify(mod?.inject)})`);

// ---- mount helper: every scenario applies the plugin against a fresh stub ----
const mount = (settingsEntries) => {
  const registrations = [];
  const slots = {
    injected: null,
    entries: (name) => (name === "sidebar.settings" ? settingsEntries : []),
    inject(name, fn) { this.injected = name; fn(); },
    register(spec, component) { registrations.push({ spec, component }); return () => {}; },
  };
  mod.apply({ slots });
  return { slots, registrations };
};

const clickFooterButton = (registrations) => {
  const component = registrations.at(-1).component;
  component({ wide: true }).props.children.props.onClick();
};

// ---- 1. shell store on the slot entry (current shells) ----
const opened = [];
const storeEntry = { component: () => null, options: {}, store: { create: () => ({ actions: { open: () => opened.push("open") } }) } };
const happy = mount([storeEntry]);
check(happy.slots.injected === "sidebar.footer.action", `apply injects the "sidebar.footer.action" seat (got ${happy.slots.injected})`);
check(happy.registrations[0]?.spec?.name === "sidebar.footer.action" && happy.registrations[0].spec.id === "sidebar-settings", `registered ${JSON.stringify(happy.registrations[0]?.spec)}`);

const wide = happy.registrations[0].component({ wide: true });
const label = wide.props.children.props.children[1];
check(label?.props?.children === "设置", `wide button renders the 设置 label (got ${JSON.stringify(label?.props?.children)})`);
clickFooterButton(happy.registrations);
check(opened.length === 1, "click opens settings through the shell store's actions.open()");

const rail = happy.registrations[0].component({ wide: false });
check(rail.props.children.props["data-rail"] === "true", "collapsed sidebar renders the icon-rail variant");

// ---- 2. older shells: a plain gear trigger inside the settings row ----
const gearButton = { click: () => clicks.push("gear") };
document.settingsRow = {
  querySelector(selector) {
    if (selector === '[data-slot="settings.trigger"]') return { closest: () => gearButton };
    return null;
  },
};
clicks.length = 0;
clickFooterButton(mount([]).registrations);
check(clicks.includes("gear") && !clicks.includes("menu-item"), "gearshell fallback clicks the sidebar's own settings trigger");

// ---- 3. account-menu shells: no settings trigger, a menu trigger instead ----
const menuTrigger = { click: () => clicks.push("menu-trigger") };
document.settingsRow = {
  querySelector(selector) {
    if (selector === 'button[aria-haspopup="menu"]') return menuTrigger;
    return null;
  },
};
clicks.length = 0;
clickFooterButton(mount([]).registrations);
check(clicks.includes("menu-trigger"), "account-menu shell opens the menu");
await new Promise((resolve) => setTimeout(resolve, 150));
check(clicks.includes("menu-item"), "account-menu shell activates the 设置 item");

// ---- 4. no settings row at all: a click must stay a no-op ----
document.settingsRow = null;
clicks.length = 0;
let threw = null;
try {
  clickFooterButton(mount([]).registrations);
} catch (error) {
  threw = error;
}
check(threw === null && clicks.length === 0, "click without any settings row is a silent no-op");

if (failures.length > 0) {
  console.error(`\n${failures.length} contract check(s) failed`);
  process.exit(1);
}
console.log("\nOK: bundle contract verified");
