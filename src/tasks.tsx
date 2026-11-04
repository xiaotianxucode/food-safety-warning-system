import React, { useCallback, useEffect, useState } from 'react';
type Props = {
  overview: any;
  busy: boolean;
  onCollect: () => void;
  onRetry: () => void;
  onReset: () => void;
};
const names: Record<string, string> = {
  idle: '空闲',
  manual: '手动采集',
  scheduled: '自动采集',
  model_retry: '模型失败重试',
  crawl_retry: '新闻正文读取失败重试',
  retry: '旧版单篇重试',
  analysis_reset: '模型分析重置',
  running: '执行中',
  completed: '已完成',
  partial_failed: '部分失败',
  failed: '失败',
  interrupted: '中断待恢复',
  pending: '待处理',
  new: '新增入库',
  duplicate: '去重合并',
  outside: '时间范围外',
  date_unknown: '发布时间无法确认',
  read_failed: '新闻正文读取失败',
  warning: '需要预警',
  no_warning: '无需预警',
  none: '未投入分析',
  scanning: '扫描栏目',
  collecting: '读取正文',
  analyzing: '模型分析',
  finished: '完成',
};
const full = (s?: string) =>
  s ? new Date(s).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
async function get(path: string) {
  const response = await fetch('/api' + path);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '加载失败');
  return value;
}
function Status({ name }: { name: string }) {
  return (
    <span
      className={`tag ${
        name.includes('fail') ? 'danger' : name === 'completed' ? 'green' : 'neutral'
      }`}
    >
      {names[name] || name}
    </span>
  );
}
export function TaskSummary({ job }: { job: any }) {
  const s = JSON.parse(job.summary || '{}');
  if (job.kind === 'analysis_reset')
    return (
      <div className="task-summary">
        <p>
          重置已处理 {s.processed || 0} / {s.total || 0} 篇 · 成功 {s.completed || 0} · 失败{' '}
          {s.failed || 0} · 清除旧预警 {s.deletedAlerts || 0} 条
        </p>
      </div>
    );
  if (s.version !== 2)
    return (
      <div className="task-summary legacy">
        <p>
          旧版记录：识别链接 {s.discovered ?? '未记录'} · 正文请求 {s.processed ?? '未记录'} · 新增{' '}
          {s.added ?? '未记录'} · 投入分析 {s.analyzed ?? '未记录'}
        </p>
        <small>旧版未保存采集成功、去重和模型成功细项，不能据此推算。</small>
      </div>
    );
  return (
    <div className="task-summary">
      <p>
        采集结果：
        {job.kind === 'model_retry' ? (
          '使用已保存正文，无需重新采集'
        ) : (
          <>
            <b>
              采集 {s.collected || 0} − 去重 {s.deduplicated || 0} = 新增 {s.added || 0} 篇
            </b>
            {' '}· 新闻列表读取失败 {s.pageFailed || 0} 页 · 新闻正文读取失败{' '}
            {s.readFailed || 0} 篇 · 发布时间无法确认 {s.dateUnknown || 0} 篇
          </>
        )}
      </p>
      <p>
        模型分析：需预警 {s.warningArticles || 0} 篇 · 无需预警 {s.noWarning || 0} 篇 ·
        模型失败 {s.modelFailed || 0} 篇 · 待处理／处理中 {s.modelPending || 0} 篇
      </p>
      <p>
        发布结果：发布预警 {s.publishedAlerts || 0} 条
      </p>
      {s.windowStart && job.kind !== 'model_retry' && (
        <small>
          {s.mode === 'initial' ? (s.initialDays === 7 ? '首次近一周' : '首次采集') : '增量窗口'}：
          {full(s.windowStart)} {s.startInclusive ? '≤' : '＜'} 新闻发布时间 ≤ {full(s.windowEnd)}
        </small>
      )}
    </div>
  );
}
export function TaskCenter({ overview, busy, onCollect, onRetry, onReset }: Props) {
  const [jobs, setJobs] = useState<any>({ items: [], total: 0 });
  const [page, setPage] = useState(1);
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<number>();
  const load = useCallback(async () => {
    try {
      setJobs(await get(`/admin/jobs?page=${page}&kind=${kind}&status=${status}`));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [page, kind, status]);
  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load, overview?.jobs?.[0]?.id, overview?.busy]);
  const state = overview?.crawlState;
  const active = overview?.jobs?.find((j: any) => j.status === 'running');
  return (
    <>
      <section className="panel task-controls">
        <div className="section-heading">
          <div>
            <h2>任务中心</h2>
            <p>采集、模型失败重试与预警重建统一管理</p>
          </div>
          <Status name={overview?.busy ? 'running' : 'idle'} />
        </div>
        <div className="task-actions">
          <button className="button primary" disabled={busy || overview?.busy} onClick={onCollect}>
            立即采集
          </button>
          <button
            className="button"
            disabled={busy || overview?.busy || !overview?.modelFailed}
            onClick={onRetry}
          >
            模型失败重试（{overview?.modelFailed || 0}）
          </button>
          <button
            className="button danger-outline"
            disabled={busy || overview?.busy}
            onClick={onReset}
          >
            模型分析重置
          </button>
        </div>
        <div className="task-schedule">
          <p>自动采集：每 24 小时 · 下次计划：{full(state?.nextRunAt)}</p>
          <p>
            {state?.initialized
              ? '上次成功采集截止：' + full(state.lastSuccessEnd)
              : '尚未完成近一周采集。首次触发时将从当时往前7天开始。'}
          </p>
          <p>
            模型失败重试只处理已有正文的失败新闻，不重新采集、不清除预警。模型分析重置会清空全部旧预警，需单独确认。
          </p>
        </div>
        {active && (
          <div className="active-task">
            <strong>
              当前任务 #{active.id} · {names[active.kind] || active.kind} ·{' '}
              {names[JSON.parse(active.summary || '{}').phase] || '处理中'}
            </strong>
            <TaskSummary job={active} />
          </div>
        )}
      </section>
      <div className="metrics admin-metrics">
        <div className="metric">
          <div>
            <label>新闻数据库</label>
            <strong>
              {overview?.news ?? '—'}
              <small>篇</small>
            </strong>
          </div>
        </div>
        <div className="metric metric-accent">
          <div>
            <label>有效预警</label>
            <strong>
              {overview?.alerts ?? '—'}
              <small>条</small>
            </strong>
          </div>
        </div>
        <div className="metric">
          <div>
            <label>模型待重试</label>
            <strong>
              {overview?.modelFailed ?? '—'}
              <small>篇</small>
            </strong>
          </div>
        </div>
        <div className="metric">
          <div>
            <label>正文待重试</label>
            <strong>
              {overview?.crawlFailed ?? '—'}
              <small>篇</small>
            </strong>
          </div>
        </div>
      </div>
      <section className="panel">
        <div className="section-heading">
          <h2>任务运行记录</h2>
          <span className="muted">每 5 秒更新 · 北京时间</span>
        </div>
        <div className="task-filters">
          <label>
            任务类型
            <select
              aria-label="任务类型"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setPage(1);
              }}
            >
              <option value="">全部任务</option>
              {['manual', 'scheduled', 'model_retry', 'crawl_retry', 'analysis_reset'].map((k) => (
                <option key={k} value={k}>
                  {names[k]}
                </option>
              ))}
            </select>
          </label>
          <label>
            任务状态
            <select
              aria-label="任务状态"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">全部状态</option>
              {['running', 'completed', 'partial_failed', 'failed', 'interrupted'].map((s) => (
                <option key={s} value={s}>
                  {names[s]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>任务</th>
                <th>时间</th>
                <th>状态／阶段</th>
                <th>结果</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {jobs.items.map((j: any) => (
                <tr key={j.id}>
                  <td>
                    #{j.id} · {names[j.kind] || j.kind}
                  </td>
                  <td>
                    <small>开始 {full(j.started_at)}</small>
                    <small>结束 {full(j.finished_at)}</small>
                  </td>
                  <td>
                    <Status name={j.status} />
                    {JSON.parse(j.summary || '{}').phase && (
                      <small>{names[JSON.parse(j.summary).phase]}</small>
                    )}
                  </td>
                  <td>
                    <TaskSummary job={j} />
                    {j.error && <pre className="inline-error">{j.error}</pre>}
                  </td>
                  <td>
                    <button className="text-button" onClick={() => setSelected(j.id)}>
                      任务详情
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!jobs.items.length && <p className="empty">暂无任务记录</p>}
        <div className="pagination">
          <button className="button" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
            上一页
          </button>
          <span>
            第 {page} / {Math.max(1, Math.ceil(jobs.total / 20))} 页
          </span>
          <button
            className="button"
            disabled={page * 20 >= jobs.total}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </button>
        </div>
      </section>
      {selected && <TaskDetails id={selected} onClose={() => setSelected(undefined)} />}
    </>
  );
}
function TaskDetails({ id, onClose }: { id: number; onClose: () => void }) {
  const [data, setData] = useState<any>();
  const [page, setPage] = useState(1);
  const [scope, setScope] = useState('window');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const load = () =>
      get(`/admin/jobs/${id}?page=${page}&scope=${scope}`)
        .then((d) => {
          if (active) {
            setData(d);
            setError('');
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    load();
    const timer = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [id, page, scope]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="overlay" onClick={onClose}>
      <section
        className="modal task-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`任务详情 #${id}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2>任务详情 #{id}</h2>
          <button className="icon-button" aria-label="关闭任务详情" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="detail">
          {error && <p className="error">{error}</p>}
          {data ? (
            <>
              <p>
                {names[data.job.kind]} · <Status name={data.job.status} /> · 开始{' '}
                {full(data.job.started_at)}
              </p>
              <TaskSummary job={data.job} />
              <div className="task-filters">
                <label>
                  记录范围
                  <select
                    aria-label="详情记录范围"
                    value={scope}
                    onChange={(e) => {
                      setScope(e.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="window">本次范围（{data.totals.window}）</option>
                    <option value="outside">窗口外日志（{data.totals.outside}）</option>
                    <option value="all">全部扫描记录（{data.totals.all}）</option>
                  </select>
                </label>
              </div>
              <p className="muted">
                以下为明细展示分页，不代表待处理数量。
                {scope === 'outside'
                  ? '窗口外链接不会投入本次模型分析。'
                  : '本次范围包含采集、分析失败及发布时间无法确认的记录；实际剩余量见上方“待处理／处理中”。'}
              </p>
              {data.job.error && <pre className="inline-error">{data.job.error}</pre>}
              {data.pageErrors.map((p: any) => (
                <p key={p.url} className="error">
                  栏目：{p.url}
                  <br />
                  {p.error}
                </p>
              ))}
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>新闻／来源</th>
                      <th>采集结果</th>
                      <th>模型结果</th>
                      <th>错误</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((i: any, index: number) => (
                      <tr key={i.id || i.news_id || index}>
                        <td className="title-cell">
                          {i.title || i.url || '—'}
                          {i.url?.startsWith('http') && (
                            <a
                              className="task-source"
                              href={i.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              查看原文
                            </a>
                          )}
                        </td>
                        <td>{names[i.result] || i.result}</td>
                        <td>{names[i.model_status] || i.model_status}</td>
                        <td>{i.error || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!data.total && (
                <p className="muted">
                  {data.totals.all
                    ? '当前筛选条件下没有记录。'
                    : '此任务没有逐项记录；旧版任务仅保留原始汇总。'}
                </p>
              )}
              <div className="pagination">
                <button
                  className="button"
                  disabled={page === 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  上一页
                </button>
                <span>
                  第 {page} / {Math.max(1, Math.ceil(data.total / 50))} 页 · 共 {data.total} 条 ·
                  每页 50 条
                </span>
                <button
                  className="button"
                  disabled={page * 50 >= data.total}
                  onClick={() => setPage((p) => p + 1)}
                >
                  下一页
                </button>
              </div>
            </>
          ) : (
            <p>正在加载…</p>
          )}
        </div>
      </section>
    </div>
  );
}
