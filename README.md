# Quotify · 引语 API

> **Quotify**（取自 `quote`）是一个仿「一言（Hitokoto）」的引语 API 实现，中文名 **引语**。
> 功能定位参考一言（随机返回一条或多条引语），但原生接口约定自成一套，**并非** Hitokoto 的兼容实现。
> 需要零改动迁移既有 Hitokoto 客户端时，可用 `/v1/hitokoto` 兼容层（见「Hitokoto 兼容层」）。

运行在 **Cloudflare Workers** 上的生产级引语 API：随机返回引语，并支持分类 / 标签筛选与关键词搜索。
数据源不是数据库，而是 **一个或多个 `data.json`**（可配置多个不同来源，随机抽取时合并成一个总池）；
运行时通过 **Cloudflare KV 懒加载缓存**，所有筛选 / 搜索 / 随机操作在 Worker 内存中完成。
不使用 D1，不使用任何 Node.js 专有 API。

- 运行时：Cloudflare Workers（V8 Isolates）
- 语言：TypeScript（`strict: true`，禁用 `any`）
- 框架：Hono
- 数据源：默认由 `DATA_MANIFEST_URL` 指向的**来源清单**提供（改清单文件即可动态增减来源，**无需重新部署**），
  可另配 `DATA_SOURCES` 作静态兜底；每个来源独立缓存、独立容错
- 缓存：Cloudflare KV（每个来源各缓存一份，TTL 300 秒）
- 限流：Cloudflare Rate Limiting Binding（公开 60 次/分钟/IP，管理 10 次/分钟/IP，
  `/` 与 `/api/health` 300 次/分钟/IP）
- 测试：Vitest + `@cloudflare/vitest-pool-workers`（测试真实运行在 Workers 运行时中）
- 工程化：ESLint + Prettier + TypeScript 严格模式（含 `noUncheckedIndexedAccess`），CI 全量校验
- bundle：约 93 KiB（gzip 约 23 KiB），远低于 1 MB 上限

## 架构

```text
来源清单 sources.json（默认，DATA_MANIFEST_URL）
   │  ["url", "url", ...]（与 DATA_SOURCES 同格式）
   ▼
数据源 0..n（GitHub raw / 任意 HTTPS）
   │  data.json × n（每个来源格式相同）
   ▼
Cloudflare Worker (quotify-api)
   │  1. 进程内热缓存（与 DATA_TTL 对齐，避免每请求重复解析）—— 命中即返回
   │  2. 解析来源列表 = DATA_SOURCES + 清单（去重、截断到 20 个）
   │  3. 并发查各来源的 KV 缓存 (quotify:data:v1:<URL 指纹>)
   │  4. 未命中 / 过期 → 并发回源
   │     （5s 超时 + 边缘缓存 60s；携带 If-None-Match，304 则复用旧数据并续期）
   │  5. 校验 JSON → 各来源回写自己的 KV (TTL 300s) + meta（含来源 URL 与上游 ETag）
   │  6. 合并所有可用来源为一个总池（单个来源失败只跳过它，不拖垮整体）
   ▼
Cloudflare KV (quotify-cache)
   ▼
API 响应
```

> 热缓存以 isolate 为单位，只用于省掉「读 KV + 全量解析」，不承担一致性保证；
> 管理端 `/refresh` 会用「重新加载后的结果」**覆盖**当前 isolate 的副本。
> 热缓存 TTL 与 `DATA_TTL` 对齐（默认 300s），多 isolate 下数据最多陈旧一个 `DATA_TTL`。

## 目录结构

```text
quotify/
├── src/
│   ├── index.ts              # Worker 入口：安全头、CORS、根域重定向、健康检查、路由挂载、统一错误处理
│   ├── config.ts             # 常量、KV 键（URL 指纹）、来源列表解析、TTL 夹紧、重定向与来源白名单校验
│   ├── routes/
│   │   ├── quotes.ts         # 公开查询路由
│   │   ├── admin.ts          # 管理路由
│   │   └── compat.ts         # Hitokoto 兼容层（/v1/hitokoto：字段映射 + 分类码 + JSONP）
│   ├── data/
│   │   ├── loader.ts         # 多来源懒加载 / 合并 + 各来源独立 KV 与条件请求 + 数据校验
│   │   │                     # （含 single-flight 回源去重、失败重试、按 id 去重）
│   │   ├── store.ts          # 内存查询（filter / search / random / paginate）+ 派生索引记忆化
│   │   └── types.ts          # Quote / QuoteDataset 类型
│   ├── middleware/
│   │   ├── security.ts       # 通用安全响应头
│   │   ├── cors.ts           # CORS + OPTIONS 预检
│   │   ├── auth.ts           # 管理接口 Bearer 鉴权（恒定时间比较）
│   │   └── rateLimit.ts      # 速率限制（公开 / 管理 / 宽松三档）
│   ├── utils/
│   │   ├── response.ts       # 统一响应格式 + 缓存头 / 304 / ETag 宽松匹配
│   │   └── error.ts          # 错误类型 + 参数校验
│   └── types/
│       └── env.ts            # 应用面向的 Env 绑定视图（唯一契约）
├── tests/
│   ├── api.test.ts           # 端到端集成测试
│   ├── store.test.ts         # store 纯函数单测
│   ├── config.test.ts        # 配置解析与边界单测
│   ├── hardening.test.ts     # 安全 / 缓存 / 回源容错加固项
│   ├── compat.test.ts        # Hitokoto 兼容层
│   ├── data.test.ts          # 示例数据集校验
│   └── test-token.ts         # 测试用 ADMIN_TOKEN（与 vitest.config.ts 共用）
├── data/                     # 按分类拆分的数据集（film / internet / literature / philosophy / technology / wisdom）
├── scripts/
│   └── normalize-ids.mjs     # 数据集 id 规范化脚本（固定 8 位十六进制 + 全局去重 + 排序）
├── sources.json              # 来源清单（列出全部数据集文件地址）
├── .github/workflows/ci.yml  # CI：类型生成 + 依赖审计 + 风格 + 静态检查 + typecheck + test
├── .github/dependabot.yml    # 依赖自动升级
├── eslint.config.js / .prettierrc.json / .prettierignore
├── .dev.vars.example         # 本地开发密钥模板
├── wrangler.toml
├── vitest.config.ts
├── tsconfig.json
└── package.json
```

> `worker-configuration.d.ts` 由 `npm run cf-typegen` 生成、已在 `.gitignore` 中：
> 应用代码只依赖 `src/types/env.ts` 这份契约，避免生成物与配置漂移。

## 命名约定

项目只用两个词，各司其职，避免同一概念出现多种叫法：

| 层                  | 用词      | 示例                                                                  |
| :------------------ | :-------- | :-------------------------------------------------------------------- |
| 公开契约 + 数据模型 | `quote`   | `GET /api/quotes`、数据集字段 `quotes`、类型 `Quote` / `QuoteDataset` |
| 项目 / 品牌标识     | `quotify` | 包名 `quotify-api`、KV 键前缀 `quotify:`、`service: "quotify"`        |

公开接口、数据集字段与代码类型统一使用通用的 `quote`：

- **语义准确**：本 API 收录的是「有出处、有作者的引语」——诗词、骈文、戏剧台词、箴言、讲义摘句，
  正是 `quote` / `quotation` 的范畴，`Quotify` 这一项目名也正是由此而来。
- **契约友好**：路径与数据集字段是长期对外契约且最难变更，通用词对使用者更友好，
  也是这类 API 的通行叫法。

`Quotify` / `quotify` 只作为项目品牌保留在包名、KV 键前缀与服务标识中，不再出现在对外契约里。

> 中文名「**引语**」是 `quote` 的直译，仅用于对外称呼与文档表述，不参与任何标识符命名。

## API 文档

所有接口（含错误）统一返回：

```json
{ "status": 200, "message": "ok.", "data": {}, "ts": 1581759895072 }
```

状态码约定：`200` 成功 / `400` 参数错误 / `401` 未授权 / `404` 未找到 / `429` 限流 / `500` 服务器错误。

- 所有响应都带 `Access-Control-Allow-Origin: *`（含错误响应），以及安全头
  `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、
  `X-Frame-Options: DENY`、`Cross-Origin-Resource-Policy: cross-origin`。
- **除了**分类 / 标签这类内容稳定的派生接口，其余响应一律带 `Cache-Control: no-store`：
  随机接口一旦被中间代理缓存，所有用户就会看到同一条引语。
- 路径末尾的斜杠会被忽略：`/api/quotes` 与 `/api/quotes/` 等价（Hono 以 `strict: false` 启动）。
- 参数取值有长度与格式上限：`limit` / `offset` 只接受十进制整数（`0x10`、`1e3` 会被拒绝），
  `offset` 上限 10000，`q` / `category` / `tag` 单个取值上限 100 个字符。

### `GET /` — 根域自动重定向

直接访问根域（例如 `https://quotify-api.<your-subdomain>.workers.dev/`）会 **302** 跳转到
`/api/quotes/`，避免用户看到裸 404。跳转只改写路径、**保留原始查询串**，
因此 `/?limit=5&format=text` 等价于 `/api/quotes/?limit=5&format=text`。

- 目标可通过环境变量 `ROOT_REDIRECT` 配置（默认 `/api/quotes/`）。
- 出于安全考虑只接受站内绝对路径（以单个 `/` 开头），配置成外链等非法值会回退到默认值，避免开放重定向。
  反斜杠（`/\evil.com`）与控制字符同样被拒绝——浏览器会把 `\` 规范化成 `/`，从而绕过 `//` 检查。
- `HEAD /` 与 `GET /` 行为一致（Hono 会按 GET 处理并剥离响应体）。

### `GET /api/quotes` — 随机一言

| 参数       | 类型   | 默认   | 说明                                   |
| :--------- | :----- | :----- | :------------------------------------- |
| `category` | string | 无     | 分类，多个用逗号分隔（OR），最多 50 个 |
| `tag`      | string | 无     | 标签，多个用逗号分隔（OR），最多 50 个 |
| `limit`    | number | `1`    | 返回数量，1–20（超出上限收敛到 20）    |
| `format`   | string | `json` | `json` 或 `text`                       |

`data` 始终为数组。`format=text` 时直接返回纯文本 `content`（多条以换行分隔），
`Content-Type: text/plain; charset=utf-8`。
`category` / `tag` 的取值个数超过 50 个时返回 `400`。

### `GET /api/quotes/search` — 关键词搜索

| 参数       | 类型   | 默认     | 说明                  |
| :--------- | :----- | :------- | :-------------------- |
| `q`        | string | **必填** | 关键词，最少 1 个字符 |
| `category` | string | 无       | 分类过滤，最多 50 个  |
| `tag`      | string | 无       | 标签过滤，最多 50 个  |
| `limit`    | number | `10`     | 1–50                  |
| `offset`   | number | `0`      | 偏移量，≥ 0           |

在 `content` / `author` / `source` 中做**大小写不敏感**的子串匹配。
`category` 与 `tag` 之间是 **AND**，同一参数内多个值是 **OR**。

### `GET /api/quotes/categories` / `GET /api/quotes/tags`

返回去重、按拼音排序的字符串数组。

结果在同一数据集内稳定，因此响应带 `Cache-Control: public, max-age=<min(3600, DATA_TTL)>`（默认 `300`）
与 `ETag`；客户端带 `If-None-Match` 再次请求时返回 **304**（无正文），并同样带 CORS 与安全头。
缓存时长与数据集 TTL 取小，避免客户端缓存得比服务端刷新周期还久。

`ETag` 由**全量内容**哈希而来（而不是只看 `version` / `updated_at` / 条数），
因此维护者改了分类或标签、却没更新 `updated_at`，ETag 也会变化，不会一直返回过期目录。
`If-None-Match` 采用宽松匹配：容忍 `W/` 前缀差异、多值列表与代理追加的 `-gzip` 之类后缀。

### `GET /api/health` — 健康检查

只读缓存状态（优先命中热缓存，不触发回源）。`data.sources` 表示「已缓存来源数 / 配置来源总数」。

```json
{
  "status": 200,
  "message": "ok.",
  "data": {
    "service": "quotify",
    "environment": "production",
    "cached": true,
    "state": "warm",
    "manifest_cached": true,
    "cache_loaded_at": 1759000000000,
    "total": 1204,
    "sources": { "loaded": 2, "total": 2 }
  },
  "ts": 1759000000123
}
```

`state` 用于区分「还没加载过」与「真的出问题了」，避免监控误报：

| `state`    | 含义                                                    | 是否需要告警 |
| :--------- | :------------------------------------------------------ | :----------- |
| `warm`     | 所有来源都有可用缓存                                    | 否           |
| `degraded` | 部分来源加载失败（见 `/api/admin/stats` 的 `failures`） | 视情况       |
| `cold`     | 这个 isolate 还没加载过（冷启动时的正常状态）           | 否           |

> 真正需要告警的组合是 `state === "cold"` **且** `manifest_cached === true`：
> 说明来源已经枚举出来了，却一个都没加载成功。

### `POST /api/admin/refresh` — 强制刷新缓存（需鉴权）

对**每个来源**分别「重新拉取 → 校验通过后覆盖自己的 KV」（`put` 会重置值与 TTL）。**不会**先删键：
这样上游数据非法时该来源的缓存仍保留上一份合法数据，不会出现空缓存窗口。若配置了来源清单，清单也会一并刷新。

单个来源失败不影响其它来源：其结果记录在 `failures` 里，服务照常使用其余来源；只有**全部来源都失败**才返回 `500`。

若带上一次记录的上游 `ETag` 请求，上游返回 **304** 时直接复用缓存数据并仅续期 KV，
不重新下载与解析正文；此时 `total` 仍与当前数据集一致。

```json
{
  "status": 200,
  "message": "ok.",
  "data": {
    "refreshed": true,
    "total": 1204,
    "loaded_at": 1759000000000,
    "sources": [
      { "url": "https://.../a.json", "total": 600, "loaded_at": 1759000000000, "cached": false }
    ],
    "failures": [],
    "manifest": { "url": "https://.../sources.json", "count": 2, "error": null }
  },
  "ts": 1759000000123
}
```

### `GET /api/admin/stats` — 数据统计（需鉴权）

返回 `{ total, categories, tags, version, updated_at, cached, cache_loaded_at, sources, failures, manifest }`。
其中 `version` / `updated_at` 是各来源的**聚合值**（取较大者），按来源的明细在 `sources` 与 `failures` 中；
`manifest` 是清单状态 `{ url, count, error }`，未配置清单时为 `null`。来源出问题时先看这里。

鉴权方式：请求头 `Authorization: Bearer <ADMIN_TOKEN>`，Token 采用恒定时间比较。

## Hitokoto 兼容层

`GET /v1/hitokoto` 以 [Hitokoto](https://developer.hitokoto.cn/) 的契约返回**裸对象**（不套统一外壳），
便于既有的一言客户端零改动迁移。映射关系：

| Hitokoto 字段                          | 来源                                                           |
| :------------------------------------- | :------------------------------------------------------------- |
| `id`                                   | 由 `quote.id` 的 32 位指纹派生的**正整数**（稳定、不含 `0`）   |
| `uuid`                                 | `quote.id`（统一为 8 位小写十六进制）                          |
| `hitokoto`                             | `quote.content`                                                |
| `type`                                 | `quote.category` 映射到的分类码（未收录 → `g`）                |
| `from`                                 | `quote.source`；缺失时回退为 `未知出处`（不会是空串）          |
| `from_who`                             | `quote.author`；缺失时回退为 `佚名`（不会是空串）              |
| `creator` / `creator_uid` / `reviewer` | 固定为 `quotify` / `1` / `1`（数字，便于客户端渲染提交者信息） |
| `commit_from`                          | 固定 `api`                                                     |
| `created_at`                           | 数据集 `updated_at` 转换出的 **Unix 秒级时间戳字符串**         |
| `length`                               | `hitokoto` 的字符数（按 Unicode 码点计，emoji 算 1 个）        |

> 所有字段**始终有实际值**：不会出现 `null`、空串或 `NaN`。缺失的出处 / 作者使用中文占位，
> `created_at` 严格遵循官方契约的「时间戳字符串」格式（早期实现直接透传 ISO 时间，按整数解析会得到 `NaN`）。

分类码沿用 `a`–`l`：动画 `a`、漫画 `b`、游戏 `c`、文学 `d`、原创 `e`、网络 `f`、其他 `g`、
影视 `h`、诗词 `i`、网易云 `j`、哲学 `k`、抖机灵 `l`。
数据集中使用的中文别名会被归入最接近的码（`哲理` / `哲思` → `k`，`科技` / `科学` → `g`，
`古诗` → `i`，`电影` → `h` 等），未收录分类统一归到 `g`。

| 参数                        | 默认   | 说明                                                       |
| :-------------------------- | :----- | :--------------------------------------------------------- |
| `c`                         | 无     | 分类码（`a`–`l`），多个用逗号分隔（OR）                    |
| `encode`                    | `json` | `json` / `text` / `js`（JSONP）                            |
| `callback`                  | 无     | `encode=js` 时**必填**，必须是合法 JS 标识符（防脚本注入） |
| `min_length` / `max_length` | 无     | 按字符数过滤（与返回的 `length` 口径一致）                 |
| `charset`                   | 无     | 仅为兼容既有客户端而接受；响应始终为 UTF-8，建议省略       |

兼容层内部按分类码预分桶并记忆化长度，随机抽取不再复制整个数据集；
即使数据量增长，单次请求的过滤成本也只与命中分类的条目数相关。

```bash
curl "$BASE/v1/hitokoto?c=d&encode=json"
curl "$BASE/v1/hitokoto?encode=text"
curl "$BASE/v1/hitokoto?encode=js&callback=hitokoto_cb"
```

> 兼容层只做字段与参数映射，不改原生接口；`/` 的行为也不变（仍是 302 到 `/api/quotes/`，
> 与 `v1.hitokoto.cn` 直接返回 JSON 不同）。

## 数据仓库格式

数据集放在独立仓库 **`quotify-data`**：按 `category` 拆分到 `data/` 下的多个文件（注：为方便统一管理，现已合并进同一个项目仓库），
根目录的 `sources.json`（**来源清单**）列出这些文件的地址。

本项目的默认配置就是这样——`DATA_SOURCES` 留空、`DATA_MANIFEST_URL` 指向该清单，
所以**维护数据不需要重新部署 Worker**：新增一个分类只需在 `data/` 加文件并登记到 `sources.json`。

```text
quotify-data/
├── sources.json          # 来源清单（列出下面全部数据文件）
└── data/
    ├── internet.json     # 网络
    ├── literature.json   # 文学
    ├── technology.json   # 科技
    ├── philosophy.json   # 哲学
    ├── film.json         # 影视
    └── wisdom.json       # 哲理
```

每个数据文件都使用下面这同一种格式；运行时所有文件会被合并成一个总池，
随机抽取覆盖全部文件，搜索 / 分类 / 标签也跨文件聚合：

```json
{
  "version": 1,
  "updated_at": "2026-10-30T08:44:08Z",
  "quotes": [
    {
      "id": "3f8c1d7a",
      "content": "人生如逆旅，我亦是行人。",
      "source": "临江仙·送钱穆父",
      "author": "苏轼",
      "category": "文学",
      "tags": ["古诗", "人生"]
    }
  ]
}
```

校验规则（`src/data/loader.ts`）：

- `version` 必须是数字。
- `quotes` 必须是数组。
- 每条记录必须含非空字符串 `id` 与 `content`。
- `source` / `author` / `category` 可选，若存在必须是字符串；`tags` 可选，若存在必须是字符串数组。
- 非法数据直接返回 `500` 并记录日志，**不会**静默丢弃，也**不会**写入 KV。
- 多来源合并时按 `id` **去重**（保留靠前的来源），重复条目数记在 `/api/admin/stats` 的 `duplicates` 里。

本仓库 `data/` 下的 6 个分类文件就是线上数据的事实来源，**全部纳入 CI 校验**
（`npm run validate:data`，见 `tests/data.test.ts`）：除运行时校验外，还会检查
`id` 是否为 **8 位小写十六进制**、是否跨文件全局唯一、是否按升序排列。

### id 规范化脚本

```bash
npm run data:ids        # 重排 data/*.json 的 id（固定 8 位十六进制、全局去重、文件内升序）
npm run data:ids:check  # 只校验，未规范化时以非 0 退出（适合放进 CI / pre-commit）
```

id 由 `content + author + source` 的 FNV-1a 指纹派生：同一份数据重复执行结果完全一致，
改动正文才需要新 id；发生冲突时按确定性盐值继续派生，因此不会出现重复。
脚本仅在内容确实变化时回写文件，并同步更新该文件的 `updated_at`。

KV 键设计：

| 键                               | 值          | 说明                                                                                   |
| :------------------------------- | :---------- | :------------------------------------------------------------------------------------- |
| `quotify:data:v1:<URL 指纹>`     | JSON 字符串 | 该来源的数据集（指纹 = 来源 URL 的 FNV-1a 哈希）                                       |
| `quotify:meta:v1:<URL 指纹>`     | JSON 字符串 | `{ loaded_at, source_url, etag? }`；`source_url` 用于校验缓存归属，`etag` 用于条件请求 |
| `quotify:manifest:v1:<URL 指纹>` | JSON 字符串 | 来源清单缓存：`{ raw, loadedAt, etag }`（未配置清单时不产生）                          |

键后缀由**来源 URL** 派生而不是数组下标，因此增删 / 重排来源都不会让某个来源读到别人的缓存；
读取时还会比对 meta 里的 `source_url`，即使哈希碰撞也只会退化成一次「未命中 + 回源」。

## 环境变量

| 名称                  | 类型              | 默认                               | 说明                                                                                                                                     |
| :-------------------- | :---------------- | :--------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------- |
| `DATA_SOURCES`        | var               | `[]`（不配置静态来源）             | 数据集来源列表（**JSON 字符串数组**）。默认留空——来源全部由清单提供；需要静态兜底（清单不可用时仍有内容）时在此列出                      |
| `DATA_MANIFEST_URL`   | var               | 作者的 `quotify-data/sources.json` | **来源清单**地址（JSON 字符串数组），与 `DATA_SOURCES` 合并去重（上限 20）。改清单即可动态增减来源、**无需重新部署**；显式留空则关闭清单 |
| `DATA_TTL`            | var               | `300`                              | KV 缓存 TTL（秒）。会被夹紧到 `[60, 31536000]`：低于 60 会让 KV 写入直接抛错                                                             |
| `DATA_SOURCE_HOSTS`   | var               | `""`（不限制）                     | 来源主机白名单（逗号分隔）。配置后，**来源清单**里解析出的地址必须命中白名单才允许加载（防 SSRF / 清单被篡改）                           |
| `ROOT_REDIRECT`       | var               | `/api/quotes/`                     | 根路径 302 重定向目标（仅接受站内绝对路径）                                                                                              |
| `ENVIRONMENT`         | var               | `production`                       | 环境标识                                                                                                                                 |
| `ADMIN_TOKEN`         | **secret**        | **无默认值**                       | 管理接口 Token。未配置时管理接口直接 `500` 并打告警                                                                                      |
| `CACHE`               | KV binding        | —                                  | 缓存命名空间                                                                                                                             |
| `PUBLIC_RATE_LIMITER` | ratelimit binding | 60 / 60s                           | 公开接口限流                                                                                                                             |
| `ADMIN_RATE_LIMITER`  | ratelimit binding | 10 / 60s                           | 管理接口限流                                                                                                                             |
| `HEALTH_RATE_LIMITER` | ratelimit binding | 300 / 60s                          | `/` 与 `/api/health` 的宽松限流                                                                                                          |

生产环境必须执行 `npx wrangler secret put ADMIN_TOKEN`；本地开发请把
`ADMIN_TOKEN=...` 写进 `.dev.vars`（参考 `.dev.vars.example`，该文件已在 `.gitignore` 中）。

> `ADMIN_TOKEN` **刻意不再提供默认值**：遗漏 `wrangler secret put` 时，宁可让管理接口 500，
> 也不能带着一个公开已知的口令上线。

> 限流只以 `CF-Connecting-IP` 分桶。刻意**不**回退到 `x-forwarded-for`：
> 那是客户端完全可控的请求头，轮换它就能绕过限流。

> 关于 `compatibility_date`：规范要求 `2026-09-01`，但本地测试链路
> （`@cloudflare/vitest-pool-workers` 内置的 miniflare / workerd）当前最高支持 `2026-08-22`，
> 因此这里取 `2026-08-01`，保证 `dev` / `test` / `deploy` 三端行为一致。

## 本地开发

```bash
npm install

# 准备本地密钥（管理接口用；未配置时管理接口会 500）
cp .dev.vars.example .dev.vars

# 启动本地开发服务器（默认 http://127.0.0.1:8787）
npm run dev

# 需要真实数据时，把 DATA_SOURCES 指向一个可访问的地址，例如本地静态文件服务
node -e "const http=require('http'),fs=require('fs');http.createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(fs.readFileSync('data/film.json'))}).listen(8788)"
npx wrangler dev --var 'DATA_SOURCES:["http://127.0.0.1:8788/data.json"]'
```

其它脚本：

```bash
npm test              # vitest run，在 Workers 运行时中执行全部测试
npm run typecheck     # tsc --noEmit
npm run lint          # ESLint 静态检查（npm run lint:fix 自动修复）
npm run format        # Prettier 格式化（npm run format:check 只检查）
npm run validate:data # 校验 data/*.json（格式 + id 规范）
npm run data:ids      # 规范化 data/*.json 的 id（固定 8 位十六进制、全局去重、升序）
npm run data:ids:check # 只校验 id 是否已规范化
npm run cf-typegen    # 修改 wrangler.toml 后重新生成 worker-configuration.d.ts
```

> `worker-configuration.d.ts` 由 `wrangler types` 生成（包含 `KVNamespace`、`RateLimit` 等运行时类型
> 以及全局 `Env`），已在 `.gitignore` 中，修改 `wrangler.toml` 后需要重新生成。
> 业务代码只依赖 `src/types/env.ts` 这份契约，不直接使用生成的字面量类型。

## 自建部署教程（Fork 并托管自己的引语 API）

面向「Fork 一份、换成自己的数据集、部署到自己的 Cloudflare 账号」的场景。
下面每一步都对应 `wrangler.toml` 里的注释，照着改即可。

### 0. 前置条件

- 一个 Cloudflare 账号（Workers Free 计划即可）
- 已把本仓库 Fork 到你的 GitHub 账号并 clone 到本地
- 本地执行过 `npm install`（Wrangler 是项目依赖，统一用 `npx wrangler` 调用）
- 已执行 `npx wrangler login` 完成授权

### 1. 准备你自己的数据集

新建一个 GitHub 仓库（例如 `my-quotes-data`），在里面放数据集文件。
**推荐按 `category` 拆分**到一个子目录（如 `data/`），一个分类一个文件，格式见上文「数据仓库格式」——
**根字段必须是 `quotes`**，每条记录至少要有非空的 `id` 与 `content`。

可以直接参考本仓库 [data/film.json](data/film.json) 的**单文件**结构，
或按 `data/` 下的**按分类拆分**结构组织自己的数据。

> `wrangler.toml` 中 `DATA_SOURCES` 的注释写着「任意公网可访问、且返回符合本项目数据格式的 JSON 的链接都可以」——
> 也就是说数据集**不一定要放在 GitHub**，你自己的静态服务器 / 对象存储同样可行，只要 URL 公网可读。

### 2. 把来源指向你自己的数据集

**推荐：清单驱动（改文件即可，无需重新部署）**
在数据仓库根目录放一份 `sources.json`，列出各个数据文件的地址，再把 `DATA_MANIFEST_URL` 指向它：

```json
[
  "https://raw.githubusercontent.com/<你的用户名>/my-quotes-data/main/data/poetry.json",
  "https://raw.githubusercontent.com/<你的用户名>/my-quotes-data/main/data/sayings.json"
]
```

```toml
[vars]
DATA_SOURCES = '[]'   # 留空：不配置静态来源，来源全部来自清单
DATA_MANIFEST_URL = "https://raw.githubusercontent.com/<你的用户名>/my-quotes-data/main/sources.json"
```

**备选：静态来源（更直接，但改一次就要重新部署）**
把地址写进 `DATA_SOURCES`，并显式关闭清单：

```toml
[vars]
DATA_SOURCES = '["https://raw.githubusercontent.com/<你的用户名>/my-quotes-data/main/data/poetry.json"]'
DATA_MANIFEST_URL = ""
```

两种方式可以混用：`DATA_SOURCES` 与清单里的来源会**合并去重**（上限 20 个）。

> 对应注释：「Fork 后请换成你自己的仓库地址，**否则你改不动数据**」。保持默认值时，
> 你的实例会一直读取作者的数据集，自己改数据不会有任何效果。
>
> ⚠️ `DATA_SOURCES` 必须是**合法的 JSON 字符串数组**。写错时**不会**让接口直接 `500`：
> 静态来源被降级为空列表（错误打到日志），来源改由清单提供；
> 只有当清单也解析不出任何来源时，才会报 `500` 并提示「未解析到任何数据来源」。
> 这样一处配置笔误不会让整个 API 不可用。`DATA_MANIFEST_URL` 显式留空则关闭清单。

### 3. 创建你自己的 KV 命名空间

```bash
npx wrangler kv namespace create quotify-cache
```

命令会输出一个 `id`，用它覆盖 `wrangler.toml` 里 `[[kv_namespaces]].id`：

```toml
[[kv_namespaces]]
binding = "CACHE"
id = "<上一步输出的 id>"
```

> 对应注释：「下面的 id 属于本项目作者，Fork 后你无权访问，必须换成自己的」。
> KV 命名空间 id 本身是公开信息、不是密钥，但它绑定在作者账号下，你无法读写。

### 4. 设置管理接口 Token

`wrangler.toml` 里**没有** `ADMIN_TOKEN` 默认值（避免把公开已知的口令带上线），需要自己注入：

```bash
# 本地开发：写进 .dev.vars（已在 .gitignore 中）
cp .dev.vars.example .dev.vars   # 然后修改里面的 ADMIN_TOKEN

# 生产环境：用 secret
npx wrangler secret put ADMIN_TOKEN
```

> 未配置时管理接口（`/api/admin/*`）会直接返回 `500` 并在日志里告警——
> 这是刻意设计：`401` 会暴露「接口存在、只是口令不对」，`500` + 告警才是安全的失败方式。

### 5. 按需调整其它变量

| 变量                           | 是否必须改 | 说明                                                           |
| :----------------------------- | :--------- | :------------------------------------------------------------- |
| `ROOT_REDIRECT`                | 否         | 访问根域时的 302 目标，默认 `/api/quotes/`；只接受站内绝对路径 |
| `DATA_TTL`                     | 否         | KV 缓存 TTL（秒），默认 `300`；越界会被夹紧到 `[60, 31536000]` |
| `DATA_SOURCE_HOSTS`            | 建议       | 留空表示不限制主机；建议至少锁到你的数据托管域名               |
| `ENVIRONMENT`                  | 否         | 环境标识，会出现在 `/api/health` 响应中                        |
| `[[ratelimits]].namespace_id`  | 建议       | 见下方说明                                                     |
| `[[kv_namespaces]].preview_id` | 建议       | 见下方说明（否则 `wrangler dev --remote` 会读写生产 KV）       |

> 对应注释：「访问根域（`/`）时 302 跳转的目标（站内绝对路径），默认指向公开随机一言接口」。
>
> ⚠️ **限流绑定的 `namespace_id`** 是「账号内唯一」的标识：同一账号下若已有 Worker 用了相同的值，
> 两者会共享同一份限流计数。默认值已取较不常用的 `9101` / `9102` / `9103`，
> 若遇到意料之外的 429，把它们改成不冲突的数字。
>
> ⚠️ **`preview_id`** 缺省时 `wrangler dev --remote` 会直接读写生产 KV。
> 请执行 `npx wrangler kv namespace create quotify-cache-preview` 并把输出 id 填进去。

### 6. 部署

```bash
# 生产环境
npx wrangler deploy

# 预发布环境（用独立 KV，不会污染生产缓存）
npx wrangler deploy --env staging
```

部署完成后终端会输出形如 `https://quotify-api.<你的子域>.workers.dev` 的访问地址。

### 7. 首次预热与验证

```bash
BASE=https://quotify-api.<你的子域>.workers.dev

curl "$BASE/api/health"      # 首次：cached=false、total=0（KV 还是空的）
curl "$BASE/api/quotes"      # 触发首次回源，返回你自己的数据
curl "$BASE/api/health"      # 再次：cached=true、total 与你的数据集条数一致

# 主动刷新缓存（需要第 4 步设置的 Token）
curl -X POST -H "Authorization: Bearer <你的 ADMIN_TOKEN>" "$BASE/api/admin/refresh"
```

完整验收项见文末「生产验证清单」。

### 8. 日常维护

- **改引语内容**：编辑数据文件并提交，等 `DATA_TTL`（默认 300 秒）自动生效，或调一次 `POST /api/admin/refresh` 立即生效。
- **新增分类 / 数据文件**：在数据仓库新建 `<slug>.json`，把地址追加到 `sources.json`，提交即可——**不需要重新部署 Worker**。
- **新增来源仓库**：同上，把新仓库的数据文件地址登记进清单。
- **排查来源问题**：`GET /api/admin/stats` 的 `sources` / `failures` / `manifest` 会显示每个来源的状态与清单解析结果。

> 清单里的来源会与 `DATA_SOURCES` **合并**（去重后最多 20 个，超出部分丢弃并告警）。
> 清单不可用或内容格式非法时**不会影响服务**：自动降级为「只用 `DATA_SOURCES`」或「沿用上一份合法清单」，
> 具体原因可在 `/api/admin/stats` 的 `manifest.error` 中看到。

### 常见问题

- **访问根域 404？** 根域会自动 302 到 `/api/quotes/`；若你改过 `ROOT_REDIRECT`，确认它是站内绝对路径（以单个 `/` 开头）。
- **`/api/quotes` 一直返回 500？** 说明**所有来源**都加载失败了（单个来源失败只会被跳过）。常见原因是数据集格式不合规：
  根字段不是 `quotes`，或某条记录缺 `id` / `content`。校验不通过时不会写入缓存，日志里会指出是哪个来源、第几条、哪个字段。
- **某个来源挂了会有影响吗？** 不会：该来源被跳过，其余来源照常提供服务；`/api/admin/stats` 的 `failures` 里能看到具体原因和 URL。
- **管理接口返回 401？** 检查请求头为 `Authorization: Bearer <token>`，且 token 与 `ADMIN_TOKEN` 一致。
- **管理接口返回 500 并提示未配置 ADMIN_TOKEN？** 说明 `ADMIN_TOKEN` 没注入成功：
  本地请把 `ADMIN_TOKEN=...` 写进 `.dev.vars`，生产请执行 `npx wrangler secret put ADMIN_TOKEN`。
- **`/api/health` 一直是 `cold`？** 冷启动（或 isolate 刚被回收）时的正常状态，
  只要 `manifest_cached` 为 `false` 就只是「还没加载过」；若它已经是 `true` 却仍为 `cold`，
  再去 `/api/admin/stats` 看 `failures`。
- **改了 `wrangler.toml` 后类型报错？** 执行 `npm run cf-typegen` 重新生成 `worker-configuration.d.ts`。

## curl 调用示例清单

```bash
BASE=https://quotify-api.<your-subdomain>.workers.dev

# 根域自动重定向（302 → /api/quotes/）
curl -i "$BASE/"

# 健康检查
curl "$BASE/api/health"

# 随机一条
curl "$BASE/api/quotes"

# 随机 5 条
curl "$BASE/api/quotes?limit=5"

# 纯文本输出（可直接接入终端脚本）
curl "$BASE/api/quotes?format=text"

# 按分类筛选
curl "$BASE/api/quotes?category=文学"

# 按标签筛选（OR）
curl --get "$BASE/api/quotes" --data-urlencode "tag=古诗,人生"

# 分类 + 标签组合（AND）
curl --get "$BASE/api/quotes" --data-urlencode "category=文学" --data-urlencode "tag=人生" --data-urlencode "limit=3"

# 关键词搜索
curl --get "$BASE/api/quotes/search" --data-urlencode "q=人生"

# 搜索 + 分页
curl --get "$BASE/api/quotes/search" --data-urlencode "q=人" --data-urlencode "limit=5" --data-urlencode "offset=5"

# 分类 / 标签枚举
curl "$BASE/api/quotes/categories"
curl "$BASE/api/quotes/tags"

# Hitokoto 兼容层（裸对象 / 纯文本 / JSONP）
curl "$BASE/v1/hitokoto?c=d"
curl "$BASE/v1/hitokoto?encode=text"
curl "$BASE/v1/hitokoto?encode=js&callback=hitokoto_cb"

# 参数错误示例（400）
curl "$BASE/api/quotes/search"

# CORS 预检
curl -i -X OPTIONS "$BASE/api/quotes"

# 管理接口：强制刷新缓存
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE/api/admin/refresh"

# 管理接口：数据统计
curl -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE/api/admin/stats"
```

## 生产验证清单

1. `npm test` —— 全部用例通过（当前 142 个）。
2. `npm run typecheck` —— 无类型错误。
3. `npm run lint && npm run format:check` —— 无静态检查 / 风格问题。
4. `curl -i "$BASE/"` —— 返回 `302` 且 `Location` 指向 `/api/quotes/`。
5. `curl "$BASE/api/health"` —— `status=200`、`data.service="quotify"`，
   `data.state` 为 `warm` / `cold`，`data.sources` 显示「已缓存 / 配置总数」。
6. 首次 `curl "$BASE/api/quotes"` —— 返回数据且 KV 被写入；再次请求 `data.cached` 为 `true`。
7. `curl -i "$BASE/api/quotes"` —— 含 `Cache-Control: no-store`（随机结果不能被缓存）。
8. `curl -i -X OPTIONS "$BASE/api/quotes"` —— 返回 `Access-Control-Allow-Origin: *`。
9. `curl -i "$BASE/api/health"` —— 含 `X-Content-Type-Options: nosniff` 与 `Referrer-Policy: no-referrer`。
10. `curl -i "$BASE/api/quotes/categories"` —— 含 `Cache-Control: public, max-age=300`（默认 TTL）与 `ETag`；
    带上该 `ETag` 的 `If-None-Match` 再次请求 —— 返回 `304`。
11. `curl -X POST "$BASE/api/admin/refresh"`（无 Token）—— 返回 `401`。
12. `curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE/api/admin/refresh"` —— 返回 `200` 且 `total` 与数据仓库条数一致。
13. 把 `data.json` 中某条记录的 `content` 置空并提交 —— 管理刷新接口应返回 `500`，且 KV 中仍是上一份合法数据。
14. 配好两个 `DATA_SOURCES` 后 `curl "$BASE/api/admin/stats"` —— `sources` 有两项，`total` 等于两个数据集条数之和
    （若有重复 `id` 会被去重，看 `duplicates`）。
15. （可选）配置 `DATA_MANIFEST_URL` 后 `curl "$BASE/api/admin/stats"` —— `manifest` 显示清单地址、解析出的来源数，
    且清单里新增的来源已被合并进 `total`。
16. （可选）`curl "$BASE/v1/hitokoto?c=d"` —— 返回含 `hitokoto` / `type` / `from` 的裸对象。
