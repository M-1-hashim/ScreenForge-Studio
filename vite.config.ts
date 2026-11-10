import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer/src'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'src/renderer/index.html'),
        agent: path.resolve(__dirname, 'src/renderer/agent.html'),
        region: path.resolve(__dirname, 'src/renderer/region.html'),
        toolbar: path.resolve(__dirname, 'src/renderer/toolbar.html'),
        annotation: path.resolve(__dirname, 'src/renderer/overlay/annotation.html'),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
