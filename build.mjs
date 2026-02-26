import * as esbuild from 'esbuild'

await Promise.all([
  esbuild.build({
    entryPoints: ['src/hook/index.ts'],
    bundle: true,
    minify: true,
    platform: 'node',
    target: 'node18',
    outfile: 'dist/hook.js',
    banner: { js: '#!/usr/bin/env node' },
  }),
  esbuild.build({
    entryPoints: ['src/bridge/daemon.ts'],
    bundle: true,
    minify: true,
    platform: 'node',
    target: 'node18',
    outfile: 'dist/bridge.js',
    banner: { js: '#!/usr/bin/env node' },
  }),
])
console.log('Build complete')
