import { createApp } from 'vue';
import { CHANNEL } from '../shared/types';
import App from '../ui/App.vue';
import styles from '../ui/styles.css?inline';

const MAX_BRIDGE_SIZE = 2.2 * 1024 * 1024;
const recentIds = new Set<string>();
let refreshTimer: number | undefined;

function refreshPanel(): void {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => window.dispatchEvent(new CustomEvent('acr:refresh')), 120);
}

window.addEventListener('message', async event => {
  if (event.source !== window || event.origin !== location.origin) return;
  const message = event.data;
  if (!message || typeof message !== 'object' || message.channel !== CHANNEL) return;
  if (message.direction === 'route' && typeof message.pageUrl === 'string' && message.pageUrl.length <= 8192) {
    try {
      if (new URL(message.pageUrl).origin === location.origin) window.dispatchEvent(new CustomEvent('acr:route', { detail: message.pageUrl }));
    } catch { /* Invalid page messages are ignored. */ }
    return;
  }
  if (message.direction !== 'to-extension' || !['PREPARE', 'COMPLETE'].includes(message.type) || typeof message.id !== 'string' || message.id.length > 100 || !/^[\w:-]+$/.test(message.id) || !message.payload || typeof message.payload !== 'object') return;
  if (recentIds.has(message.id)) return;
  try { if (new TextEncoder().encode(JSON.stringify(message)).byteLength > MAX_BRIDGE_SIZE) return; } catch { return; }
  recentIds.add(message.id);
  if (recentIds.size > 500) recentIds.delete(recentIds.values().next().value!);
  let result;
  try { result = await chrome.runtime.sendMessage({ type: message.type, payload: message.payload }); }
  catch { result = { ok: false, error: '扩展连接不可用，已直通原始请求。' }; }
  window.postMessage({ channel: CHANNEL, direction: 'to-main', id: message.id, ...result }, location.origin);
  refreshPanel();
});

function mount(): void {
  if (document.querySelector('[data-api-cache-replay]')) return;
  const host = document.createElement('div');
  host.setAttribute('data-api-cache-replay', '');
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0 auto auto 0!important;width:0!important;height:0!important;z-index:2147483646!important;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = styles;
  const root = document.createElement('div');
  shadow.append(style, root);
  document.documentElement.append(host);
  createApp(App).mount(root);
}

if (document.documentElement) mount();
else document.addEventListener('DOMContentLoaded', mount, { once: true });
