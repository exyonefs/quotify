/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import { validateDataset } from '../src/data/loader';

// data/ 下的数据集不会被运行时直接读取（Worker 通过来源清单远程加载），
// 但它们就是线上数据的事实来源，手工编辑出错只能等到线上才发现。这里纳入 CI：
// 所有文件都跑一遍与运行时完全相同的校验，并额外约束 id 的规范化格式。
const datasets = import.meta.glob('../data/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

const files = Object.entries(datasets)
  .map(([file, data]) => ({
    file,
    dataset: validateDataset(data, file),
  }))
  .sort((left, right) => left.file.localeCompare(right.file));

describe('data/*.json（数据仓库）', () => {
  it('至少存在一个数据集文件', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('每个文件都能通过运行时同一套校验（格式与线上要求完全一致）', () => {
    for (const { file, dataset } of files) {
      expect(() => validateDataset(dataset, file)).not.toThrow();
    }
  });

  it('version 与 updated_at 齐全，且 updated_at 是合法时间戳', () => {
    for (const { file, dataset } of files) {
      expect(typeof dataset.version, file).toBe('number');
      expect(dataset.updated_at.length, file).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(dataset.updated_at)), file).toBe(false);
    }
  });

  it('每条都有非空 content 与分类，避免出现无法过滤的孤儿条目', () => {
    for (const { file, dataset } of files) {
      for (const quote of dataset.quotes) {
        expect(quote.content.length, `${file} / ${quote.id}`).toBeGreaterThan(0);
        expect(quote.category, `${file} / ${quote.id}`).toBeTruthy();
      }
    }
  });

  it('id 统一为 8 位小写十六进制，且在文件内、跨文件都唯一', () => {
    const seen = new Set<string>();

    for (const { file, dataset } of files) {
      const ids = dataset.quotes.map((quote) => quote.id);
      expect(new Set(ids).size, file).toBe(ids.length);

      for (const id of ids) {
        expect(id, `${file} / ${id}`).toMatch(/^[0-9a-f]{8}$/);
        expect(seen.has(id), `${file} 中的 ${id} 与其它文件重复`).toBe(false);
        seen.add(id);
      }
    }
  });

  it('每个文件内的 id 按升序排列（npm run data:ids 的输出契约）', () => {
    for (const { file, dataset } of files) {
      const ids = dataset.quotes.map((quote) => quote.id);
      expect(ids, file).toEqual([...ids].sort());
    }
  });

  it('同一文件内没有重复正文', () => {
    for (const { file, dataset } of files) {
      const contents = dataset.quotes.map((quote) => quote.content);
      expect(new Set(contents).size, file).toBe(contents.length);
    }
  });
});
