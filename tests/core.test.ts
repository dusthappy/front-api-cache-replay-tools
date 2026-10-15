import test from 'node:test';
import assert from 'node:assert/strict';
import { CacheCore, type Sender } from '../src/background/core';
import { rememberInvalidation } from '../src/background/network-reason';
import { recordScopeDiscovery } from '../src/background/scope-discovery';
import { evictToBudget, MemoryRepository, TOTAL_CACHE_BYTES } from '../src/background/cache-store';
import { digest, isAuthPath, normalizeBody, normalizeQuery, pageRouteKey, redactBody, redactUrl, stableStringify } from '../src/shared/normalize';
import type { ApiScopeDiscoveryState, CacheEntry, Completion, PanelState, PrepareResult, RequestDescriptor, Rule, SiteConfig } from '../src/shared/types';

const options: Sender = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
const sender: Sender = { id: 'test-extension', url: 'http://localhost:5173/users', origin: 'http://localhost:5173', frameId: 0, documentId: 'test-document', tab: { id: 7, url: 'http://localhost:5173/users' } };
async function fixture(sitePatch: Partial<SiteConfig> = {}) {
  let now = 100_000, permission = true;
  const repository = new MemoryRepository();
  const core = new CacheCore(repository, { extensionId: 'test-extension', hasPermission: async () => permission, now: () => now, getBrowserSessionId: async () => 'test-browser-session' });
  const call = (type: string, payload: any = {}, from = sender) => core.handleMessage({ type, payload }, from);
  const site = await call('SITE_SAVE', { site: { origin: 'http://localhost:5173', apiScopeMode: 'custom', apiScopes: [{ origin: 'http://localhost:5173', pathPrefix: '/api/' }], cacheEnabled: true, identityMode: 'public', ...sitePatch } }, options) as SiteConfig;
  const pageUrl = 'http://localhost:5173/users';
  await call('PAGE_PATCH', { pageUrl, patch: { cacheEnabled: true } });
  const bind = async (url = '/api/users', method = 'GET') => {
    const rule = await call('BIND_ADD', { pageUrl, url: `http://localhost:5173${url}`, method }) as Rule;
    await call('RULE_PATCH', { pageUrl, bindingId: rule.id, patch: { enabled: true } });
    return rule;
  };
  const rule = await bind();
  const prepare = (patch: Partial<RequestDescriptor> = {}, from = sender) => call('PREPARE', { requestId: crypto.randomUUID(), pageUrl, url: 'http://localhost:5173/api/users', method: 'GET', headers: {}, source: 'page', startedAt: now, credentials: 'same-origin', ...patch }, from) as Promise<PrepareResult>;
  const complete = (prepared: PrepareResult, patch: Partial<Completion> = {}, from = sender) => call('COMPLETE', { ticket: prepared.ticket!, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, bodyText: '{"version":1}', durationMs: 20, ...patch }, from) as Promise<{ saved: boolean; success: boolean; reason?: string }>;
  const panel = () => call('PANEL', { pageUrl }) as Promise<PanelState>;
  return { core, repository, call, site, pageUrl, rule, bind, prepare, complete, panel, advance: (ms: number) => { now += ms; }, revoke: () => { permission = false; } };
}

test('normalization preserves duplicate query order, types, arrays and exact JSON Pointer keys', () => {
  assert.equal(normalizeQuery(new URLSearchParams('b=2&a=1&a=3')), normalizeQuery(new URLSearchParams('a=1&a=3&b=2')));
  assert.notEqual(normalizeQuery(new URLSearchParams('a=1&a=3')), normalizeQuery(new URLSearchParams('a=3&a=1')));
  assert.notEqual(normalizeQuery(new URLSearchParams('a=')), normalizeQuery(new URLSearchParams('')));
  assert.equal(normalizeBody('{"b":2,"a":1}'), normalizeBody('{"a":1,"b":2}'));
  assert.notEqual(normalizeBody('[1,2]'), normalizeBody('[2,1]'));
  assert.notEqual(normalizeBody('{"a":1}'), normalizeBody('{"a":"1"}'));
  assert.notEqual(normalizeBody(undefined), normalizeBody('null'));
  assert.notEqual(stableStringify(undefined), stableStringify(null));
  assert.equal(normalizeBody('{"array":[1,2]}', ['/array/999999999']), normalizeBody('{"array":[1,2]}'));
  assert.equal(normalizeBody('{"array":[1,2]}', ['/array/01', '/array/length']), normalizeBody('{"array":[1,2]}'));
  assert.equal(normalizeBody('{"a.b":{"c/d":1},"keep":2}', ['/a.b/c~1d']), normalizeBody('{"a.b":{"c/d":9},"keep":2}', ['/a.b/c~1d']));
  assert.throws(() => normalizeBody('{}', ['body.page']));
});

test('capture miss, hit, manual refresh and three timestamps remain distinct', async () => {
  const f = await fixture();
  const first = await f.prepare(); assert.equal(first.action, 'network');
  f.advance(20); assert.equal((await f.complete(first)).saved, true);
  let variant = (await f.panel()).bindings[0].variants[0];
  const attempt = variant.lastNetworkAttemptAt, cached = variant.cachedAt;
  f.advance(100); const hit = await f.prepare(); assert.equal(hit.action, 'hit'); assert.equal(hit.entry?.bodyText, '{"version":1}');
  variant = (await f.panel()).bindings[0].variants[0];
  assert.equal(variant.lastNetworkAttemptAt, attempt); assert.equal(variant.cachedAt, cached); assert.equal(variant.hitCount, 1);
  const pageCall = variant.lastPageCallAt;
  f.advance(100); const manual = await f.prepare({ source: 'manual' }); assert.equal(manual.action, 'network');
  assert.equal((await f.complete(manual, { bodyText: '{"version":2}' })).saved, true);
  variant = (await f.panel()).bindings[0].variants[0]; assert.equal(variant.lastPageCallAt, pageCall); assert.notEqual(variant.lastNetworkAttemptAt, attempt);
  assert.equal((await f.prepare()).entry?.bodyText, '{"version":2}');
});

test('ignored query updates latest redacted original, rule change invalidates previous grouping', async () => {
  const f = await fixture();
  await f.call('RULE_PATCH', { pageUrl: f.pageUrl, bindingId: f.rule.id, patch: { ignoreQueryKeys: ['page'] } });
  await f.complete(await f.prepare({ url: 'http://localhost:5173/api/users?page=2&status=active' }));
  assert.equal((await f.prepare({ url: 'http://localhost:5173/api/users?status=active&page=3' })).action, 'hit');
  assert.match((await f.panel()).bindings[0].variants[0].url, /page=3/);
  assert.equal((await f.prepare({ url: 'http://localhost:5173/api/users?page=3&status=disabled' })).action, 'network');
  await f.call('RULE_PATCH', { pageUrl: f.pageUrl, bindingId: f.rule.id, patch: { ignoreQueryKeys: [] } });
  assert.equal((await f.prepare({ url: 'http://localhost:5173/api/users?page=2&status=active' })).action, 'network');
});

test('credentials modes isolate cookie-dependent groups without clearing other cached variants', async () => {
  const f = await fixture({ identityMode: 'session', sessionPartition: 'test-account' });
  const omit = await f.prepare({ credentials: 'omit' });
  assert.equal((await f.complete(omit, { bodyText: '{"user":"anonymous"}' })).saved, true);
  const include = await f.prepare({ credentials: 'include' });
  assert.equal(include.action, 'network'); assert.notEqual(include.variantId, omit.variantId);
  assert.equal((await f.complete(include, { bodyText: '{"user":"signed-in"}' })).saved, true);
  assert.equal((await f.prepare({ credentials: 'omit' })).entry?.bodyText, '{"user":"anonymous"}');
  assert.equal((await f.prepare({ credentials: 'include' })).entry?.bodyText, '{"user":"signed-in"}');
  const sameOrigin = await f.prepare({ credentials: 'same-origin' });
  assert.equal(sameOrigin.action, 'network'); assert.notEqual(sameOrigin.variantId, include.variantId); assert.notEqual(sameOrigin.variantId, omit.variantId);
  assert.equal((await f.panel()).bindings[0].variants.length, 3);
  await assert.rejects(f.prepare({ credentials: 'invalid' as RequestCredentials }), /凭证模式无效/);
});

test('clear and close/reopen prevent in-flight writes; toggles retain previously successful data', async () => {
  const f = await fixture();
  const first = await f.prepare(); await f.call('CLEAR', { pageUrl: f.pageUrl });
  assert.equal((await f.complete(first)).saved, false);
  const second = await f.prepare();
  await f.call('PAGE_PATCH', { pageUrl: f.pageUrl, patch: { cacheEnabled: false } });
  await f.call('PAGE_PATCH', { pageUrl: f.pageUrl, patch: { cacheEnabled: true } });
  assert.equal((await f.complete(second)).saved, false);
  await f.complete(await f.prepare());
  await f.call('PAGE_PATCH', { pageUrl: f.pageUrl, patch: { cacheEnabled: false } });
  const off = await f.prepare({ source: 'manual' }); assert.equal(off.ticket?.cacheAllowed, false);
  assert.equal((await f.complete(off, { bodyText: '{"off":true}' })).saved, false);
  await f.call('PAGE_PATCH', { pageUrl: f.pageUrl, patch: { cacheEnabled: true } });
  assert.equal((await f.prepare()).entry?.bodyText, '{"version":1}');
});

test('newer successful request wins; newer failure does not discard an older success', async () => {
  const f = await fixture();
  const older = await f.prepare(), newer = await f.prepare();
  assert.equal((await f.complete(newer, { bodyText: '{"order":2}' })).saved, true);
  assert.equal((await f.complete(older, { bodyText: '{"order":1}' })).saved, false);
  assert.equal((await f.prepare()).entry?.bodyText, '{"order":2}');
  const delayed = await f.prepare({ source: 'manual' }), refreshed = await f.prepare({ source: 'manual' });
  assert.equal((await f.complete(refreshed, { bodyText: '{"order":4}' })).saved, true);
  // LRU eviction must not lose the last successful sequence watermark.
  await f.repository.run(async session => { session.delete(refreshed.ticket!.cacheKey); });
  assert.equal((await f.complete(delayed, { bodyText: '{"order":3}' })).saved, false);
  await f.call('CLEAR', { pageUrl: f.pageUrl });
  const pending = await f.prepare(), failed = await f.prepare();
  assert.equal((await f.complete(failed, { status: 500 })).saved, false);
  assert.equal((await f.complete(pending)).saved, true);
});

test('failure preserves successful cache timestamp; 401 invalidates it', async () => {
  const f = await fixture(); await f.complete(await f.prepare());
  const cachedAt = (await f.panel()).bindings[0].variants[0].cachedAt;
  f.advance(100); assert.equal((await f.complete(await f.prepare({ source: 'manual' }), { status: 500 })).success, false);
  const variant = (await f.panel()).bindings[0].variants[0]; assert.equal(variant.cachedAt, cachedAt); assert.equal(variant.lastStatus, 'ERROR');
  assert.equal((await f.prepare()).action, 'hit');
  await f.complete(await f.prepare({ source: 'manual' }), { status: 401 });
  assert.equal((await f.prepare()).action, 'network');
});

test('POST cache opt-out and business success condition are enforced; writes invalidate explicit dependencies', async () => {
  const f = await fixture(); const post = await f.bind('/api/query', 'POST');
  const request = { url: 'http://localhost:5173/api/query', method: 'POST', body: '{"page":1}' };
  await f.call('RULE_PATCH', { pageUrl: f.pageUrl, bindingId: post.id, patch: { readOnly: false } });
  let pending = await f.prepare(request); assert.equal(pending.canReplay, false); assert.equal((await f.complete(pending)).saved, false);
  await f.call('RULE_PATCH', { pageUrl: f.pageUrl, bindingId: post.id, patch: { readOnly: true, successCondition: { pointer: '/code', value: 0 } } });
  assert.equal((await f.complete(await f.prepare(request), { bodyText: '{"code":1}' })).success, false);
  assert.equal((await f.complete(await f.prepare(request), { bodyText: '{"code":0}' })).saved, true);
  assert.equal((await f.prepare(request)).action, 'hit');
  await f.complete(await f.prepare());
  const writer = await f.bind('/api/write', 'PUT');
  await f.call('RULE_PATCH', { pageUrl: f.pageUrl, bindingId: writer.id, patch: { invalidateBindingIds: [f.rule.id] } });
  pending = await f.prepare({ method: 'PUT', url: 'http://localhost:5173/api/write' });
  assert.equal(pending.canReplay, false); await f.complete(pending);
  assert.equal((await f.prepare()).action, 'network');
});

test('a missing business-success pointer is distinct from an explicit null value', async () => {
  const f = await fixture();
  await f.call('RULE_PATCH', { pageUrl: f.pageUrl, bindingId: f.rule.id, patch: { successCondition: { pointer: '/missing', value: null } } });
  const absent = await f.complete(await f.prepare(), { bodyText: '{}' });
  assert.equal(absent.success, false); assert.equal(absent.saved, false);
  const explicitNull = await f.complete(await f.prepare(), { bodyText: '{"missing":null}' });
  assert.equal(explicitNull.success, true); assert.equal(explicitNull.saved, true);
});

test('authorization digest, tenant headers, pages and environments partition cache without plaintext credentials', async () => {
  const f = await fixture({ identityMode: 'authorization' });
  assert.equal((await f.prepare()).ticket?.cacheAllowed, false);
  const alice = { headers: { authorization: 'Bearer sensitive-alice', 'x-tenant-id': 'one' } };
  await f.complete(await f.prepare(alice)); assert.equal((await f.prepare(alice)).action, 'hit');
  assert.equal((await f.prepare({ headers: { ...alice.headers, 'x-tenant-id': 'two' } })).action, 'network');
  assert.equal((await f.prepare({ identityHash: await digest('Bearer bob') })).action, 'network');
  assert.equal((await f.prepare(alice)).action, 'network');
  assert.ok(!JSON.stringify(f.repository.state).includes('sensitive-alice'));
  const other = 'http://localhost:5173/orders';
  assert.equal((await f.prepare({ ...alice, pageUrl: other })).action, 'network');
  assert.equal(Object.values(f.repository.state.pages).length, 2);
  await f.call('SITE_SAVE', { site: { ...f.site, environmentId: 'staging' } }, options);
  assert.equal((await f.prepare(alice)).action, 'network');
});

test('no-store, unsupported responses and TTL enforce recording bounds', async () => {
  const f = await fixture({ defaultTTL: 1000 });
  const noStore = { headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' } };
  await f.call('RULE_PATCH', { pageUrl: f.pageUrl, bindingId: f.rule.id, patch: { allowNoStore: false } });
  assert.equal((await f.complete(await f.prepare(), noStore)).saved, false);
  await f.call('RULE_PATCH', { pageUrl: f.pageUrl, bindingId: f.rule.id, patch: { allowNoStore: true } });
  assert.equal((await f.complete(await f.prepare(), noStore)).saved, true);
  f.advance(1001); assert.equal((await f.prepare()).action, 'network');
  assert.equal((await f.complete(await f.prepare(), { status: 206 })).saved, false);
  assert.equal((await f.complete(await f.prepare(), { redirected: true })).saved, false);
  assert.equal((await f.complete(await f.prepare(), { bodyText: '"' + 'x'.repeat(1024 * 1024) + '"' })).saved, false);
});

test('sender authorization, exact port, request tickets and permissions cannot be bypassed', async () => {
  const f = await fixture();
  const optionsInTab = { ...options, origin: 'chrome-extension://test-extension', frameId: 0, tab: { id: 12, url: options.url } };
  assert.equal((await f.call('OPTIONS_GET', {}, optionsInTab) as { sites: SiteConfig[] }).sites.length, 1);
  await assert.rejects(f.call('OPTIONS_GET', {}, { ...optionsInTab, origin: 'http://localhost:5173' }), /扩展设置页/);
  await assert.rejects(f.call('SITE_DELETE', { siteId: f.site.id }), /扩展设置页/);
  await assert.rejects(f.prepare({}, { ...sender, frameId: 1 }), /顶层页面/);
  await assert.rejects(f.prepare({ pageUrl: 'http://localhost:9999/users' }), /来源不匹配/);
  assert.equal((await f.prepare({ url: 'http://localhost:9999/api/users' })).action, 'ignore');
  const pending = await f.prepare();
  await assert.rejects(f.complete(pending, {}, { ...sender, tab: { id: 8, url: sender.url } }), /票据来源/);
  const forged = { ...pending, ticket: { ...pending.ticket!, cacheKey: 'forged', bindingId: 'forged', siteGeneration: 999 } };
  assert.equal((await f.complete(forged)).saved, true);
  assert.ok(!f.repository.entries.has('forged'));
  assert.equal((await f.complete(pending)).saved, false);
  f.revoke(); assert.equal((await f.prepare()).action, 'ignore'); assert.equal(await f.call('PANEL', { pageUrl: f.pageUrl }), null);
});

test('auth endpoints invalidate existing cache and never persist token-bearing response previews', async () => {
  const f = await fixture(); await f.complete(await f.prepare());
  const login = await f.prepare({ url: 'http://localhost:5173/api/login', method: 'POST', body: '{"password":"secret"}' });
  // Business requests completing while login/logout is pending must be invalidated again.
  const duringAuth = await f.prepare(); await f.complete(duringAuth);
  assert.equal((await f.prepare()).action, 'hit');
  assert.equal(login.canReplay, false);
  const authResult = await f.complete(login, { bodyText: '{"token":"DO-NOT-PERSIST"}' });
  assert.equal((authResult as { invalidateRuntime?: boolean }).invalidateRuntime, true);
  assert.equal((await f.prepare()).action, 'network');
  assert.ok(!JSON.stringify([...f.repository.entries.values()]).includes('DO-NOT-PERSIST'));
  assert.ok(!JSON.stringify(f.repository.state).includes('"password":"secret"'));
});

test('request redaction and route identity are precise', async () => {
  const f = await fixture();
  assert.equal(new URL(redactUrl('https://api.local/users?access_token=secret&page=1')).searchParams.get('access_token'), '[REDACTED]');
  assert.equal(redactBody('{"password":"secret","nested":{"apiKey":"secret","page":2}}'), '{"password":"[REDACTED]","nested":{"apiKey":"[REDACTED]","page":2}}');
  assert.equal(pageRouteKey('http://localhost:5173/users?q=1#anchor', f.site), pageRouteKey('http://localhost:5173/users?q=2', f.site));
  assert.notEqual(pageRouteKey('http://localhost:5173/users/1', f.site), pageRouteKey('http://localhost:5173/users/2', f.site));
  const hashSite = { ...f.site, routeMode: 'hash' as const, pageIdentityQueryKeys: ['id'] };
  assert.notEqual(pageRouteKey('http://localhost:5173/#/users?id=1', hashSite), pageRouteKey('http://localhost:5173/#/users?id=2', hashSite));
});

test('capacity uses LRU across cache and previews, clears evicted metadata and commits atomically', async () => {
  const repository = new MemoryRepository();
  await repository.run(async session => {
    session.state.variants.old = { id: 'old', bindingId: 'rule', normalizedKey: 'old', url: 'http://localhost/api', lastStatus: 'MISS', hitCount: 0, cachedAt: 1, sizeBytes: 60 * 1024 * 1024 };
    const entry = (key: string, size: number, lastAccessedAt: number): CacheEntry => ({ cacheKey: key, bindingId: 'rule', variantId: key, identityScope: 'public', bodyText: '{}', status: 200, statusText: 'OK', headers: {}, cachedAt: 1, expiresAt: 0, sizeBytes: size, lastAccessedAt, sequence: 1 });
    // Synthetic sizes exercise the production accounting without allocating 100 MiB.
    session.put('old', entry('old', 60 * 1024 * 1024, 1));
    session.put('recent', entry('recent', 30 * 1024 * 1024, 3));
    session.put('preview:newest', entry('newest', 30 * 1024 * 1024, 4), true);
    evictToBudget(session);
    assert.ok(Object.values(session.state.index).reduce((sum, item) => sum + item.sizeBytes, 0) <= TOTAL_CACHE_BYTES);
    assert.equal(await session.get('old'), undefined); assert.ok(await session.get('recent')); assert.ok(await session.get('preview:newest'));
    assert.equal(session.state.variants.old.cachedAt, undefined);
  });
  await assert.rejects(repository.run(async session => { session.delete('recent'); session.state.paused = true; throw new Error('模拟写入前失败'); }));
  assert.equal(repository.state.paused, false); assert.ok(repository.entries.has('recent'));
});

test('pause halts capture, bounded logs/previews replace data and service-worker core recreation restores state', async () => {
  const f = await fixture();
  await f.call('PAUSE', { paused: true }, options);
  assert.equal((await f.prepare()).action, 'ignore'); assert.equal(Object.keys(f.repository.state.variants).length, 0);
  await f.call('PAUSE', { paused: false }, options);
  await f.call('PAGE_PATCH', { pageUrl: f.pageUrl, patch: { cacheEnabled: false } });
  for (let index = 0; index < 205; index++) await f.complete(await f.prepare({ source: 'manual' }), { bodyText: JSON.stringify({ index }) });
  assert.equal(f.repository.state.logs.length, 200); assert.equal(f.repository.entries.size, 1);
  const variant = (await f.panel()).bindings[0].variants[0];
  const preview = await f.call('PREVIEW', { pageUrl: f.pageUrl, bindingId: f.rule.id, variantId: variant.id }) as { bodyText: string };
  assert.equal(preview.bodyText, '{"index":204}');
  const restarted = new CacheCore(f.repository, { extensionId: 'test-extension', hasPermission: async () => true });
  const restored = await restarted.handleMessage({ type: 'PANEL', payload: { pageUrl: f.pageUrl } }, sender) as PanelState;
  assert.equal(restored.bindings[0].variants[0].lastStatus, 'BYPASS');
  assert.equal(restored.page.cacheEnabled, false);
});

test('variant metadata is bounded and previews cannot cross document identity contexts', async () => {
  const f = await fixture();
  for (let index = 0; index < 4000; index++) f.repository.state.variants[`old-${index}`] = { id: `old-${index}`, bindingId: f.rule.id, normalizedKey: String(index), url: `http://localhost:5173/api/users?id=${index}`, lastStatus: 'BYPASS', hitCount: 0, lastCompletedAt: index };
  const prepared = await f.prepare(); await f.complete(prepared);
  assert.equal(Object.keys(f.repository.state.variants).length, 4000); assert.equal(f.repository.state.variants['old-0'], undefined);
  const otherDocument = { ...sender, documentId: 'new-document' };
  const preview = await f.call('PREVIEW', { pageUrl: f.pageUrl, bindingId: f.rule.id, variantId: prepared.variantId }, otherDocument) as { bodyText: string };
  assert.match(preview.bodyText, /当前身份/);
  await assert.rejects(f.call('RULE_PATCH', { pageUrl: f.pageUrl, bindingId: f.rule.id, patch: { successCondition: { pointer: '/code', value: undefined } } }), /成功条件无效/);
});


async function defaultFixture(sessionAvailable = true) {
  let browserSessionId = 'test-browser-session';
  const repository = new MemoryRepository();
  const core = new CacheCore(repository, { extensionId: 'test-extension', hasPermission: async () => true, getBrowserSessionId: sessionAvailable ? async () => browserSessionId : undefined });
  const call = (type: string, payload: any = {}, from = sender) => core.handleMessage({ type, payload }, from);
  const site = await call('SITE_SAVE', { site: { origin: 'http://localhost:5173' } }, options) as SiteConfig;
  const prepare = (patch: Partial<RequestDescriptor> = {}, from = sender) => call('PREPARE', { requestId: crypto.randomUUID(), pageUrl: sender.url, url: 'http://localhost:5173/users/list', method: 'GET', headers: {}, source: 'page', startedAt: Date.now(), credentials: 'include', ...patch }, from) as Promise<PrepareResult>;
  const complete = (prepared: PrepareResult, patch: Partial<Completion> = {}, from = sender) => call('COMPLETE', { ticket: prepared.ticket!, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, bodyText: '{"automatic":true}', durationMs: 20, ...patch }, from) as Promise<{ saved: boolean; success: boolean; reason?: string }>;
  return { repository, core, call, site, prepare, complete, rotateBrowserSession: (id: string) => { browserSessionId = id; } };
}

test('adding only a website automatically discovers and caches all HTTP API origins and POST requests', async () => {
  const f = await defaultFixture();
  assert.equal(f.site.apiScopeMode, 'all'); assert.equal(f.site.identityMode, 'auto'); assert.equal(f.site.cacheEnabled, true);
  assert.deepEqual(f.site.apiScopes, []);
  for (const request of [
    {},
    { url: 'https://backend.example.test/v2/search', method: 'POST', body: '{"page":1}' },
    { url: 'http://localhost:9999/data/list' },
  ]) {
    const first = await f.prepare(request);
    assert.equal(first.action, 'network'); assert.equal(first.ticket?.cacheAllowed, true); assert.equal(first.canReplay, true);
    assert.equal((await f.complete(first, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })).saved, true);
    assert.equal((await f.prepare(request)).action, 'hit');
  }
  const panel = await f.call('PANEL', { pageUrl: sender.url }) as PanelState;
  assert.equal(panel.page.cacheEnabled, true); assert.equal(panel.bindings.length, 3);
  assert.ok(panel.bindings.every(rule => rule.enabled && rule.allowNoStore));
  assert.equal(panel.bindings.find(rule => rule.method === 'POST')?.readOnly, true);
  assert.equal((await f.prepare({ url: 'https://backend.example.test/assets/app.js' })).action, 'ignore');
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const pending = await f.prepare({ method });
    assert.equal(pending.ticket?.cacheAllowed, false); assert.equal(pending.canReplay, false);
    assert.equal((await f.complete(pending)).saved, false);
  }
});

test('custom scope filters retain exact origin and path constraints and require a scope', async () => {
  const f = await defaultFixture();
  await assert.rejects(f.call('SITE_SAVE', { site: { ...f.site, apiScopeMode: 'custom' } }, options), /API 范围/);
  await f.call('SITE_SAVE', { site: { ...f.site, apiScopeMode: 'custom', apiScopes: [{ origin: 'https://backend.example.test', pathPrefix: '/v2/' }] } }, options);
  assert.equal((await f.prepare()).action, 'ignore');
  assert.equal((await f.prepare({ url: 'https://backend.example.test:444/v2/list' })).action, 'ignore');
  assert.equal((await f.prepare({ url: 'https://backend.example.test/v1/list' })).action, 'ignore');
  const pending = await f.prepare({ url: 'https://backend.example.test/v2/list' });
  assert.equal(pending.ticket?.cacheAllowed, true); assert.equal((await f.complete(pending)).saved, true);
});

test('automatic cookie identity survives same-tab reloads and isolates tabs and browser sessions', async () => {
  const f = await defaultFixture();
  const original = await f.prepare(); assert.equal((await f.complete(original)).saved, true);
  assert.match(original.ticket!.identityScope, /^tab-session:/);
  const changedDocument = { ...sender, documentId: 'after-reload' };
  assert.equal((await f.prepare({}, changedDocument)).action, 'hit');
  const changedTab = { ...sender, tab: { ...sender.tab, id: 8 } };
  const otherTab = await f.prepare({}, changedTab);
  assert.equal(otherTab.action, 'network'); assert.notEqual(otherTab.ticket?.identityScope, original.ticket?.identityScope);
  assert.equal((await f.complete(otherTab, {}, changedTab)).saved, true);
  assert.equal((await f.prepare({}, changedTab)).action, 'hit');
  assert.equal((await f.prepare()).action, 'hit');
  f.rotateBrowserSession('new-browser-session');
  const nextBrowserSession = await f.prepare({}, { ...sender, documentId: 'next-browser-document' });
  assert.equal(nextBrowserSession.action, 'network'); assert.notEqual(nextBrowserSession.ticket?.identityScope, original.ticket?.identityScope);
  assert.equal(nextBrowserSession.ticket?.cacheAllowed, true);
});

test('automatic cookie digest changes partition cache and missing browser identity fails closed', async () => {
  const f = await defaultFixture();
  const alice = { cookieIdentityHash: await digest('session=alice') }, bob = { cookieIdentityHash: await digest('session=bob') };
  const first = await f.prepare(alice); assert.equal((await f.complete(first)).saved, true);
  assert.equal((await f.prepare(alice, { ...sender, documentId: 'reloaded-alice' })).action, 'hit');
  const switched = await f.prepare(bob);
  assert.equal(switched.action, 'network'); assert.equal(switched.invalidateRuntime, true); assert.notEqual(switched.ticket?.identityScope, first.ticket?.identityScope);
  assert.equal((await f.complete(switched)).saved, true); assert.equal((await f.prepare(bob)).action, 'hit');
  assert.ok(!JSON.stringify(f.repository.state).includes('session=alice'));
  await assert.rejects(f.prepare({ cookieIdentityHash: 'raw-secret' }), /Cookie 身份摘要无效/);
  const noSession = await defaultFixture(false);
  const unavailable = await noSession.prepare();
  assert.equal(unavailable.ticket?.cacheAllowed, false); assert.match(unavailable.reason!, /无法识别当前浏览器会话/);
  assert.equal((await noSession.complete(unavailable)).saved, false);
  assert.equal((await noSession.prepare()).action, 'network');
  f.rotateBrowserSession('');
  assert.equal((await f.prepare()).ticket?.cacheAllowed, false);
  await assert.rejects(f.prepare({}, { ...sender, tab: undefined }), /顶层页面/);
});

test('automatic identity uses Authorization first and refreshes cache on identity changes', async () => {
  const f = await defaultFixture();
  const alice = { identityHash: await digest('Bearer alice') };
  const first = await f.prepare(alice); assert.match(first.ticket!.identityScope, /^authorization:/);
  await f.complete(first); assert.equal((await f.prepare(alice)).action, 'hit');
  assert.equal((await f.prepare(alice, { ...sender, documentId: 'next-document' })).action, 'hit');
  assert.equal((await f.prepare(alice, { ...sender, documentId: undefined })).action, 'hit');
  const cookie = await f.prepare(); assert.match(cookie.ticket!.identityScope, /^tab-session:/);
  assert.equal(cookie.action, 'network'); assert.equal(cookie.invalidateRuntime, false); await f.complete(cookie);
  const bob = await f.prepare({ identityHash: await digest('Bearer bob') });
  assert.equal(bob.action, 'network'); assert.equal(bob.invalidateRuntime, true);
  assert.ok(!JSON.stringify(f.repository.state).includes('Bearer alice'));
});

test('schema one migrates once with atomic body reset, preserving exclusions and user choices after migration', async () => {
  const f = await fixture({ identityMode: 'session', sessionPartition: 'legacy-account', defaultTTL: 42_000 });
  const cached = await f.prepare(); await f.complete(cached);
  const pending = await f.prepare({ source: 'manual' });
  const post = await f.bind('/api/query', 'POST');
  const legacy = f.repository.state;
  legacy.schemaVersion = 1; legacy.paused = true;
  legacy.sites[f.site.id].cacheEnabled = false;
  const oldPage = Object.values(legacy.pages)[0]; oldPage.cacheEnabled = false;
  legacy.rules[f.rule.id].alwaysBypass = true;
  for (const rule of Object.values(legacy.rules)) { rule.enabled = false; rule.allowNoStore = false; }
  legacy.rules[post.id].readOnly = false;
  const oldSiteGeneration = legacy.sites[f.site.id].generation;
  const oldPageGeneration = oldPage.generation, oldRuleGeneration = legacy.rules[f.rule.id].generation;
  f.repository.entries.set('orphaned-body', structuredClone(f.repository.entries.get(cached.ticket!.cacheKey)!));
  await assert.rejects(f.repository.run(async session => {
    assert.equal(session.state.schemaVersion, 2); assert.equal(await session.get(cached.ticket!.cacheKey), undefined);
    throw new Error('模拟升级提交失败');
  }));
  assert.equal(f.repository.state.schemaVersion, 1); assert.ok(f.repository.entries.has('orphaned-body'));
  const migrated = await f.call('OPTIONS_GET', {}, options) as { sites: SiteConfig[]; paused: boolean };
  const site = migrated.sites[0], state = f.repository.state;
  assert.equal(state.schemaVersion, 2); assert.equal(migrated.paused, true);
  assert.equal(site.cacheEnabled, true); assert.equal(site.apiScopeMode, 'all'); assert.equal(site.identityMode, 'auto');
  assert.equal(site.sessionPartition, 'legacy-account'); assert.equal(site.defaultTTL, 42_000); assert.deepEqual(site.apiScopes, f.site.apiScopes);
  assert.equal(site.generation, oldSiteGeneration + 1); assert.equal(state.pages[oldPage.id].generation, oldPageGeneration + 1);
  assert.equal(state.rules[f.rule.id].generation, oldRuleGeneration + 1);
  assert.equal(state.pages[oldPage.id].cacheEnabled, true); assert.equal(state.rules[post.id].readOnly, true);
  assert.ok(Object.values(state.rules).every(rule => rule.enabled && rule.allowNoStore));
  assert.equal(state.rules[f.rule.id].alwaysBypass, true);
  assert.deepEqual(state.tickets, {}); assert.deepEqual(state.index, {}); assert.deepEqual(state.identities, {}); assert.deepEqual(state.successfulSequences, {});
  assert.equal(f.repository.entries.size, 0);
  assert.ok(Object.values(state.variants).every(variant => variant.cachedAt === undefined && variant.sizeBytes === undefined));
  assert.equal((await f.complete(pending)).saved, false);
  await f.call('SITE_SAVE', { site: { ...site, cacheEnabled: false, apiScopeMode: 'custom', identityMode: 'public' } }, options);
  await f.call('PAGE_PATCH', { pageUrl: f.pageUrl, patch: { cacheEnabled: false } });
  await f.call('RULE_PATCH', { pageUrl: f.pageUrl, bindingId: post.id, patch: { enabled: false, readOnly: false, allowNoStore: false } });
  const snapshot = structuredClone(f.repository.state);
  const restarted = new CacheCore(f.repository, { extensionId: 'test-extension', hasPermission: async () => true });
  await restarted.handleMessage({ type: 'OPTIONS_GET' }, options);
  assert.deepEqual(f.repository.state, snapshot);
});


test('scope discovery requires successful JSON and groups exact API origins, path segments and methods', async () => {
  const f = await fixture({ apiScopeMode: 'all' });
  const discoveries = () => f.call('API_SCOPES_GET', { pageUrl: f.pageUrl }) as Promise<ApiScopeDiscoveryState>;
  const url = 'https://backend.example.test:8443/v1/users?secret=DO-NOT-STORE#ignored';
  const first = await f.prepare({ url });
  assert.deepEqual((await discoveries()).scopes, []);
  const generation = f.repository.state.sites[f.site.id].generation;
  assert.equal((await f.complete(first)).saved, true);
  const one = (await discoveries()).scopes[0];
  assert.equal(one.origin, 'https://backend.example.test:8443'); assert.equal(one.pathPrefix, '/v1');
  assert.deepEqual(one.examples, ['/v1/users']); assert.deepEqual(one.methods, ['GET']); assert.equal(one.endpointCount, 1);
  f.advance(100);
  assert.equal((await f.prepare({ url })).action, 'hit');
  assert.equal((await discoveries()).scopes[0].lastSeenAt, one.lastSeenAt + 100);
  assert.equal(f.repository.state.sites[f.site.id].generation, generation);
  await f.complete(await f.prepare({ url: 'https://backend.example.test:8443/v1/users?page=2' }));
  await f.complete(await f.prepare({ url, method: 'POST', body: '{"page":1}' }));
  for (const path of ['orders', 'teams', 'settings']) await f.complete(await f.prepare({ url: `https://backend.example.test:8443/v1/${path}` }));
  const grouped = (await discoveries()).scopes[0];
  assert.deepEqual(grouped.methods, ['GET', 'POST']); assert.equal(grouped.endpointCount, 5); assert.equal(grouped.examples.length, 3);
  assert.ok(!JSON.stringify(await discoveries()).includes('DO-NOT-STORE'));
  assert.ok(!JSON.stringify(await discoveries()).includes('endpointHashes'));
  await f.complete(await f.prepare({ url: 'https://backend.example.test:9443/v1/users' }));
  await f.complete(await f.prepare({ url: 'https://backend.example.test:8443/' }));
  const state = await discoveries();
  assert.equal(state.mode, 'all'); assert.equal(state.siteId, f.site.id); assert.equal(state.scopes.length, 3);
  assert.ok(state.scopes.some(item => item.origin === 'https://backend.example.test:9443'));
  assert.ok(state.scopes.some(item => item.pathPrefix === '/'));
  assert.deepEqual((await f.panel()).scopeDiscovery, state);
  assert.equal((await f.prepare({ url })).action, 'hit');
});

test('scope discovery excludes pending, manual, unsupported, auth and unsuccessful responses', async () => {
  const f = await defaultFixture();
  const discoveries = () => f.call('API_SCOPES_GET', { siteId: f.site.id }, options) as Promise<ApiScopeDiscoveryState>;
  await f.call('BIND_ADD', { pageUrl: sender.url, method: 'GET', url: 'http://localhost:5173/never/requested' });
  await f.prepare({ url: 'http://localhost:5173/pending/request' });
  await f.complete(await f.prepare({ url: 'http://localhost:5173/manual/request', source: 'manual' }));
  await f.complete(await f.prepare({ url: 'http://localhost:5173/authentication/login' }));
  await f.complete(await f.prepare({ url: 'http://localhost:5173/sensitive/request', unsupportedReason: '请求含敏感参数' }));
  await f.complete(await f.prepare({ url: 'http://localhost:5173/invalid-body/request', method: 'POST', body: 'plain text' }));
  for (const [index, patch] of [
    { status: 500 }, { status: 204 }, { status: 206 }, { redirected: true }, { responseType: 'opaque' },
    { headers: { 'content-type': 'text/html' }, bodyText: '<html>app</html>' },
    { bodyText: 'invalid json' }, { unsupportedReason: '流响应' }, { error: '网络错误' },
  ].entries()) await f.complete(await f.prepare({ url: `http://localhost:5173/rejected-${index}/request` }), patch);
  assert.equal((await f.prepare({ url: 'http://localhost:5173/static/app.js' })).action, 'ignore');
  for (const method of ['PUT', 'PATCH', 'DELETE']) await f.complete(await f.prepare({ url: 'http://localhost:5173/write/request', method }));
  assert.deepEqual((await discoveries()).scopes, []);
  await f.call('SITE_PATCH', { patch: { cacheEnabled: false } });
  await f.complete(await f.prepare({ url: 'http://localhost:5173/preview/request' }));
  assert.deepEqual((await discoveries()).scopes.map(item => item.pathPrefix), ['/preview']);
});

test('scope discovery API isolates website access and custom scopes never expand automatically', async () => {
  const f = await fixture();
  const siteBefore = structuredClone(f.repository.state.sites[f.site.id]);
  assert.equal((await f.prepare({ url: 'https://outside.example.test/api/data' })).action, 'ignore');
  assert.equal((await f.prepare({ url: 'http://localhost:5173/outside/data' })).action, 'ignore');
  await f.complete(await f.prepare());
  const discovery = await f.call('API_SCOPES_GET', { siteId: f.site.id }, options) as ApiScopeDiscoveryState;
  assert.equal(discovery.mode, 'custom'); assert.deepEqual(discovery.scopes.map(item => item.pathPrefix), ['/api']);
  assert.deepEqual(f.repository.state.sites[f.site.id], siteBefore);
  const second = await f.call('SITE_SAVE', { site: { origin: 'http://localhost:6000' } }, options) as SiteConfig;
  const otherSender = { ...sender, url: 'http://localhost:6000/users', origin: 'http://localhost:6000', tab: { id: 9, url: 'http://localhost:6000/users' } };
  assert.deepEqual((await f.call('API_SCOPES_GET', { pageUrl: otherSender.url }, otherSender) as ApiScopeDiscoveryState).scopes, []);
  await assert.rejects(f.call('API_SCOPES_GET', { pageUrl: f.pageUrl, siteId: second.id }), /不属于当前网站/);
  await assert.rejects(f.call('API_SCOPES_GET', { pageUrl: otherSender.url }), /来源不匹配/);
  await assert.rejects(f.call('API_SCOPES_GET', { siteId: f.site.id }, { ...options, id: 'foreign-extension' }));
  await assert.rejects(f.call('API_SCOPES_GET', { pageUrl: f.pageUrl }, { ...sender, frameId: 1 }), /顶层页面/);
  const before = structuredClone(f.repository.state);
  await f.call('API_SCOPES_GET', { siteId: f.site.id }, options);
  assert.deepEqual(f.repository.state, before);
  f.revoke(); await assert.rejects(f.call('API_SCOPES_GET', { pageUrl: f.pageUrl }), /网站未配置或访问权限已撤销/);
});

test('scope metadata persists and upgrades schema two without clearing caches; hits backfill it', async () => {
  const f = await fixture({ apiScopeMode: 'all' });
  await f.complete(await f.prepare());
  const before = await f.call('API_SCOPES_GET', { siteId: f.site.id }, options);
  const restarted = new CacheCore(f.repository, { extensionId: 'test-extension', hasPermission: async () => true });
  assert.deepEqual(await restarted.handleMessage({ type: 'API_SCOPES_GET', payload: { siteId: f.site.id } }, options), before);
  delete (f.repository.state as Partial<typeof f.repository.state>).scopeDiscoveries;
  const originalIndex = structuredClone(f.repository.state.index), originalSite = structuredClone(f.repository.state.sites[f.site.id]);
  assert.deepEqual((await f.call('API_SCOPES_GET', { siteId: f.site.id }, options) as ApiScopeDiscoveryState).scopes, []);
  assert.deepEqual(f.repository.state.index, originalIndex); assert.deepEqual(f.repository.state.sites[f.site.id], originalSite);
  assert.equal((await f.prepare()).action, 'hit');
  assert.equal((await f.call('API_SCOPES_GET', { siteId: f.site.id }, options) as ApiScopeDiscoveryState).scopes.length, 1);
  await f.call('SITE_SAVE', { site: { ...f.site, defaultTTL: 99_000 } }, options);
  assert.equal((await f.call('API_SCOPES_GET', { siteId: f.site.id }, options) as ApiScopeDiscoveryState).scopes.length, 1);
  await f.call('SITE_SAVE', { site: { ...f.site, apiScopeMode: 'custom', apiScopes: [{ origin: f.site.origin, pathPrefix: '/elsewhere' }] } }, options);
  assert.deepEqual((await f.call('API_SCOPES_GET', { siteId: f.site.id }, options) as ApiScopeDiscoveryState).scopes, []);
  await f.complete(await f.prepare({ url: 'http://localhost:5173/elsewhere/data' }));
  await f.call('SITE_SAVE', { site: { ...f.site, origin: 'http://localhost:6001' } }, options);
  assert.deepEqual((await f.call('API_SCOPES_GET', { siteId: f.site.id }, options) as ApiScopeDiscoveryState).scopes, []);
  await f.call('SITE_DELETE', { siteId: f.site.id }, options);
  assert.deepEqual(f.repository.state.scopeDiscoveries, {});
});

test('scope discovery preserves double-slash paths without changing API origin', async () => {
  const f = await defaultFixture();
  const pending = await f.prepare({ url: 'http://localhost:5173//outside.example.test/data?ignored=1' });
  await f.complete(pending);
  const result = await f.call('API_SCOPES_GET', { siteId: f.site.id }, options) as ApiScopeDiscoveryState;
  assert.equal(result.scopes[0].origin, 'http://localhost:5173');
  assert.equal(result.scopes[0].pathPrefix, '//outside.example.test');
  assert.deepEqual(result.scopes[0].examples, ['//outside.example.test/data']);
});

test('scope discovery metadata is bounded per group, website and extension', async () => {
  const f = await fixture({ apiScopeMode: 'all' });
  await f.repository.run(async session => {
    for (let index = 0; index < 210; index++) await recordScopeDiscovery(session.state, f.site, { ...f.rule, pathname: `/large/endpoint-${index}`, method: index < 20 ? `METHOD${index}` : 'GET' }, index);
    const group = Object.values(session.state.scopeDiscoveries)[0];
    assert.equal(group.endpointHashes.length, 200); assert.equal(group.view.endpointCount, 200); assert.equal(group.view.endpointCountCapped, true);
    assert.equal(group.view.examples.length, 3); assert.equal(group.view.methods.length, 16);
    for (let index = 0; index < 60; index++) await recordScopeDiscovery(session.state, f.site, { ...f.rule, pathname: `/group-${index}/list` }, 1000 + index);
    assert.equal(Object.values(session.state.scopeDiscoveries).filter(item => item.view.siteId === f.site.id).length, 50);
    assert.ok(Object.values(session.state.scopeDiscoveries).every(item => item.view.pathPrefix !== '/large'));
    assert.ok(Object.values(session.state.scopeDiscoveries).some(item => item.view.pathPrefix === '/group-59'));
    for (let siteIndex = 0; siteIndex < 10; siteIndex++) for (let index = 0; index < 50; index++) {
      await recordScopeDiscovery(session.state, { ...f.site, id: `capacity-${siteIndex}` }, { ...f.rule, pathname: `/scope-${index}/list` }, 2000 + siteIndex * 50 + index);
    }
    assert.equal(Object.keys(session.state.scopeDiscoveries).length, 500);
    assert.equal(Object.values(session.state.scopeDiscoveries).filter(item => item.view.siteId === f.site.id).length, 0);
    for (let siteIndex = 0; siteIndex < 10; siteIndex++) assert.equal(Object.values(session.state.scopeDiscoveries).filter(item => item.view.siteId === `capacity-${siteIndex}`).length, 50);
  });
});


test('default auth keywords match only the final path segment and explicit path prefixes retain their behavior', () => {
  const patterns = ['login', 'logout', 'token', 'refresh'];
  for (const path of ['/api/login', '/api/login/', '/auth/LOGOUT', '/auth/token//', '/api/refresh']) assert.equal(isAuthPath(path, patterns), true, path);
  for (const path of ['/api/login/userInfo', '/api/logout/history', '/api/token/summary', '/api/refresh/status', '/api/loginDetails', '/']) assert.equal(isAuthPath(path, patterns), false, path);
  assert.equal(isAuthPath('/api/login/userInfo', ['/api/login']), true);
  assert.equal(isAuthPath('/api/loginDetails', ['/api/login']), false);
  assert.equal(isAuthPath('/api/login/userInfo', ['/api/login/']), true);
});

test('login userInfo reads cache normally while real login and logout invalidate cached data', async () => {
  const f = await fixture({ apiScopeMode: 'all', identityMode: 'auto' });
  const request = { url: 'http://localhost:5173/api/login/userInfo' };
  for (const method of ['GET', 'POST']) {
    const first = await f.prepare({ ...request, method });
    assert.equal(first.canReplay, true); assert.equal(first.ticket?.cacheAllowed, true);
    assert.equal((await f.complete(first)).saved, true);
    assert.equal((await f.prepare({ ...request, method })).action, 'hit');
  }
  await f.complete(await f.prepare());
  const generation = f.repository.state.sites[f.site.id].generation;
  assert.equal((await f.prepare(request)).action, 'hit');
  assert.equal(f.repository.state.sites[f.site.id].generation, generation);
  for (const path of ['/api/login/', '/api/logout']) {
    const auth = await f.prepare({ url: `http://localhost:5173${path}`, method: 'POST' });
    assert.equal(auth.canReplay, false); assert.equal(auth.ticket?.cacheAllowed, false); assert.equal(auth.invalidateRuntime, true);
    assert.equal((await f.complete(auth)).saved, false);
    const after = await f.prepare(request); assert.equal(after.action, 'network'); await f.complete(after);
  }
  const infoRule = (await f.panel()).bindings.find(rule => rule.pathname === '/api/login/userInfo' && rule.method === 'GET')!;
  await f.call('RULE_PATCH', { pageUrl: f.pageUrl, bindingId: infoRule.id, patch: { enabled: false } });
  const disabled = await f.prepare(request);
  assert.equal(disabled.ticket?.cacheAllowed, false); assert.equal(f.repository.state.rules[infoRule.id].enabled, false);
  await f.call('SITE_SAVE', { site: { ...f.site, authPaths: ['/api/login'] } }, options);
  assert.equal((await f.prepare(request)).canReplay, false);
});


test('mixed automatic credential delivery and credential headers retain independent cached responses', async () => {
  const f = await defaultFixture();
  const include = { credentials: 'include' as const, cookieIdentityHash: await digest('[]') };
  const omit = { credentials: 'omit' as const };
  const auth = { ...include, identityHash: await digest('Bearer alice') };
  const generation = f.repository.state.sites[f.site.id].generation;
  for (const [request, bodyText] of [[include, '{"kind":"cookie"}'], [omit, '{"kind":"omit"}'], [auth, '{"kind":"credential"}']] as const) {
    const first = await f.prepare(request);
    assert.equal(first.action, 'network'); assert.equal(first.invalidateRuntime, false);
    assert.equal((await f.complete(first, { bodyText })).saved, true);
  }
  for (const [request, bodyText] of [[include, '{"kind":"cookie"}'], [omit, '{"kind":"omit"}'], [auth, '{"kind":"credential"}'], [include, '{"kind":"cookie"}'], [auth, '{"kind":"credential"}']] as const) {
    const hit = await f.prepare(request);
    assert.equal(hit.action, 'hit'); assert.equal(hit.entry?.bodyText, bodyText); assert.equal(hit.invalidateRuntime, false);
  }
  assert.equal(f.repository.state.sites[f.site.id].generation, generation);
  assert.equal(Object.keys(f.repository.state.identities).length, 3);
  const changedCredential = await f.prepare({ ...auth, identityHash: await digest('Bearer bob') });
  assert.equal(changedCredential.action, 'network'); assert.equal(changedCredential.invalidateRuntime, true);
  assert.equal(Object.keys(f.repository.state.identities).length, 1);
  await f.complete(changedCredential, { bodyText: '{"kind":"bob"}' });
  const afterCookie = await f.prepare(include);
  assert.equal(afterCookie.action, 'network'); assert.equal(afterCookie.invalidateRuntime, false);
  await f.complete(afterCookie);
  assert.equal((await f.prepare({ ...auth, identityHash: await digest('Bearer bob') })).entry?.bodyText, '{"kind":"bob"}');
});

test('vary field sets form separate identity channels while real tenant changes still invalidate', async () => {
  const f = await fixture();
  const narrow = await f.bind('/api/narrow');
  const reordered = await f.bind('/api/reordered');
  await f.call('RULE_PATCH', { pageUrl: f.pageUrl, bindingId: narrow.id, patch: { varyHeaders: ['x-tenant-id'] } });
  await f.call('RULE_PATCH', { pageUrl: f.pageUrl, bindingId: reordered.id, patch: { varyHeaders: ['X-TENANT-ID', 'accept-language'] } });
  const headers = { authorization: 'Bearer stable-account', 'x-tenant-id': 'one', 'accept-language': 'zh' };
  const urls = ['http://localhost:5173/api/users', 'http://localhost:5173/api/narrow', 'http://localhost:5173/api/reordered'];
  const generation = f.repository.state.sites[f.site.id].generation;
  for (const url of urls) {
    const first = await f.prepare({ url, headers });
    assert.equal(first.invalidateRuntime, false); await f.complete(first);
  }
  for (const url of urls) assert.equal((await f.prepare({ url, headers })).action, 'hit');
  assert.equal(f.repository.state.sites[f.site.id].generation, generation);
  assert.equal(Object.keys(f.repository.state.identities).length, 2);
  const changedHeaders = { ...headers, 'x-tenant-id': 'two' };
  const changed = await f.prepare({ headers: changedHeaders });
  assert.equal(changed.invalidateRuntime, true); assert.equal(changed.action, 'network');
  assert.equal(Object.keys(f.repository.state.identities).length, 1);
  await f.complete(changed);
  const narrowAfter = await f.prepare({ url: urls[1], headers: changedHeaders });
  assert.equal(narrowAfter.invalidateRuntime, false); assert.equal(narrowAfter.action, 'network'); await f.complete(narrowAfter);
  assert.equal((await f.prepare({ headers: changedHeaders })).action, 'hit');
});

test('preview only exposes identity channels observed in the current document and auth failures clear all channels', async () => {
  const f = await defaultFixture();
  const auth = { url: 'http://localhost:5173/api/private', identityHash: await digest('Bearer alice') };
  const cookie = { url: 'http://localhost:5173/api/public', cookieIdentityHash: await digest('[]') };
  const authPrepared = await f.prepare(auth); await f.complete(authPrepared, { bodyText: '{"private":true}' });
  const cookiePrepared = await f.prepare(cookie); await f.complete(cookiePrepared, { bodyText: '{"public":true}' });
  const nextDocument = { ...sender, documentId: 'next-document' };
  const preview = (prepared: PrepareResult, from = sender) => f.call('PREVIEW', { pageUrl: sender.url, bindingId: prepared.bindingId, variantId: prepared.variantId }, from) as Promise<{ bodyText: string }>;
  assert.equal((await preview(authPrepared)).bodyText, '{"private":true}');
  assert.equal((await preview(cookiePrepared)).bodyText, '{"public":true}');
  assert.match((await preview(authPrepared, nextDocument)).bodyText, /当前身份/);
  assert.equal((await f.prepare(cookie, nextDocument)).action, 'hit');
  assert.equal((await preview(cookiePrepared, nextDocument)).bodyText, '{"public":true}');
  assert.match((await preview(authPrepared, nextDocument)).bodyText, /当前身份/);
  assert.equal((await f.prepare(auth, nextDocument)).action, 'hit');
  assert.equal((await preview(authPrepared, nextDocument)).bodyText, '{"private":true}');
  assert.match((await preview(authPrepared, { ...sender, documentId: undefined })).bodyText, /当前身份/);
  await f.complete(await f.prepare({ ...auth, source: 'manual' }), { status: 401 });
  assert.deepEqual(f.repository.state.identities, {});
  assert.match((await preview(authPrepared)).bodyText, /当前身份/);
  const resumed = await f.prepare(cookie); assert.equal(resumed.action, 'network'); assert.equal(resumed.invalidateRuntime, false);
  await f.complete(resumed);
  const login = await f.prepare({ url: 'http://localhost:5173/api/login', method: 'POST' });
  await f.complete(login);
  assert.deepEqual(f.repository.state.identities, {});
});


test('preview identity prefixes keep API origins with different ports strictly separate', async () => {
  const f = await defaultFixture();
  const identityHash = await digest('Bearer common-account');
  const first = await f.prepare({ url: 'https://backend.example.test/private/data', identityHash });
  await f.complete(first, { bodyText: '{"origin":"default-port"}' });
  const nextDocument = { ...sender, documentId: 'new-port-document' };
  const otherPort = await f.prepare({ url: 'https://backend.example.test:8443/public/data', identityHash }, nextDocument);
  await f.complete(otherPort, { bodyText: '{"origin":"other-port"}' }, nextDocument);
  const preview = await f.call('PREVIEW', { pageUrl: sender.url, bindingId: first.bindingId, variantId: first.variantId }, nextDocument) as { bodyText: string };
  assert.match(preview.bodyText, /当前身份/);
});


test('forced POST cache groups dynamic query and JSON arrays while keeping latest originals and manual refresh', async () => {
  const f = await fixture();
  const post = await f.bind('/api/menuTrack/report', 'POST');
  assert.equal(post.forceCache, false);
  const patch = (value: Record<string, unknown>) => f.call('RULE_PATCH', { pageUrl: f.pageUrl, bindingId: post.id, patch: value });
  await patch({ ignoreQueryKeys: ['timestamp'], ignoreBodyPointers: ['/events/0/at'] });
  const before = structuredClone(f.repository.state.rules[post.id]);
  await patch({ forceCache: true, enabled: true });
  const forced = f.repository.state.rules[post.id];
  assert.equal(forced.ruleVersion, before.ruleVersion + 1); assert.equal(forced.generation, before.generation + 1);
  const initial = { url: 'http://localhost:5173/api/menuTrack/report?page=1&timestamp=100', method: 'POST', body: '{"events":[{"menuKey":"one","at":100}]}' };
  const first = await f.prepare(initial); assert.equal((await f.complete(first)).saved, true);
  const cachedAt = (await f.panel()).bindings.find(rule => rule.id === post.id)!.variants[0].cachedAt;
  f.advance(200);
  const dynamic = { ...initial, url: 'http://localhost:5173/api/menuTrack/report?page=9&timestamp=900', body: '{"events":[{"menuKey":"other","at":900},{"menuKey":"second"}]}' };
  const hit = await f.prepare(dynamic); assert.equal(hit.action, 'hit'); assert.equal(hit.variantId, first.variantId);
  const variant = (await f.panel()).bindings.find(rule => rule.id === post.id)!.variants[0];
  assert.equal(variant.url, dynamic.url); assert.equal(variant.body, dynamic.body); assert.equal(variant.cachedAt, cachedAt);
  for (const body of ['{"events":[]}', '{}', 'null', undefined]) assert.equal((await f.prepare({ ...dynamic, body })).action, 'hit');
  const manual = await f.prepare({ ...dynamic, source: 'manual' }); assert.equal(manual.action, 'network');
  assert.equal((await f.complete(manual, { bodyText: '{"fresh":true}' })).saved, true);
  assert.equal((await f.prepare(initial)).entry?.bodyText, '{"fresh":true}');
  await patch({ forceCache: false });
  assert.deepEqual(f.repository.state.rules[post.id].ignoreQueryKeys, ['timestamp']);
  assert.deepEqual(f.repository.state.rules[post.id].ignoreBodyPointers, ['/events/0/at']);
  const normal = await f.prepare(initial); assert.equal(normal.action, 'network'); await f.complete(normal);
  assert.equal((await f.prepare({ ...initial, url: initial.url.replace('timestamp=100', 'timestamp=999'), body: '{"events":[{"menuKey":"one","at":999}]}' })).action, 'hit');
  assert.equal((await f.prepare(dynamic)).action, 'network');
});

test('forced grouping retains page, endpoint, identity, credential mode and vary header isolation', async () => {
  const f = await fixture();
  const force = (pageUrl: string, bindingId: string) => f.call('RULE_PATCH', { pageUrl, bindingId, patch: { forceCache: true } });
  await force(f.pageUrl, f.rule.id);
  await f.complete(await f.prepare({ url: 'http://localhost:5173/api/users?first=1' }));
  assert.equal((await f.prepare({ url: 'http://localhost:5173/api/users?changed=2' })).action, 'hit');
  const otherPage = 'http://localhost:5173/other-page';
  const otherBinding = await f.call('BIND_ADD', { pageUrl: otherPage, method: 'GET', url: 'http://localhost:5173/api/users' }) as Rule;
  await force(otherPage, otherBinding.id);
  assert.equal((await f.prepare({ pageUrl: otherPage })).action, 'network');
  const endpoint = await f.bind('/api/other'); await force(f.pageUrl, endpoint.id);
  assert.equal((await f.prepare({ url: 'http://localhost:5173/api/other' })).action, 'network');
  const post = await f.bind('/api/users', 'POST'); await force(f.pageUrl, post.id);
  assert.equal((await f.prepare({ method: 'POST', body: '{}' })).action, 'network');
  assert.equal((await f.prepare({ credentials: 'omit' })).action, 'network');
  const alice = { identityHash: await digest('Bearer alice'), headers: { 'x-tenant-id': 'one' } };
  await f.complete(await f.prepare(alice)); assert.equal((await f.prepare(alice)).action, 'hit');
  assert.equal((await f.prepare({ ...alice, headers: { 'x-tenant-id': 'two' } })).action, 'network');
  assert.equal((await f.prepare({ ...alice, identityHash: await digest('Bearer bob') })).action, 'network');
});

test('forced cache obeys TTL and site/page/interface/capture/pause switches', async () => {
  const f = await fixture({ defaultTTL: 1000 });
  await f.call('RULE_PATCH', { pageUrl: f.pageUrl, bindingId: f.rule.id, patch: { forceCache: true } });
  await f.complete(await f.prepare()); f.advance(1001);
  const expired = await f.prepare({ url: 'http://localhost:5173/api/users?different=1' });
  assert.equal(expired.action, 'network'); await f.complete(expired);
  for (const [type, payload, key] of [
    ['SITE_PATCH', {}, 'cacheEnabled'],
    ['PAGE_PATCH', { pageUrl: f.pageUrl }, 'cacheEnabled'],
    ['RULE_PATCH', { pageUrl: f.pageUrl, bindingId: f.rule.id }, 'enabled'],
  ] as const) {
    await f.call(type, { ...payload, patch: { [key]: false } });
    const disabled = await f.prepare(); assert.equal(disabled.action, 'network'); assert.equal(disabled.ticket?.cacheAllowed, false);
    assert.equal((await f.complete(disabled)).saved, false);
    await f.call(type, { ...payload, patch: { [key]: true } });
    assert.equal((await f.prepare()).action, 'hit');
  }
  await f.call('SITE_PATCH', { patch: { captureEnabled: false } }); assert.equal((await f.prepare()).action, 'ignore');
  await f.call('SITE_PATCH', { patch: { captureEnabled: true } });
  await f.call('PAUSE', { paused: true }, options); assert.equal((await f.prepare()).action, 'ignore');
  await f.call('PAUSE', { paused: false }, options);
  await f.call('RULE_PATCH', { pageUrl: f.pageUrl, bindingId: f.rule.id, patch: { alwaysBypass: true } });
  assert.equal((await f.prepare()).ticket?.cacheAllowed, false);
});

test('force toggles discard in-flight writes and reject unsupported interface kinds', async () => {
  const f = await fixture();
  const pending = await f.prepare();
  await f.call('RULE_PATCH', { pageUrl: f.pageUrl, bindingId: f.rule.id, patch: { forceCache: true } });
  assert.equal((await f.complete(pending)).saved, false);
  const forcedPending = await f.prepare();
  await f.call('RULE_PATCH', { pageUrl: f.pageUrl, bindingId: f.rule.id, patch: { forceCache: false } });
  assert.equal((await f.complete(forcedPending)).saved, false);
  for (const [path, method, additional] of [
    ['/api/login', 'POST', {}], ['/api/write', 'PUT', {}], ['/api/not-readonly', 'POST', { readOnly: false }], ['/api/bypassed', 'GET', { alwaysBypass: true }],
  ] as const) {
    const binding = await f.bind(path, method);
    await f.call('RULE_PATCH', { pageUrl: f.pageUrl, bindingId: binding.id, patch: additional });
    await assert.rejects(f.call('RULE_PATCH', { pageUrl: f.pageUrl, bindingId: binding.id, patch: { forceCache: true } }), /仅普通 GET/);
    assert.equal(f.repository.state.rules[binding.id].forceCache, false);
  }
});

test('force never replays over malformed or unsupported requests and retains response validity checks', async () => {
  const f = await fixture(); const post = await f.bind('/api/force-body', 'POST');
  await f.call('RULE_PATCH', { pageUrl: f.pageUrl, bindingId: post.id, patch: { forceCache: true, allowNoStore: false, successCondition: { pointer: '/code', value: 0 } } });
  const request = { url: 'http://localhost:5173/api/force-body', method: 'POST', body: '{"events":[1]}' };
  await f.complete(await f.prepare(request), { bodyText: '{"code":0,"saved":true}' });
  const malformed = await f.prepare({ ...request, body: 'not JSON' });
  assert.equal(malformed.action, 'network'); assert.equal(malformed.ticket?.cacheAllowed, false); assert.equal(malformed.canReplay, false);
  assert.equal((await f.complete(malformed, { bodyText: '{"code":0}' })).saved, false);
  const unsafe = await f.prepare({ ...request, headers: { 'x-csrf-token': 'single-use' } });
  assert.equal(unsafe.action, 'network'); assert.equal(unsafe.ticket?.cacheAllowed, false);
  const unsupported = await f.prepare({ ...request, unsupportedReason: '上传请求' });
  assert.equal(unsupported.action, 'network'); assert.equal(unsupported.ticket?.cacheAllowed, false);
  const failedCompletions: Partial<Completion>[] = [
    { status: 500 }, { bodyText: '{"code":1}' }, { bodyText: 'not JSON' }, { headers: { 'content-type': 'text/html' }, bodyText: '<p>HTML</p>' },
    { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, bodyText: '{"code":0}' }, { status: 206, bodyText: '{"code":0}' },
  ];
  for (const completion of failedCompletions) assert.equal((await f.complete(await f.prepare({ ...request, source: 'manual' }), completion)).saved, false);
  assert.equal((await f.prepare({ ...request, body: '{"events":[2,3]}' })).entry?.bodyText, '{"code":0,"saved":true}');
});


test('network reasons preserve first/manual/disabled/bypass outcomes without disabling recording', async () => {
  const f = await fixture();
  const first = await f.prepare(); assert.equal(first.networkReason?.code, 'FIRST_REQUEST'); assert.equal(first.ticket?.networkReason?.code, 'FIRST_REQUEST');
  assert.equal(first.ticket?.cacheAllowed, true); assert.equal((await f.complete(first)).saved, true);
  assert.equal((await f.panel()).bindings[0].variants[0].networkReason?.code, 'FIRST_REQUEST');
  assert.equal((await f.prepare()).action, 'hit'); assert.equal((await f.panel()).bindings[0].variants[0].networkReason, undefined);
  const manual = await f.prepare({ source: 'manual' }); assert.equal(manual.networkReason?.code, 'MANUAL'); await f.complete(manual);
  assert.equal((await f.panel()).bindings[0].variants[0].networkReason?.code, 'MANUAL');
  await f.call('PAGE_PATCH', { pageUrl: f.pageUrl, patch: { cacheEnabled: false } });
  const disabled = await f.prepare(); assert.equal(disabled.networkReason?.code, 'CACHE_DISABLED'); assert.equal(disabled.networkReason?.detail, '本页缓存关闭');
  assert.equal(disabled.ticket?.cacheAllowed, false);
  assert.equal((await f.prepare({ unsupportedReason: '上传不支持' })).networkReason?.code, 'BYPASS');
});

test('network diagnostics distinguish normalized query/body changes and respect ignored or forced fields', async () => {
  const f = await fixture(); const post = await f.bind('/api/diagnostic', 'POST');
  const req = { url: 'http://localhost:5173/api/diagnostic?page=1', method: 'POST', body: '{"value":1}' };
  await f.complete(await f.prepare(req));
  const query = await f.prepare({ ...req, url: 'http://localhost:5173/api/diagnostic?page=2' }); assert.equal(query.networkReason?.code, 'QUERY_CHANGED'); await f.complete(query);
  const body = await f.prepare({ ...req, url: 'http://localhost:5173/api/diagnostic?page=2', body: '{"value":2}' }); assert.equal(body.networkReason?.code, 'BODY_CHANGED'); await f.complete(body);
  const both = await f.prepare({ ...req, url: 'http://localhost:5173/api/diagnostic?page=3', body: '{"value":3}' }); assert.equal(both.networkReason?.code, 'PARAMETERS_CHANGED'); await f.complete(both);
  await f.call('RULE_PATCH', { pageUrl: f.pageUrl, bindingId: post.id, patch: { ignoreQueryKeys: ['time'], ignoreBodyPointers: ['/volatile'] } });
  const ignored = { ...req, url: 'http://localhost:5173/api/diagnostic?time=1', body: '{"value":1,"volatile":1}' };
  const changedRules = await f.prepare(ignored); assert.equal(changedRules.networkReason?.code, 'RULES_CHANGED'); await f.complete(changedRules);
  assert.equal((await f.prepare({ ...ignored, url: 'http://localhost:5173/api/diagnostic?time=2', body: '{"volatile":2,"value":1}' })).action, 'hit');
  await f.call('RULE_PATCH', { pageUrl: f.pageUrl, bindingId: post.id, patch: { forceCache: true } });
  const force = await f.prepare(req); assert.equal(force.networkReason?.code, 'FORCE_MODE_CHANGED'); await f.complete(force);
  const forcedHit = await f.prepare({ ...req, url: 'http://localhost:5173/api/diagnostic?anything=changed', body: '{"events":[1,2,3]}' });
  assert.equal(forcedHit.action, 'hit'); assert.equal(forcedHit.networkReason, undefined);
  const fingerprints = JSON.stringify(f.repository.state.requestFingerprints);
  assert.ok(!fingerprints.includes('volatile')); assert.ok(!fingerprints.includes('anything')); assert.ok(!fingerprints.includes('events'));
});

test('known expiry, explicit clear, eviction and session changes receive specific reasons', async () => {
  const f = await fixture({ defaultTTL: 1000 });
  await f.complete(await f.prepare()); f.advance(1001);
  const expired = await f.prepare(); assert.equal(expired.networkReason?.code, 'EXPIRED'); await f.complete(expired);
  await f.call('CLEAR', { pageUrl: f.pageUrl, bindingId: f.rule.id });
  const cleared = await f.prepare(); assert.equal(cleared.networkReason?.code, 'CLEARED'); await f.complete(cleared);
  await f.repository.run(async session => {
    const entry = await session.get(cleared.ticket!.cacheKey); entry!.sizeBytes = TOTAL_CACHE_BYTES + 1;
    session.put(cleared.ticket!.cacheKey, entry!); evictToBudget(session);
  });
  assert.equal((await f.prepare()).networkReason?.code, 'EVICTED');
  const automatic = await defaultFixture(); await automatic.complete(await automatic.prepare());
  automatic.rotateBrowserSession('next-browser-session');
  assert.equal((await automatic.prepare({}, { ...sender, documentId: 'next-session-document' })).networkReason?.code, 'SESSION_CHANGED');
});

test('headers, credentials and identity are not misreported as query or body changes', async () => {
  const headers = await fixture(); await headers.complete(await headers.prepare());
  assert.equal((await headers.prepare({ headers: { 'accept-language': 'en' } })).networkReason?.code, 'HEADERS_CHANGED');
  const credentials = await fixture(); await credentials.complete(await credentials.prepare());
  assert.equal((await credentials.prepare({ credentials: 'omit' })).networkReason?.code, 'CREDENTIALS_CHANGED');
  const identity = await defaultFixture();
  const alice = { identityHash: await digest('Bearer alice') };
  await identity.complete(await identity.prepare(alice));
  assert.equal((await identity.prepare({ identityHash: await digest('Bearer bob') })).networkReason?.code, 'IDENTITY_CHANGED');
});

test('pending, failed and unknown historical requests use evidence-specific fallback reasons', async () => {
  const f = await fixture(); const first = await f.prepare();
  const concurrent = await f.prepare(); assert.equal(concurrent.networkReason?.code, 'IN_FLIGHT');
  await f.complete(first, { status: 500 }); await f.complete(concurrent, { status: 500 });
  const retry = await f.prepare(); assert.equal(retry.networkReason?.code, 'NOT_RECORDED'); await f.complete(retry, { status: 500 });
  f.repository.state.requestFingerprints = {};
  assert.equal((await f.prepare({ url: 'http://localhost:5173/api/users?unknown=new' })).networkReason?.code, 'UNAVAILABLE');
  const old = await fixture(); const cached = await old.prepare(); await old.complete(cached);
  delete (old.repository.state as Partial<typeof old.repository.state>).requestFingerprints;
  delete (old.repository.state as Partial<typeof old.repository.state>).missTraces;
  delete (old.repository.state as Partial<typeof old.repository.state>).fingerprintSequence;
  assert.equal((await old.prepare()).action, 'hit');
});

test('out-of-order completions preserve the latest request UI state and network diagnostic', async () => {
  const f = await fixture();
  const older = await f.prepare(); const manual = await f.prepare({ source: 'manual' });
  assert.equal(manual.networkReason?.code, 'MANUAL');
  f.advance(10); assert.equal((await f.complete(older)).saved, true);
  const pending = (await f.panel()).bindings[0].variants[0];
  assert.equal(pending.networkReason?.code, 'MANUAL'); assert.equal(pending.lastStatus, 'PENDING');
  assert.equal(pending.lastCompletedAt, undefined); assert.equal(pending.lastDurationMs, undefined);
  assert.equal(pending.reason, undefined); assert.equal(pending.lastError, undefined);
  await f.complete(manual); assert.equal((await f.prepare()).action, 'hit');
  assert.equal((await f.panel()).bindings[0].variants[0].networkReason, undefined);
  const delayed = await f.prepare({ source: 'manual' });
  f.advance(10); assert.equal((await f.prepare()).action, 'hit');
  const hit = (await f.panel()).bindings[0].variants[0];
  f.advance(10); assert.equal((await f.complete(delayed, { durationMs: 999 })).saved, true);
  const afterDelayed = (await f.panel()).bindings[0].variants[0];
  assert.equal(afterDelayed.networkReason, undefined); assert.equal(afterDelayed.lastStatus, 'HIT');
  assert.equal(afterDelayed.lastCompletedAt, hit.lastCompletedAt); assert.equal(afterDelayed.lastDurationMs, 0);
  assert.equal(afterDelayed.reason, '缓存命中'); assert.equal(afterDelayed.lastError, undefined);
  const failing = await f.prepare({ source: 'manual' });
  assert.equal((await f.prepare()).action, 'hit');
  f.advance(10); const failure = await f.complete(failing, { status: 500, durationMs: 500 });
  const afterFailure = (await f.panel()).bindings[0].variants[0];
  assert.equal(failure.success, false); assert.match(failure.reason!, /500/);
  assert.equal(afterFailure.lastStatus, 'HIT'); assert.equal(afterFailure.reason, '缓存命中');
  assert.equal(afterFailure.lastError, undefined); assert.equal(afterFailure.lastDurationMs, 0);
  assert.equal(afterFailure.networkReason, undefined);
});

test('diagnostic traces and fingerprints are bounded and removed with their variants or binding', async () => {
  const f = await fixture(); const prepared = await f.prepare(); await f.complete(prepared);
  for (let i = 0; i < 6001; i++) f.repository.state.missTraces[`synthetic-${i}`] = { bindingId: f.rule.id, code: 'CLEARED' };
  rememberInvalidation(f.repository.state, 'newest', f.rule.id, 'RULES_CHANGED');
  assert.equal(Object.keys(f.repository.state.missTraces).length, 6000); assert.ok(f.repository.state.missTraces.newest);
  await f.call('BIND_DELETE', { pageUrl: f.pageUrl, bindingId: f.rule.id });
  assert.deepEqual(f.repository.state.missTraces, {}); assert.deepEqual(f.repository.state.requestFingerprints, {});
});


test('a later explicit clear supersedes an earlier eviction diagnostic', async () => {
  const f = await fixture(); const prepared = await f.prepare(); await f.complete(prepared);
  await f.repository.run(async session => {
    const entry = await session.get(prepared.ticket!.cacheKey); entry!.sizeBytes = TOTAL_CACHE_BYTES + 1;
    session.put(prepared.ticket!.cacheKey, entry!); evictToBudget(session);
  });
  assert.equal(f.repository.state.missTraces[`cache:${prepared.ticket!.cacheKey}`].code, 'EVICTED');
  await f.call('CLEAR', { pageUrl: f.pageUrl, bindingId: f.rule.id });
  assert.equal((await f.prepare()).networkReason?.code, 'CLEARED');
});

test('storage statistics separate UTF-8 cache bodies and previews; only options can inspect or clear all', async () => {
  const f = await fixture();
  const read = () => f.call('STORAGE_GET', {}, options) as Promise<import('../src/shared/types').CacheStorageStats>;
  assert.deepEqual(await read(), { cacheBytes: 0, previewBytes: 0, totalBytes: 0, limitBytes: TOTAL_CACHE_BYTES, cacheCount: 0, previewCount: 0, requestRecordCount: 0, pendingCount: 0 });
  const text = '{"名称":"缓存"}';
  await f.complete(await f.prepare(), { bodyText: text });
  await f.call('RULE_PATCH', { pageUrl: f.pageUrl, bindingId: f.rule.id, patch: { enabled: false } });
  await f.complete(await f.prepare({ url: 'http://localhost:5173/api/users?preview=1' }), { bodyText: '{"preview":true}' });
  const before = await read();
  assert.equal(before.cacheBytes, Buffer.byteLength(text)); assert.equal(before.previewBytes, Buffer.byteLength('{"preview":true}'));
  assert.equal(before.totalBytes, before.cacheBytes + before.previewBytes);
  assert.equal(before.cacheCount, 1); assert.equal(before.previewCount, 1); assert.equal(before.requestRecordCount, 2);
  for (const type of ['STORAGE_GET', 'CACHE_CLEAR_ALL']) {
    await assert.rejects(f.call(type), /扩展设置页/);
    await assert.rejects(f.call(type, {}, { ...options, origin: 'http://localhost:5173' }), /扩展设置页/);
  }
  assert.deepEqual(await read(), before);
});

test('global clear spans sites and pages, preserves configuration, blocks in-flight writes and supports fresh recording', async () => {
  const f = await fixture({ apiScopeMode: 'all' });
  await f.complete(await f.prepare());
  const otherSite = await f.call('SITE_SAVE', { site: { origin: 'http://localhost:5174', identityMode: 'public' } }, options) as SiteConfig;
  const otherSender = { ...sender, url: 'http://localhost:5174/other', origin: 'http://localhost:5174', tab: { id: 8, url: 'http://localhost:5174/other' } };
  await f.complete(await f.prepare({ pageUrl: otherSender.url, url: 'http://localhost:5174/api/other' }, otherSender), {}, otherSender);
  await f.complete(await f.prepare({ pageUrl: 'http://localhost:5173/second' }));
  const inflight = await f.prepare({ url: 'http://localhost:5173/api/users?pending=1' });
  const sites = structuredClone(f.repository.state.sites), pages = structuredClone(f.repository.state.pages), rules = structuredClone(f.repository.state.rules);
  const stats = await f.call('CACHE_CLEAR_ALL', {}, options) as import('../src/shared/types').CacheStorageStats;
  assert.equal(stats.totalBytes, 0); assert.equal(stats.pendingCount, 0); assert.equal(stats.requestRecordCount, 0);
  assert.equal(f.repository.entries.size, 0);
  assert.deepEqual(f.repository.state.sites, sites); assert.deepEqual(f.repository.state.pages, pages);
  assert.ok(f.repository.state.sites[otherSite.id]);
  for (const rule of Object.values(rules)) assert.deepEqual(f.repository.state.rules[rule.id], { ...rule, generation: rule.generation + 1 });
  assert.equal((await f.complete(inflight)).saved, false); assert.equal(f.repository.entries.size, 0);
  assert.deepEqual(f.repository.state.logs, []); assert.deepEqual(f.repository.state.requestFingerprints, {});
  const fresh = await f.prepare(); assert.equal(fresh.action, 'network'); assert.equal(fresh.networkReason?.code, 'CLEARED');
  assert.equal((await f.complete(fresh)).saved, true); assert.equal((await f.prepare()).action, 'hit');
});
