import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    https: true
  },
  build: {
    chunkSizeWarningLimit: 700
  },
  plugins: [
    basicSsl(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg}']
      },
      manifest: {
        name: 'JanVaani',
        short_name: 'JanVaani',
        theme_color: '#0a0a0f',
        background_color: '#0a0a0f',
        display: 'standalone',
        description: 'Offline public alert system — जनवाणी',
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable'
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      }
    })
  ]
});
