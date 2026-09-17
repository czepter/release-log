<script setup lang="ts">
// Eine Auswahl aus wenigen Optionen mit je einer Erklärung -- statt eines
// Select, dessen Werte ("full", "timeline") niemand ohne Erklärung versteht.
defineProps<{ options: Array<{ value: string; label: string; hint: string }>; name: string }>()
const model = defineModel<string>({ required: true })
</script>

<template>
  <div role="radiogroup" class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
    <label
      v-for="option in options" :key="option.value"
      class="flex cursor-pointer flex-col gap-1 rounded-lg border bg-background px-3.5 py-3 transition-colors has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50"
      :class="model === option.value ? 'border-primary ring-1 ring-primary' : 'hover:bg-muted/50'"
    >
      <input v-model="model" type="radio" :name="name" :value="option.value" class="sr-only">
      <span class="text-sm font-medium">{{ option.label }}</span>
      <span class="text-xs leading-[17px] text-muted-foreground">{{ option.hint }}</span>
    </label>
  </div>
</template>
