import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: './src/index.ts',
    hono: './src/hono.ts',
    workers: './src/workers.ts',
  },
  dts: true,
  format: ['esm'],
  platform: 'neutral',
  sourcemap: true,
  clean: true,
  publint: true,
  deps: {
    neverBundle: ['hono', 'cloudflare:workers', 'node:async_hooks'],
  },
})
