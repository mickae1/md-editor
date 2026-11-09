import { defineConfig } from 'vite'

// Development: `python ../server/app.py <folder> --port 8765 --no-window`, then `npm run dev`.
export default defineConfig({
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8765', '/raw': 'http://127.0.0.1:8765' },
    fs: { allow: ['..'] }, // lang/en.json is outside web/
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2000, target: 'es2022' }, // es2022: top-level await (boot.ts)
})
