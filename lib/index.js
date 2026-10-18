/**
 * Host half of `dsh-sidebar-settings`.
 *
 * This plugin is purely a web-client surface (it only adds a button to the
 * sidebar footer), but a DSH plugin still needs a host-side loader row: the
 * client module system ships the browser half of every `dsh.client` package
 * whose host row is mounted. Keeping `apply` empty makes that explicit — the
 * host process does nothing, the browser bundle does the work.
 */

/** Display name used by the loader for this row. */
export const name = "dsh-sidebar-settings";

/** No host-side services are required. */
export const inject = [];

/** The browser half is discovered through `dsh.client` in package.json. */
export function apply() {}
