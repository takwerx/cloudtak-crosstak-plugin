<template>
    <div class='px-3 py-2'>
        <div class='fw-semibold mb-2'>
            {{ initial ? `Edit ${initial.name}` : 'Add a linked TAK Server from certificates' }}
        </div>

        <TablerInput
            v-model='form.name'
            label='Name'
            placeholder='Agency or site name'
            :required='true'
            class='mb-2'
        />
        <TablerInput
            v-model='form.url'
            label='Stream URL'
            placeholder='ssl://tak.example.org:8089'
            description='The TAK Server streaming port, usually 8089'
            :required='true'
            class='mb-2'
        />
        <TablerInput
            v-model='form.webtak'
            label='Enrollment URL (optional)'
            placeholder='https://tak.example.org:8446'
            description='Needed only for username/password enrollment'
            class='mb-2'
        />
        <TablerInput
            v-model='form.api'
            label='API URL (optional)'
            placeholder='https://tak.example.org:8443'
            class='mb-2'
        />
        <TablerInput
            v-model='form.expected_name'
            label='Expected certificate name (optional)'
            placeholder='takserver'
            description='Only if the server certificate does not name the host in the URL. The CA is still verified.'
            class='mb-2'
        />
        <TablerInput
            v-model='form.ca'
            :label='initial ? "CA chain PEM (leave blank to keep)" : "CA chain PEM"'
            :rows='5'
            placeholder='-----BEGIN CERTIFICATE-----'
            description='The linked server&#39;s CA, pinned on its connections only'
            :required='!initial'
            class='mb-2'
        />
        <TablerInput
            v-model='form.cert'
            :label='initial ? "Client certificate PEM (leave blank to keep)" : "Client certificate PEM (optional)"'
            :rows='3'
            placeholder='-----BEGIN CERTIFICATE-----'
            class='mb-2'
        />
        <TablerInput
            v-model='form.key'
            :label='initial ? "Client key PEM (leave blank to keep)" : "Client key PEM (optional)"'
            :rows='3'
            placeholder='-----BEGIN PRIVATE KEY-----'
            description='Unencrypted PEM. Or save without one and use Enroll.'
            class='mb-2'
        />

        <div class='d-flex gap-4 my-2'>
            <TablerToggle
                v-model='form.enabled'
                label='Enabled'
            />
        </div>

        <div
            v-if='error'
            class='alert alert-danger small py-2 my-2'
            v-text='error'
        />

        <div class='d-flex gap-2 mt-3'>
            <button
                class='btn btn-primary btn-sm'
                :disabled='busy'
                @click='save'
            >
                <TablerLoading
                    v-if='busy'
                    :inline='true'
                    desc='Saving'
                />
                <span v-else>{{ initial ? 'Save' : 'Add server' }}</span>
            </button>
            <button
                class='btn btn-secondary btn-sm'
                :disabled='busy'
                @click='$emit("cancel")'
            >
                Cancel
            </button>
        </div>
    </div>
</template>

<script setup lang='ts'>
import { ref } from 'vue';
import { TablerInput, TablerToggle, TablerLoading } from '@tak-ps/vue-tabler';
import { createServer, patchServer, errorText } from './crosstak-client.ts';
import type { LinkedServer, LinkedServerInput } from './crosstak-client.ts';

const props = defineProps<{
    initial: LinkedServer | null;
}>();

const emit = defineEmits<{
    (e: 'saved', server: LinkedServer): void;
    (e: 'cancel'): void;
}>();

const form = ref({
    name: props.initial?.name ?? '',
    url: props.initial?.url ?? '',
    api: props.initial?.api ?? '',
    webtak: props.initial?.webtak ?? '',
    expected_name: props.initial?.expected_name ?? '',
    ca: '',
    cert: '',
    key: '',
    enabled: props.initial?.enabled ?? true,
});

const busy = ref(false);
const error = ref('');

async function save() {
    error.value = '';
    busy.value = true;
    try {
        const body: LinkedServerInput = {
            name: form.value.name.trim(),
            url: form.value.url.trim(),
            api: form.value.api.trim() || null,
            webtak: form.value.webtak.trim() || null,
            expected_name: form.value.expected_name.trim() || null,
            enabled: form.value.enabled,
        };
        if (form.value.ca.trim()) body.ca = form.value.ca.trim();
        if (form.value.cert.trim() || form.value.key.trim()) {
            body.cert = form.value.cert.trim();
            body.key = form.value.key.trim();
        }
        const saved = props.initial
            ? await patchServer(props.initial.id, body)
            : await createServer(body);
        // Never keep PEM text around after a save.
        form.value.ca = '';
        form.value.cert = '';
        form.value.key = '';
        emit('saved', saved);
    } catch (err) {
        error.value = errorText(err);
    } finally {
        busy.value = false;
    }
}
</script>
