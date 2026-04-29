import path from 'path';

export default {
  // We keep the "public" folder as Vite root for local dev (if you still use Vite).
  root: path.resolve(__dirname, 'public'),

  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
  },

  // IMPORTANT: build output must NOT be the same as root (or its parent).
  // Output to /dist and serve it in production if you want bundled assets.
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        admin: path.resolve(__dirname, 'public/admin.html'),
        panel: path.resolve(__dirname, 'public/panel.html'),
        index: path.resolve(__dirname, 'public/index.html'),
      },
    },
  },
};
