// SPDX-License-Identifier: AGPL-3.0-or-later
// CrossTAK — CloudTAK runtime plugin (CloudTAK 14.2+): the web half as one bundle.
// Copyright (C) 2026 TAKWERX
//
// Same panes as plugin/index.ts, loaded by CloudTAK at runtime from an uploaded bundle
// (manifest.json + index.js) instead of compiled into the web build. See bundle/README.md.
//
// Differences from the compiled-in plugin, each on purpose:
//  - own menu key and own route name, never the compiled-in ones;
//  - if the compiled-in CrossTAK is installed (the Marketplace source install), this does nothing,
//    so the menu shows CrossTAK once;
//  - it asks the server part for its version first and says so when the two do not match;
//  - host modules (std, map store, menu frame) come from bundle/shims.
import type { App } from 'vue';
import { h, markRaw, defineComponent, ref, onMounted } from 'vue';
import type { PluginAPI, PluginInstance } from '../../plugin.ts';
import { IconAccessPoint } from '@tabler/icons-vue';
import MenuTemplate from './shims/MenuTemplate.vue';
import { setApi } from './shims/host.ts';
import { useMapStore, hasMapStore } from './shims/map-store.ts';
import { routeCompat } from './compat.ts';
import type { Compat } from './compat.ts';
import CrosstakContainer from '@crosstak/lib/CrosstakContainer.vue';
import { sendSelf, health } from '@crosstak/lib/crosstak-client.ts';
import { installSendHijack } from '@crosstak/lib/send-hijack.ts';

declare const __BUNDLE_VERSION__: string;

export const MENU_KEY = 'crosstak-runtime';
export const ROUTE_NAME = 'home-menu-plugin-crosstak-runtime';
const COMPILED_IN_ROUTE = 'home-menu-plugin-crosstak';
const SELF_MS = 10_000;
const LINKS_RECHECK_MS = 60_000;

type MenuIcon = NonNullable<Parameters<PluginAPI['menu']['add']>[0]['icon']>;
const IconCrosstak = markRaw(IconAccessPoint) as unknown as MenuIcon;

const compat = ref<Compat | null>(null);

async function probe(): Promise<Compat> {
    try {
        const res = await health();
        compat.value = routeCompat(res.version, __BUNDLE_VERSION__);
    } catch (err) {
        const status = (err as { status?: number }).status;
        // A missing route is a real mismatch. A timeout or a 401 is not: try again on the next visit.
        compat.value = status === 404 ? routeCompat(undefined, __BUNDLE_VERSION__) : { ok: true, message: '' };
    }
    if (compat.value.ok && !hasMapStore()) {
        compat.value = {
            ok: false,
            message: 'CrossTAK cannot reach the CloudTAK map on this version of CloudTAK. '
                + 'Ask your CloudTAK admin to update CrossTAK.',
        };
    }
    return compat.value;
}

function makePage(api: PluginAPI) {
    return defineComponent({
        setup() {
            onMounted(() => { void probe(); });
            return () => h(MenuTemplate, { name: 'CrossTAK' }, {
                default: () => {
                    if (compat.value && !compat.value.ok) {
                        return h('div', { class: 'alert alert-warning my-2', 'data-test': 'crosstak-compat' }, compat.value.message);
                    }
                    return h(CrosstakContainer, { api });
                }
            });
        }
    });
}

class CompiledInPresent implements PluginInstance {
    async enable(): Promise<void> { /* the compiled-in CrossTAK is the one in use */ }
    async disable(): Promise<void> { /* nothing was added */ }
}

class CrosstakRuntimePlugin implements PluginInstance {
    api: PluginAPI;
    private selfTimer?: ReturnType<typeof setInterval>;
    private uninstallHijack?: () => void;
    private links = 0;
    private linksAt = 0;

    constructor(api: PluginAPI) {
        this.api = api;
    }

    private async reportSelf(): Promise<void> {
        if (Date.now() - this.linksAt > LINKS_RECHECK_MS) {
            this.links = (await health()).servers;
            this.linksAt = Date.now();
        }
        if (!this.links) return;
        const map = useMapStore() as { gpsCoordinates?: { lng: number; lat: number } | null; gpsAltitude?: number | null; gpsSpeed?: number | null; gpsHeading?: number | null };
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

    async enable(): Promise<void> {
        this.api.menu.add({
            key: MENU_KEY,
            label: 'CrossTAK',
            route: ROUTE_NAME,
            tooltip: 'CrossTAK',
            description: 'Show other agencies\' TAK Servers on the CloudTAK map',
            icon: IconCrosstak
        });
        const ok = (await probe()).ok;
        if (!ok) return;   // the page shows why; no position reports, no Share changes
        if (!this.uninstallHijack) {
            try {
                this.uninstallHijack = installSendHijack(useMapStore());
            } catch {
                // map store not ready; enable() runs again on the next page load
            }
        }
        if (!this.selfTimer) {
            this.selfTimer = setInterval(() => {
                this.reportSelf().catch(() => { this.linksAt = 0; });
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
            // menu not loaded yet
        }
    }
}

export default class CrosstakRuntime {
    static async install(app: App, api: PluginAPI): Promise<PluginInstance> {
        void app;
        // The Marketplace source install of CrossTAK is already in this CloudTAK: use that one.
        if (api.router.hasRoute(COMPILED_IN_ROUTE)) {
            console.info('CrossTAK bundle: the compiled-in CrossTAK is installed, the bundle stays idle');
            return new CompiledInPresent();
        }
        setApi(api);
        api.routes.add({
            path: 'plugin-crosstak-runtime',
            name: ROUTE_NAME,
            component: makePage(api)
        }, 'home-menu');
        return new CrosstakRuntimePlugin(api);
    }
}
