import type { Rule, SiteConfig } from './types';

const SENSITIVE = /authorization|cookie|password|passwd|secret|token|csrf|xsrf|api[-_]?key|signature/i;
export const isSensitiveKey = (key: string): boolean => SENSITIVE.test(key);

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  // An absent JSON Pointer value must never compare equal to explicit JSON null.
  return JSON.stringify(value) ?? 'undefined';
}

export function normalizeQuery(params: URLSearchParams, ignored: string[] = []): string {
  const keys = [...new Set(params.keys())].filter(key => !ignored.includes(key)).sort();
  return stableStringify(keys.map(key => [key, params.getAll(key)]));
}

export function pointerParts(pointer: string): string[] {
  if (!pointer.startsWith('/') || /~(?![01])/u.test(pointer)) throw new Error('Body 字段必须使用有效 JSON Pointer，例如 /pagination/page');
  return pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function valueAtPointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  let result: unknown = value;
  for (const part of pointerParts(pointer)) {
    if (!result || typeof result !== 'object' || !Object.hasOwn(result, part)) return undefined;
    result = (result as Record<string, unknown>)[part];
  }
  return result;
}

export function normalizeBody(body: string | undefined, ignored: string[] = []): string {
  if (body === undefined) return 'absent';
  const parsed: unknown = JSON.parse(body);
  for (const pointer of ignored) {
    const parts = pointerParts(pointer);
    let parent: unknown = parsed;
    for (const key of parts.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) { parent = undefined; break; }
      parent = (parent as Record<string, unknown>)[key];
    }
    if (parent && typeof parent === 'object') {
      const last = parts.at(-1)!;
      // Deleting an array element must not shift the meaning of subsequent indexes.
      if (Array.isArray(parent)) {
        if (/^(0|[1-9]\d*)$/.test(last) && Number(last) < parent.length && Object.hasOwn(parent, last)) {
          parent[Number(last)] = { '$apiCacheReplayIgnored': true };
        }
      } else delete (parent as Record<string, unknown>)[last];
    }
  }
  return `json:${stableStringify(parsed)}`;
}

export function pageRouteKey(pageUrl: string, site: SiteConfig): string {
  const page = new URL(pageUrl);
  const route = site.routeMode === 'hash' ? new URL(page.hash.slice(1) || '/', page.origin) : page;
  return `${site.routeMode}:${route.pathname}?${normalizeQuery(new URLSearchParams([...route.searchParams].filter(([key]) => site.pageIdentityQueryKeys.includes(key))))}`;
}

export function endpointInScope(url: URL, site: SiteConfig): boolean {
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  return site.apiScopeMode === 'all' || site.apiScopes.some(scope => url.origin === scope.origin && url.pathname.startsWith(scope.pathPrefix));
}

export function isAuthPath(pathname: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    if (pattern.startsWith('/')) return pathname === pattern || pathname.startsWith(pattern.endsWith('/') ? pattern : `${pattern}/`);
    return pathname.toLowerCase().split('/').filter(Boolean).at(-1) === pattern.toLowerCase();
  });
}

export function normalizedRequestParts(url: string, body: string | undefined, headers: Record<string, string>, rule: Rule): { normalized: string; query: string; body: string; headers: string } {
  const target = new URL(url);
  const lowerHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const vary = rule.varyHeaders.map(key => key.toLowerCase()).sort().map(key => [key, lowerHeaders[key] ?? null]);
  // Even forced grouping must reject malformed JSON rather than replaying over it.
  const normalizedBody = normalizeBody(body, rule.forceCache ? [] : rule.ignoreBodyPointers);
  const query = rule.forceCache ? 'forced-query' : normalizeQuery(target.searchParams, rule.ignoreQueryKeys);
  const matchedBody = rule.forceCache ? 'forced-body' : normalizedBody;
  return { normalized: stableStringify([rule.method, target.origin, target.pathname, query, matchedBody, vary]), query, body: matchedBody, headers: stableStringify(vary) };
}

export function normalizeRequest(url: string, body: string | undefined, headers: Record<string, string>, rule: Rule): string {
  return normalizedRequestParts(url, body, headers, rule).normalized;
}

export function redactUrl(url: string): string {
  const target = new URL(url);
  target.username = ''; target.password = ''; target.hash = '';
  for (const key of new Set(target.searchParams.keys())) if (isSensitiveKey(key)) target.searchParams.set(key, '[REDACTED]');
  return target.href.slice(0, 8192);
}

export function redactBody(body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  try {
    const redact = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, isSensitiveKey(key) ? '[REDACTED]' : redact(child)]));
      return value;
    };
    const text = JSON.stringify(redact(JSON.parse(body)));
    return text.length > 8192 ? '[请求体过长，未持久化]' : text;
  } catch { return '[不支持的请求体，未持久化]'; }
}

export async function digest(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
