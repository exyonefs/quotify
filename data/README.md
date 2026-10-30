# quotify-data · 引语数据集

这是 **quotify（引语）** API 的数据仓库。Worker 通过**来源清单**动态加载这里的数据集文件，
因此**修改本仓库不需要改动或重新部署 Worker**。

## 目录结构

```text
quotify-data/
├── sources.json          # 来源清单：列出全部数据集文件的地址（Worker 据此加载）
└── data/
    ├── internet.json     # 网络
    ├── literature.json   # 文学
    ├── technology.json   # 科技
    ├── philosophy.json   # 哲学
    ├── film.json         # 影视
    └── wisdom.json       # 哲理
```

数据按 `category` 拆分：**一个文件对应一个分类**，便于分工维护、按需扩展与定位问题。

## 数据格式

每个数据集文件都使用同一种结构：

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

| 字段                | 必填 | 说明                                                                     |
| :------------------ | :--- | :----------------------------------------------------------------------- |
| `version`           | ✅   | 数字。数据结构版本，当前为 `1`                                           |
| `updated_at`        | ➖   | 字符串，建议 ISO 8601（如 `2026-09-26T17:30:00Z`）                       |
| `quotes`            | ✅   | 引语数组，**字段名固定为 `quotes`**                                      |
| `quotes[].id`       | ✅   | **8 位小写十六进制**，**全局唯一**（跨文件也不能重复），文件内按升序排列 |
| `quotes[].content`  | ✅   | 非空字符串，引语正文                                                     |
| `quotes[].source`   | ➖   | 出处 / 作品名，字符串                                                    |
| `quotes[].author`   | ➖   | 作者，字符串                                                             |
| `quotes[].category` | ➖   | 分类，字符串（应与所在文件的分类一致）                                   |
| `quotes[].tags`     | ➖   | 标签，字符串数组                                                         |

> Worker 端校验较严格：必填字段缺失或类型不符时，**该文件整体被拒绝**（接口返回 `500`，日志会指出是哪个文件、
> 第几条、哪个字段），但**不影响其它数据集文件**——它们照常提供服务。

## 来源清单 `sources.json`

一个 JSON 字符串数组，每项是一个数据集文件的原始地址：

```json
[
  "https://raw.githubusercontent.com/exyone-js/quotify-data/main/data/internet.json",
  "https://raw.githubusercontent.com/exyone-js/quotify-data/main/data/literature.json"
]
```

Worker 的 `DATA_MANIFEST_URL` 指向本文件，并把清单里的地址与自身配置的 `DATA_SOURCES` **合并去重**
（合计上限 20 个）。所以：**加减数据文件只需要改这个清单**。

## 如何维护

### 新增一条引语

1. 打开对应分类的文件（例：文学引语 → `data/literature.json`）；
2. 在 `quotes` 数组末尾追加一条，先随便填一个占位 `id`，**`content` 必须非空**；
3. 在仓库根目录执行 `npm run data:ids`：脚本会按内容派生固定 8 位 id、全局去重、
   文件内排序并同步 `updated_at`（也可手动运行 `npm run data:ids:check` 校验）；
4. 提交。

Worker 会在缓存过期（默认 300 秒）后自动拉到新数据；想立即生效，调用一次
`POST /api/admin/refresh`（需要管理 Token）。

### 新增一个分类 / 数据集文件

1. 在 `data/` 下新建 `<slug>.json`（文件名用小写英文，便于在 URL 中引用），按上面的格式写入内容；
2. 把它的原始地址追加到 `sources.json`；
3. 提交。

全程**不需要改动或重新部署 Worker**。

### 提交前自检

- 每个文件的根键只有 `version` / `updated_at` / `quotes`；
- 每条记录的 `category` 与所在文件一致；
- `id` 全局唯一、`content` 非空（没有空字符串或空数组字段）；
- `sources.json` 是合法 JSON 数组，且覆盖 `data/` 下的全部文件。

## 许可

数据内容多来自公有领域的诗词、典籍与名言；如涉及版权问题请提 Issue 联系处理。
