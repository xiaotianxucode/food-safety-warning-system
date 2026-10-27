import { randomUUID } from 'node:crypto';
import { all, one, run, transaction, now, type DB } from './db.js';
import { DEFAULT_PROMPT, LEGACY_PROMPT_HASH } from './prompt.js';
import { callModel, modelName, validateAnalysis } from './model.js';
import { canonicalUrl, DEFAULT_SOURCES, fetchHtml, fingerprint } from './crawler.js';
import { createTask, executeTask, crawlState, saveCrawlState, DAY } from './collection.js';
export function initialize(db: DB) {
  if (!one(db, 'SELECT id FROM prompts LIMIT 1'))
    run(db, 'INSERT INTO prompts(content,created_at) VALUES(?,?)', DEFAULT_PROMPT, now());
  if (!one(db, 'SELECT version FROM migrations WHERE version=2'))
    transaction(db, () => {
      const active = one(db, 'SELECT content FROM prompts ORDER BY id DESC LIMIT 1');
      if (active && fingerprint(active.content) === LEGACY_PROMPT_HASH)
        run(db, 'INSERT INTO prompts(content,created_at) VALUES(?,?)', DEFAULT_PROMPT, now());
      run(db, "UPDATE news SET status='pending',error=NULL WHERE status='filtered'");
      run(db, 'INSERT INTO migrations(version,applied_at) VALUES(2,?)', now());
    });
  if (!one(db, "SELECT key FROM settings WHERE key='crawler'"))
    run(
      db,
      'INSERT INTO settings VALUES(?,?)',
      'crawler',
      JSON.stringify({
        intervalHours: 24,
        sources: DEFAULT_SOURCES,
      }),
    );
  run(db, 'INSERT OR IGNORE INTO migrations(version,applied_at) VALUES(3,?)', now());
  if (!one(db, 'SELECT version FROM migrations WHERE version=4'))
    transaction(db, () => {
      const cfg = JSON.parse(one(db, "SELECT value FROM settings WHERE key='crawler'")!.value);
      setSetting(db, 'crawler', { intervalHours: 24, sources: cfg.sources });
      const hasHistory = !!one(db, 'SELECT id FROM jobs LIMIT 1');
      saveCrawlState(db, {
        initialized: false,
        lastSuccessEnd: null,
        nextRunAt: new Date(Date.now() + (hasHistory ? DAY : 0)).toISOString(),
      });
      run(db, 'INSERT INTO migrations(version,applied_at) VALUES(4,?)', now());
    });
}
export const config = (db: DB) =>
  JSON.parse(one(db, "SELECT value FROM settings WHERE key='crawler'")!.value);
export function setSetting(db: DB, key: string, value: unknown) {
  run(
    db,
    'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    key,
    JSON.stringify(value),
  );
}
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export function ingest(
  db: DB,
  article: { title: string; body: string; publishedAt: string | null },
  url: string,
  withinTransaction = false,
) {
  url = canonicalUrl(url);
  const hash = fingerprint(article.body);
  const write = () => {
    const existing = one(db, 'SELECT * FROM news WHERE fingerprint=?', hash);
    const source = one(db, 'SELECT * FROM sources WHERE url=?', url);
    if (existing) {
      if (source && source.news_id !== existing.id) {
        run(db, 'UPDATE sources SET news_id=? WHERE id=?', existing.id, source.id);
        run(db, "UPDATE news SET status='duplicate',error=NULL WHERE id=?", source.news_id);
      } else if (!source)
        run(
          db,
          'INSERT INTO sources(news_id,url,title) VALUES(?,?,?)',
          existing.id,
          url,
          article.title,
        );
      return { id: existing.id, inserted: false };
    }
    if (source) {
      run(
        db,
        'UPDATE news SET title=?,body=?,published_at=?,fingerprint=?,status=?,error=NULL WHERE id=?',
        article.title,
        article.body,
        article.publishedAt,
        hash,
        'pending',
        source.news_id,
      );
      return { id: source.news_id, inserted: true };
    }
    const id = Number(
      run(
        db,
        'INSERT INTO news(title,body,published_at,fingerprint,status,created_at) VALUES(?,?,?,?,?,?)',
        article.title,
        article.body,
        article.publishedAt,
        hash,
        'pending',
        now(),
      ).lastInsertRowid,
    );
    run(db, 'INSERT INTO sources(news_id,url,title) VALUES(?,?,?)', id, url, article.title);
    return { id, inserted: true };
  };
  return withinTransaction ? write() : transaction(db, write);
}
export async function analyzeNews(db: DB, id: number, analyzer = callModel, promptId?: number) {
  const news = one(db, 'SELECT * FROM news WHERE id=?', id);
  if (!news || !news.body) throw new Error('新闻正文缺失，不能分析');
  if (['published', 'no_warning', 'duplicate'].includes(news.status)) return;
  const prompt = promptId
    ? one(db, 'SELECT * FROM prompts WHERE id=?', promptId)!
    : one(db, 'SELECT * FROM prompts ORDER BY id DESC LIMIT 1')!;
  const analysisId = Number(
    run(
      db,
      "INSERT INTO analyses(news_id,status,model,prompt_id,created_at) VALUES(?,'running',?,?,?)",
      id,
      modelName(),
      prompt.id,
      now(),
    ).lastInsertRowid,
  );
  run(db, "UPDATE news SET status='analyzing',error=NULL WHERE id=?", id);
  let error = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    run(db, 'UPDATE analyses SET attempts=? WHERE id=?', attempt, analysisId);
    try {
      const result = validateAnalysis(await analyzer(prompt.content, news.body), news.body);
      transaction(db, () => {
        run(
          db,
          "UPDATE analyses SET status='completed',result=?,finished_at=? WHERE id=?",
          JSON.stringify(result),
          now(),
          analysisId,
        );
        for (const alert of result.alerts) {
          const key = fingerprint(
            JSON.stringify([alert.food, alert.region, alert.company, alert.batch, alert.factor]),
          );
          run(
            db,
            'INSERT OR IGNORE INTO alerts(news_id,analysis_id,object_key,payload,published_at) VALUES(?,?,?,?,?)',
            id,
            analysisId,
            key,
            JSON.stringify({ ...alert, summary: result.summary }),
            now(),
          );
        }
        run(
          db,
          'UPDATE news SET status=?,error=NULL WHERE id=?',
          result.shouldWarn ? 'published' : 'no_warning',
          id,
        );
      });
      return;
    } catch (e) {
      error = e instanceof Error ? e.message : '模型分析失败';
      if (attempt < 3) await sleep(attempt * 1500);
    }
  }
  run(
    db,
    "UPDATE analyses SET status='failed',error=?,finished_at=? WHERE id=?",
    error,
    now(),
    analysisId,
  );
  run(db, "UPDATE news SET status='analysis_failed',error=? WHERE id=?", error, id);
}
export class Worker {
  busy = false;
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private owner = randomUUID();
  jobId?: number;
  constructor(
    public db: DB,
    private fetcher = fetchHtml,
    private analyzer = callModel,
  ) {}
  start() {
    this.timer = setInterval(() => {
      this.tick();
    }, 60_000);
    this.tick();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
  canAnalyze() {
    return this.analyzer !== callModel || !!process.env.MODEL_API_KEY;
  }
  hasUnfinishedTask() {
    return all(
      this.db,
      "SELECT kind,status,summary FROM jobs WHERE status IN ('running','interrupted')",
    ).some(
      (j) =>
        j.status === 'running' ||
        j.kind === 'analysis_reset' ||
        JSON.parse(j.summary || '{}').version === 2,
    );
  }
  resetPreview(since?: string) {
    const condition =
      "trim(body)<>'' AND status<>'duplicate'" + (since ? ' AND published_at>=?' : '');
    const eligible = one(
      this.db,
      `SELECT COUNT(*) AS count FROM news WHERE ${condition}`,
      ...(since ? [since] : []),
    )!.count;
    return {
      eligible,
      articles: one(this.db, 'SELECT COUNT(*) AS count FROM news')!.count,
      alerts: one(this.db, 'SELECT COUNT(*) AS count FROM alerts')!.count,
      since: since || null,
      promptId: one(this.db, 'SELECT id FROM prompts ORDER BY id DESC LIMIT 1')!.id,
      model: modelName(),
      modelConfigured: this.canAnalyze(),
    };
  }
  resetAnalysis(since?: string) {
    if (!this.canAnalyze()) throw new Error('请先配置模型 API 密钥，未清除任何预警');
    if (this.hasUnfinishedTask() || !this.acquire()) return undefined;
    try {
      if (
        one(
          this.db,
          "SELECT id FROM jobs WHERE kind='analysis_reset' AND status IN ('running','interrupted') LIMIT 1",
        )
      ) {
        this.release();
        return undefined;
      }
      const result = transaction(this.db, () => {
        const preview = this.resetPreview(since);
        if (!preview.eligible)
          throw new Error('所选范围内没有正文完整的可分析文章，未清除任何预警');
        const selected = all(
          this.db,
          `SELECT id FROM news WHERE trim(body)<>'' AND status<>'duplicate' ${
            since ? 'AND published_at>=?' : ''
          } ORDER BY id`,
          ...(since ? [since] : []),
        );
        const summary = {
          ...preview,
          deletedAlerts: preview.alerts,
          total: selected.length,
          completed: 0,
          failed: 0,
          processed: 0,
          analyzed: 0,
        };
        run(
          this.db,
          "UPDATE jobs SET status='interrupted',finished_at=?,error='原任务中断，由模型分析重置接管' WHERE status='running'",
          now(),
        );
        run(
          this.db,
          "UPDATE analyses SET status='interrupted',finished_at=? WHERE status='running'",
          now(),
        );
        const jobId = Number(
          run(
            this.db,
            "INSERT INTO jobs(kind,status,started_at,summary) VALUES('analysis_reset','running',?,?)",
            now(),
            JSON.stringify(summary),
          ).lastInsertRowid,
        );
        run(this.db, 'DELETE FROM reads');
        run(this.db, 'DELETE FROM alerts');
        // 保留 AUTOINCREMENT 序列，防止旧游标与新预警 ID 冲突。
        const generation = JSON.parse(
          one(this.db, "SELECT value FROM settings WHERE key='feedGeneration'")?.value || '0',
        );
        setSetting(this.db, 'feedGeneration', generation + 1);
        run(
          this.db,
          "UPDATE news SET status='reset_excluded',error=NULL WHERE trim(body)<>'' AND status<>'duplicate'",
        );
        for (const article of selected) {
          run(
            this.db,
            "INSERT INTO reanalysis_queue(job_id,news_id,status) VALUES(?,?,'pending')",
            jobId,
            article.id,
          );
          run(this.db, "UPDATE news SET status='pending',error=NULL WHERE id=?", article.id);
        }
        return { jobId, ...summary };
      });
      this.runActive(() => this.executeReset(result.jobId));
      return result;
    } catch (e) {
      this.release();
      throw e;
    }
  }
  tick() {
    if (this.busy) return;
    const unfinished = all(
      this.db,
      "SELECT * FROM jobs WHERE status IN ('running','interrupted')",
    ).find(
      (j) =>
        j.status === 'running' ||
        j.kind === 'analysis_reset' ||
        JSON.parse(j.summary || '{}').version === 2,
    );
    if (unfinished || Date.parse(crawlState(this.db).nextRunAt) <= Date.now())
      this.launch('scheduled');
  }
  launch(kind = 'manual', retryId?: number) {
    if (!this.acquire()) return false;
    const reset = one(
      this.db,
      "SELECT id FROM jobs WHERE kind='analysis_reset' AND status IN ('running','interrupted') ORDER BY id DESC LIMIT 1",
    );
    this.runActive(() => (reset ? this.executeReset(reset.id) : this.execute(kind, retryId)));
    return true;
  }
  private acquire() {
    if (this.busy) return false;
    const acquired = transaction(this.db, () => {
      const lock = one(this.db, "SELECT * FROM locks WHERE name='worker'");
      if (lock && lock.expires_at > now()) return false;
      run(
        this.db,
        "INSERT INTO locks VALUES('worker',?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at",
        this.owner,
        new Date(Date.now() + 180_000).toISOString(),
      );
      return true;
    });
    return acquired;
  }
  private release() {
    run(this.db, "DELETE FROM locks WHERE name='worker' AND owner=?", this.owner);
  }
  private runActive(task: () => Promise<void>) {
    this.busy = true;
    this.active = task().finally(() => {
      this.release();
      this.busy = false;
    });
  }
  private async executeReset(jobId: number) {
    this.jobId = jobId;
    const db = this.db;
    const job = one(db, 'SELECT * FROM jobs WHERE id=?', jobId)!;
    const summary = JSON.parse(job.summary);
    const heartbeat = setInterval(
      () =>
        run(
          db,
          "UPDATE locks SET expires_at=? WHERE name='worker' AND owner=?",
          new Date(Date.now() + 180_000).toISOString(),
          this.owner,
        ),
      30000,
    );
    const updateProgress = () => {
      const counts = one(
        db,
        "SELECT COUNT(*) AS total,COALESCE(SUM(status='completed'),0) AS completed,COALESCE(SUM(status='failed'),0) AS failed FROM reanalysis_queue WHERE job_id=?",
        jobId,
      )!;
      const progress = {
        ...summary,
        ...counts,
        processed: counts.completed + counts.failed,
        analyzed: counts.completed + counts.failed,
      };
      run(db, 'UPDATE jobs SET summary=? WHERE id=?', JSON.stringify(progress), jobId);
      return progress;
    };
    try {
      transaction(db, () => {
        run(db, "UPDATE jobs SET status='running',finished_at=NULL,error=NULL WHERE id=?", jobId);
        run(
          db,
          "UPDATE analyses SET status='interrupted',finished_at=? WHERE status='running' AND news_id IN (SELECT news_id FROM reanalysis_queue WHERE job_id=? AND status='running')",
          now(),
          jobId,
        );
        run(
          db,
          "UPDATE news SET status='pending' WHERE status='analyzing' AND id IN (SELECT news_id FROM reanalysis_queue WHERE job_id=? AND status='running')",
          jobId,
        );
        run(
          db,
          "UPDATE reanalysis_queue SET status='pending' WHERE job_id=? AND status='running'",
          jobId,
        );
      });
      updateProgress();
      for (const item of all(
        db,
        "SELECT news_id FROM reanalysis_queue WHERE job_id=? AND status='pending' ORDER BY news_id",
        jobId,
      )) {
        run(
          db,
          "UPDATE reanalysis_queue SET status='running' WHERE job_id=? AND news_id=?",
          jobId,
          item.news_id,
        );
        try {
          await analyzeNews(db, item.news_id, this.analyzer, summary.promptId);
          const news = one(db, 'SELECT status,error FROM news WHERE id=?', item.news_id)!;
          const failed = news.status === 'analysis_failed';
          run(
            db,
            'UPDATE reanalysis_queue SET status=?,error=? WHERE job_id=? AND news_id=?',
            failed ? 'failed' : 'completed',
            failed ? news.error : null,
            jobId,
            item.news_id,
          );
        } catch (e) {
          const error = e instanceof Error ? e.message : '分析失败';
          run(
            db,
            "UPDATE news SET status='analysis_failed',error=? WHERE id=?",
            error,
            item.news_id,
          );
          run(
            db,
            "UPDATE reanalysis_queue SET status='failed',error=? WHERE job_id=? AND news_id=?",
            error,
            jobId,
            item.news_id,
          );
        }
        updateProgress();
      }
      const progress = updateProgress();
      const errors = all(
        db,
        "SELECT error FROM reanalysis_queue WHERE job_id=? AND status='failed' LIMIT 20",
        jobId,
      )
        .map((r) => r.error)
        .join('\n');
      run(
        db,
        'UPDATE jobs SET status=?,finished_at=?,error=? WHERE id=?',
        progress.failed ? 'partial_failed' : 'completed',
        now(),
        errors || null,
        jobId,
      );
    } catch (e) {
      run(
        db,
        "UPDATE jobs SET status='interrupted',error=? WHERE id=?",
        e instanceof Error ? e.message : '重置分析中断',
        jobId,
      );
    } finally {
      clearInterval(heartbeat);
    }
  }
  private async execute(kind: string, retryId?: number) {
    const db = this.db;
    const heartbeat = setInterval(
      () =>
        run(
          db,
          "UPDATE locks SET expires_at=? WHERE name='worker' AND owner=?",
          new Date(Date.now() + 180_000).toISOString(),
          this.owner,
        ),
      30000,
    );
    try {
      const unfinished = all(
        db,
        "SELECT * FROM jobs WHERE kind<>'analysis_reset' AND status IN ('running','interrupted') ORDER BY id",
      );
      const resumable = unfinished.find((j) => JSON.parse(j.summary || '{}').version === 2);
      if (resumable) this.jobId = resumable.id;
      else {
        const legacy = unfinished.filter((j) => j.status === 'running');
        for (const j of legacy)
          run(
            db,
            "UPDATE jobs SET status='interrupted',finished_at=?,error='旧版中断任务已迁入新执行器' WHERE id=?",
            now(),
            j.id,
          );
        let ids: number[] | undefined;
        if (kind === 'retry' && retryId) {
          const n = one(db, 'SELECT * FROM news WHERE id=?', retryId)!;
          kind = n.body ? 'model_retry' : 'crawl_retry';
          ids = [retryId];
        } else if (kind === 'model_retry')
          ids = all(
            db,
            "SELECT id FROM news WHERE status='analysis_failed' AND trim(body)<>'' ORDER BY id",
          ).map((n) => n.id);
        else if (legacy.length) {
          ids = all(
            db,
            "SELECT id FROM news WHERE status IN ('pending','analyzing') AND trim(body)<>''",
          ).map((n) => n.id);
          if (ids.length) kind = 'model_retry';
        }
        this.jobId = createTask(db, kind, ids);
      }
      await executeTask(db, this.jobId!, {
        fetcher: this.fetcher,
        ingest: (article, url) => ingest(db, article, url, true),
        analyze: (id, prompt) => analyzeNews(db, id, this.analyzer, prompt),
        pause: () => (this.fetcher === fetchHtml ? sleep(800) : Promise.resolve()),
      });
    } catch (e) {
      if (this.jobId)
        run(
          db,
          "UPDATE jobs SET status='interrupted',error=? WHERE id=?",
          e instanceof Error ? e.message : '任务中断',
          this.jobId,
        );
    } finally {
      clearInterval(heartbeat);
    }
  }
}
