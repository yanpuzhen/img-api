# img-api

Cloudflare Worker 随机图片 API，数据来自 [Wallhaven](https://wallhaven.cc/)。默认只返回 SFW 图片，支持按关键词、分类、分辨率、比例、颜色和随机 seed 过滤。

## 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yanpuzhen/img-api)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fyanpuzhen%2Fimg-api)

Cloudflare Workers 是本项目的原生部署目标。Vercel 按钮会进入 Vercel 的仓库导入部署流程；如需 NSFW 图片，请在对应平台配置 `WALLHAVEN_API_KEY` 环境变量或密钥。

## API

```text
GET /random
GET /
GET /health
```

默认返回 JSON：

```bash
curl "https://<your-worker>/random?q=landscape&categories=111&purity=100"
```

常用参数：

| 参数 | 示例 | 说明 |
| --- | --- | --- |
| `q` | `mountain` | Wallhaven 搜索语法，最长 200 字符 |
| `categories` | `111` | 三位 bitmask：general/anime/people |
| `purity` | `100` | 三位 bitmask：sfw/sketchy/nsfw；NSFW 需要 Worker secret |
| `atleast` | `1920x1080` | 最小分辨率 |
| `resolutions` | `1920x1080,3840x2160` | 精确分辨率列表 |
| `ratios` | `16x9,21x9` | 屏幕比例列表 |
| `colors` | `0066cc` | 6 位十六进制颜色，允许带 `#` |
| `seed` | `abc123` | Wallhaven 随机 seed，配合 `page` 翻页避免重复 |
| `page` | `2` | 页码，范围 1-1000 |
| `count` | `3` | JSON 返回数量，范围 1-24 |
| `format` | `json` | `json`、`redirect`、`image`、`url` |

直接用于图片标签：

```html
<img src="https://<your-worker>/random?format=image&q=forest&purity=100" alt="Random wallpaper">
```

只想拿图片 URL：

```bash
curl "https://<your-worker>/random?format=url&q=city"
```

重定向到 Wallhaven 原图：

```bash
curl -I "https://<your-worker>/random?format=redirect&q=space"
```

## 配置

`wrangler.jsonc` 默认配置：

```jsonc
{
  "vars": {
    "WALLHAVEN_DEFAULT_CATEGORIES": "111",
    "WALLHAVEN_DEFAULT_PURITY": "100"
  }
}
```

如需 NSFW 或使用 Wallhaven 账户设置/黑名单，通过 Worker secret 配置 API key：

```bash
npx wrangler secret put WALLHAVEN_API_KEY
```

不要把 `apikey` 作为客户端查询参数传入；Worker 会直接拒绝这类请求，避免 key 出现在 URL 和日志里。

## 开发

```bash
npm install
npm run dev
npm test
npm run typecheck
```

部署：

```bash
npm run deploy
```
