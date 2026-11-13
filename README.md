# EveryHub · Hub for Everything

静态导航站，聚合 DockerHub / GHCR / GitHub / JsDelivr 加速与 Pixiv / Imgur / 微博图片代理等服务文档页。

```
├── index.html        # 主页（服务导航卡片）
├── docker/           # DockerHub 镜像加速
├── ghcr/             # GHCR.IO 镜像加速
├── github/           # GitHub 文件加速（gh-proxy 工具页）
├── jsdelivr/         # JsDelivr CDN 加速
├── pixiv/            # Pixiv 图片代理
├── imgur/            # Imgur 图片代理
├── weibo/            # 微博图片代理
├── cors/             # CORS 跨域代理
├── moyu/             # 聆听卡密落地页
├── vercel.json       # Vercel 部署配置（缓存 / 安全响应头）
├── wrangler.toml     # Cloudflare Pages 部署配置
└── _headers          # Cloudflare Pages 响应头规则
```

纯静态站点，**无需任何构建步骤**，仓库根目录即部署目录。

---

## 部署到 Cloudflare Pages

### 方式一：Git 集成（推荐，推送自动部署）

1. 将本仓库推送到 GitHub / GitLab。
2. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**。
3. 选择仓库，构建配置如下：
   - Framework preset：`None`
   - Build command：留空
   - Build output directory：`/`
4. 保存并部署，得到 `*.pages.dev` 预览域名。

### 方式二：Wrangler CLI

```bash
npm install -g wrangler
wrangler login
wrangler pages deploy . --project-name everyhub
```

### 绑定域名

部署完成后：**项目 → Custom domains → Set up a custom domain**，添加 `everyhub.top`（按提示到 DNS 添加 CNAME 记录指向 `everyhub.pages.dev`）。

---

## 部署到 Vercel

### 方式一：Git 集成（推荐）

1. 打开 [Vercel Dashboard](https://vercel.com/new) → 导入本仓库。
2. 配置：
   - Framework Preset：`Other`
   - Build Command：留空
   - Output Directory：默认（`.`）
3. Deploy，得到 `*.vercel.app` 预览域名。

### 方式二：Vercel CLI

```bash
npm install -g vercel
vercel login
vercel --prod
```

### 绑定域名

**项目 → Settings → Domains**，添加 `everyhub.top`（按提示在 DNS 服务商处添加 CNAME/A 记录）。

---

## 备注

- 页面间跳转统一使用服务子域名（如 `docker.everyhub.top`、`cors.everyhub.top`），需要为每个服务绑定对应子域名。
- API（api.everyhub.top）与 iKMS（ikms.eu.org）为外部服务链接，不在本仓库内。
- Docker / GHCR 等加速服务本体为 Cloudflare Workers，独立部署，本仓库只承载其文档页。
