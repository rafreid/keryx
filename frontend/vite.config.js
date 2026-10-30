import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Build straight into the backend's static folder so the FastAPI app serves it.
export default defineConfig({
  plugins: [react()],
  build: { outDir: '../backend/static', emptyOutDir: true },
  // `npm run dev` proxies /api to a running Keryx backend; point KERYX_API at yours
  server: { proxy: { '/api': process.env.KERYX_API || 'http://localhost:9120' } },
  test: { environment: 'node', include: ['src/**/*.test.js'] },
})
