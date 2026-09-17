<script setup lang="ts">
defineProps<{ options: Array<{ value: string; label: string }>; label: string }>()
const model = defineModel<string>({ required: true })
</script>

<template>
  <div role="radiogroup" :aria-label="label" class="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
    <button
      v-for="option in options" :key="option.value" type="button" role="radio" :aria-checked="model === option.value"
      class="h-8 rounded-md text-[13px] transition-colors"
      :class="model === option.value ? 'bg-background font-medium shadow-xs' : 'text-muted-foreground hover:text-foreground'"
      @click="model = option.value"
    >
      {{ option.label }}
    </button>
  </div>
</template>
