// SPDX-License-Identifier: AGPL-3.0-or-later
// CrossTAK runtime bundle: stands in for CloudTAK's `src/stores/map.ts`.
// The pane and the feed list call useMapStore() the way the compiled-in plugin does.
import { findStore, MAP_STORE_ID } from './host.ts';

export class MapStoreMissing extends Error {
    constructor() {
        super('CrossTAK cannot reach the CloudTAK map on this version of CloudTAK. '
            + 'Ask your CloudTAK admin to update CrossTAK.');
    }
}

// The real store when it is there; a stand-in whose every use says why it cannot work.
export function useMapStore(): Record<string, unknown> {
    const store = findStore(MAP_STORE_ID);
    if (store) return store;
    return new Proxy({}, {
        get() {
            throw new MapStoreMissing();
        },
    });
}

export function hasMapStore(): boolean {
    return !!findStore(MAP_STORE_ID);
}
