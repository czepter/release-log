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
        { rel: 'icon', href: '/favicon.ico', sizes: '48x48' },
        { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
        { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
      ],
    },
  },
  routeRules: {
    '/dashboard/connections': { redirect: '/konto' },
    '/admin/allowlist': { redirect: '/konto' },
  },
  typescript: { tsConfig: { compilerOptions: { allowImportingTsExtensions: true } } },
})
