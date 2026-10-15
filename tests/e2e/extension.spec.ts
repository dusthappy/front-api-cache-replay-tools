import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, cp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ApiScopeDiscoveryState, PanelState, SiteConfig } from '../../src/shared/types';
import type { CacheState } from '../../src/background/cache-store';
import { chromeExecutable } from './chrome';

let context: BrowserContext, settings: Page, page: Page, root: string, extensionPath: string, profile: string, extensionId: string;
const origin = 'http://127.0.0.1:4173';
const chromePath = chromeExecutable();
const site: SiteConfig = {
  id: 'fixture', origin, environmentId: 'local', routeMode: 'history', pageIdentityQueryKeys: [],
  apiScopeMode: 'custom',
  apiScopes: [{ origin, pathPrefix: '/api/' }, { origin: 'http://127.0.0.1:4174', pathPrefix: '/api/' }],
  cacheEnabled: true, captureEnabled: true, identityMode: 'public', sessionPartition: '',
  defaultTTL: 1800000, generation: 0, authPaths: ['login','logout','token','refresh']
};
async function admin(type: string, payload?: any) {
  const result = await settings.evaluate(async ({ type, payload }) => chrome.runtime.sendMessage({ type, payload }), {type,payload});
  if (!result.ok) throw Error(`${type}: ${result.error}`);
  return result.data;
}
async function rpc(type: string, payload: any = {}) {
  const result = await settings.evaluate(async ({type,payload,url}) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(t => t.url === url);
    if (!tab?.id) throw Error(`Missing fixture tab ${url}`);
    const results = await chrome.scripting.executeScript({target: {tabId:tab.id}, world:'ISOLATED',
      func: async (type, payload) => chrome.runtime.sendMessage({type,payload}), args:[type,payload] });
    return results[0].result;
  }, {type,payload,url:page.url()});
  if (!result?.ok) throw Error(`${type}: ${result?.error}`);
  return result.data;
}
const panel = async ():Promise<PanelState> => rpc('PANEL',{pageUrl:page.url()});
async function request(url: string, init?: RequestInit) {
  return page.evaluate(async ({url, init}) => {const response = await fetch(url,init); return {status:response.status, text:await response.text()};}, {url,init});
}
async function count(url: string, method='GET') {
  const data = await (await settings.request.get(`${origin}/__counts`)).json();
  return data[`${method} ${new URL(url,origin).pathname}`] || 0;
}
async function bind(url: string, patch: any = {}, method='GET') {
  const data = await rpc('BIND_ADD', {pageUrl:page.url(),method,url:new URL(url,origin).href,alias:''});
  const state = await panel();
  const binding = state.bindings.find(b=> b.pathname === new URL(url,origin).pathname && b.method === method)!;
  if (!binding) throw Error(`Missing binding ${JSON.stringify(data)}`);
  await rpc('RULE_PATCH',{pageUrl:page.url(),bindingId:binding.id,patch:{enabled:true,...patch}});
  return binding.id;
}
async function settle() {
  await expect.poll(async()=> (await panel()).bindings.flatMap(b=>b.variants).filter(v=>v.lastStatus==='PENDING').length).toBe(0);
}
async function restartBackground() {
  const cdp=await context.newCDPSession(settings);
  try {
    const targets=await cdp.send('Target.getTargets');
    const target=targets.targetInfos.find((item:any)=>item.type==='service_worker'&&item.url.includes(extensionId));
    expect(target).toBeTruthy();
    await cdp.send('Target.closeTarget',{targetId:target!.targetId});
    await admin('OPTIONS_GET');
  } finally {await cdp.detach();}
}
async function manual(bindingId: string, variantId?:string) {
  return page.evaluate(({bindingId,variantId})=>new Promise<any>((resolve,reject)=>{
    const id=crypto.randomUUID(); const timeout=setTimeout(()=>reject(Error('manual timeout')),8000);
    const listener=(event:MessageEvent)=>{if(event.data?.channel==='API_CACHE_REPLAY_V1' && event.data.direction==='command-result' && event.data.id===id){clearTimeout(timeout);window.removeEventListener('message',listener);event.data.ok?resolve(event.data.data):reject(Error(event.data.error));}};
    window.addEventListener('message',listener);
    window.postMessage({channel:'API_CACHE_REPLAY_V1',direction:'command',id,type:'MANUAL',payload:{bindingId,variantId}},location.origin);
  }),{bindingId,variantId});
}
async function launch() {
  context = await chromium.launchPersistentContext(profile, {
    executablePath:chromePath, headless:true, viewport:{width:1280,height:900},
    args:[`--disable-extensions-except=${extensionPath}`,`--load-extension=${extensionPath}`]
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
  settings=await context.newPage(); await settings.goto(`chrome-extension://${extensionId}/options.html`);
}
test.beforeAll(async()=>{
  root=await mkdtemp(path.join(tmpdir(),'api-cache-replay-e2e-')); extensionPath=path.join(root,'extension'); profile=path.join(root,'profile');
  await cp(path.resolve('dist'),extensionPath,{recursive:true});
  // Grant only fixture origins in the disposable test build; production uses optional permissions.
  const manifest=JSON.parse(await readFile(path.join(extensionPath,'manifest.json'),'utf8'));
  manifest.host_permissions=['http://127.0.0.1/*'];
  await writeFile(path.join(extensionPath,'manifest.json'),JSON.stringify(manifest));
  await launch();
});
test.afterAll(async()=>{await context?.close();await rm(root,{recursive:true,force:true});});
test.beforeEach(async({ },info)=>{
  Object.assign(site,await admin('SITE_SAVE',{site}));
  page=await context.newPage();
  await page.goto(`${origin}/case-${info.title.split(' ')[0]}`);
  await expect(page.locator('[data-api-cache-replay]')).toBeAttached();
});
test.afterEach(async()=>{await page?.close();});

test('A00 只填网站地址即可自动缓存任意路径、跨源与 POST 查询',async()=>{
  const defaultOrigin='http://127.0.0.1:4175';
  let savedId:string|undefined;
  try {
    await settings.reload();
    await settings.getByRole('button',{name:'添加网站',exact:true}).click();
    await expect(settings.getByLabel('后端环境标识')).not.toBeVisible();
    await settings.getByLabel('前端网站地址').fill(defaultOrigin);
    await settings.getByRole('button',{name:'授权并添加网站',exact:true}).click();
    await expect(settings.getByRole('status').filter({hasText:'网站已保存'})).toBeVisible();
    const saved:SiteConfig=(await admin('OPTIONS_GET')).sites.find((item:SiteConfig)=>item.origin===defaultOrigin);
    savedId=saved.id;
    expect(saved).toMatchObject({apiScopeMode:'all',identityMode:'auto',cacheEnabled:true,captureEnabled:true});
    await mkdir('docs/verification',{recursive:true});
    await settings.screenshot({path:'docs/verification/options-defaults-desktop.png',fullPage:true});
    await settings.locator('summary').filter({hasText:'高级设置'}).click();
    await settings.screenshot({path:'docs/verification/options-defaults-advanced.png',fullPage:true});
    await settings.locator('summary').filter({hasText:'高级设置'}).click();
    await settings.setViewportSize({width:390,height:844});
    await settings.screenshot({path:'docs/verification/options-defaults-narrow.png',fullPage:true});
    await settings.setViewportSize({width:1280,height:900});

    await page.goto(`${defaultOrigin}/automatic-defaults`);
    await expect(page.locator('button.floating')).toBeVisible();
    expect((await panel()).page.cacheEnabled).toBe(true);
    const repeatedGet=async(url:string)=>{
      const before=await count(url);
      const first=await request(url);await settle();
      expect(await request(url)).toEqual(first);await settle();
      expect(await count(url)).toBe(before+1);
      const binding=(await panel()).bindings.find(item=>item.pathname===new URL(url,defaultOrigin).pathname)!;
      expect(binding.enabled).toBe(true);expect(binding.variants[0].lastStatus).toBe('HIT');
    };
    await repeatedGet('/backend/default-get');
    await repeatedGet('http://127.0.0.1:4174/services/default-cors');
    await repeatedGet('/backend/default-no-store?noStore=1');
    const post=()=>request('/backend/default-post',{method:'POST',headers:{'content-type':'application/json'},body:'{"filter":"active","page":1}'});
    const firstPost=await post();await settle();expect(await post()).toEqual(firstPost);await settle();
    expect(await count('/backend/default-post','POST')).toBe(1);
    expect((await panel()).bindings.find(item=>item.pathname==='/backend/default-post')).toMatchObject({enabled:true,readOnly:true});
    const xhr=()=>page.evaluate(()=>new Promise<any>((resolve,reject)=>{const x=new XMLHttpRequest();x.open('GET','/backend/default-xhr');x.responseType='json';x.onload=()=>resolve(x.response);x.onerror=()=>reject(Error('xhr'));x.send();}));
    const firstXHR=await xhr();await settle();expect(await xhr()).toEqual(firstXHR);await settle();expect(await count('/backend/default-xhr')).toBe(1);

    await page.locator('button.floating').click();
    await expect(page.getByText('/backend/default-get',{exact:true})).toBeVisible();
    await page.screenshot({path:'docs/verification/panel-defaults.png'});
    await page.keyboard.press('Escape');
    await page.evaluate(()=>history.pushState({},'','/automatic-defaults-next'));
    expect((await panel()).page.cacheEnabled).toBe(true);
    await repeatedGet('/backend/default-get');
    expect(await count('/backend/default-get')).toBe(2);
    for(const method of ['PUT','PATCH','DELETE']) {
      await request('/backend/default-write',{method,headers:{'content-type':'application/json'},body:'{}'});await settle();
      await request('/backend/default-write',{method,headers:{'content-type':'application/json'},body:'{}'});await settle();
      expect(await count('/backend/default-write',method)).toBe(2);
    }
    await request('/backend/login');await settle();await request('/backend/login');await settle();expect(await count('/backend/login')).toBe(2);
    await page.evaluate(async()=>{for(let i=0;i<2;i++){const body=new FormData();body.set('file',new Blob(['fixture upload']), 'example.txt');await fetch('/backend/default-upload',{method:'POST',body});}});
    expect(await count('/backend/default-upload','POST')).toBe(2);
  } finally {
    await settings.setViewportSize({width:1280,height:900});
    if(savedId) await admin('SITE_DELETE',{siteId:savedId});
  }
});
test('A00b 自动身份支持 Authorization，同标签页刷新保留缓存且新标签页隔离',async()=>{
  await admin('SITE_SAVE',{site:{...site,apiScopeMode:'all',apiScopes:[],identityMode:'auto'}});
  const anonymousURL='/backend/auto-document';
  const first=await request(anonymousURL);await settle();expect(await request(anonymousURL)).toEqual(first);await settle();
  expect(await count(anonymousURL)).toBe(1);
  await page.reload();
  const reloaded=await request(anonymousURL);await settle();expect(reloaded).toEqual(first);expect(await request(anonymousURL)).toEqual(reloaded);await settle();
  expect(await count(anonymousURL)).toBe(1);
  const currentPage=page;
  try {
    page=await context.newPage();await page.goto(currentPage.url());
    const other=await request(anonymousURL);await settle();expect(other).not.toEqual(reloaded);expect(await request(anonymousURL)).toEqual(other);await settle();
    expect(await count(anonymousURL)).toBe(2);
  } finally {await page.close();page=currentPage;}
  const authorized=(token:string)=>request('/backend/auto-authorization',{headers:{authorization:`Bearer ${token}`}});
  const a=await authorized('default-account-a');await settle();expect(await authorized('default-account-a')).toEqual(a);await settle();
  expect(await count('/backend/auto-authorization')).toBe(1);
  await page.reload();expect(await authorized('default-account-a')).toEqual(a);await settle();expect(await count('/backend/auto-authorization')).toBe(1);
  const b=await authorized('default-account-b');await settle();expect(b).not.toEqual(a);expect(await authorized('default-account-b')).toEqual(b);await settle();
  expect(await count('/backend/auto-authorization')).toBe(2);
});
test('A01 授权范围与端口精确隔离',async()=>{
  const other=await context.newPage();await other.goto('http://127.0.0.1:4175/users');
  await expect(other.locator('button.floating')).toHaveCount(0);
  await other.close();
  const manifest=JSON.parse(await readFile('dist/manifest.json','utf8'));
  expect(manifest.host_permissions).toBeUndefined();expect(manifest.permissions).toEqual(['storage','scripting']);
});
test('A05 首次录制、命中与 fetch 原生 Response',async()=>{
  const id=await bind('/api/basic');const before=await count('/api/basic');
  const a=await request('/api/basic?a=1');await settle();const b=await request('/api/basic?a=1');await settle();
  expect(b).toEqual(a);expect(await count('/api/basic')).toBe(before+1);
  const variants=(await panel()).bindings.find(b=>b.id===id)!.variants;
  expect(variants[0].lastStatus).toBe('HIT');expect(variants[0].cachedAt).toBeTruthy();
  const response=await page.evaluate(async()=>{const r=await fetch('/api/basic?a=1');const c=r.clone();return {json:await r.json(),text:await c.text(),used:r.bodyUsed,status:r.status,header:r.headers.get('x-fixture')};});
  expect(response.used).toBe(true);expect(response.status).toBe(200);expect(response.header).toBe('api-cache-replay');
});
test('A06 参数规范化与显式 POST 查询',async()=>{
  await bind('/api/search-key',{readOnly:true},'POST');const before=await count('/api/search-key','POST');
  const post=(body:any)=>request('/api/search-key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const a=await post({a:1,b:{x:2,y:3}});await settle();const b=await post({b:{y:3,x:2},a:1});await settle();expect(b).toEqual(a);
  await post({a:'1',b:{x:2,y:3}});await settle();expect(await count('/api/search-key','POST')).toBe(before+2);
  await bind('/api/query-key');
  const q=await request('/api/query-key?z=2&a=1&a=2');await settle();expect(await request('/api/query-key?a=1&a=2&z=2')).toEqual(q);await settle();
  await request('/api/query-key?a=2&a=1&z=2');await settle();expect(await count('/api/query-key')).toBe(2);
});
test('A07 忽略参数仅改变匹配、手动重发保留最近原始参数',async()=>{
  const id=await bind('/api/pagination',{ignoreQueryKeys:['page','pageSize']});
  const a=await request('/api/pagination?page=2&pageSize=20&status=active');await settle();
  const b=await request('/api/pagination?page=3&pageSize=40&status=active');await settle();expect(b).toEqual(a);
  const result=await manual(id);expect(result.success).toBe(true);expect(result.saved).toBe(true);
  const fresh=await request('/api/pagination?page=5&pageSize=20&status=active');await settle();
  expect(JSON.parse(fresh.text).query).toContainEqual(['page','3']);expect(await count('/api/pagination')).toBe(2);
  await rpc('RULE_PATCH',{pageUrl:page.url(),bindingId:id,patch:{ignoreQueryKeys:[]}});
  await request('/api/pagination?page=5&pageSize=20&status=active');await settle();expect(await count('/api/pagination')).toBe(3);
});
test('A08 写操作、鉴权接口与始终直通',async()=>{
  await bind('/api/write',{readOnly:false},'POST');
  for(let i=0;i<2;i++){await request('/api/write',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});await settle();}
  expect(await count('/api/write','POST')).toBe(2);
  await bind('/api/always',{alwaysBypass:true});await request('/api/always');await settle();await request('/api/always');await settle();expect(await count('/api/always')).toBe(2);
  const id=await bind('/api/login');await request('/api/login');await settle();await request('/api/login');await settle();expect(await count('/api/login')).toBe(2);
  await expect(manual(id)).rejects.toThrow();
});
test('A09 时间语义与关闭缓存后的手动重发',async()=>{
  const id=await bind('/api/time');await request('/api/time');await settle();
  const first=(await panel()).bindings.find(b=>b.id===id)!.variants[0];
  await request('/api/time');await settle();let current=(await panel()).bindings.find(b=>b.id===id)!.variants[0];
  expect(current.lastNetworkAttemptAt).toBe(first.lastNetworkAttemptAt);expect(current.cachedAt).toBe(first.cachedAt);expect(current.lastPageCallAt).toBeGreaterThanOrEqual(first.lastPageCallAt!);
  await rpc('RULE_PATCH',{pageUrl:page.url(),bindingId:id,patch:{enabled:false}});
  const lastCall=current.lastPageCallAt;const result=await manual(id);expect(result.success).toBe(true);expect(result.saved).toBe(false);
  current=(await panel()).bindings.find(b=>b.id===id)!.variants[0];expect(current.cachedAt).toBe(first.cachedAt);expect(current.lastPageCallAt).toBe(lastCall);
});
test('A13 业务错误、HTTP 错误、no-store 与大响应',async()=>{
  await bind('/api/business',{successCondition:{pointer:'/code',value:0}});
  await request('/api/business?businessError=1');await settle();await request('/api/business?businessError=1');await settle();expect(await count('/api/business')).toBe(2);
  for(const [name,params] of [['http','status=500'],['nostore','noStore=1'],['large','large=1']]){
    await bind(`/api/${name}`,name==='nostore'?{allowNoStore:false}:{});await request(`/api/${name}?${params}`);await settle();await request(`/api/${name}?${params}`);await settle();expect(await count(`/api/${name}`)).toBe(2);
  }
});
test('A14 身份、租户、环境分区与凭证不落盘',async()=>{
  const id=await bind('/api/identity',{varyHeaders:['x-tenant-id']});
  const get=(token:string,tenant:string)=>request('/api/identity',{headers:{authorization:`Bearer ${token}`,'x-tenant-id':tenant}});
  await get('test-secret-one','a');await settle();await get('test-secret-one','a');await settle();expect(await count('/api/identity')).toBe(1);
  await get('test-secret-two','a');await settle();await get('test-secret-two','b');await settle();expect(await count('/api/identity')).toBe(3);
  await admin('SITE_SAVE',{site:{...site,environmentId:'staging'}});await get('test-secret-two','b');await settle();expect(await count('/api/identity')).toBe(4);
  const dump=await settings.evaluate(async()=>{
    const dbs=await indexedDB.databases();const rows:any[]=[];
    for(const info of dbs){const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(info.name!);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      for(const store of [...db.objectStoreNames]) rows.push(await new Promise(resolve=>{const r=db.transaction(store).objectStore(store).getAll();r.onsuccess=()=>resolve(r.result);}));db.close();}
    return JSON.stringify({rows,storage:await chrome.storage.local.get(null)});
  });
  expect(dump).not.toContain('test-secret-one');expect(dump).not.toContain('test-secret-two');
  expect((await panel()).bindings.find(b=>b.id===id)).toBeTruthy();
});
test('A16 清空和关闭再开启阻止在途写入',async()=>{
  const id=await bind('/api/slow');
  const task=request('/api/slow?delay=450');await expect.poll(()=>count('/api/slow')).toBe(1);
  await rpc('CLEAR',{pageUrl:page.url(),bindingId:id});await task;await settle();
  await request('/api/slow?delay=450');await settle();expect(await count('/api/slow')).toBe(2);
  await rpc('CLEAR',{pageUrl:page.url(),bindingId:id});
  const task2=request('/api/slow?delay=450');await expect.poll(()=>count('/api/slow')).toBe(3);
  await rpc('RULE_PATCH',{pageUrl:page.url(),bindingId:id,patch:{enabled:false}});await rpc('RULE_PATCH',{pageUrl:page.url(),bindingId:id,patch:{enabled:true}});
  await task2;await settle();await request('/api/slow?delay=450');await settle();expect(await count('/api/slow')).toBe(4);
});
test('A16b 同键乱序完成不能覆盖后发成功响应',async()=>{
  await bind('/api/order',{ignoreQueryKeys:['delay']});
  const slow=request('/api/order?delay=450');await expect.poll(()=>count('/api/order')).toBe(1);
  const fast=await request('/api/order?delay=10');await settle();await slow;await settle();
  const hit=await request('/api/order?delay=20');expect(hit.text).toBe(fast.text);expect(await count('/api/order')).toBe(2);
});
test('A17 fetch abort 与 XHR json、事件、timeout',async()=>{
  await bind('/api/xhr');
  const xhr=()=>page.evaluate(()=>new Promise<any>((resolve,reject)=>{const x=new XMLHttpRequest();const events:number[]=[];x.open('GET','/api/xhr');x.responseType='json';x.onreadystatechange=()=>events.push(x.readyState);x.onload=()=>resolve({body:x.response,status:x.status,header:x.getResponseHeader('x-fixture'),events});x.onerror=()=>reject(Error('xhr'));x.send();}));
  const first=await xhr();await settle();const second=await xhr();await settle();expect(second.body).toEqual(first.body);expect(second.status).toBe(200);expect(second.events).toContain(4);expect(second.header).toBe('api-cache-replay');expect(await count('/api/xhr')).toBe(1);
  const aborted=await page.evaluate(async()=>{const controller=new AbortController();const p=fetch('/api/abort?delay=300',{signal:controller.signal}).then(()=> 'success',e=>e.name);controller.abort();return p;});expect(aborted).toBe('AbortError');
  const timed=await page.evaluate(()=>new Promise<string>(resolve=>{const x=new XMLHttpRequest();x.open('GET','/api/timeout?delay=400');x.timeout=40;x.ontimeout=()=>resolve('timeout');x.onload=()=>resolve('load');x.send();}));expect(timed).toBe('timeout');
  const cachedAbort=await page.evaluate(async()=>{const c=new AbortController();const r=await fetch('/api/xhr',{signal:c.signal});c.abort();return r.text().then(()=>({name:'success',message:''}),e=>({name:e.name,message:e.message}));});expect(cachedAbort).toMatchObject({name:'AbortError'});
});
test('A17b Axios XHR、Request 覆盖与原始正文',async()=>{
  await bind('/api/axios');
  await page.addScriptTag({path:path.resolve('node_modules/axios/dist/axios.min.js')});
  const axios=()=>page.evaluate(async()=>{const r=await (window as any).axios.get('/api/axios',{adapter:'xhr'});return {data:r.data,status:r.status,fixture:r.headers['x-fixture']};});
  const first=await axios();await settle();expect(await axios()).toEqual(first);await settle();expect(await count('/api/axios')).toBe(1);
  await bind('/api/request-body',{readOnly:true},'POST');
  const overlay=()=>page.evaluate(async()=>{const req=new Request('/api/request-body',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"first":1}'});const res=await fetch(req,{body:'{"second":2}'});return res.json();});
  const original=await overlay();await settle();expect(original.body).toEqual({second:2});expect(await overlay()).toEqual(original);await settle();expect(await count('/api/request-body','POST')).toBe(1);
});
test('A17c 跨域 CORS 与当前 Cookie 凭证语义',async()=>{
  const endpoint='http://127.0.0.1:4174/api/cors';await bind(endpoint);
  await context.addCookies([{name:'fixture-session',value:'active',url:origin}]);
  const anonymous=await request(endpoint,{credentials:'omit'});await settle();expect(JSON.parse(anonymous.text).cookie).toBe(false);
  const authenticated=await request(endpoint,{credentials:'include'});await settle();expect(JSON.parse(authenticated.text).cookie).toBe(true);
  expect(await request(endpoint,{credentials:'omit'})).toEqual(anonymous);expect(await request(endpoint,{credentials:'include'})).toEqual(authenticated);await settle();expect(await count(endpoint)).toBe(2);
  await context.clearCookies();
});
test('A20 不支持的 Request Body、二进制、Worker 与 iframe 保持原生请求',async()=>{
  await bind('/api/request-stream',{readOnly:true},'POST');
  const raw=()=>page.evaluate(async()=>{const req=new Request('/api/request-stream',{method:'POST',headers:{'content-type':'application/json'},body:'{"stream":true}'});return(await fetch(req)).json();});
  expect((await raw()).body).toEqual({stream:true});await raw();expect(await count('/api/request-stream','POST')).toBe(2);
  await bind('/api/binary');
  const binary=()=>page.evaluate(()=>new Promise<number>(resolve=>{const x=new XMLHttpRequest();x.open('GET','/api/binary');x.responseType='arraybuffer';x.onload=()=>resolve(x.response.byteLength);x.send();}));
  expect(await binary()).toBeGreaterThan(0);await binary();expect(await count('/api/binary')).toBe(2);
  await bind('/api/worker');
  await page.evaluate(async()=>{
    const source=`Promise.all([fetch('${location.origin}/api/worker'),fetch('${location.origin}/api/worker')]).then(()=>postMessage('done'))`;
    const blob=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));const worker=new Worker(blob);
    await new Promise(resolve=>worker.onmessage=resolve);worker.terminate();URL.revokeObjectURL(blob);
  });expect(await count('/api/worker')).toBe(2);
  const frame=await page.evaluateHandle(()=>{const frame=document.createElement('iframe');frame.src='/iframe';document.body.append(frame);return frame;});
  const nested=await (frame.asElement()!).contentFrame();await nested!.waitForLoadState();
  expect(await nested!.locator('[data-api-cache-replay]').count()).toBe(0);
  await nested!.evaluate(async()=>{await fetch('/api/frame');await fetch('/api/frame');});expect(await count('/api/frame')).toBe(2);
});
test('A04 页面快照、历史绑定与独立缓存',async()=>{
  const start=page.url();const id=await bind('/api/route');
  const delayed=request('/api/route?delay=250');await expect.poll(()=>count('/api/route')).toBe(1);
  await page.evaluate(()=>history.pushState({},'','/route-next'));await delayed;
  expect((await panel()).bindings).toHaveLength(0);
  await page.evaluate(url=>history.replaceState({},'',url),start);await settle();expect((await panel()).bindings.find(b=>b.id===id)!.variants).toHaveLength(1);
  await page.reload();expect((await panel()).bindings.find(b=>b.id===id)).toBeTruthy();
  await request('/api/route?delay=250');await settle();expect(await count('/api/route')).toBe(1);
});
test('A19 TTL 与页面清空隔离',async()=>{
  await bind('/api/ttl',{ttl:20});await request('/api/ttl');await settle();await new Promise(r=>setTimeout(r,40));await request('/api/ttl');await settle();expect(await count('/api/ttl')).toBe(2);
  await bind('/api/isolated');await request('/api/isolated');await settle();const original=page.url();
  await page.evaluate(()=>history.pushState({},'','/other-isolation'));await rpc('PAGE_PATCH',{pageUrl:page.url(),patch:{cacheEnabled:true}});await bind('/api/isolated');await request('/api/isolated');await settle();
  await rpc('CLEAR',{pageUrl:page.url()});await page.evaluate(url=>history.pushState({},'',url),original);await request('/api/isolated');await settle();expect(await count('/api/isolated')).toBe(2);
});
test('A02-A03 浮窗交互与窄窗口布局',async()=>{
  await bind('/api/visual');await request('/api/visual');await settle();
  const trigger=page.getByRole('button',{name:/API Cache Replay.*打开接口面板/});
  await expect(trigger).toHaveCSS('right','35px');
  await expect(trigger).toHaveCSS('top','55px');
  expect(await trigger.evaluate(element=>(element as HTMLElement).style.left)).toBe('');
  await page.setViewportSize({width:1000,height:900});
  await expect(trigger).toHaveCSS('right','35px');
  const resized=(await trigger.boundingBox())!;expect(1000-resized.x-resized.width).toBe(35);
  await page.setViewportSize({width:1280,height:900});
  const box=(await trigger.boundingBox())!;
  await page.mouse.move(box.x+22,box.y+22);await page.mouse.down();await page.mouse.move(box.x-90,box.y+90,{steps:8});await page.mouse.up();
  await expect(page.locator('#acr-panel')).toHaveCount(0);
  const moved=(await page.locator('button.floating').boundingBox())!;
  await page.reload();await expect(page.locator('button.floating')).toBeVisible();
  const restored=(await page.locator('button.floating').boundingBox())!;expect(Math.abs(restored.x-moved.x)).toBeLessThan(2);expect(Math.abs(restored.y-moved.y)).toBeLessThan(2);
  await trigger.click();
  await expect(page.getByText('/api/visual',{exact:true}).first()).toBeVisible();
  await expect(page.locator('.endpoint-detail')).toHaveCount(0);
  await page.getByRole('switch',{name:'/api/visual 缓存开关',exact:true}).click();await expect(page.locator('.endpoint-detail')).toHaveCount(0);
  await page.getByRole('switch',{name:'/api/visual 缓存开关',exact:true}).click();
  await page.screenshot({path:'test-results/panel-desktop.png'});
  await page.keyboard.press('Escape');
  await trigger.click();
  await page.getByRole('button',{name:'GET /api/visual',exact:true}).click();await expect(page.locator('.endpoint-detail')).toBeVisible();await expect(page.locator('.response-preview')).toHaveCount(0);
  await page.setViewportSize({width:390,height:700});
  await page.screenshot({path:'test-results/panel-narrow.png'});
  await expect(page.locator('button.floating')).toBeInViewport();
  await page.keyboard.press('Escape');await expect(page.locator('#acr-panel')).toHaveCount(0);
  await settings.reload();await expect(settings.getByRole('heading',{name:'配置开发网站',exact:true})).toBeVisible();
  await settings.screenshot({path:'test-results/options-desktop.png',fullPage:true});
});
test('A10 指定参数组重发不覆盖其他组',async()=>{
  const id=await bind('/api/variants');const a=await request('/api/variants?x=1');await settle();const b=await request('/api/variants?x=2');await settle();
  const variant=(await panel()).bindings.find(b=>b.id===id)!.variants.find(v=>v.url.endsWith('x=1'))!;
  expect((await manual(id,variant.id)).saved).toBe(true);
  expect(await request('/api/variants?x=2')).toEqual(b);expect(await request('/api/variants?x=1')).not.toEqual(a);expect(await count('/api/variants')).toBe(3);
});
test('A14b Cookie 会话与未建立身份上下文',async()=>{
  await admin('SITE_SAVE',{site:{...site,identityMode:'unconfigured'}});await bind('/api/cookie');
  await request('/api/cookie');await settle();await request('/api/cookie');await settle();expect(await count('/api/cookie')).toBe(2);
  await admin('SITE_SAVE',{site:{...site,identityMode:'session',sessionPartition:'account-a'}});
  const first=await request('/api/cookie');await settle();expect(await request('/api/cookie')).toEqual(first);await settle();expect(await count('/api/cookie')).toBe(3);
  await admin('SITE_SAVE',{site:{...site,identityMode:'session',sessionPartition:'account-b'}});await request('/api/cookie');await settle();expect(await count('/api/cookie')).toBe(4);
});
test('A14c 表单登录直通并失效旧身份缓存',async()=>{
  await bind('/api/form-session');const original=await request('/api/form-session');await settle();
  expect(await request('/api/form-session')).toEqual(original);await settle();expect(await count('/api/form-session')).toBe(1);
  await page.evaluate(async()=>{const body=new FormData();body.set('password','fixture-form-secret');await(await fetch('/api/login',{method:'POST',body})).json();});
  await expect.poll(async()=> (await panel()).bindings.some(b=>b.pathname==='/api/login'&&b.variants.some(v=>v.lastStatus==='BYPASS'))).toBe(true);
  await request('/api/form-session');await settle();expect(await count('/api/form-session')).toBe(2);
  const preview=(await panel()).bindings.find(b=>b.pathname==='/api/login')!;expect(preview.variants[0].body).toBeUndefined();
  expect((await rpc('PREVIEW',{pageUrl:page.url(),bindingId:preview.id,variantId:preview.variants[0].id})).bodyText).not.toContain('fixture-form-secret');
});
test('A01b 设置页表单保存与暂停采集',async()=>{
  await settings.reload();await settings.locator('summary').filter({hasText:'高级设置'}).click();await settings.getByLabel('后端环境标识').fill('ui-saved');
  await settings.getByRole('button',{name:'保存网站设置',exact:true}).click();
  await expect(settings.getByRole('status').filter({hasText:'网站已保存'})).toBeVisible();
  expect((await admin('OPTIONS_GET')).sites.find((s:SiteConfig)=>s.id===site.id).environmentId).toBe('ui-saved');
  await settings.getByRole('button',{name:'运行中 · 暂停扩展'}).click();
  await expect(settings.getByRole('button',{name:'已暂停 · 恢复运行'})).toBeVisible();
  await request('/api/paused');expect((await panel()).bindings.some(b=>b.pathname==='/api/paused')).toBe(false);
  await settings.getByRole('button',{name:'已暂停 · 恢复运行'}).click();
  await expect(settings.getByRole('button',{name:'运行中 · 暂停扩展'})).toBeVisible();
});
test('A04b Hash 路由和页面区分参数',async()=>{
  await admin('SITE_SAVE',{site:{...site,routeMode:'hash',pageIdentityQueryKeys:['workspace']}});
  await page.goto(`${origin}/hash#/users?workspace=a&noise=1`);await rpc('PAGE_PATCH',{pageUrl:page.url(),patch:{cacheEnabled:true}});await bind('/api/hash');await request('/api/hash');await settle();
  const first=(await panel()).page.id;
  await page.evaluate(()=>location.hash='/users?workspace=a&noise=2');expect((await panel()).page.id).toBe(first);
  await page.evaluate(()=>location.hash='/users?workspace=b');expect((await panel()).page.id).not.toBe(first);expect((await panel()).bindings).toHaveLength(0);
});
test('A18 桥接查询超时只回退一次原始请求',async()=>{
  await bind('/api/bridge-failure');
  await page.evaluate(()=>{
    const post=window.postMessage.bind(window);
    window.postMessage=((message:any,...args:any[])=>{if(message?.channel==='API_CACHE_REPLAY_V1'&&message.direction==='to-extension'&&message.type==='PREPARE') return;return Reflect.apply(post,window,[message,...args]);}) as typeof window.postMessage;
  });
  const result=await request('/api/bridge-failure');expect(result.status).toBe(200);expect(await count('/api/bridge-failure')).toBe(1);
});
test('A18b 缓存保存失败不重发真实请求',async()=>{
  await bind('/api/storage-failure');const worker=context.serviceWorkers().find(w=>w.url().includes(extensionId))!;
  await worker.evaluate(()=>{
    const original=IDBObjectStore.prototype.put;
    (globalThis as any).__restorePut=()=>IDBObjectStore.prototype.put=original;
    IDBObjectStore.prototype.put=function(...args:Parameters<IDBObjectStore['put']>){if(this.name==='bodies')throw new DOMException('fixture quota','QuotaExceededError');return Reflect.apply(original,this,args);};
  });
  try { const result=await request('/api/storage-failure');expect(result.status).toBe(200);await expect.poll(()=>count('/api/storage-failure')).toBe(1); }
  finally { await new Promise(r=>setTimeout(r,150)); await worker.evaluate(()=>(globalThis as any).__restorePut()); }
});
test('A12 请求并刷新页面等待缓存保存',async()=>{
  await bind('/api/reload');await request('/api/reload');await settle();
  await page.locator('button.floating').click();await page.getByRole('button',{name:'GET /api/reload',exact:true}).click();
  await expect(page.getByRole('button',{name:'请求并刷新页面',exact:true})).toBeEnabled();
  await Promise.all([page.waitForEvent('load'),page.getByRole('button',{name:'请求并刷新页面',exact:true}).click()]);
  const refreshed=await request('/api/reload');await settle();expect(JSON.parse(refreshed.text).count).toBe(2);expect(await count('/api/reload')).toBe(2);
});
test('A18c 后台停止后唤醒继续命中',async()=>{
  await bind('/api/wakeup');const original=await request('/api/wakeup');await settle();
  const cdp=await context.newCDPSession(settings);
  const targets=await cdp.send('Target.getTargets');const target=targets.targetInfos.find((t:any)=>t.type==='service_worker'&&t.url.includes(extensionId));expect(target).toBeTruthy();
  await cdp.send('Target.closeTarget',{targetId:target!.targetId});
  const hit=await request('/api/wakeup');await settle();expect(hit).toEqual(original);expect(await count('/api/wakeup')).toBe(1);await cdp.detach();
});
test('A19b 浏览器重启后缓存与规则恢复、运行时模板不持久化',async()=>{
  await bind('/api/restart');const original=await request('/api/restart');await settle();const url=page.url();
  await context.close();await launch();page=await context.newPage();await page.goto(url);
  const snapshot=await panel();expect(snapshot.bindings.find(b=>b.pathname==='/api/restart')?.enabled).toBe(true);
  const runtime=await page.evaluate(()=>new Promise<any>(resolve=>{const id=crypto.randomUUID();const listener=(e:MessageEvent)=>{if(e.data?.id===id&&e.data.direction==='command-result'){window.removeEventListener('message',listener);resolve(e.data.data);}};window.addEventListener('message',listener);window.postMessage({channel:'API_CACHE_REPLAY_V1',direction:'command',id,type:'RUNTIME_LIST',payload:{}},location.origin);}));expect(runtime).toEqual([]);
  expect(await request('/api/restart')).toEqual(original);await settle();expect(await count('/api/restart')).toBe(1);
});
test('B01 自动识别并采用实际 API 范围，轮询与查看不增加业务请求',async()=>{
  const discoveredOrigin='http://127.0.0.1:4175';
  const saved:SiteConfig=await admin('SITE_SAVE',{site:{origin:discoveredOrigin}});
  const discovery=():Promise<ApiScopeDiscoveryState>=>admin('API_SCOPES_GET',{siteId:saved.id});
  try {
    await page.goto(`${discoveredOrigin}/scope-discovery`);
    await expect(page.locator('button.floating')).toBeVisible();
    expect(await discovery()).toEqual({siteId:saved.id,mode:'all',scopes:[]});
    const getURL='/backend/discovery-users?region=west#browser-fragment';
    const first=await request(getURL);await settle();
    expect(await request(getURL)).toEqual(first);await settle();
    expect(await count(getURL)).toBe(1);
    const afterHit=await discovery();
    expect(afterHit.scopes[0]).toMatchObject({siteId:saved.id,origin:discoveredOrigin,pathPrefix:'/backend',methods:['GET'],examples:['/backend/discovery-users'],endpointCount:1});
    const lastSeenAt=afterHit.scopes[0].lastSeenAt;
    await request('/backend/discovery-users?region=east');await settle();
    await request('/backend/discovery-orders?page=7');await settle();
    const post=()=>request('/backend/discovery-users?view=compact',{method:'POST',headers:{'content-type':'application/json'},body:'{"filter":"active"}'});
    const firstPost=await post();await settle();expect(await post()).toEqual(firstPost);await settle();expect(await count('/backend/discovery-users','POST')).toBe(1);
    const crossURL='http://127.0.0.1:4174/services/discovery-list?limit=20';
    const cross=await request(crossURL);await settle();expect(await request(crossURL)).toEqual(cross);await settle();expect(await count(crossURL)).toBe(1);
    expect((await panel()).site.generation).toBe(saved.generation);
    for(const endpoint of ['/backend/discovery-html?html=1','/backend/discovery-failure?status=500','/backend/discovery-invalid?invalidJson=1','/backend/login']) {
      const before=await count(endpoint);
      await request(endpoint);await settle();expect(await count(endpoint)).toBe(before+1);
    }
    const discovered=await discovery();expect(discovered.scopes).toHaveLength(2);
    const sameOrigin=discovered.scopes.find(scope=>scope.origin===discoveredOrigin)!;
    expect(sameOrigin).toMatchObject({pathPrefix:'/backend',endpointCount:3});
    expect(sameOrigin.methods).toEqual(expect.arrayContaining(['GET','POST']));
    expect(sameOrigin.lastSeenAt).toBeGreaterThanOrEqual(lastSeenAt);
    expect(discovered.scopes.find(scope=>scope.origin==='http://127.0.0.1:4174')).toMatchObject({pathPrefix:'/services',methods:['GET'],endpointCount:1});
    for(const scope of discovered.scopes) for(const example of scope.examples) {
      expect(example).toMatch(/^\/(?!\/)/);expect(example).not.toMatch(/[?#]|https?:|discovery-html|discovery-failure|discovery-invalid|\/login/);
    }
    expect((await panel()).scopeDiscovery).toEqual(discovered);

    const countsBeforeSettings=await(await settings.request.get(`${origin}/__counts`)).json();
    await settings.reload();await settings.bringToFront();
    await settings.locator('.site-item').filter({hasText:discoveredOrigin}).click();
    const scopeRegion=settings.getByRole('region',{name:'已自动识别的 API 范围'});
    await expect(scopeRegion.getByText('已自动采用',{exact:true})).toBeVisible();
    await expect(scopeRegion.locator('.scope-discovery-item')).toHaveCount(2);
    expect(await(await settings.request.get(`${origin}/__counts`)).json()).toEqual(countsBeforeSettings);
    await settings.locator('summary').filter({hasText:'高级设置'}).click();
    await settings.getByLabel('后端环境标识').fill('draft-not-saved');
    const late=await request('/backend/discovery-late');await settle();expect(await request('/backend/discovery-late')).toEqual(late);await settle();expect(await count('/backend/discovery-late')).toBe(1);
    // The settings window remains foreground; its real two-second poll must add
    // the newly observed endpoint without reloading the user's in-progress form.
    await expect(scopeRegion.getByText('4 个接口',{exact:true})).toBeVisible({timeout:7000});
    await expect(settings.getByLabel('后端环境标识')).toHaveValue('draft-not-saved');
    expect(await(await settings.request.get(`${origin}/__counts`)).json()).toEqual({...countsBeforeSettings,'GET /backend/discovery-late':1});
    expect((await admin('OPTIONS_GET')).sites.find((item:SiteConfig)=>item.id===saved.id).environmentId).toBe('local');
    await settings.locator('summary').filter({hasText:'高级设置'}).click();
    const countsBefore=await(await settings.request.get(`${origin}/__counts`)).json();
    await scopeRegion.locator('summary').first().click();
    await expect(scopeRegion.getByRole('button',{name:/确认|采用|应用|保存/})).toHaveCount(0);
    await settings.screenshot({path:'docs/verification/scopes-desktop.png',fullPage:true});
    await settings.setViewportSize({width:390,height:844});
    await settings.screenshot({path:'docs/verification/scopes-narrow.png',fullPage:true});
    await settings.setViewportSize({width:1280,height:900});
    await page.bringToFront();await page.locator('button.floating').click();
    await page.locator('summary[aria-label="查看 API 范围"]').click();
    const panelScopes=page.locator('details.scope-discovery');
    await expect(panelScopes.locator('.scope-discovery-item')).toHaveCount(2);
    await expect(panelScopes.getByRole('button',{name:/确认|采用|应用|保存/})).toHaveCount(0);
    await page.screenshot({path:'docs/verification/scopes-panel.png'});
    expect(await(await settings.request.get(`${origin}/__counts`)).json()).toEqual(countsBefore);

    const persisted=await discovery();
    const cdp=await context.newCDPSession(settings);
    try {
      const targets=await cdp.send('Target.getTargets');
      const target=targets.targetInfos.find((item:any)=>item.type==='service_worker'&&item.url.includes(extensionId));expect(target).toBeTruthy();
      await cdp.send('Target.closeTarget',{targetId:target!.targetId});
      expect(await discovery()).toEqual(persisted);
    } finally {await cdp.detach();}
    expect(await(await settings.request.get(`${origin}/__counts`)).json()).toEqual(countsBefore);
  } finally {
    await settings.setViewportSize({width:1280,height:900});
    await admin('SITE_DELETE',{siteId:saved.id});
  }
});
test('B02 手工 API 范围仍限制自动发现和缓存，不被自动采用扩大',async()=>{
  const customOrigin='http://127.0.0.1:4175';
  const configuredScopes=[{origin:customOrigin,pathPrefix:'/api/'}];
  const saved:SiteConfig=await admin('SITE_SAVE',{site:{origin:customOrigin,apiScopeMode:'custom',apiScopes:configuredScopes}});
  try {
    await page.goto(`${customOrigin}/scope-custom`);
    const included=await request('/api/discovery-custom-included');await settle();expect(await request('/api/discovery-custom-included')).toEqual(included);await settle();
    expect(await count('/api/discovery-custom-included')).toBe(1);
    for(let index=0;index<2;index++) {
      await request('/backend/discovery-custom-excluded');
      await request('http://127.0.0.1:4174/api/discovery-custom-cross-origin');
    }
    expect(await count('/backend/discovery-custom-excluded')).toBe(2);
    expect(await count('/api/discovery-custom-cross-origin')).toBe(2);
    const state:ApiScopeDiscoveryState=await admin('API_SCOPES_GET',{siteId:saved.id});
    expect(state).toMatchObject({siteId:saved.id,mode:'custom'});expect(state.scopes).toHaveLength(1);
    expect(state.scopes[0]).toMatchObject({origin:customOrigin,pathPrefix:'/api',methods:['GET'],examples:['/api/discovery-custom-included'],endpointCount:1});
    expect((await panel()).site).toMatchObject({apiScopeMode:'custom',apiScopes:configuredScopes,generation:saved.generation});
    await settings.reload();await settings.locator('.site-item').filter({hasText:customOrigin}).click();
    const region=settings.getByRole('region',{name:'已自动识别的 API 范围'});
    await expect(region.getByText('已限定范围',{exact:true})).toBeVisible();
    await expect(region.locator('.scope-discovery-item')).toHaveCount(1);
    await page.locator('button.floating').click();await page.locator('summary[aria-label="查看 API 范围"]').click();
    await expect(page.locator('details.scope-discovery')).toContainText('仅使用自定义范围，不会自动扩大');
  } finally {await admin('SITE_DELETE',{siteId:saved.id});}
});
test('C01 页面加载的用户信息和列表并行请求在连续刷新后命中，真正登录退出仍失效',async()=>{
  await admin('SITE_SAVE',{site:{...site,apiScopeMode:'all',apiScopes:[],identityMode:'auto'}});
  const loaded=()=>page.evaluate(async()=>await (window as any).fixtureLoad);
  const userPath='/api/login/userInfo',listPath='/api/simple-list';
  for(const scenario of ['user-first','list-first','parallel']) {
    const userBefore=await count(userPath,'POST'),listBefore=await count(listPath,'POST');
    await page.goto(`${origin}/reload-flow/${scenario}`);
    const first=await loaded();await settle();
    expect(first).toHaveLength(2);expect(first[0].path).toBe(userPath);expect(first[1].path).toBe(listPath);
    if(scenario!=='parallel') expect(await page.evaluate(()=>(window as any).fixtureCompleted[0])).toBe(scenario==='user-first'?'userInfo':'list');
    expect(await count(userPath,'POST')).toBe(userBefore+1);expect(await count(listPath,'POST')).toBe(listBefore+1);
    for(let reload=0;reload<2;reload++) {
      await page.reload();expect(await loaded()).toEqual(first);await settle();
      expect(await count(userPath,'POST')).toBe(userBefore+1);expect(await count(listPath,'POST')).toBe(listBefore+1);
      const snapshot=await panel();
      for(const pathname of [userPath,listPath]) {
        const binding=snapshot.bindings.find(item=>item.pathname===pathname&&item.method==='POST');
        expect(binding).toMatchObject({enabled:true,readOnly:true});expect(binding!.variants[0].lastStatus).toBe('HIT');
      }
    }
  }
  await page.locator('button.floating').click();
  const manifest=JSON.parse(await readFile('dist/manifest.json','utf8'));
  await expect(page.locator('.extension-version')).toHaveText(`v${manifest.version}`);
  await expect(settings.locator('.extension-version')).toHaveText(`v${manifest.version}`);
  await page.screenshot({path:'docs/verification/reload-panel.png'});
  await page.keyboard.press('Escape');
  for(const authPath of ['/api/login','/api/logout']) {
    const authBefore=await count(authPath,'POST'),userBefore=await count(userPath,'POST'),listBefore=await count(listPath,'POST');
    for(let repeat=0;repeat<2;repeat++) {await request(authPath,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});await settle();}
    expect(await count(authPath,'POST')).toBe(authBefore+2);
    await page.reload();const fresh=await loaded();await settle();
    expect(await count(userPath,'POST')).toBe(userBefore+1);expect(await count(listPath,'POST')).toBe(listBefore+1);
    await page.reload();expect(await loaded()).toEqual(fresh);await settle();
    expect(await count(userPath,'POST')).toBe(userBefore+1);expect(await count(listPath,'POST')).toBe(listBefore+1);
  }
});
test('C02 可见登录 Cookie 切换不串缓存，刷新和后台重启复用而浏览器重启重新录制',async()=>{
  await admin('SITE_SAVE',{site:{...site,apiScopeMode:'all',apiScopes:[],identityMode:'auto'}});
  const endpoint='/api/reload-identity-cookie';
  const setCookie=(account:string)=>page.evaluate(account=>{document.cookie=`fixture-account=${account}; Path=/; Max-Age=3600; SameSite=Lax`;},account);
  try {
    await setCookie('alice');
    const alice=await request(endpoint);await settle();expect(JSON.parse(alice.text).fixtureAccount).toBe('alice');
    expect(await request(endpoint)).toEqual(alice);await settle();expect(await count(endpoint)).toBe(1);
    await page.reload();expect(await request(endpoint)).toEqual(alice);await settle();expect(await count(endpoint)).toBe(1);
    await setCookie('bob');
    const bob=await request(endpoint);await settle();expect(JSON.parse(bob.text).fixtureAccount).toBe('bob');expect(bob).not.toEqual(alice);
    expect(await request(endpoint)).toEqual(bob);await settle();expect(await count(endpoint)).toBe(2);
    await page.reload();expect(await request(endpoint)).toEqual(bob);await settle();expect(await count(endpoint)).toBe(2);
    const sessionBefore=await settings.evaluate(async()=> (await chrome.storage.session.get('apiCacheReplayBrowserSessionId')).apiCacheReplayBrowserSessionId);
    expect(sessionBefore).toBeTruthy();
    await restartBackground();expect(await request(endpoint)).toEqual(bob);await settle();expect(await count(endpoint)).toBe(2);
    expect(await settings.evaluate(async()=> (await chrome.storage.session.get('apiCacheReplayBrowserSessionId')).apiCacheReplayBrowserSessionId)).toBe(sessionBefore);
    const url=page.url();await context.close();await launch();page=await context.newPage();await page.goto(url);
    const restarted=await request(endpoint);await settle();expect(JSON.parse(restarted.text).fixtureAccount).toBe('bob');expect(restarted).not.toEqual(bob);
    expect(await request(endpoint)).toEqual(restarted);await settle();expect(await count(endpoint)).toBe(3);
    expect(await settings.evaluate(async()=> (await chrome.storage.session.get('apiCacheReplayBrowserSessionId')).apiCacheReplayBrowserSessionId)).not.toBe(sessionBefore);
    const omitURL='/api/reload-identity-cookie-omit';
    const omitted=await request(omitURL,{credentials:'omit'});await settle();expect(JSON.parse(omitted.text).fixtureAccount).toBeNull();
    await setCookie('carol');expect(await request(omitURL,{credentials:'omit'})).toEqual(omitted);await settle();expect(await count(omitURL)).toBe(1);
    await page.reload();expect(await request(omitURL,{credentials:'omit'})).toEqual(omitted);await settle();expect(await count(omitURL)).toBe(1);
    const mixedURL='/api/reload-identity-credential-modes';
    const included=await request(mixedURL,{credentials:'include'});await settle();expect(JSON.parse(included.text).fixtureAccount).toBe('carol');
    const anonymous=await request(mixedURL,{credentials:'omit'});await settle();expect(JSON.parse(anonymous.text).fixtureAccount).toBeNull();
    for(let repeat=0;repeat<2;repeat++) {
      expect(await request(mixedURL,{credentials:'include'})).toEqual(included);await settle();
      expect(await request(mixedURL,{credentials:'omit'})).toEqual(anonymous);await settle();
    }
    expect(await count(mixedURL)).toBe(2);
  } finally {await context.clearCookies();}
});
test('C03 自定义凭证请求头按当前身份隔离，刷新与后台重启不丢失正确缓存',async()=>{
  await admin('SITE_SAVE',{site:{...site,apiScopeMode:'all',apiScopes:[],identityMode:'auto'}});
  for(const header of ['token','x-auth-token','api-key']) {
    const endpoint=`/api/reload-identity-${header}`;
    const call=(account:'alice'|'bob')=>request(endpoint,{headers:{[header]:`fixture-header-${account}`}});
    const alice=await call('alice');await settle();expect(JSON.parse(alice.text).fixtureIdentity).toBe('alice');
    expect(await call('alice')).toEqual(alice);await settle();expect(await count(endpoint)).toBe(1);
    await page.reload();expect(await call('alice')).toEqual(alice);await settle();expect(await count(endpoint)).toBe(1);
    const bob=await call('bob');await settle();expect(JSON.parse(bob.text).fixtureIdentity).toBe('bob');expect(bob).not.toEqual(alice);
    expect(await call('bob')).toEqual(bob);await settle();expect(await count(endpoint)).toBe(2);
    await restartBackground();expect(await call('bob')).toEqual(bob);await settle();expect(await count(endpoint)).toBe(2);
  }
  const combined=(token:string)=>request('/api/reload-identity-combined',{headers:{authorization:'Bearer fixture-header-alice',token}});
  const combinedAlice=await combined('fixture-header-alice');await settle();expect(await combined('fixture-header-alice')).toEqual(combinedAlice);await settle();
  const combinedBob=await combined('fixture-header-bob');await settle();expect(combinedBob).not.toEqual(combinedAlice);expect(await combined('fixture-header-bob')).toEqual(combinedBob);await settle();
  expect(await count('/api/reload-identity-combined')).toBe(2);
  const mixedURL='/api/reload-identity-optional-authorization';
  const withAuthorization=()=>request(mixedURL,{headers:{authorization:'Bearer fixture-header-alice'}});
  const authorized=await withAuthorization();await settle();expect(JSON.parse(authorized.text).fixtureIdentity).toBe('alice');
  const anonymous=await request(mixedURL);await settle();expect(JSON.parse(anonymous.text).fixtureIdentity).toBeNull();
  for(let repeat=0;repeat<2;repeat++) {
    expect(await withAuthorization()).toEqual(authorized);await settle();
    expect(await request(mixedURL)).toEqual(anonymous);await settle();
  }
  expect(await count(mixedURL)).toBe(2);
  const persisted=await settings.evaluate(async()=>{
    const open=indexedDB.open('api-cache-replay',1);
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
    try {
      const values=await Promise.all([...db.objectStoreNames].map(name=>new Promise<unknown>((resolve,reject)=>{const read=db.transaction(name).objectStore(name).getAll();read.onsuccess=()=>resolve(read.result);read.onerror=()=>reject(read.error);}))); 
      return JSON.stringify({values,storage:await chrome.storage.local.get(null),session:await chrome.storage.session.get(null)});
    } finally {db.close();}
  });
  expect(persisted).not.toContain('fixture-header-alice');expect(persisted).not.toContain('fixture-header-bob');
});
test('D01 折叠接口行一键强制缓存忽略动态参数，刷新和手动重发保留最新原始请求',async()=>{
  await admin('SITE_SAVE',{site:{...site,apiScopeMode:'all',apiScopes:[],identityMode:'auto'}});
  const endpoint='/api/force-cache-query';
  const id=await bind(endpoint,{ignoreQueryKeys:['trace'],ignoreBodyPointers:['/timestamp']},'POST');
  const before=await count(endpoint,'POST');
  const bodyFor=(value:number,timestamp=value)=>({events:[{type:'viewport',value}],time:value*1000,timestamp});
  const call=(filter:string,value:number,trace=`trace-${value}`,timestamp=value)=>request(`${endpoint}?${new URLSearchParams({filter,trace})}`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(bodyFor(value,timestamp)),
  });
  const ordinaryA=await call('first',1);await settle();
  const ordinaryB=await call('second',2);await settle();
  expect(ordinaryB).not.toEqual(ordinaryA);expect(await count(endpoint,'POST')).toBe(before+2);
  await page.locator('button.floating').click();
  const forceToggle=page.getByRole('button',{name:`${endpoint} 强制缓存`,exact:true});
  const statusBadge=page.locator('.endpoint-meta .status-badge');
  await expect(page.locator('.endpoint-detail')).toHaveCount(0);
  await expect(statusBadge).toContainText('MISS');
  await expect(forceToggle).toBeVisible();
  await expect(forceToggle).toHaveAttribute('aria-pressed','false');
  await forceToggle.click();
  await expect(forceToggle).toHaveAttribute('aria-pressed','true');
  await expect(forceToggle).toHaveText('强制缓存中');
  await expect(page.locator('.endpoint-detail')).toHaveCount(0);
  const enabled=(await panel()).bindings.find(item=>item.id===id)!;
  expect(enabled).toMatchObject({forceCache:true,ignoreQueryKeys:['trace'],ignoreBodyPointers:['/timestamp']});
  expect(enabled.variants.every(variant=>variant.cachedAt===undefined)).toBe(true);

  const recorded=await call('forced-first',3);await settle();
  await expect(statusBadge).toContainText('MISS');
  await expect(forceToggle).toBeVisible();
  expect(await call('changed-query',4)).toEqual(recorded);await settle();
  expect(await call('changed-again',5)).toEqual(recorded);await settle();
  expect(await count(endpoint,'POST')).toBe(before+3);
  await expect(statusBadge).toContainText('HIT');
  await expect(forceToggle).toHaveCount(0);
  expect((await panel()).bindings.find(item=>item.id===id)!.variants.some(variant=>variant.lastStatus==='HIT'&&variant.cachedAt!==undefined)).toBe(true);
  await page.reload();
  expect(await call('latest-before-manual',6,'current-trace',999)).toEqual(recorded);await settle();
  expect(await count(endpoint,'POST')).toBe(before+3);
  await page.locator('button.floating').click();
  await expect(forceToggle).toHaveCount(0);
  const replay=page.getByRole('button',{name:`重新请求 ${endpoint}`,exact:true});
  await expect(replay).toBeEnabled();await replay.click();
  await expect.poll(()=>count(endpoint,'POST')).toBe(before+4);await settle();
  await expect(statusBadge).toContainText('MISS');
  await expect(forceToggle).toBeVisible();
  const refreshed=await call('after-manual',7);await settle();
  expect(refreshed).not.toEqual(recorded);expect(await count(endpoint,'POST')).toBe(before+4);
  const refreshedData=JSON.parse(refreshed.text);
  expect(refreshedData.body).toEqual(bodyFor(6,999));
  expect(refreshedData.query).toEqual(expect.arrayContaining([['filter','latest-before-manual'],['trace','current-trace']]));
  await expect(page.locator('.endpoint-detail')).toHaveCount(0);
  await expect(page.locator('.endpoint-meta .status-badge')).toContainText('HIT');
  await page.screenshot({path:'docs/verification/force-cache-desktop.png'});
  await page.setViewportSize({width:390,height:700});
  await expect(forceToggle).toHaveCount(0);
  await page.screenshot({path:'docs/verification/force-cache-narrow.png'});
  await page.setViewportSize({width:1280,height:900});

  await replay.click(); await expect.poll(()=>count(endpoint,'POST')).toBe(before+5); await settle();
  await expect(forceToggle).toBeVisible();
  await forceToggle.click();await expect(forceToggle).toHaveAttribute('aria-pressed','false');
  await expect(page.locator('.endpoint-detail')).toHaveCount(0);
  const disabled=(await panel()).bindings.find(item=>item.id===id)!;
  expect(disabled).toMatchObject({forceCache:false,ignoreQueryKeys:['trace'],ignoreBodyPointers:['/timestamp']});
  const restored=await call('first',1);await settle();
  expect(restored).not.toEqual(ordinaryA);expect(await count(endpoint,'POST')).toBe(before+6);
  await expect(statusBadge).toContainText('MISS');
  await expect(forceToggle).toBeVisible();
  expect(await call('first',1,'ignored-query-change',123456)).toEqual(restored);await settle();expect(await count(endpoint,'POST')).toBe(before+6);
  await expect(statusBadge).toContainText('HIT');
  await expect(forceToggle).toHaveCount(0);
  await call('new-query',1);await settle();expect(await count(endpoint,'POST')).toBe(before+7);
  await call('new-query',8);await settle();expect(await count(endpoint,'POST')).toBe(before+8);
});
test('E01 真实请求区分首次、参数、过期、手动、清空和规则原因，命中不残留旧原因',async()=>{
  const baseline=await(await settings.request.get(`${origin}/__counts`)).json();
  const row=(pathname:string,method='GET')=>page.locator('article.endpoint').filter({has:page.getByRole('button',{name:`${method} ${pathname}`,exact:true})});
  const latest=async(pathname:string,method='GET')=>{
    const binding=(await panel()).bindings.find(item=>item.pathname===pathname&&item.method===method)!;
    expect(binding).toBeTruthy();
    return [...binding.variants].sort((a,b)=>Math.max(b.lastPageCallAt||0,b.lastNetworkAttemptAt||0)-Math.max(a.lastPageCallAt||0,a.lastNetworkAttemptAt||0))[0];
  };
  const networkCount=async(pathname:string,increment:number,method='GET')=>expect(await count(pathname,method)).toBe((baseline[`${method} ${pathname}`]||0)+increment);
  const reason=async(pathname:string,code:string,label:string,method='GET')=>{
    await settle();
    const variant=await latest(pathname,method);
    expect(variant.lastStatus).toBe(code==='CACHE_DISABLED'?'BYPASS':'MISS');
    expect(variant.networkReason).toMatchObject({code,label});
    const badge=row(pathname,method).locator('.network-reason');
    await expect(badge).toHaveText(code==='CLEARED' ? '已重新缓存' : label);
    await expect(badge).toHaveAttribute('data-reason-code',code);
    if(code==='CLEARED') await expect(badge).toHaveAttribute('title',/响应已成功写入缓存/);
    else await expect(badge).toHaveAttribute('title',variant.networkReason!.detail||label);
    return variant;
  };
  await page.locator('button.floating').click();
  const firstURL='/api/reason-hit';
  const first=await request(firstURL);await reason(firstURL,'FIRST_REQUEST','首次请求');await networkCount(firstURL,1);
  await expect(row(firstURL).locator('.force-cache-button')).toHaveCount(0);
  expect(await request(firstURL)).toEqual(first);await settle();
  expect((await latest(firstURL)).lastStatus).toBe('HIT');expect((await latest(firstURL)).networkReason).toBeUndefined();
  await expect(row(firstURL).locator('.network-reason')).toHaveCount(0);await networkCount(firstURL,1);
  await expect(row(firstURL).locator('.force-cache-button')).toHaveCount(0);

  const queryURL='/api/reason-query';
  await request(`${queryURL}?page=1`);await settle();await request(`${queryURL}?page=2`);
  await reason(queryURL,'QUERY_CHANGED','Query 参数已变化');await networkCount(queryURL,2);
  const bodyURL='/api/reason-body';
  const post=(url:string,body:unknown)=>request(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  await post(bodyURL,{events:[1],time:100});await settle();await post(bodyURL,{events:[2],time:200});
  await reason(bodyURL,'BODY_CHANGED','Body 参数已变化','POST');await networkCount(bodyURL,2,'POST');
  await row(bodyURL,'POST').getByRole('button',{name:`POST ${bodyURL}`,exact:true}).click();
  await expect(row(bodyURL,'POST').locator('.selected-network-reason')).toContainText('真实请求原因');
  await expect(row(bodyURL,'POST').locator('.selected-network-reason')).toContainText('Body 参数已变化');
  await row(bodyURL,'POST').getByRole('button',{name:`POST ${bodyURL}`,exact:true}).click();

  const expiryURL='/api/reason-expiry';
  await bind(expiryURL,{ttl:250});await request(`${expiryURL}?fixed=1`);await settle();
  const expiresAt=(await latest(expiryURL)).expiresAt!;expect(expiresAt).toBeGreaterThan(0);
  await expect.poll(()=>Date.now()).toBeGreaterThan(expiresAt);
  await request(`${expiryURL}?fixed=1`);await reason(expiryURL,'EXPIRED','缓存已过期');await networkCount(expiryURL,2);

  const manualURL='/api/reason-manual';
  await request(`${manualURL}?source=page`);await settle();
  const replay=row(manualURL).getByRole('button',{name:`重新请求 ${manualURL}`,exact:true});
  await expect(replay).toBeEnabled();await replay.click();
  await expect.poll(()=>count(manualURL)).toBe((baseline[`GET ${manualURL}`]||0)+2);
  await reason(manualURL,'MANUAL','手动重新请求');

  const clearURL='/api/reason-clear';
  await request(clearURL);await settle();
  const clearId=(await panel()).bindings.find(item=>item.pathname===clearURL)!.id;
  await rpc('CLEAR',{pageUrl:page.url(),bindingId:clearId});
  await request(clearURL);await reason(clearURL,'CLEARED','缓存已清空');await networkCount(clearURL,2);

  const forceURL='/api/reason-force';
  await post(`${forceURL}?event=1`,{events:[1]});
  await reason(forceURL,'FIRST_REQUEST','首次请求','POST');
  const forceToggle=row(forceURL,'POST').getByRole('button',{name:`${forceURL} 强制缓存`,exact:true});
  await expect(forceToggle).toHaveCount(0);
  await networkCount(forceURL,1,'POST');
  await post(`${forceURL}?event=changed`,{events:['changed']});
  await reason(forceURL,'PARAMETERS_CHANGED','请求参数已变化','POST');
  await expect(forceToggle).toBeVisible();
  await expect(forceToggle).toHaveAttribute('aria-pressed','false');
  await forceToggle.click();await expect(forceToggle).toHaveAttribute('aria-pressed','true');
  const forced=await post(`${forceURL}?event=2`,{events:[2]});
  await reason(forceURL,'FORCE_MODE_CHANGED','强制缓存模式已切换','POST');
  await expect(forceToggle).toBeVisible();
  expect(await post(`${forceURL}?event=3`,{events:[3]})).toEqual(forced);await settle();
  expect((await latest(forceURL,'POST')).networkReason).toBeUndefined();
  await expect(row(forceURL,'POST').locator('.network-reason')).toHaveCount(0);await networkCount(forceURL,3,'POST');
  await expect(row(forceURL,'POST').locator('.status-badge')).toContainText('HIT');
  await expect(forceToggle).toHaveCount(0);
  await row(forceURL,'POST').getByRole('button',{name:`重新请求 ${forceURL}`,exact:true}).click();
  await reason(forceURL,'MANUAL','手动重新请求','POST');
  await expect(forceToggle).toHaveAttribute('aria-pressed','true');
  await forceToggle.click();await expect(forceToggle).toHaveAttribute('aria-pressed','false');
  await post(`${forceURL}?event=4`,{events:[4]});await reason(forceURL,'FORCE_MODE_CHANGED','强制缓存模式已切换','POST');await networkCount(forceURL,5,'POST');
  await expect(forceToggle).toBeVisible();

  const disabledURL='/api/reason-disabled';
  await request(disabledURL);await settle();
  const disabledId=(await panel()).bindings.find(item=>item.pathname===disabledURL)!.id;
  await row(disabledURL).getByRole('switch',{name:`${disabledURL} 缓存开关`,exact:true}).click();
  await expect.poll(async()=>(await panel()).bindings.find(item=>item.id===disabledId)!.enabled).toBe(false);
  await request(disabledURL);const disabled=await reason(disabledURL,'CACHE_DISABLED','缓存开关已关闭');
  expect(disabled.networkReason!.detail).toContain('接口');expect(disabled.lastStatus).toBe('BYPASS');await networkCount(disabledURL,2);

  const rulesURL='/api/reason-rules';
  await request(`${rulesURL}?trace=one`);await settle();
  const rulesId=(await panel()).bindings.find(item=>item.pathname===rulesURL)!.id;
  await rpc('RULE_PATCH',{pageUrl:page.url(),bindingId:rulesId,patch:{ignoreQueryKeys:['trace']}});
  await request(`${rulesURL}?trace=one`);await reason(rulesURL,'RULES_CHANGED','缓存规则已修改');await networkCount(rulesURL,2);
  const initialURL='/api/reason-initial';
  await request(initialURL);await reason(initialURL,'FIRST_REQUEST','首次请求');await networkCount(initialURL,1);

  await expect(page.locator('.endpoint-detail')).toHaveCount(0);
  await page.setViewportSize({width:1280,height:1200});
  await page.locator('.endpoint-list').evaluate(element=>{element.scrollTop=0;});
  await page.screenshot({path:'docs/verification/network-reasons-desktop.png'});
  await page.setViewportSize({width:390,height:1000});
  await row(forceURL,'POST').scrollIntoViewIfNeeded();
  await page.screenshot({path:'docs/verification/network-reasons-narrow.png'});
  await page.setViewportSize({width:1280,height:900});
});
test('E02 关闭原因准确说明网站、本页或接口层级并优先于参数变化',async()=>{
  const endpoint='/api/reason-toggle-levels';
  const before=await count(endpoint);
  await request(`${endpoint}?step=initial`);await settle();
  const id=(await panel()).bindings.find(item=>item.pathname===endpoint)!.id;
  const newest=async()=> (await panel()).bindings.find(item=>item.id===id)!.variants.sort((a,b)=>(b.lastPageCallAt||0)-(a.lastPageCallAt||0))[0];
  const check=async(step:string,level:string,increment:number)=>{
    await request(`${endpoint}?step=${step}`);await settle();
    const variant=await newest();
    expect(variant.lastStatus).toBe('BYPASS');expect(variant.networkReason).toMatchObject({code:'CACHE_DISABLED',label:'缓存开关已关闭'});
    expect(variant.networkReason!.detail).toContain(level);expect(await count(endpoint)).toBe(before+increment);
  };
  try {
    await rpc('RULE_PATCH',{pageUrl:page.url(),bindingId:id,patch:{enabled:false}});
    await check('rule-off','接口',2);
    await rpc('PAGE_PATCH',{pageUrl:page.url(),patch:{cacheEnabled:false}});
    await check('page-off','本页',3);
    await rpc('SITE_PATCH',{patch:{cacheEnabled:false}});
    await check('site-off','网站',4);
  } finally {
    await rpc('SITE_PATCH',{patch:{cacheEnabled:true}});
    await rpc('PAGE_PATCH',{pageUrl:page.url(),patch:{cacheEnabled:true}});
    await rpc('RULE_PATCH',{pageUrl:page.url(),bindingId:id,patch:{enabled:true}});
  }
});
test('A20b Chrome IndexedDB 旧配置只迁移一次并清除全部旧正文',async()=>{
  const getId=await bind('/api/migration-cache');
  const postId=await bind('/api/migration-query',{},'POST');
  await request('/api/migration-cache');await settle();expect(await count('/api/migration-cache')).toBe(1);
  const url=page.url();
  await page.close(); // No content-script reads may race the legacy-state injection.
  await settings.getByRole('button',{name:'添加网站',exact:true}).click(); // An unsaved site has no discovery poll.
  await admin('OPTIONS_GET'); // Drain any already-started settings read before the seed.
  const seeded=await settings.evaluate(({getId,postId,siteId})=>new Promise<{bodyCount:number;siteGeneration:number;pageGeneration:number;ruleGeneration:number;pageId:string}>((resolve,reject)=>{
    const open=indexedDB.open('api-cache-replay',1);open.onerror=()=>reject(open.error);
    open.onsuccess=()=>{
      const db=open.result,transaction=db.transaction(['meta','bodies'],'readwrite');
      const meta=transaction.objectStore('meta'),bodies=transaction.objectStore('bodies');
      let result:{bodyCount:number;siteGeneration:number;pageGeneration:number;ruleGeneration:number;pageId:string};
      transaction.oncomplete=()=>{db.close();resolve(result);};
      transaction.onerror=()=>{db.close();reject(transaction.error);};
      transaction.onabort=()=>{db.close();reject(transaction.error??Error('Legacy seed aborted'));};
      const read=meta.get('state');
      read.onsuccess=()=>{
        const state=read.result as CacheState;
        const cached=Object.values(state.index).find(item=>item.bindingId===getId&&!item.preview);
        if(!cached){transaction.abort();return;}
        const pageId=state.rules[getId].pageId;
        result={bodyCount:0,siteGeneration:state.sites[siteId].generation,pageGeneration:state.pages[pageId].generation,ruleGeneration:state.rules[postId].generation,pageId};
        state.schemaVersion=1;
        for(const item of Object.values(state.sites)){item.cacheEnabled=false;item.identityMode='unconfigured';item.apiScopeMode='custom';}
        for(const item of Object.values(state.pages)) item.cacheEnabled=false;
        for(const item of Object.values(state.rules)){item.enabled=false;item.allowNoStore=false;if(item.method==='POST') item.readOnly=false;}
        state.rules[getId].alwaysBypass=true;
        const body=bodies.get(cached.key);
        body.onsuccess=()=>{
          if(!body.result){transaction.abort();return;}
          bodies.put(body.result,'legacy-orphan-without-index');
          const count=bodies.count();count.onsuccess=()=>{result.bodyCount=count.result;};
        };
        meta.put(state,'state');
      };
    };
  }),{getId,postId,siteId:site.id});
  expect(seeded.bodyCount).toBeGreaterThanOrEqual(2);
  const readDatabase=()=>settings.evaluate(()=>new Promise<{state:CacheState;keys:IDBValidKey[]}>((resolve,reject)=>{
    const open=indexedDB.open('api-cache-replay',1);open.onerror=()=>reject(open.error);
    open.onsuccess=()=>{
      const db=open.result,transaction=db.transaction(['meta','bodies']);
      const state=transaction.objectStore('meta').get('state'),keys=transaction.objectStore('bodies').getAllKeys();
      transaction.oncomplete=()=>{db.close();resolve({state:state.result,keys:keys.result});};
      transaction.onerror=()=>{db.close();reject(transaction.error);};
    };
  }));
  const legacy=await readDatabase();expect(legacy.state.schemaVersion).toBe(1);expect(legacy.keys).toContain('legacy-orphan-without-index');
  await admin('OPTIONS_GET');
  const migrated=await readDatabase(),state=migrated.state;
  expect(state.schemaVersion).toBe(2);expect(migrated.keys).toEqual([]);
  expect(state.sites[site.id]).toMatchObject({cacheEnabled:true,apiScopeMode:'all',identityMode:'auto',generation:seeded.siteGeneration+1});
  expect(state.pages[seeded.pageId]).toMatchObject({cacheEnabled:true,generation:seeded.pageGeneration+1});
  expect(state.rules[postId]).toMatchObject({enabled:true,readOnly:true,allowNoStore:true,generation:seeded.ruleGeneration+1});
  expect(state.rules[getId].alwaysBypass).toBe(true);
  expect(Object.values(state.pages).every(item=>item.cacheEnabled)).toBe(true);
  expect(Object.values(state.rules).every(item=>item.enabled&&item.allowNoStore)).toBe(true);
  for(const key of ['index','tickets','identities','successfulSequences'] as const) expect(state[key]).toEqual({});
  expect(Object.values(state.variants).every(item=>item.cachedAt===undefined&&item.expiresAt===undefined&&item.sizeBytes===undefined)).toBe(true);

  page=await context.newPage();await page.goto(url);await expect(page.locator('button.floating')).toBeVisible();
  const post=()=>request('/api/migration-query',{method:'POST',headers:{'content-type':'application/json'},body:'{"page":1}'});
  const first=await post();await settle();expect(await post()).toEqual(first);await settle();expect(await count('/api/migration-query','POST')).toBe(1);
  await request('/api/migration-cache');await settle();await request('/api/migration-cache');await settle();expect(await count('/api/migration-cache')).toBe(3);
  await rpc('SITE_PATCH',{patch:{cacheEnabled:false}});
  await rpc('PAGE_PATCH',{pageUrl:page.url(),patch:{cacheEnabled:false}});
  await rpc('RULE_PATCH',{pageUrl:page.url(),bindingId:postId,patch:{enabled:false,readOnly:false,allowNoStore:false}});
  const optedOut=await readDatabase();
  await admin('OPTIONS_GET');await panel();
  const reread=await readDatabase();
  expect(reread.state.schemaVersion).toBe(2);
  expect(reread.state.sites[site.id]).toEqual(optedOut.state.sites[site.id]);
  expect(reread.state.pages[seeded.pageId]).toEqual(optedOut.state.pages[seeded.pageId]);
  expect(reread.state.rules[postId]).toEqual(optedOut.state.rules[postId]);
  expect(reread.state.sites[site.id].cacheEnabled).toBe(false);
  expect(reread.state.pages[seeded.pageId].cacheEnabled).toBe(false);
  expect(reread.state.rules[postId]).toMatchObject({enabled:false,readOnly:false,allowNoStore:false});
});

test('F01 设置页存储统计、一键清理、在途隔离和重新录制', async () => {
  await admin('CACHE_CLEAR_ALL');
  const url='/api/storage-count';
  await request(url); await settle(); await request(url);
  await bind('/api/storage-preview', {enabled:false});
  await request('/api/storage-preview'); await settle();
  const before=await admin('STORAGE_GET');
  expect(before.cacheCount).toBe(1); expect(before.previewCount).toBe(1);
  expect(before.totalBytes).toBe(before.cacheBytes+before.previewBytes); expect(before.totalBytes).toBeGreaterThan(0);
  await expect(rpc('STORAGE_GET')).rejects.toThrow('扩展设置页');
  await expect(rpc('CACHE_CLEAR_ALL')).rejects.toThrow('扩展设置页');
  await settings.reload();
  const section=settings.getByRole('region',{name:'存储与缓存'});
  await expect(section.getByText(`1 份 ·`,{exact:false}).first()).toBeVisible();
  await expect(section.getByRole('meter')).toHaveAttribute('value',String(before.totalBytes));
  await expect(section.getByText(/约 .* (B|KiB|MiB)/)).toBeVisible();
  await settings.locator('summary').filter({hasText:'高级设置'}).click();
  await settings.getByLabel('后端环境标识').fill('unsaved-storage-test');
  await settings.locator('summary').filter({hasText:'高级设置'}).click();
  await mkdir('docs/verification',{recursive:true});
  await settings.screenshot({path:'docs/verification/storage-desktop.png',fullPage:true});
  await settings.setViewportSize({width:390,height:844});
  expect(await settings.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await settings.screenshot({path:'docs/verification/storage-narrow.png',fullPage:true});
  await settings.setViewportSize({width:1280,height:900});
  await page.evaluate(()=>{localStorage.setItem('storage-clear-control','keep');document.cookie='storage-clear-control=keep; path=/';});
  const savedSites=(await admin('OPTIONS_GET')).sites;
  const pending=request('/api/storage-pending?delay=2500');
  await expect.poll(async()=>(await admin('STORAGE_GET')).pendingCount).toBeGreaterThan(0);
  await section.getByRole('button',{name:'一键清理缓存',exact:true}).click();
  await expect(section.getByRole('status')).toContainText('已清理所有网站');
  await expect(section.getByTestId('storage-total')).toHaveText('0 B');
  await pending;
  expect(await admin('STORAGE_GET')).toMatchObject({totalBytes:0,cacheCount:0,previewCount:0,pendingCount:0,requestRecordCount:0});
  expect((await admin('OPTIONS_GET')).sites).toEqual(savedSites);
  expect(await page.evaluate(()=>[localStorage.getItem('storage-clear-control'),document.cookie.includes('storage-clear-control=keep')])).toEqual(['keep',true]);
  expect((await panel()).bindings.find(b=>b.pathname==='/api/storage-preview')?.enabled).toBe(false);
  await settings.locator('summary').filter({hasText:'高级设置'}).click();
  await expect(settings.getByLabel('后端环境标识')).toHaveValue('unsaved-storage-test');
  await settings.locator('summary').filter({hasText:'高级设置'}).click();
  await expect(section.getByRole('button',{name:'一键清理缓存',exact:true})).toBeDisabled();
  await settings.screenshot({path:'docs/verification/storage-empty.png',fullPage:true});
  const networkBefore=await count(url);
  await request(url); await settle();
  expect((await panel()).bindings.find(b=>b.pathname===url)?.variants[0].networkReason?.code).toBe('CLEARED');
  await request(url); await settle(); expect(await count(url)).toBe(networkBefore+1);
  await restartBackground();
  expect((await admin('STORAGE_GET')).cacheCount).toBe(1);
  await section.getByRole('button',{name:'刷新统计',exact:true}).click();
  await expect(section.getByRole('meter')).not.toHaveAttribute('value','0');
});

test('F02 估算不可用、统计读取失败和清理失败均可恢复', async () => {
  await request('/api/storage-errors'); await settle();
  await settings.reload();
  const section=settings.getByRole('region',{name:'存储与缓存'});
  await expect(section.getByRole('button',{name:'一键清理缓存',exact:true})).toBeEnabled();
  await settings.evaluate(()=>{
    const send=chrome.runtime.sendMessage.bind(chrome.runtime);
    (window as any).storageFailure='clear';
    (chrome.runtime as any).sendMessage=(message:any)=>{
      if(message.type==='CACHE_CLEAR_ALL'&&(window as any).storageFailure==='clear')return Promise.resolve({ok:false,error:'模拟事务失败'});
      if(message.type==='STORAGE_GET'&&(window as any).storageFailure==='read')return Promise.resolve({ok:false,error:'模拟统计失败'});
      return send(message);
    };
    navigator.storage.estimate=async()=>{throw Error('模拟估算不可用');};
  });
  await section.getByRole('button',{name:'一键清理缓存',exact:true}).click();
  await expect(section.getByRole('alert')).toContainText('缓存清理失败');
  await expect(section.getByText('暂不可用',{exact:true})).toBeVisible();
  await expect(section.getByRole('meter')).not.toHaveAttribute('value','0');
  await settings.evaluate(()=>{(window as any).storageFailure='read';});
  await section.getByRole('button',{name:'刷新统计',exact:true}).click();
  await expect(section.getByRole('alert').filter({hasText:'存储统计读取失败'})).toContainText('上次读取结果');
  await settings.evaluate(()=>{(window as any).storageFailure='';});
  await section.getByRole('button',{name:'一键清理缓存',exact:true}).click();
  await expect(section.getByRole('status')).toContainText('已清理所有网站');
  await expect(section.getByRole('alert')).toHaveCount(0);
  await expect(section.getByTestId('storage-total')).toHaveText('0 B');
  await settings.reload();
});

test('G01 清空后请求中、重新录制、命中与失败的提示动态更新', async () => {
  const endpoint='/api/clear-recording';
  const url=`${endpoint}?delay=650`;
  await request(url); await settle();
  await page.locator('button.floating').click();
  const row=page.locator('article.endpoint').filter({has:page.getByRole('button',{name:`GET ${endpoint}`,exact:true})});
  await page.getByRole('button',{name:'清空本页',exact:true}).click();
  await page.reload();
  await page.locator('button.floating').click();
  const recording=request(url);
  await expect(row.locator('.status-badge')).toContainText('PENDING');
  await expect(row.locator('.network-reason')).toHaveText('缓存已清空');
  await recording; await settle();
  await expect(row.locator('.status-badge')).toContainText('MISS');
  await expect(row.locator('.network-reason')).toHaveText('已重新缓存');
  await expect(row.locator('.network-reason')).toHaveAttribute('title',/因缓存清空.*响应已成功写入缓存/);
  await row.getByRole('button',{name:`GET ${endpoint}`,exact:true}).click();
  await expect(row.locator('.selected-network-reason')).toContainText('缓存状态');
  await expect(row.locator('.selected-network-reason')).toContainText('已重新缓存');
  await mkdir('docs/verification',{recursive:true});
  await page.screenshot({path:'docs/verification/clear-recorded.png'});
  const calls=await count(endpoint);
  await request(url); await settle();
  await expect(row.locator('.status-badge')).toContainText('HIT');
  await expect(row.locator('.network-reason')).toHaveCount(0);
  expect(await count(endpoint)).toBe(calls);

  await page.getByRole('button',{name:'清空本页',exact:true}).click();
  await request(`${endpoint}?status=500`); await settle();
  await expect(row.locator('.status-badge')).toContainText('ERROR');
  await expect(row.locator('.network-reason')).toHaveText('缓存已清空');
  await expect(row.getByText('已重新缓存',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'清空本页',exact:true}).click();
  await request(`${endpoint}?html=1`); await settle();
  await expect(row.locator('.status-badge')).toContainText('BYPASS');
  await expect(row.locator('.network-reason')).toHaveText('缓存已清空');
  await expect(row.getByText('已重新缓存',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'清空本页',exact:true}).click();
  await request(url); await settle();
  await expect(row.locator('.network-reason')).toHaveText('已重新缓存');
  await page.getByRole('button',{name:'清空本页',exact:true}).click();
  await expect(row.locator('.network-reason')).toHaveText('缓存已清空');
});
