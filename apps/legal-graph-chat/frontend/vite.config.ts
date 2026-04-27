import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const threeChunk = /node_modules[\\/]three[\\/]/;
const forceGraph3dChunk = /node_modules[\\/](react-force-graph-3d|3d-force-graph|three-forcegraph)[\\/]/;

export default defineConfig({
  plugins: [react()],
  build: {
    // Three.js is intentionally isolated into a lazy Full 3D chunk. Keep the warning budget
    // above the known lazy chunk size so real regressions show up outside this accepted cost.
    chunkSizeWarningLimit: 1450,
    rolldownOptions: {
      output: {
        codeSplitting: {
          includeDependenciesRecursively: false,
          groups: [
            {
              name: 'three',
              test: (id) => threeChunk.test(id),
              priority: 20,
              minSize: 0,
            },
            {
              name: 'react-force-graph-3d',
              test: (id) => forceGraph3dChunk.test(id),
              priority: 10,
              minSize: 0,
            },
          ],
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
