// SPDX-License-Identifier: AGPL-3.0-or-later
// CrossTAK — CloudTAK web plugin (UI only; all ingest is server-side, see server/)
// Copyright (C) 2026 TAKWERX
import type { App } from 'vue';
import { h } from 'vue';
import type { PluginAPI, PluginInstance } from '../../plugin.ts';
// CloudTAK's own menu frame (same as its Channels / Data Sync menus): header, theme and
// scrolling match the host. Our old copy drew dark-on-dark in the light theme and did not
// scroll to the end (operator 2026-11-17).
import MenuTemplate from '../../src/components/CloudTAK/util/MenuTemplate.vue';
import CrosstakContainer from './lib/CrosstakContainer.vue';
import IconCrosstakUrl from './lib/Crosstak.svg';
import { useMapStore } from '../../src/stores/map.ts';
import { sendSelf, health } from './lib/crosstak-client.ts';
import { installSendHijack } from './lib/send-hijack.ts';

const MENU_KEY = 'crosstak';
const ROUTE_NAME = 'home-menu-plugin-crosstak';
const SELF_MS = 10_000;           // W11: own position to linked servers, like an ATAK PLI
const LINKS_RECHECK_MS = 60_000;  // how often we re-ask whether this user has any links

const IconCrosstak = {
    render: () => h('img', {
        src: IconCrosstakUrl,
        width: 32,
        height: 32
    })
};

export default class CrosstakPlugin implements PluginInstance {
    api: PluginAPI;
    private selfTimer?: ReturnType<typeof setInterval>;
    private uninstallHijack?: () => void;
    private links: number;
    private linksAt: number;

    constructor(api: PluginAPI) {
        this.api = api;
        this.links = 0;
        this.linksAt = 0;
    }

    // W11: the people on your linked servers see you. Reads the position CloudTAK already
    // shows for you (live GPS or the location you set) and sends it on your own links only.
    private async reportSelf(): Promise<void> {
        if (Date.now() - this.linksAt > LINKS_RECHECK_MS) {
            this.links = (await health()).servers;
            this.linksAt = Date.now();
        }
        if (!this.links) return;
        const map = useMapStore();
        const c = map.gpsCoordinates;
        if (!c || (c.lng === 0 && c.lat === 0)) return;
        await sendSelf({
            longitude: c.lng,
            latitude: c.lat,
            altitude: map.gpsAltitude,
            speed: map.gpsSpeed,
            bearing: map.gpsHeading,
        });
    }

    static async install(
        app: App,
        api: PluginAPI
    ): Promise<PluginInstance> {
        // The route is registered once here and never removed: CloudTAK calls disable()
        // on every page load before enable(), and a menu item whose route is gone fails
        // to add (Dispatcher precedent, cloudtak-plugin-authoring §1).
        api.routes.add({
            path: 'plugin-crosstak',
            name: ROUTE_NAME,
            component: {
                render: () => h(MenuTemplate, { name: 'CrossTAK' }, {
                    default: () => h(CrosstakContainer, { api })
                })
            }
        }, 'home-menu');

        return new CrosstakPlugin(api);
    }

    async enable(): Promise<void> {
        this.api.menu.add({
            key: MENU_KEY,
            label: 'CrossTAK',
            route: ROUTE_NAME,
            tooltip: 'CrossTAK',
            description: 'Show other agencies\' TAK Servers on the CloudTAK map',
            icon: IconCrosstak
        });
        if (!this.uninstallHijack) {
            try {
                // W12b: native Share to a person seen through a link goes out on that link.
                this.uninstallHijack = installSendHijack(useMapStore());
            } catch {
                // map store not ready; enable() runs again on the next page load
            }
        }
        if (!this.selfTimer) {
            this.selfTimer = setInterval(() => {
                this.reportSelf().catch(() => {
                    // best effort; the next tick tries again
                    this.linksAt = 0;
                });
            }, SELF_MS);
        }
    }

    async disable(): Promise<void> {
        if (this.selfTimer) {
            clearInterval(this.selfTimer);
            this.selfTimer = undefined;
        }
        if (this.uninstallHijack) {
            this.uninstallHijack();
            this.uninstallHijack = undefined;
        }
        try {
            this.api.menu.remove(MENU_KEY);
        } catch {
            // menu not loaded yet (load-time disable)
        }
    }
}
