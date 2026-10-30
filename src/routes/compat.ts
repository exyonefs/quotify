import { Hono } from 'hono';
import { fingerprint } from '../config';
import { loadDataset } from '../data/loader';
import { randomPick } from '../data/store';
import type { Quote, QuoteDataset } from '../data/types';
import { publicRateLimit } from '../middleware/rateLimit';
import type { Env } from '../types/env';
import { ApiError, parseLimit } from '../utils/error';
import { bareJson, plainText } from '../utils/response';

/**
 * Hitokoto（一言）兼容层。
 *
 * Quotify 的原生响应是「信封 + 数组」，与 `v1.hitokoto.cn` 的裸对象契约不同，
 * 现有的一言客户端直接接入会取不到字段。这一层只做**字段与参数映射**，
 * 不改动原生接口，让老客户端可以零改动迁移。
 *
 * 字段契约以 [Hitokoto 开发者文档](https://developer.hitokoto.cn/) 为准：
 * 所有字段**始终返回有意义的非空值**（`creator_uid` / `reviewer` 为数字），
 * 缺失出处 / 作者时使用明确的中文占位，而不是空串或 `null`，
 * 避免客户端渲染出空白条目。
 *
 * 映射关系见 README「Hitokoto 兼容层」。
 */

/** Hitokoto 分类码 → 含义（a..l），也是 `c` 参数的取值。 */
const CODE_TO_CATEGORY: Record<string, string> = {
  a: '动画',
  b: '漫画',
  c: '游戏',
  d: '文学',
  e: '原创',
  f: '网络',
  g: '其他',
  h: '影视',
  i: '诗词',
  j: '网易云',
  k: '哲学',
  l: '抖机灵',
};

/**
 * 分类 → 分类码。
 *
 * 先由官方分类码反推，再补充数据集里实际出现、但官方没有独立分类的名称
 * （`哲理` 归入 `k` 哲学，`科技` 等归入 `g` 其他），避免它们因为映射不到
 * 而全部退化成「其他」——那会让 `c=k` 之类的筛选直接漏数据。
 * 未收录的分类统一归到 `g`。
 */
const CATEGORY_TO_CODE: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(CODE_TO_CATEGORY).map(([code, category]) => [category, code]),
  ),
  // 常见别名：数据集 / 上游文件写法不完全统一时的兜底。
  动漫: 'a',
  动画片: 'a',
  电影: 'h',
  影片: 'h',
  连续剧: 'h',
  古诗: 'i',
  古诗词: 'i',
  诗词歌赋: 'i',
  哲思: 'k',
  哲理: 'k',
  人生哲理: 'k',
  科技: 'g',
  科学: 'g',
  随想: 'e',
  随笔: 'e',
};

/** 未收录分类的兜底码：`g`（其他）。 */
const DEFAULT_CATEGORY_CODE = 'g';

/** 缺失出处 / 作者时的占位：保证客户端永远有内容可渲染。 */
const DEFAULT_FROM = '未知出处';
const DEFAULT_FROM_WHO = '佚名';

/** 兼容层固定的提交者 / 审核者信息。 */
const CREATOR = 'quotify';
const CREATOR_UID = 1;
const REVIEWER_UID = 1;
const COMMIT_FROM = 'api';

/** Hitokoto 的数字 id 必须是正整数，取模后落在 int32 安全区间内。 */
const MAX_NUMERIC_ID = 2_147_483_646;

/** JSONP 回调名白名单：必须是合法 JS 标识符，避免把响应变成可执行的任意脚本。 */
const CALLBACK_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

const compat = new Hono<{ Bindings: Env }>();

compat.use('*', publicRateLimit());

/** 解析 `c` 参数：只接受 a..l 的字母，多个值之间用逗号分隔（OR）。 */
function parseCategoryCodes(raw: string | undefined): string[] | null {
  if (!raw) return null;

  const codes = [
    ...new Set(
      raw
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item.length > 0),
    ),
  ];
  if (codes.length === 0) return null;

  for (const code of codes) {
    if (!(code in CODE_TO_CATEGORY)) {
      throw ApiError.badRequest(`参数 c 只支持 a-l 的分类码，收到：${code}。`);
    }
  }
  return codes;
}

/** 解析 `encode` 参数：json（默认）/ text / js。 */
function parseEncode(raw: string | undefined): 'json' | 'text' | 'js' {
  const value = raw?.trim() ?? '';
  if (value === '' || value === 'json') return 'json';
  if (value === 'text' || value === 'js') return value;
  throw ApiError.badRequest("参数 encode 只支持 'json'、'text' 或 'js'。");
}

/** 把数据集里的分类名映射为 Hitokoto 分类码。 */
function categoryCode(category: string | undefined): string {
  const name = category?.trim();
  if (!name) return DEFAULT_CATEGORY_CODE;
  return CATEGORY_TO_CODE[name] ?? DEFAULT_CATEGORY_CODE;
}

/**
 * 由 `quote.id` 稳定派生 Hitokoto 的数字 id。
 *
 * 取完整 32 位 FNV-1a 指纹再收敛到 `[1, 2^31-2]`：同一 uuid 永远得到同一个正整数，
 * 且不会出现 `0`（部分客户端会把 0 当作「无效 id」）。
 */
function numericId(uuid: string): number {
  return (parseInt(fingerprint(uuid), 16) % MAX_NUMERIC_ID) + 1;
}

/**
 * `created_at` 必须是 Unix 时间戳（字符串）。
 *
 * 旧实现直接透传数据集的 ISO `updated_at`，按官方契约把它当整数解析的客户端会得到 `NaN`。
 * 这里统一转换成秒级时间戳；`updated_at` 缺失 / 非法时回退到当前时间，保证字段始终可用。
 */
function createdTimestamp(updatedAt: string): string {
  const ms = Date.parse(updatedAt);
  const seconds = Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
  return String(seconds);
}

/**
 * 按「字符」而不是 UTF-16 码元计长度，与一言的 `length` 语义一致
 * （emoji 等增补平面字符算 1 个字符）。
 *
 * 以记录对象为键记忆化：热缓存存活期内同一条目被反复取用时无需重复遍历。
 */
const lengthCache = new WeakMap<Quote, number>();

function charLength(quote: Quote): number {
  const cached = lengthCache.get(quote);
  if (cached !== undefined) return cached;
  const length = Array.from(quote.content).length;
  lengthCache.set(quote, length);
  return length;
}

/** 把 Quotify 的 quote 映射成 Hitokoto 的响应对象（所有字段均有实际内容）。 */
function toHitokoto(quote: Quote, dataset: QuoteDataset): Record<string, unknown> {
  const source = quote.source?.trim() ?? '';
  const author = quote.author?.trim() ?? '';

  return {
    id: numericId(quote.id),
    uuid: quote.id,
    hitokoto: quote.content,
    type: categoryCode(quote.category),
    from: source.length > 0 ? source : DEFAULT_FROM,
    from_who: author.length > 0 ? author : DEFAULT_FROM_WHO,
    creator: CREATOR,
    creator_uid: CREATOR_UID,
    reviewer: REVIEWER_UID,
    commit_from: COMMIT_FROM,
    created_at: createdTimestamp(dataset.updated_at),
    length: charLength(quote),
  };
}

/**
 * 按分类码预先分桶的索引。
 *
 * 按数据集数组（热缓存里是同一个对象）记忆化：随机接口每请求都要按 `c` 过滤，
 * 每次都全量扫描 + 比较分类名会随数据量线性放大；分桶后单次请求只触碰命中的分桶。
 */
interface CompatPools {
  all: Quote[];
  byCode: Map<string, Quote[]>;
}

const poolsCache = new WeakMap<Quote[], CompatPools>();

function compatPools(quotes: Quote[]): CompatPools {
  const cached = poolsCache.get(quotes);
  if (cached !== undefined) return cached;

  const byCode = new Map<string, Quote[]>();
  for (const quote of quotes) {
    const code = categoryCode(quote.category);
    const bucket = byCode.get(code);
    if (bucket === undefined) byCode.set(code, [quote]);
    else bucket.push(quote);
  }

  const pools: CompatPools = { all: quotes, byCode };
  poolsCache.set(quotes, pools);
  return pools;
}

/** 取分类码对应的候选池；未传 `c` 时返回全量池。 */
function selectPool(quotes: Quote[], codes: string[] | null): Quote[] {
  if (codes === null) return quotes;

  const { byCode } = compatPools(quotes);
  const picked: Quote[] = [];
  for (const code of codes) {
    const bucket = byCode.get(code);
    if (bucket === undefined) continue;
    for (const quote of bucket) picked.push(quote);
  }
  return picked;
}

/**
 * GET /v1/hitokoto —— 随机一条，以 Hitokoto 契约返回。
 *
 * 支持参数：`c`（分类码 a-l，逗号分隔）、`encode`、`callback`（encode=js 时必填）、
 * `min_length`、`max_length`；`charset` 仅为兼容既有客户端而接受，响应始终为 UTF-8。
 */
compat.get('/', async (c) => {
  const codes = parseCategoryCodes(c.req.query('c'));
  const encode = parseEncode(c.req.query('encode'));
  const minLength = parseLimit(c.req.query('min_length'), 0, 0, 10_000, 'min_length');
  const maxLength = parseLimit(c.req.query('max_length'), 0, 0, 10_000, 'max_length');

  if (maxLength > 0 && maxLength < minLength) {
    throw ApiError.badRequest('参数 max_length 不能小于 min_length。');
  }

  const dataset = await loadDataset(c.env);

  let pool = selectPool(dataset.quotes, codes);
  if (minLength > 0) pool = pool.filter((quote) => charLength(quote) >= minLength);
  if (maxLength > 0) pool = pool.filter((quote) => charLength(quote) <= maxLength);
  if (pool.length === 0) {
    throw ApiError.notFound('没有符合条件的一言。');
  }

  const picked = randomPick(pool, 1)[0];
  if (picked === undefined) {
    throw ApiError.notFound('没有符合条件的一言。');
  }

  if (encode === 'text') {
    return plainText(picked.content);
  }

  const payload = toHitokoto(picked, dataset);

  if (encode === 'js') {
    const callback = (c.req.query('callback') ?? '').trim();
    if (!CALLBACK_PATTERN.test(callback)) {
      throw ApiError.badRequest(
        'encode=js 时必须提供合法的 callback 参数（JS 标识符，最多 64 个字符）。',
      );
    }
    return new Response(`${callback}(${JSON.stringify(payload)});`, {
      status: 200,
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  // 裸对象：Hitokoto 客户端直接读 `hitokoto` / `type`，不能套统一外壳。
  return bareJson(payload);
});

export default compat;
