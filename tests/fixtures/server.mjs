import http from 'node:http';
import { readFile } from 'node:fs/promises';

const counts = new Map();
const handler = async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, token, x-auth-token, api-key, x-tenant-id, x-language, x-csrf-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Cache-Control', 'no-cache, max-age=0');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (url.pathname === '/__counts') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(Object.fromEntries(counts))); return; }
  if (url.pathname === '/__reset') { counts.clear(); res.end('ok'); return; }
  if (url.pathname.startsWith('/reload-flow/')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(await readFile(new URL('./reload-flow.html', import.meta.url))); return;
  }
  if (!['/api/', '/backend/', '/services/'].some(prefix => url.pathname.startsWith(prefix))) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(await readFile(new URL('./index.html', import.meta.url))); return;
  }
  const key = `${req.method} ${url.pathname}`;
  const count = (counts.get(key) || 0) + 1;
  counts.set(key, count);
  let text = '';
  for await (const chunk of req) text += chunk;
  if (url.searchParams.get('delay')) await new Promise(r => setTimeout(r, Number(url.searchParams.get('delay'))));
  if (url.pathname.endsWith('/disconnect')) { res.destroy(); return; }
  const candidateStatus = Number(url.searchParams.get('status') || 200);
  const status = Number.isInteger(candidateStatus) && candidateStatus >= 200 && candidateStatus <= 599 ? candidateStatus : 200;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Fixture', 'api-cache-replay');
  if (url.searchParams.has('html')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><title>Fixture HTML</title><p>Not an API response</p>'); return; }
  if (url.searchParams.has('invalidJson')) { res.end('{invalid JSON'); return; }
  if (url.searchParams.has('noStore')) res.setHeader('Cache-Control', 'no-store');
  if (url.pathname.endsWith('/redirect')) { res.writeHead(302, { Location: '/api/users' }); res.end(); return; }
  let body;
  try { body = JSON.parse(text); } catch { body = text || null; }
  const result = { code: url.searchParams.get('businessError') ? 1 : 0, count, method: req.method,
    path: url.pathname, query: [...url.searchParams], body, tenant: req.headers['x-tenant-id'] || null,
    hasAuthorization: !!req.headers.authorization, cookie: !!req.headers.cookie };
  if (url.pathname.startsWith('/api/reload-identity-')) {
    const fixtureCookie = (req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith('fixture-account='))?.slice('fixture-account='.length);
    const credential = req.headers.authorization || req.headers.token || req.headers['x-auth-token'] || req.headers['api-key'];
    const fixtureAccounts = { 'fixture-header-alice': 'alice', 'fixture-header-bob': 'bob', 'Bearer fixture-header-alice': 'alice', 'Bearer fixture-header-bob': 'bob' };
    result.fixtureAccount = ['alice', 'bob', 'carol'].includes(fixtureCookie) ? fixtureCookie : null;
    result.fixtureIdentity = Object.hasOwn(fixtureAccounts, credential) ? fixtureAccounts[credential] : null;
  }
  if (url.searchParams.has('large')) result.large = 'x'.repeat(1100000);
  res.end(JSON.stringify(result));
};
for (const port of [4173, 4174, 4175]) http.createServer(handler).listen(port, '127.0.0.1', () => console.log(`Fixture http://127.0.0.1:${port}`));
