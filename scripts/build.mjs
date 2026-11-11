// Bundles main, preload and renderer with esbuild. No runtime npm dependencies
// are shipped: everything the app needs ends up in a handful of files in dist/.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, readdirSync } from 'node:fs';

const prod = process.env.NODE_ENV === 'production';
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/renderer', { recursive: true });

const common = { bundle: true, minify: prod, sourcemap: !prod, logLevel: 'warning', target: 'es2022' };
const nodeCommon = { ...common, platform: 'node', format: 'cjs', external: ['electron'] };

const tests = readdirSync('src/test').filter((f) => f.endsWith('.test.ts')).map((f) => `src/test/${f}`);

await Promise.all([
  build({ ...nodeCommon, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.js' }),
  build({ ...nodeCommon, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload.js' }),
  build({ ...nodeCommon, entryPoints: ['src/main/probe.ts'], outfile: 'dist/probe.js' }),
  build({ ...nodeCommon, entryPoints: ['src/main/probeMirror.ts'], outfile: 'dist/probeMirror.js' }),
  build({ ...nodeCommon, entryPoints: tests, outdir: 'dist/test' }),
  build({ ...nodeCommon, entryPoints: ['src/preload/mirrorPreload.ts'], outfile: 'dist/mirrorPreload.js' }),
  build({ ...common, platform: 'browser', format: 'iife', entryPoints: ['src/renderer/renderer.ts'], outfile: 'dist/renderer/renderer.js' }),
  build({ ...common, platform: 'browser', format: 'iife', entryPoints: ['src/renderer/mirror.ts'], outfile: 'dist/renderer/mirror.js' }),
]);
cpSync('src/renderer/mirror.html', 'dist/renderer/mirror.html');
cpSync('src/renderer/mirror.css', 'dist/renderer/mirror.css');

cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('src/renderer/styles.css', 'dist/renderer/styles.css');
cpSync('src/renderer/splash.html', 'dist/renderer/splash.html');
cpSync('src/renderer/splash.css', 'dist/renderer/splash.css');
