import { all, one, run, transaction, now, type DB } from './db.js';
import { weekBefore, crawlState, saveCrawlState, taskProgress } from './collection.js';

// 仅供停服后的维护调用；正常采集、升级不会自动删除历史数据。
export function narrowInitialTaskToWeek(db: DB, jobId: number, end?: string) {
  const job = one(db, 'SELECT * FROM jobs WHERE id=?', jobId);
  if (!job) throw new Error('任务不存在');
  const summary = JSON.parse(job.summary || '{}');
  if (summary.version !== 2 || summary.mode !== 'initial' || !summary.windowEnd)
    throw new Error('只能调整新版首次采集任务');
  const windowEnd = end || summary.windowEnd;
  const start = weekBefore(windowEnd);
  const older = 'SELECT id FROM news WHERE published_at IS NOT NULL AND published_at<?';
  const result = transaction(db, () => {
    const removedNews = one(
      db,
      'SELECT COUNT(*) AS count FROM news WHERE published_at IS NOT NULL AND published_at<?',
      start,
    )!.count;
    const removedAlerts = one(
      db,
      `SELECT COUNT(*) AS count FROM alerts WHERE news_id IN (${older})`,
      start,
    )!.count;
    run(
      db,
      `DELETE FROM reads WHERE alert_id IN (SELECT id FROM alerts WHERE news_id IN (${older}))`,
      start,
    );
    run(db, `DELETE FROM alerts WHERE news_id IN (${older})`, start);
    run(
      db,
      `UPDATE task_items SET news_id=NULL,analysis_id=NULL,result='outside',model_status='none',error=NULL WHERE news_id IN (${older})`,
      start,
    );
    run(
      db,
      "UPDATE task_items SET result='outside',model_status='none',analysis_id=NULL,error=NULL WHERE job_id=? AND published_at<?",
      jobId,
      start,
    );
    run(
      db,
      "UPDATE task_items SET result='pending',model_status='none',error=NULL WHERE job_id=? AND result='outside' AND published_at>=? AND published_at<=?",
      jobId,
      start,
      windowEnd,
    );
    run(db, `DELETE FROM reanalysis_queue WHERE news_id IN (${older})`, start);
    run(db, `DELETE FROM sources WHERE news_id IN (${older})`, start);
    run(db, `DELETE FROM analyses WHERE news_id IN (${older})`, start);
    run(db, 'DELETE FROM news WHERE published_at IS NOT NULL AND published_at<?', start);
    run(db, "UPDATE analyses SET status='interrupted',finished_at=? WHERE status='running'", now());
    run(db, "UPDATE news SET status='pending' WHERE status='analyzing'");
    run(
      db,
      "UPDATE task_items SET model_status='pending' WHERE job_id=? AND model_status='running'",
      jobId,
    );
    const changed = {
      ...summary,
      windowEnd,
      phase: end && end !== summary.windowEnd ? 'scanning' : summary.phase,
      initialDays: 7,
      windowStart: start,
      startInclusive: true,
      previousWindowStart: summary.previousWindowStart || summary.windowStart,
      scopeChangedAt: now(),
      removedNews,
      removedAlerts,
    };
    run(
      db,
      "UPDATE jobs SET status='interrupted',finished_at=NULL,error=NULL,summary=? WHERE id=?",
      JSON.stringify(changed),
      jobId,
    );
    const state = crawlState(db);
    saveCrawlState(db, { ...state, initialStart: start, initialDays: 7 });
    if (end && end !== summary.windowEnd) {
      run(db, 'DELETE FROM task_pages WHERE job_id=?', jobId);
      const cfg = JSON.parse(one(db, "SELECT value FROM settings WHERE key='crawler'")!.value);
      for (const url of cfg.sources)
        run(db, 'INSERT INTO task_pages(job_id,url) VALUES(?,?)', jobId, url);
    }
    const generation = JSON.parse(
      one(db, "SELECT value FROM settings WHERE key='feedGeneration'")?.value || '0',
    );
    run(
      db,
      "INSERT INTO settings VALUES('feedGeneration',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      JSON.stringify(generation + 1),
    );
    run(db, "DELETE FROM locks WHERE name='worker'");
    taskProgress(db, jobId);
    return {
      jobId,
      start,
      end: windowEnd,
      removedNews,
      removedAlerts,
      remainingNews: one(db, 'SELECT COUNT(*) AS count FROM news')!.count,
      remainingAlerts: one(db, 'SELECT COUNT(*) AS count FROM alerts')!.count,
    };
  });
  return result;
}
