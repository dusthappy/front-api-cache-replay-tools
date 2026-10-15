import { MAX_BODY_BYTES, type CacheEntry, type Completion, type CompleteResult, type PrepareResult } from '../shared/types';
import { bridge } from './bridge';
import { completeFailure, completeResponse, descriptorFor, invalidateRuntime, nativeFetch, readBounded, rememberTemplate, runtimeVersion, safeHeaders } from './request-runtime';

/** Observe authentication boundaries without delaying or reading an unsupported request body. */
function directFetch(input: RequestInfo | URL, init: RequestInit | undefined, reason: string): Promise<Response> {
  const startedAt = Date.now(), pageUrl = location.href;
  const network = nativeFetch(input, init);
  try {
    const original = input instanceof Request ? input : undefined;
    const url = original?.url ?? new URL(String(input), location.href).href;
    const origin = new URL(url).origin;
    const preparing = descriptorFor(url, init?.method ?? original?.method ?? 'GET', new Headers(init?.headers ?? original?.headers), undefined, init?.credentials ?? original?.credentials ?? 'same-origin', pageUrl, startedAt, 'page', reason)
      .then(descriptor => bridge<PrepareResult>('PREPARE', descriptor))
      .then(result => { if (result.invalidateRuntime) invalidateRuntime(origin); return result; })
      .catch(() => undefined);
    void network.then(response => {
      if ([401, 403].includes(response.status)) invalidateRuntime(origin);
      const completion = { status: response.status, statusText: response.statusText, headers: safeHeaders(response.headers), durationMs: Date.now() - startedAt, redirected: response.redirected, responseType: response.type, unsupportedReason: reason };
      return preparing.then(async prepared => {
        if (!prepared?.ticket) return;
        const completed = await bridge<CompleteResult>('COMPLETE', { ...completion, ticket: prepared.ticket } satisfies Completion);
        if (completed.invalidateRuntime) invalidateRuntime(origin);
      });
    }, error => preparing.then(prepared => completeFailure(prepared, startedAt, error))).catch(() => undefined);
  } catch { /* Platform argument validation and network outcome remain the returned native promise. */ }
  return network;
}

function abortAwareResponse(response: Response, signal: AbortSignal): Response {
  // Chrome maps errors from a user-created stream to "TypeError: Failed to fetch" in Body methods.
  // Restore native fetch's AbortError only for an actual signal cancellation.
  for (const method of ['arrayBuffer', 'blob', 'formData', 'json', 'text', 'bytes'] as const) {
    const original = (response as unknown as Record<string, unknown>)[method];
    if (typeof original !== 'function') continue;
    Object.defineProperty(response, method, { configurable: true, writable: true, value: function (this: Response) {
      return (Reflect.apply(original, this, []) as Promise<unknown>).catch((error: unknown) => {
        if (this === response && signal.aborted && error instanceof TypeError) throw new DOMException('The operation was aborted', 'AbortError');
        throw error;
      });
    } });
  }
  const clone = response.clone;
  Object.defineProperty(response, 'clone', { configurable: true, writable: true, value: function (this: Response) {
    const cloned = Reflect.apply(clone, this, []) as Response;
    return this === response ? abortAwareResponse(cloned, signal) : cloned;
  } });
  return response;
}

function replayResponse(entry: CacheEntry, signal: AbortSignal): Response {
  let emitted = false;
  let onAbort: () => void;
  const bytes = new TextEncoder().encode(entry.bodyText);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => controller.error(new DOMException('The operation was aborted', 'AbortError'));
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    },
    pull(controller) {
      if (!emitted && bytes.byteLength) { emitted = true; controller.enqueue(bytes); }
      else { signal.removeEventListener('abort', onAbort); controller.close(); }
    },
    cancel() { signal.removeEventListener('abort', onAbort); },
  });
  return abortAwareResponse(new Response(body, { status: entry.status, statusText: entry.statusText, headers: entry.headers }), signal);
}

export function installFetchInterceptor(): void {
  window.fetch = async function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    // Request exposes every body as a stream, so its repeatability cannot be inferred from Content-Type.
    // Leave those inputs untouched; an explicit string init.body provides a known repeatable replacement.
    if (input instanceof Request && input.body && init?.body == null) return directFetch(input, init, 'Request 流式正文保持直通');
    if (init?.body != null && typeof init.body !== 'string') return directFetch(input, init, '非字符串请求体保持直通');
    // Construct once so Request/init overlays and platform argument validation use Chrome's own implementation.
    const request = new Request(input, init);
    if (request.signal.aborted) throw request.signal.reason;
    if (!['http:', 'https:'].includes(new URL(request.url).protocol)) return nativeFetch(request);
    const startedAt = Date.now();
    const pageUrl = location.href;
    let body: string | undefined;
    let unsupportedReason: string | undefined;
    if (request.body) {
      if (!/\bjson\b/i.test(request.headers.get('content-type') ?? '')) return directFetch(request, undefined, '仅支持 JSON 请求体');
      try { body = await readBounded(request.clone().body, MAX_BODY_BYTES, 100); }
      catch { return directFetch(request, undefined, '正文过大或无法安全复制，保持直通'); }
      try { JSON.parse(body); } catch { unsupportedReason = '仅支持 JSON 请求体'; }
    }
    if (request.mode === 'no-cors') return directFetch(request, undefined, 'no-cors 请求保持直通');
    let prepared: PrepareResult | undefined;
    try {
      const descriptor = await descriptorFor(request.url, request.method, request.headers, body, request.credentials, pageUrl, startedAt, 'page', unsupportedReason);
      const version = runtimeVersion();
      prepared = await bridge<PrepareResult>('PREPARE', descriptor, request.signal);
      const replayInit: RequestInit = {
        method: request.method, body, headers: new Headers(request.headers), credentials: request.credentials,
        mode: request.mode, cache: request.cache, redirect: request.redirect,
        referrer: request.referrer, referrerPolicy: request.referrerPolicy, integrity: request.integrity,
      };
      rememberTemplate(prepared, descriptor, request.headers, replayInit, version);
      if (request.signal.aborted) throw request.signal.reason;
      if (prepared.action === 'hit' && prepared.entry) {
        return replayResponse(prepared.entry, request.signal);
      }
    } catch (error) {
      if (request.signal.aborted) { completeFailure(prepared, startedAt, error); throw request.signal.reason; }
      // This is the only fallback path. A late bridge result has already lost its listener.
    }
    try {
      const response = await nativeFetch(request);
      if (prepared) void completeResponse(prepared, response, startedAt).catch(() => undefined);
      return response;
    } catch (error) {
      completeFailure(prepared, startedAt, error);
      throw error;
    }
  };
}
