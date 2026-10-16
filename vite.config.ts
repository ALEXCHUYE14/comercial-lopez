import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Comercial López JYD EIRL - Gestion Comercial',
        short_name: 'CL POS',
        description: 'Sistema de punto de venta y gestion en tiempo real',
        theme_color: '#0a0a0a',
        background_color: '#fafaf9',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,mp3}'],
        // Las fotos de negocio (logo/tienda) no se precachean: pueden pesar
        // varios MB y no son parte del app shell; se sirven por red normal.
        // "xlsx-*.js" (la libreria de Excel del inventario, ~400KB) tampoco:
        // se carga con import() dinamico SOLO cuando alguien realmente usa
        // Exportar/Importar Excel, que en la practica es poca gente y pocas
        // veces al mes — precachearla de entrada la bajaria a CADA
        // dispositivo de CADA cajero, sin que la mayoria la use nunca. Queda
        // cubierta por su propia regla de runtimeCaching mas abajo: la
        // primera vez que alguien la use se guarda en su dispositivo, sin
        // pedirla de nuevo despues.
        globIgnores: ['**/img/**', '**/assets/xlsx-*.js', '**/assets/jszip*.js'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        // Borra las caches de versiones anteriores al activar el nuevo
        // service worker, para que nunca sirva JS/CSS de un despliegue viejo.
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          // Datos de Supabase (productos, precios, stock, ventas...): SIEMPRE
          // de la red; la copia guardada solo se usa si NO hay conexion (para
          // que el POS abra offline). Antes tenia networkTimeoutSeconds: 5 —
          // con internet lento (respuesta en mas de 5 s) el service worker
          // servia la copia vieja del cache aunque hubiera red, y el POS
          // mostraba precios y stock desactualizados sin ningun aviso. Tambien
          // se limita la antiguedad de la copia (24 h) y se cambio el nombre
          // del cache para descartar las copias viejas ya guardadas.
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/rest/v1'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-api-v2',
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [200] },
            },
          },
          // Fotos de productos/negocio (bucket de Storage): la URL guardada
          // en la base ya lleva su propio "?t=" que cambia solo cuando la
          // foto cambia (ver useProductoImagen.ts), asi que es seguro
          // servirla siempre desde el cache del dispositivo sin volver a
          // pedirla a Supabase. Antes, al no estar cubierta por ninguna
          // regla aqui, cada foto se re-descargaba por red normal (sujeta
          // solo al cacheControl de 1 hora de Supabase) cada vez que se
          // abria o recargaba la app — la causa real del "Cached Egress"
          // que superaba la cuota del plan gratuito.
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/storage/v1/object/public/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'supabase-storage-imagenes',
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // La libreria de Excel (ver globIgnores arriba): se guarda en el
          // dispositivo la primera vez que se usa, no antes.
          {
            urlPattern: ({ url }) => /\/assets\/xlsx-.*\.js$/.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'lib-xlsx',
              expiration: { maxEntries: 2, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // Igual que xlsx: solo se usa al descargar/subir fotos en bloque.
          {
            urlPattern: ({ url }) => /\/assets\/jszip.*\.js$/.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'lib-jszip',
              expiration: { maxEntries: 2, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    host: true,
  },
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react') || id.includes('react-dom') || id.includes('react-router')) return 'react'
            if (id.includes('recharts')) return 'charts'
            if (id.includes('html5-qrcode')) return 'scanner'
            if (id.includes('@supabase')) return 'supabase'
          }
        },
      },
    },
  },
})
