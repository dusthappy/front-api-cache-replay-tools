import { CHANNEL, MAX_BODY_BYTES, type RequestDescriptor, type PrepareResult, type CompleteResult, type Completion, type ManualResult, type RuntimeTemplate } from '../shared/types';
import { bridge, requestId } from './bridge';
import { sha256Hex } from './sha256';

const secret = /authorization|cookie|password|passwd|secret|token|signature|csrf|xsrf|api[-_]?key/i;
const singleUse = /signature|csrf|xsrf|nonce/i;
const authPath = /(?:^|\/)(?:login|logout|signin|signout|token|refresh)\/*$/i;
const credentialHeader = /authorization|token|api[-_]?key/i;
const identityCookie = /session|(?:^|[-_])sid(?:$|[-_])|auth|token|user|account|tenant/i;
const encoder = new TextEncoder();
interface Template {
  descriptor: RequestDescriptor; headers: Headers; init: RequestInit; scope: string;
  bindingId: string; variantId: string; canReplay: boolean; reason?: string; updatedAt: number;
}
const templates = new Map<string, Template>();
const currentIdentity = new Map<string, string>();
const currentTenant = new Map<string, string>();
let runtimeGeneration = 0;

export const nativeFetch = window.fetch.bind(window);
export function invalidateRuntime(origin?: string): void {
  runtimeGeneration++;
  for (const [key, value] of templates) {
    if (!origin || new URL(value.descriptor.url).origin === origin) templates.delete(key);
  }
  if (origin) { currentIdentity.delete(origin); currentTenant.delete(origin); }
  else { currentIdentity.clear(); currentTenant.clear(); }
}
export function runtimeVersion(): number { return runtimeGeneration; }

export async function hash(value: string): Promise<string> {
  if (!crypto.subtle) return sha256Hex(encoder.encode(value));
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function safeHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(Array.from(headers).filter(([name]) => !secret.test(name)));
}
async function cookieIdentityFor(url: string, credentials: RequestCredentials): Promise<string | undefined> {
  if (credentials === 'omit' || new URL(url).origin !== location.origin) return undefined;
  // Only fingerprint readable authentication cookies. Analytics/heartbeat cookies
  // must not turn every reload into a new cache partition. No raw cookie crosses
  // the page bridge; HttpOnly cookies remain inaccessible to this script.
  try {
    const values = document.cookie.split(';').map(value => value.trim()).filter(value => {
      const end = value.indexOf('=');
      return end > 0 && identityCookie.test(value.slice(0, end));
    }).sort();
    return hash(JSON.stringify(values));
  } catch { return undefined; }
}
function redactBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactBody);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secret.test(key) ? '[REDACTED]' : redactBody(item)]));
  return value;
}
/** Secrets in URL/body are not sent over the page bridge or used for cache replay. */
export async function descriptorFor(url: string, method: string, headers: Headers, body: string | undefined, credentials: RequestCredentials, pageUrl: string, startedAt: number, source: 'page' | 'manual' = 'page', unsupportedReason?: string): Promise<RequestDescriptor> {
  const parsed = new URL(url, location.href);
  parsed.hash = '';
  let sensitive = Boolean(parsed.username || parsed.password);
  parsed.username = ''; parsed.password = '';
  for (const key of new Set(parsed.searchParams.keys())) {
    if (secret.test(key)) { sensitive = true; parsed.searchParams.set(key, '[REDACTED]'); }
  }
  let safeBody = body;
  if (body) {
    try {
      const parsedBody: unknown = JSON.parse(body);
      const redacted = redactBody(parsedBody);
      if (JSON.stringify(parsedBody) !== JSON.stringify(redacted)) { sensitive = true; safeBody = JSON.stringify(redacted); }
    } catch { unsupportedReason ??= '仅支持 JSON 请求体'; safeBody = undefined; }
  }
  const credentialsInHeaders = Array.from(headers).filter(([name]) => credentialHeader.test(name) && !singleUse.test(name));
  // Preserve the Authorization-only key, while also recognizing common token
  // headers used by local applications. The raw values stay in MAIN memory.
  const identityHash = credentialsInHeaders.length === 1 && credentialsInHeaders[0][0] === 'authorization'
    ? await hash(credentialsInHeaders[0][1]) : credentialsInHeaders.length ? await hash(JSON.stringify(credentialsInHeaders)) : undefined;
  const cookieIdentityHash = await cookieIdentityFor(parsed.href, credentials);
  const tenantHeaders = ['x-tenant-id', 'x-tenant', 'tenant-id', 'x-org-id', 'x-organization-id', 'x-account-id'];
  const tenant = tenantHeaders.filter(name => headers.has(name)).map(name => `${name}:${headers.get(name)}`).join('\n');
  // An absent Authorization header is not proof that a cookie session logged out.
  const priorIdentity = currentIdentity.get(parsed.origin), priorTenant = currentTenant.get(parsed.origin);
  if (identityHash && priorIdentity && priorIdentity !== identityHash || tenant && priorTenant && priorTenant !== tenant) invalidateRuntime(parsed.origin);
  if (identityHash) currentIdentity.set(parsed.origin, identityHash);
  if (tenant) currentTenant.set(parsed.origin, tenant);
  if (authPath.test(parsed.pathname)) invalidateRuntime(parsed.origin);
  const oneTime = Array.from(headers.keys()).some(name => singleUse.test(name)) || Array.from(new URL(url, location.href).searchParams.keys()).some(name => singleUse.test(name));
  return {
    requestId: requestId(), pageUrl, url: parsed.href, method: method.toUpperCase(),
    headers: safeHeaders(headers), body: safeBody, identityHash, cookieIdentityHash, source, startedAt, credentials,
    unsupportedReason: unsupportedReason ?? (sensitive ? '请求含敏感参数，已脱敏并直通' : oneTime ? '请求依赖一次性签名或 CSRF，需由页面触发' : undefined),
  };
}

export function rememberTemplate(result: PrepareResult, descriptor: RequestDescriptor, headers: Headers, init: RequestInit, version: number): void {
  if (descriptor.source !== 'page' || !result.bindingId || !result.variantId || version !== runtimeGeneration) return;
  if (result.invalidateRuntime) {
    const origin = new URL(descriptor.url).origin;
    invalidateRuntime(origin);
    if (descriptor.identityHash) currentIdentity.set(origin, descriptor.identityHash);
    const tenant = ['x-tenant-id', 'x-tenant', 'tenant-id', 'x-org-id', 'x-organization-id', 'x-account-id'].filter(name => headers.has(name)).map(name => `${name}:${headers.get(name)}`).join('\n');
    if (tenant) currentTenant.set(origin, tenant);
  }
  const scope = descriptor.identityHash ?? '';
  if (scope && currentIdentity.get(new URL(descriptor.url).origin) !== scope) return;
  const key = `${result.bindingId}:${result.variantId}`;
  templates.delete(key);
  templates.set(key, {
    descriptor, headers: new Headers(headers), init: { ...init, headers: new Headers(headers), signal: undefined }, scope,
    bindingId: result.bindingId, variantId: result.variantId, canReplay: Boolean(result.canReplay) && !descriptor.unsupportedReason,
    reason: descriptor.unsupportedReason ?? result.replayReason, updatedAt: Date.now(),
  });
  // Raw request templates are short-lived runtime state, never an unbounded body log.
  let retainedBytes = [...templates.values()].reduce((sum, item) => sum + (item.descriptor.body?.length ?? 0) * 2, 0);
  while (templates.size > 200 || retainedBytes > 16 * MAX_BODY_BYTES) {
    const oldest = templates.keys().next().value!;
    retainedBytes -= (templates.get(oldest)!.descriptor.body?.length ?? 0) * 2;
    templates.delete(oldest);
  }
}

export async function readBounded(stream: ReadableStream<Uint8Array> | null, limit = MAX_BODY_BYTES, timeoutMs = 30_000): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => { timer = setTimeout(() => { void reader.cancel().catch(() => undefined); reject(new Error('正文读取超时')); }, timeoutMs); });
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), timedOut]);
      if (done) break;
      length += value.byteLength;
      if (length > limit) { void reader.cancel().catch(() => undefined); throw new Error('响应或请求正文超过 1 MiB'); }
      chunks.push(value);
    }
    const combined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(combined);
  } finally { clearTimeout(timer); }
}

export async function completeResponse(result: PrepareResult, response: Response, startedAt: number): Promise<CompleteResult> {
  if ([401, 403].includes(response.status)) invalidateRuntime(response.url ? new URL(response.url).origin : undefined);
  if (!result.ticket) return { saved: false, success: response.ok, reason: result.reason };
  const completion: Completion = {
    ticket: result.ticket, status: response.status, statusText: response.statusText,
    headers: safeHeaders(response.headers), durationMs: Date.now() - startedAt,
    redirected: response.redirected, responseType: response.type,
  };
  const contentType = response.headers.get('content-type') ?? '';
  if (response.redirected || !/\bjson\b/i.test(contentType) || response.type === 'opaque' || [204, 206].includes(response.status)) completion.unsupportedReason = '仅录制完整、非重定向的 JSON 响应';
  else if (Number(response.headers.get('content-length')) > MAX_BODY_BYTES) completion.unsupportedReason = '响应正文超过 1 MiB';
  else {
    try { completion.bodyText = await readBounded(response.clone().body); }
    catch (error) { completion.unsupportedReason = error instanceof Error ? error.message : '无法读取响应副本'; }
  }
  const completed = await bridge<CompleteResult>('COMPLETE', completion);
  if (completed.invalidateRuntime) invalidateRuntime(response.url ? new URL(response.url).origin : undefined);
  return completed;
}
export function completeFailure(result: PrepareResult | undefined, startedAt: number, error: unknown): void {
  if (!result?.ticket) return;
  const name = error instanceof Error ? error.name : 'Error';
  void bridge('COMPLETE', { ticket: result.ticket, status: 0, statusText: '', headers: {}, durationMs: Date.now() - startedAt, error: name === 'AbortError' ? '请求已取消' : name === 'TimeoutError' ? '请求超时' : '网络请求失败' } satisfies Completion).catch(() => undefined);
}

async function manual(bindingId: string, variantId?: string): Promise<ManualResult> {
  const candidates = [...templates.values()].filter(template => template.bindingId === bindingId && (!variantId || template.variantId === variantId)).sort((a, b) => b.updatedAt - a.updatedAt);
  const template = candidates[0];
  if (!template || !template.canReplay) throw new Error(template?.reason ?? '请先从当前页面触发一次真实请求');
  const origin = new URL(template.descriptor.url).origin;
  if (template.scope && currentIdentity.get(origin) !== template.scope) throw new Error('身份已变化，请从页面重新触发请求');
  const cookieIdentityHash = await cookieIdentityFor(template.descriptor.url, template.descriptor.credentials);
  if (cookieIdentityHash !== template.descriptor.cookieIdentityHash) {
    invalidateRuntime(origin);
    throw new Error('登录 Cookie 已变化，请从页面重新触发请求');
  }
  const startedAt = Date.now();
  const version = runtimeVersion();
  const descriptor = { ...template.descriptor, cookieIdentityHash, requestId: requestId(), source: 'manual' as const, startedAt };
  let result: PrepareResult;
  try { result = await bridge<PrepareResult>('PREPARE', descriptor); }
  catch { throw new Error('扩展连接失败，未发送重新请求'); }
  if (result.invalidateRuntime || version !== runtimeVersion()) {
    invalidateRuntime(origin);
    completeFailure(result, startedAt, new DOMException('Context changed', 'AbortError'));
    throw new Error('身份或配置已变化，请先从页面重新触发请求');
  }
  // Always re-check the current rule. A stale button cannot replay a newly classified write.
  if (!result.canReplay || result.bindingId !== bindingId) {
    completeFailure(result, startedAt, new DOMException('Replay disabled', 'AbortError'));
    throw new Error(result.replayReason ?? '当前规则不允许重新请求');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), 30_000);
  try {
    const response = await nativeFetch(template.descriptor.url, { ...template.init, headers: template.headers, signal: controller.signal, cache: descriptor.method === 'GET' ? 'no-store' : template.init.cache });
    const completed = await completeResponse(result, response, startedAt);
    return { ...completed, pageUrl: descriptor.pageUrl, cacheAllowed: result.ticket?.cacheAllowed };
  } catch (error) { completeFailure(result, startedAt, error); throw error; }
  finally { clearTimeout(timer); }
}

export function installRuntimeCommands(): void {
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.channel !== CHANNEL || message.direction !== 'command' || typeof message.id !== 'string' || message.id.length > 100) return;
    void (async () => {
      let data: unknown;
      if (message.type === 'INVALIDATE_RUNTIME') { invalidateRuntime(); data = true; }
      else if (message.type === 'RUNTIME_LIST') {
        data = [...templates.values()].filter(value => !message.payload?.bindingId || value.bindingId === message.payload.bindingId).map(({ bindingId, variantId, canReplay, reason, updatedAt }): RuntimeTemplate => ({ bindingId, variantId, canReplay, reason, updatedAt }));
      } else if (message.type === 'MANUAL' && typeof message.payload?.bindingId === 'string') data = await manual(message.payload.bindingId, message.payload.variantId);
      else return;
      window.postMessage({ channel: CHANNEL, direction: 'command-result', id: message.id, ok: true, data }, location.origin);
    })().catch((error: unknown) => window.postMessage({ channel: CHANNEL, direction: 'command-result', id: message.id, ok: false, error: error instanceof Error ? error.message : '操作失败' }, location.origin));
  });
}
