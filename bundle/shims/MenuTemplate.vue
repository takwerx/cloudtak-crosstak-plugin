<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!--
    CrossTAK runtime bundle: stands in for CloudTAK's
    app/src/components/CloudTAK/util/MenuTemplate.vue (the frame every CloudTAK menu uses).
    A bundle cannot import host components, so this is a copy of that frame at CloudTAK 14.4.2
    with the app store read through findStore(). Same header, same phone sheet, same scrolling.
-->
<template>
    <TablerModal
        v-if='isModal'
        v-model:height='sheetHeight'
        size='xl'
        swipeable
        :min-height='SHEET_MIN_HEIGHT'
        @close='router.push("/")'
    >
        <div class='main-menu-modal-frame w-100 px-0 d-flex flex-column overflow-hidden'>
            <div
                class='modal-header d-flex align-items-center py-2 px-2 flex-shrink-0'
                data-modal-swipe
            >
                <TablerIconButton
                    v-if='backType === "back"'
                    title='Back'
                    @click='routerBack'
                >
                    <IconCircleArrowLeft
                        :size='28'
                        stroke='1'
                    />
                </TablerIconButton>
                <div
                    class='flex-grow-1 d-flex flex-column px-1'
                    style='min-width: 0'
                >
                    <div
                        class='modal-title text-break'
                        v-text='name'
                    />
                </div>
                <div class='btn-list align-items-center flex-nowrap'>
                    <slot name='buttons' />
                    <TablerIconButton
                        title='Close Menu'
                        @click='router.push("/")'
                    >
                        <IconCircleX
                            :size='28'
                            stroke='1'
                        />
                    </TablerIconButton>
                </div>
            </div>
            <div class='d-flex flex-column overflow-x-hidden flex-grow-1 px-2 overflow-y-auto' style='min-height: 0'>
                <slot />
                <div class='menu-scroll-spacer flex-shrink-0' />
            </div>
        </div>
    </TablerModal>
    <div
        v-else
        class='w-100 px-0 d-flex flex-column overflow-hidden flex-grow-1'
        style='min-height: 0'
    >
        <div
            class='col-12 cloudtak-header flex-shrink-0 border-bottom'
            style='z-index: 1020; border-radius: 0px;'
        >
            <div class='card-header d-flex align-items-center py-2 px-0 mx-2 flex-wrap row-gap-2'>
                <div class='d-flex align-items-center flex-grow-1' style='min-width: 0'>
                    <TablerIconButton
                        v-if='backType === "back"'
                        title='Back'
                        @click='routerBack'
                    >
                        <IconCircleArrowLeft
                            :size='32'
                            stroke='1'
                        />
                    </TablerIconButton>
                    <div v-else />
                    <div class='d-flex flex-column user-select-none px-2' style='min-width: 0'>
                        <div
                            class='strong text-break'
                            v-text='name'
                        />
                    </div>
                </div>
                <div class='col-auto btn-list align-items-center menu-header-buttons'>
                    <slot name='buttons' />
                </div>
            </div>
        </div>
        <div class='d-flex flex-column overflow-x-hidden flex-grow-1 px-2 overflow-y-auto' style='min-height: 0'>
            <slot />
            <div class='menu-scroll-spacer flex-shrink-0' />
        </div>
    </div>
</template>

<script lang='ts'>
import { ref } from 'vue';

const SHEET_MIN_HEIGHT = 0.5;

// Shared by every menu so the height the user dragged to survives moving between menus
const sheetHeight = ref(1);
</script>

<script setup lang='ts'>
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { TablerModal, TablerIconButton } from '@tak-ps/vue-tabler';
import { IconCircleX, IconCircleArrowLeft } from '@tabler/icons-vue';
import { findStore, APP_STORE_ID } from './host.ts';

const router = useRouter();

const props = defineProps({
    name: { type: String, default: '' },
});

function routerBack() {
    if (!router.options.history.state.back || String(router.options.history.state.back).startsWith('/login')) {
        router.push('/');
    } else {
        router.back();
    }
}

const backType = computed(() => {
    if (!router.options.history.state.back || router.options.history.state.back === '/') return 'close';
    return 'back';
});

if (sheetHeight.value < SHEET_MIN_HEIGHT) sheetHeight.value = 1;

const isModal = computed(() => !!findStore(APP_STORE_ID)?.isMobileDetected);
// `props` is read by the template through `name`
void props;
</script>

<style scoped>
.menu-header-buttons {
    min-height: 34px;
}

.main-menu-modal-frame {
    height: calc((100dvh - 2rem - 2 * var(--status-bar-height, 0px)) * var(--tblr-modal-sheet, 1));
    max-height: calc((100dvh - 2rem - 2 * var(--status-bar-height, 0px)) * var(--tblr-modal-sheet, 1));
}

.menu-scroll-spacer {
    height: calc(env(safe-area-inset-bottom, 0px) + 32px);
}
</style>
