/**
 * EveryHub · CORS 跨域代理 Worker
 * 对应页面：../index.html
 *
 * 用法（与页面文案一致，路径式前缀）：
 *   https://cors.everyhub.top/https://api.example.com/data.json
 * 也可用查询式：
 *   https://cors.everyhub.top/?url=<encodeURIComponent(目标地址)>
 *
 * 安全边界：
 *   - 只允许 http/https；默认把 http:// 目标自动升级为 https://（ALLOW_HTTP=true 可关闭）
 *   - 拒绝带账号密码的 URL、拒绝内网/回环/链路本地地址（SSRF 防护）
 *   - 可选 ALLOWED_HOSTS 白名单（逗号分隔域名后缀），为空表示允许所有公网域名
 *   - 默认不透传 Cookie 与 Set-Cookie
 *   - 可选 MAX_BYTES 响应体上限（默认 50MB）
 *
 * 绑定：无必需绑定；可选 HUB_KV（限流计数）
 * Secrets：ADMIN_TOKEN（可选，保护 /__admin/purge）
 */
interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

interface Env {
  ALLOWED_HOSTS?: string;
  ALLOW_HTTP?: string;
  FORWARD_AUTH?: string;
  MAX_BYTES?: string;
  CACHE_TTL?: string;
  RATE_LIMIT_PER_MIN?: string;
  ADMIN_TOKEN?: string;
  HUB_KV?: KVLike;
}

interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

const SERVICE = 'cors';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
  'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'content-encoding', 'set-cookie',
]);

// 允许透传给上游的请求头（其余一律丢弃，避免把代理自身的头带进去）
const FORWARD_REQUEST_HEADERS = [
  'accept', 'accept-language', 'content-type', 'authorization', 'range',
  'if-none-match', 'if-modified-since', 'x-requested-with', 'user-agent',
];

const ALLOWED_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS';

// 常见的回环 / 内网 / 链路本地地址，Workers 内无法做 DNS 反查，只能拦字面量
const PRIVATE_HOSTS = [
  /^localhost$/,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
  /^\[::1\]$/,
  /^\[(fc|fd)[0-9a-f]{2}:/,
  /^\[fe80:/,
];

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

function edgeCache(): Cache {
  return (caches as unknown as { default: Cache }).default;
}

function requestId(req: Request): string {
  return req.headers.get('cf-ray') || Math.random().toString(16).slice(2);
}

function corsHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': ALLOWED_METHODS,
    'access-control-allow-headers':
      'accept, accept-language, authorization, content-type, range, if-none-match, if-modified-since, x-requested-with',
    'access-control-expose-headers':
      'content-length, content-range, accept-ranges, etag, last-modified, content-disposition, x-request-id',
    'access-control-max-age': '86400',
    ...extra,
  };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders(), ...extra },
  });
}

function errorResponse(status: number, code: string, req: Request, message?: string): Response {
  return json({ error: code, message, requestId: requestId(req) }, status);
}

function fetchTimeout(input: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function withCors(res: Response, extra: Record<string, string> = {}): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(extra))) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function limitBody(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      total += value.byteLength;
      if (total > max) {
        controller.error(new Error('response_too_large'));
        void reader.cancel();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
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

/** 从请求里解析目标地址：优先路径式 /https://...，其次 ?url= */
function extractTarget(url: URL): string | null {
  if (url.pathname.startsWith('/http://') || url.pathname.startsWith('/https://')) {
    return url.pathname.slice(1) + url.search;
  }
  const queryTarget = url.searchParams.get('url');
  if (queryTarget) return queryTarget;
  return null;
}

function validateTarget(raw: string, env: Env): { url: URL } | { error: string } {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return { error: 'invalid_url' };
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return { error: 'unsupported_protocol' };
  if (target.username || target.password) return { error: 'credentials_not_allowed' };
  if (target.protocol === 'http:' && env.ALLOW_HTTP !== 'true') target.protocol = 'https:';

  const host = target.hostname.toLowerCase();
  if (PRIVATE_HOSTS.some((re) => re.test(host))) return { error: 'host_not_allowed' };

  const allowlist = (env.ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length && !allowlist.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    return { error: 'host_not_allowed' };
  }
  return { url: target };
}

async function handle(req: Request, env: Env, ctx: Ctx): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === '/health' || url.pathname === '/__health') {
    return json({ ok: true, service: SERVICE, time: new Date().toISOString() });
  }
  if (url.pathname === '/' || url.pathname === '') {
    return json({
      service: `${SERVICE} proxy`,
      usage: [
        'GET /https://api.example.com/data.json',
        'GET /?url=<encodeURIComponent(target)>',
      ],
      methods: ALLOWED_METHODS,
    });
  }
  if (url.pathname === '/__admin/purge') {
    if (req.method !== 'POST') return errorResponse(405, 'method_not_allowed', req);
    if (!env.ADMIN_TOKEN) return json({ error: 'admin_disabled' }, 503);
    if (req.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: 'unauthorized' }, 401);
    let payload: { urls?: unknown } = {};
    try {
      payload = (await req.json()) as { urls?: unknown };
    } catch {
      /* ignore */
    }
    const urls = Array.isArray(payload.urls) ? payload.urls.filter((u): u is string => typeof u === 'string') : [];
    let purged = 0;
    for (const target of urls.slice(0, 50)) {
      try {
        if (await edgeCache().delete(new Request(target))) purged++;
      } catch {
        /* ignore */
      }
    }
    return json({ ok: true, service: SERVICE, purged });
  }

  // 浏览器预检：直接答复，不转发给上游
  if (req.method === 'OPTIONS') {
    const requested = req.headers.get('access-control-request-headers');
    return new Response(null, {
      status: 204,
      headers: corsHeaders(requested ? { 'access-control-allow-headers': requested } : {}),
    });
  }
  if (!ALLOWED_METHODS.split(', ').includes(req.method)) {
    return errorResponse(405, 'method_not_allowed', req);
  }
  if (await rateLimited(req, env)) return json({ error: 'rate_limited' }, 429, { 'retry-after': '60' });

  const rawTarget = extractTarget(url);
  if (!rawTarget) return errorResponse(400, 'missing_target', req, '用法：/https://api.example.com/data.json 或 ?url=');
  if (rawTarget.includes('..')) return errorResponse(400, 'bad_target', req);

  const checked = validateTarget(rawTarget, env);
  if ('error' in checked) return errorResponse(403, checked.error, req);
  const target = checked.url;

  const maxBytes = Math.max(1, parseInt(env.MAX_BYTES || String(DEFAULT_MAX_BYTES), 10));
  const ttl = Math.max(0, parseInt(env.CACHE_TTL || '0', 10));
  const cacheKey = new Request(target.toString(), { method: 'GET' });

  if (req.method === 'GET' && ttl > 0) {
    const hit = await edgeCache().match(cacheKey);
    if (hit) return withCors(hit, { 'x-cache': 'HIT', 'x-request-id': requestId(req) });
  }

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    if (name === 'authorization' && env.FORWARD_AUTH === 'false') continue;
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has('user-agent')) {
    headers.set(
      'user-agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    );
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  let upstream: Response;
  try {
    upstream = await fetchTimeout(
      target.toString(),
      { method: req.method, headers, body: hasBody ? req.body : undefined, redirect: 'follow' },
      30000,
    );
  } catch {
    return errorResponse(502, 'upstream_unreachable', req);
  }

  if (upstream.status !== 304 && upstream.status !== 204) {
    const declared = parseInt(upstream.headers.get('content-length') || '0', 10);
    if (declared && declared > maxBytes) {
      void upstream.body?.cancel();
      return errorResponse(413, 'response_too_large', req, `上限 ${maxBytes} 字节`);
    }
  }

  const outHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!HOP_BY_HOP.has(lower) && !lower.startsWith('access-control-')) outHeaders.set(key, value);
  });

  const hasResponseBody = req.method !== 'HEAD' && upstream.status !== 204 && upstream.status !== 304;
  const body = hasResponseBody && upstream.body ? limitBody(upstream.body, maxBytes) : null;
  const out = new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: outHeaders });

  if (req.method === 'GET' && ttl > 0 && upstream.status === 200) {
    const cacheHeaders = new Headers(out.headers);
    cacheHeaders.set('cache-control', `public, max-age=${ttl}`);
    const copy = new Response(out.clone().body, { status: 200, headers: cacheHeaders });
    ctx.waitUntil(edgeCache().put(cacheKey, copy));
  }

  return withCors(out, { 'x-cache': ttl > 0 ? 'MISS' : 'BYPASS', 'x-request-id': requestId(req) });
}

export default {
  fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    return handle(req, env, ctx).catch((error) =>
      json({ error: 'internal_error', message: String(error), requestId: requestId(req) }, 500),
    );
  },
};
