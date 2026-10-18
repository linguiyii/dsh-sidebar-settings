#!/usr/bin/env node
/**
 * Install this repository into a DSH profile as a local plugin.
 *
 * What it does (and nothing else):
 *   1. links the repository into `<profile>/node_modules/<name>` (junction on
 *      Windows, symlink elsewhere), so a rebuild is live without reinstalling;
 *   2. records the same link in `<profile>/package.json` `dependencies`;
 *   3. adds `<name>` to `dsh.profile.bundles`, the list of profile layers the
 *      host loader loads at startup.
 *
 * A profile the desktop app owns is outside this repository, so the first run
 * needs permission to write there. Every written file is backed up once as
 * `<file>.dsh-sidebar-settings.bak` and `--uninstall` removes all three edits.
 *
 * Usage:
 *   node scripts/install-desktop.mjs [--profile desktop] [--dry-run]
 *   node scripts/install-desktop.mjs --uninstall [--profile desktop]
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const name = manifest.name;

const argv = process.argv.slice(2);
const uninstall = argv.includes("--uninstall");
const dryRun = argv.includes("--dry-run");
const profileFlag = argv.indexOf("--profile");
const profile = profileFlag === -1 ? "desktop" : argv[profileFlag + 1];
if (profile === undefined) {
  console.error("--profile needs a value");
  process.exit(2);
}

const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
const profileDir = join(dshHome, "profiles", profile);
const profileManifestPath = join(profileDir, "package.json");
const linkPath = join(profileDir, "node_modules", name);
const backupSuffix = ".dsh-sidebar-settings.bak";

if (!existsSync(profileManifestPath)) {
  console.error(`no DSH profile at ${profileDir} (set DSH_HOME if your profile lives elsewhere)`);
  process.exit(1);
}

const profileManifest = JSON.parse(readFileSync(profileManifestPath, "utf8"));
const dependencies = profileManifest.dependencies ?? {};
const profileConfig = (profileManifest.dsh ??= {});
profileConfig.profile ??= {};
const bundles = (profileConfig.profile.bundles ??= []);

/**
 * Classify `linkPath` without trusting reparse tags: on Windows a junction is
 * *not* a symlink to Node (`lstatSync().isSymbolicLink()` is false,
 * `readlinkSync` throws EINVAL and `rmSync` throws EISDIR). A junction and a
 * directory symlink to this repository are both the same directory as `repo`,
 * so compare directory identity (`dev`/`ino`) for those.
 * @returns {"missing" | "ours" | "foreign"}
 */
function linkState() {
  const stat = lstatSync(linkPath, { throwIfNoEntry: false });
  if (stat === undefined) return "missing";
  if (stat.isSymbolicLink()) {
    try {
      return resolve(dirname(linkPath), readlinkSync(linkPath)) === repo ? "ours" : "foreign";
    } catch {
      return "foreign";
    }
  }
  if (stat.isDirectory()) {
    try {
      const target = statSync(repo);
      return stat.dev === target.dev && stat.ino === target.ino ? "ours" : "foreign";
    } catch {
      return "foreign";
    }
  }
  return "foreign";
}

/** Remove our own link: `unlink` for symlinks, `rmdir` for junctions (never their target). */
function dropLink() {
  if (lstatSync(linkPath, { throwIfNoEntry: false }) === undefined) return;
  try {
    unlinkSync(linkPath);
  } catch {
    rmdirSync(linkPath);
  }
}

/** @returns {boolean} whether a filesystem change was (or would be) made. */
function setLink() {
  const state = linkState();
  if (state === "ours") {
    console.log(`ok    ${linkPath} -> ${repo}`);
    return false;
  }
  if (state === "foreign") {
    console.error(`refusing to replace ${linkPath}: it exists and is not a link to this repository`);
    process.exit(1);
  }
  console.log(`link  ${linkPath} -> ${repo}`);
  if (!dryRun) {
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(repo, linkPath, process.platform === "win32" ? "junction" : "dir");
  }
  return true;
}

/**
 * `--uninstall` counterpart of setLink: removes the link when it points at this
 * repository, never creates one. Missing links are skipped (`ok`), a foreign
 * link or a real directory is left alone so we only undo our own edits.
 * @returns {boolean} whether a filesystem change was (or would be) made.
 */
function removeLink() {
  const state = linkState();
  if (state === "missing") {
    console.log(`ok    ${linkPath} (no link to remove)`);
    return false;
  }
  if (state === "foreign") {
    console.log(`skip  ${linkPath} (not a link to this repository)`);
    return false;
  }
  console.log(`del   ${linkPath}`);
  if (!dryRun) dropLink();
  return true;
}

let changed = uninstall ? removeLink() : setLink();

// 2) profile dependency entry, so `dsh plugin` keeps treating it as profile-owned
const spec = `link:${repo.replaceAll("\\", "/")}`;
if (uninstall) {
  // Uninstall has to win over the "already equal" shortcut, otherwise the exact
  // entry this script wrote can never be removed again.
  if (name in dependencies) {
    console.log(`del   dependencies["${name}"]`);
    delete dependencies[name];
    changed = true;
  } else {
    console.log(`ok    dependencies["${name}"] (not set)`);
  }
} else if (dependencies[name] === spec) {
  console.log(`ok    dependencies["${name}"]`);
} else {
  console.log(`set   dependencies["${name}"] = "${spec}"`);
  dependencies[name] = spec;
  changed = true;
}
profileManifest.dependencies = dependencies;

// 3) the bundle layer that makes the host loader load it at startup
if (uninstall) {
  const at = bundles.indexOf(name);
  if (at !== -1) {
    console.log(`del   dsh.profile.bundles["${name}"]`);
    bundles.splice(at, 1);
    changed = true;
  } else {
    console.log("ok    not listed in dsh.profile.bundles");
  }
} else if (bundles.includes(name)) {
  console.log("ok    listed in dsh.profile.bundles");
} else {
  console.log(`set   dsh.profile.bundles += "${name}"`);
  bundles.push(name);
  changed = true;
}

if (changed) {
  const backup = profileManifestPath + backupSuffix;
  if (!existsSync(backup)) {
    console.log(`save  ${backup}`);
    if (!dryRun) writeFileSync(backup, readFileSync(profileManifestPath));
  }
  if (dryRun) {
    console.log("\n--dry-run: profile manifest left untouched, showing the result below\n");
    console.log(JSON.stringify(profileManifest, null, 2));
  } else {
    writeFileSync(profileManifestPath, `${JSON.stringify(profileManifest, null, 2)}\n`);
    console.log(`wrote ${profileManifestPath}`);
  }
} else {
  console.log("\nprofile already up to date");
}

if (uninstall) {
  console.log("\nuninstalled — restart DeepSeek Harness to drop the plugin from the running host");
} else {
  console.log("\nnext: restart DeepSeek Harness (or use its restart action) so the host loads the plugin");
}
