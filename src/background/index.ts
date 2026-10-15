import type { RpcMessage, RpcResult, SiteConfig } from '../shared/types';
import { CacheCore, originPattern } from './core';
import { IndexedDBRepository } from './cache-store';

const repository = new IndexedDBRepository();
let browserSessionId: Promise<string> | undefined;
function getBrowserSessionId(): Promise<string> {
  // storage.session survives worker suspension, but resets when Chrome or the
  // extension restarts. Do not expose it to page/content script storage access.
  return browserSessionId ??= (async () => {
    const key = 'apiCacheReplayBrowserSessionId';
    const existing = (await chrome.storage.session.get(key))[key];
    if (typeof existing === 'string' && existing.length) return existing;
    const value = crypto.randomUUID();
    await chrome.storage.session.set({ [key]: value });
    return value;
  })().catch(error => { browserSessionId = undefined; throw error; });
}
let registrationQueue: Promise<unknown> = Promise.resolve();
async function synchronizeSites(sites: SiteConfig[]): Promise<void> {
  const job = registrationQueue.then(async () => {
    const allowed = [];
    for (const site of sites) if (await chrome.permissions.contains({ origins: [originPattern(site.origin)] })) allowed.push(site);
    const matches = [...new Set(allowed.map(site => originPattern(site.origin)))];
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const managed = existing.filter(script => script.id.startsWith('api-cache-replay-')).map(script => script.id);
    if (managed.length) await chrome.scripting.unregisterContentScripts({ ids: managed });
    if (matches.length) await chrome.scripting.registerContentScripts([
      { id: 'api-cache-replay-main', matches, js: ['main.js'], runAt: 'document_start', world: 'MAIN', allFrames: false, persistAcrossSessions: true },
      { id: 'api-cache-replay-content', matches, js: ['content.js'], runAt: 'document_start', world: 'ISOLATED', allFrames: false, persistAcrossSessions: true },
    ]);
  });
  registrationQueue = job.catch(() => undefined);
  return job;
}
const core = new CacheCore(repository, {
  extensionId: chrome.runtime.id,
  getBrowserSessionId,
  hasPermission: origin => chrome.permissions.contains({ origins: [originPattern(origin)] }),
  synchronizeSites,
  openOptions: () => chrome.runtime.openOptionsPage(),
});
export async function handleMessage(message: RpcMessage, sender: chrome.runtime.MessageSender): Promise<RpcResult> {
  try {
    const data = await core.handleMessage(message, sender);
    if (message.type === 'PANEL' && data) Object.assign(data, { extensionVersion: chrome.runtime.getManifest().version });
    if (['SITE_SAVE', 'SITE_DELETE', 'PAUSE', 'SITE_PATCH', 'PAGE_PATCH', 'RULE_PATCH', 'CLEAR', 'CACHE_CLEAR_ALL', 'BIND_ADD', 'BIND_DELETE'].includes(message.type)) {
      await chrome.storage.local.set({ revision: crypto.randomUUID() });
    }
    return { ok: true, data };
  }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : '扩展处理失败' }; }
}
chrome.runtime.onMessage.addListener((message: RpcMessage, sender, sendResponse) => {
  void handleMessage(message, sender).then(sendResponse);
  return true;
});
async function refreshRegistration(): Promise<void> {
  try { const sites = await repository.run(async session => Object.values(session.state.sites)); await synchronizeSites(sites); }
  catch (error) { console.warn('API Cache Replay: 无法注册内容脚本', error); }
}
chrome.runtime.onInstalled.addListener(() => { void refreshRegistration(); });
chrome.runtime.onStartup.addListener(() => { void refreshRegistration(); });
chrome.permissions.onAdded.addListener(() => { void refreshRegistration(); });
chrome.permissions.onRemoved.addListener(() => {
  // Already-injected scripts fail closed on their next request because every RPC
  // rechecks exact origin and host permission. Existing tickets are invalidated.
  void repository.run(async session => { for (const site of Object.values(session.state.sites)) if (!await chrome.permissions.contains({ origins: [originPattern(site.origin)] })) site.generation++; })
    .then(async () => { await chrome.storage.local.set({ revision: crypto.randomUUID() }); await refreshRegistration(); });
});
chrome.action.onClicked.addListener(() => { void chrome.runtime.openOptionsPage(); });
