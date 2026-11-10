# JsDelivr 加速 Worker

对应页面：`../index.html`（把 `cdn.jsdelivr.net` 换成 `https://jsdelivr.everyhub.top`）。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/HEAD | `/gh/<user>/<repo>@<ver>/<file>` | GitHub 资源 |
| GET/HEAD | `/npm/<pkg>@<ver>/<file>` | npm 资源 |
| GET/HEAD | `/wp/<pkg>@<ver>/<file>` | WordPress 资源 |
| GET | `/health` | 探活 |
| POST | `/__admin/purge` | `Bearer $ADMIN_TOKEN` |

只允许上述三种前缀；带版本号/commit 的路径缓存 7 天，其余 1 小时。

## 部署

```bash
cd E:\repo\everyhub\jsdelivr\worker
wrangler deploy
# 绑定 jsdelivr.everyhub.top 后取消 wrangler.toml 中 routes 注释再部署
```

## Secrets

```bash
wrangler secret put ADMIN_TOKEN   # 可选
```

## 验收

```bash
curl -I https://<worker>/gh/jquery/jquery@3.7.1/dist/jquery.min.js
```
