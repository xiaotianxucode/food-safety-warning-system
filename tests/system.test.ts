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
        JSON.stringify({ ...output.alerts[0], summary: '测试样例' }),
        now(),
      );
    const agent = request.agent(createApp(db));
    await agent.post('/api/login').send({ username: 'reader', password: 'test-password-2026' });
    const first = (await agent.get('/api/alerts?after=1')).body;
    expect(first.items).toHaveLength(100);
    expect(first.items[0].id).toBe(2);
    expect(first.cursor).toBe(101);
    expect(first.hasMore).toBe(true);
    const second = (await agent.get('/api/alerts?after=101')).body;
    expect(second.cursor).toBe(201);
    expect(second.hasMore).toBe(true);
    const last = (await agent.get('/api/alerts?after=201')).body;
    expect(last.items).toHaveLength(4);
    expect(last.hasMore).toBe(false);
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
