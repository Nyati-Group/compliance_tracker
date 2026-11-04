// The plain-node HTTP layer that replaced Express: routing, bodies, cookies, rate limits, static files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, jsonBody, rawBody, rateLimit, securityHeaders, serveStatic, getCookie } from '../http.mjs';

async function serve(app, fn) {
  const server = app.listen(0);
  await new Promise((ok) => server.once('listening', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

test('routes match params, fall through on next(), and 404 otherwise', async () => {
  const app = createApp();
  app.delete('/api/:col/:id', (req, res, next) => (req.params.col === 'phases' ? res.json({ special: req.params.id }) : next()));
  app.delete('/api/:col/:id', (req, res) => res.json({ generic: req.params.col, id: req.params.id }));
  app.get('/api/:col', (req, res) => res.json({ col: req.params.col, q: req.query }));
  await serve(app, async (b) => {
    assert.deepEqual(await (await fetch(`${b}/api/phases/p%201`, { method: 'DELETE' })).json(), { special: 'p 1' });
    assert.deepEqual(await (await fetch(`${b}/api/tracking/x`, { method: 'DELETE' })).json(), { generic: 'tracking', id: 'x' });
    assert.deepEqual(await (await fetch(`${b}/api/audit?key=a&limit=5`)).json(), { col: 'audit', q: { key: 'a', limit: '5' } });
    const r = await fetch(`${b}/nope`);
    assert.equal(r.status, 404);
    assert.equal((await fetch(`${b}/api/audit/x/y`)).status, 404);
  });
});

test('async errors reach the error handler; status < 500 keeps its message', async () => {
  const app = createApp();
  app.get('/boom', async () => { throw Object.assign(new Error('nope'), { status: 400 }); });
  app.get('/crash', async () => { throw new Error('secret detail'); });
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.status < 500 ? err.message : 'server error' }));
  await serve(app, async (b) => {
    const r = await fetch(`${b}/boom`);
    assert.equal(r.status, 400); assert.deepEqual(await r.json(), { error: 'nope' });
    const c = await fetch(`${b}/crash`);
    assert.equal(c.status, 500); assert.deepEqual(await c.json(), { error: 'server error' });
  });
});

test('JSON bodies are parsed only for JSON requests; raw bodies honour the limit', async () => {
  const app = createApp();
  app.use(jsonBody({ limit: 50 }));
  app.post('/j', (req, res) => res.json({ body: req.body ?? null }));
  app.post('/raw', rawBody({ limit: 10, tooLarge: 'too big' }), (req, res) => res.json({ n: req.body.length }));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  await serve(app, async (b) => {
    const post = (p, body, type) => fetch(`${b}${p}`, { method: 'POST', headers: { 'Content-Type': type }, body });
    assert.deepEqual(await (await post('/j', '{"a":1}', 'application/json')).json(), { body: { a: 1 } });
    assert.deepEqual(await (await post('/j', 'a=1', 'text/plain')).json(), { body: null });
    assert.equal((await post('/j', '{bad', 'application/json')).status, 400);
    assert.equal((await post('/j', JSON.stringify({ x: 'y'.repeat(80) }), 'application/json')).status, 413);
    assert.deepEqual(await (await post('/raw', '12345', 'application/pdf')).json(), { n: 5 });
    const big = await post('/raw', '12345678901', 'application/pdf');
    assert.equal(big.status, 413); assert.deepEqual(await big.json(), { error: 'too big' });
  });
});

test('cookies are set, read back and cleared', async () => {
  const app = createApp();
  app.get('/set', (req, res) => res.cookie('sid', 'a b', { httpOnly: true, sameSite: 'strict', maxAge: 60_000 }).json({}));
  app.get('/read', (req, res) => res.json({ sid: getCookie(req, 'sid') }));
  app.get('/clear', (req, res) => res.clearCookie('sid', { httpOnly: true }).json({}));
  await serve(app, async (b) => {
    const c = (await fetch(`${b}/set`)).headers.get('set-cookie');
    assert.match(c, /^sid=a%20b; Path=\/; Max-Age=60; Expires=.+; HttpOnly; SameSite=Strict$/);
    assert.deepEqual(await (await fetch(`${b}/read`, { headers: { cookie: 'x=1; sid=a%20b' } })).json(), { sid: 'a b' });
    assert.match((await fetch(`${b}/clear`)).headers.get('set-cookie'), /^sid=; Path=\/; Expires=Thu, 01 Jan 1970/);
  });
});

test('rate limit answers 429 with the message once the window is used up', async () => {
  const app = createApp();
  app.post('/login', rateLimit({ windowMs: 60_000, limit: 2, message: { error: 'slow down' } }), (req, res) => res.json({ ok: true }));
  await serve(app, async (b) => {
    for (let i = 0; i < 2; i++) assert.equal((await fetch(`${b}/login`, { method: 'POST' })).status, 200);
    const r = await fetch(`${b}/login`, { method: 'POST' });
    assert.equal(r.status, 429); assert.deepEqual(await r.json(), { error: 'slow down' });
    assert.ok(Number(r.headers.get('retry-after')) > 0);
  });
});

test('static files are served under their prefix and paths cannot escape the folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-'));
  fs.writeFileSync(path.join(dir, 'a.json'), '{"ok":true}');
  fs.writeFileSync(path.join(path.dirname(dir), 'secret.txt'), 'x');
  const app = createApp();
  app.use(securityHeaders({ csp: { defaultSrc: ["'self'"] }, hsts: false }));
  app.use(serveStatic(dir, { prefix: '/data' }));
  await serve(app, async (b) => {
    const r = await fetch(`${b}/data/a.json`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(r.headers.get('content-security-policy'), "default-src 'self'");
    assert.deepEqual(await r.json(), { ok: true });
    assert.equal((await fetch(`${b}/data/..%2Fsecret.txt`)).status, 404);
    assert.equal((await fetch(`${b}/a.json`)).status, 404);
  });
});
