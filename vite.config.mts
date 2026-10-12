import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: path.join(import.meta.dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: { outDir: path.join(import.meta.dirname, 'dist/renderer'), emptyOutDir: true },
  test: { root: import.meta.dirname, include: ['tests/**/*.test.ts'], testTimeout: 30000 },
} as any);
