import { fingerprint } from '../config';
import type { Quote, QuoteDataset } from './types';

/** Fisher–Yates 洗牌（返回新数组）。 */
function shuffle(list: Quote[]): Quote[] {
  const result = [...list];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = result[i] as Quote;
    const b = result[j] as Quote;
    result[i] = b;
    result[j] = a;
  }
  return result;
}

/**
 * 随机取 n 条，保证不重复。
 *
 * 三种策略按填充率切换，避免「只取 1 条却复制整个池」这种最常见的浪费：
 * - `n >= 总量`：洗牌后全量返回；
 * - `n` 远小于总量：只记录命中的下标（拒绝采样），不复制原数组；
 * - 其余情况：部分 Fisher–Yates，复杂度稳定为 O(n)，不会反复重试。
 *
 * 任何情况下都不修改原数组，返回的顺序是随机的。
 */
export function randomPick(list: Quote[], n: number): Quote[] {
  if (n <= 0 || list.length === 0) return [];
  if (n >= list.length) return shuffle(list);

  if (n === 1) {
    return [list[Math.floor(Math.random() * list.length)] as Quote];
  }

  if (n * 4 <= list.length) {
    const indexes = new Set<number>();
    while (indexes.size < n) {
      indexes.add(Math.floor(Math.random() * list.length));
    }
    return [...indexes].map((index) => list[index] as Quote);
  }

  const pool = [...list];
  for (let i = 0; i < n; i += 1) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    const a = pool[i] as Quote;
    const b = pool[j] as Quote;
    pool[i] = b;
    pool[j] = a;
  }
  return pool.slice(0, n);
}

export interface FilterOptions {
  /**
   * 未给出的维度就是 `undefined`（与空数组等价：都不加过滤）。
   * 显式写出 `| undefined`：过滤逻辑本来就接受「这个维度没设置」这一种状态，
   * 没必要强迫调用方在调用点做条件展开。
   */
  categories?: string[] | undefined;
  tags?: string[] | undefined;
}

/**
 * 过滤：不同维度之间是 AND，同一维度内多个值是 OR。
 *
 * 取值先转成 `Set`：否则每个条目都要对参数数组做一次线性 `includes`，
 * 数据量与筛选值同时变大时退化成 O(n·m)。无任何条件时直接原样返回，省掉一次全量遍历。
 */
export function applyFilters(list: Quote[], opts: FilterOptions): Quote[] {
  const { categories, tags } = opts;
  const categorySet = categories?.length ? new Set(categories) : null;
  const tagSet = tags?.length ? new Set(tags) : null;
  if (categorySet === null && tagSet === null) return list;

  return list.filter((quote) => {
    if (categorySet !== null && (!quote.category || !categorySet.has(quote.category))) {
      return false;
    }
    if (tagSet !== null && (!quote.tags || !quote.tags.some((tag) => tagSet.has(tag)))) {
      return false;
    }
    return true;
  });
}

/**
 * 单条引语的小写检索文本（content / author / source 以 U+0000 拼接）。
 *
 * 以记录对象为键做 WeakMap 记忆化：同一份数据集在热缓存存活期内被反复检索时，
 * 无需每个请求都重新 toLowerCase 全量文本。分隔符用 U+0000，
 * 正常关键词不会包含它，因此跨字段误匹配不可能发生。
 */
const lowerTextCache = new WeakMap<Quote, string>();

function lowerText(quote: Quote): string {
  const cached = lowerTextCache.get(quote);
  if (cached !== undefined) return cached;
  const text =
    `${quote.content}\u0000${quote.author ?? ''}\u0000${quote.source ?? ''}`.toLowerCase();
  lowerTextCache.set(quote, text);
  return text;
}

/** 关键词搜索：大小写不敏感，匹配 content / author / source。 */
export function search(list: Quote[], q: string): Quote[] {
  const kw = q.trim().toLowerCase();
  if (!kw) return [];
  return list.filter((quote) => lowerText(quote).includes(kw));
}

/** 分页。 */
export function paginate(list: Quote[], limit: number, offset: number): Quote[] {
  return list.slice(offset, offset + limit);
}

/**
 * 复用一个 Collator：`localeCompare` 每次比较都会重新解析 locale 与选项，
 * 在枚举、排序上千个分类 / 标签时是可观的开销。
 */
const SORT_COLLATOR = new Intl.Collator('zh-Hans-CN');

/** 去重、去空并按拼音排序。 */
function collectUnique(values: readonly (string | undefined)[]): string[] {
  const set = new Set<string>();
  for (const value of values) {
    if (value) set.add(value);
  }
  return [...set].sort((a, b) => SORT_COLLATOR.compare(a, b));
}

interface EnumerableIndex {
  categories: string[];
  tags: string[];
}

/** 以数据集数组为键记忆化「分类 / 标签」枚举结果，避免每次请求重复全量遍历 + 排序。 */
const enumerableCache = new WeakMap<Quote[], EnumerableIndex>();

function enumerableIndex(list: Quote[]): EnumerableIndex {
  const cached = enumerableCache.get(list);
  if (cached !== undefined) return cached;

  const index: EnumerableIndex = {
    categories: collectUnique(list.map((quote) => quote.category)),
    tags: collectUnique(list.flatMap((quote) => quote.tags ?? [])),
  };
  enumerableCache.set(list, index);
  return index;
}

/** 收集去重后的分类（字典序）。 */
export function collectCategories(list: Quote[]): string[] {
  return enumerableIndex(list).categories;
}

/** 收集去重后的标签（字典序）。 */
export function collectTags(list: Quote[]): string[] {
  return enumerableIndex(list).tags;
}

/** 数据集的规范化文本：所有对外可见字段按固定顺序拼接，任一变化都会改变它。 */
function canonicalText(dataset: QuoteDataset): string {
  const parts: string[] = [String(dataset.version), dataset.updated_at];
  for (const quote of dataset.quotes) {
    parts.push(
      [
        quote.id,
        quote.content,
        quote.source ?? '',
        quote.author ?? '',
        quote.category ?? '',
        (quote.tags ?? []).join('\u0001'),
      ].join('\u0002'),
    );
  }
  return parts.join('\u0003');
}

/** 以 quotes 数组为键记忆化指纹：热缓存存活期内不必每次请求都重新哈希全量数据。 */
const etagCache = new WeakMap<Quote[], string>();

/**
 * 数据集指纹，用于派生接口的 ETag。
 *
 * 由「version + 条数 + 全量内容的哈希」构成。**必须包含内容**：
 * 只靠 `version + updated_at + 条数` 的话，维护者改了分类 / 标签却不更新
 * `updated_at`，ETag 就不会变，分类与标签接口会一直返回过期结果。
 *
 * 客户端凭 If-None-Match 命中即可拿到 304，省去重复传输。
 */
export function datasetEtag(dataset: QuoteDataset): string {
  const cached = etagCache.get(dataset.quotes);
  if (cached !== undefined) return cached;

  const etag = `W/"${dataset.version}-${dataset.quotes.length}-${fingerprint(canonicalText(dataset))}"`;
  etagCache.set(dataset.quotes, etag);
  return etag;
}
