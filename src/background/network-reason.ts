import type { NetworkReason, NetworkReasonCode } from '../shared/types';
import type { CacheState, RequestFingerprint } from './cache-store';

const labels: Record<NetworkReasonCode, string> = {
  MANUAL: '手动重新请求', EXPIRED: '缓存已过期', CLEARED: '缓存已清空', RULES_CHANGED: '缓存规则已修改',
  FORCE_MODE_CHANGED: '强制缓存模式已切换', IDENTITY_CHANGED: '身份分区已变化', SESSION_CHANGED: '浏览器会话已变化',
  FIRST_REQUEST: '首次请求', QUERY_CHANGED: 'Query 参数已变化', BODY_CHANGED: 'Body 参数已变化', PARAMETERS_CHANGED: '请求参数已变化',
  HEADERS_CHANGED: '匹配请求头已变化', CREDENTIALS_CHANGED: '凭证发送方式已变化', NOT_RECORDED: '此前未成功录制',
  IN_FLIGHT: '上次请求尚未写入缓存', EVICTED: '缓存已被容量淘汰', CACHE_DISABLED: '缓存开关已关闭',
  BYPASS: '当前请求需直通', UNAVAILABLE: '当前无可用缓存',
};
export const networkReason = (code: NetworkReasonCode, detail?: string): NetworkReason => ({ code, label: labels[code], ...(detail ? { detail } : {}) });

export function rememberInvalidation(state: CacheState, key: string, bindingId: string, code: NetworkReasonCode, variantId?: string): void {
  delete state.missTraces[key];
  state.missTraces[key] = { bindingId, variantId, code };
  const keys = Object.keys(state.missTraces);
  for (const expired of keys.slice(0, Math.max(0, keys.length - 6000))) delete state.missTraces[expired];
}
export function forgetVariantDiagnostics(state: CacheState, variantId: string): void {
  delete state.requestFingerprints[variantId];
  for (const [key, trace] of Object.entries(state.missTraces)) if (trace.variantId === variantId) delete state.missTraces[key];
}
export function fingerprintChange(previous: RequestFingerprint | undefined, current: RequestFingerprint): NetworkReason | undefined {
  if (!previous || previous.ruleVersion !== current.ruleVersion) return;
  if (previous.credentials !== current.credentials) return networkReason('CREDENTIALS_CHANGED');
  if (previous.headers !== current.headers) return networkReason('HEADERS_CHANGED');
  if (previous.tabId === current.tabId && previous.session && current.session && previous.session !== current.session) return networkReason('SESSION_CHANGED');
  if (previous.identity !== current.identity) return networkReason('IDENTITY_CHANGED');
  const query = previous.query !== current.query, body = previous.body !== current.body;
  if (query && body) return networkReason('PARAMETERS_CHANGED', '归一化后的 Query 和 Body 均不同。');
  if (query) return networkReason('QUERY_CHANGED');
  if (body) return networkReason('BODY_CHANGED');
}
