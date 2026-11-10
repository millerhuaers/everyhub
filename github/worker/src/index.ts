/**
 * EveryHub · GitHub 文件加速 Worker
 * 对应页面：../index.html（表单拼出 https://git.everyhub.top/https://github.com/...）
 *
 * 支持：
 *   /https://github.com/<owner>/<repo>/...
 *   /https://raw.githubusercontent.com/...
 *   /https://codeload.github.com/...
 *   /<owner>/<repo>/releases/download/...   （缺省补 https://github.com/）
 *
 * 绑定：无必需绑定；可选 HUB_KV（限流计数）
 * Secrets：ADMIN_TOKEN（可选）
 */
interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

interface Env {
  RATE_LIMIT_PER_MIN?: string;
  ADMIN_TOKEN?: string;
  CACHE_TTL?: string;
  HUB_KV?: KVLike;
}

interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

const SERVICE = 'github';
const ALLOWED_HOSTS = new Set([
  'github.com', 'www.github.com', 'api.github.com',
  'raw.githubusercontent.com', 'gist.github.com', 'gist.githubusercontent.com',
  'codeload.github.com', 'objects.githubusercontent.com',
  'release-assets.githubusercontent.com', 'user-images.githubusercontent.com',
]);
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
  'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'content-encoding', 'set-cookie',
]);

function edgeCache(): Cache {
  return (caches as unknown as { default: Cache }).default;
}

function requestId(req: Request): string {
  return req.headers.get('cf-ray') || Math.random().toString(16).slice(2);
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'range, if-none-match, if-modified-since, accept',
  'access-control-expose-headers': 'content-length, content-range, accept-ranges, etag, last-modified, content-disposition, x-request-id',
  'access-control-max-age': '86400',
};

function withCors(res: Response, extra: Record<string, string> = {}): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries({ ...CORS, ...extra })) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function errorResponse(status: number, code: string, req: Request): Response {
  return json({ error: code, requestId: requestId(req) }, status, CORS);
}

function fetchTimeout(input: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function rateLimited(req: Request, env: Env): Promise<boolean> {
  const kv = env.HUB_KV;
  if (!kv) return false;
  const limit = Math.max(1, parseInt(env.RATE_LIMIT_PER_MIN || '240', 10));
  const ip = req.headers.get('cf-connecting-ip') || 'unknown';
  const minute = Math.floor(Date.now() / 60000);
  const key = `rl:${SERVICE}:${minute}:${ip}`;
  const count = parseInt((await kv.get(key)) || '0', 10);
  if (count >= limit) return true;
  await kv.put(key, String(count + 1), { expirationTtl: 120 });
  return false;
}

async function handle(req: Request, env: Env, ctx: Ctx): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === '/health' || url.pathname === '/__health') {
    return json({ ok: true, service: SERVICE, time: new Date().toISOString() });
  }
  if (url.pathname === '/' || url.pathname === '') {
    return json({ service: 'github download proxy', example: '/https://github.com/<owner>/<repo>/releases/download/<tag>/<file>' });
  }
  if (url.pathname === '/__admin/purge') {
    if (req.method !== 'POST') return errorResponse(405, 'method_not_allowed', req);
    if (!env.ADMIN_TOKEN) return json({ error: 'admin_disabled' }, 503);
    if (req.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: 'unauthorized' }, 401);
    let payload: { urls?: unknown } = {};
    try { payload = (await req.json()) as { urls?: unknown }; } catch { /* ignore */ }
    const urls = Array.isArray(payload.urls) ? payload.urls.filter((u): u is string => typeof u === 'string') : [];
    let purged = 0;
    for (const target of urls.slice(0, 50)) {
      try { if (await edgeCache().delete(new Request(target))) purged++; } catch { /* ignore */ }
    }
    return json({ ok: true, service: SERVICE, purged });
  }

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'GET' && req.method !== 'HEAD') return errorResponse(405, 'method_not_allowed', req);
  if (await rateLimited(req, env)) return json({ error: 'rate_limited' }, 429, { 'retry-after': '60', ...CORS });

  let rawTarget = '';
  try { rawTarget = decodeURIComponent(url.pathname.replace(/^\//, '')); } catch { return errorResponse(400, 'bad_path', req); }
  if (!rawTarget) return errorResponse(404, 'not_found', req);
  if (rawTarget.includes('..')) return errorResponse(400, 'bad_path', req);

  let target: URL;
  try {
    target = /^https?:\/\//i.test(rawTarget)
      ? new URL(rawTarget)
      : new URL(`https://github.com/${rawTarget}`);
  } catch {
    return errorResponse(400, 'bad_url', req);
  }
  if (!/^https?:$/.test(target.protocol)) return errorResponse(400, 'bad_scheme', req);
  if (target.username || target.password) return errorResponse(400, 'credentials_not_allowed', req);
  if (!ALLOWED_HOSTS.has(target.hostname.toLowerCase())) return errorResponse(403, 'host_not_allowed', req);

  // 表单以路径方式提交时，把非 q= 的查询串补回目标
  if (url.search && !url.search.startsWith('?q=')) target = new URL(target.toString() + url.search);

  const ttl = target.pathname.includes('/releases/download/')
    ? 604800
    : parseInt(env.CACHE_TTL || '3600', 10);
  const cacheKey = new Request(target.toString(), { method: 'GET' });
  if (req.method === 'GET') {
    const hit = await edgeCache().match(cacheKey);
    if (hit) return withCors(hit, { 'x-cache': 'HIT', 'x-request-id': requestId(req) });
  }

  const headers = new Headers();
  for (const name of ['range', 'if-none-match', 'if-modified-since', 'accept']) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('user-agent', 'EveryHubGitHubProxy/1.0');

  let upstream: Response;
  try {
    upstream = await fetchTimeout(target.toString(), { method: req.method, headers, redirect: 'follow' }, 30000);
  } catch {
    return errorResponse(502, 'upstream_unreachable', req);
  }

  const outHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase()) && !key.toLowerCase().startsWith('access-control-')) outHeaders.set(key, value);
  });
  const out = new Response(req.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });

  if (req.method === 'GET' && upstream.status === 200) {
    const cacheHeaders = new Headers(out.headers);
    cacheHeaders.set('cache-control', `public, max-age=${ttl}`);
    cacheHeaders.delete('vary');
    const copy = new Response(out.clone().body, { status: 200, headers: cacheHeaders });
    ctx.waitUntil(edgeCache().put(cacheKey, copy));
  }

  return withCors(out, { 'x-cache': 'MISS', 'x-request-id': requestId(req) });
}

export default {
  fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    return handle(req, env, ctx).catch((error) =>
      json({ error: 'internal_error', message: String(error), requestId: requestId(req) }, 500));
  },
};
