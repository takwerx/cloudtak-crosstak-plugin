<template>
    <div class='d-flex flex-column w-100 pb-5'>
        <!-- W8: fixed wording (PLAN §10), do not soften -->
        <div class='alert alert-info small py-2 mx-2 mt-2 mb-1'>
            Linked features are read-only by convention. Sharing or adding one to a mission
            copies it to {{ homeName }}.
        </div>

        <div
            v-if='loadError'
            class='alert alert-danger small py-2 mx-2 my-1'
        >
            <div class='fw-bold'>
                CrossTAK is not available
            </div>
            {{ loadError }}
        </div>

        <TablerLoading
            v-else-if='loading'
            desc='Loading linked servers'
        />

        <template v-else>
            <LinkForm
                v-if='mode === "link"'
                @saved='onSaved'
                @cancel='mode = "list"'
                @pem='mode = "add"'
            />

            <ServerForm
                v-else-if='mode === "add" || mode === "edit"'
                :initial='mode === "edit" ? editing : null'
                @saved='onSaved'
                @cancel='mode = "list"'
            />

            <div
                v-else-if='mode === "enroll" && editing'
                class='px-3 py-2'
            >
                <div class='fw-semibold mb-2'>
                    Enroll again on {{ editing.name }}
                </div>
                <div class='text-muted small mb-2'>
                    Replaces your certificate on this server with one issued for your username on it.
                    The password is used once and never stored.
                </div>
                <TablerInput
                    v-model='enroll.username'
                    label='Username'
                    autocomplete='off'
                    class='mb-2'
                />
                <TablerInput
                    v-model='enroll.password'
                    label='Password'
                    type='password'
                    autocomplete='new-password'
                    class='mb-2'
                />
                <div
                    v-if='actionError'
                    class='alert alert-danger small py-2 my-2'
                    v-text='actionError'
                />
                <div class='d-flex gap-2 mt-3'>
                    <button
                        class='btn btn-primary btn-sm'
                        :disabled='busy || !enroll.username || !enroll.password'
                        @click='doEnroll'
                    >
                        <TablerLoading
                            v-if='busy'
                            :inline='true'
                            desc='Enrolling'
                        />
                        <span v-else>Enroll</span>
                    </button>
                    <button
                        class='btn btn-secondary btn-sm'
                        :disabled='busy'
                        @click='closeEnroll'
                    >
                        Cancel
                    </button>
                </div>
            </div>

            <template v-else>
                <div class='d-flex align-items-center px-3 py-2 gap-2'>
                    <span class='fw-semibold'>My linked servers</span>
                    <span class='text-muted small ms-auto'>
                        {{ servers.length }} server{{ servers.length === 1 ? '' : 's' }}
                        <span v-if='selectedFeatures.length'>· {{ selectedFeatures.length }} selected on map</span>
                    </span>
                    <TablerIconButton
                        title='Refresh'
                        @click='refresh'
                    >
                        <IconRefresh :size='18' />
                    </TablerIconButton>
                    <button
                        class='btn btn-primary btn-sm'
                        @click='openLink'
                    >
                        <IconPlus
                            :size='16'
                            class='me-1'
                        />Link
                    </button>
                </div>

                <div
                    v-if='actionError'
                    class='alert alert-danger small py-2 mx-2 my-1 d-flex'
                >
                    <span class='flex-grow-1'>{{ actionError }}</span>
                    <button
                        class='btn-close btn-close-white ms-2'
                        aria-label='Dismiss'
                        @click='actionError = ""'
                    />
                </div>
                <div
                    v-if='actionInfo'
                    class='alert alert-success small py-2 mx-2 my-1 d-flex'
                >
                    <span class='flex-grow-1'>{{ actionInfo }}</span>
                    <button
                        class='btn-close btn-close-white ms-2'
                        aria-label='Dismiss'
                        @click='actionInfo = ""'
                    />
                </div>

                <TablerNone
                    v-if='!servers.length'
                    label='Linked servers. Click Link to add a TAK Server you have an account on'
                    :create='false'
                />

                <div
                    v-for='s in servers'
                    :key='s.id'
                    class='card mx-2 my-1'
                >
                    <div class='card-body py-2 px-3'>
                        <div class='d-flex align-items-center gap-2'>
                            <span
                                class='status-dot'
                                :class='dotClass(s)'
                                :title='statusTitle(s)'
                            />
                            <span class='fw-semibold text-truncate'>{{ s.name }}</span>
                            <span
                                v-if='!s.enabled'
                                class='badge bg-secondary text-white small'
                            >disabled</span>
                            <span
                                v-else-if='s.status.rejected'
                                class='badge bg-danger text-white small'
                            >not connecting</span>
                            <span
                                v-else-if='!s.has_auth'
                                class='badge bg-warning text-dark small'
                            >no certificate</span>
                            <span class='ms-auto text-muted small text-nowrap'>
                                {{ counts[s.id] || 0 }} on map
                            </span>
                        </div>

                        <div class='text-muted small mt-1 text-truncate'>
                            {{ s.url }}
                        </div>
                        <div class='text-muted small'>
                            <template v-if='s.status.connected'>
                                connected {{ ago(s.status.since) }} · last CoT {{ ago(s.status.last_cot) }} · {{ s.status.cots }} received
                            </template>
                            <template v-else-if='s.status.error'>
                                {{ s.status.error }}
                            </template>
                            <template v-else-if='s.enabled && s.has_auth'>
                                idle — connects when you are on the map
                            </template>
                            <template v-else>
                                not connected
                            </template>
                        </div>
                        <div
                            v-if='s.cert'
                            class='text-muted small'
                        >
                            identity {{ cn(s.cert.subject) }} · expires {{ s.cert.valid_to.slice(0, 10) }}
                        </div>

                        <div class='d-flex flex-wrap align-items-center gap-2 mt-2'>
                            <button
                                class='btn btn-sm btn-outline-primary'
                                :disabled='!s.status.verified'
                                :title='s.status.verified ? `Send selected features to people on ${s.name}` : "Not connected"'
                                @click='toggleSend(s.id)'
                            >
                                <IconSend
                                    :size='16'
                                    class='me-1'
                                />Send to…
                            </button>
                            <button
                                class='btn btn-sm btn-outline-secondary'
                                :disabled='!s.has_auth'
                                @click='toggleChannels(s.id)'
                            >
                                <IconAffiliate
                                    :size='16'
                                    class='me-1'
                                />Channels
                            </button>
                            <button
                                class='btn btn-sm btn-outline-secondary'
                                :disabled='!s.has_auth'
                                @click='toggleFeeds(s.id)'
                            >
                                <IconCloudPin
                                    :size='16'
                                    class='me-1'
                                />Data Sync
                            </button>

                            <div class='form-check form-switch mb-0 small'>
                                <input
                                    :id='`crosstak-enabled-${s.id}`'
                                    class='form-check-input'
                                    type='checkbox'
                                    :checked='s.enabled'
                                    :disabled='busy'
                                    @change='toggle(s, "enabled", ($event.target as HTMLInputElement).checked)'
                                >
                                <label
                                    class='form-check-label'
                                    :for='`crosstak-enabled-${s.id}`'
                                >Enabled</label>
                            </div>
                            <span class='ms-auto d-flex gap-1'>
                                <TablerIconButton
                                    title='Enroll again with username/password'
                                    @click='openEnroll(s)'
                                >
                                    <IconCertificate :size='18' />
                                </TablerIconButton>
                                <TablerIconButton
                                    title='Edit'
                                    @click='openEdit(s)'
                                >
                                    <IconPencil :size='18' />
                                </TablerIconButton>
                                <TablerDelete
                                    displaytype='icon'
                                    :size='18'
                                    label='Delete this linked server'
                                    @delete='remove(s)'
                                />
                            </span>
                        </div>

                        <ChannelList
                            v-if='openChannels.has(s.id)'
                            :server='s'
                        />
                        <FeedList
                            v-if='openFeeds.has(s.id)'
                            :server='s'
                            :api='api'
                            :features='selectedFeatures.map((cot) => cot.as_feature({ clone: true }))'
                            @changed='refresh'
                        />
                        <SendTo
                            v-if='openSend.has(s.id) && s.status.verified'
                            :server='s'
                            :features='selectedFeatures.map((cot) => cot.as_feature({ clone: true }))'
                        />
                    </div>
                </div>
            </template>
        </template>
    </div>
</template>

<script setup lang='ts'>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { TablerLoading, TablerNone, TablerIconButton, TablerInput, TablerDelete } from '@tak-ps/vue-tabler';
// Same icons as CloudTAK's own Channels (IconAffiliate) and Data Sync (IconCloudPin) menus.
import { IconRefresh, IconPlus, IconSend, IconPencil, IconCertificate, IconAffiliate, IconCloudPin } from '@tabler/icons-vue';
// Resolved once this directory is app/plugins/crosstak/lib/ (Dispatcher pattern).
import type { PluginAPI } from '../../../plugin.ts';
import { useMapStore } from '../../../src/stores/map.ts';
import LinkForm from './LinkForm.vue';
import ServerForm from './ServerForm.vue';
import ChannelList from './ChannelList.vue';
import SendTo from './SendTo.vue';
import FeedList from './FeedList.vue';
import {
    listServers, patchServer, deleteServer, enrollServer,
    homeServerName, errorText, ago, cn,
} from './crosstak-client.ts';
import type { LinkedServer } from './crosstak-client.ts';
import { isFromLink } from './linked-features.ts';

const props = defineProps<{
    api: PluginAPI;
}>();

const mapStore = useMapStore();

const servers = ref<LinkedServer[]>([]);
const counts = ref<Record<number, number>>({});
const loading = ref(true);
const loadError = ref('');
const actionError = ref('');
const actionInfo = ref('');
const busy = ref(false);
const homeName = ref('the home TAK Server');
const mode = ref<'list' | 'link' | 'add' | 'edit' | 'enroll'>('list');
const editing = ref<LinkedServer | null>(null);
const enroll = ref({ username: '', password: '' });
const openChannels = ref<Set<number>>(new Set());
const openSend = ref<Set<number>>(new Set());
const openFeeds = ref<Set<number>>(new Set());

let timer: ReturnType<typeof setInterval> | undefined;

// Everything selected on the map except the user's own position (self-PLI push is P2).
const selectedFeatures = computed(() => {
    return [...mapStore.selected.values()].filter((cot) => !cot.is_self);
});

function dotClass(s: LinkedServer): string {
    if (!s.enabled) return 'bg-secondary';
    if (s.status.rejected) return 'bg-danger';
    if (s.status.connected && s.status.verified) return 'bg-success';
    if (s.status.error) return 'bg-danger';
    return 'bg-warning';
}

function statusTitle(s: LinkedServer): string {
    if (!s.enabled) return 'Disabled';
    if (s.status.connected) return 'Connected';
    return s.status.error || 'Not connected';
}

type CrosstakMeta = { metadata?: { crosstak?: { server?: number } } };

async function refresh() {
    try {
        servers.value = await listServers();
        loadError.value = '';
    } catch (err) {
        if (!servers.value.length) loadError.value = errorText(err);
    }
    try {
        const next: Record<number, number> = {};
        const feats = await props.api.feature.list({
            filter: (f) => {
                const meta = (f.properties as CrosstakMeta).metadata;
                return !!meta && !!meta.crosstak && typeof meta.crosstak.server === 'number';
            }
        });
        for (const f of feats) {
            const id = (f.properties as CrosstakMeta).metadata?.crosstak?.server;
            if (typeof id === 'number') next[id] = (next[id] || 0) + 1;
        }
        counts.value = next;
    } catch {
        // counts are cosmetic
    }
}

function toggleChannels(id: number) {
    const next = new Set(openChannels.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    openChannels.value = next;
}

function toggleFeeds(id: number) {
    const next = new Set(openFeeds.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    openFeeds.value = next;
}

function toggleSend(id: number) {
    const next = new Set(openSend.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    openSend.value = next;
}

function openLink() {
    actionError.value = '';
    editing.value = null;
    mode.value = 'link';
}

function openEdit(s: LinkedServer) {
    actionError.value = '';
    editing.value = s;
    mode.value = 'edit';
}

function openEnroll(s: LinkedServer) {
    actionError.value = '';
    editing.value = s;
    enroll.value = { username: '', password: '' };
    mode.value = 'enroll';
}

function closeEnroll() {
    enroll.value = { username: '', password: '' };
    editing.value = null;
    mode.value = 'list';
}

// Switching a link off takes its markers off this map at once, instead of waiting for them to go
// stale. Same removal the feed pane uses when you leave a feed.
async function clearMarkers(serverId: number): Promise<number> {
    const feats = await props.api.feature.list({ filter: (feat) => isFromLink(feat, serverId) });
    let n = 0;
    for (const feat of feats) {
        try {
            await mapStore.worker.db.remove(String(feat.id));
            n++;
        } catch {
            // already gone
        }
    }
    return n;
}

async function clearAfterDisable(s: { id: number; name: string }) {
    try {
        const n = await clearMarkers(s.id);
        if (n) actionInfo.value = `${s.name} is off; removed ${n} marker${n === 1 ? '' : 's'} from the map`;
    } catch (err) {
        actionError.value = `${s.name} is off, but its markers could not be removed: ${errorText(err)}`;
    }
}

async function onSaved(server: LinkedServer) {
    mode.value = 'list';
    editing.value = null;
    actionInfo.value = `Saved ${server.name}`;
    if (!server.enabled) await clearAfterDisable(server);
    await refresh();
}

async function toggle(s: LinkedServer, field: 'enabled', value: boolean) {
    busy.value = true;
    actionError.value = '';
    try {
        await patchServer(s.id, { [field]: value });
        if (!value) await clearAfterDisable(s);
        await refresh();
    } catch (err) {
        actionError.value = errorText(err);
    } finally {
        busy.value = false;
    }
}

async function remove(s: LinkedServer) {
    busy.value = true;
    actionError.value = '';
    try {
        await deleteServer(s.id);
        actionInfo.value = `Deleted ${s.name}`;
        await refresh();
    } catch (err) {
        actionError.value = errorText(err);
    } finally {
        busy.value = false;
    }
}

async function doEnroll() {
    if (!editing.value) return;
    busy.value = true;
    actionError.value = '';
    try {
        const saved = await enrollServer(editing.value.id, enroll.value.username, enroll.value.password);
        actionInfo.value = `Enrolled on ${saved.name}${saved.cert ? ` as ${cn(saved.cert.subject)}` : ''}`;
        closeEnroll();
        await refresh();
    } catch (err) {
        actionError.value = errorText(err);
    } finally {
        busy.value = false;
        enroll.value.password = '';
    }
}

onMounted(async () => {
    homeName.value = await homeServerName();
    await refresh();
    loading.value = false;
    timer = setInterval(() => {
        if (mode.value === 'list') refresh();
    }, 5000);
});

onUnmounted(() => {
    if (timer) clearInterval(timer);
});
</script>

<style scoped>
.status-dot {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
}
</style>
