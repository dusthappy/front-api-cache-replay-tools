<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { BindingView, ManualResult, Rule, RuntimeTemplate, Variant } from '../shared/types';
import { isAuthPath } from '../shared/normalize';
import { formatBytes, formatTime, fullTime, rpc, runtimeRpc, splitList } from './rpc';

const props = defineProps<{ binding: BindingView; allBindings: BindingView[]; expanded: boolean; pageUrl: string; templates: RuntimeTemplate[]; defaultTtl: number; authPaths: string[]; cacheActive: boolean }>();
const emit = defineEmits<{ toggle: []; updated: [] }>();
const busy = ref(false);
const message = ref('');
const error = ref('');
const deleting = ref(false);
const rulesOpen = ref(false);
const selectedId = ref('');
const previewOpen = ref(false);
const previewLoading = ref(false);
const preview = ref('');
const previewAt = ref<number>();
const form = reactive({ alias: '', ignoreQuery: '', ignoreBody: '', varyHeaders: '', ttl: '', readOnly: true, alwaysBypass: false, allowNoStore: true, successPointer: '', successValue: '', invalidateBindingIds: [] as string[] });
const statuses: Record<string, string> = { HIT: '缓存命中', MISS: '真实请求', BYPASS: '直通', ERROR: '失败', PENDING: '请求中' };
const recent = computed(() => [...props.binding.variants].sort((a, b) => Math.max(b.lastPageCallAt || 0, b.lastNetworkAttemptAt || 0) - Math.max(a.lastPageCallAt || 0, a.lastNetworkAttemptAt || 0))[0]);
const selected = computed(() => props.binding.variants.find(item => item.id === selectedId.value) || recent.value);
const recentNetworkReason = computed(() => displayedNetworkReason(recent.value));
const selectedNetworkReason = computed(() => displayedNetworkReason(selected.value));
const recentOutcome = computed(() => outcomeReason(recent.value));
const selectedOutcome = computed(() => outcomeReason(selected.value));
const lastNetwork = computed(() => Math.max(0, ...props.binding.variants.map(item => item.lastNetworkAttemptAt || 0)));
const canQuery = computed(() => !props.binding.alwaysBypass && (props.binding.method === 'GET' || (props.binding.method === 'POST' && props.binding.readOnly)));
const canForceCache = computed(() => canQuery.value && !isAuthPath(props.binding.pathname, props.authPaths));
const showForceCache = computed(() => recent.value?.lastStatus !== 'HIT' && recent.value?.networkReason?.code !== 'FIRST_REQUEST' && (canForceCache.value || props.binding.forceCache));
const forceCacheHint = '忽略 Query / Body 变化，仍按当前页面、身份和有效期匹配。切换会清空旧缓存，下一次成功响应重新录制后复用。';
const ttl = computed(() => props.binding.ttl ?? props.defaultTtl);
const cacheAge = computed(() => {
  if (!selected.value?.cachedAt) return '未保存';
  const minutes = Math.max(0, Math.floor((Date.now() - selected.value.cachedAt) / 60000));
  return minutes < 1 ? '刚刚更新' : `${minutes} 分钟前`;
});
const query = computed(() => {
  if (!selected.value) return '';
  try { return new URL(selected.value.url).search || '无 Query 参数'; } catch { return selected.value.url; }
});
const bodyDisplay = computed(() => {
  if (!selected.value?.body) return '无请求 Body';
  try { return JSON.stringify(JSON.parse(selected.value.body), null, 2); } catch { return selected.value.body; }
});
function recordedAfterClear(variant?: Variant): boolean {
  return variant?.networkReason?.code === 'CLEARED' && variant.lastStatus === 'MISS' && variant.cachedAt !== undefined;
}
function displayedNetworkReason(variant?: Variant) {
  if (!variant || variant.lastStatus === 'HIT') return undefined;
  if (recordedAfterClear(variant)) return { code: 'CLEARED' as const, label: '已重新缓存', detail: '本次因缓存清空发起真实请求，响应已成功写入缓存。后续符合规则的请求可回放。' };
  return variant.networkReason;
}
function outcomeReason(variant?: Variant): string {
  if (!variant || variant.lastStatus === 'HIT') return '';
  const reason = variant.lastStatus === 'ERROR'
    ? variant.lastError || variant.reason || '最近请求失败，缓存未更新。'
    : variant.reason || '';
  return ['真实请求并录制', '缓存命中', variant.networkReason?.label].includes(reason) ? '' : reason;
}
function templateFor(variant?: Variant): RuntimeTemplate | undefined { return props.templates.find(item => item.bindingId === props.binding.id && (!variant || item.variantId === variant.id)); }
function replayReason(variant?: Variant): string {
  if (!canQuery.value) return props.binding.alwaysBypass ? '始终直通接口不开放快捷重发' : '仅 GET 或允许缓存的 POST 支持重发';
  if (!variant) return '尚无请求模板，请先从页面触发一次请求';
  const template = templateFor(variant);
  return template?.canReplay ? '' : template?.reason || '当前标签页暂无有效模板，请先从页面触发一次请求';
}
function loadForm(): void {
  const b = props.binding;
  Object.assign(form, { alias: b.alias, ignoreQuery: b.ignoreQueryKeys.join(', '), ignoreBody: b.ignoreBodyPointers.join('\n'), varyHeaders: b.varyHeaders.join(', '), ttl: b.ttl === undefined ? '' : String(b.ttl / 60000), readOnly: b.readOnly, alwaysBypass: b.alwaysBypass, allowNoStore: b.allowNoStore, successPointer: b.successCondition?.pointer || '', successValue: b.successCondition ? JSON.stringify(b.successCondition.value) : '', invalidateBindingIds: [...b.invalidateBindingIds] });
}
watch(() => props.expanded, value => {
  if (value) { selectedId.value = recent.value?.id || ''; loadForm(); }
  else { previewOpen.value = false; preview.value = ''; rulesOpen.value = false; deleting.value = false; }
});
watch(selectedId, () => { previewOpen.value = false; preview.value = ''; });

async function patch(patch: Record<string, unknown>): Promise<void> {
  busy.value = true; error.value = ''; message.value = '';
  try { await rpc('RULE_PATCH', { pageUrl: props.pageUrl, bindingId: props.binding.id, patch }); emit('updated'); }
  catch (failure) { error.value = (failure as Error).message; }
  finally { busy.value = false; }
}
async function toggleForceCache(): Promise<void> {
  if (busy.value || (!props.binding.forceCache && !canForceCache.value)) return;
  const enabled = !props.binding.forceCache;
  await patch(enabled ? { forceCache: true, enabled: true } : { forceCache: false });
  if (!error.value) {
    selectedId.value = ''; previewOpen.value = false; preview.value = '';
    message.value = enabled
      ? props.cacheActive ? '强制缓存已开启，旧缓存已清空。下一次成功录制后复用，忽略 Query / Body 变化。' : '强制缓存已开启，旧缓存已清空。开启网站与本页缓存后，成功录制即可复用。'
      : '强制缓存已关闭，旧缓存已清空。之后按原匹配规则重新录制。';
  }
}
async function saveRules(): Promise<void> {
  error.value = '';
  let condition: Rule['successCondition'];
  if (form.successPointer || form.successValue) {
    if (form.successPointer && !form.successPointer.startsWith('/')) { error.value = '业务成功字段使用 JSON Pointer，例如 /code。'; return; }
    try { condition = { pointer: form.successPointer, value: JSON.parse(form.successValue) }; }
    catch { error.value = '成功值需为 JSON，例如 0、true 或 "success"。'; return; }
  }
  const bodyPointers = splitList(form.ignoreBody);
  if (bodyPointers.some(pointer => !pointer.startsWith('/') || /~(?![01])/.test(pointer))) { error.value = 'Body 字段使用 JSON Pointer，例如 /pagination/page。'; return; }
  if (form.ttl && (!Number.isFinite(Number(form.ttl)) || Number(form.ttl) < 0)) { error.value = '有效期需为非负分钟数。'; return; }
  await patch({ alias: form.alias.trim(), ignoreQueryKeys: splitList(form.ignoreQuery), ignoreBodyPointers: bodyPointers, varyHeaders: splitList(form.varyHeaders).map(value => value.toLowerCase()), ttl: form.ttl === '' ? null : Number(form.ttl) * 60000, readOnly: form.readOnly, alwaysBypass: form.alwaysBypass, allowNoStore: form.allowNoStore, successCondition: condition ?? null, invalidateBindingIds: [...form.invalidateBindingIds] });
  if (!error.value) { message.value = '规则已保存，旧匹配缓存已失效。'; rulesOpen.value = false; }
}
async function manually(variant: Variant | undefined, refreshPage = false): Promise<void> {
  if (!variant || replayReason(variant)) return;
  busy.value = true; error.value = ''; message.value = '';
  const originalPage = props.pageUrl;
  try {
    const result = await runtimeRpc<ManualResult>('MANUAL', { pageUrl: originalPage, bindingId: props.binding.id, variantId: variant.id });
    if (!result.success) throw new Error(result.reason || '重新请求失败；旧成功缓存仍保留。');
    message.value = result.saved ? '真实请求成功，新响应已保存。' : `真实请求成功，未写入缓存${result.reason ? `：${result.reason}` : '。'}`;
    emit('updated');
    if (refreshPage) {
      if (location.href !== originalPage || result.pageUrl !== originalPage) { message.value += ' 页面已切换，未刷新。'; return; }
      if (result.cacheAllowed && !result.saved) { error.value = '新响应未成功保存，已取消刷新页面。'; return; }
      location.reload();
    }
  } catch (failure) { error.value = (failure as Error).message; emit('updated'); }
  finally { busy.value = false; }
}
async function clear(variantId?: string): Promise<void> {
  busy.value = true; error.value = '';
  try {
    await rpc('CLEAR', { pageUrl: props.pageUrl, bindingId: props.binding.id, variantId });
    message.value = variantId ? '当前参数组缓存已清空。' : '此接口全部缓存已清空。';
    previewOpen.value = false; preview.value = ''; emit('updated');
  } catch (failure) { error.value = (failure as Error).message; }
  finally { busy.value = false; }
}
async function remove(): Promise<void> {
  busy.value = true; error.value = '';
  try { await rpc('BIND_DELETE', { pageUrl: props.pageUrl, bindingId: props.binding.id }); emit('updated'); }
  catch (failure) { error.value = (failure as Error).message; }
  finally { busy.value = false; }
}
async function openPreview(): Promise<void> {
  previewOpen.value = !previewOpen.value;
  if (!previewOpen.value || !selected.value) return;
  previewLoading.value = true; error.value = '';
  const variantId = selected.value.id;
  try {
    const data = await rpc<{ bodyText: string; cachedAt?: number }>('PREVIEW', { pageUrl: props.pageUrl, bindingId: props.binding.id, variantId });
    if (selected.value?.id !== variantId || !previewOpen.value) return;
    previewAt.value = data.cachedAt;
    try { preview.value = JSON.stringify(JSON.parse(data.bodyText), null, 2); } catch { preview.value = data.bodyText || '暂无可用响应，请先从页面发起一次成功请求。'; }
  } catch (failure) { preview.value = ''; error.value = (failure as Error).message; }
  finally { previewLoading.value = false; }
}
async function copyUrl(): Promise<void> {
  try { await navigator.clipboard.writeText(selected.value?.url || `${props.binding.apiOrigin}${props.binding.pathname}`); message.value = '接口地址已复制。'; }
  catch { error.value = '无法访问剪贴板，请选中接口地址手动复制。'; }
}
</script>

<template>
  <article class="endpoint" :class="{ 'is-expanded': expanded }">
    <div class="endpoint-heading">
      <button class="endpoint-title" :aria-expanded="expanded" :aria-controls="`details-${binding.id}`" @click="emit('toggle')"><svg class="chevron" :class="{ rotated: expanded }" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg><span class="method" :class="binding.method.toLowerCase()">{{ binding.method }}</span><strong :title="`${binding.apiOrigin}${binding.pathname}`">{{ binding.alias || binding.pathname }}</strong></button>
      <label class="row-switch" :title="binding.alwaysBypass ? '始终直通规则优先' : canQuery ? '接口缓存开关' : '仅 GET 和允许缓存的 POST 支持缓存'" @click.stop><input type="checkbox" role="switch" :aria-label="`${binding.alias || binding.pathname} 缓存开关`" :checked="binding.enabled" :disabled="busy || !canQuery" @change="patch({ enabled: ($event.target as HTMLInputElement).checked })"/></label>
      <button class="icon-button replay-button" :disabled="busy || !!replayReason(recent)" :title="busy ? '请求处理中' : replayReason(recent) || '重新请求最新参数组'" :aria-label="`重新请求 ${binding.alias || binding.pathname}`" @click.stop="manually(recent)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5m5 0a8 8 0 1 0-2 5"/></svg></button>
    </div>
    <div class="endpoint-meta"><div class="endpoint-status-actions"><span class="status-badge" :class="(recent?.lastStatus || 'UNSEEN').toLowerCase()">{{ recent?.lastStatus || '未请求' }}<span v-if="recent"> · {{ statuses[recent.lastStatus] }}</span></span><span v-if="recentNetworkReason" class="network-reason" :title="recentNetworkReason.detail || recentNetworkReason.label" :data-reason-code="recentNetworkReason.code">{{ recentNetworkReason.label }}</span><button v-if="showForceCache" type="button" class="force-cache-button" :class="{ active: binding.forceCache }" :aria-label="`${binding.alias || binding.pathname} 强制缓存`" :aria-pressed="!!binding.forceCache" :title="forceCacheHint" :disabled="busy" @click.stop="toggleForceCache">{{ binding.forceCache ? '强制缓存中' : '强制缓存' }}</button></div><span class="last-network-time" :title="fullTime(lastNetwork)">最后真实请求 <time>{{ formatTime(lastNetwork) }}</time></span></div>
    <p v-if="recentOutcome" class="row-reason" :class="{ 'error-text': recent?.lastStatus === 'ERROR' }">{{ recentOutcome }}</p>
    <p v-if="error" class="inline-message error" role="alert">{{ error }}</p><p v-if="message" class="inline-message" role="status">{{ message }}</p>
    <div v-if="expanded" :id="`details-${binding.id}`" class="endpoint-detail">
      <div class="api-address"><code>{{ binding.apiOrigin }}{{ binding.pathname }}</code><button class="icon-button" title="复制接口地址" aria-label="复制接口地址" @click.stop="copyUrl"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 8h11v13H9zM5 16H3V3h11v2"/></svg></button></div>
      <label v-if="binding.variants.length" class="variant-select">参数组合 <span class="muted">{{ binding.variants.length }} 组</span><select v-model="selectedId" aria-label="选择参数组合"><option v-for="variant in binding.variants" :key="variant.id" :value="variant.id">{{ formatTime(variant.lastPageCallAt || variant.lastNetworkAttemptAt) }} · {{ variant.url }}{{ variant.body ? ` · ${variant.body.slice(0, 60)}` : '' }}</option></select></label>
      <p v-else class="help-text">此绑定尚未观察到请求。从页面正常触发一次后，可查看参数并重新请求。</p>
      <template v-if="selected">
        <dl v-if="selectedNetworkReason" class="selected-network-reason" :data-reason-code="selectedNetworkReason.code"><dt>{{ recordedAfterClear(selected) ? '缓存状态' : '真实请求原因' }}</dt><dd><strong>{{ selectedNetworkReason.label }}</strong><span v-if="selectedNetworkReason.detail && selectedNetworkReason.detail !== selectedNetworkReason.label">{{ selectedNetworkReason.detail }}</span></dd></dl>
        <p v-if="selectedOutcome && selected.id !== recent?.id" class="selected-outcome-reason" :class="{ 'error-text': selected.lastStatus === 'ERROR' }">{{ selectedOutcome }}</p>
        <dl class="request-facts"><div><dt>缓存更新</dt><dd :title="fullTime(selected.cachedAt)">{{ cacheAge }}</dd></div><div><dt>有效期</dt><dd>{{ ttl === 0 ? '手动清空前有效' : `${ttl / 60000} 分钟` }}{{ selected.expiresAt && selected.expiresAt < Date.now() ? ' · 已过期' : '' }}</dd></div><div><dt>命中 / 大小</dt><dd>{{ selected.hitCount }} 次 / {{ formatBytes(selected.sizeBytes) }}</dd></div><div><dt>最近耗时</dt><dd>{{ selected.lastDurationMs == null ? '—' : `${Math.round(selected.lastDurationMs)} ms` }}</dd></div><div><dt>页面最近调用</dt><dd :title="fullTime(selected.lastPageCallAt)">{{ formatTime(selected.lastPageCallAt) }}</dd></div><div><dt>组合真实请求</dt><dd :title="fullTime(selected.lastNetworkAttemptAt)">{{ formatTime(selected.lastNetworkAttemptAt) }}</dd></div></dl>
        <div class="parameter-block"><span class="field-heading">最近原始参数（已脱敏）</span><pre>{{ query }}</pre><pre v-if="selected.body">{{ bodyDisplay }}</pre></div>
        <div class="detail-actions"><button :disabled="busy || !!replayReason(selected)" :title="replayReason(selected)" @click.stop="manually(selected)">{{ busy ? '请求处理中…' : '重新请求' }}</button><button :disabled="busy || !!replayReason(selected)" :title="replayReason(selected)" @click.stop="manually(selected, true)">请求并刷新页面</button><button :disabled="busy" @click.stop="clear(selected.id)">清空此组</button></div>
        <p v-if="replayReason(selected)" class="help-text">{{ replayReason(selected) }}</p>
        <button class="disclosure" :aria-expanded="previewOpen" @click.stop="openPreview"><svg class="chevron" :class="{ rotated: previewOpen }" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>响应预览 <span v-if="previewOpen && previewAt" class="muted">{{ formatTime(previewAt) }}</span></button>
        <div v-if="previewOpen" class="response-preview"><p v-if="previewLoading" class="help-text" role="status">正在读取响应…</p><pre v-else tabindex="0">{{ preview }}</pre></div>
      </template>
      <button class="disclosure" :aria-expanded="rulesOpen" @click.stop="rulesOpen = !rulesOpen; rulesOpen && loadForm()"><svg class="chevron" :class="{ rotated: rulesOpen }" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>匹配与录制规则</button>
      <form v-if="rulesOpen" class="rule-form" @submit.prevent="saveRules" @click.stop>
        <label>接口别名<input v-model="form.alias" maxlength="100" placeholder="例如：用户列表"/></label>
        <label>忽略的 Query 参数<input v-model="form.ignoreQuery" placeholder="page, pageSize, timestamp"/><span class="help-text">字段名以逗号分隔。忽略后返回同一份响应，不会重新计算分页。</span></label>
        <label>忽略的 Body 字段<textarea v-model="form.ignoreBody" rows="2" placeholder="/pagination/page&#10;/pagination/pageSize"></textarea><span class="help-text">JSON Pointer，一行一个。只影响匹配，不修改真实请求。</span></label>
        <label>参与匹配的请求头<input v-model="form.varyHeaders" placeholder="accept-language, x-tenant-id"/></label>
        <label>有效期（分钟）<input v-model="form.ttl" type="number" min="0" :placeholder="`继承本页：${defaultTtl / 60000}`"/><span class="help-text">留空继承本页；0 表示手动清空前有效。</span></label>
        <div class="inline-fields"><label>业务成功字段<input v-model="form.successPointer" placeholder="/code"/></label><label>成功值（JSON）<input v-model="form.successValue" placeholder="0"/></label></div>
        <label class="check-label"><input v-model="form.alwaysBypass" type="checkbox"/>始终直通，不读写缓存</label>
        <label v-if="binding.method === 'POST'" class="check-label"><input v-model="form.readOnly" type="checkbox"/>允许 POST 缓存</label><p v-if="binding.method === 'POST'" class="help-text">默认开启。保存、创建、删除等写操作接口可关闭此项，或设为始终直通。</p>
        <label class="check-label"><input v-model="form.allowNoStore" type="checkbox"/>允许在本地录制 no-store 响应</label>
        <fieldset v-if="['POST', 'PUT', 'PATCH', 'DELETE'].includes(binding.method)"><legend>此接口写入成功后清空</legend><label v-for="target in allBindings.filter(item => item.id !== binding.id && (item.method === 'GET' || (item.method === 'POST' && item.readOnly)))" :key="target.id" class="check-label"><input v-model="form.invalidateBindingIds" type="checkbox" :value="target.id"/><span>{{ target.method }} {{ target.alias || target.pathname }}</span></label><p class="help-text">未选择时不推断接口依赖。只影响当前页面的绑定。</p></fieldset>
        <button class="primary" :disabled="busy">保存规则</button>
      </form>
      <div class="binding-actions"><button class="text-button" :disabled="busy" @click.stop="clear()">清空接口全部缓存</button><button v-if="!deleting" class="text-button danger" :disabled="busy" @click.stop="deleting = true">删除本页绑定</button><template v-else><span class="help-text">同时删除缓存？</span><button class="text-button danger" :disabled="busy" @click.stop="remove">确认删除</button><button class="text-button" @click.stop="deleting = false">取消</button></template></div>
    </div>
  </article>
</template>
