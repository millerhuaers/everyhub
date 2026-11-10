# Pixiv 图床 Worker

对应页面：`../index.html`（把 `i.pximg.net` 换成 `https://pixiv.everyhub.top`）。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/HEAD | `/img-original/*` | 原图 |
| GET/HEAD | `/img-master/*` | 大图 |
| GET/HEAD | `/c/*`、`/img/*`、`/common/*` | 其它资源 |
| GET | `/health` | 探活 |
| POST | `/__admin/purge` | `Bearer $ADMIN_TOKEN` |

上游固定 `i.pximg.net`，自动补 `Referer: https://www.pixiv.net/`（Pixiv 防盗链要求）；图片缓存 7 天，带版本段最长 30 天。

## 部署

```bash
cd E:\repo\everyhub\pixiv\worker
wrangler deploy
# 绑定 pixiv.everyhub.top 后取消 wrangler.toml 中 routes 注释再部署
```

## Secrets

```bash
wrangler secret put ADMIN_TOKEN   # 可选
```

## 注意

- 仅代理公开图片；不处理登录/Cookie。
- 上游可能对高频请求限速，建议配 `HUB_KV` 限流。

## 验收

```bash
curl -I https://<worker>/img-original/img/2013/04/07/01/53/07/34844544_p0.jpg
```
