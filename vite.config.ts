import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { dddParserPlugin } from './vite-plugin-ddd-parser'

export default defineConfig({
  plugins: [react(), dddParserPlugin()],
  server: {
    proxy: {
      '/api/parse-card': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        rewrite: () => '/parse-card',
      },
    },
  },
})
