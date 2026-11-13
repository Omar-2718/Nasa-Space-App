import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The API serves /api and the patch images (/patches); the dev server proxies both.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: { '/api': 'http://localhost:3000', '/patches': 'http://localhost:3000' },
  },
})
