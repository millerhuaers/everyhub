# GitHub 加速 Worker

对应页面：`../index.html`（表单提交到 `https://git.everyhub.top/https://github.com/...`）。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/HEAD | `/https://github.com/...` | Release / Archive / Raw / Blob 透传 |
| GET/HEAD | `/https://raw.githubusercontent.com/...` | 原始文件 |
| GET/HEAD | `/https://codeload.github.com/...` | 源码包 |
| GET/HEAD | `/<owner>/<repo>/releases/download/...` | 缺省补 `https://github.com/` |
| GET | `/health` | 探活 |
| POST | `/__admin/purge` | `Bearer $ADMIN_TOKEN` |

仅允许 GitHub 系域名（含 `objects.githubusercontent.com`、`release-assets.githubusercontent.com`），避免成为开放代理。支持 `Range` 断点续传与 `ETag/If-None-Match`；release 资产缓存 7 天，其它 1 小时。

## 部署

```bash
cd E:\repo\everyhub\github\worker
wrangler deploy
# 绑定 git.everyhub.top 后取消 wrangler.toml 中 routes 注释再部署
```

## Secrets

```bash
wrangler secret put ADMIN_TOKEN   # 可选
```

## 前端需注意（未改动前端）

表单用 `location.href` 推导前缀，访问 `/github`（无尾斜杠）时会拼成 `https://host/<输入>`。
建议把前缀固定为 `https://git.everyhub.top/`，本 Worker 同时兼容两种形式。

## 验收

```bash
curl -I https://<worker>/https://github.com/cli/cli/releases/latest/download/gh_2.0.0_checksums.txt
curl -I https://<worker>/cli/cli/releases/download/v2.0.0/gh_2.0.0_checksums.txt
```
