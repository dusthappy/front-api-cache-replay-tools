import { MAX_BODY_BYTES, type CacheEntry, type Completion, type CompleteResult, type PrepareResult } from '../shared/types';
import { bridge } from './bridge';
import { completeFailure, descriptorFor, invalidateRuntime, rememberTemplate, runtimeVersion, safeHeaders } from './request-runtime';

const NativeXHR = window.XMLHttpRequest;
type Mode = 'idle' | 'preparing' | 'native' | 'synthetic';
const eventNames = ['readystatechange', 'loadstart', 'progress', 'abort', 'error', 'load', 'timeout', 'loadend'] as const;

/** EventTarget facade: native handles direct requests; a cache hit owns its complete lifecycle. */
class ReplayXMLHttpRequest extends EventTarget {
  static readonly UNSENT = 0; static readonly OPENED = 1; static readonly HEADERS_RECEIVED = 2;
  static readonly LOADING = 3; static readonly DONE = 4;
  readonly UNSENT = 0; readonly OPENED = 1; readonly HEADERS_RECEIVED = 2;
  readonly LOADING = 3; readonly DONE = 4;
  readonly #native = new NativeXHR();
  #mode: Mode = 'idle';
  #sent = false;
  #asynchronous = true;
  #method = 'GET';
  #url = '';
  #pageUrl = '';
  #headers = new Headers();
  #responseType: XMLHttpRequestResponseType = '';
  #timeout = 0;
  #state = 0;
  #entry?: CacheEntry;
  #text = '';
  #parsed: unknown;
  #parsedText?: string;
  #token = 0;
  #timer?: ReturnType<typeof setTimeout>;
  #prepared?: PrepareResult;
  #directPreparation?: Promise<PrepareResult | undefined>;
  #directReason?: string;
  #startedAt = 0;
  #unsupported = false;
  #uploadListeners = false;
  #loadStarted = false;
  readonly #handlers = new Map<string, EventListener>();

  constructor() {
    super();
    for (const type of eventNames) this.#native.addEventListener(type, event => {
      if (this.#mode !== 'native' && !(this.#mode === 'idle' && type === 'readystatechange')) return;
      if (type === 'loadstart' && this.#loadStarted) return;
      if (type === 'loadstart') this.#loadStarted = true;
      if (type === 'readystatechange' && this.#native.readyState === 4) { this.#sent = false; this.#capture(); }
      this.#emit(type, event instanceof ProgressEvent ? event : undefined);
    });
    const upload = this.#native.upload;
    const add = upload.addEventListener;
    upload.addEventListener = ((...args: Parameters<XMLHttpRequestUpload['addEventListener']>) => {
      this.#uploadListeners = true;
      return Reflect.apply(add, upload, args);
    }) as XMLHttpRequestUpload['addEventListener'];
  }
  get [Symbol.toStringTag](): string { return 'XMLHttpRequest'; }
  get readyState(): number { return this.#mode === 'synthetic' ? this.#state : this.#native.readyState; }
  get status(): number { return this.#mode === 'synthetic' ? (this.#state >= 2 ? this.#entry?.status ?? 0 : 0) : this.#native.status; }
  get statusText(): string { return this.#mode === 'synthetic' ? (this.#state >= 2 ? this.#entry?.statusText ?? '' : '') : this.#native.statusText; }
  get responseURL(): string { return this.#mode === 'synthetic' ? (this.#state >= 2 && this.#entry ? this.#url : '') : this.#native.responseURL; }
  get responseType(): XMLHttpRequestResponseType { return this.#responseType; }
  set responseType(value: XMLHttpRequestResponseType) {
    if (this.#mode === 'synthetic' && this.#state >= 3) throw new DOMException('The response is already loading', 'InvalidStateError');
    // Keep raw JSON text in native XHR so cache recording never changes its precision or formatting.
    this.#native.responseType = value === 'json' ? 'text' : value;
    this.#responseType = value;
  }
  get responseText(): string {
    if (this.#responseType !== '' && this.#responseType !== 'text') throw new DOMException('responseText is only available for text responses', 'InvalidStateError');
    return this.#mode === 'synthetic' ? (this.#state >= 3 ? this.#text : '') : this.#native.responseText;
  }
  get response(): unknown {
    if (this.#responseType === 'json') {
      if (this.readyState !== 4) return null;
      const text = this.#mode === 'synthetic' ? this.#text : this.#native.responseText;
      if (this.#parsedText !== text) {
        this.#parsedText = text;
        try { this.#parsed = JSON.parse(text); } catch { this.#parsed = null; }
      }
      return this.#parsed ?? null;
    }
    if (this.#mode === 'synthetic') {
      if (['arraybuffer', 'blob', 'document'].includes(this.#responseType)) {
        if (this.#state !== 4) return null;
        // A caller can select a binary type from its HEADERS_RECEIVED callback after replay began.
        if (this.#responseType === 'arraybuffer') return new TextEncoder().encode(this.#text).buffer;
        if (this.#responseType === 'blob') return new Blob([this.#text], { type: this.getResponseHeader('content-type') ?? '' });
        return null;
      }
      return this.#state >= 3 ? this.#text : '';
    }
    return this.#native.response;
  }
  get responseXML(): Document | null {
    if (this.#responseType !== '' && this.#responseType !== 'document') throw new DOMException('responseXML is unavailable', 'InvalidStateError');
    return this.#mode === 'synthetic' ? null : this.#native.responseXML;
  }
  get timeout(): number { return this.#timeout; }
  set timeout(value: number) {
    this.#native.timeout = value;
    this.#timeout = this.#native.timeout;
    if (this.#mode === 'preparing' && this.#sent) this.#armTimeout();
  }
  get withCredentials(): boolean { return this.#native.withCredentials; }
  set withCredentials(value: boolean) {
    if (this.#sent) throw new DOMException('The request has already been sent', 'InvalidStateError');
    this.#native.withCredentials = value;
  }
  get upload(): XMLHttpRequestUpload { return this.#native.upload; }

  open(method: string, url: string | URL, async = true, username?: string | null, password?: string | null): void {
    this.#token++;
    clearTimeout(this.#timer);
    this.#mode = 'idle'; this.#sent = false; this.#entry = undefined; this.#text = ''; this.#parsedText = undefined;
    this.#headers = new Headers(); this.#prepared = undefined; this.#directPreparation = undefined; this.#directReason = undefined; this.#loadStarted = false;
    this.#method = String(method).toUpperCase(); this.#url = new URL(String(url), location.href).href;
    this.#asynchronous = Boolean(async); this.#unsupported = username != null || password != null;
    // Omitted credentials arguments must stay omitted: null/string coercion belongs to the platform.
    Reflect.apply(this.#native.open, this.#native, Array.from(arguments));
  }
  setRequestHeader(name: string, value: string): void {
    if (this.#sent) throw new DOMException('The request has already been sent', 'InvalidStateError');
    this.#native.setRequestHeader(name, value);
    this.#headers.append(name, value);
  }
  overrideMimeType(mime: string): void { this.#native.overrideMimeType(mime); this.#unsupported = true; }
  getResponseHeader(name: string): string | null {
    if (this.#mode !== 'synthetic') return this.#native.getResponseHeader(name);
    if (this.#state < 2 || !this.#entry || /^(set-cookie|set-cookie2)$/i.test(name)) return null;
    return new Headers(this.#entry.headers).get(name);
  }
  getAllResponseHeaders(): string {
    if (this.#mode !== 'synthetic') return this.#native.getAllResponseHeaders();
    if (this.#state < 2 || !this.#entry) return '';
    return Array.from(new Headers(this.#entry.headers)).filter(([name]) => !/^set-cookie2?$/i.test(name)).map(([name, value]) => `${name}: ${value}\r\n`).join('');
  }
  send(body?: Document | XMLHttpRequestBodyInit | null): void {
    if (this.readyState !== 1 || this.#sent) throw new DOMException('The request is not opened or was already sent', 'InvalidStateError');
    const bodyIgnored = ['GET', 'HEAD'].includes(this.#method);
    const rawBody = bodyIgnored ? undefined : body ?? undefined;
    const uploadUsed = this.#uploadListeners || ['onloadstart', 'onprogress', 'onabort', 'onerror', 'onload', 'ontimeout', 'onloadend'].some(key => Boolean((this.#native.upload as unknown as Record<string, unknown>)[key]));
    let jsonBody = true;
    if (rawBody !== undefined) {
      if (typeof rawBody !== 'string' || !/\bjson\b/i.test(this.#headers.get('content-type') ?? '') || new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) jsonBody = false;
      else { try { JSON.parse(rawBody); } catch { jsonBody = false; } }
    }
    this.#sent = true; this.#startedAt = Date.now(); this.#pageUrl = location.href;
    if (!this.#asynchronous || this.#unsupported || uploadUsed || !jsonBody || !['', 'text', 'json'].includes(this.#responseType) || !/^https?:/.test(this.#url)) {
      this.#mode = 'native';
      // No body inspection or configuration wait: even FormData login and binary 401 responses must invalidate identity state.
      if (/^https?:/.test(this.#url)) {
        this.#directReason = '同步、上传、二进制或不支持的请求体保持直通';
        const origin = new URL(this.#url).origin;
        this.#directPreparation = descriptorFor(this.#url, this.#method, this.#headers, undefined, this.withCredentials ? 'include' : 'same-origin', this.#pageUrl, this.#startedAt, 'page', this.#directReason)
          .then(descriptor => bridge<PrepareResult>('PREPARE', descriptor))
          .then(result => { if (result.invalidateRuntime) invalidateRuntime(origin); return result; })
          .catch(() => undefined);
      }
      try { this.#native.send(body); }
      catch (error) {
        this.#sent = false;
        const pending = this.#directPreparation, startedAt = this.#startedAt;
        this.#directPreparation = undefined;
        if (pending) void pending.then(result => completeFailure(result, startedAt, error));
        throw error;
      }
      return;
    }
    this.#mode = 'preparing';
    const token = ++this.#token;
    this.#armTimeout();
    this.#loadStarted = true;
    this.#emit('loadstart');
    if (!this.#sent || token !== this.#token) return;
    void (async () => {
      const credentials: RequestCredentials = this.#native.withCredentials ? 'include' : 'same-origin';
      try {
        const descriptor = await descriptorFor(this.#url, this.#method, this.#headers, rawBody as string | undefined, credentials, this.#pageUrl, this.#startedAt);
        const version = runtimeVersion();
        if (token !== this.#token || !this.#sent) return;
        const prepared = await bridge<PrepareResult>('PREPARE', descriptor);
        if (token !== this.#token || !this.#sent) { completeFailure(prepared, this.#startedAt, new DOMException('Aborted', 'AbortError')); return; }
        this.#prepared = prepared;
        rememberTemplate(prepared, descriptor, this.#headers, { method: this.#method, headers: this.#headers, body: rawBody as string | undefined, credentials }, version);
        if (prepared.action === 'hit' && prepared.entry && !this.#unsupported && ['', 'text', 'json'].includes(this.#responseType)) { this.#deliver(prepared.entry, token); return; }
      } catch { /* A bridge or storage failure falls through to one native send. */ }
      if (token !== this.#token || !this.#sent) return;
      this.#startNative(body);
    })();
  }
  abort(): void {
    if (this.#mode === 'preparing') { this.#fail('abort'); this.#state = 0; return; }
    if (this.#mode === 'synthetic' && this.#sent) { this.#fail('abort'); this.#state = 0; return; }
    this.#token++;
    this.#native.abort();
    if (this.#mode === 'synthetic') { this.#state = 0; this.#entry = undefined; this.#text = ''; }
  }
  #startNative(body?: Document | XMLHttpRequestBodyInit | null): void {
    clearTimeout(this.#timer);
    if (this.#timeout > 0) {
      const remaining = this.#timeout - (Date.now() - this.#startedAt);
      if (remaining <= 0) { this.#fail('timeout'); return; }
      this.#native.timeout = remaining;
    }
    this.#mode = 'native';
    try { this.#native.send(body); }
    catch (error) { completeFailure(this.#prepared, this.#startedAt, error); this.#fail('error'); }
  }
  #armTimeout(): void {
    clearTimeout(this.#timer);
    if (this.#timeout > 0) this.#timer = setTimeout(() => this.#fail('timeout'), Math.max(0, this.#timeout - (Date.now() - this.#startedAt)));
  }
  #deliver(entry: CacheEntry, token: number): void {
    clearTimeout(this.#timer);
    this.#mode = 'synthetic'; this.#entry = entry;
    const active = () => token === this.#token && this.#sent;
    this.#state = 2; this.#emit('readystatechange');
    if (!active()) return;
    this.#text = entry.bodyText; this.#state = 3; this.#emit('readystatechange');
    if (!active()) return;
    const size = new TextEncoder().encode(entry.bodyText).byteLength;
    const progress = new ProgressEvent('progress', { lengthComputable: true, loaded: size, total: size });
    this.#emit('progress', progress);
    if (!active()) return;
    this.#state = 4; this.#emit('readystatechange');
    if (!active()) return;
    this.#sent = false;
    this.#emit('load', progress); this.#emit('loadend', progress);
  }
  #fail(type: 'abort' | 'timeout' | 'error'): void {
    if (!this.#sent) return;
    clearTimeout(this.#timer);
    this.#token++; this.#sent = false; this.#mode = 'synthetic'; this.#entry = undefined; this.#text = ''; this.#state = 4;
    this.#native.abort();
    completeFailure(this.#prepared, this.#startedAt, new DOMException(type, type === 'abort' ? 'AbortError' : type === 'timeout' ? 'TimeoutError' : 'NetworkError'));
    this.#emit('readystatechange'); this.#emit(type); this.#emit('loadend');
  }
  #emit(type: string, progress?: ProgressEvent): void {
    this.dispatchEvent(type === 'readystatechange' ? new Event(type) : new ProgressEvent(type, { lengthComputable: progress?.lengthComputable ?? false, loaded: progress?.loaded ?? 0, total: progress?.total ?? 0 }));
  }
  #capture(): void {
    const prepared = this.#prepared;
    const directPreparation = this.#directPreparation;
    this.#prepared = undefined;
    this.#directPreparation = undefined;
    const status = this.#native.status;
    if ([401, 403].includes(status)) invalidateRuntime(new URL(this.#url).origin);
    if (!prepared?.ticket && !directPreparation) return;
    const startedAt = this.#startedAt;
    if (!status) {
      completeFailure(prepared, startedAt, new Error('Network error'));
      if (directPreparation) void directPreparation.then(result => completeFailure(result, startedAt, new Error('Network error')));
      return;
    }
    const headers = new Headers();
    for (const line of this.#native.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
      const separator = line.indexOf(':');
      if (separator > 0) headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
    const completion: Omit<Completion, 'ticket'> = { status, statusText: this.#native.statusText, headers: safeHeaders(headers), durationMs: Date.now() - startedAt, redirected: this.#native.responseURL !== this.#url.split('#')[0] };
    if (this.#directReason) completion.unsupportedReason = this.#directReason;
    else if (!/\bjson\b/i.test(headers.get('content-type') ?? '') || [204, 206].includes(status) || !['', 'text', 'json'].includes(this.#responseType)) completion.unsupportedReason = '仅录制完整 JSON 文本响应';
    else {
      const text = this.#native.responseText;
      if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) completion.unsupportedReason = '响应正文超过 1 MiB';
      else completion.bodyText = text;
    }
    const origin = new URL(this.#url).origin;
    const record = async (result: PrepareResult | undefined) => {
      if (!result?.ticket) return;
      const completed = await bridge<CompleteResult>('COMPLETE', { ...completion, ticket: result.ticket } satisfies Completion);
      if (completed.invalidateRuntime) invalidateRuntime(origin);
    };
    void (directPreparation ? directPreparation.then(record) : record(prepared)).catch(() => undefined);
  }
  getHandler(type: string): EventListener | null { return this.#handlers.get(type) ?? null; }
  setHandler(type: string, listener: EventListener | null): void {
    const previous = this.#handlers.get(type);
    if (previous) this.removeEventListener(type, previous);
    if (typeof listener === 'function') { this.#handlers.set(type, listener); this.addEventListener(type, listener); }
    else this.#handlers.delete(type);
  }
}
for (const type of eventNames) Object.defineProperty(ReplayXMLHttpRequest.prototype, `on${type}`, {
  configurable: true, enumerable: true,
  get(this: ReplayXMLHttpRequest) { return this.getHandler(type); },
  set(this: ReplayXMLHttpRequest, listener: EventListener | null) { this.setHandler(type, listener); },
});
export function installXhrInterceptor(): void { window.XMLHttpRequest = ReplayXMLHttpRequest as unknown as typeof XMLHttpRequest; }
