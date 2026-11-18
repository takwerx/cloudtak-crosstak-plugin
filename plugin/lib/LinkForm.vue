<template>
    <div class='px-3 py-2'>
        <div class='fw-semibold mb-1'>
            Link a TAK Server
        </div>
        <div class='text-muted small mb-2'>
            Uses your own username and password on that server to get a certificate for you.
            The password is used once and never stored. The link is yours only: other
            CloudTAK users do not see it or its data.
        </div>

        <TablerInput
            v-model='form.host'
            label='Server address'
            placeholder='takserver.agency.org'
            description='The name on the server&#39;s enrollment certificate (port 8446)'
            :required='true'
            class='mb-2'
        />
        <TablerInput
            v-model='form.username'
            label='Username on that server'
            autocomplete='off'
            :required='true'
            class='mb-2'
        />
        <TablerInput
            v-model='form.password'
            label='Password'
            type='password'
            autocomplete='new-password'
            :required='true'
            class='mb-2'
        />
        <TablerInput
            v-model='form.name'
            label='Display name (optional)'
            placeholder='Agency or site name'
            class='mb-2'
        />

        <button
            class='btn btn-link btn-sm px-0'
            @click='advanced = !advanced'
        >
            {{ advanced ? 'Hide' : 'Show' }} advanced
        </button>
        <template v-if='advanced'>
            <TablerInput
                v-model='form.expected_name'
                label='Expected certificate name (optional)'
                placeholder='takserver'
                description='Only if the status says the certificate names something else. The CA is still verified.'
                class='mb-2'
            />
            <TablerInput
                v-model='form.ca'
                label='CA chain PEM (optional)'
                :rows='4'
                placeholder='-----BEGIN CERTIFICATE-----'
                description='Only if the enrollment port does not have a public certificate'
                class='mb-2'
            />
        </template>

        <div
            v-if='error'
            class='alert alert-danger small py-2 my-2'
            v-text='error'
        />

        <div class='d-flex align-items-center gap-2 mt-3'>
            <button
                class='btn btn-primary btn-sm'
                :disabled='busy || !form.host || !form.username || !form.password'
                @click='save'
            >
                <TablerLoading
                    v-if='busy'
                    :inline='true'
                    desc='Linking'
                />
                <span v-else>Link</span>
            </button>
            <button
                class='btn btn-secondary btn-sm'
                :disabled='busy'
                @click='$emit("cancel")'
            >
                Cancel
            </button>
            <button
                class='btn btn-link btn-sm ms-auto'
                :disabled='busy'
                @click='$emit("pem")'
            >
                Paste certificates instead
            </button>
        </div>
    </div>
</template>

<script setup lang='ts'>
import { ref } from 'vue';
import { TablerInput, TablerLoading } from '@tak-ps/vue-tabler';
import { linkServer, errorText } from './crosstak-client.ts';
import type { LinkedServer } from './crosstak-client.ts';

const emit = defineEmits<{
    (e: 'saved', server: LinkedServer): void;
    (e: 'cancel'): void;
    (e: 'pem'): void;
}>();

const form = ref({
    host: '',
    username: '',
    password: '',
    name: '',
    expected_name: '',
    ca: '',
});

const advanced = ref(false);
const busy = ref(false);
const error = ref('');

async function save() {
    error.value = '';
    busy.value = true;
    try {
        const saved = await linkServer({
            host: form.value.host.trim(),
            username: form.value.username.trim(),
            password: form.value.password,
            name: form.value.name.trim() || undefined,
            expected_name: form.value.expected_name.trim() || null,
            ca: form.value.ca.trim() || null,
        });
        emit('saved', saved);
    } catch (err) {
        error.value = errorText(err);
    } finally {
        busy.value = false;
        form.value.password = '';
    }
}
</script>
