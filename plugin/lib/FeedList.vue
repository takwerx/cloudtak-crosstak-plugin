<template>
    <div class='border-top mt-2 pt-2'>
        <div class='small fw-semibold mb-1'>
            Data Sync feeds on {{ server.name }}
        </div>
        <TablerLoading
            v-if='loading'
            :inline='true'
            desc='Loading feeds'
        />
        <div
            v-else-if='error'
            class='text-danger small'
            v-text='error'
        />
        <template v-else>
            <div
                v-if='!feeds.length'
                class='text-muted small'
            >
                Your account sees no Data Sync feeds on {{ server.name }}.
            </div>
            <div
                v-for='f in feeds'
                :key='f.name'
                class='small mb-1'
            >
                <div class='d-flex align-items-start gap-2'>
                    <div
                        class='flex-grow-1'
                        :class='{ "cursor-pointer": f.subscribed }'
                        style='min-width: 0'
                        :title='f.subscribed ? "Show or hide the items in this feed" : ""'
                        @click='f.subscribed && toggleItems(f.name)'
                    >
                        <IconChevronDown
                            v-if='f.subscribed && open.has(f.name)'
                            :size='14'
                        />
                        <IconChevronRight
                            v-else-if='f.subscribed'
                            :size='14'
                        />
                        <span class='fw-semibold'>{{ f.name }}</span>
                        <span
                            v-if='f.locked'
                            class='text-muted'
                        > · password protected</span>
                        <div
                            v-if='f.description'
                            class='text-muted text-truncate'
                            v-text='f.description'
                        />
                    </div>
                    <template v-if='f.subscribed'>
                        <button
                            class='btn btn-sm btn-outline-primary'
                            :disabled='busy === f.name || !features.length'
                            :title='features.length ? `Add the ${features.length} selected feature(s) to ${f.name}` : "Select features on the map first"'
                            @click='contribute(f)'
                        >
                            Add selected
                        </button>
                        <button
                            class='btn btn-sm btn-outline-secondary'
                            :disabled='busy === f.name'
                            @click='leave(f)'
                        >
                            Leave
                        </button>
                    </template>
                    <button
                        v-else
                        class='btn btn-sm btn-outline-primary'
                        :disabled='busy === f.name || f.locked'
                        :title='f.locked ? "Password-protected feeds are not supported yet" : `Join ${f.name}`'
                        @click='join(f)'
                    >
                        <TablerLoading
                            v-if='busy === f.name'
                            :inline='true'
                            desc='Joining'
                        />
                        <span v-else>Join</span>
                    </button>
                </div>
                <div
                    v-if='f.subscribed && open.has(f.name)'
                    class='ms-3 mt-1 mb-2'
                >
                    <TablerLoading
                        v-if='items[f.name] === undefined'
                        :inline='true'
                        desc='Loading items'
                    />
                    <div
                        v-else-if='!(items[f.name] || []).length'
                        class='text-muted'
                    >
                        This feed has no map items.
                    </div>
                    <div
                        v-for='it in items[f.name] || []'
                        :key='it.id'
                        class='d-flex align-items-center gap-2 py-1 border-bottom'
                        :class='{ "cursor-pointer": !!it.center }'
                        :title='it.center ? "Show on the map" : ""'
                        @click='flyTo(it)'
                    >
                        <span class='text-truncate flex-grow-1'>{{ it.callsign }}</span>
                        <span class='text-muted text-nowrap'>{{ it.type }}</span>
                    </div>
                </div>
            </div>
            <div
                v-if='info'
                class='text-success small mt-1'
                v-text='info'
            />
            <div
                v-if='actionError'
                class='text-danger small mt-1'
                v-text='actionError'
            />
        </template>
    </div>
</template>

<script setup lang='ts'>
import { ref, onMounted } from 'vue';
import { TablerLoading } from '@tak-ps/vue-tabler';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-vue';
import type { PluginAPI } from '../../../plugin.ts';
import { useMapStore } from '../../../src/stores/map.ts';
import { listFeeds, joinFeed, leaveFeed, sendFeature, feedItems, errorText } from './crosstak-client.ts';
import type { LinkedServer, Feed, FeedItem } from './crosstak-client.ts';

const props = defineProps<{
    server: LinkedServer;
    api: PluginAPI;
    features: unknown[];
}>();

const emit = defineEmits<{
    (e: 'changed'): void;
}>();

const mapStore = useMapStore();

const feeds = ref<Feed[]>([]);
const loading = ref(true);
const error = ref('');
const busy = ref('');
const info = ref('');
const actionError = ref('');
const open = ref<Set<string>>(new Set());
const items = ref<Record<string, FeedItem[] | undefined>>({});

async function loadItems(name: string) {
    items.value = { ...items.value, [name]: undefined };
    try {
        items.value = { ...items.value, [name]: await feedItems(props.server.id, name) };
    } catch (err) {
        items.value = { ...items.value, [name]: [] };
        actionError.value = errorText(err);
    }
}

function toggleItems(name: string) {
    const next = new Set(open.value);
    if (next.has(name)) {
        next.delete(name);
    } else {
        next.add(name);
        loadItems(name);
    }
    open.value = next;
}

function flyTo(it: FeedItem) {
    if (!it.center) return;
    props.api.map.flyTo({ center: [it.center[0], it.center[1]], zoom: Math.max(props.api.map.getZoom(), 14) });
}

type FeedMeta = { metadata?: { crosstak?: { server?: number; mission?: string } } };

async function load() {
    try {
        feeds.value = await listFeeds(props.server.id);
        error.value = '';
    } catch (err) {
        error.value = errorText(err);
    } finally {
        loading.value = false;
    }
}

async function join(f: Feed) {
    busy.value = f.name;
    info.value = '';
    actionError.value = '';
    try {
        const res = await joinFeed(props.server.id, f.name);
        info.value = `${res.message}: ${res.items} item${res.items === 1 ? '' : 's'}`;
        await load();
        emit('changed');
    } catch (err) {
        actionError.value = errorText(err);
    } finally {
        busy.value = '';
    }
}

// Contribute: each selected feature goes to the linked server addressed to this feed.
async function contribute(f: Feed) {
    busy.value = f.name;
    info.value = '';
    actionError.value = '';
    let sent = 0;
    try {
        for (const feat of props.features) {
            await sendFeature(props.server.id, feat, { mission: f.name });
            sent++;
        }
        info.value = `Added ${sent} feature${sent === 1 ? '' : 's'} to ${f.name}`;
        if (open.value.has(f.name)) setTimeout(() => loadItems(f.name), 2000);
    } catch (err) {
        actionError.value = `${sent ? `Added ${sent}, then failed: ` : ''}${errorText(err)}`;
    } finally {
        busy.value = '';
    }
}

async function leave(f: Feed) {
    busy.value = f.name;
    info.value = '';
    actionError.value = '';
    try {
        await leaveFeed(props.server.id, f.name);
        // Take the feed's items off this map now (CloudTAK has no server-side delete for them).
        const feats = await props.api.feature.list({
            filter: (feat) => {
                const meta = (feat.properties as FeedMeta).metadata?.crosstak;
                return !!meta && meta.server === props.server.id && meta.mission === f.name;
            }
        });
        for (const feat of feats) {
            try {
                await mapStore.worker.db.remove(String(feat.id));
            } catch {
                // already gone
            }
        }
        info.value = `Left ${f.name}; removed ${feats.length} item${feats.length === 1 ? '' : 's'} from the map`;
        await load();
        emit('changed');
    } catch (err) {
        actionError.value = errorText(err);
    } finally {
        busy.value = '';
    }
}

onMounted(load);
</script>
