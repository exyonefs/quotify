import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataKey, manifestKey, metaKey, resolveManifestUrl } from '../src/config';
import { invalidateMemoryCache } from '../src/data/loader';
import type { Env } from '../src/types/env';

/** 覆盖 hitokoto 各分类码与长度过滤的最小数据集。 */
const DATASET = {
  version: 1,
  updated_at: '2026-09-26T12:00:00Z',
  quotes: [
    {
      id: 'q1',
      content: '人生如逆旅，我亦是行人。',
      source: '临江仙·送钱穆父',
      author: '苏轼',
      category: '文学',
    },
    {
      id: 'q2',
      content: '我思故我在。',
      source: '方法论',
      author: '笛卡尔',
      category: '哲学',
    },
    { id: 'q3', content: '短。', category: '其他' },
    { id: 'q4', content: '科技改变生活。', category: '科技' },
    {
      id: 'q5',
      content: '上善若水。',
      source: '道德经',
      author: '老子',
      category: '哲理',
    },
  ],
};

const DEFAULT_MANIFEST = resolveManifestUrl(env as unknown as Env) as string;
const SOURCE_URL =
  'https://raw.githubusercontent.com/exyone-js/quotify-data/main/data/literature.json';
const BASE = 'https://quotify.test';

interface Hitokoto {
  id: number;
  uuid: string;
  hitokoto: string;
  type: string;
  from: string;
  from_who: string;
  creator: string;
  creator_uid: number;
  reviewer: number;
  commit_from: string;
  created_at: string;
  length: number;
}

function urlOf(input: unknown): string {
  return input instanceof Request ? input.url : String(input);
}

beforeEach(async () => {
  invalidateMemoryCache();
  await Promise.all(
    [dataKey(SOURCE_URL), metaKey(SOURCE_URL), manifestKey(DEFAULT_MANIFEST)].map((key) =>
      env.CACHE.delete(key),
    ),
  );

  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = urlOf(input);
    if (url === DEFAULT_MANIFEST) {
      return new Response(JSON.stringify([SOURCE_URL]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === SOURCE_URL) {
      return new Response(JSON.stringify(DATASET), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /v1/hitokoto（Hitokoto 兼容层）', () => {
  it('以 Hitokoto 契约返回裸对象（不是信封）', async () => {
    const res = await SELF.fetch(`${BASE}/v1/hitokoto`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    // 随机接口不能被缓存
    expect(res.headers.get('Cache-Control')).toContain('no-store');

    const body = (await res.json()) as Hitokoto;
    expect(typeof body.id).toBe('number');
    expect(body.id).toBeGreaterThan(0);
    expect(typeof body.uuid).toBe('string');
    expect(body.uuid.length).toBeGreaterThan(0);
    expect(typeof body.hitokoto).toBe('string');
    expect(body.hitokoto.length).toBeGreaterThan(0);
    expect(body.length).toBe(body.hitokoto.length);
    expect(body.creator).toBe('quotify');
    expect(body.creator_uid).toBeGreaterThan(0);
    expect(body.reviewer).toBeGreaterThan(0);
    expect(body.commit_from).toBe('api');
    expect(Array.from(body.hitokoto).length).toBe(body.length);
    expect(typeof body.from).toBe('string');
    expect(body.from.length).toBeGreaterThan(0);
    expect(typeof body.from_who).toBe('string');
    expect(body.from_who.length).toBeGreaterThan(0);
    expect(body.type).toMatch(/^[a-l]$/);
  });

  it('created_at 是 Unix 秒级时间戳（字符串），而不是 ISO 时间', async () => {
    const res = await SELF.fetch(`${BASE}/v1/hitokoto`);
    const body = (await res.json()) as Hitokoto;

    expect(body.created_at).toBe(String(Math.floor(Date.parse(DATASET.updated_at) / 1000)));
    expect(Number.isInteger(Number(body.created_at))).toBe(true);
  });

  it('分类码与 category 正确映射（含 哲理 → k）', async () => {
    const res = await SELF.fetch(`${BASE}/v1/hitokoto?c=k`);
    const body = (await res.json()) as Hitokoto;

    expect(body.type).toBe('k');
    expect(['q2', 'q5']).toContain(body.uuid);
  });

  it('未收录 / 别名分类归到 g（其他）', async () => {
    const res = await SELF.fetch(`${BASE}/v1/hitokoto?c=g`);
    const body = (await res.json()) as Hitokoto;

    expect(body.type).toBe('g');
    expect(['q3', 'q4']).toContain(body.uuid);
  });

  it('缺失出处 / 作者时返回明确的占位值，而不是空串', async () => {
    // q3：既无 source 也无 author，长度 2，可被 max_length 精确定位。
    const fallback = (await (
      await SELF.fetch(`${BASE}/v1/hitokoto?c=g&max_length=2`)
    ).json()) as Hitokoto;
    expect(fallback.uuid).toBe('q3');
    expect(fallback.from).toBe('未知出处');
    expect(fallback.from_who).toBe('佚名');

    // q4：分类写作「科技」，应归到 g（其他），长度 7。
    const alias = (await (
      await SELF.fetch(`${BASE}/v1/hitokoto?c=g&min_length=7&max_length=7`)
    ).json()) as Hitokoto;
    expect(alias.uuid).toBe('q4');
    expect(alias.type).toBe('g');
  });

  it('非法分类码返回 400', async () => {
    const res = await SELF.fetch(`${BASE}/v1/hitokoto?c=z`);
    expect(res.status).toBe(400);
  });

  it('encode=text 返回纯文本正文', async () => {
    const res = await SELF.fetch(`${BASE}/v1/hitokoto?encode=text`);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    const text = await res.text();
    expect(DATASET.quotes.some((item) => item.content === text)).toBe(true);
  });

  it('encode=js 返回 JSONP，且 callback 必须是合法标识符', async () => {
    const res = await SELF.fetch(`${BASE}/v1/hitokoto?encode=js&callback=hitokoto_cb`);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('javascript');
    const text = await res.text();
    expect(text.startsWith('hitokoto_cb(')).toBe(true);
    expect(text.endsWith(');')).toBe(true);
  });

  it('encode=js 缺少合法 callback 时返回 400（防止注入任意脚本）', async () => {
    expect((await SELF.fetch(`${BASE}/v1/hitokoto?encode=js`)).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/v1/hitokoto?encode=js&callback=alert(1)`)).status).toBe(400);
  });

  it('min_length 过滤掉过短的条目', async () => {
    const res = await SELF.fetch(`${BASE}/v1/hitokoto?min_length=5`);
    const body = (await res.json()) as Hitokoto;

    expect(body.length).toBeGreaterThanOrEqual(5);
    expect(body.uuid).not.toBe('q3');
  });

  it('max_length 小于 min_length 时返回 400', async () => {
    const res = await SELF.fetch(`${BASE}/v1/hitokoto?min_length=10&max_length=3`);
    expect(res.status).toBe(400);
  });

  it('同一条目的数字 id 稳定不变', async () => {
    // c=d 只有 q1 一条，避免随机抽到不同条目导致误判。
    const first = (await (await SELF.fetch(`${BASE}/v1/hitokoto?c=d`)).json()) as Hitokoto;
    invalidateMemoryCache();
    const second = (await (await SELF.fetch(`${BASE}/v1/hitokoto?c=d`)).json()) as Hitokoto;

    expect(first.uuid).toBe('q1');
    expect(first.id).toBe(second.id);
    expect(first.uuid).toBe(second.uuid);
  });

  it('无匹配结果时返回 404', async () => {
    const res = await SELF.fetch(`${BASE}/v1/hitokoto?min_length=1000`);
    expect(res.status).toBe(404);
  });
});
