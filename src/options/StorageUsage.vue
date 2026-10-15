<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { CacheStorageStats } from '../shared/types';
import { rpc } from '../ui/rpc';

const stats = ref<CacheStorageStats>();
const estimate = ref<number>();
const loading = ref(false);
const clearing = ref(false);
const error = ref('');
const clearError = ref('');
const notice = ref('');
let disposed = false;
let interval: number | undefined;
const hasData = computed(() => stats.value && (stats.value.cacheCount + stats.value.previewCount + stats.value.requestRecordCount + stats.value.pendingCount > 0));
function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const unit = value >= 1024 ** 3 ? 'GiB' : value >= 1024 ** 2 ? 'MiB' : 'KiB';
  const divisor = unit === 'GiB' ? 1024 ** 3 : unit === 'MiB' ? 1024 ** 2 : 1024;
  return `${Number((value / divisor).toFixed(2))} ${unit}`;
}
async function refresh(): Promise<void> {
  if (disposed || loading.value || clearing.value) return;
  loading.value = true;
  try {
    // Estimate is for the extension origin, not the website or the whole Chrome profile.
    const [data, usage] = await Promise.allSettled([
      rpc<CacheStorageStats>('STORAGE_GET'),
      Promise.resolve().then(() => navigator.storage.estimate()),
    ]);
    if (disposed) return;
    estimate.value = usage.status === 'fulfilled' && Number.isFinite(usage.value.usage) ? usage.value.usage : undefined;
    if (data.status === 'rejected') throw data.reason;
    stats.value = data.value; error.value = '';
  } catch (failure) {
    if (!disposed) error.value = `存储统计读取失败，请点击刷新重试。${(failure as Error).message}`;
  } finally { loading.value = false; }
}
async function clearAll(): Promise<void> {
  if (clearing.value || loading.value) return;
  clearing.value = true; clearError.value = ''; notice.value = '';
  try {
    const data = await rpc<CacheStorageStats>('CACHE_CLEAR_ALL');
    if (disposed) return;
    stats.value = data; estimate.value = undefined;
    notice.value = '已清理所有网站的缓存、预览与请求记录，设置已保留。新请求会重新录制。';
  } catch (failure) {
    if (!disposed) clearError.value = `缓存清理失败，请重试。${(failure as Error).message}`;
  } finally { clearing.value = false; }
  await refresh();
}
function onVisible(): void { if (document.visibilityState === 'visible') void refresh(); }
onMounted(() => {
  void refresh();
  interval = window.setInterval(onVisible, 5000);
  document.addEventListener('visibilitychange', onVisible);
});
onBeforeUnmount(() => { disposed = true; clearInterval(interval); document.removeEventListener('visibilitychange', onVisible); });
</script>

<template>
  <section class="storage-section" aria-labelledby="storage-heading" :aria-busy="loading || clearing">
    <div class="storage-heading">
      <div><h2 id="storage-heading">存储与缓存</h2><p>当前 Chrome 中，本扩展所有网站的本地缓存。</p></div>
      <div class="storage-actions">
        <button type="button" :disabled="loading || clearing" @click="refresh">{{ loading ? '读取中…' : '刷新统计' }}</button>
        <button type="button" class="danger-button" :disabled="loading || clearing || !stats || !hasData" aria-describedby="storage-clear-scope" @click="clearAll">{{ clearing ? '正在清理…' : '一键清理缓存' }}</button>
      </div>
    </div>
    <template v-if="stats">
      <div class="storage-budget"><span>缓存正文与响应预览</span><span><strong data-testid="storage-total">{{ bytes(stats.totalBytes) }}</strong> / {{ bytes(stats.limitBytes) }}</span></div>
      <meter class="storage-meter" :value="stats.totalBytes" :max="stats.limitBytes" :high="stats.limitBytes * .85" :optimum="0" min="0" aria-label="缓存正文与响应预览占用" :aria-valuetext="`${bytes(stats.totalBytes)}，上限 ${bytes(stats.limitBytes)}`"/>
      <dl class="storage-breakdown">
        <div><dt>响应缓存</dt><dd>{{ stats.cacheCount }} 份 · {{ bytes(stats.cacheBytes) }}</dd></div>
        <div><dt>响应预览</dt><dd>{{ stats.previewCount }} 份 · {{ bytes(stats.previewBytes) }}</dd></div>
        <div><dt>扩展存储估算</dt><dd>{{ estimate === undefined ? '暂不可用' : `约 ${bytes(estimate)}` }}</dd></div>
      </dl>
      <p v-if="!hasData" class="storage-empty">暂无可清理的缓存。页面请求成功录制后，占用会显示在这里。</p>
    </template>
    <p v-else class="storage-empty">{{ loading ? '正在读取存储占用…' : '暂时无法读取存储占用。' }}</p>
    <p id="storage-clear-scope" class="help">清理所有网站的缓存、响应预览与请求记录，保留网站授权、接口规则和开关。下一次请求将重新录制。</p>
    <p class="help storage-estimate-note">正文上限为 100 MiB；浏览器估算还包含索引等数据，清理后可能不会归零。这里只管理本扩展，不清理其他网站的 Cookie 或 Chrome 缓存。可见时每 5 秒更新。</p>
    <p v-if="error" class="storage-feedback error" role="alert">{{ error }}{{ stats ? ' 当前显示上次读取结果。' : '' }}</p>
    <p v-if="clearError" class="storage-feedback error" role="alert">{{ clearError }}</p>
    <p v-if="notice" class="storage-feedback success" role="status">{{ notice }}</p>
  </section>
</template>
