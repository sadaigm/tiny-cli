import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { inkWebPlugin } from 'ink-web/vite';
import { fileURLToPath } from 'node:url';

const empty = fileURLToPath(new URL('./shims/empty.js', import.meta.url));

// Web mode — boots the real <App> inside an xterm.js terminal in the browser.
// Run with: pnpm --filter tiny-cli web
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), inkWebPlugin()],
  server: {
    port: 5173,
  },
  resolve: {
    alias: {
      // planReader.ts and other Node-side utils transitively imported by <App>
      // use fs/promises — a subpath ink-web's fs shim doesn't cover. These utils
      // only run during plan execution (/continue), never during plain UI render.
      'fs/promises': empty,
      'node:fs/promises': empty,
      // Stub @tiny-cli/core so its node-fetch chain never enters the browser
      // bundle. Web mode injects a fake agent/session via main.tsx; the only
      // value import from core that <App> needs is SessionManager.createSession.
      '@tiny-cli/core': fileURLToPath(new URL('./shims/core.js', import.meta.url)),
      // Stub the file-mention module: it uses Node fs/path to scan the
      // workspace, which doesn't exist in the browser. Returns an empty index
      // and passes messages through unchanged (no [@file] expansion).
      '/src/file-mention.js': fileURLToPath(new URL('./shims/file-mention.js', import.meta.url)),
      '../file-mention.js': fileURLToPath(new URL('./shims/file-mention.js', import.meta.url)),
      '../../file-mention.js': fileURLToPath(new URL('./shims/file-mention.js', import.meta.url)),
      // node-fetch + fetch-blob are Node-only and pull in stream/fs APIs that
      // crash ink-web's shims. They're never imported in web mode (core is
      // aliased away above), so alias them to the empty stub too.
      'node-fetch': empty,
      'fetch-blob': empty,
    },
  },
  optimizeDeps: {
    // Exclude Node-only deps from eager optimization. Vite's scanner sees
    // node-fetch in the package's dependencies and pre-bundles it, hitting
    // ink-web's incomplete stream/fs shims. Excluding keeps them out of the
    // browser bundle entirely.
    exclude: ['node-fetch', 'fetch-blob', '@tiny-cli/core'],
  },
  define: {
    // <App> calls the bare global `process.cwd()` at mount (file-mention
    // index). ink-web aliases the `process` *module*, but the bare global
    // resolves to Vite's default polyfill, which has no cwd(). Rewrite it to
    // a literal so the call works (returns "/" — fine for UI debugging).
    'process.cwd': '() => "/"',
  },
});


