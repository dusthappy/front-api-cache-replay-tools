import { rememberInvalidation } from './network-reason';
import type { ApiScopeDiscovery, CacheEntry, CacheStorageStats, NetworkReasonCode, PageConfig, Rule, SiteConfig, Ticket, Variant } from '../shared/types';

export const TOTAL_CACHE_BYTES = 100 * 1024 * 1024;
export interface StoredTicket extends Ticket { tabId: number; origin: string; authRequest: boolean; documentId?: string; discoveryAllowed?: boolean; }
export interface StoredApiScopeDiscovery { view: ApiScopeDiscovery; endpointHashes: string[] }
export interface BodyIndex { key: string; bindingId: string; variantId: string; sizeBytes: number; lastAccessedAt: number; preview: boolean }
export interface RequestFingerprint { query: string; body: string; headers: string; credentials: RequestCredentials; identity: string; session?: string; tabId: number; ruleVersion: number; sequence: number }
export interface CacheState {
  requestFingerprints: Record<string, RequestFingerprint>; fingerprintSequence: number;
  missTraces: Record<string, { bindingId: string; variantId?: string; code: NetworkReasonCode }>;
  scopeDiscoveries: Record<string, StoredApiScopeDiscovery>;
  schemaVersion: 1 | 2; paused: boolean; sequence: number; sites: Record<string, SiteConfig>;
  pages: Record<string, PageConfig>; rules: Record<string, Rule>; variants: Record<string, Variant>;
  tickets: Record<string, StoredTicket>; index: Record<string, BodyIndex>;
  successfulSequences: Record<string, { sequence: number; variantId: string }>;
  identities: Record<string, string>; logs: { requestId: string; bindingId: string; source: string; status: string; at: number; reason?: string }[];
}
export const emptyState = (): CacheState => ({ requestFingerprints: {}, fingerprintSequence: 0, missTraces: {}, schemaVersion: 2, scopeDiscoveries: {}, paused: false, sequence: 0, sites: {}, pages: {}, rules: {}, variants: {}, tickets: {}, index: {}, successfulSequences: {}, identities: {}, logs: [] });

/** Metadata and body reset commit atomically; callers clear bodies only after success. */
export function migrateState(state: CacheState): boolean {
  state.scopeDiscoveries ??= {};
  state.requestFingerprints ??= {}; state.fingerprintSequence ??= 0; state.missTraces ??= {};
  state.successfulSequences ??= {};
  for (const [key, value] of Object.entries(state.successfulSequences)) if (typeof value === 'number') delete state.successfulSequences[key];
  if (state.schemaVersion !== 1) return false;
  for (const site of Object.values(state.sites)) {
    site.apiScopeMode = 'all'; site.cacheEnabled = true; site.identityMode = 'auto'; site.generation++;
  }
  for (const page of Object.values(state.pages)) { page.cacheEnabled = true; page.generation++; }
  for (const rule of Object.values(state.rules)) {
    rule.enabled = true; rule.allowNoStore = true;
    if (rule.method === 'POST') rule.readOnly = true;
    rule.generation++; rule.ruleVersion++;
  }
  for (const variant of Object.values(state.variants)) {
    delete variant.cachedAt; delete variant.expiresAt; delete variant.sizeBytes;
    variant.lastStatus = 'BYPASS'; variant.reason = '已升级为自动缓存，请重新触发请求';
    delete variant.lastError; delete variant.networkReason; delete variant.lastObservedSequence;
  }
  state.index = {}; state.tickets = {}; state.identities = {}; state.successfulSequences = {};
  state.requestFingerprints = {}; state.missTraces = {}; state.fingerprintSequence = 0;
  state.schemaVersion = 2;
  return true;
}

export interface StoreSession {
  state: CacheState;
  get(key: string): Promise<CacheEntry | undefined>;
  put(key: string, entry: CacheEntry, preview?: boolean): void;
  delete(key: string): void;
}
export interface Repository { run<T>(operation: (session: StoreSession) => Promise<T>): Promise<T> }

export function storageStats(state: CacheState): CacheStorageStats {
  const stats: CacheStorageStats = { cacheBytes: 0, previewBytes: 0, totalBytes: 0, limitBytes: TOTAL_CACHE_BYTES,
    cacheCount: 0, previewCount: 0, requestRecordCount: Object.keys(state.variants).length, pendingCount: Object.keys(state.tickets).length };
  for (const entry of Object.values(state.index)) {
    if (entry.preview) { stats.previewBytes += entry.sizeBytes; stats.previewCount++; }
    else { stats.cacheBytes += entry.sizeBytes; stats.cacheCount++; }
  }
  stats.totalBytes = stats.cacheBytes + stats.previewBytes;
  return stats;
}

function sessionFor(state: CacheState, changes: Map<string, CacheEntry | null>, read: (key: string) => Promise<CacheEntry | undefined>): StoreSession {
  return {
    state,
    async get(key) { return changes.has(key) ? changes.get(key) ?? undefined : read(key); },
    put(key, entry, preview = false) {
      changes.set(key, entry);
      state.index[key] = { key, bindingId: entry.bindingId, variantId: entry.variantId, sizeBytes: entry.sizeBytes, lastAccessedAt: entry.lastAccessedAt, preview };
    },
    delete(key) { changes.set(key, null); delete state.index[key]; },
  };
}

/** Tests use the same transaction contract; production always uses extension-origin IndexedDB. */
export class MemoryRepository implements Repository {
  state = emptyState(); entries = new Map<string, CacheEntry>(); private queue: Promise<unknown> = Promise.resolve();
  run<T>(operation: (session: StoreSession) => Promise<T>): Promise<T> {
    const job = this.queue.then(async () => {
      const state = structuredClone(this.state), changes = new Map<string, CacheEntry | null>();
      const resetBodies = migrateState(state);
      const value = await operation(sessionFor(state, changes, async key => resetBodies ? undefined : structuredClone(this.entries.get(key))));
      if (resetBodies) this.entries.clear();
      for (const [key, entry] of changes) { if (entry) this.entries.set(key, entry); else this.entries.delete(key); }
      this.state = state;
      return value;
    });
    this.queue = job.catch(() => undefined); return job;
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}

export class IndexedDBRepository implements Repository {
  private database?: Promise<IDBDatabase>;
  private queue: Promise<unknown> = Promise.resolve();
  private open(): Promise<IDBDatabase> {
    return this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('api-cache-replay', 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('meta'); request.result.createObjectStore('bodies'); };
      request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); this.database = undefined; }; resolve(request.result); };
      request.onerror = () => { this.database = undefined; reject(request.error); };
    });
  }
  run<T>(operation: (session: StoreSession) => Promise<T>): Promise<T> {
    // Every mutation is serialized in the sole service worker. Only touched bodies are
    // loaded, and metadata plus body changes commit together in one IDB transaction.
    const job = this.queue.then(async () => {
      const db = await this.open();
      const state: CacheState = await requestResult(db.transaction('meta').objectStore('meta').get('state')) ?? emptyState();
      const resetBodies = migrateState(state);
      const changes = new Map<string, CacheEntry | null>();
      const value = await operation(sessionFor(state, changes, key => resetBodies ? Promise.resolve(undefined) : requestResult(db.transaction('bodies').objectStore('bodies').get(key))));
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(['meta', 'bodies'], 'readwrite');
        transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error ?? new Error('数据库事务取消'));
        transaction.objectStore('meta').put(state, 'state');
        if (resetBodies) transaction.objectStore('bodies').clear();
        for (const [key, entry] of changes) { if (entry) transaction.objectStore('bodies').put(entry, key); else transaction.objectStore('bodies').delete(key); }
      });
      return value;
    });
    this.queue = job.catch(() => undefined); return job;
  }
}

export function evictToBudget(session: StoreSession): void {
  const indexes = Object.values(session.state.index);
  let total = indexes.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  for (const entry of indexes.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)) {
    if (total <= TOTAL_CACHE_BYTES) break;
    if (!entry.preview) rememberInvalidation(session.state, `cache:${entry.key}`, entry.bindingId, 'EVICTED', entry.variantId);
    session.delete(entry.key); total -= entry.sizeBytes;
    const variant = session.state.variants[entry.variantId];
    if (variant && !entry.preview) { delete variant.cachedAt; delete variant.expiresAt; delete variant.sizeBytes; }
  }
}
