<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import type { ApiScopeDiscoveryState, SiteConfig } from '../shared/types';
import { APP_VERSION } from '../shared/version';
import { rpc, splitList } from '../ui/rpc';
import StorageUsage from './StorageUsage.vue';

const installedVersion = (() => { try { return chrome.runtime.getManifest().version; } catch { return APP_VERSION; } })();
const DEFAULT_SITE_ORIGIN = 'http://localhost:3000/';
const sites = ref<SiteConfig[]>([]);
const paused = ref(false);
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const notice = ref('');
const selectedId = ref('');
const deleting = ref(false);
const permissions = ref<Record<string, boolean>>({});
const scopeDiscovery = ref<ApiScopeDiscoveryState | null>(null);
const scopeLoading = ref(false);
const scopeError = ref('');
let scopeGeneration = 0;
let scopeInterval: number | undefined;
let disposed = false;
const form = reactive({ origin: DEFAULT_SITE_ORIGIN, environmentId: 'local', apiScopeMode: 'all' as 'all' | 'custom', apiScopes: '', routeMode: 'history' as SiteConfig['routeMode'], pageIdentityQueryKeys: '', identityMode: 'auto' as SiteConfig['identityMode'], sessionPartition: '', ttl: '30', authPaths: 'login\nlogout\ntoken\nrefresh\nsignin\nsignout', captureEnabled: true, cacheEnabled: true });
const selected = computed(() => sites.value.find(site => site.id === selectedId.value));
const permissionPattern = (origin: string): string => { const url = new URL(origin); return `${url.protocol}//${url.hostname}/*`; };

function select(site?: SiteConfig): void {
  selectedId.value = site?.id || ''; deleting.value = false; error.value = ''; notice.value = '';
  scopeGeneration++; scopeLoading.value = false; scopeDiscovery.value = null; scopeError.value = '';
  Object.assign(form, {
    origin: site?.origin ?? DEFAULT_SITE_ORIGIN, environmentId: site?.environmentId || 'local', apiScopeMode: site?.apiScopeMode || 'all',
    apiScopes: site?.apiScopes.map(scope => `${scope.origin}${scope.pathPrefix}`).join('\n') || '',
    routeMode: site?.routeMode || 'history', pageIdentityQueryKeys: site?.pageIdentityQueryKeys.join(', ') || '',
    identityMode: site?.identityMode || 'auto', sessionPartition: site?.sessionPartition || '', ttl: String((site?.defaultTTL ?? 1800000) / 60000),
    authPaths: site?.authPaths.join('\n') ?? 'login\nlogout\ntoken\nrefresh\nsignin\nsignout', captureEnabled: site?.captureEnabled ?? true, cacheEnabled: site?.cacheEnabled ?? true,
  });
  void loadScopes();
}
async function loadScopes(): Promise<void> {
  const siteId = selectedId.value;
  if (!siteId || scopeLoading.value || disposed) return;
  const generation = ++scopeGeneration;
  scopeLoading.value = true;
  try {
    const discovery = await rpc<ApiScopeDiscoveryState>('API_SCOPES_GET', { siteId });
    if (generation !== scopeGeneration || selectedId.value !== siteId) return;
    scopeDiscovery.value = discovery; scopeError.value = '';
  } catch (failure) {
    if (generation === scopeGeneration && selectedId.value === siteId) scopeError.value = `范围列表暂时无法更新：${(failure as Error).message}`;
  } finally {
    if (generation === scopeGeneration) scopeLoading.value = false;
  }
}
async function load(): Promise<void> {
  try {
    const data = await rpc<{ sites: SiteConfig[]; paused: boolean }>('OPTIONS_GET');
    sites.value = data.sites; paused.value = data.paused;
    const results = await Promise.all(sites.value.map(async site => [site.id, await chrome.permissions.contains({ origins: [permissionPattern(site.origin)] })] as const));
    permissions.value = Object.fromEntries(results);
  } catch (failure) { error.value = (failure as Error).message; }
  finally { loading.value = false; }
}
function parseForm(): SiteConfig {
  let origin: URL;
  try { origin = new URL(form.origin); } catch { throw new Error('请输入完整的网站地址，例如 http://localhost:5173。'); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) throw new Error('网站只支持 HTTP 或 HTTPS 地址。Chrome 内置页面和应用商店不支持注入。');
  if (origin.hostname === 'chromewebstore.google.com' || (origin.hostname === 'chrome.google.com' && origin.pathname.startsWith('/webstore'))) throw new Error('Chrome 应用商店不支持内容脚本，请填写你的开发网站。');
  if (!form.environmentId.trim()) throw new Error('请填写后端环境标识，例如 local 或 staging。');
  const parseScopes = () => form.apiScopes.split('\n').map(value => value.trim()).filter(Boolean).map(value => {
    let url: URL;
    try { url = new URL(value, origin.origin); } catch { throw new Error(`API 范围地址无效：${value}`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash || url.username || url.password) throw new Error('API 范围只填写 HTTP(S) 地址和路径前缀，不填写参数、片段或凭证。');
    return { origin: url.origin, pathPrefix: url.pathname };
  });
  let scopes: SiteConfig['apiScopes'];
  try { scopes = parseScopes(); }
  catch (failure) {
    if (form.apiScopeMode === 'custom') throw failure;
    scopes = selected.value?.apiScopes ?? [];
  }
  if (form.apiScopeMode === 'custom' && !scopes.length) throw new Error('请填写自定义 API 范围，或切换为自动识别并采用。');
  if (form.identityMode === 'session' && !form.sessionPartition.trim()) throw new Error('Cookie 会话模式需要填写分区名称，用来隔离不同账号。');
  if (!Number.isFinite(Number(form.ttl)) || Number(form.ttl) < 0) throw new Error('默认有效期需为非负分钟数。');
  return {
    id: selectedId.value || crypto.randomUUID(), origin: origin.origin, environmentId: form.environmentId.trim(), routeMode: form.routeMode,
    pageIdentityQueryKeys: splitList(form.pageIdentityQueryKeys), apiScopeMode: form.apiScopeMode, apiScopes: scopes, captureEnabled: form.captureEnabled, cacheEnabled: form.cacheEnabled,
    identityMode: form.identityMode, sessionPartition: form.sessionPartition.trim(), defaultTTL: Number(form.ttl) * 60000,
    generation: selected.value?.generation || 0, floatingPosition: selected.value?.floatingPosition, authPaths: splitList(form.authPaths),
  };
}
async function save(): Promise<void> {
  error.value = ''; notice.value = '';
  let site: SiteConfig;
  try { site = parseForm(); } catch (failure) { error.value = (failure as Error).message; return; }
  // The permission request must be initiated synchronously from the submit gesture.
  const grant = chrome.permissions.request({ origins: [permissionPattern(site.origin)] });
  busy.value = true;
  try {
    if (!await grant) throw new Error('网站访问授权未完成。再次点击保存并允许访问后，扩展才会启用。');
    const saved = await rpc<SiteConfig>('SITE_SAVE', { site });
    await load(); select(sites.value.find(item => item.id === saved.id));
    notice.value = '网站已保存。刷新业务页面后，新设置即可生效。';
  } catch (failure) { error.value = (failure as Error).message; }
  finally { busy.value = false; }
}
async function remove(): Promise<void> {
  if (!selected.value) return;
  busy.value = true; error.value = '';
  try { await rpc('SITE_DELETE', { siteId: selected.value.id }); await load(); select(sites.value[0]); notice.value = '网站配置及其缓存已删除。'; }
  catch (failure) { error.value = (failure as Error).message; }
  finally { busy.value = false; }
}
async function togglePause(): Promise<void> {
  busy.value = true; error.value = '';
  try { await rpc('PAUSE', { paused: !paused.value }); await load(); }
  catch (failure) { error.value = (failure as Error).message; }
  finally { busy.value = false; }
}
function resetPartition(): void { form.sessionPartition = `session-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`; }
onMounted(async () => {
  scopeInterval = window.setInterval(() => { if (document.visibilityState === 'visible' && selectedId.value) void loadScopes(); }, 2000);
  await load();
  if (!disposed && sites.value.length) select(sites.value[0]);
});
onBeforeUnmount(() => { disposed = true; clearInterval(scopeInterval); scopeGeneration++; });
</script>

<template>
  <div class="settings-shell">
    <header class="app-header"><a class="brand" href="options.html" aria-label="API Cache Replay 网站设置"><svg viewBox="0 0 28 28" aria-hidden="true"><path d="M23 10A9 9 0 0 0 7 7L4 10M4 5v5h5m-4 8a9 9 0 0 0 16 3l3-3m0 5v-5h-5"/><path d="m12 10 6 4-6 4z" class="play"/></svg><span><span class="brand-title"><strong>API Cache Replay</strong><em class="extension-version" title="已安装的扩展版本">v{{ installedVersion }}</em></span><small>接口缓存与回放</small></span></a><button class="pause-button" :class="{ paused }" :disabled="busy" @click="togglePause"><span class="status-dot"></span>{{ paused ? '已暂停 · 恢复运行' : '运行中 · 暂停扩展' }}</button></header>
    <main>
      <div class="page-title"><div><h1>网站设置</h1><p>添加开发网站，接口自动发现、缓存与回放。</p></div><span class="local-label">仅保存在本机</span></div>
      <div v-if="paused" class="banner warning" role="status">扩展当前已暂停。所有网站停止采集与缓存回放，页面请求照常执行。</div>
      <StorageUsage />
      <div class="workspace">
        <aside class="site-sidebar" aria-label="已配置网站"><div class="sidebar-heading"><h2>开发网站</h2><span>{{ sites.length }}</span></div><p v-if="loading" class="sidebar-empty">正在读取网站…</p><p v-else-if="!sites.length" class="sidebar-empty">添加第一个网站后，页面右上角会出现调试按钮。</p><button v-for="site in sites" :key="site.id" class="site-item" :class="{ selected: selectedId === site.id }" :aria-pressed="selectedId === site.id" @click="select(site)"><strong>{{ site.origin }}</strong><span>{{ site.environmentId }}<em v-if="!permissions[site.id]">需重新授权</em></span></button><button class="add-site" :class="{ selected: !selectedId }" @click="select()"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>添加网站</button><div class="sidebar-note"><strong>精确到协议、主机和端口</strong><p>localhost 与 127.0.0.1、不同端口分别管理，缓存不会自动互通。</p></div></aside>
        <form class="site-form" @submit.prevent="save">
          <div class="form-heading"><h2>{{ selected ? '配置开发网站' : '添加开发网站' }}</h2><span v-if="selected" class="permission-status" :class="{ missing: !permissions[selected.id] }">{{ permissions[selected.id] ? '已获网站授权' : '访问权限已撤销' }}</span></div>
          <p v-if="error" class="banner error" role="alert">{{ error }}</p><p v-if="notice" class="banner success" role="status">{{ notice }}</p>
          <section class="site-basics" aria-label="网站地址">
            <label>前端网站地址<input v-model="form.origin" required maxlength="2048" type="url" placeholder="http://localhost:3000/" autocomplete="off" spellcheck="false"/><span class="help">默认使用 localhost:3000，可直接修改为其他开发网站地址。</span></label>
            <p class="defaults-note">默认缓存全部 GET / POST JSON 接口，无需手动设置身份。可在悬浮面板中关闭不需要缓存的接口。</p>
          </section>
          <section class="scope-discovery-section" aria-label="已自动识别的 API 范围">
            <div class="scope-discovery-heading"><h3>已自动识别的 API 范围</h3><span v-if="scopeDiscovery" class="scope-mode" :class="{ custom: scopeDiscovery.mode === 'custom' }">{{ scopeDiscovery.mode === 'all' ? '已自动采用' : '已限定范围' }}</span></div>
            <p v-if="!selected" class="help">添加网站并刷新业务页面后，正常操作即可自动识别并采用 API 范围。</p>
            <p v-else-if="scopeLoading && !scopeDiscovery" class="help" role="status">正在读取已识别范围…</p>
            <template v-else-if="scopeDiscovery">
              <p v-if="scopeDiscovery.mode === 'custom'" class="help">当前仅使用自定义范围，不会自动扩大。可在高级设置中切换为自动识别并采用。</p>
              <p v-else-if="!scopeDiscovery.scopes.length" class="help">正常操作业务页面后，自动识别并采用 API 范围，无需确认。</p>
              <p v-else class="help">根据业务页面成功返回的 JSON 接口自动识别，无需确认。</p>
              <div v-if="scopeDiscovery.scopes.length" class="scope-discovery-list" role="list" tabindex="0" aria-label="已识别范围列表">
                <div v-for="scope in scopeDiscovery.scopes" :key="scope.id" class="scope-discovery-item" role="listitem">
                  <code>{{ scope.origin }}{{ scope.pathPrefix }}</code>
                  <div class="scope-discovery-meta"><span>{{ scope.methods.join(' / ') }}</span><span>{{ scope.endpointCount }}{{ scope.endpointCountCapped ? '+' : '' }} 个接口</span></div>
                  <details v-if="scope.examples.length" class="scope-examples"><summary>查看接口示例</summary><ul><li v-for="example in scope.examples.slice(0, 3)" :key="example"><code>{{ example }}</code></li></ul></details>
                </div>
              </div>
            </template>
            <p v-if="scopeError" class="scope-discovery-error" role="status">{{ scopeError }}<button type="button" class="text-button" :disabled="scopeLoading" @click="loadScopes">重试</button></p>
          </section>
          <details class="advanced-settings">
            <summary>高级设置<span>接口范围、身份、有效期与路由</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg></summary>
            <section class="form-section" aria-labelledby="scope-heading">
              <h3 id="scope-heading">接口范围</h3>
              <label>发现范围<select v-model="form.apiScopeMode"><option value="all">自动识别并采用（默认）</option><option value="custom">仅自定义 API 范围</option></select><span class="help">默认自动识别并采用同源及跨域接口，无需填写 API 地址。自定义模式只使用已填写的范围。</span></label>
              <label v-if="form.apiScopeMode === 'custom'" class="scope-field">API 范围<textarea v-model="form.apiScopes" rows="3" placeholder="/api&#10;http://localhost:8080/api" spellcheck="false"></textarea><span class="help">每行一组地址和路径前缀；只采集范围内的请求。</span></label>
              <div class="switch-row"><label class="checkbox-label"><input v-model="form.captureEnabled" type="checkbox"/>自动发现页面接口</label><label class="checkbox-label"><input v-model="form.cacheEnabled" type="checkbox"/>开启网站缓存</label></div>
              <p class="help">新页面和新接口默认开启缓存；网站、本页和接口开关均可单独关闭。</p>
            </section>
            <section class="form-section" aria-labelledby="identity-heading">
              <h3 id="identity-heading">身份与缓存</h3>
              <div class="field-grid"><label>身份隔离方式<select v-model="form.identityMode"><option value="auto">自动识别（默认）</option><option value="public">公开接口 · 无需登录</option><option value="authorization">Authorization 凭证摘要</option><option value="session">Cookie 登录 · 显式会话分区</option><option value="unconfigured">未配置 · 仅凭证请求可缓存</option></select></label><label>默认有效期（分钟）<input v-model="form.ttl" type="number" min="0"/><span class="help">0 表示手动清空前有效；页面和接口可单独设置。</span></label></div>
              <p v-if="form.identityMode === 'auto'" class="identity-note">优先按 Authorization 凭证摘要隔离缓存；没有凭证时，同一标签页在当前浏览器会话内可跨刷新复用缓存。不同标签页和浏览器会话分别隔离。</p>
              <p v-if="form.identityMode === 'unconfigured'" class="identity-note">含 Authorization 凭证的请求按凭证隔离并缓存，无凭证请求直通。选择自动识别后，无凭证请求也可使用缓存。</p>
              <p v-if="form.identityMode === 'authorization'" class="identity-note">依据当前 Authorization 凭证摘要隔离缓存。原始凭证仅保留在当前标签页内存中。</p>
              <p v-if="form.identityMode === 'public'" class="identity-note">仅用于无需登录的公开接口。依赖 Cookie 身份的请求可使用自动识别。</p>
              <div v-if="form.identityMode === 'session'" class="session-field"><label>当前会话分区<div class="input-action"><input v-model="form.sessionPartition" maxlength="128" placeholder="例如 dev-alice" autocomplete="off"/><button type="button" @click="resetPartition">新建分区</button></div></label><p class="help">切换账号或租户后，请新建分区并保存，再从页面触发接口。</p></div>
              <label class="scope-field">后端环境标识<input v-model="form.environmentId" maxlength="100" placeholder="local" autocomplete="off"/><span class="help">代理切换后端时修改此标识，避免复用旧数据。</span></label>
            </section>
            <section class="form-section" aria-labelledby="page-heading"><h3 id="page-heading">页面识别</h3><div class="field-grid"><label>路由模式<select v-model="form.routeMode"><option value="history">History / 路径路由</option><option value="hash">Hash 路由（#/path）</option></select></label><label>区分页面的 Query 参数<input v-model="form.pageIdentityQueryKeys" placeholder="默认不使用 Query 区分页面" spellcheck="false"/><span class="help">以逗号分隔，例如 tab, tenantId。</span></label></div><p class="help">按精确路径绑定接口；普通锚点保留在 History 模式。请求参数仍会参与缓存匹配。</p></section>
            <section class="form-section" aria-labelledby="bypass-heading"><h3 id="bypass-heading">直通规则</h3><label>鉴权路径关键字<textarea v-model="form.authPaths" rows="3" spellcheck="false" placeholder="login&#10;logout&#10;token&#10;refresh"></textarea><span class="help">每行一个关键字，匹配最后一个路径段；以 / 开头则匹配路径前缀。鉴权接口始终直通。POST 默认允许缓存，写操作接口可在面板中关闭缓存或设为始终直通。</span></label></section>
          </details>
          <div class="save-bar"><div><button class="primary" :disabled="busy || loading">{{ busy ? '正在保存…' : selected ? '保存网站设置' : '授权并添加网站' }}</button><p>首次添加后，刷新业务页面一次。</p></div><button v-if="selected && !deleting" type="button" class="text-button danger" :disabled="busy" @click="deleting = true">删除网站</button></div>
          <div v-if="deleting" class="delete-confirm"><p>删除 {{ selected?.origin }} 的配置、绑定与缓存？</p><div><button type="button" class="danger-button" :disabled="busy" @click="remove">确认删除</button><button type="button" @click="deleting = false">保留网站</button></div></div>
        </form>
      </div>
      <footer class="help-footer"><p><strong>开始使用：</strong>添加网站 → 刷新业务页面 → 正常操作。首次请求自动缓存，相同请求自动回放。</p><p>支持 Chrome 顶层页面的异步 fetch / XHR JSON 响应。每条正文最多 1 MiB，总缓存最多 100 MiB。数据只保存在本机。</p></footer>
    </main>
  </div>
</template>
