<script setup lang="ts">
defineProps<{ tone: 'green' | 'amber' | 'gray' | 'red' }>()
const COLORS = { green: 'bg-green-500', amber: 'bg-amber-500', gray: 'bg-zinc-400', red: 'bg-red-500' }
</script>

<template>
  <span class="inline-flex items-center gap-1.5 text-[13px]">
    <span class="size-[7px] shrink-0 rounded-full" :class="COLORS[tone]" />
    <slot />
  </span>
</template>
