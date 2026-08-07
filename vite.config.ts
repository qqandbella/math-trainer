import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Served from GitHub Pages as a project site, i.e. under /<repo>/.
// Routing is hash-based, so the sub-path does not affect navigation.
const BASE = '/math-trainer/'

export default defineConfig({
  base: BASE,
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Math Trainer',
        short_name: 'Math',
        description: 'Arithmetic fluency trainer',
        theme_color: '#1b2a4a',
        background_color: '#f7f9fc',
        display: 'standalone',
        orientation: 'any',
        start_url: BASE,
        scope: BASE,
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Firebase is only reachable when signed in, which requires a network
        // anyway. Precaching it would make every offline-first device download
        // ~700 KB it can never use.
        globIgnores: ['**/firebase-*.js'],
        // The whole app must survive a cold start with no network (car use).
        navigateFallback: `${BASE}index.html`,
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        // Predictable names so the service worker can exclude them.
        manualChunks(id: string) {
          if (id.includes('node_modules/@firebase') || id.includes('node_modules/firebase')) {
            return 'firebase-sdk'
          }
          return undefined
        },
        chunkFileNames(chunkInfo: { name: string }) {
          return chunkInfo.name === 'firebase-sdk'
            ? 'assets/firebase-[hash].js'
            : 'assets/[name]-[hash].js'
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
