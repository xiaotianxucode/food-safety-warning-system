import { all, one, run, transaction, now, type DB } from './db.js';
import { extractArticle, extractListing } from './crawler.js';
export const DAY = 86400_000;
export function threeMonthsBefore(end: string) {
  const local = new Date(Date.parse(end) + 8 * 3600_000);
  const year = local.getUTCFullYear(),
    month = local.getUTCMonth() - 3;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(last, local.getUTCDate()),
      local.getUTCHours(),
      local.getUTCMinutes(),
      local.getUTCSeconds(),
      local.getUTCMilliseconds(),
    ) -
      8 * 3600_000,
  ).toISOString();
}
export function crawlState(db: DB) {
  return JSON.parse(one(db, "SELECT value FROM settings WHERE key='crawlState'")!.value);
}
export function saveCrawlState(db: DB, state: any) {
  run(
    db,
    "INSERT INTO settings VALUES('crawlState',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    JSON.stringify(state),
  );
}
export function windowContains(start: string, end: string, date: string, inclusive: boolean) {
  return (inclusive ? date >= start : date > start) && date <= end;
}
export function createTask(db: DB, kind: string, targetIds?: number[], end = now()) {
  const state = crawlState(db);
  const retry = kind === 'model_retry' || kind === 'crawl_retry';
  const start = state.initialized
    ? state.lastSuccessEnd
    : state.initialStart || threeMonthsBefore(end);
  const summary: any = {
    version: 2,
    phase: retry ? 'analyzing' : 'scanning',
    mode: retry ? 'retry' : state.initialized ? 'incremental' : 'initial',
    windowStart: start,
    windowEnd: end,
    startInclusive: !state.initialized,
    promptId: one(db, 'SELECT id FROM prompts ORDER BY id DESC LIMIT 1')!.id,
    collected: 0,
    deduplicated: 0,
    added: 0,
    warningArticles: 0,
    noWarning: 0,
    modelFailed: 0,
    publishedAlerts: 0,
  };
  return transaction(db, () => {
    const id = Number(
      run(
        db,
        "INSERT INTO jobs(kind,status,started_at,summary) VALUES(?,'running',?,?)",
        kind,
        end,
        JSON.stringify(summary),
      ).lastInsertRowid,
    );
    if (retry) {
      for (const newsId of targetIds || []) {
        const news = one(db, 'SELECT * FROM news WHERE id=?', newsId)!;
        const url =
          one(db, 'SELECT url FROM sources WHERE news_id=? ORDER BY id LIMIT 1', newsId)?.url ||
          `news:${newsId}`;
        run(
          db,
          'INSERT INTO task_items(job_id,url,news_id,published_at,result,model_status) VALUES(?,?,?,?,?,?)',
          id,
          url,
          newsId,
          news.published_at,
          kind === 'model_retry' ? 'retry' : 'pending',
          kind === 'model_retry' ? 'pending' : 'none',
        );
      }
    } else {
      const cfg = JSON.parse(one(db, "SELECT value FROM settings WHERE key='crawler'")!.value);
      for (const url of cfg.sources)
        run(db, 'INSERT OR IGNORE INTO task_pages(job_id,url) VALUES(?,?)', id, url);
      if (!state.initialized && !state.initialStart)
        saveCrawlState(db, { ...state, initialStart: start });
    }
    return id;
  });
}
export function taskProgress(db: DB, id: number) {
  const job = one(db, 'SELECT summary FROM jobs WHERE id=?', id)!;
  const initial = JSON.parse(job.summary);
  const counts = one(
    db,
    `SELECT COUNT(*) AS discovered,COALESCE(SUM(result IN ('new','duplicate')),0) AS collected,COALESCE(SUM(result='duplicate'),0) AS deduplicated,COALESCE(SUM(result='new'),0) AS added,COALESCE(SUM(result='read_failed'),0) AS readFailed,COALESCE(SUM(result='date_unknown'),0) AS dateUnknown,COALESCE(SUM(result='outside'),0) AS outside,COALESCE(SUM(model_status='warning'),0) AS warningArticles,COALESCE(SUM(model_status='no_warning'),0) AS noWarning,COALESCE(SUM(model_status='failed'),0) AS modelFailed,COALESCE(SUM(model_status IN ('pending','running')),0) AS modelPending,COALESCE(SUM(result='pending'),0) AS readingPending FROM task_items WHERE job_id=?`,
    id,
  )!;
  const page = one(
    db,
    "SELECT COUNT(*) AS pages,COALESCE(SUM(status='failed'),0) AS pageFailed,COALESCE(SUM(status='pending'),0) AS pagesPending FROM task_pages WHERE job_id=?",
    id,
  )!;
  const published = one(
    db,
    'SELECT COUNT(*) AS count FROM alerts WHERE analysis_id IN (SELECT analysis_id FROM task_items WHERE job_id=?)',
    id,
  )!.count;
  const summary = {
    ...initial,
    ...counts,
    ...page,
    publishedAlerts: published,
    modelSucceeded: counts.warningArticles + counts.noWarning,
    processed: counts.warningArticles + counts.noWarning + counts.modelFailed,
    analyzed: counts.warningArticles + counts.noWarning + counts.modelFailed,
  };
  run(db, 'UPDATE jobs SET summary=? WHERE id=?', JSON.stringify(summary), id);
  return summary;
}
type Hooks = {
  fetcher: (url: string) => Promise<string>;
  ingest: (
    article: ReturnType<typeof extractArticle>,
    url: string,
  ) => { id: number; inserted: boolean };
  analyze: (id: number, promptId: number) => Promise<void>;
  pause: () => Promise<unknown>;
};
export async function executeTask(db: DB, id: number, hooks: Hooks) {
  const job = one(db, 'SELECT * FROM jobs WHERE id=?', id)!;
  let summary = JSON.parse(job.summary);
  const retry = job.kind === 'model_retry' || job.kind === 'crawl_retry';
  const update = (phase?: string) => {
    if (phase) {
      summary = {
        ...JSON.parse(one(db, 'SELECT summary FROM jobs WHERE id=?', id)!.summary),
        phase,
      };
      run(db, 'UPDATE jobs SET summary=? WHERE id=?', JSON.stringify(summary), id);
    }
    return taskProgress(db, id);
  };
  run(db, "UPDATE jobs SET status='running',error=NULL,finished_at=NULL WHERE id=?", id);
  transaction(db, () => {
    run(
      db,
      "UPDATE analyses SET status='interrupted',finished_at=? WHERE status='running' AND news_id IN (SELECT news_id FROM task_items WHERE job_id=? AND model_status='running')",
      now(),
      id,
    );
    run(
      db,
      "UPDATE news SET status='pending' WHERE status='analyzing' AND id IN (SELECT news_id FROM task_items WHERE job_id=? AND model_status='running')",
      id,
    );
    run(
      db,
      "UPDATE task_items SET model_status='pending' WHERE job_id=? AND model_status='running'",
      id,
    );
  });
  let page: any;
  while (
    (page = one(
      db,
      "SELECT * FROM task_pages WHERE job_id=? AND status='pending' ORDER BY rowid LIMIT 1",
      id,
    ))
  ) {
    try {
      let html = '';
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          html = await hooks.fetcher(page.url);
          break;
        } catch (e) {
          if (attempt === 3) throw e;
          await hooks.pause();
        }
      }
      const listing = extractListing(html, page.url);
      if (
        !listing.entries.length &&
        !listing.seeds.length &&
        !/暂无|没有找到|无相关|no results/i.test(html)
      )
        throw new Error('未识别有效新闻列表，不能确认时间窗口覆盖完整');
      const beforeStart =
        listing.ordered &&
        listing.entries.length > 0 &&
        listing.entries.every(
          (e) =>
            e.publishedAt &&
            Date.parse(e.publishedAt) + (e.precise ? 0 : DAY) < Date.parse(summary.windowStart),
        );
      transaction(db, () => {
        for (const entry of listing.entries) {
          const known = one(
            db,
            "SELECT n.*,(SELECT published_at FROM task_items WHERE url=s.url AND result IN ('new','duplicate') AND published_at IS NOT NULL ORDER BY id DESC LIMIT 1) AS source_date FROM sources s JOIN news n ON n.id=s.news_id WHERE s.url=?",
            entry.url,
          );
          const date =
            (entry.precise ? entry.publishedAt : null) ||
            known?.source_date ||
            known?.published_at ||
            one(
              db,
              'SELECT published_at FROM task_items WHERE url=? AND published_at IS NOT NULL ORDER BY id DESC LIMIT 1',
              entry.url,
            )?.published_at ||
            null;
          const dayOutside =
            entry.publishedAt &&
            !entry.precise &&
            (Date.parse(entry.publishedAt) + DAY <= Date.parse(summary.windowStart) ||
              entry.publishedAt > summary.windowEnd);
          const outside =
            dayOutside ||
            (!!date &&
              !windowContains(
                summary.windowStart,
                summary.windowEnd,
                date,
                summary.startInclusive,
              ));
          run(
            db,
            'INSERT OR IGNORE INTO task_items(job_id,url,news_id,published_at,result) VALUES(?,?,?,?,?)',
            id,
            entry.url,
            known?.id || null,
            date,
            outside ? 'outside' : known?.body && date ? 'duplicate' : 'pending',
          );
        }
        for (const url of listing.seeds)
          run(db, 'INSERT OR IGNORE INTO task_pages(job_id,url) VALUES(?,?)', id, url);
        if (listing.next && !beforeStart) {
          const visited = one(
            db,
            'SELECT status FROM task_pages WHERE job_id=? AND url=?',
            id,
            listing.next,
          );
          if (visited?.status === 'completed')
            throw new Error('检测到历史分页循环，不能确认覆盖完整');
          run(db, 'INSERT OR IGNORE INTO task_pages(job_id,url) VALUES(?,?)', id, listing.next);
        }
        run(
          db,
          "UPDATE task_pages SET status='completed',error=NULL WHERE job_id=? AND url=?",
          id,
          page.url,
        );
      });
    } catch (e) {
      run(
        db,
        "UPDATE task_pages SET status='failed',error=? WHERE job_id=? AND url=?",
        e instanceof Error ? e.message : '栏目读取失败',
        id,
        page.url,
      );
    }
    update('scanning');
    await hooks.pause();
  }
  update('collecting');
  for (const item of all(
    db,
    "SELECT * FROM task_items WHERE job_id=? AND result='pending' ORDER BY id",
    id,
  )) {
    try {
      let article: ReturnType<typeof extractArticle> | undefined;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          article = extractArticle(await hooks.fetcher(item.url));
          break;
        } catch (e) {
          if (attempt === 3) throw e;
          await hooks.pause();
        }
      }
      if (!article) throw new Error('正文缺失');
      if (!article.publishedAt) {
        run(
          db,
          "UPDATE task_items SET result='date_unknown',error='新闻没有可确认的发布时间，未计入时间窗口' WHERE id=?",
          item.id,
        );
      } else if (
        !windowContains(
          summary.windowStart,
          summary.windowEnd,
          article.publishedAt,
          summary.startInclusive,
        ) &&
        job.kind !== 'crawl_retry'
      ) {
        run(
          db,
          "UPDATE task_items SET result='outside',published_at=?,error=NULL WHERE id=?",
          article.publishedAt,
          item.id,
        );
      } else
        transaction(db, () => {
          const result = hooks.ingest(article!, item.url);
          run(
            db,
            'UPDATE task_items SET result=?,news_id=?,published_at=?,model_status=?,error=NULL WHERE id=?',
            result.inserted ? 'new' : 'duplicate',
            result.id,
            article!.publishedAt,
            result.inserted ? 'pending' : 'none',
            item.id,
          );
        });
    } catch (e) {
      const error = e instanceof Error ? e.message : '正文读取失败';
      transaction(db, () => {
        let n = one(db, 'SELECT news_id FROM sources WHERE url=?', item.url);
        if (!n) {
          const newsId = Number(
            run(
              db,
              "INSERT INTO news(title,status,error,created_at) VALUES(?,'crawl_failed',?,?)",
              item.url,
              error,
              now(),
            ).lastInsertRowid,
          );
          run(
            db,
            'INSERT INTO sources(news_id,url,title) VALUES(?,?,?)',
            newsId,
            item.url,
            item.url,
          );
          n = { news_id: newsId };
        }
        run(
          db,
          "UPDATE task_items SET result='read_failed',news_id=?,error=? WHERE id=?",
          n.news_id,
          error,
          item.id,
        );
      });
    }
    update();
    await hooks.pause();
  }
  let stats = update('analyzing');
  if (!retry && !stats.pageFailed && !stats.readFailed && !stats.dateUnknown) {
    transaction(db, () => {
      const state = crawlState(db);
      if (!state.lastSuccessEnd || state.lastSuccessEnd < summary.windowEnd)
        saveCrawlState(db, {
          ...state,
          initialized: true,
          lastSuccessEnd: summary.windowEnd,
          nextRunAt: new Date(Date.parse(summary.windowEnd) + DAY).toISOString(),
        });
    });
  } else if (!retry) {
    const state = crawlState(db);
    saveCrawlState(db, {
      ...state,
      nextRunAt: new Date(Date.parse(summary.windowEnd) + DAY).toISOString(),
    });
  }
  for (const item of all(
    db,
    "SELECT * FROM task_items WHERE job_id=? AND model_status='pending' ORDER BY id",
    id,
  )) {
    run(db, "UPDATE task_items SET model_status='running' WHERE id=?", item.id);
    try {
      await hooks.analyze(item.news_id, summary.promptId);
      const news = one(db, 'SELECT status,error FROM news WHERE id=?', item.news_id)!;
      const analysis = one(
        db,
        'SELECT id FROM analyses WHERE news_id=? ORDER BY id DESC LIMIT 1',
        item.news_id,
      );
      run(
        db,
        'UPDATE task_items SET model_status=?,analysis_id=?,error=? WHERE id=?',
        news.status === 'published'
          ? 'warning'
          : news.status === 'no_warning'
          ? 'no_warning'
          : 'failed',
        analysis?.id || null,
        news.error || null,
        item.id,
      );
    } catch (e) {
      run(
        db,
        "UPDATE task_items SET model_status='failed',error=? WHERE id=?",
        e instanceof Error ? e.message : '模型处理失败',
        item.id,
      );
    }
    update();
  }
  stats = update('finished');
  const errors = [
    ...all(db, "SELECT error FROM task_pages WHERE job_id=? AND status='failed'", id),
    ...all(
      db,
      "SELECT error FROM task_items WHERE job_id=? AND (result IN ('read_failed','date_unknown') OR model_status='failed')",
      id,
    ),
  ]
    .map((r) => r.error)
    .filter(Boolean);
  const failed = stats.pageFailed + stats.readFailed + stats.dateUnknown + stats.modelFailed;
  run(
    db,
    'UPDATE jobs SET status=?,finished_at=?,error=? WHERE id=?',
    failed
      ? stats.pages && stats.pageFailed === stats.pages && !stats.collected
        ? 'failed'
        : 'partial_failed'
      : 'completed',
    now(),
    errors.slice(0, 20).join('\n') || null,
    id,
  );
}
