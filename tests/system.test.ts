import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { openDatabase, one, all, run, now, type DB } from '../server/db.js';
import { createApp } from '../server/app.js';
import { initialize, ingest, analyzeNews, Worker } from '../server/service.js';
import { hashPassword } from '../server/auth.js';
import { validateAnalysis, callModel } from '../server/model.js';
import { canonicalUrl, extractArticle, extractLinks } from '../server/crawler.js';
const body =
  '台湾食药署通报，日本草莓检出残留农药不合格，涉事批次退运。另有马来西亚白胡椒粒检出农药残留，不合格批次销毁。';
const output = {
  shouldWarn: true,
  summary: '边境查验发现两个食品批次不合格。',
  alerts: [
    {
      food: '草莓',
      region: '日本',
      company: '',
      batch: '',
      factor: '检出残留农药不合格',
      impact: '涉事批次退运',
      advice: '关注涉事批次',
      evidence: '日本草莓检出残留农药不合格，涉事批次退运',
      seasoning: false,
    },
    {
      food: '白胡椒粒',
      region: '马来西亚',
      company: '',
      batch: '',
      factor: '检出农药残留',
      impact: '不合格批次销毁',
      advice: '关注涉事批次',
      evidence: '马来西亚白胡椒粒检出农药残留，不合格批次销毁',
      seasoning: true,
    },
  ],
};
let db: DB;
beforeEach(() => {
  db = openDatabase(':memory:');
  initialize(db);
});
afterEach(() => db.close());
function addNews() {
  return ingest(
    db,
    { title: '边境不合格名单（测试样例）', body, publishedAt: now() },
    'https://news.foodmate.net/2026/10/12345.html',
  ).id;
}
function addUser(username = 'reader', role = 'user') {
  return Number(
    run(
      db,
      'INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)',
      username,
      hashPassword('test-password-2026'),
      role,
      now(),
    ).lastInsertRowid,
  );
}
describe('新闻与模型处理', () => {
  it('重置清除所有旧预警，仅分析发布时间达标的文章，固定提示词且不受单次采集上限限制', async () => {
    const uid = addUser();
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) {
      const n = ingest(
        db,
        {
          title: `新闻${i}`,
          body: body + `附注${i}`,
          publishedAt: [
            '2026-10-26T15:59:59.999Z',
            '2026-10-26T16:00:00.000Z',
            null,
            '2026-10-27T16:00:00.000Z',
          ][i],
        },
        `https://news.foodmate.net/2026/10/${60000 + i}.html`,
      );
      ids.push(n.id);
      await analyzeNews(db, n.id, async () => validateAnalysis(output, body));
    }
    const oldMax = one(db, 'SELECT MAX(id) AS id FROM alerts')!.id;
    run(db, 'INSERT INTO reads VALUES(?,?,?)', uid, 1, now());
    run(db, 'INSERT INTO notifications VALUES(?,?)', uid, oldMax);
    const cfg = JSON.parse(one(db, "SELECT value FROM settings WHERE key='crawler'")!.value);
    run(
      db,
      "UPDATE settings SET value=? WHERE key='crawler'",
      JSON.stringify({ ...cfg, maxArticles: 1 }),
    );
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const model = vi.fn(async () => {
      await gate;
      return validateAnalysis(output, body);
    });
    const worker = new Worker(db, async () => '<html/>', model);
    expect(worker.resetPreview('2026-10-26T16:00:00.000Z').eligible).toBe(2);
    const reset = worker.resetAnalysis('2026-10-26T16:00:00.000Z')!;
    expect(reset.deletedAlerts).toBe(8);
    expect(all(db, 'SELECT * FROM alerts')).toHaveLength(0);
    expect(all(db, 'SELECT * FROM reads')).toHaveLength(0);
    expect(one(db, 'SELECT status FROM news WHERE id=?', ids[0])?.status).toBe('reset_excluded');
    expect(one(db, 'SELECT status FROM news WHERE id=?', ids[2])?.status).toBe('reset_excluded');
    expect(new Worker(db, undefined, model).resetAnalysis()).toBeUndefined();
    run(db, 'INSERT INTO prompts(content,created_at) VALUES(?,?)', '执行中新增的提示词版本', now());
    finish();
    await worker.stop();
    expect(model).toHaveBeenCalledTimes(2);
    expect(one(db, 'SELECT MIN(id) AS id FROM alerts')!.id).toBeGreaterThan(oldMax);
    expect(all(db, 'SELECT * FROM alerts')).toHaveLength(4);
    expect(
      all(db, 'SELECT prompt_id FROM analyses ORDER BY id DESC LIMIT 2').every(
        (a) => a.prompt_id === 1,
      ),
    ).toBe(true);
    expect(one(db, 'SELECT status FROM jobs WHERE id=?', reset.jobId)?.status).toBe('completed');
    expect(
      JSON.parse(one(db, 'SELECT summary FROM jobs WHERE id=?', reset.jobId)!.summary),
    ).toMatchObject({ total: 2, completed: 2, failed: 0, processed: 2 });
    expect(all(db, 'SELECT * FROM sources')).toHaveLength(4);
    expect(one(db, "SELECT value FROM settings WHERE key='feedGeneration'")?.value).toBe('1');
  });
  it('空范围不清除预警，有任务锁时不允许重置', async () => {
    const id = addNews();
    await analyzeNews(db, id, async () => validateAnalysis(output, body));
    const worker = new Worker(db, undefined, async () => validateAnalysis(output, body));
    expect(() => worker.resetAnalysis('2099-01-01T00:00:00.000Z')).toThrow('没有正文完整');
    expect(all(db, 'SELECT * FROM alerts')).toHaveLength(2);
    expect(all(db, 'SELECT * FROM locks')).toHaveLength(0);
    run(
      db,
      "INSERT INTO locks VALUES('worker','other',?)",
      new Date(Date.now() + 60000).toISOString(),
    );
    expect(worker.resetAnalysis()).toBeUndefined();
    expect(all(db, 'SELECT * FROM alerts')).toHaveLength(2);
  });
  it('重启继续重置队列，保留已重新生成的预警且不再次清空', async () => {
    const id = addNews();
    await analyzeNews(db, id, async () => validateAnalysis(output, body));
    const second = ingest(
      db,
      { title: '第二篇', body: body + '第二篇附注', publishedAt: now() },
      'https://news.foodmate.net/2026/10/77777.html',
    ).id;
    run(db, "UPDATE news SET status='analyzing' WHERE id=?", second);
    run(
      db,
      "INSERT INTO analyses(news_id,status,model,prompt_id,created_at) VALUES(?,'running','test',1,?)",
      second,
      now(),
    );
    const job = Number(
      run(
        db,
        "INSERT INTO jobs(kind,status,started_at,summary) VALUES('analysis_reset','running',?,?)",
        now(),
        JSON.stringify({
          total: 2,
          completed: 1,
          failed: 0,
          processed: 1,
          promptId: 1,
          deletedAlerts: 2,
        }),
      ).lastInsertRowid,
    );
    run(db, "INSERT INTO reanalysis_queue VALUES(?,?,'completed',NULL)", job, id);
    run(db, "INSERT INTO reanalysis_queue VALUES(?,?,'running',NULL)", job, second);
    run(db, "INSERT INTO settings VALUES('feedGeneration','1')");
    const model = vi.fn(async () => ({ shouldWarn: false, summary: '未发现具体风险', alerts: [] }));
    const fetcher = vi.fn(async () => '<html/>');
    const worker = new Worker(db, fetcher, model);
    expect(worker.launch()).toBe(true);
    await worker.stop();
    expect(model).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(all(db, 'SELECT id FROM alerts ORDER BY id').map((a) => a.id)).toEqual([1, 2]);
    expect(one(db, "SELECT value FROM settings WHERE key='feedGeneration'")?.value).toBe('1');
    expect(one(db, 'SELECT status FROM jobs WHERE id=?', job)?.status).toBe('completed');
    expect(JSON.parse(one(db, 'SELECT summary FROM jobs WHERE id=?', job)!.summary)).toMatchObject({
      total: 2,
      completed: 2,
      processed: 2,
    });
  });
  it('不按关键词预先筛除新闻，模型判定无需预警时不发布', async () => {
    const text = '本周举办年度交流会，介绍新品与行业动态，正文未披露具体异常事件。';
    const { id } = ingest(
      db,
      { title: '年度交流活动', body: text, publishedAt: now() },
      'https://news.foodmate.net/2026/10/54321.html',
    );
    expect(one(db, 'SELECT status FROM news WHERE id=?', id)?.status).toBe('pending');
    const model = vi.fn(async () => ({
      shouldWarn: false,
      summary: '交流活动及新品介绍，没有具体风险事实，无需预警。',
      alerts: [],
    }));
    await analyzeNews(db, id, model);
    expect(model).toHaveBeenCalledTimes(1);
    expect(all(db, 'SELECT * FROM alerts')).toHaveLength(0);
    expect(one(db, 'SELECT status FROM news WHERE id=?', id)?.status).toBe('no_warning');
  });
  it('升级时恢复旧关键词筛除的新闻，并保留开发者自定义提示词', () => {
    run(db, 'DELETE FROM migrations WHERE version=2');
    run(db, 'INSERT INTO prompts(content,created_at) VALUES(?,?)', '开发者自定义分析要求', now());
    const id = addNews();
    run(db, "UPDATE news SET status='filtered' WHERE id=?", id);
    initialize(db);
    initialize(db);
    expect(one(db, 'SELECT status FROM news WHERE id=?', id)?.status).toBe('pending');
    expect(one(db, 'SELECT content FROM prompts ORDER BY id DESC LIMIT 1')?.content).toBe(
      '开发者自定义分析要求',
    );
    expect(all(db, 'SELECT version FROM migrations WHERE version=2')).toHaveLength(1);
  });
  it('提取新闻正文、表格、时间和链接，不采集站外链接', () => {
    const html =
      '<h1>抽检通报</h1><div>时间：2026-10-27 10:30</div><div id="article"><p>日本草莓抽检不合格，涉事批次退运销毁处理。</p><table><tr><td>白胡椒粒</td><td>残留农药</td></tr></table></div><a href="/2026/10/12345.html">详情</a><a href="https://evil.example/2026/10/12345.html">站外</a>';
    const a = extractArticle(html);
    expect(a.body).toContain('白胡椒粒 |');
    expect(a.publishedAt).toBe('2026-10-27T02:30:00.000Z');
    expect(extractLinks(html, 'https://news.foodmate.net/')).toHaveLength(1);
    expect(() => canonicalUrl('file:///etc/passwd')).toThrow();
  });
  it('同链接及相同正文跨链接不重复分析，保留来源', async () => {
    const id = addNews();
    expect(addNews()).toBe(id);
    const duplicate = ingest(
      db,
      { title: '转载新闻', body, publishedAt: now() },
      'https://fsc.foodmate.net/show.php?itemid=12345',
    );
    expect(duplicate.inserted).toBe(false);
    expect(all(db, 'SELECT * FROM news')).toHaveLength(1);
    expect(all(db, 'SELECT * FROM sources')).toHaveLength(2);
    const model = vi.fn(async () => validateAnalysis(output, body));
    await analyzeNews(db, id, model);
    await analyzeNews(db, id, model);
    expect(model).toHaveBeenCalledTimes(1);
    expect(all(db, 'SELECT * FROM alerts')).toHaveLength(2);
    expect(one(db, 'SELECT prompt_id,model FROM analyses')?.prompt_id).toBe(1);
  });
  it('无风险新闻不发布；未获取正文不能分析', async () => {
    const id = addNews();
    await analyzeNews(db, id, async () => ({
      shouldWarn: false,
      summary: '没有明确风险',
      alerts: [],
    }));
    expect(all(db, 'SELECT * FROM alerts')).toHaveLength(0);
    expect(one(db, 'SELECT status FROM news WHERE id=?', id)?.status).toBe('no_warning');
    const empty = Number(
      run(db, "INSERT INTO news(title,status,created_at) VALUES('缺正文','pending',?)", now())
        .lastInsertRowid,
    );
    await expect(analyzeNews(db, empty)).rejects.toThrow('正文缺失');
  });
  it('阻止伪造证据、产地和矛盾的预警判定', () => {
    expect(() =>
      validateAnalysis(
        { ...output, alerts: [{ ...output.alerts[0], evidence: '日本草莓全部不合格' }] },
        body,
      ),
    ).toThrow();
    expect(() =>
      validateAnalysis({ ...output, alerts: [{ ...output.alerts[0], region: '美国' }] }, body),
    ).toThrow();
    expect(() => validateAnalysis({ ...output, shouldWarn: false }, body)).toThrow();
  });
  it('模型失败有限重试并保存错误', async () => {
    const id = addNews();
    const model = vi.fn(async () => {
      throw new Error('模型请求超时');
    });
    vi.useFakeTimers();
    const p = analyzeNews(db, id, model);
    await vi.runAllTimersAsync();
    await p;
    vi.useRealTimers();
    expect(model).toHaveBeenCalledTimes(3);
    expect(one(db, 'SELECT status,error FROM news WHERE id=?', id)).toMatchObject({
      status: 'analysis_failed',
      error: '模型请求超时',
    });
  });
  it('模型请求返回非法 JSON 时拒绝发布', async () => {
    const previous = process.env.MODEL_API_KEY;
    process.env.MODEL_API_KEY = 'test-only';
    try {
      await expect(
        callModel(
          'test',
          body,
          vi.fn(
            async () =>
              new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), {
                status: 200,
              }),
          ) as any,
        ),
      ).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env.MODEL_API_KEY;
      else process.env.MODEL_API_KEY = previous;
    }
  });
  it('工作进程持久锁阻止第二实例，重启恢复未完成分析', async () => {
    const id = addNews();
    run(db, "UPDATE news SET status='analyzing' WHERE id=?", id);
    run(db, "INSERT INTO jobs(kind,status,started_at) VALUES('manual','running',?)", now());
    const worker = new Worker(
      db,
      async () => '<html></html>',
      async () => validateAnalysis(output, body),
    );
    const second = new Worker(db);
    expect(worker.launch()).toBe(true);
    expect(second.launch()).toBe(false);
    await worker.stop();
    expect(one(db, 'SELECT status FROM news WHERE id=?', id)?.status).toBe('published');
    expect(one(db, 'SELECT status FROM jobs WHERE id=1')?.status).toBe('interrupted');
    expect(all(db, 'SELECT * FROM locks')).toHaveLength(0);
  });
});
describe('登录、权限和提醒', () => {
  it('重置仅开发者可用，要求确认，校验时间且异步返回进度', async () => {
    addUser();
    addUser('developer', 'developer');
    const id = addNews();
    await analyzeNews(db, id, async () => validateAnalysis(output, body));
    const worker = new Worker(db, undefined, async () => ({
      shouldWarn: false,
      summary: '重置后模型判定无需预警',
      alerts: [],
    }));
    const app = createApp(db, worker);
    const user = request.agent(app);
    const admin = request.agent(app);
    await user.post('/api/login').send({ username: 'reader', password: 'test-password-2026' });
    await admin.post('/api/login').send({ username: 'developer', password: 'test-password-2026' });
    await user.get('/api/admin/analysis-reset/preview').expect(403);
    await user.post('/api/admin/analysis-reset').send({ confirmed: true }).expect(403);
    await admin.post('/api/admin/analysis-reset').send({}).expect(400);
    await admin
      .post('/api/admin/analysis-reset')
      .send({ confirmed: true, since: 'bad-date' })
      .expect(400);
    await admin
      .post('/api/admin/analysis-reset')
      .send({ confirmed: true, since: '2099-01-01T00:00:00.000Z' })
      .expect(400);
    expect(all(db, 'SELECT * FROM alerts')).toHaveLength(2);
    const preview = (await admin.get('/api/admin/analysis-reset/preview')).body;
    expect(preview).toMatchObject({ alerts: 2, eligible: 1 });
    const response = await admin
      .post('/api/admin/analysis-reset')
      .send({ confirmed: true })
      .expect(202);
    expect(response.body).toMatchObject({ deletedAlerts: 2, total: 1 });
    await worker.stop();
    const feed = (await user.get('/api/alerts?after=2')).body;
    expect(feed.generation).toBe(1);
    expect(feed.items).toHaveLength(0);
    const overview = (await admin.get('/api/admin/overview')).body;
    expect(overview.latestReset.status).toBe('completed');
    expect(JSON.parse(overview.latestReset.summary)).toMatchObject({
      processed: 1,
      completed: 1,
      failed: 0,
    });
  });
  it('按北京时间的起止日期筛选，分类数量与分页均限定在范围内', async () => {
    addUser();
    const id = addNews();
    await analyzeNews(db, id, async () => validateAnalysis(output, body));
    run(db, "UPDATE alerts SET published_at='2026-10-26T15:59:59.999Z' WHERE id=1");
    run(db, "UPDATE alerts SET published_at='2026-10-27T15:59:59.999Z' WHERE id=2");
    run(
      db,
      "INSERT INTO alerts(news_id,analysis_id,object_key,payload,published_at) SELECT news_id,analysis_id,'next-day',payload,'2026-10-27T16:00:00.000Z' FROM alerts WHERE id=1",
    );
    const agent = request.agent(createApp(db));
    await agent.post('/api/login').send({ username: 'reader', password: 'test-password-2026' });
    for (const paging of ['', '&after=1', '&before=3']) {
      const res = (await agent.get('/api/alerts?startDate=2026-10-27&endDate=2026-10-27' + paging))
        .body;
      expect(res.items.map((a: any) => a.id)).toEqual([2]);
      expect(res.counts).toEqual({ total: 1, seasoning: 1 });
      expect(res.filteredUnread).toBe(1);
    }
    expect((await agent.get('/api/alerts?startDate=2026-10-27')).body.items).toHaveLength(2);
    expect((await agent.get('/api/alerts?endDate=2026-10-27')).body.items).toHaveLength(2);
    await agent.post('/api/alerts/2/read');
    const read = (await agent.get('/api/alerts?startDate=2026-10-27&endDate=2026-10-27')).body;
    expect(read.filteredUnread).toBe(0);
    expect(read.unread).toBe(2);
    await agent.get('/api/alerts?startDate=2026-10-28&endDate=2026-10-27').expect(400);
    await agent.get('/api/alerts?startDate=2026-02-30').expect(400);
  });
  it('超过一页的新预警按发布序号增量补齐', async () => {
    addUser();
    const id = addNews();
    const analysis = Number(
      run(
        db,
        "INSERT INTO analyses(news_id,status,model,created_at) VALUES(?,'completed','test',?)",
        id,
        now(),
      ).lastInsertRowid,
    );
    for (let i = 0; i < 205; i++)
      run(
        db,
        'INSERT INTO alerts(news_id,analysis_id,object_key,payload,published_at) VALUES(?,?,?,?,?)',
        id,
        analysis,
        String(i),
        JSON.stringify({ ...output.alerts[0], summary: '测试样例', seasoning: i % 2 === 0 }),
        now(),
      );
    const agent = request.agent(createApp(db));
    await agent.post('/api/login').send({ username: 'reader', password: 'test-password-2026' });
    const first = (await agent.get('/api/alerts?after=1')).body;
    expect(first.items).toHaveLength(100);
    expect(first.items[0].id).toBe(2);
    expect(first.cursor).toBe(101);
    expect(first.hasMore).toBe(true);
    expect(first.counts).toEqual({ total: 205, seasoning: 103 });
    const second = (await agent.get('/api/alerts?after=101')).body;
    expect(second.cursor).toBe(201);
    expect(second.hasMore).toBe(true);
    const last = (await agent.get('/api/alerts?after=201')).body;
    expect(last.items).toHaveLength(4);
    expect(last.hasMore).toBe(false);
    expect(last.counts).toEqual({ total: 205, seasoning: 103 });
  });
  it('角色越权被阻止，采集错误不泄漏给普通用户', async () => {
    addUser();
    run(
      db,
      "INSERT INTO jobs(kind,status,started_at,error) VALUES('manual','failed',?,'内部详情')",
      now(),
    );
    const app = createApp(db);
    const user = request.agent(app);
    await user
      .post('/api/login')
      .send({ username: 'reader', password: 'test-password-2026' })
      .expect(200);
    await user.get('/api/admin/news').expect(403);
    await request(app).get('/api/alerts').expect(401);
    const feed = await user.get('/api/alerts').expect(200);
    expect(feed.body.lastJob.error).toBeUndefined();
    const id = addNews();
    await analyzeNews(db, id, async () => validateAnalysis(output, body));
    const detail = await user.get('/api/alerts/1').expect(200);
    expect(detail.body.sources).toEqual([
      { url: 'https://news.foodmate.net/2026/10/12345.html', title: '边境不合格名单（测试样例）' },
    ]);
  });
  it('离线消息持久保存，多标签页同时争取只提醒一次，阅读独立', async () => {
    const uid = addUser();
    const id = addNews();
    await analyzeNews(db, id, async () => validateAnalysis(output, body));
    const app = createApp(db);
    const user = request.agent(app);
    await user.post('/api/login').send({ username: 'reader', password: 'test-password-2026' });
    const [a, b] = await Promise.all([
      user.post('/api/notifications/claim'),
      user.post('/api/notifications/claim'),
    ]);
    expect([a.body.count, b.body.count].sort()).toEqual([0, 2]);
    expect((await user.get('/api/alerts')).body.unread).toBe(2);
    const alert = one(db, 'SELECT id FROM alerts ORDER BY id LIMIT 1')!.id;
    await user.post(`/api/alerts/${alert}/read`).expect(200);
    await user.post(`/api/alerts/${alert}/read`).expect(200);
    expect((await user.get('/api/alerts')).body.unread).toBe(1);
    expect(one(db, 'SELECT cursor FROM notifications WHERE user_id=?', uid)?.cursor).toBe(2);
    await user.post('/api/logout');
    await user.post('/api/login').send({ username: 'reader', password: 'test-password-2026' });
    expect((await user.post('/api/notifications/claim')).body.count).toBe(0);
  });
  it('停用账号立即使既有会话失效', async () => {
    const uid = addUser();
    addUser('developer', 'developer');
    const app = createApp(db);
    const user = request.agent(app);
    const admin = request.agent(app);
    await user.post('/api/login').send({ username: 'reader', password: 'test-password-2026' });
    await admin.post('/api/login').send({ username: 'developer', password: 'test-password-2026' });
    await admin.patch(`/api/admin/users/${uid}`).send({ active: false }).expect(200);
    await user.get('/api/me').expect(401);
  });
  it('撤下预警不再展示，拒绝站外修改请求', async () => {
    addUser('developer', 'developer');
    const id = addNews();
    await analyzeNews(db, id, async () => validateAnalysis(output, body));
    const app = createApp(db);
    const admin = request.agent(app);
    await admin.post('/api/login').send({ username: 'developer', password: 'test-password-2026' });
    await admin.post('/api/admin/alerts/1/withdraw').expect(200);
    expect((await admin.get('/api/alerts')).body.items).toHaveLength(1);
    expect((await admin.get('/api/alerts')).body.counts).toEqual({ total: 1, seasoning: 1 });
    await admin.get('/api/alerts/1').expect(404);
    await admin.post('/api/logout').set('Origin', 'https://external.example').expect(403);
  });
  it('提示词版本化，配置拒绝站外采集源', async () => {
    addUser('developer', 'developer');
    const admin = request.agent(createApp(db));
    await admin.post('/api/login').send({ username: 'developer', password: 'test-password-2026' });
    const cfg = (await admin.get('/api/admin/config')).body;
    await admin
      .put('/api/admin/config')
      .send({
        crawler: { ...cfg.crawler, sources: ['https://external.example'] },
        prompt: cfg.prompt.content,
      })
      .expect(400);
    await admin
      .put('/api/admin/config')
      .send({ crawler: cfg.crawler, prompt: cfg.prompt.content + '\n再次强调只分析原文。' })
      .expect(200);
    expect(all(db, 'SELECT * FROM prompts')).toHaveLength(2);
  });
});
