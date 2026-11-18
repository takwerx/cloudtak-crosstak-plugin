<template>
    <div class='border-top mt-2 pt-2'>
        <TablerLoading
            v-if='loading'
            :inline='true'
            desc='Loading channels'
        />
        <div
            v-else-if='error'
            class='text-danger small'
            v-text='error'
        />
        <template v-else>
            <div
                v-if='!list || !list.items.length'
                class='text-muted small'
            >
                Your account is in no channels on {{ server.name }}.
            </div>
            <template v-else>
                <div
                    v-if='!list.can_switch'
                    class='alert alert-warning small py-1 px-2 mb-2'
                >
                    This certificate was not issued for channel switching, so {{ server.name }}
                    may ignore changes. Link or enroll again with a username and password to get
                    one that can.
                </div>
                <div
                    v-for='c in list.items'
                    :key='c.name'
                    class='form-check small mb-1'
                >
                    <input
                        :id='`crosstak-ch-${server.id}-${c.name}`'
                        class='form-check-input'
                        type='checkbox'
                        :checked='selected.has(c.name)'
                        :disabled='saving'
                        @change='toggle(c.name, ($event.target as HTMLInputElement).checked)'
                    >
                    <label
                        class='form-check-label'
                        :for='`crosstak-ch-${server.id}-${c.name}`'
                    >
                        {{ c.name }}
                        <span class='text-muted'>{{ direction(c) }}</span>
                        <span
                            v-if='c.description'
                            class='text-muted'
                        > — {{ c.description }}</span>
                    </label>
                </div>
                <div class='d-flex align-items-center gap-2 mt-2'>
                    <button
                        class='btn btn-sm btn-primary'
                        :disabled='saving || !dirty || !selected.size'
                        @click='apply'
                    >
                        <TablerLoading
                            v-if='saving'
                            :inline='true'
                            desc='Saving'
                        />
                        <span v-else>Apply</span>
                    </button>
                    <span class='text-muted small'>
                        Applies to your own account on that server. Keep at least one on.
                    </span>
                </div>
                <div
                    v-if='saveError'
                    class='text-danger small mt-1'
                    v-text='saveError'
                />
            </template>
        </template>
    </div>
</template>

<script setup lang='ts'>
import { ref, computed, onMounted } from 'vue';
import { TablerLoading } from '@tak-ps/vue-tabler';
import { listChannels, setChannels, errorText } from './crosstak-client.ts';
import type { LinkedServer, ChannelList, Channel } from './crosstak-client.ts';

const props = defineProps<{
    server: LinkedServer;
}>();

const list = ref<ChannelList | null>(null);
const selected = ref<Set<string>>(new Set());
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const saveError = ref('');

const dirty = computed(() => {
    if (!list.value) return false;
    const active = new Set(list.value.items.filter((c) => c.active).map((c) => c.name));
    if (active.size !== selected.value.size) return true;
    for (const n of selected.value) if (!active.has(n)) return true;
    return false;
});

function direction(c: Channel): string {
    if (c.in && c.out) return '(send + receive)';
    if (c.in) return '(send only)';
    if (c.out) return '(receive only)';
    return '';
}

function sync(next: ChannelList) {
    list.value = next;
    selected.value = new Set(next.items.filter((c) => c.active).map((c) => c.name));
}

function toggle(name: string, on: boolean) {
    const next = new Set(selected.value);
    if (on) next.add(name);
    else next.delete(name);
    selected.value = next;
}

async function apply() {
    saving.value = true;
    saveError.value = '';
    try {
        sync(await setChannels(props.server.id, [...selected.value]));
    } catch (err) {
        saveError.value = errorText(err);
    } finally {
        saving.value = false;
    }
}

onMounted(async () => {
    try {
        sync(await listChannels(props.server.id));
    } catch (err) {
        error.value = errorText(err);
    } finally {
        loading.value = false;
    }
});
</script>
