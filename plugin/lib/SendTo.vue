<template>
    <div class='border-top mt-2 pt-2'>
        <div class='small fw-semibold mb-1'>
            Send {{ features.length }} selected feature{{ features.length === 1 ? '' : 's' }} to people on {{ server.name }}
        </div>
        <div
            v-if='!features.length'
            class='text-muted small'
        >
            Select one or more features on the map first.
        </div>
        <TablerLoading
            v-else-if='loading'
            :inline='true'
            desc='Loading who is on that server'
        />
        <div
            v-else-if='error'
            class='text-danger small'
            v-text='error'
        />
        <template v-else>
            <div class='btn-group btn-group-sm mb-2'>
                <button
                    class='btn'
                    :class='mode === "people" ? "btn-primary" : "btn-outline-primary"'
                    @click='mode = "people"'
                >
                    People
                </button>
                <button
                    class='btn'
                    :class='mode === "team" ? "btn-primary" : "btn-outline-primary"'
                    @click='mode = "team"'
                >
                    Team
                </button>
                <button
                    class='btn'
                    :class='mode === "feed" ? "btn-primary" : "btn-outline-primary"'
                    @click='mode = "feed"'
                >
                    Feed
                </button>
            </div>

            <template v-if='mode === "people"'>
                <div
                    v-if='!others.length'
                    class='text-muted small'
                >
                    Nobody else is on {{ server.name }} right now.
                </div>
                <div
                    v-for='c in others'
                    :key='c.uid'
                    class='form-check small mb-1'
                >
                    <input
                        :id='`crosstak-to-${server.id}-${c.uid}`'
                        class='form-check-input'
                        type='checkbox'
                        :checked='people.has(c.uid)'
                        @change='togglePerson(c.uid, ($event.target as HTMLInputElement).checked)'
                    >
                    <label
                        class='form-check-label'
                        :for='`crosstak-to-${server.id}-${c.uid}`'
                    >
                        {{ c.callsign }}
                        <span
                            v-if='c.team || c.role'
                            class='text-muted'
                        >· {{ [c.team, c.role].filter(Boolean).join(' · ') }}</span>
                    </label>
                </div>
            </template>

            <template v-else-if='mode === "feed"'>
                <div
                    v-if='!followed.length'
                    class='text-muted small'
                >
                    You have joined no Data Sync feed on {{ server.name }}. Use Data Sync on this card first.
                </div>
                <select
                    v-else
                    v-model='feed'
                    class='form-select form-select-sm mb-1'
                >
                    <option
                        disabled
                        value=''
                    >
                        Choose a feed
                    </option>
                    <option
                        v-for='f in followed'
                        :key='f.name'
                        :value='f.name'
                    >
                        {{ f.name }}
                    </option>
                </select>
            </template>

            <template v-else>
                <div
                    v-if='!teams.length'
                    class='text-muted small'
                >
                    Nobody else is on {{ server.name }} right now.
                </div>
                <select
                    v-else
                    v-model='team'
                    class='form-select form-select-sm mb-1'
                >
                    <option
                        disabled
                        value=''
                    >
                        Choose a team
                    </option>
                    <option
                        v-for='t in teams'
                        :key='t.name'
                        :value='t.name'
                    >
                        {{ t.name }} ({{ t.count }})
                    </option>
                </select>
            </template>

            <div class='d-flex align-items-center gap-2 mt-2'>
                <button
                    class='btn btn-sm btn-primary'
                    :disabled='sending || !ready'
                    @click='send'
                >
                    <TablerLoading
                        v-if='sending'
                        :inline='true'
                        desc='Sending'
                    />
                    <span v-else>Send</span>
                </button>
                <span
                    v-if='info'
                    class='text-success small'
                    v-text='info'
                />
            </div>
            <div
                v-if='sendError'
                class='text-danger small mt-1'
                v-text='sendError'
            />
        </template>
    </div>
</template>

<script setup lang='ts'>
import { ref, computed, onMounted } from 'vue';
import { TablerLoading } from '@tak-ps/vue-tabler';
import { listContacts, listFeeds, sendFeature, errorText } from './crosstak-client.ts';
import type { LinkedServer, Contact, SendTarget, Feed } from './crosstak-client.ts';

const props = defineProps<{
    server: LinkedServer;
    features: unknown[];
}>();

const contacts = ref<Contact[]>([]);
const loading = ref(true);
const error = ref('');
const mode = ref<'people' | 'team' | 'feed'>('people');
const followed = ref<Feed[]>([]);
const feed = ref('');
const people = ref<Set<string>>(new Set());
const team = ref('');
const sending = ref(false);
const sendError = ref('');
const info = ref('');

const others = computed(() => contacts.value.filter((c) => !c.self));

const teams = computed(() => {
    const count = new Map<string, number>();
    for (const c of others.value) if (c.team) count.set(c.team, (count.get(c.team) || 0) + 1);
    return [...count.entries()].map(([name, n]) => ({ name, count: n })).sort((a, b) => a.name.localeCompare(b.name));
});

const ready = computed(() => {
    if (!props.features.length) return false;
    if (mode.value === 'people') return people.value.size > 0;
    if (mode.value === 'feed') return !!feed.value;
    return !!team.value;
});

function togglePerson(uid: string, on: boolean) {
    const next = new Set(people.value);
    if (on) next.add(uid);
    else next.delete(uid);
    people.value = next;
}

async function send() {
    sending.value = true;
    sendError.value = '';
    info.value = '';
    const to: SendTarget = mode.value === 'people'
        ? { uids: [...people.value] }
        : mode.value === 'feed' ? { mission: feed.value } : { team: team.value };
    let sent = 0;
    try {
        let last = '';
        for (const f of props.features) {
            last = (await sendFeature(props.server.id, f, to)).message;
            sent++;
        }
        info.value = sent === 1 ? last : `${sent} features: ${last}`;
    } catch (err) {
        sendError.value = `${sent ? `Sent ${sent}, then failed: ` : ''}${errorText(err)}`;
    } finally {
        sending.value = false;
    }
}

onMounted(async () => {
    try {
        const [c, f] = await Promise.all([
            listContacts(props.server.id),
            listFeeds(props.server.id).catch(() => [] as Feed[]),
        ]);
        contacts.value = c.items;
        followed.value = f.filter((x) => x.subscribed);
    } catch (err) {
        error.value = errorText(err);
    } finally {
        loading.value = false;
    }
});
</script>
