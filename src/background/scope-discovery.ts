import type { ApiScopeDiscoveryState, Rule, SiteConfig } from '../shared/types';
import { digest, endpointInScope, stableStringify } from '../shared/normalize';
import type { CacheState, StoredApiScopeDiscovery } from './cache-store';

export const MAX_SCOPE_DISCOVERIES_PER_SITE = 50;
export const MAX_SCOPE_DISCOVERIES_TOTAL = 500;
export const MAX_DISCOVERED_ENDPOINTS = 200;
const MAX_METHODS = 16, MAX_EXAMPLES = 3, MAX_EXAMPLE_LENGTH = 2048;

/** Called only after verified successful JSON, or a hit on such a cached response. */
export async function recordScopeDiscovery(state: CacheState, site: SiteConfig, rule: Rule, now: number): Promise<void> {
  const url = new URL(rule.apiOrigin);
  url.pathname = rule.pathname;
  if (!endpointInScope(url, site)) return;
  const pathPrefix = url.pathname.match(/^\/+[^/]+/)?.[0] ?? url.pathname;
  if (pathPrefix.length > 512) return;
  const id = await digest(stableStringify([site.id, url.origin, pathPrefix]));
  const endpointHash = await digest(stableStringify([rule.method, url.pathname]));
  const previous = state.scopeDiscoveries[id];
  const endpointHashes = previous?.endpointHashes ?? [];
  let capped = previous?.view.endpointCountCapped ?? false;
  if (!endpointHashes.includes(endpointHash)) {
    if (endpointHashes.length < MAX_DISCOVERED_ENDPOINTS) endpointHashes.push(endpointHash);
    else capped = true;
  }
  const methods = [...new Set([...(previous?.view.methods ?? []), rule.method])].slice(0, MAX_METHODS).sort();
  const example = url.pathname.slice(0, MAX_EXAMPLE_LENGTH);
  const examples = [...new Set([...(previous?.view.examples ?? []), example])].slice(0, MAX_EXAMPLES);
  state.scopeDiscoveries[id] = {
    endpointHashes,
    view: { id, siteId: site.id, origin: url.origin, pathPrefix, methods, examples, lastSeenAt: Math.max(previous?.view.lastSeenAt ?? 0, now), endpointCount: endpointHashes.length, ...(capped ? { endpointCountCapped: true } : {}) },
  };
  const evict = (items: StoredApiScopeDiscovery[], maximum: number): void => {
    for (const item of items.sort((a, b) => a.view.lastSeenAt - b.view.lastSeenAt).slice(0, Math.max(0, items.length - maximum))) delete state.scopeDiscoveries[item.view.id];
  };
  evict(Object.values(state.scopeDiscoveries).filter(item => item.view.siteId === site.id), MAX_SCOPE_DISCOVERIES_PER_SITE);
  evict(Object.values(state.scopeDiscoveries), MAX_SCOPE_DISCOVERIES_TOTAL);
}

export function scopeDiscoveryState(state: CacheState, site: SiteConfig): ApiScopeDiscoveryState {
  return {
    siteId: site.id, mode: site.apiScopeMode ?? 'custom',
    scopes: Object.values(state.scopeDiscoveries).filter(item => item.view.siteId === site.id)
      .map(item => ({ ...item.view, methods: [...item.view.methods], examples: [...item.view.examples] }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.origin.localeCompare(b.origin) || a.pathPrefix.localeCompare(b.pathPrefix)),
  };
}

export function clearScopeDiscoveries(state: CacheState, siteId: string): void {
  for (const [id, item] of Object.entries(state.scopeDiscoveries)) if (item.view.siteId === siteId) delete state.scopeDiscoveries[id];
}
