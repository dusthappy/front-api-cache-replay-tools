export type NetworkReasonCode = 'MANUAL' | 'EXPIRED' | 'CLEARED' | 'RULES_CHANGED' | 'FORCE_MODE_CHANGED' | 'IDENTITY_CHANGED' | 'SESSION_CHANGED' | 'FIRST_REQUEST' | 'QUERY_CHANGED' | 'BODY_CHANGED' | 'PARAMETERS_CHANGED' | 'HEADERS_CHANGED' | 'CREDENTIALS_CHANGED' | 'NOT_RECORDED' | 'IN_FLIGHT' | 'EVICTED' | 'CACHE_DISABLED' | 'BYPASS' | 'UNAVAILABLE';
export interface NetworkReason { code: NetworkReasonCode; label: string; detail?: string }

export type Status = 'HIT' | 'MISS' | 'BYPASS' | 'ERROR' | 'PENDING';
export interface SiteConfig {
  id: string; origin: string; environmentId: string; routeMode: 'history' | 'hash';
  pageIdentityQueryKeys: string[]; apiScopeMode?: 'all' | 'custom'; apiScopes: { origin: string; pathPrefix: string }[];
  cacheEnabled: boolean; captureEnabled: boolean; identityMode: 'auto' | 'unconfigured' | 'public' | 'authorization' | 'session';
  sessionPartition: string; defaultTTL: number; generation: number;
  floatingPosition?: { x: number; y: number }; authPaths: string[];
}
export interface ApiScopeDiscovery {
  readonly id: string; readonly siteId: string; readonly origin: string; readonly pathPrefix: string;
  readonly methods: string[]; readonly examples: string[]; readonly lastSeenAt: number;
  readonly endpointCount: number; readonly endpointCountCapped?: boolean;
}
export interface ApiScopeDiscoveryState { siteId: string; mode: 'all' | 'custom'; scopes: ApiScopeDiscovery[] }
export interface CacheStorageStats {
  cacheBytes: number; previewBytes: number; totalBytes: number; limitBytes: number;
  cacheCount: number; previewCount: number; requestRecordCount: number; pendingCount: number;
}
export interface PageConfig { id: string; siteId: string; routeKey: string; cacheEnabled: boolean; generation: number; ttl?: number }
export interface Rule {
  id: string; pageId: string; method: string; apiOrigin: string; pathname: string; alias: string;
  enabled: boolean; forceCache?: boolean; alwaysBypass: boolean; readOnly: boolean; ignoreQueryKeys: string[]; ignoreBodyPointers: string[];
  varyHeaders: string[]; successCondition?: { pointer: string; value: unknown }; ttl?: number;
  allowNoStore: boolean; ruleVersion: number; generation: number; invalidateBindingIds: string[];
}
export interface RequestDescriptor {
  requestId: string; pageUrl: string; url: string; method: string; headers: Record<string,string>;
  body?: string; identityHash?: string; cookieIdentityHash?: string; source: 'page' | 'manual'; startedAt: number;
  credentials: RequestCredentials; unsupportedReason?: string;
}
export interface Variant {
  id: string; bindingId: string; normalizedKey: string; url: string; body?: string;
  lastObservedSequence?: number;
  lastPageCallAt?: number; lastNetworkAttemptAt?: number; lastCompletedAt?: number;
  networkReason?: NetworkReason; lastStatus: Status; lastDurationMs?: number; lastError?: string; reason?: string;
  cachedAt?: number; expiresAt?: number; sizeBytes?: number; hitCount: number;
}
export interface CacheEntry {
  cacheKey: string; bindingId: string; variantId: string; identityScope: string;
  bodyText: string; status: number; statusText: string; headers: Record<string,string>;
  cachedAt: number; expiresAt: number; sizeBytes: number; lastAccessedAt: number; sequence: number;
}
export interface Ticket {
  id: string; siteId: string; pageId: string; bindingId: string; variantId: string; cacheKey: string;
  identityScope: string; siteGeneration: number; pageGeneration: number; ruleGeneration: number;
  sequence: number; networkReason?: NetworkReason; cacheAllowed: boolean; source: 'page'|'manual'; startedAt: number; reason?: string;
}
export interface PrepareResult {
  action: 'ignore' | 'network' | 'hit'; reason?: string; networkReason?: NetworkReason; ticket?: Ticket; entry?: CacheEntry;
  bindingId?: string; variantId?: string; canReplay?: boolean; replayReason?: string;
  invalidateRuntime?: boolean;
}
export interface Completion {
  ticket: Ticket; status: number; statusText: string; headers: Record<string,string>; bodyText?: string;
  durationMs: number; error?: string; unsupportedReason?: string; redirected?: boolean; responseType?: string;
}
export interface CompleteResult { saved: boolean; reason?: string; success: boolean; invalidateRuntime?: boolean }
export interface BindingView extends Rule { variants: Variant[] }
export interface PanelState { site: SiteConfig; page: PageConfig; bindings: BindingView[]; paused: boolean; scopeDiscovery?: ApiScopeDiscoveryState; extensionVersion?: string }
export interface RuntimeTemplate { bindingId: string; variantId: string; canReplay: boolean; reason?: string; updatedAt: number }
export interface ManualResult { success: boolean; saved: boolean; reason?: string; pageUrl: string; cacheAllowed?: boolean }
export const CHANNEL = 'API_CACHE_REPLAY_V1';
export const MAX_BODY_BYTES = 1024 * 1024;
export const BRIDGE_TIMEOUT_MS = 1200;
export interface RpcMessage { type: string; payload?: any }
export interface RpcResult { ok: boolean; data?: any; error?: string }
