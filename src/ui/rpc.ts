import { CHANNEL, type RpcResult } from '../shared/types';

export async function rpc<T = unknown>(type: string, payload: unknown = {}): Promise<T> {
  let result: RpcResult;
  try {
    result = await chrome.runtime.sendMessage({ type, payload }) as RpcResult;
  } catch {
    throw new Error('扩展连接已断开，请重新加载扩展并刷新此页面。');
  }
  if (!result?.ok) throw new Error(result?.error || '操作未完成，请重试。');
  return result.data as T;
}

export function runtimeRpc<T = unknown>(type: 'RUNTIME_LIST' | 'MANUAL' | 'INVALIDATE_RUNTIME', payload: unknown = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    const timeout = window.setTimeout(() => {
      window.removeEventListener('message', receive);
      reject(new Error(type === 'MANUAL' ? '请求等待超时，请检查页面或网络状态。' : '页面请求上下文暂不可用，请刷新页面。'));
    }, type === 'MANUAL' ? 60000 : 1800);
    const receive = (event: MessageEvent) => {
      const message = event.data;
      if (event.source !== window || event.origin !== location.origin || message?.channel !== CHANNEL || message.direction !== 'command-result' || message.id !== id) return;
      window.clearTimeout(timeout);
      window.removeEventListener('message', receive);
      if (message.ok) resolve(message.data as T);
      else reject(new Error(message.error || '页面请求未完成。'));
    };
    window.addEventListener('message', receive);
    window.postMessage({ channel: CHANNEL, direction: 'command', id, type, payload }, location.origin);
  });
}

export function formatTime(time?: number): string {
  if (!time) return '未请求';
  const date = new Date(time);
  const sameDay = date.toDateString() === new Date().toDateString();
  return date.toLocaleString('zh-CN', sameDay
    ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }
    : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function fullTime(time?: number): string { return time ? new Date(time).toLocaleString('zh-CN', { hour12: false }) : '尚未发起真实请求'; }
export function splitList(value: string): string[] { return [...new Set(value.split(/[\n,，]/).map(item => item.trim()).filter(Boolean))]; }
export function formatBytes(value?: number): string { return value == null ? '—' : value < 1024 ? `${value} B` : `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KiB`; }
