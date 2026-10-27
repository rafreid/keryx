import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Build straight into the backend's static folder so the FastAPI app serves it.
export default defineConfig({
  plugins: [react()],
  build: { outDir: '../backend/static', emptyOutDir: true },
  server: { proxy: { '/api': 'http://100.99.160.22:9120' } },
})
