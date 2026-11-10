# 微博图床 Worker

对应页面：`../index.html`（把 `wx*.sinaimg.cn` 换成 `https://weibo.everyhub.top`）。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/HEAD | `/large/*`、`/mw690/*`、`/thumbnail/*`、`/original/*`、`/orj1080/*`、`/bmiddle/*` | 微博图片尺寸路径 |
| GET | `/health` | 探活 |
| POST | `/__admin/purge` | `Bearer $ADMIN_TOKEN` |

上游按 `wx1 → ww1 → tvax1 → wx2 → ww2 → tvax2 → …` 共 12 个 host 顺序回退，取第一个非 4xx/5xx 的响应；请求自动带 `Referer: https://weibo.com/`。图片缓存 7 天。

## 部署

```bash
cd E:\repo\everyhub\weibo\worker
wrangler deploy
# 绑定 weibo.everyhub.top 后取消 wrangler.toml 中 routes 注释再部署
```

## Secrets

```bash
wrangler secret put ADMIN_TOKEN   # 可选
```

## 验收

```bash
curl -I https://<worker>/large/006DuUBrly1iip797c302j30xi0k4wj8.jpg
```
