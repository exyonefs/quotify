#!/usr/bin/env node
/**
 * 统一 data/*.json 中引语的 id 排列。
 *
 * 做三件事：
 * 1. 把每条引语的 id 重新派生为**固定 8 位小写十六进制**（FNV-1a 32 位，
 *    种子 = content + author + source）：同一份数据重复执行结果完全一致；
 * 2. 全局去重（跨文件也不重复），冲突时按确定性盐值继续派生；
 * 3. 每个文件内按 id 升序排列，并用项目自己的 Prettier 配置格式化。
 *
 * 只有内容真正发生变化时才回写文件，并把该文件的 `updated_at` 更新为当前时间，
 * 因此脚本可以反复执行（幂等），也可以放进 CI 用 `--check` 做校验。
 *
 * 用法：
 *   node scripts/normalize-ids.mjs           # 写入
 *   node scripts/normalize-ids.mjs --check   # 只检查，未规范化时以 1 退出
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const dataDir = path.join(projectRoot, 'data');
const CHECK_ONLY = process.argv.includes('--check');
const SHOW_HELP = process.argv.includes('--help') || process.argv.includes('-h');

/** FNV-1a 32 位 → 8 位十六进制。与 Worker 端的 `fingerprint` 保持同一算法。 */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** id 的派生种子：正文 + 作者 + 出处，任一变化都会得到新 id。 */
function seedOf(quote) {
  return [quote.content, quote.author ?? '', quote.source ?? ''].join('\u0000');
}

/** 与数据文件现有格式保持一致：秒级 ISO 8601（不带毫秒）。 */
function timestampNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (SHOW_HELP) {
  console.log(
    [
      '用法：node scripts/normalize-ids.mjs [--check]',
      '',
      '  --check   只检查 data/*.json 的 id 是否已规范化，不写入文件',
      '  --help    显示本帮助',
    ].join('\n'),
  );
  process.exit(0);
}

const names = (await readdir(dataDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
  .map((entry) => entry.name)
  .sort();

if (names.length === 0) {
  fail(`未在 ${dataDir} 下找到任何 .json 数据文件。`);
}

const files = [];
for (const name of names) {
  const filePath = path.join(dataDir, name);
  const raw = await readFile(filePath, 'utf8');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`${name} 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail(`${name} 的根节点必须是对象。`);
  }
  if (!Array.isArray(parsed.quotes)) {
    fail(`${name} 缺少 quotes 数组。`);
  }

  const quotes = parsed.quotes.map((quote, index) => {
    if (typeof quote !== 'object' || quote === null || Array.isArray(quote)) {
      fail(`${name} 的第 ${index} 条记录不是对象。`);
    }
    if (typeof quote.content !== 'string' || quote.content.length === 0) {
      fail(`${name} 的第 ${index} 条记录缺少非空 content。`);
    }
    return { ...quote };
  });

  files.push({
    name,
    filePath,
    raw,
    version: typeof parsed.version === 'number' ? parsed.version : 1,
    updatedAt: typeof parsed.updated_at === 'string' ? parsed.updated_at : timestampNow(),
    quotes,
  });
}

// 全局按种子排序后再分配 id：结果与文件顺序、数组顺序、执行时间都无关。
const entries = [];
for (const file of files) {
  for (const quote of file.quotes) {
    entries.push({ quote, seed: seedOf(quote) });
  }
}
entries.sort((left, right) => (left.seed < right.seed ? -1 : left.seed > right.seed ? 1 : 0));

const used = new Set();
for (const entry of entries) {
  let attempt = 0;
  let id = fnv1a(entry.seed);
  while (used.has(id)) {
    attempt += 1;
    id = fnv1a(`${entry.seed}\u0000${attempt}`);
  }
  used.add(id);
  entry.quote.id = id;
}

/** 只保留已知字段，并丢掉空字符串 / 空数组，输出结构固定的对象。 */
function normalizeQuote(quote) {
  const result = { id: quote.id, content: quote.content };

  for (const key of ['source', 'author', 'category']) {
    const value = quote[key];
    if (typeof value === 'string' && value.length > 0) result[key] = value;
  }
  if (Array.isArray(quote.tags) && quote.tags.length > 0) {
    result.tags = quote.tags.filter((tag) => typeof tag === 'string' && tag.length > 0);
    if (result.tags.length === 0) delete result.tags;
  }
  return result;
}

async function render(file, updatedAt) {
  const payload = {
    version: file.version,
    updated_at: updatedAt,
    quotes: file.quotes
      .slice()
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map(normalizeQuote),
  };
  const text = JSON.stringify(payload, null, 2);
  return prettier.format(text, { filepath: file.filePath });
}

const changedFiles = [];
let totalQuotes = 0;

for (const file of files) {
  totalQuotes += file.quotes.length;
  const current = await render(file, file.updatedAt);
  if (current === file.raw) continue;

  changedFiles.push(file.name);
  if (CHECK_ONLY) continue;

  const next = await render(file, timestampNow());
  await writeFile(file.filePath, next, 'utf8');
}

if (CHECK_ONLY) {
  if (changedFiles.length > 0) {
    console.error(`✗ 以下文件的 id 尚未规范化：${changedFiles.join('、')}`);
    console.error('  执行 `npm run data:ids` 修复。');
    process.exit(1);
  }
  console.log(`✓ ${files.length} 个文件、${totalQuotes} 条引语的 id 均为规范格式。`);
} else if (changedFiles.length === 0) {
  console.log(`✓ 无需修改：${files.length} 个文件、${totalQuotes} 条引语的 id 已规范。`);
} else {
  console.log(`✓ 已规范化 ${changedFiles.length} 个文件（共 ${totalQuotes} 条引语）：`);
  for (const name of changedFiles) console.log(`  - ${name}`);
}
