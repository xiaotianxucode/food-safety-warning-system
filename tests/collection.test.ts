import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { openDatabase, one, all, run, now, type DB } from '../server/db.js';
import { initialize, ingest, analyzeNews, setSetting, Worker } from '../server/service.js';
import { narrowInitialTaskToWeek } from '../server/maintenance.js';
import {
  createTask,
  executeTask,
  crawlState,
  weekBefore,
  windowContains,
} from '../server/collection.js';
let db: DB;
const source = 'https://news.foodmate.net/test/';
const base = '日本草莓检出残留农药不合格，涉事产品退运。此处为独立验证使用的新闻正文材料。';
beforeEach(() => {
  db = openDatabase(':memory:');
  initialize(db);
  setSetting(db, 'crawler', { intervalHours: 24, sources: [source] });
});
afterEach(() => {
  vi.useRealTimers();
  db.close();
});
const article = (date: string, body: string) =>
  `<h1>采集测试新闻</h1><div>时间：${date}</div><div id="article"><p>${body}</p></div>`;
const entry = (id: number, date: string) =>
  `<li class="catlist_li"><span>${date}</span><a href="https://news.foodmate.net/2026/10/${id}.html">新闻${id}</a></li>`;
const none = async () => ({ shouldWarn: false, summary: '这是样例，无需预警', alerts: [] });
it('收窄旧首次任务时删除一周前新闻及预警，保留一周内已完成结果和待分析队列', async () => {
  const job = createTask(db, 'manual', undefined, '2026-10-27T04:00:00.000Z');
  const summary = JSON.parse(one(db, 'SELECT summary FROM jobs WHERE id=?', job)!.summary);
  run(
    db,
    'UPDATE jobs SET summary=? WHERE id=?',
    JSON.stringify({ ...summary, windowStart: '2026-07-27T04:00:00.000Z', initialDays: undefined }),
    job,
  );
  const ids: number[] = [];
  for (let i = 0; i < 3; i++) {
    const pub = [
      '2026-10-10T03:00:00.000Z',
      '2026-10-25T03:00:00.000Z',
      '2026-10-26T03:00:00.000Z',
    ][i];
    const n = ingest(
      db,
      { title: `测试新闻${i}`, body: base + i, publishedAt: pub },
      `https://news.foodmate.net/2026/10/${85000 + i}.html`,
    );
    ids.push(n.id);
    if (i < 2)
      await analyzeNews(db, n.id, async () => ({
        shouldWarn: true,
        summary: '不合格食品',
        alerts: [
          {
            food: '草莓',
            region: '日本',
            company: '',
            batch: '',
            factor: '农药残留不合格',
            impact: '涉事产品退运',
            advice: '关注涉事批次',
            evidence: '日本草莓检出残留农药不合格，涉事产品退运',
            seasoning: false,
          },
        ],
      }));
    const analysis = one(db, 'SELECT id FROM analyses WHERE news_id=?', n.id);
    run(
      db,
      "INSERT INTO task_items(job_id,url,news_id,published_at,result,model_status,analysis_id) VALUES(?,?,?,?,'new',?,?)",
      job,
      `https://news.foodmate.net/2026/10/${85000 + i}.html`,
      n.id,
      pub,
      i < 2 ? 'warning' : 'pending',
      analysis?.id || null,
    );
  }
  run(
    db,
    "INSERT INTO users(username,password_hash,role,created_at) VALUES('reader','test','user',?)",
    now(),
  );
  run(db, 'INSERT INTO reads VALUES(1,1,?)', now());
  run(db, "INSERT INTO reanalysis_queue VALUES(?,?,'completed',NULL)", job, ids[0]);
  const result = narrowInitialTaskToWeek(db, job);
  expect(result).toMatchObject({
    removedNews: 1,
    removedAlerts: 1,
    remainingNews: 2,
    remainingAlerts: 1,
    start: '2026-10-20T04:00:00.000Z',
  });
  expect(one(db, 'SELECT id FROM news WHERE id=?', ids[0])).toBeUndefined();
  expect(all(db, 'SELECT * FROM reads')).toHaveLength(0);
  expect(all(db, 'SELECT * FROM sources')).toHaveLength(2);
  expect(all(db, 'SELECT * FROM reanalysis_queue')).toHaveLength(0);
  expect(one(db, 'SELECT status FROM news WHERE id=?', ids[1])?.status).toBe('published');
  expect(JSON.parse(one(db, 'SELECT summary FROM jobs WHERE id=?', job)!.summary)).toMatchObject({
    initialDays: 7,
    added: 2,
    warningArticles: 1,
    modelPending: 1,
  });
  expect(one(db, "SELECT value FROM settings WHERE key='feedGeneration'")?.value).toBe('1');
  narrowInitialTaskToWeek(db, job, '2026-10-28T04:00:00.000Z');
  expect(JSON.parse(one(db, 'SELECT summary FROM jobs WHERE id=?', job)!.summary)).toMatchObject({
    windowStart: '2026-10-21T04:00:00.000Z',
    windowEnd: '2026-10-28T04:00:00.000Z',
    phase: 'scanning',
  });
  expect(all(db, "SELECT * FROM task_pages WHERE job_id=? AND status='pending'", job)).toHaveLength(
    1,
  );
});
function hooks(fetcher: (url: string) => Promise<string>, analyzer: any = none) {
  return {
    fetcher,
    ingest: (a: any, u: string) => ingest(db, a, u, true),
    analyze: (id: number, prompt: number) => analyzeNews(db, id, analyzer, prompt),
    pause: async () => {},
  };
}
it('首次范围为连续7天，增量窗口左开右闭', () => {
  expect(weekBefore('2026-05-31T04:00:00.000Z')).toBe('2026-05-24T04:00:00.000Z');
  expect(weekBefore('2024-05-31T04:00:00.000Z')).toBe('2024-05-24T04:00:00.000Z');
  expect(
    windowContains(
      '2026-10-27T04:00:00.000Z',
      '2026-10-28T04:00:00.000Z',
      '2026-10-27T04:00:00.000Z',
      false,
    ),
  ).toBe(false);
  expect(
    windowContains(
      '2026-10-27T04:00:00.000Z',
      '2026-10-28T04:00:00.000Z',
      '2026-10-28T04:00:00.000Z',
      false,
    ),
  ).toBe(true);
});
it('首次自动翻过10页，处理超过200篇，遇到一周边界停止', async () => {
  const pages = new Map<string, string>();
  for (let p = 1; p <= 14; p++) {
    const first = (p - 1) * 15;
    const rows = Array.from({ length: Math.min(15, 205 - first) }, (_, i) =>
      entry(80000 + first + i, '2026-10-23 12:00'),
    ).join('');
    pages.set(
      p === 1 ? source : `${source}list_${p}.html`,
      rows + `<a href="${source}list_${p + 1}.html">下一页»</a>`,
    );
  }
  pages.set(
    `${source}list_15.html`,
    entry(99999, '2026-06-01 12:00') + `<a href="${source}list_16.html">下一页»</a>`,
  );
  const fetcher = vi.fn(async (url: string) => {
    if (pages.has(url)) return pages.get(url)!;
    const id = url.match(/\/(\d+)\.html$/)?.[1];
    if (id && id !== '99999') return article('2026-10-23 12:00', base + id);
    throw Error('不应请求：' + url);
  });
  const model = vi.fn(none);
  const job = createTask(db, 'manual', undefined, '2026-10-27T04:00:00.000Z');
  await executeTask(db, job, hooks(fetcher, model));
  const summary = JSON.parse(one(db, 'SELECT summary FROM jobs WHERE id=?', job)!.summary);
  expect(summary).toMatchObject({
    collected: 205,
    deduplicated: 0,
    added: 205,
    noWarning: 205,
    modelFailed: 0,
    pages: 15,
    mode: 'initial',
    windowStart: '2026-10-20T04:00:00.000Z',
  });
  expect(model).toHaveBeenCalledTimes(205);
  expect(fetcher.mock.calls.some(([u]) => u.includes('list_16') || u.includes('99999'))).toBe(
    false,
  );
  expect(crawlState(db)).toMatchObject({
    initialized: true,
    lastSuccessEnd: '2026-10-27T04:00:00.000Z',
    nextRunAt: '2026-10-28T04:00:00.000Z',
  });
});
it('按成功截止时刻增量采集，正文重复计入去重，旧新闻不反复读正文', async () => {
  setSetting(db, 'crawlState', {
    initialized: true,
    lastSuccessEnd: '2026-10-27T04:00:00.000Z',
    nextRunAt: '2026-10-28T04:00:00.000Z',
  });
  const listing =
    entry(81000, '2026-10-27 12:00') +
    entry(81001, '2026-10-27 13:00') +
    entry(81002, '2026-10-27 13:01') +
    entry(81003, '2026-10-28 12:01');
  const fetcher = vi.fn(async (url: string) =>
    url === source ? listing : article('2026-10-27 13:00', base),
  );
  const job = createTask(db, 'manual', undefined, '2026-10-28T04:00:00.000Z');
  await executeTask(db, job, hooks(fetcher));
  const s = JSON.parse(one(db, 'SELECT summary FROM jobs WHERE id=?', job)!.summary);
  expect(s).toMatchObject({
    collected: 2,
    deduplicated: 1,
    added: 1,
    noWarning: 1,
    outside: 2,
    mode: 'incremental',
  });
  expect(s.collected - s.deduplicated).toBe(s.added);
  expect(all(db, 'SELECT * FROM sources')).toHaveLength(2);
  expect(fetcher).toHaveBeenCalledTimes(3);
  const again = createTask(db, 'manual', undefined, '2026-10-28T04:00:30.000Z');
  fetcher.mockClear();
  await executeTask(db, again, hooks(fetcher));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(one(db, 'SELECT summary FROM jobs WHERE id=?', again)!.summary)).toMatchObject({
    collected: 0,
    added: 0,
  });
});
it('来源读取失败不推进截止时刻，首次范围下限不会随着重试向后滑动', async () => {
  const job = createTask(db, 'manual', undefined, '2026-10-27T04:00:00.000Z');
  await executeTask(
    db,
    job,
    hooks(async () => {
      throw Error('HTTP 503');
    }),
  );
  expect(crawlState(db).lastSuccessEnd).toBeNull();
  expect(one(db, 'SELECT status FROM jobs WHERE id=?', job)?.status).toBe('failed');
  const next = createTask(db, 'manual', undefined, '2026-10-28T04:00:00.000Z');
  expect(
    JSON.parse(one(db, 'SELECT summary FROM jobs WHERE id=?', next)!.summary).windowStart,
  ).toBe('2026-10-20T04:00:00.000Z');
});
it('HTTP成功但返回验证码等无有效列表页面时不能推进边界', async () => {
  const job = createTask(db, 'manual', undefined, '2026-10-27T04:00:00.000Z');
  await executeTask(
    db,
    job,
    hooks(async () => '<html><h1>请完成验证码</h1></html>'),
  );
  expect(crawlState(db).lastSuccessEnd).toBeNull();
  expect(one(db, 'SELECT status FROM jobs WHERE id=?', job)?.status).toBe('failed');
  expect(JSON.parse(one(db, 'SELECT summary FROM jobs WHERE id=?', job)!.summary).pageFailed).toBe(
    1,
  );
});
it('首页没有日期的窗口外链接保存日期元数据，下轮不反复下载正文', async () => {
  const listing = '<a href="https://news.foodmate.net/2026/06/84000.html">旧新闻</a>';
  const fetcher = vi.fn(async (url: string) =>
    url === source ? listing : article('2026-06-01 12:00', base),
  );
  const first = createTask(db, 'manual', undefined, '2026-10-27T04:00:00.000Z');
  await executeTask(db, first, hooks(fetcher));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(all(db, 'SELECT * FROM news')).toHaveLength(0);
  fetcher.mockClear();
  const second = createTask(db, 'manual', undefined, '2026-10-28T04:00:00.000Z');
  await executeTask(db, second, hooks(fetcher));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(one(db, 'SELECT summary FROM jobs WHERE id=?', second)!.summary)).toMatchObject(
    { collected: 0, added: 0, outside: 1 },
  );
});
it('模型失败仍保存采集边界，独立模型重试不抓网页、不清除预警、不改变边界', async () => {
  vi.useFakeTimers();
  const listing = entry(82000, '2026-10-27 11:00');
  const job = createTask(db, 'manual', undefined, '2026-10-27T04:00:00.000Z');
  const task = executeTask(
    db,
    job,
    hooks(
      async (url) => (url === source ? listing : article('2026-10-27 11:00', base)),
      async () => {
        throw Error('模型超时');
      },
    ),
  );
  await vi.runAllTimersAsync();
  await task;
  expect(crawlState(db).lastSuccessEnd).toBe('2026-10-27T04:00:00.000Z');
  expect(JSON.parse(one(db, 'SELECT summary FROM jobs WHERE id=?', job)!.summary)).toMatchObject({
    added: 1,
    modelFailed: 1,
  });
  const news = one(db, 'SELECT * FROM news')!;
  expect(news.status).toBe('analysis_failed');
  const state = JSON.stringify(crawlState(db));
  const retry = createTask(db, 'model_retry', [news.id], '2026-10-27T05:00:00.000Z');
  const fetcher = vi.fn(async () => {
    throw Error('不应抓取');
  });
  await executeTask(db, retry, hooks(fetcher));
  expect(fetcher).not.toHaveBeenCalled();
  expect(JSON.stringify(crawlState(db))).toBe(state);
  expect(JSON.parse(one(db, 'SELECT summary FROM jobs WHERE id=?', retry)!.summary)).toMatchObject({
    noWarning: 1,
    modelFailed: 0,
  });
  expect(all(db, 'SELECT * FROM alerts')).toHaveLength(0);
});
it('新版中断任务恢复相同ID，已入库文章不误算去重或重复调用成功模型', async () => {
  const job = createTask(db, 'manual', undefined, '2026-10-27T04:00:00.000Z');
  run(db, "UPDATE task_pages SET status='completed' WHERE job_id=?", job);
  const n = ingest(
    db,
    { title: '断点新闻', body: base, publishedAt: '2026-10-27T03:00:00.000Z' },
    'https://news.foodmate.net/2026/10/83000.html',
  );
  run(
    db,
    "INSERT INTO task_items(job_id,url,news_id,published_at,result,model_status) VALUES(?,?,?,?,'new','pending')",
    job,
    'https://news.foodmate.net/2026/10/83000.html',
    n.id,
    '2026-10-27T03:00:00.000Z',
  );
  const fetcher = vi.fn(async () => '<html/>');
  const model = vi.fn(none);
  const worker = new Worker(db, fetcher, model);
  expect(worker.resetAnalysis()).toBeUndefined();
  expect(worker.launch()).toBe(true);
  await worker.stop();
  expect(all(db, 'SELECT id FROM jobs')).toHaveLength(1);
  expect(model).toHaveBeenCalledTimes(1);
  expect(fetcher).not.toHaveBeenCalled();
  expect(JSON.parse(one(db, 'SELECT summary FROM jobs WHERE id=?', job)!.summary)).toMatchObject({
    collected: 1,
    deduplicated: 0,
    added: 1,
    noWarning: 1,
  });
});
