import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'es2020',
  },
  worker: {
    format: 'es'
  },
  server: {
    port: 3000,
    open: true
  }
})
