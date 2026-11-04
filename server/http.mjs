// A small HTTP layer on plain node:http: routing with :params, middleware chains, JSON/raw bodies, cookies,
// static files, per-key rate limits and security headers. It keeps the req/res shape the route modules are written
// against (req.params, req.query, req.body, res.status().json(), ...), so the app is a plain (req, res) handler that
// works with http.createServer and as a Vercel serverless function alike.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const httpError = (status, message, type) => Object.assign(new Error(message), { status, type });

// Vercel's runtime defines lazy req.body / req.query getters; replace them with plain values.
const setProp = (obj, key, value) => Object.defineProperty(obj, key, { value, writable: true, configurable: true, enumerable: true });

/* ----------------------------- routing ----------------------------- */
function compile(pattern, prefix) {
  if (pattern === '*') return { re: /^.*$/, keys: [] };
  const keys = [];
  const src = pattern.replace(/\/$/, '').split('/').map((seg) => {
    if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { re: new RegExp(`^${src}${prefix ? '(?:/.*)?' : '/?'}$`), keys };
}

export function createApp() {
  const layers = [];
  const settings = {};
  const app = (req, res) => handle(req, res);

  const add = (method, pattern, handlers, prefix = false) => {
    const { re, keys } = compile(pattern, prefix);
    for (const fn of handlers.flat()) layers.push({ method, re, keys, fn });
  };
  for (const m of ['get', 'post', 'put', 'patch', 'delete', 'all']) {
    app[m] = (pattern, ...handlers) => { add(m.toUpperCase(), pattern, handlers); return app; };
  }
  /** app.use(fn) runs for every request; app.use('/prefix', fn) for that path and below. */
  app.use = (...args) => { const pattern = typeof args[0] === 'string' ? args.shift() : '*'; add('USE', pattern, args, true); return app; };
  app.set = (k, v) => { settings[k] = v; return app; };
  app.listen = (port, cb) => http.createServer(app).listen(port, cb);

  function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    setProp(req, 'path', url.pathname);
    setProp(req, 'query', Object.fromEntries(url.searchParams));
    setProp(req, 'body', undefined);
    setProp(req, 'params', {});
    req.ip = clientIp(req, settings.trustProxy);
    req.is = (type) => isType(req, type);
    decorate(res);

    let i = 0;
    const next = (err) => {
      while (i < layers.length) {
        const l = layers[i++];
        if (!methodMatches(l.method, req.method)) continue;
        const m = l.re.exec(req.path);
        if (!m) continue;
        const isErrorHandler = l.fn.length === 4;
        if (err ? !isErrorHandler : isErrorHandler) continue;
        try { req.params = Object.fromEntries(l.keys.map((k, n) => [k, safeDecode(m[n + 1])])); }
        catch { return next(httpError(400, 'bad request')); }
        try {
          const out = err ? l.fn(err, req, res, next) : l.fn(req, res, next);
          if (out && typeof out.catch === 'function') out.catch(next);
        } catch (e) { next(e); }
        return;
      }
      // Nothing (left) handled it.
      if (res.headersSent) { if (err) res.destroy(); return; }
      if (err) { console.error(err); return res.status(err.status || 500).json({ error: err.status && err.status < 500 ? err.message : 'server error' }); }
      res.status(404).json({ error: 'not found' });
    };
    next();
  }
  return app;
}

const methodMatches = (layer, method) => layer === 'USE' || layer === 'ALL' || layer === method || (layer === 'GET' && method === 'HEAD');
const safeDecode = (s) => decodeURIComponent(s);

function clientIp(req, trust) {
  const direct = req.socket?.remoteAddress || '';
  if (!trust) return direct;
  const chain = [...String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean), direct];
  // A number = how many proxies in front of us to trust; anything else = trust them all.
  const hops = /^\d+$/.test(String(trust)) ? Number(trust) : chain.length - 1;
  return chain[Math.max(0, chain.length - 1 - hops)];
}

function isType(req, type) {
  const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!ct) return false;
  if (type === 'json') return /^application\/([\w.-]+\+)?json$/.test(ct);
  return ct === type;
}

/* ----------------------------- response helpers ----------------------------- */
function decorate(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => send(res, Buffer.from(JSON.stringify(obj)), 'application/json; charset=utf-8');
  res.send = (body) => (Buffer.isBuffer(body) ? send(res, body, 'application/octet-stream') : send(res, Buffer.from(String(body)), 'text/html; charset=utf-8'));
  res.redirect = (location) => { res.statusCode = 302; res.setHeader('Location', location); res.end(); return res; };
  res.cookie = (name, value, opts = {}) => appendCookie(res, serializeCookie(name, value, opts));
  res.clearCookie = (name, opts = {}) => appendCookie(res, serializeCookie(name, '', { ...opts, maxAge: undefined, expires: new Date(0) }));
  res.sendFile = (file, headers = {}) => sendFile(res, file, headers);
}

function send(res, buf, type) {
  if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', buf.length);
  res.end(res.req?.method === 'HEAD' ? undefined : buf);
  return res;
}

function serializeCookie(name, value, { maxAge, expires, path: p = '/', httpOnly, secure, sameSite } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${p}`];
  if (maxAge != null) { parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`); expires = new Date(Date.now() + maxAge); }
  if (expires) parts.push(`Expires=${expires.toUTCString()}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (sameSite) parts.push(`SameSite=${sameSite[0].toUpperCase()}${sameSite.slice(1).toLowerCase()}`);
  return parts.join('; ');
}
function appendCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, cookie) : cookie);
  return res;
}

export function getCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

/* ----------------------------- request bodies ----------------------------- */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > limit) { req.resume(); return reject(httpError(413, 'request entity too large', 'entity.too.large')); }
    const chunks = []; let size = 0, done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) { done = true; req.resume(); return reject(httpError(413, 'request entity too large', 'entity.too.large')); }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}
const hasBody = (req) => req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length']) > 0;

/** Parses JSON bodies (only when the request says it is JSON) into req.body. */
export const jsonBody = ({ limit }) => async (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || !req.is('json') || !hasBody(req)) return next();
  const buf = await readBody(req, limit);
  try { req.body = buf.length ? JSON.parse(buf.toString('utf8')) : {}; }
  catch { throw httpError(400, 'The request body is not valid JSON.', 'entity.parse.failed'); }
  next();
};

/** Reads the whole body, whatever its type, into req.body as a Buffer. */
export const rawBody = ({ limit, tooLarge = 'request entity too large' }) => async (req, res, next) => {
  if (Buffer.isBuffer(req.body)) return next();
  try { req.body = await readBody(req, limit); }
  catch (e) { if (e.type === 'entity.too.large') return res.status(413).json({ error: tooLarge }); throw e; }
  next();
};

/* ----------------------------- rate limiting ----------------------------- */
/** Fixed-window counter per key, kept in memory (per process / per serverless instance). */
export function rateLimit({ windowMs, limit, key = (req) => req.ip, message }) {
  const hits = new Map();
  let sweepAt = Date.now() + windowMs;
  return (req, res, next) => {
    const now = Date.now();
    if (now > sweepAt) { for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); sweepAt = now + windowMs; }
    const k = String(key(req));
    let h = hits.get(k);
    if (!h || h.reset <= now) { h = { count: 0, reset: now + windowMs }; hits.set(k, h); }
    h.count++;
    const resetIn = Math.ceil((h.reset - now) / 1000);
    res.setHeader('RateLimit-Limit', limit);
    res.setHeader('RateLimit-Remaining', Math.max(0, limit - h.count));
    res.setHeader('RateLimit-Reset', resetIn);
    if (h.count > limit) { res.setHeader('Retry-After', resetIn); return res.status(429).json(message); }
    next();
  };
}

/* ----------------------------- security headers ----------------------------- */
export function securityHeaders({ csp, hsts }) {
  const policy = Object.entries(csp).map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())} ${v.join(' ')}`).join('; ');
  const fixed = {
    'Content-Security-Policy': policy,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Origin-Agent-Cluster': '?1',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-DNS-Prefetch-Control': 'off',
    'X-Download-Options': 'noopen',
    'X-Frame-Options': 'SAMEORIGIN',
    'X-Permitted-Cross-Domain-Policies': 'none',
    'X-XSS-Protection': '0',
    ...(hsts ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {})
  };
  return (req, res, next) => { for (const [k, v] of Object.entries(fixed)) res.setHeader(k, v); next(); };
}

/* ----------------------------- static files ----------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.pdf': 'application/pdf'
};

function sendFile(res, file, headers = {}) {
  return new Promise((resolve) => {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.status(404).json({ error: 'not found' }); return resolve(); }
      res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Content-Length', st.size);
      res.setHeader('Last-Modified', st.mtime.toUTCString());
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      if (res.req?.method === 'HEAD') { res.end(); return resolve(); }
      fs.createReadStream(file).on('error', () => res.destroy()).on('close', resolve).pipe(res);
    });
  });
}

/**
 * Serves files from `dir` for GET/HEAD requests under `prefix`. Unknown paths fall through to the next handler.
 * `headers(file)` adds per-file headers (e.g. caching).
 */
export function serveStatic(dir, { prefix = '', headers = () => ({}) } = {}) {
  const root = path.resolve(dir);
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (prefix && !req.path.startsWith(prefix + '/')) return next();
    let rel;
    try { rel = decodeURIComponent(req.path.slice(prefix.length)); } catch { return next(); }
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep) || rel.includes('\0')) return next();
    fs.stat(file, (err, st) => (err || !st.isFile() ? next() : sendFile(res, file, headers(file)).catch(next)));
  };
}
