/**
 * EveryHub · GHCR 镜像加速 Worker
 * 路由：/v2/*（Docker Registry V2 pull-through）
 *
 * 绑定：无必需绑定；可选 HUB_KV（限流计数）
 * Secrets：ADMIN_TOKEN（可选，管理接口）、UPSTREAM_USERNAME/UPSTREAM_PASSWORD（私有镜像可选）
 */
interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

interface Env {
  UPSTREAM_HOST: string;
  TOKEN_HOST: string;
  TOKEN_SERVICE: string;
  MANIFEST_TTL?: string;
  BLOB_TTL?: string;
  RATE_LIMIT_PER_MIN?: string;
  ADMIN_TOKEN?: string;
  UPSTREAM_USERNAME?: string;
  UPSTREAM_PASSWORD?: string;
  HUB_KV?: KVLike;
}

interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

const SERVICE = 'ghcr';
const WORKERS_HOST = 'ghcr.everyhub.top';
const HOME_PAGE_URL = 'https://everyhub.top/ghcr/index.html';
const ACCEPT_DEFAULT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/json',
].join(', ');

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
  'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'content-encoding',
]);

function edgeCache(): Cache {
  return (caches as unknown as { default: Cache }).default;
}

function requestId(req: Request): string {
  return req.headers.get('cf-ray') || Math.random().toString(16).slice(2);
}

function corsHeaders(methods: string): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': methods,
    'access-control-allow-headers': 'content-type, range, if-none-match, if-modified-since, accept',
    'access-control-expose-headers': 'content-length, content-range, accept-ranges, etag, last-modified, docker-content-digest, x-request-id',
    'access-control-max-age': '86400',
  };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

function withHeaders(res: Response, extra: Record<string, string>): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function errorResponse(status: number, code: string, req: Request): Response {
  return json({ error: code, requestId: requestId(req) }, status, corsHeaders('GET, HEAD, OPTIONS'));
}

function sanitizeHeaders(src: Headers): Headers {
  const out = new Headers();
  src.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase()) && !key.toLowerCase().startsWith('access-control-')) {
      out.set(key, value);
    }
  });
  return out;
}

function fetchTimeout(input: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function rateLimited(req: Request, env: Env): Promise<boolean> {
  const kv = env.HUB_KV;
  if (!kv) return false;
  const limit = Math.max(1, parseInt(env.RATE_LIMIT_PER_MIN || '600', 10));
  const ip = req.headers.get('cf-connecting-ip') || 'unknown';
  const minute = Math.floor(Date.now() / 60000);
  const key = `rl:${SERVICE}:${minute}:${ip}`;
  const count = parseInt((await kv.get(key)) || '0', 10);
  if (count >= limit) return true;
  await kv.put(key, String(count + 1), { expirationTtl: 120 });
  return false;
}

async function admin(req: Request, env: Env, ctx: Ctx): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith('/__admin/')) return null;
  if (url.pathname !== '/__admin/purge' || req.method !== 'POST') return json({ error: 'not_found' }, 404);
  if (!env.ADMIN_TOKEN) return json({ error: 'admin_disabled' }, 503);
  if (req.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`) {
    return json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' });
  }
  let payload: { urls?: unknown } = {};
  try { payload = (await req.json()) as { urls?: unknown }; } catch { /* ignore */ }
  const urls = Array.isArray(payload.urls) ? payload.urls.filter((u): u is string => typeof u === 'string') : [];
  if (!urls.length) return json({ error: 'no_urls' }, 400);
  let purged = 0;
  for (const target of urls.slice(0, 50)) {
    try { if (await edgeCache().delete(new Request(target))) purged++; } catch { /* ignore */ }
  }
  return json({ ok: true, service: SERVICE, purged });
}

const tokenCache = new Map<string, { token: string; expires: number }>();

async function pullToken(env: Env, scope: string): Promise<string | null> {
  const now = Date.now();
  const cached = tokenCache.get(scope);
  if (cached && cached.expires > now) return cached.token;
  const url = new URL(`https://${env.TOKEN_HOST}/token`);
  url.searchParams.set('service', env.TOKEN_SERVICE);
  url.searchParams.set('scope', `repository:${scope}:pull`);
  const headers: Record<string, string> = {};
  if (env.UPSTREAM_USERNAME && env.UPSTREAM_PASSWORD) {
    headers.authorization = `Basic ${btoa(`${env.UPSTREAM_USERNAME}:${env.UPSTREAM_PASSWORD}`)}`;
  }
  try {
    const res = await fetchTimeout(url.toString(), { headers }, 15000);
    if (!res.ok) return null;
    const data = (await res.json()) as { token?: string; access_token?: string };
    const token = data.token || data.access_token || '';
    if (!token) return null;
    tokenCache.set(scope, { token, expires: now + 55000 });
    return token;
  } catch {
    return null;
  }
}

async function handle(req: Request, env: Env, ctx: Ctx): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === '/health' || url.pathname === '/__health') {
    return json({ ok: true, service: SERVICE, upstream: env.UPSTREAM_HOST, time: new Date().toISOString() });
  }
  if (url.pathname === '/' || url.pathname === '') {
    try {
      const homeRes = await fetchTimeout(HOME_PAGE_URL, { method: 'GET', headers: { 'user-agent': 'EveryHubRegistryProxy/1.0' } }, 15000);
      if (homeRes.ok) {
        const text = (await homeRes.text()).replace(/{workers_host}/g, WORKERS_HOST);
        return new Response(text, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300', ...corsHeaders('GET, HEAD, OPTIONS') },
        });
      }
    } catch { /* 首页回源失败则回退 JSON 清单 */ }
    return json({ service: `${SERVICE} registry proxy`, upstream: env.UPSTREAM_HOST, endpoints: ['/v2/'] });
  }
  if (url.pathname === '/token') {
    const tokenUrl = `https://${env.TOKEN_HOST}/token${url.search}`;
    const tokenHeaders = new Headers();
    for (const name of ['user-agent', 'accept', 'accept-language', 'accept-encoding']) {
      const value = req.headers.get(name);
      if (value) tokenHeaders.set(name, value);
    }
    if (env.UPSTREAM_USERNAME && env.UPSTREAM_PASSWORD) {
      tokenHeaders.set('authorization', `Basic ${btoa(`${env.UPSTREAM_USERNAME}:${env.UPSTREAM_PASSWORD}`)}`);
    }
    try {
      const tokenRes = await fetchTimeout(tokenUrl, { method: req.method, headers: tokenHeaders }, 15000);
      return withHeaders(new Response(req.method === 'HEAD' ? null : tokenRes.body, {
        status: tokenRes.status,
        statusText: tokenRes.statusText,
        headers: sanitizeHeaders(tokenRes.headers),
      }), corsHeaders('GET, HEAD, OPTIONS'));
    } catch {
      return errorResponse(502, 'upstream_unreachable', req);
    }
  }
  const adminRes = await admin(req, env, ctx);
  if (adminRes) return adminRes;

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders('GET, HEAD, OPTIONS') });
  if (req.method !== 'GET' && req.method !== 'HEAD') return errorResponse(405, 'method_not_allowed', req);

  if (url.pathname !== '/v2' && url.pathname !== '/v2/' && !url.pathname.startsWith('/v2/')) {
    return errorResponse(404, 'not_found', req);
  }
  if (await rateLimited(req, env)) {
    return json({ error: 'rate_limited' }, 429, { 'retry-after': '60', ...corsHeaders('GET, HEAD, OPTIONS') });
  }
  if (url.pathname === '/v2' || url.pathname === '/v2/') {
    return new Response('{}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'docker-distribution-api-version': 'registry/2.0',
        'cache-control': 'no-store',
        ...corsHeaders('GET, HEAD, OPTIONS'),
      },
    });
  }

  const matched = url.pathname.match(/^\/v2\/(.+)\/(manifests|blobs|tags)\/(.+)$/);
  if (!matched) return errorResponse(404, 'unsupported_path', req);
  const [, repo, kind, ref] = matched;
  if (!repo || repo.includes('..') || !kind || !ref) return errorResponse(400, 'invalid_path', req);

  const upstreamUrl = `https://${env.UPSTREAM_HOST}/v2/${repo}/${kind}/${ref}${url.search}`;
  const ttl = kind === 'blobs'
    ? parseInt(env.BLOB_TTL || '86400', 10)
    : parseInt(env.MANIFEST_TTL || '300', 10);

  const cacheKeyHeaders = new Headers();
  cacheKeyHeaders.set('accept', req.headers.get('accept') || ACCEPT_DEFAULT);
  const cacheKey = new Request(upstreamUrl, { method: 'GET', headers: cacheKeyHeaders });
  // 配置了上游凭据（私有镜像）时关闭边缘缓存，避免私有层被其他请求命中
  const cacheable = !(env.UPSTREAM_USERNAME && env.UPSTREAM_PASSWORD);
  if (req.method === 'GET' && cacheable) {
    const hit = await edgeCache().match(cacheKey);
    if (hit) return withHeaders(hit, { ...corsHeaders('GET, HEAD, OPTIONS'), 'x-request-id': requestId(req), 'x-cache': 'HIT' });
  }

  const headers = new Headers();
  for (const name of ['accept', 'range', 'if-none-match', 'if-modified-since']) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has('accept')) headers.set('accept', ACCEPT_DEFAULT);
  headers.set('user-agent', 'EveryHubRegistryProxy/1.0');
  const token = await pullToken(env, repo);
  if (token) headers.set('authorization', `Bearer ${token}`);

  let upstreamRes: Response;
  try {
    upstreamRes = await fetchTimeout(upstreamUrl, { method: req.method, headers, redirect: 'follow' }, 30000);
  } catch {
    return errorResponse(502, 'upstream_unreachable', req);
  }

  const outHeaders = sanitizeHeaders(upstreamRes.headers);
  // 把上游 401 的 realm 改回本 Worker，客户端才能访问到 /token
  const wwwAuth = outHeaders.get('www-authenticate');
  if (wwwAuth) {
    const upstreamRealm = `https://${env.TOKEN_HOST}`;
    outHeaders.set('www-authenticate', wwwAuth.split(upstreamRealm).join(`https://${WORKERS_HOST}`));
  }
  const out = new Response(req.method === 'HEAD' ? null : upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: outHeaders,
  });

  if (req.method === 'GET' && cacheable && upstreamRes.status === 200) {
    const cacheHeaders = new Headers(out.headers);
    cacheHeaders.set('cache-control', `public, max-age=${ttl}`);
    cacheHeaders.set('vary', 'accept, accept-encoding');
    const toCache = new Response(out.clone().body, { status: 200, headers: cacheHeaders });
    ctx.waitUntil(edgeCache().put(cacheKey, toCache));
  }

  return withHeaders(out, { ...corsHeaders('GET, HEAD, OPTIONS'), 'x-request-id': requestId(req), 'x-cache': 'MISS' });
}

export default {
  fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    return handle(req, env, ctx).catch((error) =>
      json({ error: 'internal_error', message: String(error), requestId: requestId(req) }, 500));
  },
};
