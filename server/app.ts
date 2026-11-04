import express from 'express';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { all, one, run, transaction, now, type DB } from './db.js';
import { hashPassword, verifyPassword, sessionToken, tokenHash } from './auth.js';
import { config, initialize, Worker, setSetting } from './service.js';
import { canonicalUrl } from './crawler.js';
import { callModel, modelName } from './model.js';
import { SOURCE_DEFINITIONS, sourceName } from './source-registry.js';
import { crawlState, saveCrawlState } from './collection.js';
import { failureCounts } from './failure-counts.js';
declare global {
  namespace Express {
    interface Request {
      user?: Record<string, any>;
    }
  }
}
export function createApp(db: DB, worker = new Worker(db)) {
  initialize(db);
  const app = express();
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'script-src': ["'self'"],
          'img-src': ["'self'", 'data:'],
          'style-src': ["'self'", "'unsafe-inline'"],
        },
      },
    }),
  );
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      if (origin && new URL(origin).host !== req.get('host')) {
        // Vite proxy preserves browser host
        return res.status(403).json({ error: '请求来源不匹配' });
      }
    }
    next();
  });
  const failures = new Map<string, { count: number; until: number }>();
  app.post('/api/login', (req, res) => {
    const input = z
      .object({ username: z.string().min(1).max(64), password: z.string().min(1).max(128) })
      .parse(req.body);
    const key = req.ip || 'local';
    const f = failures.get(key);
    if (f && f.until > Date.now() && f.count >= 10)
      return res.status(429).json({ error: '尝试次数过多，请 15 分钟后重试' });
    if (f && f.until < Date.now()) failures.delete(key);
    const user = one(db, 'SELECT * FROM users WHERE username=?', input.username);
    const matched = verifyPassword(
      input.password,
      user?.password_hash || hashPassword('dummy-password'),
    );
    if (!user || !user.active || !matched) {
      const old = failures.get(key);
      failures.set(key, { count: (old?.count || 0) + 1, until: Date.now() + 900000 });
      return res.status(401).json({ error: '账号或密码错误，或账号已停用' });
    }
    failures.delete(key);
    const token = sessionToken();
    run(db, 'DELETE FROM sessions WHERE expires_at<?', now());
    run(
      db,
      'INSERT INTO sessions VALUES(?,?,?)',
      tokenHash(token),
      user.id,
      new Date(Date.now() + 7 * 86400_000).toISOString(),
    );
    res.cookie('session', token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.COOKIE_SECURE === 'true' || req.secure,
      maxAge: 7 * 86400_000,
      path: '/',
    });
    res.json({ id: user.id, username: user.username, role: user.role });
  });
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', (req, res, next) => {
    const token = (req.headers.cookie || '')
      .split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith('session='))
      ?.slice(8);
    const user = token
      ? one(
          db,
          'SELECT u.id,u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>? AND u.active=1',
          tokenHash(token),
          now(),
        )
      : undefined;
    if (!user) return res.status(401).json({ error: '请先登录' });
    req.user = user;
    next();
  });
  app.get('/api/me', (req, res) => res.json(req.user));
  app.post('/api/logout', (req, res) => {
    const token = (req.headers.cookie || '')
      .split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith('session='))
      ?.slice(8);
    if (token) run(db, 'DELETE FROM sessions WHERE token=?', tokenHash(token));
    res.clearCookie('session', { path: '/' });
    res.json({ ok: true });
  });
  app.post('/api/password', (req, res) => {
    const input = z
      .object({ currentPassword: z.string().max(128), password: z.string().min(10).max(128) })
      .parse(req.body);
    const user = one(db, 'SELECT * FROM users WHERE id=?', req.user!.id)!;
    if (!verifyPassword(input.currentPassword, user.password_hash))
      return res.status(400).json({ error: '原密码错误' });
    transaction(db, () => {
      run(db, 'UPDATE users SET password_hash=? WHERE id=?', hashPassword(input.password), user.id);
      run(db, 'DELETE FROM sessions WHERE user_id=?', user.id);
    });
    res.clearCookie('session', { path: '/' }).json({ ok: true });
  });
  const parseId = (value: unknown) => z.coerce.number().int().positive().parse(value);
  const serialize = (a: any) => ({ ...a, payload: JSON.parse(a.payload) });
  app.get('/api/alerts', (req, res) => {
    const after = z.coerce.number().int().min(0).default(0).parse(req.query.after);
    const before = z.coerce.number().int().min(1).optional().parse(req.query.before);
    const dateSchema = z.iso.date().optional();
    const startDate = dateSchema.parse(req.query.startDate);
    const endDate = dateSchema.parse(req.query.endDate);
    if (startDate && endDate && startDate > endDate)
      return res.status(400).json({ error: '开始日期不能晚于结束日期' });
    const rangeParts: string[] = [];
    const rangeArgs: string[] = [];
    if (startDate) {
      rangeParts.push('a.published_at>=?');
      rangeArgs.push(new Date(`${startDate}T00:00:00+08:00`).toISOString());
    }
    if (endDate) {
      rangeParts.push('a.published_at<?');
      rangeArgs.push(new Date(Date.parse(`${endDate}T00:00:00+08:00`) + 86400_000).toISOString());
    }
    const rangeSql = rangeParts.length ? ' AND ' + rangeParts.join(' AND ') : '';
    const items = all(
      db,
      `SELECT a.*, CASE WHEN r.alert_id IS NULL THEN 0 ELSE 1 END AS is_read FROM alerts a LEFT JOIN reads r ON r.alert_id=a.id AND r.user_id=? WHERE a.withdrawn=0 AND a.id>? ${
        before ? 'AND a.id<?' : ''
      } ${rangeSql} ORDER BY a.id ${after > 0 ? 'ASC' : 'DESC'} LIMIT 100`,
      req.user!.id,
      after,
      ...(before ? [before] : []),
      ...rangeArgs,
    ).map(serialize);
    const job = one(
      db,
      "SELECT status,started_at,finished_at FROM jobs WHERE kind IN ('manual','scheduled') ORDER BY id DESC LIMIT 1",
    );
    res.json({
      items,
      generation: JSON.parse(
        one(db, "SELECT value FROM settings WHERE key='feedGeneration'")?.value || '0',
      ),
      counts: one(
        db,
        `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN json_extract(a.payload,'$.seasoning')=1 THEN 1 ELSE 0 END),0) AS seasoning FROM alerts a WHERE a.withdrawn=0 ${rangeSql}`,
        ...rangeArgs,
      ),
      filteredUnread: one(
        db,
        `SELECT COUNT(*) AS count FROM alerts a WHERE a.withdrawn=0 AND NOT EXISTS(SELECT 1 FROM reads r WHERE r.alert_id=a.id AND r.user_id=?) ${rangeSql}`,
        req.user!.id,
        ...rangeArgs,
      )!.count,
      readIds: all(db, 'SELECT alert_id FROM reads WHERE user_id=?', req.user!.id).map(
        (r) => r.alert_id,
      ),
      withdrawnIds: all(db, 'SELECT id FROM alerts WHERE withdrawn=1').map((a) => a.id),
      cursor:
        after > 0
          ? items.at(-1)?.id || after
          : one(db, 'SELECT COALESCE(MAX(id),0) AS id FROM alerts')!.id,
      hasMore: after > 0 && items.length === 100,
      intervalHours: config(db).intervalHours,
      unread: one(
        db,
        'SELECT COUNT(*) AS count FROM alerts a WHERE withdrawn=0 AND NOT EXISTS(SELECT 1 FROM reads r WHERE r.alert_id=a.id AND r.user_id=?)',
        req.user!.id,
      )!.count,
      lastJob: job || null,
      lastPublished:
        one(db, 'SELECT published_at FROM alerts WHERE withdrawn=0 ORDER BY id DESC LIMIT 1')
          ?.published_at || null,
    });
  });
  app.get('/api/alerts/:id', (req, res) => {
    const a = one(
      db,
      'SELECT a.*,n.title FROM alerts a JOIN news n ON n.id=a.news_id WHERE a.id=? AND a.withdrawn=0',
      parseId(req.params.id),
    );
    if (!a) return res.status(404).json({ error: '预警不存在或已撤下' });
    res.json({
      ...serialize(a),
      sources: all(db, 'SELECT url,title,source_name FROM sources WHERE news_id=? ORDER BY id', a.news_id),
    });
  });
  app.post('/api/alerts/:id/read', (req, res) => {
    const id = parseId(req.params.id);
    if (!one(db, 'SELECT id FROM alerts WHERE id=? AND withdrawn=0', id))
      return res.status(404).json({ error: '预警不存在' });
    run(db, 'INSERT OR IGNORE INTO reads VALUES(?,?,?)', req.user!.id, id, now());
    res.json({ ok: true });
  });
  app.post('/api/notifications/claim', (req, res) => {
    const result = transaction(db, () => {
      const cursor =
        one(db, 'SELECT cursor FROM notifications WHERE user_id=?', req.user!.id)?.cursor || 0;
      const max = one(db, 'SELECT COALESCE(MAX(id),0) AS id FROM alerts')!.id;
      const count = one(
        db,
        'SELECT COUNT(*) AS count FROM alerts WHERE withdrawn=0 AND id>? AND id<=?',
        cursor,
        max,
      )!.count;
      run(
        db,
        'INSERT INTO notifications VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET cursor=excluded.cursor',
        req.user!.id,
        max,
      );
      return { count, cursor: max };
    });
    res.json(result);
  });
  app.use('/api/admin', (req, res, next) =>
    req.user!.role === 'developer' ? next() : res.status(403).json({ error: '仅开发者可访问' }),
  );
  app.get('/api/admin/overview', (_req, res) => {
    const failures = failureCounts(db);
    res.json({
      news: one(db, 'SELECT COUNT(*) AS count FROM news')!.count,
      alerts: one(db, 'SELECT COUNT(*) AS count FROM alerts WHERE withdrawn=0')!.count,
      failed: failures.collection + failures.analysis,
      users: one(db, 'SELECT COUNT(*) AS count FROM users WHERE active=1')!.count,
      busy:
        worker.busy ||
        worker.hasUnfinishedTask() ||
        !!one(db, "SELECT name FROM locks WHERE name='worker' AND expires_at>?", now()),
      modelFailed: failures.analysis,
      crawlFailed: failures.collection,
      crawlState: crawlState(db),
      jobs: all(db, 'SELECT * FROM jobs ORDER BY id DESC LIMIT 30'),
    });
  });
  app.get('/api/admin/jobs', (req, res) => {
    const page = z.coerce.number().int().min(1).default(1).parse(req.query.page);
    const kind = z.string().max(40).optional().parse(req.query.kind);
    const status = z.string().max(40).optional().parse(req.query.status);
    const parts: string[] = [];
    const args: string[] = [];
    if (kind) {
      parts.push('kind=?');
      args.push(kind);
    }
    if (status) {
      parts.push('status=?');
      args.push(status);
    }
    const where = parts.length ? 'WHERE ' + parts.join(' AND ') : '';
    res.json({
      items: all(
        db,
        `SELECT * FROM jobs ${where} ORDER BY id DESC LIMIT 20 OFFSET ?`,
        ...args,
        (page - 1) * 20,
      ),
      total: one(db, `SELECT COUNT(*) AS count FROM jobs ${where}`, ...args)!.count,
      page,
    });
  });
  app.get('/api/admin/jobs/:id', (req, res) => {
    const job = one(db, 'SELECT * FROM jobs WHERE id=?', parseId(req.params.id));
    if (!job) return res.status(404).json({ error: '任务不存在' });
    const page = z.coerce.number().int().min(1).default(1).parse(req.query.page);
    const scope = z.enum(['window', 'outside', 'all']).default('window').parse(req.query.scope);
    const filter = scope === 'window' ? " AND i.result<>'outside'" : scope === 'outside' ? " AND i.result='outside'" : '';
    const totals = one(db,"SELECT COUNT(*) AS 'all',COALESCE(SUM(result='outside'),0) AS outside FROM task_items WHERE job_id=?",job.id)!;
    res.json({
      job,
      items: all(db,`SELECT i.* FROM task_items i WHERE job_id=? ${filter} ORDER BY i.id LIMIT 50 OFFSET ?`,job.id,(page-1)*50),
      total:
        scope === 'all'
          ? totals.all
          : scope === 'outside'
          ? totals.outside
          : totals.all - totals.outside,
      totals: { ...totals, window: totals.all - totals.outside },
      scope,
      page,
      sourceProgress: all(db, 'SELECT * FROM job_sources WHERE job_id=?', job.id),
      pageErrors: all(
        db,
        "SELECT url,error FROM task_pages WHERE job_id=? AND status='failed'",
        job.id,
      ),
    });
  });
  app.get('/api/admin/news', (req,res)=>{
    const page=z.coerce.number().int().min(1).default(1).parse(req.query.page);
    const search=z.string().max(200).default('').parse(req.query.search);
    const category=z.enum(['biological','chemical','physical','other','']).default('').parse(req.query.category);
    const source=z.string().max(200).default('').parse(req.query.source);
    const filters=['n.title LIKE ?'];const args:any[]=[`%${search}%`];
    if(category){filters.push('EXISTS(SELECT 1 FROM json_each(n.categories) WHERE value=?)');args.push(category);}
    if(source){filters.push('EXISTS(SELECT 1 FROM sources s WHERE s.news_id=n.id AND s.source_name=?)');args.push(source);}
    const where=filters.join(' AND ');
    res.json({items:all(db,`SELECT n.* FROM news n WHERE ${where} ORDER BY id DESC LIMIT 30 OFFSET ?`,...args,(page-1)*30).map(n=>({...n,categories:JSON.parse(n.categories),sources:all(db,'SELECT url,title,source_name FROM sources WHERE news_id=?',n.id),analyses:all(db,'SELECT * FROM analyses WHERE news_id=? ORDER BY id DESC',n.id)})),total:one(db,`SELECT COUNT(*) AS count FROM news n WHERE ${where}`,...args)!.count,sourceOptions:all(db,'SELECT DISTINCT source_name FROM sources ORDER BY source_name').map(s=>s.source_name)});
  });
  app.get('/api/admin/failures', (req,res)=>{
    const page=z.coerce.number().int().min(1).default(1).parse(req.query.page);
    res.json({items:all(db,"SELECT p.id,p.title,p.published_at,p.error,p.attempts,p.model,p.prompt_id,p.updated_at,(SELECT url FROM pipeline_urls WHERE item_id=p.id LIMIT 1) AS url,(SELECT source_name FROM pipeline_urls WHERE item_id=p.id LIMIT 1) AS source_name FROM pipeline_items p WHERE status='failed' ORDER BY p.id LIMIT 30 OFFSET ?",(page-1)*30),total:one(db,"SELECT COUNT(*) AS count FROM pipeline_items WHERE status='failed'")!.count,page});
  });
  app.post('/api/admin/failures/:id/retry',(req,res)=>{
    const id=parseId(req.params.id);
    if(!one(db,"SELECT id FROM pipeline_items WHERE id=? AND status='failed' AND trim(body)<>''",id))return res.status(404).json({error:'失败暂存项不存在或没有可重试正文'});
    if(worker.hasUnfinishedTask()||!worker.launch('retry',id))return res.status(409).json({error:'模型未配置或已有任务执行中'});
    res.status(202).json({jobId:worker.jobId});
  });
  app.post('/api/admin/collect', (_req, res) => {
    if (!worker.canAnalyze()) return res.status(400).json({error:'请先配置模型 API 密钥，采集后将逐篇立即分析'});
    if (worker.hasUnfinishedTask() || !worker.launch())
      return res.status(409).json({ error: '已有任务执行中或待恢复，请等待完成' });
    res.status(202).json({ jobId: worker.jobId, message: '采集任务已提交' });
  });
  app.get('/api/admin/alerts', (_req, res) =>
    res.json(
      all(
        db,
        'SELECT a.*,n.title FROM alerts a JOIN news n ON n.id=a.news_id ORDER BY id DESC LIMIT 300',
      ).map((a) => ({
        ...serialize(a),
        sources: all(db, 'SELECT url,title,source_name FROM sources WHERE news_id=?', a.news_id),
      })),
    ),
  );
  app.post('/api/admin/alerts/:id/withdraw', (req, res) => {
    run(db, 'UPDATE alerts SET withdrawn=1 WHERE id=?', parseId(req.params.id));
    res.json({ ok: true });
  });
  app.get('/api/admin/config', (_req, res) =>
    res.json({
      crawler: config(db),
      sourceStatus: [...new Set<string>([...SOURCE_DEFINITIONS.map(s=>s.url),...config(db).sources])].map((url:string)=>({url,name:sourceName(url),enabled:config(db).sources.includes(url),...one(db,'SELECT last_end,next_run_at FROM source_states WHERE url=?',url),latest:one(db,'SELECT * FROM job_sources WHERE url=? ORDER BY job_id DESC LIMIT 1',url)||null})),
      prompt: one(db, 'SELECT * FROM prompts ORDER BY id DESC LIMIT 1'),
      model: {
        name: modelName(),
        baseUrl: process.env.MODEL_BASE_URL || '',
        configured: !!process.env.MODEL_API_KEY,
      },
    }),
  );
  app.put('/api/admin/config', (req, res) => {
    const input = z
      .object({
        crawler: z
          .object({
            sources: z
              .array(
                z
                  .string()
                  .url()
                  .refine((u) => {
                    try {
                      canonicalUrl(u);
                      return true;
                    } catch {
                      return false;
                    }
                  }, '仅支持食品伙伴网、中国食品安全网、中国调味品协会和重庆市场监管局网址')
                  .transform((u) => canonicalUrl(u)),
              )
              .min(1)
              .max(10),
          })
          .optional(),
        prompt: z.string().min(100).max(30000).optional(),
      })
      .refine((v) => v.crawler !== undefined || v.prompt !== undefined, '至少提交采集配置或提示词')
      .parse(req.body);
    transaction(db, () => {
      if (input.crawler) {
        setSetting(db, 'crawler', { intervalHours: 24, sources: [...new Set(input.crawler.sources)] });
        saveCrawlState(db,{...crawlState(db),nextRunAt:now()});
      }
      const old = one(db, 'SELECT content FROM prompts ORDER BY id DESC LIMIT 1');
      if (input.prompt !== undefined && old?.content !== input.prompt)
        run(db, 'INSERT INTO prompts(content,created_at) VALUES(?,?)', input.prompt, now());
    });
    res.json({ ok: true, prompt: one(db, 'SELECT * FROM prompts ORDER BY id DESC LIMIT 1') });
  });
  app.post('/api/admin/model/test', async (_req, res) => {
    try {
      await callModel(
        one(db, 'SELECT content FROM prompts ORDER BY id DESC LIMIT 1')!.content,
        '本周开展食品知识宣传活动，没有发现具体食品风险。',
      );
      res.json({ ok: true, message: '模型连接及结构校验成功' });
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : '模型测试失败' });
    }
  });
  app.get('/api/admin/users', (_req, res) =>
    res.json(all(db, 'SELECT id,username,role,active,created_at FROM users ORDER BY id')),
  );
  app.post('/api/admin/users', (req, res) => {
    const input = z
      .object({
        username: z.string().regex(/^[\p{L}\p{N}_-]{2,32}$/u),
        password: z.string().min(10).max(128),
        role: z.enum(['user', 'developer']),
      })
      .parse(req.body);
    if (one(db, 'SELECT id FROM users WHERE username=?', input.username))
      return res.status(409).json({ error: '用户名已存在' });
    run(
      db,
      'INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)',
      input.username,
      hashPassword(input.password),
      input.role,
      now(),
    );
    res.status(201).json({ ok: true });
  });
  app.patch('/api/admin/users/:id', (req, res) => {
    const id = parseId(req.params.id);
    const input = z
      .object({ active: z.boolean().optional(), password: z.string().min(10).max(128).optional() })
      .parse(req.body);
    if (id === req.user!.id && input.active === false)
      return res.status(400).json({ error: '不能停用当前账号' });
    if (!one(db, 'SELECT id FROM users WHERE id=?', id))
      return res.status(404).json({ error: '账号不存在' });
    transaction(db, () => {
      if (input.active !== undefined)
        run(db, 'UPDATE users SET active=? WHERE id=?', Number(input.active), id);
      if (input.password)
        run(db, 'UPDATE users SET password_hash=? WHERE id=?', hashPassword(input.password), id);
      run(db, 'DELETE FROM sessions WHERE user_id=?', id);
    });
    res.json({ ok: true });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
  const dist = resolve('dist');
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
  }
  app.use(
    (error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (error instanceof z.ZodError)
        return res.status(400).json({
          error: '输入不符合要求',
          details: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        });
      if (error instanceof SyntaxError) return res.status(400).json({ error: '请求格式错误' });
      console.error('Request failed:', error?.code || error?.name);
      res.status(500).json({ error: '服务处理失败，请检查服务端日志' });
    },
  );
  return app;
}
