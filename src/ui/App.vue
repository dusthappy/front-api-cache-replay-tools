<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { PanelState, RuntimeTemplate, SiteConfig } from '../shared/types';
import { APP_VERSION } from '../shared/version';
import EndpointItem from './EndpointItem.vue';
import { rpc, runtimeRpc } from './rpc';

const state = ref<PanelState | null>(null);
const templates = ref<RuntimeTemplate[]>([]);
const pageUrl = ref(location.href);
const opened = ref(false);
const search = ref('');
const expanded = ref(new Set<string>());
const error = ref('');
const connectionLost = ref(false);
const notice = ref('');
const busy = ref(false);
const panel = ref<HTMLElement>();
const floating = ref<HTMLButtonElement>();
const FLOATING_SIZE = 44;
const DEFAULT_FLOATING_RIGHT = 35;
const right = ref(DEFAULT_FLOATING_RIGHT);
const DEFAULT_FLOATING_TOP = 55;
const y = ref(DEFAULT_FLOATING_TOP);
const viewport = ref({ width: innerWidth, height: innerHeight });
// Keep existing saved x coordinates and drag controls compatible with right anchoring.
const x = computed({
  get: () => viewport.value.width - FLOATING_SIZE - right.value,
  set: (value: number) => { right.value = viewport.value.width - FLOATING_SIZE - value; },
});
let positionLoaded = false;
let identity = '';
let refreshGeneration = 0;
let interval: number | undefined;
let drag: { startX: number; startY: number; x: number; y: number; moved: boolean } | null = null;
let suppressClick = false;

const versionMismatch = computed(() => !!state.value?.extensionVersion && state.value.extensionVersion !== APP_VERSION);
const needsRefresh = computed(() => versionMismatch.value || connectionLost.value);
const effectiveEnabled = computed(() => !!state.value && !state.value.paused && state.value.site.captureEnabled && state.value.site.cacheEnabled && state.value.page.cacheEnabled);
const bindings = computed(() => state.value?.bindings.filter(item => `${item.method} ${item.alias} ${item.apiOrigin}${item.pathname}`.toLowerCase().includes(search.value.toLowerCase())) || []);
const panelStyle = computed(() => {
  const width = Math.min(440, viewport.value.width - 16);
  const availableHeight = Math.min(viewport.value.height * .7, viewport.value.height - 16);
  const left = Math.max(8, Math.min(x.value + 44 - width, viewport.value.width - width - 8));
  const top = Math.max(8, Math.min(y.value + 52, viewport.value.height - availableHeight - 8));
  return { left: `${left}px`, top: `${top}px`, width: `${width}px`, maxHeight: `${availableHeight}px` };
});
const routeLabel = computed(() => {
  const page = new URL(pageUrl.value);
  const site = state.value?.site;
  const route = site?.routeMode === 'hash' ? new URL(page.hash.slice(1) || '/', page.origin) : page;
  const params = new URLSearchParams([...route.searchParams].filter(([key]) => site?.pageIdentityQueryKeys.includes(key)));
  return `${site?.routeMode === 'hash' ? '#' : ''}${route.pathname}${params.size ? `?${params}` : ''}`;
});

function reportFailure(failure: unknown): void {
  const message = failure instanceof Error ? failure.message : String(failure);
  if (/扩展连接已断开|extension context invalidated/i.test(message)) {
    connectionLost.value = true; templates.value = []; error.value = '';
  } else error.value = message;
}

async function refresh(): Promise<void> {
  const generation = ++refreshGeneration;
  const requestedUrl = pageUrl.value;
  try {
    const data = await rpc<PanelState | null>('PANEL', { pageUrl: requestedUrl });
    if (generation !== refreshGeneration || requestedUrl !== pageUrl.value) return;
    if (state.value && data?.page.id !== state.value.page.id) { expanded.value = new Set(); search.value = ''; templates.value = []; }
    state.value = data; connectionLost.value = false;
    if (!data) { close(); return; }
    const nextIdentity = JSON.stringify([data.site.environmentId, data.site.identityMode, data.site.sessionPartition]);
    if (identity && identity !== nextIdentity) {
      templates.value = [];
      void runtimeRpc('INVALIDATE_RUNTIME').catch(() => {});
    }
    identity = nextIdentity;
    if (!positionLoaded) {
      positionLoaded = true;
      if (data.site.floatingPosition) x.value = data.site.floatingPosition.x;
      else right.value = DEFAULT_FLOATING_RIGHT;
      y.value = data.site.floatingPosition?.y ?? DEFAULT_FLOATING_TOP;
      clampPosition();
    }
    if (opened.value) {
      try { templates.value = await runtimeRpc<RuntimeTemplate[]>('RUNTIME_LIST', { pageUrl: requestedUrl }); }
      catch { templates.value = []; }
    }
  } catch (failure) {
    if (generation === refreshGeneration && requestedUrl === pageUrl.value) reportFailure(failure);
  }
}

function close(): void { opened.value = false; expanded.value = new Set(); search.value = ''; }
async function toggleOpen(): Promise<void> {
  if (suppressClick) { suppressClick = false; return; }
  if (opened.value) close();
  else {
    opened.value = true; expanded.value = new Set();
    await nextTick(); panel.value?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    void refresh();
  }
}
function toggleRow(id: string): void {
  const next = new Set(expanded.value);
  next.has(id) ? next.delete(id) : next.add(id);
  expanded.value = next;
}
async function mutate(type: string, payload: unknown): Promise<void> {
  if (busy.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try { await rpc(type, payload); await refresh(); }
  catch (failure) { reportFailure(failure); }
  finally { busy.value = false; }
}
async function patchSite(patch: Partial<SiteConfig>): Promise<void> { await mutate('SITE_PATCH', { patch }); }
async function bulkEnable(): Promise<void> {
  busy.value = true; error.value = '';
  try {
    for (const binding of state.value?.bindings || []) {
      if (!binding.alwaysBypass && (binding.method === 'GET' || (binding.method === 'POST' && binding.readOnly))) {
        await rpc('RULE_PATCH', { pageUrl: pageUrl.value, bindingId: binding.id, patch: { enabled: true } });
      }
    }
    notice.value = '已开启允许缓存的 GET / POST 接口，下一次成功请求会自动缓存。';
    await refresh();
  } catch (failure) { reportFailure(failure); }
  finally { busy.value = false; }
}
function onRoute(event: Event): void {
  const next = (event as CustomEvent<string>).detail || location.href;
  if (next === pageUrl.value) return;
  pageUrl.value = next; expanded.value = new Set(); search.value = ''; error.value = ''; notice.value = ''; templates.value = [];
  void refresh();
}
function clampPosition(): void {
  viewport.value = { width: innerWidth, height: innerHeight };
  x.value = Math.max(8, Math.min(x.value, innerWidth - 52));
  y.value = Math.max(8, Math.min(y.value, innerHeight - 52));
}
function startDrag(event: PointerEvent): void {
  if (event.button !== 0) return;
  drag = { startX: event.clientX, startY: event.clientY, x: x.value, y: y.value, moved: false };
  floating.value?.setPointerCapture(event.pointerId);
}
function moveDrag(event: PointerEvent): void {
  if (!drag) return;
  const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
  if (Math.hypot(dx, dy) >= 5) drag.moved = true;
  if (!drag.moved) return;
  x.value = drag.x + dx; y.value = drag.y + dy; clampPosition();
}
function endDrag(): void {
  if (drag?.moved) {
    suppressClick = true;
    void rpc('SITE_PATCH', { patch: { floatingPosition: { x: x.value, y: y.value } } }).catch(() => {});
  }
  drag = null;
}
function keyPosition(event: KeyboardEvent): void {
  if (!event.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  x.value += event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0;
  y.value += event.key === 'ArrowUp' ? -16 : event.key === 'ArrowDown' ? 16 : 0;
  clampPosition();
  void rpc('SITE_PATCH', { patch: { floatingPosition: { x: x.value, y: y.value } } }).catch(() => {});
}
function outside(event: PointerEvent): void {
  if (opened.value && !event.composedPath().includes(panel.value!) && !event.composedPath().includes(floating.value!)) close();
}
function escape(event: KeyboardEvent): void {
  if (opened.value && event.key === 'Escape') { close(); floating.value?.focus(); }
}
function openSettings(): void { void rpc('OPEN_OPTIONS').catch(reportFailure); }
function reloadPage(): void { location.reload(); }
const onRefresh = () => { void refresh(); };
onMounted(() => {
  void refresh();
  interval = window.setInterval(() => { if (opened.value && document.visibilityState === 'visible') void refresh(); }, 2000);
  window.addEventListener('acr:route', onRoute);
  window.addEventListener('acr:refresh', onRefresh);
  window.addEventListener('resize', clampPosition);
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', escape, true);
  chrome.storage.onChanged.addListener(onRefresh);
});
onBeforeUnmount(() => {
  clearInterval(interval);
  window.removeEventListener('acr:route', onRoute);
  window.removeEventListener('acr:refresh', onRefresh);
  window.removeEventListener('resize', clampPosition);
  document.removeEventListener('pointerdown', outside, true);
  document.removeEventListener('keydown', escape, true);
  try { chrome.storage.onChanged.removeListener(onRefresh); } catch { /* The old content context may be invalid after an extension update. */ }
});
</script>

<template>
  <div v-if="state" class="acr-app">
    <button ref="floating" class="floating" :class="{ active: effectiveEnabled, paused: state.paused }" :style="{ right: `${right}px`, top: `${y}px` }"
      :title="`API Cache Replay v${APP_VERSION} · ${state.paused ? '扩展已暂停' : effectiveEnabled ? '本页缓存已开启' : '本页缓存已关闭'}；拖动或 Alt + 方向键移动`"
      :aria-label="`API Cache Replay，${effectiveEnabled ? '本页缓存开启' : '本页缓存关闭'}，${opened ? '关闭' : '打开'}接口面板`" :aria-expanded="opened" aria-controls="acr-panel"
      @click="toggleOpen" @pointerdown="startDrag" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="endDrag" @keydown="keyPosition">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M19.5 8A8 8 0 0 0 5 6.5L2.5 9M2.5 4.5V9H7M4.5 16A8 8 0 0 0 19 17.5l2.5-2.5m0 4.5V15H17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="m10 8 6 4-6 4z" fill="currentColor"/></svg>
      <span class="floating-dot" aria-hidden="true"></span>
    </button>
    <section v-if="opened" id="acr-panel" ref="panel" class="panel" :style="panelStyle" aria-label="API Cache Replay 接口缓存面板">
      <header class="panel-header">
        <div class="brand"><div class="brand-title"><strong>API Cache Replay</strong><span class="extension-version" :title="`当前页面脚本版本 v${APP_VERSION}${state.extensionVersion ? ` · 扩展后台 v${state.extensionVersion}` : ''}`">v{{ APP_VERSION }}</span></div><span class="brand-description">接口缓存与回放</span></div>
        <button class="icon-button" title="网站设置" aria-label="打开网站设置" @click.stop="openSettings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8 4 1-2-2-3-2 .2L16 5h-4l-1 2.2L9 7l-2 3 1 2-1 2 2 3 2-.2L12 19h4l1-2.2 2 .2 2-3-1-2Z" transform="translate(-2 0)"/></svg></button>
        <button class="icon-button" title="关闭面板 (Esc)" aria-label="关闭面板" @click="close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
      </header>
      <div class="page-context"><div><span class="context-label">{{ state.site.origin }}</span><span class="environment">{{ state.site.environmentId }}</span></div><code :title="routeLabel">{{ routeLabel }}</code></div>
      <div v-if="needsRefresh" class="inline-message warning update-notice" role="status"><div><strong>{{ versionMismatch ? '扩展已更新，请刷新业务页面' : '扩展连接已断开，请刷新业务页面' }}</strong><span v-if="versionMismatch">页面 v{{ APP_VERSION }} · 已安装 v{{ state.extensionVersion }}</span></div><button class="text-button" @click="reloadPage">刷新业务页面</button></div>
      <div v-if="state.paused" class="inline-message warning">扩展已暂停，当前不采集、不回放。<button class="text-button" @click="openSettings">去设置恢复</button></div>
      <div v-else-if="!state.site.captureEnabled" class="inline-message warning">网站自动采集已关闭，当前请求直接通过。<button class="text-button" @click="openSettings">去设置开启</button></div>
      <div v-else-if="state.site.identityMode === 'unconfigured'" class="inline-message warning">当前仅含登录凭证的请求可缓存；自动模式可覆盖其他请求。<button class="text-button" @click="openSettings">修改身份模式</button></div>
      <div class="scope-toggles">
        <label><span>网站缓存</span><input type="checkbox" role="switch" :checked="state.site.cacheEnabled" :disabled="busy || state.paused" @change="patchSite({ cacheEnabled: ($event.target as HTMLInputElement).checked })"/></label>
        <label><span>本页缓存</span><input type="checkbox" role="switch" :checked="state.page.cacheEnabled" :disabled="busy || state.paused" @change="mutate('PAGE_PATCH', { pageUrl, patch: { cacheEnabled: ($event.target as HTMLInputElement).checked } })"/></label>
      </div>
      <details class="scope-discovery">
        <summary aria-label="查看 API 范围"><span>API 范围 · {{ (state.scopeDiscovery?.mode ?? state.site.apiScopeMode) === 'custom' ? '已限定范围' : state.scopeDiscovery?.scopes.length ? `自动识别并采用（${state.scopeDiscovery.scopes.length} 组）` : '自动识别 · 等待请求' }}</span><svg class="chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg></summary>
        <div class="scope-discovery-content" tabindex="0" role="region" aria-label="已识别范围列表">
          <p v-if="(state.scopeDiscovery?.mode ?? state.site.apiScopeMode) === 'custom'" class="help-text">仅使用自定义范围，不会自动扩大。</p>
          <p v-else class="help-text">根据成功的 JSON 响应自动识别并采用，无需确认。</p>
          <div v-if="state.scopeDiscovery?.scopes.length" class="scope-discovery-list" role="list">
            <div v-for="scope in state.scopeDiscovery.scopes" :key="scope.id" class="scope-discovery-item" role="listitem"><code>{{ scope.origin }}{{ scope.pathPrefix }}</code><span>{{ scope.methods.join(' / ') }} · {{ scope.endpointCount }}{{ scope.endpointCountCapped ? '+' : '' }} 个接口</span></div>
          </div>
          <p v-else class="help-text">等待页面请求接口。刷新业务页面或操作一次后，这里会自动更新。</p>
        </div>
      </details>
      <div class="search-row"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><input v-model="search" type="search" aria-label="搜索接口" placeholder="搜索路径、别名或方法"/><span>{{ bindings.length }} 个接口</span></div>
      <div class="toolbar"><button class="text-button" :disabled="busy || !state.bindings.length" @click="bulkEnable">开启全部接口</button><button class="text-button" :disabled="busy" @click="mutate('CLEAR', { pageUrl })">清空本页</button><button class="icon-button" title="刷新当前页面" aria-label="刷新当前页面" @click="reloadPage"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5m5 0a8 8 0 1 0-2 5"/></svg></button></div>
      <p v-if="error" role="alert" class="inline-message error">{{ error }}</p>
      <p v-if="notice" role="status" class="inline-message">{{ notice }}</p>
      <div class="endpoint-list">
        <div v-if="!state.bindings.length" class="empty-state"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M8 13h32v24H8zM8 21h32M16 29h7m7 0h3"/></svg><strong>等待页面请求接口</strong><p>刷新业务页面或触发一次查询，接口会自动出现在这里，成功响应会按规则自动缓存。</p><button class="text-button" @click="reloadPage">刷新业务页面</button></div>
        <div v-else-if="!bindings.length" class="empty-state"><strong>没有匹配的接口</strong><button class="text-button" @click="search = ''">清除搜索</button></div>
        <EndpointItem v-for="binding in bindings" :key="`${state.page.id}:${binding.id}`" :binding="binding" :all-bindings="state.bindings" :expanded="expanded.has(binding.id)" :page-url="pageUrl" :templates="templates" :default-ttl="state.page.ttl ?? state.site.defaultTTL" :auth-paths="state.site.authPaths" :cache-active="effectiveEnabled" @toggle="toggleRow(binding.id)" @updated="refresh"/>
      </div>
      <footer class="panel-footer"><span><i :class="{ on: effectiveEnabled }"></i>{{ state.paused ? '已暂停采集' : !state.site.captureEnabled ? '网站采集已关闭' : effectiveEnabled ? (state.bindings.length ? '自动缓存与回放已开启' : '自动缓存已开启 · 等待请求') : '真实请求 · 缓存关闭' }}</span><details><summary>本页设置</summary><div class="footer-popover"><label>本页有效期（分钟，0 为永久）<input type="number" min="0" :value="(state.page.ttl ?? state.site.defaultTTL) / 60000" @change="mutate('PAGE_PATCH', { pageUrl, patch: { ttl: Number(($event.target as HTMLInputElement).value) * 60000 } })"/></label><button v-if="state.page.ttl !== undefined" class="text-button" @click="mutate('PAGE_PATCH', { pageUrl, patch: { ttl: null } })">恢复网站默认有效期</button><button class="text-button" @click="openSettings">{{ state.paused ? '去设置恢复扩展' : '去设置暂停扩展' }}</button><p>“真实请求”绕过本扩展，仍可能经过浏览器缓存或网站 Service Worker。</p></div></details></footer>
    </section>
  </div>
</template>
