# Imgur 图床 Worker

对应页面：`../index.html`（把 `i.imgur.com` 换成 `https://imgur.everyhub.top`）。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/HEAD | `/<file>` | 例：`/cNLtIRP.jpeg`、`/<id>.png` |
| GET | `/health` | 探活 |
| POST | `/__admin/purge` | `Bearer $ADMIN_TOKEN` |

上游固定 `i.imgur.com`，不加 Referer；图片缓存 7 天。**不提供 `/a/<album>` 页面代理**（会返回 HTML，不适合作为图床）。

## 部署

```bash
cd E:\repo\everyhub\imgur\worker
wrangler deploy
# 绑定 imgur.everyhub.top 后取消 wrangler.toml 中 routes 注释再部署
```

## Secrets

```bash
wrangler secret put ADMIN_TOKEN   # 可选
```

## 注意

- Imgur 服务条款对程序化批量抓取有限制；本 Worker 只做单张图片透传，请勿用于批量采集。
- 删除的图片上游会返回 `removed.png`，属于内容侧问题，代理不额外处理。

## 验收

```bash
curl -I https://<worker>/cNLtIRP.jpeg
```
