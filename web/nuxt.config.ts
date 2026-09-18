import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  compatibilityDate: '2026-09-01',
  devtools: { enabled: false },
  modules: ['shadcn-nuxt'],
  css: ['~/assets/css/main.css'],
  shadcn: { prefix: '', componentDir: '~/components/ui' },
  vite: { plugins: [tailwindcss()] },
  app: {
    head: {
      link: [
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap' },
      ],
    },
  },
  routeRules: {
    '/dashboard/connections': { redirect: '/konto' },
    '/admin/allowlist': { redirect: '/konto' },
  },
  typescript: { tsConfig: { compilerOptions: { allowImportingTsExtensions: true } } },
})
