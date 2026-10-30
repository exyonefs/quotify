import { describe, expect, it } from 'vitest';
import {
  applyFilters,
  collectCategories,
  collectTags,
  datasetEtag,
  paginate,
  randomPick,
  search,
} from '../src/data/store';
import type { Quote } from '../src/data/types';

/** 构造一条 quote，未给出的可选字段一律省略。 */
function quote(id: string, extra: Partial<Quote> = {}): Quote {
  return { id, content: `内容-${id}`, ...extra };
}

const LIST: Quote[] = [
  quote('1', { category: '文学', tags: ['古诗', '人生'], author: '苏轼', source: '临江仙' }),
  quote('2', { category: '文学', tags: ['古文'], author: '王勃', source: '滕王阁序' }),
  quote('3', { category: '哲学', tags: ['人生'], author: '苏格拉底' }),
  quote('4', { category: '科技', author: '费曼' }),
  quote('5'),
];

describe('randomPick', () => {
  it('n 小于总量时返回 n 条且互不重复', () => {
    for (let round = 0; round < 50; round += 1) {
      const picked = randomPick(LIST, 3);
      expect(picked).toHaveLength(3);
      expect(new Set(picked.map((item) => item.id)).size).toBe(3);
    }
  });

  it('n 大于等于总量时返回全部（顺序被打乱但集合一致）', () => {
    const picked = randomPick(LIST, 99);
    expect(picked).toHaveLength(LIST.length);
    expect(new Set(picked.map((item) => item.id))).toEqual(new Set(LIST.map((item) => item.id)));
  });

  it('n 为 1 时直接从列表中取出一条，不做无意义的全量复制', () => {
    for (let round = 0; round < 50; round += 1) {
      const picked = randomPick(LIST, 1);
      expect(picked).toHaveLength(1);
      expect(LIST).toContain(picked[0]);
    }
  });

  it('n 远小于总量时走稀疏取样，结果互不重复', () => {
    const big = Array.from({ length: 1000 }, (_, index) => quote(`b${index}`));
    const picked = randomPick(big, 5);

    expect(picked).toHaveLength(5);
    expect(new Set(picked.map((item) => item.id)).size).toBe(5);
    expect(big).toHaveLength(1000);
  });

  it('n 为 0 时返回空数组', () => {
    expect(randomPick(LIST, 0)).toEqual([]);
  });

  it('空列表返回空数组，不抛错', () => {
    expect(randomPick([], 5)).toEqual([]);
  });

  it('不修改原数组', () => {
    const snapshot = LIST.map((item) => item.id);
    randomPick(LIST, 3);
    expect(LIST.map((item) => item.id)).toEqual(snapshot);
  });
});

describe('applyFilters', () => {
  it('无过滤条件时原样返回', () => {
    expect(applyFilters(LIST, {})).toHaveLength(LIST.length);
  });

  it('同一维度内多个取值是 OR', () => {
    const result = applyFilters(LIST, { categories: ['文学', '哲学'] });
    expect(result.map((item) => item.id).sort()).toEqual(['1', '2', '3']);
  });

  it('不同维度之间是 AND', () => {
    const result = applyFilters(LIST, { categories: ['文学'], tags: ['人生'] });
    expect(result.map((item) => item.id)).toEqual(['1']);
  });

  it('空数组条件视为「不加过滤」', () => {
    expect(applyFilters(LIST, { categories: [] })).toHaveLength(LIST.length);
  });

  it('缺失 category / tags 的条目不会被匹配', () => {
    expect(applyFilters(LIST, { categories: ['文学'] }).map((item) => item.id)).toEqual(['1', '2']);
    expect(applyFilters(LIST, { tags: ['人生'] }).map((item) => item.id)).toEqual(['1', '3']);
  });
});

describe('search', () => {
  it('大小写不敏感，且覆盖 content / author / source', () => {
    expect(search(LIST, '苏轼').map((item) => item.id)).toEqual(['1']);
    expect(search(LIST, '滕王阁序').map((item) => item.id)).toEqual(['2']);
    expect(search(LIST, '内容-3').map((item) => item.id)).toEqual(['3']);
  });

  it('不会跨字段误匹配（U+0000 分隔符生效）', () => {
    // 「苏轼」在一条记录里同时跨越 author 与 content 边界，不应命中
    const one: Quote[] = [quote('x', { author: '苏', content: '轼' })];
    expect(search(one, '苏轼')).toEqual([]);
  });

  it('空关键词返回空数组', () => {
    expect(search(LIST, '   ')).toEqual([]);
  });
});

describe('paginate', () => {
  it('按 offset / limit 切片', () => {
    expect(paginate(LIST, 2, 1).map((item) => item.id)).toEqual(['2', '3']);
  });

  it('offset 超出总量时返回空数组', () => {
    expect(paginate(LIST, 10, 99)).toEqual([]);
  });
});

describe('collectCategories / collectTags', () => {
  it('去重、去空并按字典序排序', () => {
    // 不写死具体顺序：中文排序取决于运行时的 ICU 数据，只断言「集合正确 + 已排序」。
    const categories = collectCategories(LIST);
    expect(new Set(categories)).toEqual(new Set(['文学', '哲学', '科技']));
    expect(categories).toEqual([...categories].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')));

    const tags = collectTags(LIST);
    expect(new Set(tags)).toEqual(new Set(['古诗', '人生', '古文']));
    expect(tags).toEqual([...tags].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')));
  });

  it('空列表返回空数组', () => {
    expect(collectCategories([])).toEqual([]);
    expect(collectTags([])).toEqual([]);
  });
});

describe('datasetEtag', () => {
  const base = { version: 1, updated_at: '2026-01-01T00:00:00Z', quotes: LIST };

  it('同一数据集稳定返回同一个 ETag', () => {
    expect(datasetEtag(base)).toBe(datasetEtag(base));
  });

  it('内容变化会改变 ETag（即使 version / updated_at / 条数都不变）', () => {
    // 这正是旧实现（只看 version + updated_at + 条数）的漏洞：
    // 维护者改了标签却不更新 updated_at，分类 / 标签接口会一直返回过期结果。
    const tweaked = {
      ...base,
      quotes: LIST.map((item) => (item.id === '1' ? { ...item, tags: ['改过的标签'] } : item)),
    };

    expect(tweaked.quotes).toHaveLength(base.quotes.length);
    expect(datasetEtag(tweaked)).not.toBe(datasetEtag(base));
  });

  it('条数变化会改变 ETag', () => {
    const shorter = { ...base, quotes: LIST.slice(0, 2) };
    expect(datasetEtag(shorter)).not.toBe(datasetEtag(base));
  });

  it('是弱 ETag（带 W/ 前缀）', () => {
    expect(datasetEtag(base).startsWith('W/"')).toBe(true);
  });
});
