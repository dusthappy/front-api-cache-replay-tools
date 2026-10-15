import { BRIDGE_TIMEOUT_MS, CHANNEL } from '../shared/types';

export function requestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** A timeout removes the listener: late results can never complete a request twice. */
export function bridge<T>(type: 'PREPARE' | 'COMPLETE', payload: unknown, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const id = requestId();
    const finish = (error?: unknown, data?: T) => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      signal?.removeEventListener('abort', onAbort);
      if (error !== undefined) reject(error); else resolve(data as T);
    };
    const onAbort = () => finish(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const message = event.data;
      if (message?.channel !== CHANNEL || message.direction !== 'to-main' || message.id !== id) return;
      if (message.ok) finish(undefined, message.data as T);
      else finish(new Error(typeof message.error === 'string' ? message.error : '扩展暂不可用'));
    };
    const timer = setTimeout(() => finish(new Error('扩展连接超时，已直通')), BRIDGE_TIMEOUT_MS);
    window.addEventListener('message', onMessage);
    signal?.addEventListener('abort', onAbort, { once: true });
    window.postMessage({ channel: CHANNEL, direction: 'to-extension', id, type, payload }, location.origin);
  });
}
