import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const devCertificatePath = path.join(rootDir, '.certs', 'janvaani-dev.pfx');
const localHttps = fs.existsSync(devCertificatePath)
  ? {
    pfx: fs.readFileSync(devCertificatePath),
    passphrase: process.env.JANVAANI_CERT_PASSPHRASE || 'janvaani'
  }
  : true;
const needsBasicSsl = localHttps === true;

export default defineConfig({
  server: {
    host: '0.0.0.0',
    https: localHttps
  },
  preview: {
    host: '0.0.0.0',
    https: localHttps
  },
  build: {
    chunkSizeWarningLimit: 700
  },
  plugins: [
    needsBasicSsl ? basicSsl() : undefined,
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg}'],
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true
      },
      manifest: {
        id: '/',
        name: 'JanVaani',
        short_name: 'JanVaani',
        theme_color: '#0a0a0f',
        background_color: '#0a0a0f',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        orientation: 'portrait',
        lang: 'en',
        categories: ['utilities', 'news', 'social'],
        description: 'Offline public alert system for civilians during internet blackouts.',
        shortcuts: [
          {
            name: 'Create Alert',
            short_name: 'Create',
            url: '/#create',
            icons: [
              {
                src: '/icons/icon-192.png',
                sizes: '192x192',
                type: 'image/png'
              }
            ]
          },
          {
            name: 'Scan QR',
            short_name: 'Scan',
            url: '/#scan',
            icons: [
              {
                src: '/icons/icon-192.png',
                sizes: '192x192',
                type: 'image/png'
              }
            ]
          }
        ],
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
  ].filter(Boolean)
});
