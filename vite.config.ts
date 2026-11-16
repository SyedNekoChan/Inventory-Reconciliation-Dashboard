import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves this project under /<repo-name>/.
// Override with BASE_PATH=/ for root-domain hosting or local preview at root.
const base = process.env.BASE_PATH ?? '/Inventory-Reconciliation-Dashboard/';

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          sheet: ['xlsx'],
          charts: ['recharts'],
        },
      },
    },
  },
});
