# GHCR 镜像加速 Worker

对应页面：`../index.html`（前端把 `ghcr.io` 换成 `https://ghcr.everyhub.top`）。

## 接口

与 Docker Worker 完全一致：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v2/` | Registry 版本探测 |
| GET/HEAD | `/v2/<repo>/manifests/<ref>` | manifest 透传（缓存 5 分钟） |
| GET/HEAD | `/v2/<repo>/blobs/<digest>` | blob 透传（缓存 24 小时） |
| GET | `/v2/<repo>/tags/list` | 标签列表 |
| GET | `/health` | 探活 |
| POST | `/__admin/purge` | `Bearer $ADMIN_TOKEN` |

上游为 `ghcr.io`，匿名 token 来自 `https://ghcr.io/token`；私有镜像需 `UPSTREAM_USERNAME` / `UPSTREAM_PASSWORD`（GitHub PAT）。

## 部署

```bash
cd E:\repo\everyhub\ghcr\worker
wrangler deploy
# 绑定 ghcr.everyhub.top 后取消 wrangler.toml 中 routes 注释再部署
```

## Secrets

```bash
wrangler secret put ADMIN_TOKEN
wrangler secret put UPSTREAM_USERNAME   # 私有镜像可选
wrangler secret put UPSTREAM_PASSWORD
```

> 配置了 `UPSTREAM_USERNAME` / `UPSTREAM_PASSWORD` 时，Worker 会自动关闭边缘缓存，避免私有镜像的 manifest/blob 被其他请求命中。匿名拉公共镜像不受影响。

## 验收

```bash
curl -i https://<worker>/v2/
docker pull <worker-host>/<owner>/<image>:<tag>
```
