import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: process.env.BASE_PATH || '/',
  plugins: [react()],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers', '@ffmpeg/ffmpeg', '@ffmpeg/util'] },
  test: { include: ['src/**/*.test.ts'] }
});
