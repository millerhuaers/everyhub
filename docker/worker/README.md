# Docker 镜像加速 Worker

对应页面：`../index.html`（前端把 `https://docker.everyhub.top` 作为 registry mirror）。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v2/` | Registry 版本探测，固定返回 `{}` |
| GET/HEAD | `/v2/<repo>/manifests/<ref>` | manifest 透传（按 `Accept` 区分，缓存 5 分钟） |
| GET/HEAD | `/v2/<repo>/blobs/<digest>` | blob 透传（按 digest 缓存 24 小时） |
| GET | `/v2/<repo>/tags/list` | 标签列表 |
| GET | `/health` | 探活 |
| POST | `/__admin/purge` | 需 `Authorization: Bearer $ADMIN_TOKEN`，body `{"urls":["..."]}` |

`_` 会被当作 Docker Hub 官方命名空间 `library` 的别名（例如 `_/hello-world` → `library/hello-world`），与页面示例一致；也可直接写 `library/nginx`。

## 部署

```bash
cd E:\repo\everyhub\docker\worker
wrangler deploy          # 先出 *.workers.dev 验证
# 绑定 docker.everyhub.top 后取消 wrangler.toml 中 routes 注释再部署
```

## Secrets

```bash
wrangler secret put ADMIN_TOKEN            # 可选
wrangler secret put UPSTREAM_USERNAME      # 私有镜像才需要
wrangler secret put UPSTREAM_PASSWORD
```

> 配置了 `UPSTREAM_USERNAME` / `UPSTREAM_PASSWORD` 时，Worker 会自动关闭边缘缓存，避免私有镜像的 manifest/blob 被其他请求命中。匿名拉公共镜像不受影响。

## 绑定

无必需绑定。可选：`HUB_KV`（限流计数，`wrangler kv namespace create HUB_KV` 后填入 id）。

## 验收

```bash
curl -i https://<worker>/v2/
docker pull <worker-host>/library/nginx:latest
```
