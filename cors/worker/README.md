# CORS 跨域代理 Worker

对应页面：`../index.html`。页面文案里的用法是路径式前缀，Worker 完全兼容：

```
https://cors.everyhub.top/https://api.example.com/data.json
```

也支持查询式：`https://cors.everyhub.top/?url=<encodeURIComponent(目标地址)>`。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/HEAD/POST/PUT/PATCH/DELETE | `/https://<host>/<path>?<query>` | 路径式代理，`?` 后的查询串原样透传 |
| 同上 | `/?url=<encoded>` | 查询式代理 |
| OPTIONS | 任意 | 预检直接返回 204，不访问上游 |
| GET | `/health` | 探活 |
| POST | `/__admin/purge` | 清边缘缓存，`Bearer $ADMIN_TOKEN` |

错误码：`missing_target` / `invalid_url` / `unsupported_protocol` / `credentials_not_allowed` / `host_not_allowed` / `upstream_unreachable` / `response_too_large` / `rate_limited`。

## 安全策略

- 仅允许 `http` / `https`；`http://` 默认自动升级为 `https://`（`ALLOW_HTTP="true"` 可关闭）。
- 拒绝带账号密码的 URL；拒绝 `localhost`、`127.*`、`10.*`、`192.168.*`、`172.16-31.*`、`169.254.*`、`[::1]`、`[fc/fd/fe80]` 等内网/回环地址（SSRF 防护）。
- 可选 `ALLOWED_HOSTS` 白名单（逗号分隔域名后缀，如 `api.example.com,example.org`）；留空表示允许所有公网域名。
- 默认不透传 `Cookie`，响应里的 `Set-Cookie` / `Content-Encoding` / `Content-Length` 会被剥离。
- `Authorization` 默认透传，设 `FORWARD_AUTH="false"` 可关闭。
- 响应体上限 `MAX_BYTES`（默认 50MB），超限返回 413 或中途截断。
- 上游超时 30 秒。

## 绑定与变量

| 名称 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `ALLOWED_HOSTS` | var | 否 | 域名白名单，空 = 不限制 |
| `ALLOW_HTTP` | var | 否 | 默认 `"false"` |
| `FORWARD_AUTH` | var | 否 | 默认 `"true"` |
| `MAX_BYTES` | var | 否 | 默认 `"52428800"` |
| `CACHE_TTL` | var | 否 | 默认 `"0"`，动态接口不要开 |
| `RATE_LIMIT_PER_MIN` | var | 否 | 仅在绑定 KV 后生效 |
| `HUB_KV` | KV | 否 | 限流计数 |
| `ADMIN_TOKEN` | secret | 否 | 未设置时 `/__admin/purge` 返回 503 |

创建 KV 并填入 `wrangler.toml`：

```bash
wrangler kv namespace create HUB_KV
# 把输出的 id 填到 [[kv_namespaces]] 的 id，并取消该段注释
```

## 部署

```bash
cd E:\repo\everyhub\cors\worker
wrangler secret put ADMIN_TOKEN   # 可选
wrangler deploy
# 绑定 cors.everyhub.top 后，取消 wrangler.toml 中 routes 注释再次部署
```

## 验收

```bash
curl -i "https://<worker>/https://api.github.com/repos/cloudflare/workers-sdk"
curl -i -X OPTIONS "https://<worker>/https://api.github.com/" -H "Origin: https://everyhub.top" -H "Access-Control-Request-Method: GET"
curl -i "https://<worker>/http://example.com/"          # 应自动升级为 https
curl -i "https://<worker>/http://127.0.0.1/"            # 应返回 403 host_not_allowed
```

## 注意

- 这是开放代理，正式对外前建议配置 `ALLOWED_HOSTS`，并用 KV 开启限流，避免被滥用。
- 目标站点的 `Set-Cookie`、鉴权 Cookie 不会透传；需要带 Cookie 的接口不适合走此代理。
- 缓存默认关闭，`CACHE_TTL` 只建议给纯静态 JSON 接口使用。
