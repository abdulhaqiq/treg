import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { handleApi } from './api.js'

// In dev the API runs inside Vite's own server, so `npm run dev` is one process.
export default defineConfig({
  plugins: [vue(), {
    name: 'openenrich-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => (req.url.startsWith('/api/') ? handleApi(req, res) : next()))
    },
  }],
})
