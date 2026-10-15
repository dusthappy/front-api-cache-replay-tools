import type { CacheEntry, CompleteResult, Completion, NetworkReason, NetworkReasonCode, PageConfig, PanelState, PrepareResult, RequestDescriptor, RpcMessage, Rule, SiteConfig, Variant } from '../shared/types';
import { MAX_BODY_BYTES } from '../shared/types';
import { digest, endpointInScope, isAuthPath, isSensitiveKey, normalizedRequestParts, pageRouteKey, pointerParts, redactBody, redactUrl, stableStringify, valueAtPointer } from '../shared/normalize';
import { fingerprintChange, forgetVariantDiagnostics, networkReason, rememberInvalidation } from './network-reason';
import { clearScopeDiscoveries, recordScopeDiscovery, scopeDiscoveryState } from './scope-discovery';
import { evictToBudget, storageStats, type Repository, type RequestFingerprint, type StoreSession, type StoredTicket } from './cache-store';

export interface Sender { id?: string; url?: string; origin?: string; frameId?: number; documentId?: string; tab?: { id?: number; url?: string } }
export interface CoreEnvironment {
  extensionId: string;
  hasPermission(origin: string): Promise<boolean>;
  now?: () => number;
  getBrowserSessionId?: () => Promise<string>;
  synchronizeSites?: (sites: SiteConfig[]) => Promise<void>;
  openOptions?: () => Promise<void>;
}
const MAX_VARIANTS = 4000, MAX_RULES = 2000, MAX_PAGES = 1000;
const DEFAULT_AUTH_PATHS = ['login', 'logout', 'token', 'refresh', 'signin', 'signout'];
const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
const own = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const ensure = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
const lower = (headers: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
const stringList = (value: unknown, max = 50): string[] => {
  ensure(Array.isArray(value) && value.length <= max && value.every(item => typeof item === 'string' && item.length <= 256), '字段列表无效或过长');
  return [...new Set(value as string[])];
};
function ttlValue(value: unknown): number {
  ensure(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 365 * 24 * 3600_000, '有效期须为 0 至 365 天的毫秒数');
  return value as number;
}
function httpUrl(value: unknown): URL {
  ensure(typeof value === 'string' && value.length <= 16384, 'URL 无效或过长');
  const url = new URL(value as string);
  ensure(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, '仅支持无内嵌凭证的 HTTP/HTTPS 地址');
  ensure(!['chrome.google.com', 'chromewebstore.google.com'].includes(url.hostname), 'Chrome 商店页面不允许注入扩展');
  return url;
}
export function originPattern(origin: string): string { const url = new URL(origin); return `${url.protocol}//${url.hostname}/*`; }
const identityKeyFor = (siteId: string, sender: Sender, apiOrigin: string): string => `${siteId}:${stableStringify([sender.tab?.id, sender.documentId ?? 'unknown', apiOrigin])}`;

function clearBindings(session: StoreSession, ids: Set<string>, variantId?: string, diagnosticCode?: NetworkReasonCode): void {
  if (diagnosticCode) {
    for (const [key, trace] of Object.entries(session.state.missTraces)) if (ids.has(trace.bindingId) && (!variantId || trace.variantId === variantId)) delete session.state.missTraces[key];
    if (!variantId) for (const id of ids) rememberInvalidation(session.state, `binding:${id}`, id, diagnosticCode);
    for (const variant of Object.values(session.state.variants)) if (ids.has(variant.bindingId) && (!variantId || variant.id === variantId)) rememberInvalidation(session.state, `variant:${variant.id}`, variant.bindingId, diagnosticCode, variant.id);
  }
  for (const index of Object.values(session.state.index)) if (ids.has(index.bindingId) && (!variantId || variantId === index.variantId)) session.delete(index.key);
  for (const variant of Object.values(session.state.variants)) if (ids.has(variant.bindingId) && (!variantId || variant.id === variantId)) {
    delete variant.cachedAt; delete variant.expiresAt; delete variant.sizeBytes;
  }
  for (const [key, watermark] of Object.entries(session.state.successfulSequences)) if (ids.has(session.state.variants[watermark.variantId]?.bindingId) && (!variantId || watermark.variantId === variantId)) delete session.state.successfulSequences[key];
}
function rulesForSite(session: StoreSession, siteId: string): Rule[] {
  return Object.values(session.state.rules).filter(rule => session.state.pages[rule.pageId]?.siteId === siteId);
}
function invalidateSite(session: StoreSession, site: SiteConfig): void {
  site.generation++;
  clearBindings(session, new Set(rulesForSite(session, site.id).map(rule => rule.id)), undefined, 'IDENTITY_CHANGED');
  for (const key of Object.keys(session.state.identities)) if (key.startsWith(`${site.id}:`)) delete session.state.identities[key];
}
function removeBinding(session: StoreSession, bindingId: string): void {
  clearBindings(session, new Set([bindingId]));
  for (const variant of Object.values(session.state.variants)) if (variant.bindingId === bindingId) { forgetVariantDiagnostics(session.state, variant.id); delete session.state.variants[variant.id]; }
  for (const [key, trace] of Object.entries(session.state.missTraces)) if (trace.bindingId === bindingId) delete session.state.missTraces[key];
  for (const ticket of Object.values(session.state.tickets)) if (ticket.bindingId === bindingId) delete session.state.tickets[ticket.id];
  delete session.state.rules[bindingId];
}
function defaultRule(page: PageConfig, method: string, url: URL, alias = ''): Rule {
  return { id: crypto.randomUUID(), pageId: page.id, method, apiOrigin: url.origin, pathname: url.pathname, alias, enabled: true, forceCache: false, alwaysBypass: false, readOnly: method === 'GET' || method === 'POST', ignoreQueryKeys: [], ignoreBodyPointers: [], varyHeaders: ['accept-language', 'x-tenant-id'], allowNoStore: true, ruleVersion: 1, generation: 1, invalidateBindingIds: [] };
}
function getPage(session: StoreSession, site: SiteConfig, url: string): PageConfig {
  const routeKey = pageRouteKey(url, site);
  let page = Object.values(session.state.pages).find(item => item.siteId === site.id && item.routeKey === routeKey);
  if (!page) {
    ensure(Object.keys(session.state.pages).length < MAX_PAGES, '页面记录已达上限');
    page = { id: crypto.randomUUID(), siteId: site.id, routeKey, cacheEnabled: true, generation: 1 };
    session.state.pages[page.id] = page;
  }
  return page;
}

export class CacheCore {
  private now: () => number;
  constructor(private repository: Repository, private environment: CoreEnvironment) { this.now = environment.now ?? Date.now; }
  private isOptions(sender: Sender): boolean {
    const extensionOrigin = `chrome-extension://${this.environment.extensionId}`;
    return sender.id === this.environment.extensionId
      && sender.url?.split(/[?#]/)[0] === `${extensionOrigin}/options.html`
      && (sender.origin === undefined || sender.origin === extensionOrigin)
      && (sender.frameId === undefined || sender.frameId === 0)
      && (!sender.tab?.url || sender.tab.url.startsWith(`${extensionOrigin}/`));
  }
  private requireOptions(sender: Sender): void { ensure(this.isOptions(sender), '该操作仅允许在扩展设置页执行'); }
  private async siteFor(session: StoreSession, sender: Sender, pageUrl: unknown): Promise<SiteConfig | undefined> {
    ensure(sender.id === this.environment.extensionId && sender.frameId === 0 && typeof sender.tab?.id === 'number', '仅允许已授权的顶层页面');
    const page = httpUrl(pageUrl), senderUrl = httpUrl(sender.url);
    ensure(page.origin === senderUrl.origin && (!sender.origin || sender.origin === page.origin), '页面来源不匹配');
    if (sender.tab?.url) ensure(new URL(sender.tab.url).origin === page.origin, '标签页来源不匹配');
    const site = Object.values(session.state.sites).find(item => item.origin === page.origin);
    return site && await this.environment.hasPermission(site.origin) ? site : undefined;
  }
  private pageRules(session: StoreSession, page: PageConfig): Rule[] { return Object.values(session.state.rules).filter(rule => rule.pageId === page.id); }
  private scopedRule(session: StoreSession, page: PageConfig, bindingId: unknown): Rule {
    const rule = typeof bindingId === 'string' ? session.state.rules[bindingId] : undefined;
    ensure(rule && rule.pageId === page.id, '接口绑定不属于当前页面'); return rule!;
  }
  private validateSite(input: unknown, old?: SiteConfig): SiteConfig {
    ensure(own(input), '网站设置无效'); const site = input as Record<string, any>;
    const origin = httpUrl(site.origin).origin;
    ensure(site.origin === origin || site.origin === `${origin}/`, '网站地址只填写 origin（协议、主机和端口）');
    const apiScopeMode = site.apiScopeMode ?? 'all';
    ensure(['all', 'custom'].includes(apiScopeMode), 'API 范围模式无效');
    const scopeInput = site.apiScopes ?? [];
    ensure(Array.isArray(scopeInput) && scopeInput.length <= 20 && (apiScopeMode === 'all' || scopeInput.length > 0), '自定义模式请配置 1 至 20 个 API 范围');
    const apiScopes = scopeInput.map((scope: any) => {
      ensure(own(scope), 'API 范围无效');
      ensure(typeof scope.pathPrefix === 'string' && scope.pathPrefix.startsWith('/') && !/[?#]/.test(scope.pathPrefix) && scope.pathPrefix.length <= 512, 'API 路径前缀须以 / 开头');
      return { origin: httpUrl(scope.origin).origin, pathPrefix: scope.pathPrefix as string };
    });
    ensure(['history', 'hash'].includes(site.routeMode ?? 'history'), '路由模式无效');
    ensure(['auto', 'unconfigured', 'public', 'authorization', 'session'].includes(site.identityMode ?? 'auto'), '身份模式无效');
    const sessionPartition = String(site.sessionPartition ?? '').trim();
    ensure(sessionPartition.length <= 128 && (site.identityMode !== 'session' || sessionPartition.length > 0), '请为 Cookie 会话填写分区名称');
    const environmentId = String(site.environmentId ?? 'local').trim();
    ensure(environmentId.length > 0 && environmentId.length <= 128, '环境标识无效');
    return { id: old?.id ?? crypto.randomUUID(), origin, environmentId, routeMode: site.routeMode ?? 'history', pageIdentityQueryKeys: stringList(site.pageIdentityQueryKeys ?? []), apiScopeMode, apiScopes, cacheEnabled: site.cacheEnabled !== false, captureEnabled: site.captureEnabled !== false, identityMode: site.identityMode ?? 'auto', sessionPartition, defaultTTL: ttlValue(site.defaultTTL ?? 1800_000), generation: (old?.generation ?? 0) + 1, authPaths: stringList(site.authPaths ?? DEFAULT_AUTH_PATHS), floatingPosition: old?.floatingPosition };
  }
  async handleMessage(message: RpcMessage, sender: Sender): Promise<unknown> {
    ensure(own(message) && typeof message.type === 'string' && message.type.length <= 40, '消息结构无效');
    const payload = message.payload ?? {};
    ensure(own(payload), '消息参数无效');
    ensure(JSON.stringify(payload).length <= 2 * MAX_BODY_BYTES + 100_000, '消息超过大小限制');
    if (message.type === 'OPEN_OPTIONS') {
      await this.repository.run(async session => { ensure(await this.siteFor(session, sender, sender.url), '未授权网站'); });
      await this.environment.openOptions?.(); return true;
    }
    const result = await this.repository.run(async session => {
      const state = session.state;
      if (message.type === 'OPTIONS_GET') { this.requireOptions(sender); return { sites: Object.values(state.sites), paused: state.paused }; }
      if (message.type === 'STORAGE_GET') { this.requireOptions(sender); return storageStats(state); }
      if (message.type === 'CACHE_CLEAR_ALL') {
        this.requireOptions(sender);
        // Commit bodies and metadata together; old completions cannot recreate cleared data.
        for (const rule of Object.values(state.rules)) rule.generation++;
        for (const key of Object.keys(state.index)) session.delete(key);
        state.variants = {}; state.tickets = {}; state.successfulSequences = {};
        state.requestFingerprints = {}; state.missTraces = {}; state.logs = [];
        for (const rule of Object.values(state.rules)) rememberInvalidation(state, `binding:${rule.id}`, rule.id, 'CLEARED');
        return storageStats(state);
      }
      if (message.type === 'API_SCOPES_GET') {
        let site: SiteConfig | undefined;
        if (this.isOptions(sender)) { site = typeof payload.siteId === 'string' ? state.sites[payload.siteId] : undefined; }
        else {
          site = await this.siteFor(session, sender, payload.pageUrl ?? sender.url);
          ensure(payload.siteId === undefined || payload.siteId === site?.id, '范围发现记录不属于当前网站');
        }
        ensure(site, '网站未配置或访问权限已撤销');
        return scopeDiscoveryState(state, site!);
      }
      if (message.type === 'SITE_SAVE') {
        this.requireOptions(sender);
        const old = typeof payload.site?.id === 'string' ? state.sites[payload.site.id] : undefined;
        const site = this.validateSite(payload.site, old);
        ensure(await this.environment.hasPermission(site.origin), '请先授予网站访问权限');
        ensure(!Object.values(state.sites).some(item => item.id !== site.id && item.origin === site.origin), '该网站已配置');
        ensure(old || Object.keys(state.sites).length < 100, '网站数量已达上限');
        if (old) {
          if (old.origin !== site.origin || stableStringify([old.apiScopeMode, old.apiScopes]) !== stableStringify([site.apiScopeMode, site.apiScopes])) clearScopeDiscoveries(state, old.id);
          clearBindings(session, new Set(rulesForSite(session, old.id).map(rule => rule.id)), undefined, 'RULES_CHANGED');
          for (const key of Object.keys(state.identities)) if (key.startsWith(`${old.id}:`)) delete state.identities[key];
        }
        state.sites[site.id] = site; return site;
      }
      if (message.type === 'SITE_DELETE') {
        this.requireOptions(sender);
        const site = state.sites[payload.siteId]; ensure(site, '网站不存在');
        for (const rule of rulesForSite(session, site.id)) removeBinding(session, rule.id);
        for (const page of Object.values(state.pages)) if (page.siteId === site.id) delete state.pages[page.id];
        for (const key of Object.keys(state.identities)) if (key.startsWith(`${site.id}:`)) delete state.identities[key];
        clearScopeDiscoveries(state, site.id);
        delete state.sites[site.id]; return true;
      }
      if (message.type === 'PAUSE') {
        this.requireOptions(sender); ensure(typeof payload.paused === 'boolean', '暂停状态无效');
        state.paused = payload.paused; for (const site of Object.values(state.sites)) site.generation++; return state.paused;
      }
      if (message.type === 'PREPARE') return this.prepare(session, sender, payload as RequestDescriptor);
      if (message.type === 'COMPLETE') return this.complete(session, sender, payload as Completion);
      const site = await this.siteFor(session, sender, payload.pageUrl ?? sender.url);
      if (message.type === 'PANEL' && !site) return null;
      ensure(site, '网站未配置或访问权限已撤销');
      const activeSite = site!;
      const page = getPage(session, activeSite, payload.pageUrl ?? sender.url!);
      if (message.type === 'PANEL') {
        return { site: activeSite, page, paused: state.paused, scopeDiscovery: scopeDiscoveryState(state, activeSite), bindings: this.pageRules(session, page).map(rule => ({ ...rule, variants: Object.values(state.variants).filter(variant => variant.bindingId === rule.id).sort((a, b) => (b.lastPageCallAt ?? 0) - (a.lastPageCallAt ?? 0)) })) } satisfies PanelState;
      }
      if (message.type === 'SITE_PATCH') {
        ensure(own(payload.patch), '网站更新无效'); const patch = payload.patch;
        ensure(Object.keys(patch).every(key => ['cacheEnabled', 'captureEnabled', 'floatingPosition'].includes(key)), '该网站设置只能在扩展设置页修改');
        for (const key of ['cacheEnabled', 'captureEnabled'] as const) if (key in patch) { ensure(typeof patch[key] === 'boolean', '开关值无效'); activeSite[key] = patch[key]; activeSite.generation++; }
        if ('floatingPosition' in patch) {
          ensure(own(patch.floatingPosition) && [patch.floatingPosition.x, patch.floatingPosition.y].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100000), '按钮位置无效');
          activeSite.floatingPosition = { x: patch.floatingPosition.x, y: patch.floatingPosition.y };
        }
        return activeSite;
      }
      if (message.type === 'PAGE_PATCH') {
        ensure(own(payload.patch) && Object.keys(payload.patch).every(key => ['cacheEnabled', 'ttl'].includes(key)), '页面更新无效');
        if ('cacheEnabled' in payload.patch) { ensure(typeof payload.patch.cacheEnabled === 'boolean', '开关值无效'); page.cacheEnabled = payload.patch.cacheEnabled; }
        if ('ttl' in payload.patch) { page.ttl = payload.patch.ttl === null ? undefined : ttlValue(payload.patch.ttl); clearBindings(session, new Set(this.pageRules(session, page).map(rule => rule.id)), undefined, 'RULES_CHANGED'); }
        page.generation++; return page;
      }
      if (message.type === 'BIND_ADD') {
        const url = httpUrl(payload.url); ensure(endpointInScope(url, activeSite), '接口不在已配置 API 范围内');
        const method = String(payload.method ?? 'GET').toUpperCase(); ensure(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method), '请求方法无效');
        const existing = this.pageRules(session, page).find(rule => rule.method === method && rule.apiOrigin === url.origin && rule.pathname === url.pathname);
        if (existing) return existing;
        ensure(Object.keys(state.rules).length < MAX_RULES, '接口绑定已达上限');
        const rule = defaultRule(page, method, url, String(payload.alias ?? '').slice(0, 256)); state.rules[rule.id] = rule; return rule;
      }
      if (message.type === 'RULE_PATCH') {
        const rule = this.scopedRule(session, page, payload.bindingId); this.patchRule(session, rule, payload.patch); return rule;
      }
      if (message.type === 'BIND_DELETE') { const rule = this.scopedRule(session, page, payload.bindingId); removeBinding(session, rule.id); return true; }
      if (message.type === 'CLEAR') {
        const rules = payload.bindingId ? [this.scopedRule(session, page, payload.bindingId)] : this.pageRules(session, page);
        if (payload.variantId) ensure(state.variants[payload.variantId]?.bindingId === payload.bindingId, '参数组合不属于当前接口');
        for (const rule of rules) rule.generation++;
        clearBindings(session, new Set(rules.map(rule => rule.id)), payload.variantId, 'CLEARED'); return true;
      }
      if (message.type === 'PREVIEW') {
        const rule = this.scopedRule(session, page, payload.bindingId);
        ensure(state.variants[payload.variantId]?.bindingId === rule.id, '参数组合不属于当前接口');
        const available = Object.values(state.index).filter(index => index.variantId === payload.variantId).sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
        const identityPrefix = `${identityKeyFor(activeSite.id, sender, rule.apiOrigin)}:`;
        const identityScopes = new Set(sender.documentId ? Object.entries(state.identities).filter(([key]) => key.startsWith(identityPrefix)).map(([, value]) => value) : []);
        // Only identities actually observed in this document may expose a preview.
        for (const index of available) {
          const entry = await session.get(index.key);
          if (entry && identityScopes.has(entry.identityScope)) return { bodyText: entry.bodyText, cachedAt: index.preview ? undefined : entry.cachedAt };
        }
        return { bodyText: '暂无当前身份的响应预览，请先从页面触发请求' };
      }
      throw new Error('不支持的消息类型');
    });
    if (['SITE_SAVE', 'SITE_DELETE'].includes(message.type)) {
      const sites = await this.repository.run(async session => Object.values(session.state.sites));
      await this.environment.synchronizeSites?.(sites);
    }
    return result;
  }
  private patchRule(session: StoreSession, rule: Rule, input: unknown): void {
    ensure(own(input), '接口规则无效'); const patch = input as Record<string, any>;
    const forceChanged = 'forceCache' in patch && Boolean(patch.forceCache) !== Boolean(rule.forceCache);
    const allowed = ['alias', 'enabled', 'forceCache', 'alwaysBypass', 'readOnly', 'ignoreQueryKeys', 'ignoreBodyPointers', 'varyHeaders', 'successCondition', 'ttl', 'allowNoStore', 'invalidateBindingIds'];
    ensure(Object.keys(patch).every(key => allowed.includes(key)), '不可修改接口身份字段');
    if ('alias' in patch) { ensure(typeof patch.alias === 'string' && patch.alias.length <= 256, '别名过长'); rule.alias = patch.alias; }
    for (const key of ['enabled', 'forceCache', 'alwaysBypass', 'readOnly', 'allowNoStore'] as const) if (key in patch) { ensure(typeof patch[key] === 'boolean', '规则开关无效'); rule[key] = patch[key]; }
    if (patch.forceCache === true) {
      const site = session.state.sites[session.state.pages[rule.pageId]?.siteId];
      ensure(site && !rule.alwaysBypass && !isAuthPath(rule.pathname, site.authPaths) && (rule.method === 'GET' || rule.method === 'POST' && rule.readOnly), '仅普通 GET 或允许缓存的 POST 接口可开启强制缓存');
    }
    for (const key of ['ignoreQueryKeys', 'ignoreBodyPointers', 'varyHeaders', 'invalidateBindingIds'] as const) if (key in patch) rule[key] = stringList(patch[key]);
    for (const pointer of rule.ignoreBodyPointers) pointerParts(pointer);
    ensure(rule.varyHeaders.every(header => /^[a-z0-9-]+$/i.test(header) && !isSensitiveKey(header)), '匹配头不能包含 Authorization、Cookie 或敏感凭证');
    for (const id of rule.invalidateBindingIds) ensure(session.state.rules[id]?.pageId === rule.pageId, '写后清空的接口须属于当前页面');
    if ('successCondition' in patch) {
      if (patch.successCondition == null) delete rule.successCondition;
      else {
        ensure(own(patch.successCondition) && typeof patch.successCondition.pointer === 'string' && patch.successCondition.value !== undefined && JSON.stringify(patch.successCondition.value).length < 4096, '业务成功条件无效');
        if (patch.successCondition.pointer !== '') pointerParts(patch.successCondition.pointer);
        rule.successCondition = { pointer: patch.successCondition.pointer, value: patch.successCondition.value };
      }
    }
    if ('ttl' in patch) rule.ttl = patch.ttl === null ? undefined : ttlValue(patch.ttl);
    if (Object.keys(patch).some(key => key !== 'alias')) rule.generation++;
    if (Object.keys(patch).some(key => !['alias', 'enabled', 'alwaysBypass'].includes(key))) { rule.ruleVersion++; clearBindings(session, new Set([rule.id]), undefined, forceChanged ? 'FORCE_MODE_CHANGED' : 'RULES_CHANGED'); }
  }
  private async prepare(session: StoreSession, sender: Sender, request: RequestDescriptor): Promise<PrepareResult> {
    const state = session.state;
    const site = await this.siteFor(session, sender, request.pageUrl);
    if (!site || state.paused || !site.captureEnabled) return { action: 'ignore', reason: state.paused ? '扩展已暂停' : '网站未启用采集或未授权' };
    ensure(typeof request.requestId === 'string' && request.requestId.length >= 8 && request.requestId.length <= 128, '请求 ID 无效');
    ensure(request.source === 'page' || request.source === 'manual', '请求来源无效');
    const url = httpUrl(request.url);
    if (!endpointInScope(url, site) || /(?:\.(?:js|css|map|png|jpg|gif|svg|ico|woff2?)$|\/__vite|\/@vite)/i.test(url.pathname)) return { action: 'ignore', reason: '不在 API 范围内' };
    const method = String(request.method).toUpperCase();
    ensure(/^[A-Z]{1,16}$/.test(method) && own(request.headers) && Object.keys(request.headers).length <= 100 && Object.values(request.headers).every(value => typeof value === 'string' && value.length <= 16384), '请求描述无效');
    ensure(['omit', 'same-origin', 'include'].includes(request.credentials), '请求凭证模式无效');
    ensure(request.body === undefined || typeof request.body === 'string', '请求体无效');
    if (request.body && bytes(request.body) > MAX_BODY_BYTES) return { action: 'ignore', reason: '请求体超过 1 MiB' };
    const headers = lower(request.headers);
    const authHash = headers.authorization ? await digest(headers.authorization) : request.identityHash;
    if (authHash !== undefined) ensure(/^[a-f0-9]{64}$/i.test(authHash), '身份摘要无效');
    if (request.cookieIdentityHash !== undefined) ensure(/^[a-f0-9]{64}$/i.test(request.cookieIdentityHash), 'Cookie 身份摘要无效');
    const now = this.now(), page = getPage(session, site, request.pageUrl);
    let rule = this.pageRules(session, page).find(item => item.method === method && item.apiOrigin === url.origin && item.pathname === url.pathname);
    if (!rule) { ensure(Object.keys(state.rules).length < MAX_RULES, '接口绑定已达上限'); rule = defaultRule(page, method, url); state.rules[rule.id] = rule; }
    const authRequest = isAuthPath(url.pathname, site.authPaths);
    let invalidateRuntime = authRequest;
    if (authRequest) invalidateSite(session, site);
    let identityScope: string | undefined, browserSessionId: string | undefined;
    if (authHash) identityScope = `authorization:${authHash}`;
    else if (site.identityMode === 'auto') {
      try { browserSessionId = await this.environment.getBrowserSessionId?.(); }
      catch { /* A missing browser-session identity must fail open to the network. */ }
      if (typeof browserSessionId === 'string' && browserSessionId.length > 0 && browserSessionId.length <= 256 && Number.isInteger(sender.tab?.id) && sender.tab!.id! >= 0) {
        identityScope = `tab-session:${await digest(stableStringify([browserSessionId, sender.tab!.id, request.cookieIdentityHash ?? '']))}`;
      }
    }
    else if (site.identityMode === 'public') identityScope = 'public';
    else if (site.identityMode === 'session' && site.sessionPartition) identityScope = `session:${await digest(site.sessionPartition)}`;
    // Vary headers also define the runtime context, so a tenant/language switch
    // cannot reuse another context's manual templates or previews.
    const contextHeaderNames = [...new Set(rule.varyHeaders.map(key => key.toLowerCase()))].sort();
    if (identityScope) identityScope += `:context:${await digest(stableStringify(contextHeaderNames.map(key => [key, headers[key] ?? null])))}`;
    const identityKind = authHash ? 'credential' : site.identityMode === 'auto' ? 'auto-cookie' : site.identityMode;
    const identityBase = identityKeyFor(site.id, sender, url.origin);
    const identityChannel = await digest(stableStringify([identityKind, request.credentials, contextHeaderNames]));
    const identityKey = `${identityBase}:${identityChannel}`;
    // Retire pre-channel tracking lazily without invalidating otherwise usable caches.
    delete state.identities[identityBase];
    const priorIdentity = state.identities[identityKey];
    if (identityScope) {
      if (priorIdentity && priorIdentity !== identityScope) { invalidateSite(session, site); invalidateRuntime = true; }
      state.identities[identityKey] = identityScope;
    } else if (priorIdentity) { invalidateSite(session, site); invalidateRuntime = true; delete state.identities[identityKey]; }
    const safe = !authRequest && !rule.alwaysBypass && (method === 'GET' || method === 'POST' && rule.readOnly);
    const unsafeHeaders = Object.keys(headers).some(header => /csrf|xsrf|signature/i.test(header));
    let reason = request.unsupportedReason || (authRequest ? '鉴权接口始终直通' : !safe ? 'POST 缓存已关闭、写操作或始终直通接口' : !identityScope ? (site.identityMode === 'auto' ? '无法识别当前浏览器会话，暂不缓存' : '请先配置身份隔离方式') : unsafeHeaders ? '一次性签名或 CSRF 上下文不支持回放' : undefined);
    let normalized: string, requestBodySupported = true, parts: ReturnType<typeof normalizedRequestParts> | undefined;
    try { parts = normalizedRequestParts(request.url, request.body, headers, rule); normalized = parts.normalized; }
    catch { requestBodySupported = false; normalized = stableStringify([method, url.origin, url.pathname, url.search, request.body ?? null]); reason ||= '请求体不是有效 JSON'; }
    // Credential delivery can alter cookie-dependent responses even when the URL,
    // explicit headers and configured identity partition are otherwise identical.
    const normalizedKey = await digest(stableStringify([request.credentials, normalized]));
    const variantId = await digest(`${rule.id}:${normalizedKey}`);
    const priorVariants = Object.values(state.variants).filter(item => item.bindingId === rule.id);
    const oldFingerprint = state.requestFingerprints[variantId] ?? priorVariants.map(item => state.requestFingerprints[item.id]).filter((item): item is RequestFingerprint => !!item).sort((a, b) => b.sequence - a.sequence)[0];
    let fingerprint: RequestFingerprint | undefined;
    if (parts) {
      const [query, body, matchedHeaders, identity, browserSession] = await Promise.all([digest(parts.query), digest(parts.body), digest(parts.headers), digest(identityScope ?? 'unknown'), browserSessionId ? digest(browserSessionId) : Promise.resolve(undefined)]);
      fingerprint = { query, body, headers: matchedHeaders, identity, session: browserSession, credentials: request.credentials, tabId: sender.tab!.id!, ruleVersion: rule.ruleVersion, sequence: ++state.fingerprintSequence };
    }
    let variant = state.variants[variantId];
    const hadVariant = !!variant;
    if (!variant) {
      if (Object.keys(state.variants).length >= MAX_VARIANTS) {
        const oldest = Object.values(state.variants).sort((a, b) => (a.lastCompletedAt ?? 0) - (b.lastCompletedAt ?? 0))[0];
        clearBindings(session, new Set([oldest.bindingId]), oldest.id); forgetVariantDiagnostics(state, oldest.id); delete state.variants[oldest.id];
      }
      variant = { id: variantId, bindingId: rule.id, normalizedKey, url: redactUrl(request.url), body: redactBody(request.body), lastStatus: 'BYPASS', hitCount: 0 }; state.variants[variantId] = variant;
    }
    const previousStatus = variant.lastStatus, previouslyCached = variant.cachedAt !== undefined;
    const observationSequence = ++state.sequence;
    variant.lastObservedSequence = observationSequence;
    variant.url = redactUrl(request.url); variant.body = redactBody(request.body);
    if (request.source === 'page') variant.lastPageCallAt = now;
    const canReplay = safe && !!identityScope && !unsafeHeaders && !request.unsupportedReason && !reason;
    const cacheAllowed = !reason && site.cacheEnabled && page.cacheEnabled && rule.enabled;
    if (!reason && !cacheAllowed) reason = !site.cacheEnabled ? '网站缓存关闭' : !page.cacheEnabled ? '本页缓存关闭' : '接口缓存关闭';
    const cacheKey = await digest(stableStringify([1, site.id, page.id, site.environmentId, identityScope ?? 'unknown', rule.ruleVersion, normalizedKey]));
    let expired = false;
    if (cacheAllowed && request.source !== 'manual') {
      const cached = await session.get(cacheKey);
      if (cached && (!cached.expiresAt || cached.expiresAt > now)) {
        cached.lastAccessedAt = now; session.put(cacheKey, cached);
        if (request.source === 'page') await recordScopeDiscovery(state, site, rule, now);
        if (fingerprint) state.requestFingerprints[variantId] = fingerprint;
        delete variant.networkReason;
        delete state.missTraces[`cache:${cacheKey}`]; delete state.missTraces[`variant:${variantId}`];
        variant.lastStatus = 'HIT'; variant.lastCompletedAt = now; variant.lastDurationMs = 0; variant.hitCount++; variant.reason = '缓存命中'; delete variant.lastError;
        this.log(session, request.requestId, rule.id, request.source, 'HIT', now);
        return { action: 'hit', entry: cached, bindingId: rule.id, variantId, canReplay, replayReason: canReplay ? undefined : reason, invalidateRuntime };
      }
      if (cached) { expired = true; session.delete(cacheKey); delete variant.cachedAt; delete variant.expiresAt; delete variant.sizeBytes; }
    }
    let diagnostic: NetworkReason;
    const cacheTraceKey = `cache:${cacheKey}`, variantTraceKey = `variant:${variantId}`, bindingTraceKey = `binding:${rule.id}`;
    const trace = state.missTraces[cacheTraceKey] ?? state.missTraces[variantTraceKey] ?? state.missTraces[bindingTraceKey];
    const changed = fingerprint ? fingerprintChange(oldFingerprint, fingerprint) : undefined;
    if (request.source === 'manual') diagnostic = networkReason('MANUAL');
    else if (reason) diagnostic = networkReason(['网站缓存关闭', '本页缓存关闭', '接口缓存关闭'].includes(reason) ? 'CACHE_DISABLED' : 'BYPASS', reason);
    else if (expired) diagnostic = networkReason('EXPIRED');
    else if (trace && trace.code !== 'IDENTITY_CHANGED') diagnostic = networkReason(trace.code);
    else if (changed && ['HEADERS_CHANGED', 'CREDENTIALS_CHANGED', 'SESSION_CHANGED', 'IDENTITY_CHANGED'].includes(changed.code)) diagnostic = changed;
    else if (trace) diagnostic = networkReason(trace.code);
    else if (Object.values(state.tickets).some(active => active.cacheKey === cacheKey && active.cacheAllowed && now - active.startedAt <= 10 * 60_000 && active.siteGeneration === site.generation && active.pageGeneration === page.generation && active.ruleGeneration === rule!.generation)) diagnostic = networkReason('IN_FLIGHT');
    else if (!priorVariants.length) diagnostic = networkReason('FIRST_REQUEST');
    else if (changed) diagnostic = changed;
    else if (hadVariant && oldFingerprint && !previouslyCached && ['ERROR', 'BYPASS'].includes(previousStatus)) diagnostic = networkReason('NOT_RECORDED');
    else diagnostic = networkReason('UNAVAILABLE', oldFingerprint ? '没有找到当前匹配条件下可用的缓存。' : '历史请求尚无参数摘要，无法确定此前未命中的原因。');
    if (!reason) { delete state.missTraces[cacheTraceKey]; delete state.missTraces[variantTraceKey]; delete state.missTraces[bindingTraceKey]; }
    if (fingerprint) state.requestFingerprints[variantId] = fingerprint;
    variant.networkReason = diagnostic;
    variant.lastNetworkAttemptAt = now; variant.lastStatus = 'PENDING'; variant.reason = reason; delete variant.lastError;
    for (const ticket of Object.values(state.tickets)) if (now - ticket.startedAt > 10 * 60_000) delete state.tickets[ticket.id];
    if (Object.keys(state.tickets).length >= 2000) delete state.tickets[Object.keys(state.tickets)[0]];
    const ticket: StoredTicket = { id: crypto.randomUUID(), siteId: site.id, pageId: page.id, bindingId: rule.id, variantId, cacheKey, identityScope: identityScope ?? 'unknown', siteGeneration: site.generation, pageGeneration: page.generation, ruleGeneration: rule.generation, sequence: observationSequence, networkReason: diagnostic, cacheAllowed: !!cacheAllowed, source: request.source, startedAt: now, reason, tabId: sender.tab!.id!, documentId: sender.documentId, origin: site.origin, authRequest, discoveryAllowed: request.source === 'page' && safe && !request.unsupportedReason && !unsafeHeaders && requestBodySupported };
    state.tickets[ticket.id] = ticket;
    return { action: 'network', ticket, reason, networkReason: diagnostic, bindingId: rule.id, variantId, canReplay, replayReason: canReplay ? undefined : reason, invalidateRuntime };
  }
  private log(session: StoreSession, requestId: string, bindingId: string, source: string, status: string, at: number, reason?: string): void {
    session.state.logs.push({ requestId, bindingId, source, status, at, reason: reason?.slice(0, 200) });
    session.state.logs = session.state.logs.slice(-200);
  }
  private async complete(session: StoreSession, sender: Sender, completion: Completion): Promise<CompleteResult> {
    const state = session.state;
    ensure(own(completion.ticket) && typeof completion.ticket.id === 'string', '请求票据无效');
    const ticket = state.tickets[completion.ticket.id];
    if (!ticket) return { saved: false, success: false, reason: '请求票据已过期或已完成' };
    const site = await this.siteFor(session, sender, ticket.origin);
    ensure(site?.id === ticket.siteId && ticket.tabId === sender.tab?.id && ticket.documentId === sender.documentId, '请求票据来源不匹配');
    delete state.tickets[ticket.id];
    const rule = state.rules[ticket.bindingId], page = state.pages[ticket.pageId], variant = state.variants[ticket.variantId];
    if (!site || !rule || !page || !variant) return { saved: false, success: false, reason: '请求所属绑定已删除' };
    ensure(Number.isInteger(completion.status) && completion.status >= 0 && completion.status <= 599 && own(completion.headers) && Object.keys(completion.headers).length <= 100 && Object.values(completion.headers).every(value => typeof value === 'string' && value.length <= 16384), '响应描述无效');
    const now = this.now(), headers = lower(completion.headers);
    let reason = completion.error ? '真实请求失败或已取消' : completion.status < 200 || completion.status >= 300 ? `HTTP ${completion.status}` : undefined;
    let parsed: unknown, jsonValid = false;
    if (completion.bodyText !== undefined) {
      ensure(typeof completion.bodyText === 'string', '响应正文无效');
      try { parsed = JSON.parse(completion.bodyText); jsonValid = true; } catch { /* Response stays untouched; unsupported body is not persisted. */ }
    }
    if (!reason && rule.successCondition && (!jsonValid || valueAtPointer(parsed, rule.successCondition.pointer) === undefined || stableStringify(valueAtPointer(parsed, rule.successCondition.pointer)) !== stableStringify(rule.successCondition.value))) reason = '未满足业务成功条件';
    const success = !reason;
    const invalidateRuntime = ticket.authRequest || completion.status === 401 || completion.status === 403;
    if (invalidateRuntime) invalidateSite(session, site);
    if (success && !['GET', 'HEAD', 'OPTIONS'].includes(rule.method) && !(rule.method === 'POST' && rule.readOnly)) {
      for (const bindingId of rule.invalidateBindingIds) { const affected = state.rules[bindingId]; if (affected?.pageId === rule.pageId) { affected.generation++; clearBindings(session, new Set([bindingId]), undefined, 'CLEARED'); } }
    }
    let recordReason = reason || completion.unsupportedReason;
    if (!recordReason && [204, 206].includes(completion.status)) recordReason = '204 / 部分响应不录制';
    if (!recordReason && (completion.redirected || ['opaque', 'opaqueredirect', 'error'].includes(completion.responseType ?? ''))) recordReason = '重定向或 opaque 响应不录制';
    if (!recordReason && !/\b(?:application|text)\/(?:[a-z0-9.+-]*\+)?json\b/i.test(headers['content-type'] ?? '')) recordReason = '仅录制 JSON 响应';
    if (!recordReason && !jsonValid) recordReason = '响应不是有效 JSON';
    if (!recordReason && completion.bodyText !== undefined && bytes(completion.bodyText) > MAX_BODY_BYTES) recordReason = '响应超过 1 MiB';
    if (!recordReason && /(?:^|,)\s*no-store\b/i.test(headers['cache-control'] ?? '') && !rule.allowNoStore) recordReason = '响应 no-store，未开启允许录制';
    const current = !state.paused && site.captureEnabled && site.generation === ticket.siteGeneration && page.generation === ticket.pageGeneration && rule.generation === ticket.ruleGeneration;
    if (!recordReason && !current) recordReason = '请求期间配置、身份或缓存已变更';
    if (!recordReason && ticket.authRequest) recordReason = '鉴权接口不保存响应';
    let saved = false;
    if (!recordReason && completion.bodyText !== undefined) {
      if (ticket.discoveryAllowed) await recordScopeDiscovery(state, site, rule, now);
      const visibleHeaders = Object.fromEntries(Object.entries(headers).filter(([key]) => !isSensitiveKey(key) && !['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(key)));
      const ttl = rule.ttl ?? page.ttl ?? site.defaultTTL;
      const entry: CacheEntry = { cacheKey: ticket.cacheKey, bindingId: rule.id, variantId: variant.id, identityScope: ticket.identityScope, bodyText: completion.bodyText, status: completion.status, statusText: String(completion.statusText).slice(0, 256), headers: visibleHeaders, cachedAt: now, expiresAt: ttl === 0 ? 0 : now + ttl, sizeBytes: bytes(completion.bodyText), lastAccessedAt: now, sequence: ticket.sequence };
      if (ticket.cacheAllowed && site.cacheEnabled && page.cacheEnabled && rule.enabled && !rule.alwaysBypass) {
        const previous = await session.get(ticket.cacheKey);
        const newestSuccess = Math.max(previous?.sequence ?? 0, state.successfulSequences[ticket.cacheKey]?.sequence ?? 0);
        if (ticket.sequence > newestSuccess) {
          session.put(ticket.cacheKey, entry); state.successfulSequences[ticket.cacheKey] = { sequence: ticket.sequence, variantId: variant.id };
          variant.cachedAt = now; variant.expiresAt = entry.expiresAt; variant.sizeBytes = entry.sizeBytes; saved = true;
          // A watermark can be discarded only when no in-flight ticket can use it.
          // Active tickets are capped at 2,000, so this remains bounded at 6,000.
          const watermarks = Object.entries(state.successfulSequences);
          if (watermarks.length > 6000) {
            const activeKeys = new Set(Object.values(state.tickets).map(active => active.cacheKey));
            let count = watermarks.length;
            for (const [key] of watermarks.sort((a, b) => a[1].sequence - b[1].sequence)) {
              if (count <= 6000) break;
              if (!activeKeys.has(key)) { delete state.successfulSequences[key]; count--; }
            }
          }
        }
        else recordReason = '较新的请求已成功更新缓存';
      } else {
        const key = `preview:${variant.id}`; const previous = await session.get(key);
        if (!previous || ticket.sequence > previous.sequence) session.put(key, entry, true);
        recordReason = ticket.reason ?? '缓存关闭，已更新响应预览';
      }
      evictToBudget(session);
    }
    const completedStatus = !success ? 'ERROR' : saved ? 'MISS' : 'BYPASS';
    const completedReason = recordReason ?? ticket.reason ?? '真实请求并录制';
    // Cache writes follow successful response order above; the panel follows the
    // latest observed request, including HITs that never create a network ticket.
    if (variant.lastObservedSequence === undefined || variant.lastObservedSequence === ticket.sequence) {
      variant.lastCompletedAt = now; variant.lastDurationMs = Number.isFinite(completion.durationMs) ? Math.max(0, completion.durationMs) : now - ticket.startedAt;
      variant.lastStatus = completedStatus; variant.reason = completedReason;
      if (!success) variant.lastError = reason; else delete variant.lastError;
    }
    this.log(session, ticket.id, rule.id, ticket.source, completedStatus, now, completedReason);
    return { saved, success, reason: completedReason, invalidateRuntime };
  }
}
