// SPDX-License-Identifier: AGPL-3.0-or-later
// CrossTAK runtime bundle: does the CrossTAK server part on this CloudTAK match this bundle?
// No imports on purpose: test/bundle.test.mjs loads this file on its own.
//
// The bundle (browser half) and the route file (server half) ship as one version. A bundle that
// meets an older or newer route file calls routes that are not there. So the bundle asks
// GET /api/crosstak/health first and says so in plain words instead of showing a broken page.

export interface Compat {
    ok: boolean;
    message: string;
}

// "0.6.1" and "0.6.0" are the same family; "0.7.0" is not. Patch releases never change a route.
export function majorMinor(version: unknown): string | null {
    if (typeof version !== 'string') return null;
    const m = /^(\d+)\.(\d+)\.\d+/.exec(version.trim());
    return m ? `${m[1]}.${m[2]}` : null;
}

export function routeCompat(routeVersion: unknown, bundleVersion: string): Compat {
    if (routeVersion === undefined || routeVersion === null) {
        return {
            ok: false,
            message: 'CrossTAK is not fully installed on this CloudTAK: its server part is missing. '
                + 'Ask your CloudTAK admin to install CrossTAK from the TAK Portal Marketplace.',
        };
    }
    const route = majorMinor(routeVersion);
    const mine = majorMinor(bundleVersion);
    if (!route || !mine || route !== mine) {
        return {
            ok: false,
            message: `This CrossTAK app is version ${bundleVersion}, but the CrossTAK server part on this CloudTAK `
                + `is version ${String(routeVersion)}. Ask your CloudTAK admin to update CrossTAK so both match.`,
        };
    }
    return { ok: true, message: '' };
}
