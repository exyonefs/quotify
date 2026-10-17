import type { Env } from './types/env';

/**
 * KV 键前缀。
 *
 * 版本后缀只在「结构不兼容变更」时递增，用于隔离旧缓存。
 * 每个来源各存一份缓存，键后缀由**来源 URL 派生**（而非数组下标），
 * 这样增删 / 重排来源都不会导致缓存错位。
 */
export const DATA_KEY_PREFIX = 'quotify:data:v1';
export const META_KEY_PREFIX = 'quotify:meta:v1';
export const MANIFEST_KEY_PREFIX = 'quotify:manifest:v1';

/** 单次加载允许的来源总数上限，避免清单失控导致上游调用爆炸。 */
export const MAX_DATA_SOURCES = 20;

/**
 * FNV-1a 32 位哈希（8 位十六进制），把 URL 映射为稳定的 KV 键后缀。
 *
 * 哈希存在碰撞可能，但读取缓存时会比对 meta 里的 `source_url`，
 * 真碰撞只会退化成一次「未命中 + 回源」，不会返回错数据。
 */
export function fingerprint(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 某个来源的数据集 KV 键。 */
export function dataKey(url: string): string {
  return `${DATA_KEY_PREFIX}:${fingerprint(url)}`;
}

/** 某个来源的元信息 KV 键。 */
export function metaKey(url: string): string {
  return `${META_KEY_PREFIX}:${fingerprint(url)}`;
}

/** 来源清单文件的 KV 键。 */
export function manifestKey(url: string): string {
  return `${MANIFEST_KEY_PREFIX}:${fingerprint(url)}`;
}

/**
 * 默认「来源清单」地址：quotify-data 仓库根目录的 `sources.json`
 * （一个 JSON 字符串数组，每项是一个数据集文件地址）。
 *
 * 未显式配置 `DATA_MANIFEST_URL` 时使用它；显式配置为空字符串则表示关闭清单。
 */
export const DEFAULT_MANIFEST_URL =
  'https://raw.githubusercontent.com/exyonefs/quotify-data/main/sources.json';

/**
 * 默认静态来源：留空表示「默认不配置静态来源」，来源列表完全由清单文件解析得到。
 * 需要静态兜底（清单不可用时仍有内容可服务）时，在 `wrangler.toml` 的 `DATA_SOURCES` 里列出。
 */
export const DEFAULT_DATA_SOURCES: readonly string[] = [];

/** 缓存默认 TTL：300 秒。 */
export const DEFAULT_DATA_TTL = 300;

/**
 * KV `expirationTtl` 的合法区间（Cloudflare 要求至少 60 秒）。
 *
 * 越界的配置不会「悄悄生效」，而是夹紧到边界并打告警：
 * 低于下限时 `CACHE.put` 会直接抛错，进而让所有来源加载失败、全站 500。
 */
export const MIN_DATA_TTL = 60;
export const MAX_DATA_TTL = 31_536_000;

/** 进程内热缓存 TTL：60 秒。用于避免每个请求都重复读 KV 并全量解析数据集。 */
export const MEMORY_CACHE_TTL_MS = 60_000;

/** 外部 fetch 超时时间：5 秒。 */
export const FETCH_TIMEOUT_MS = 5000;

/** 回源失败后的重试次数与退避基数：只在超时 / 网络错误 / 5xx 时重试，4xx 直接失败。 */
export const FETCH_RETRY_COUNT = 2;
export const FETCH_RETRY_BASE_DELAY_MS = 120;

/** 回源请求在 Cloudflare 边缘缓存中的 TTL：60 秒（缓解 GitHub 限流）。 */
export const GITHUB_CACHE_TTL = 60;

/** 逗号分隔参数允许的最大取值个数，避免超长参数放大过滤开销。 */
export const MAX_CSV_VALUES = 50;

/** 单个参数取值的最大字符数，避免超长关键词把子串匹配放大成 O(n·m)。 */
export const MAX_PARAM_LENGTH = 100;

/** 分页偏移上限：超过它几乎一定是误用，且会白扫一遍结果集。 */
export const MAX_OFFSET = 10_000;

/** 内容稳定的派生接口（分类 / 标签）的浏览器 / CDN 缓存时长：1 小时。 */
export const CATALOG_CACHE_MAX_AGE = 3600;

/** `/api/quotes` 的 limit 区间。 */
export const RANDOM_LIMIT_MIN = 1;
export const RANDOM_LIMIT_MAX = 20;

/** `/api/quotes/search` 的 limit 区间与默认值。 */
export const SEARCH_LIMIT_MIN = 1;
export const SEARCH_LIMIT_MAX = 50;
export const SEARCH_LIMIT_DEFAULT = 10;

/** CORS 预检结果缓存时长：24 小时。 */
export const CORS_MAX_AGE = 86400;

/**
 * 根路径默认重定向目标。访问根域时直接跳到公开随机一言接口，
 * 避免用户看到裸 404。必须是以单个 `/` 开头的站内绝对路径。
 */
export const DEFAULT_ROOT_REDIRECT = '/api/quotes/';

/**
 * 解析「JSON 字符串数组」形式的来源列表：去空、去重。
 *
 * `DATA_SOURCES` 与来源清单文件共用这一种格式，因此解析逻辑也共用。
 * 结构非法时抛错，由调用方决定是「致命」还是「降级」。
 */
export function parseSourceList(raw: string, label: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} 不是合法 JSON，应形如 ["https://.../data.json"]。`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} 必须是 JSON 字符串数组。`);
  }

  const urls = parsed
    .filter((item): item is string => typeof item === 'string')
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  return [...new Set(urls)];
}

/**
 * 读取基线来源（部署期配置的 `DATA_SOURCES`）。
 *
 * 配置非法时**降级为空列表**而不是抛错：来源还可能全部来自清单文件（见
 * `resolveManifestUrl`），一个配置笔误不该让整个 API 不可用。
 * 降级不会静默——错误会打到日志，并在清单也没解析出来源时
 * 由 `loadAggregate` 抛出「未解析到任何数据来源」。
 *
 * 未配置或显式 `[]` 都表示不设静态来源。
 */
export function resolveBaselineSources(env: Env): string[] {
  const raw = env.DATA_SOURCES?.trim();
  if (!raw) return [...DEFAULT_DATA_SOURCES];

  try {
    return parseSourceList(raw, 'DATA_SOURCES');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[quotify] DATA_SOURCES 解析失败，已降级为「不设静态来源」：${reason}`);
    return [...DEFAULT_DATA_SOURCES];
  }
}

/**
 * 读取来源清单地址：清单里解析出的来源会与基线来源合并。
 *
 * - 未配置（`undefined`）→ 使用 `DEFAULT_MANIFEST_URL`；
 * - 显式留空字符串 → 关闭清单，只用 `DATA_SOURCES`。
 */
export function resolveManifestUrl(env: Env): string | null {
  const raw = env.DATA_MANIFEST_URL;
  if (raw === undefined) return DEFAULT_MANIFEST_URL;

  const url = raw.trim();
  return url.length > 0 ? url : null;
}

/** 合并来源并截断到上限；超出部分丢弃并告警（保留靠前的来源，顺序即优先级）。 */
export function limitSources(urls: readonly string[]): string[] {
  const unique = [...new Set(urls)];
  if (unique.length <= MAX_DATA_SOURCES) return unique;

  console.warn(
    `[quotify] 数据来源过多（${unique.length} 个），只取前 ${MAX_DATA_SOURCES} 个（见 MAX_DATA_SOURCES）。`,
  );
  return unique.slice(0, MAX_DATA_SOURCES);
}

/**
 * 站内绝对路径白名单。
 *
 * 只放行「以单个 `/` 开头、且后续每段都由 URL 安全字符构成」的路径，因此：
 * - `//evil.com`（协议相对地址）→ 拒绝；
 * - `/\evil.com`（反斜杠）→ 拒绝：浏览器会把 `\` 规范化成 `/`，从而绕过 `//` 检查；
 * - 控制字符 / 空白 / `?` → 拒绝，避免反射出畸形 Location 头。
 */
const SAFE_PATH_PATTERN =
  /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%]+(?:\/[A-Za-z0-9\-._~!$&'()*+,;=:@%]*)*$/;

/** 重定向目标的最大长度，避免异常配置反射进 Location 头。 */
const MAX_ROOT_REDIRECT_LENGTH = 200;

/**
 * 读取生效的根路径重定向目标。
 *
 * 只接受站内绝对路径，否则回退到默认值：避免配置被写成外链时形成开放重定向（Open Redirect）。
 */
export function resolveRootRedirect(env: Env): string {
  const target = env.ROOT_REDIRECT?.trim();
  if (!target || target.length > MAX_ROOT_REDIRECT_LENGTH || !SAFE_PATH_PATTERN.test(target)) {
    return DEFAULT_ROOT_REDIRECT;
  }
  return target;
}

/**
 * 读取生效的缓存 TTL（秒）。
 *
 * 非法值（非数字 / 非正数 / NaN）回退到默认值；合法但越界的值**夹紧**到
 * `[MIN_DATA_TTL, MAX_DATA_TTL]` 并打告警——低于 KV 下限会让写入直接抛错。
 */
export function resolveDataTtl(env: Env): number {
  const ttl = Number(env.DATA_TTL);
  if (!Number.isFinite(ttl) || ttl <= 0) return DEFAULT_DATA_TTL;

  const seconds = Math.floor(ttl);
  if (seconds < MIN_DATA_TTL) {
    console.warn(`[quotify] DATA_TTL=${seconds} 低于 KV 下限，已夹紧为 ${MIN_DATA_TTL} 秒。`);
    return MIN_DATA_TTL;
  }
  if (seconds > MAX_DATA_TTL) {
    console.warn(`[quotify] DATA_TTL=${seconds} 超过上限，已夹紧为 ${MAX_DATA_TTL} 秒。`);
    return MAX_DATA_TTL;
  }
  return seconds;
}

/** 读取可选的来源主机白名单（逗号分隔；未配置表示不限制主机）。 */
export function resolveSourceHosts(env: Env): string[] {
  const raw = env.DATA_SOURCE_HOSTS?.trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);
}

/**
 * 判断一个来源地址是否允许被加载。
 *
 * 来源清单属于「运行期数据」（可能被协作者改动、也可能被中间人篡改），
 * 因此清单里解析出的地址必须过这一关：
 * - 协议必须是 `https:`：禁止 `http://` 明文与 `file:` / `data:` 等；
 * - 若配置了 `DATA_SOURCE_HOSTS`，主机必须命中白名单（防 SSRF 到内网 / 任意站点）。
 */
export function isAllowedSourceUrl(url: string, hosts: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (hosts.length > 0 && !hosts.includes(parsed.hostname.toLowerCase())) return false;
  return true;
}
