// SPDX-License-Identifier: AGPL-3.0-or-later
// CrossTAK runtime bundle: what the bundle can reach on the host.
//
// A runtime plugin gets `vue`, `vue-router` and `@tak-ps/vue-tabler` from the host and the
// PluginAPI object. It cannot import CloudTAK's own modules (std, the map store, the menu frame),
// so the bundle build swaps those imports for the shims in this folder.
//
// The stores are found through the Pinia instance the PluginAPI carries. That reads
// `pinia._s`, an internal of Pinia (its own getStores() helper does the same). If a later
// CloudTAK renames a store, findStore() returns undefined and the pane says so.
import type { PluginAPI } from '../../../plugin.ts';

export const MAP_STORE_ID = 'cloudtak';
export const APP_STORE_ID = 'cloudtak-app';

let current: PluginAPI | undefined;

export function setApi(api: PluginAPI): void {
    current = api;
}

export function getApi(): PluginAPI | undefined {
    return current;
}

export function findStore(id: string): Record<string, unknown> | undefined {
    const pinia = current?.pinia as unknown as { _s?: Map<string, unknown> } | undefined;
    const store = pinia?._s?.get(id);
    return store ? store as Record<string, unknown> : undefined;
}
