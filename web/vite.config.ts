import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig(({ mode }) => ({
  base: process.env.VITE_BASE_PATH || '/',
  publicDir: mode === 'pages' ? '../pages-pack/public' : 'public',
  plugins: [react()],
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
