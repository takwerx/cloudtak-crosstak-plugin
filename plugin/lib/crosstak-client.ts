// SPDX-License-Identifier: AGPL-3.0-or-later
// CrossTAK — typed client for the plugin's own routes (/api/crosstak/*).
//
// Routed through CloudTAK's std() helper so every request carries the user's Bearer token
// and errors surface as Error(message) from the API's {status, message} body. The relative
// import is the Dispatcher pattern; it resolves once this directory is copied into
// app/plugins/crosstak/ (upstream has no authenticated-fetch accessor yet — PLAN W9).
import { std } from '../../../src/std.ts';

const BASE = '/api/crosstak';

export interface CertSummary {
    subject: string;
    issuer: string;
    valid_to: string;
    channels: boolean;
}

export interface StreamStatus {
    connected: boolean;
    verified: boolean;
    since: string | null;
    last_cot: string | null;
    cots: number;
    error: string | null;
    rejected: boolean;
}

export interface LinkedServer {
    id: number;
    name: string;
    url: string;
    api: string | null;
    webtak: string | null;
    expected_name: string | null;
    enabled: boolean;
    created: string;
    updated: string;
    created_by: string | null;
    enrolled_by: string | null;
    enrolled_at: string | null;
    owner: string | null;
    has_auth: boolean;
    cert: CertSummary | null;
    ca: CertSummary[];
    status: StreamStatus;
}

export interface LinkedServerInput {
    name?: string;
    url?: string;
    api?: string | null;
    webtak?: string | null;
    expected_name?: string | null;
    ca?: string;
    cert?: string;
    key?: string;
    enabled?: boolean;
}

export interface LinkInput {
    host: string;
    username: string;
    password: string;
    name?: string;
    expected_name?: string | null;
    ca?: string | null;
}

export interface Channel {
    name: string;
    description: string | null;
    active: boolean;
    in: boolean;
    out: boolean;
}

export interface ChannelList {
    items: Channel[];
    can_switch: boolean;
}

export async function listServers(): Promise<LinkedServer[]> {
    const res = await std(`${BASE}/server`) as { total: number; items: LinkedServer[] };
    return res.items;
}

export async function linkServer(body: LinkInput): Promise<LinkedServer> {
    return await std(`${BASE}/link`, { method: 'POST', body, timeout: 60_000 }) as LinkedServer;
}

export async function createServer(body: LinkedServerInput): Promise<LinkedServer> {
    return await std(`${BASE}/server`, { method: 'POST', body }) as LinkedServer;
}

export async function patchServer(id: number, body: LinkedServerInput): Promise<LinkedServer> {
    return await std(`${BASE}/server/${id}`, { method: 'PATCH', body }) as LinkedServer;
}

export async function deleteServer(id: number): Promise<void> {
    await std(`${BASE}/server/${id}`, { method: 'DELETE' });
}

export async function enrollServer(id: number, username: string, password: string): Promise<LinkedServer> {
    return await std(`${BASE}/server/${id}/enroll`, { method: 'POST', body: { username, password }, timeout: 60_000 }) as LinkedServer;
}

export async function listChannels(id: number): Promise<ChannelList> {
    return await std(`${BASE}/server/${id}/channel`) as ChannelList;
}

export async function setChannels(id: number, active: string[]): Promise<ChannelList> {
    return await std(`${BASE}/server/${id}/channel`, { method: 'PUT', body: { active } }) as ChannelList;
}

export interface Contact {
    uid: string;
    callsign: string;
    team: string;
    role: string;
    self: boolean;
}

// W12: a person (uids), every member of a team, or a Data Sync feed (mission). No broadcast.
export interface SendTarget {
    uids?: string[];
    team?: string;
    mission?: string;
}

export async function listContacts(id: number): Promise<{ self_uid: string; items: Contact[] }> {
    return await std(`${BASE}/server/${id}/contact`) as { self_uid: string; items: Contact[] };
}

export async function sendFeature(server_id: number, feature: unknown, to: SendTarget): Promise<{ status: number; message: string; uid: string }> {
    return await std(`${BASE}/send`, { method: 'POST', body: { server_id, feature, to } }) as { status: number; message: string; uid: string };
}

// W13: Data Sync feeds (missions) on a linked server.
export interface Feed {
    name: string;
    guid: string | null;
    description: string;
    keywords: string[];
    locked: boolean;
    subscribed: boolean;
}

export async function listFeeds(id: number): Promise<Feed[]> {
    return (await std(`${BASE}/server/${id}/mission`) as { items: Feed[] }).items;
}

export interface FeedItem {
    id: string;
    callsign: string;
    type: string;
    center: number[] | null;
}

export async function feedItems(id: number, name: string): Promise<FeedItem[]> {
    return (await std(`${BASE}/server/${id}/mission/${encodeURIComponent(name)}`, { timeout: 60_000 }) as { items: FeedItem[] }).items;
}

export async function joinFeed(id: number, name: string): Promise<{ status: number; message: string; items: number }> {
    return await std(`${BASE}/server/${id}/mission/${encodeURIComponent(name)}`, { method: 'PUT', timeout: 60_000 }) as { status: number; message: string; items: number };
}

export async function leaveFeed(id: number, name: string): Promise<void> {
    await std(`${BASE}/server/${id}/mission/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

export interface SelfPosition {
    longitude: number;
    latitude: number;
    altitude?: number | null;
    speed?: number | null;
    bearing?: number | null;
}

// W11: own position to every connected link (server ignores calls closer than ~10 s apart).
export async function sendSelf(body: SelfPosition): Promise<{ status: number; message: string; sent: number }> {
    return await std(`${BASE}/self`, { method: 'POST', body }) as { status: number; message: string; sent: number };
}

export async function health(): Promise<{ version: string; ready: boolean; servers: number; online: boolean }> {
    return await std(`${BASE}/health`) as { version: string; ready: boolean; servers: number; online: boolean };
}

export async function homeServerName(): Promise<string> {
    try {
        const server = await std('/api/server') as { name?: string; url?: string };
        if (server.name && server.name !== 'Default Server') return server.name;
        if (server.url) {
            try {
                return new URL(server.url).hostname;
            } catch {
                return server.url;
            }
        }
    } catch {
        // fall through
    }
    return 'the home TAK Server';
}

export function errorText(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

export function cn(subject: string): string {
    const m = subject.match(/CN=([^,\n]+)/);
    return m ? m[1] : subject;
}

export function ago(iso: string | null): string {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return 'now';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}
