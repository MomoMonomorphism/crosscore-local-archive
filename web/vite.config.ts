import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const webRoot = fileURLToPath(new URL('.', import.meta.url))
const references = JSON.parse(readFileSync(resolve(webRoot, '../spine_resource_references.json'), 'utf8')) as Record<string, { platform: string; sha256: string }>
const referenceVersions = Object.fromEntries(Object.entries(references).map(([packageName, reference]) =>
  [packageName.replace(/^prefabs_spine_/, ''), `${reference.platform}-${reference.sha256.slice(0, 8)}`]))

export default defineConfig(({ mode }) => ({
  base: process.env.VITE_BASE_PATH || '/',
  publicDir: mode === 'pages' ? '../pages-pack/public' : 'public',
  plugins: [react()],
  // Pages uses its selected pack's fingerprints; local builds use the pinned
  // package versions without exposing source paths or diagnostic metadata.
  define: { __SPINE_REFERENCE_VERSIONS__: JSON.stringify(mode === 'pages' ? {} : referenceVersions) },
  build: {
    outDir: mode === 'pages' ? '../dist-pages' : '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: mode === 'pages' ? {
        main: resolve(webRoot, 'index.html'),
        mobileAcceptance: resolve(webRoot, 'mobile-acceptance.html'),
      } : undefined,
      output: {
        // Vendor split: the big runtime stacks become independently cached
        // chunks; route views are split automatically by React.lazy in App.tsx.
        manualChunks: {
          react: ['react', 'react-dom'],
          pixi: ['pixi.js'],
          spine: ['@esotericsoftware/spine-pixi-v7'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8798',
      '/assets': 'http://127.0.0.1:8798',
    },
  },
}))
