import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');

mkdirSync('dist/codicons', { recursive: true });
for (const file of ['codicon.css', 'codicon.ttf']) {
  cpSync(`node_modules/@vscode/codicons/dist/${file}`, `dist/codicons/${file}`);
}

/** @type {esbuild.BuildOptions[]} */
const builds = [
  {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['vscode'],
    sourcemap: watch,
    minify: !watch,
    logLevel: 'info',
  },
  {
    entryPoints: ['src/webview/main.ts'],
    bundle: true,
    outfile: 'dist/webview.js',
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    sourcemap: watch,
    minify: !watch,
    logLevel: 'info',
  },
];

if (watch) {
  for (const options of builds) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  }
} else {
  // Source maps from an earlier watch build must not ship in the .vsix.
  for (const map of ['dist/extension.js.map', 'dist/webview.js.map']) rmSync(map, { force: true });
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
