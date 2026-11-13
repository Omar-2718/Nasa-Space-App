import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The API serves /api, patch images (/patches) and map layers (/layers); the dev server proxies them.
// API_URL lets a second copy point at another API (e.g. API_URL=http://localhost:3001 npx vite --port 5174).
const API = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env.API_URL ?? 'http://localhost:3000'
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: Object.fromEntries(['/api', '/patches', '/layers'].map(p => [p, API])),
  },
})
