<script setup lang="ts">
import { Check, Copy } from '@lucide/vue'

const props = defineProps<{ code: string; label?: string }>()
const { m } = useI18n()
const copied = ref(false)
async function copy() {
  await navigator.clipboard.writeText(props.code)
  copied.value = true
  setTimeout(() => { copied.value = false }, 1500)
}
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <span v-if="label" class="text-[13px] font-medium">{{ label }}</span>
    <div class="relative rounded-lg border bg-muted/40">
      <pre class="overflow-x-auto px-3 py-2.5 pr-24 font-mono text-[12.5px] leading-5"><code>{{ code }}</code></pre>
      <Button size="sm" variant="outline" type="button" class="absolute top-1.5 right-1.5 font-sans" @click="copy">
        <Check v-if="copied" /><Copy v-else />{{ copied ? m.common.copied : m.common.copy }}
      </Button>
    </div>
  </div>
</template>
