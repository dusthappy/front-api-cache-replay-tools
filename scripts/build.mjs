import { build as viteBuild } from 'vite';
import vue from '@vitejs/plugin-vue';
import { build } from 'esbuild';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { watch } from 'node:fs';

async function compile() {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const define = { __APP_VERSION__: JSON.stringify(version) };
  await rm('dist', { recursive: true, force: true });
  await mkdir('dist', { recursive: true });
  await viteBuild({ configFile: false, plugins: [vue()], define, build: {
    outDir: 'dist', emptyOutDir: false, target: 'chrome120',
    rollupOptions: { input: 'options.html' }
  }});
  await viteBuild({ configFile: false, plugins: [vue()], define: { ...define, 'process.env.NODE_ENV': '"production"' }, build: {
    outDir: 'dist', emptyOutDir: false, target: 'chrome120',
    lib: { entry: 'src/content/index.ts', name: 'ApiCacheReplayContent', formats: ['iife'], fileName: () => 'content.js' }
  }});
  await build({ entryPoints: ['src/content/main.ts'], bundle: true, outfile: 'dist/main.js', format: 'iife', target: 'chrome120', sourcemap: true });
  await build({ entryPoints: ['src/background/index.ts'], bundle: true, outfile: 'dist/background.js', format: 'esm', target: 'chrome120', sourcemap: true });
  await writeFile('dist/manifest.json', JSON.stringify({
    manifest_version: 3, name: 'API Cache Replay', version, minimum_chrome_version: '120',
    description: '接口缓存与回放：按页面管理接口，自动缓存真实响应，一键回放与刷新，加速本地前端调试。',
    permissions: ['storage', 'scripting'], optional_host_permissions: ['http://*/*', 'https://*/*'],
    background: { service_worker: 'background.js', type: 'module' },
    action: { default_title: 'API Cache Replay · 网站设置' },
    options_page: 'options.html',
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" }
  }, null, 2));
  console.log('Chrome extension ready: dist/');
}
await compile();
if (process.argv.includes('--watch')) {
  let timer;
  let running = false;
  watch('src', { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(async () => { if (running) return; running = true; try { await compile(); } catch (e) { console.error(e); } finally { running = false; } }, 300);
  });
  console.log('Watching src/. Reload the extension and page after rebuild.');
}
