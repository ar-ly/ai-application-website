import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      // 前端请求 /api/* 时自动转发到本地后端代理服务（3001）
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      // 生成的应用独立访问链接（/apps/:sid/:mid）也由后端提供
      '/apps': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
