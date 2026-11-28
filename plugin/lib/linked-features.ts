// Which map features came from one linked server. No imports on purpose: test/clear-on-disable.test.mjs
// loads this file on its own.
//
// Every feature the route file pushes carries `metadata.crosstak.server` (the link id) and an id of
// the form `crosstak:<link id>:<uid>`. Either one marks it as that link's.

export function isFromLink(feat: { id?: unknown; properties?: unknown }, serverId: number): boolean {
    const props = (feat.properties || {}) as { metadata?: { crosstak?: { server?: unknown } } };
    const server = props.metadata?.crosstak?.server;
    if (typeof server === 'number') return server === serverId;
    return typeof feat.id === 'string' && feat.id.startsWith(`crosstak:${serverId}:`);
}
