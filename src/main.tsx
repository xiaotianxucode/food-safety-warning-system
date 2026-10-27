import React, { useEffect, useState, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ShieldCheck,
  ArrowUpRight,
  Bell,
  Search,
  RefreshCw,
  LogOut,
  LayoutDashboard,
  Database,
  Settings2,
  Users,
  Radio,
  ChevronRight,
  X,
  Leaf,
  Clock3,
  Check,
  AlertTriangle,
  Eye,
  KeyRound,
  Activity,
  Globe2,
} from 'lucide-react';
import './styles.css';
type User = { id: number; username: string; role: string };
type Alert = {
  id: number;
  news_id: number;
  published_at: string;
  is_read: number;
  withdrawn: number;
  title?: string;
  sources?: { url: string; title: string }[];
  payload: {
    food: string;
    region: string;
    company: string;
    batch: string;
    factor: string;
    impact: string;
    advice: string;
    evidence: string;
    summary: string;
    seasoning: boolean;
  };
};
async function api(path: string, options: RequestInit = {}) {
  const res = await fetch('/api' + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 401 && path !== '/login') window.dispatchEvent(new Event('session-expired'));
    throw new Error([data.error, ...(data.details || [])].filter(Boolean).join('；') || '请求失败');
  }
  return data;
}
const send = (path: string, data: unknown = {}, method = 'POST') =>
  api(path, { method, body: JSON.stringify(data) });
const fmt = (value?: string | null) =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : '暂无记录';
const statusNames: Record<string, string> = {
  pending: '待分析',
  analyzing: '分析中',
  published: '已发布',
  no_warning: '无需预警',
  filtered: '已筛除',
  duplicate: '重复报道',
  crawl_failed: '采集失败',
  analysis_failed: '分析失败',
  running: '执行中',
  completed: '已完成',
  partial_failed: '部分失败',
  failed: '失败',
  interrupted: '已中断',
  scheduled: '定时采集',
  manual: '手动采集',
  retry: '失败重试',
};
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', fn);
    const prev = document.activeElement as HTMLElement;
    const button = document.querySelector<HTMLButtonElement>('.modal .close');
    button?.focus();
    return () => {
      document.removeEventListener('keydown', fn);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="overlay" onClick={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <span className="eyebrow">FOOD SAFETY INSIGHT</span>
            <h2>{title}</h2>
          </div>
          <button className="icon-button close" onClick={onClose} aria-label="关闭">
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function Brand() {
  return (
    <div className="brand">
      <span className="brand-icon">
        <ShieldCheck size={27} />
      </span>
      <div>
        <strong>
          食安瞭望<span>FOOD SAFETY</span>
        </strong>
        <small>食品安全预警系统</small>
      </div>
    </div>
  );
}
function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <main className="login">
      <section className="login-story">
        <Brand />
        <div className="login-copy">
          <span className="eyebrow">INFORMATION INTO AWARENESS</span>
          <h1>
            让每一条风险信号，
            <br />
            都被及时看见。
          </h1>
          <p>
            汇集食品安全资讯，以智能分析连接新闻与风险。
            <br />
            为每一次关注，提供清晰、可追溯的依据。
          </p>
          <div className="orbit">
            <ShieldCheck size={72} />
            <span className="orbit-label first">
              <Activity size={16} /> 持续监测
            </span>
            <span className="orbit-label second">
              <Leaf size={16} /> 食品安全
            </span>
            <span className="orbit-label third">
              <Eye size={16} /> 风险洞察
            </span>
          </div>
        </div>
        <footer>食品资讯监测 · 模型辅助分析 · 预警及时触达</footer>
      </section>
      <section className="login-form">
        <div className="login-box">
          <span className="eyebrow">WELCOME BACK</span>
          <h2>欢迎登录</h2>
          <p className="muted">登录账号，查看最新食品安全动态。</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              const d = new FormData(e.currentTarget);
              try {
                onLogin(await send('/login', Object.fromEntries(d)));
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              账号
              <input
                name="username"
                autoComplete="username"
                placeholder="请输入账号"
                required
                maxLength={64}
              />
            </label>
            <label>
              密码
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                placeholder="请输入密码"
                required
                maxLength={128}
              />
            </label>
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <button className="button primary wide" disabled={busy}>
              {busy ? '正在登录…' : '登录系统'}
              <ArrowUpRight size={18} />
            </button>
          </form>
          <div className="login-note">
            <ShieldCheck size={18} />
            <p>
              账号由开发者统一创建。
              <br />
              首次使用，请联系系统管理员。
            </p>
          </div>
        </div>
        <footer>食安瞭望 / Food Safety Early Warning System</footer>
      </section>
    </main>
  );
}
function AlertDetail({ alert }: { alert: Alert }) {
  const a = alert.payload;
  return (
    <div className="detail">
      <div className="tag-row">
        <span className="tag danger">食品风险关注</span>
        {a.seasoning && <span className="tag green">调味品相关</span>}
        <span className="muted">发布于 {fmt(alert.published_at)}</span>
      </div>
      <h3>
        {a.region} {a.food}
      </h3>
      {alert.title && (
        <>
          <h4>相关新闻</h4>
          <p>{alert.title}</p>
        </>
      )}
      <p className="summary">{a.summary}</p>
      <div className="detail-grid">
        <div>
          <label>涉及企业</label>
          <p>{a.company || '原文未明确'}</p>
        </div>
        <div>
          <label>涉及批次 / 范围</label>
          <p>{a.batch || '以新闻描述的涉事产品为限'}</p>
        </div>
      </div>
      <h4>风险因素</h4>
      <p>{a.factor}</p>
      <h4>可能影响</h4>
      <p>{a.impact || '原文未明确'}</p>
      <h4>关注事项</h4>
      <p>{a.advice || '关注后续监管通报及涉事产品信息'}</p>
      <blockquote>
        <span>原文证据</span>
        {a.evidence}
      </blockquote>
      <p className="footnote">本分析对应新闻中的具体对象及范围，由模型辅助生成。</p>
      {alert.sources && (
        <div className="source-list">
          <h4>新闻来源（开发者核查）</h4>
          {alert.sources.map((s) => (
            <a href={s.url} target="_blank" rel="noreferrer" key={s.url}>
              {s.title}
              <ArrowUpRight size={15} />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
function Dashboard({ notify }: { notify: (text: string) => void }) {
  const [data, setData] = useState<any>({ items: [], unread: 0 });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Alert | null>(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [more, setMore] = useState(true);
  const cursor = useRef(0);
  const inFlight = useRef(false);
  const cards = useRef<HTMLDivElement>(null);
  const paused = useRef(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      let next = await api('/alerts' + (cursor.current ? '?after=' + cursor.current : ''));
      let incoming = next.items;
      while (next.hasMore) {
        next = await api('/alerts?after=' + next.cursor);
        incoming = [...incoming, ...next.items];
      }
      cursor.current = next.cursor;
      setData((old: any) => ({
        ...next,
        items: [
          ...incoming,
          ...old.items.filter(
            (a: Alert) =>
              !incoming.some((n: Alert) => n.id === a.id) && !next.withdrawnIds?.includes(a.id),
          ),
        ]
          .map((a: Alert) => ({ ...a, is_read: next.readIds?.includes(a.id) ? 1 : a.is_read }))
          .sort((a: Alert, b: Alert) => b.id - a.id),
      }));
      setDetail((current) => (current && next.withdrawnIds?.includes(current.id) ? null : current));
      setError('');
      if (document.visibilityState === 'visible') {
        const result = await send('/notifications/claim');
        if (result.count) notify(`收到 ${result.count} 条新增预警，已更新到最新动态。`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, [notify]);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 30000);
    const visible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('online', refresh);
    };
  }, [refresh]);
  const items: Alert[] = data.items.filter(
    (a: Alert) =>
      (filter !== 'unread' || !a.is_read) &&
      (filter !== 'seasoning' || a.payload.seasoning) &&
      `${a.payload.food}${a.payload.region}${a.payload.factor}${a.payload.summary}`.includes(
        search,
      ),
  );
  useEffect(() => {
    const timer = setInterval(() => {
      const node = cards.current;
      if (
        !node ||
        !autoScroll ||
        paused.current ||
        document.hidden ||
        detail ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      )
        return;
      const atEnd = node.scrollLeft + node.clientWidth >= node.scrollWidth - 5;
      node.scrollTo({
        left: atEnd ? 0 : node.scrollLeft + node.clientWidth - 48,
        behavior: 'smooth',
      });
    }, 8000);
    return () => clearInterval(timer);
  }, [autoScroll, detail]);
  const open = async (a: Alert) => {
    try {
      const fresh = await api(`/alerts/${a.id}`);
      await send(`/alerts/${a.id}/read`);
      setDetail(fresh);
      setData((d: any) => ({
        ...d,
        unread: Math.max(0, d.unread - (a.is_read ? 0 : 1)),
        items: d.items.map((x: Alert) => (x.id === a.id ? { ...x, is_read: 1 } : x)),
      }));
    } catch (e) {
      notify((e as Error).message);
      refresh();
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">SAFETY INTELLIGENCE / 风险动态</span>
          <h1>
            食品安全预警
            <span className="live">
              <i /> 实时关注
            </span>
          </h1>
          <p>从新闻中发现风险，让关注更有依据。</p>
        </div>
        <div className="page-actions">
          <span className="muted">
            <Clock3 size={15} /> 每 {data.intervalHours || 12} 小时自动采集
          </span>
          <button className="button" onClick={refresh}>
            <RefreshCw size={15} />
            刷新动态
          </button>
        </div>
      </div>
      <section className="hero">
        <div className="hero-text">
          <span className="hero-kicker">
            <Radio size={14} /> 食品安全情报监测
          </span>
          <h2>
            读懂资讯背后的
            <br />
            食品安全信号<span>。</span>
          </h2>
          <p>
            追踪监管、抽检与供应链动态，
            <br />
            聚焦具体食品，呈现有依据的风险分析。
          </p>
          <div className="hero-footer">
            <span>
              <Check size={14} /> 新闻持续汇集
            </span>
            <span>
              <Check size={14} /> 智能辅助分析
            </span>
            <span>
              <Check size={14} /> 新增合并提醒
            </span>
          </div>
        </div>
        <div className="hero-art">
          <div className="radar">
            <div className="radar-core">
              <ShieldCheck size={50} />
            </div>
            <span className="radar-dot dot1" />
            <span className="radar-dot dot2" />
            <span className="radar-dot dot3" />
          </div>
          <div className="radar-caption">
            <span className="pulse" /> RISK SIGNAL MONITORING
          </div>
        </div>
      </section>
      <div className="metrics">
        <Metric icon={<Bell />} label="待阅读预警" value={data.unread} suffix="条" accent />
        <Metric icon={<ShieldCheck />} label="近期已载入" value={data.items.length} suffix="条" />
        <Metric icon={<Clock3 />} label="最近消息发布" value={fmt(data.lastPublished)} />
        <Metric
          icon={<RefreshCw />}
          label="最近采集状态"
          value={
            data.lastJob ? statusNames[data.lastJob.status] || data.lastJob.status : '等待首次采集'
          }
          sub={fmt(data.lastJob?.finished_at || data.lastJob?.started_at)}
        />
      </div>
      <section className="feed">
        <div className="section-heading">
          <div>
            <h2>
              近期预警动态 <span>RECENT ALERTS</span>
            </h2>
            <p>聚焦具体对象，关注风险变化</p>
          </div>
          <div className="carousel-controls">
            <div className="legend">
              <i /> 新增未读
            </div>
            {items.length > 1 && (
              <>
                <button className="text-button" onClick={() => setAutoScroll((v) => !v)}>
                  {autoScroll ? '暂停滚动' : '自动滚动'}
                </button>
                <button
                  className="icon-button"
                  aria-label="上一组预警"
                  onClick={() =>
                    cards.current?.scrollBy({
                      left: -(cards.current.clientWidth - 48),
                      behavior: 'smooth',
                    })
                  }
                >
                  ‹
                </button>
                <button
                  className="icon-button"
                  aria-label="下一组预警"
                  onClick={() =>
                    cards.current?.scrollBy({
                      left: cards.current.clientWidth - 48,
                      behavior: 'smooth',
                    })
                  }
                >
                  ›
                </button>
              </>
            )}
          </div>
        </div>
        <div className="feed-toolbar">
          <div className="tabs">
            {[
              ['all', '全部预警'],
              ['unread', '未读消息'],
              ['seasoning', '调味品相关'],
            ].map(([v, l]) => (
              <button key={v} className={filter === v ? 'active' : ''} onClick={() => setFilter(v)}>
                {l}
                <b>
                  {v === 'all'
                    ? data.counts?.total ?? data.items.length
                    : v === 'seasoning'
                    ? data.counts?.seasoning ??
                      data.items.filter((a: Alert) => a.payload.seasoning).length
                    : data.unread}
                </b>
              </button>
            ))}
          </div>
          <div className="search">
            <Search size={16} />
            <input
              aria-label="搜索已载入预警"
              placeholder="搜索食品、地区或风险…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        {error && (
          <div className="error" role="alert">
            连接暂时不可用：{error}。已保留最近内容，将自动重试。
          </div>
        )}
        {data.lastJob && ['partial_failed', 'failed'].includes(data.lastJob.status) && (
          <div className="notice">
            <AlertTriangle size={16} /> 最近采集存在失败，当前展示已保存内容，开发者可在后台查看。
          </div>
        )}
        <div
          className="alert-grid"
          ref={cards}
          onPointerEnter={() => {
            paused.current = true;
          }}
          onPointerLeave={() => {
            paused.current = false;
          }}
          onFocusCapture={() => {
            paused.current = true;
          }}
          onBlurCapture={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) paused.current = false;
          }}
        >
          {items.map((a) => (
            <button
              className={`alert-card ${!a.is_read ? 'unread' : ''}`}
              key={a.id}
              onClick={() => open(a)}
            >
              <div className="card-top">
                <span className={`tag ${a.payload.seasoning ? 'green' : 'amber'}`}>
                  {a.payload.seasoning ? '调味品相关' : '食品安全'}
                </span>
                <span className="card-time">
                  {!a.is_read && <i />}
                  {fmt(a.published_at)}
                </span>
              </div>
              <h3>
                {a.payload.region && <span>{a.payload.region} · </span>}
                {a.payload.food}
              </h3>
              <p className="card-factor">{a.payload.factor}</p>
              <p className="card-summary">{a.payload.summary}</p>
              <div className="card-bottom">
                <span>
                  <Globe2 size={14} />
                  {a.payload.region || '原文未明确地区'}
                </span>
                <span>
                  查看分析
                  <ArrowUpRight size={16} />
                </span>
              </div>
            </button>
          ))}
        </div>
        {!items.length && (
          <div className="empty">
            <ShieldCheck size={38} />
            <h3>
              {loading
                ? '正在获取动态…'
                : filter === 'unread'
                ? '暂时没有未读预警'
                : '暂无符合条件的预警'}
            </h3>
            <p>
              {loading
                ? '请稍候'
                : data.items.length
                ? '可以切换筛选条件或搜索关键词。'
                : '后台完成新闻采集和分析后，预警将在这里展示。'}
            </p>
          </div>
        )}
        {data.items.length >= 100 && more && (
          <button
            className="button load-more"
            onClick={async () => {
              try {
                const next = await api(`/alerts?before=${data.items.at(-1).id}`);
                setData((d: any) => ({
                  ...d,
                  items: [
                    ...d.items,
                    ...next.items.filter((a: Alert) => !d.items.some((x: Alert) => x.id === a.id)),
                  ],
                }));
                setMore(next.items.length === 100);
              } catch (e) {
                notify((e as Error).message);
              }
            }}
          >
            加载更早消息
          </button>
        )}
        <div className="feed-footer">
          <span>
            <Activity size={14} /> 页面每 30 秒检查新增内容
          </span>
          <span>最近采集：{fmt(data.lastJob?.finished_at)}</span>
        </div>
      </section>
      {detail && (
        <Modal title="预警分析详情" onClose={() => setDetail(null)}>
          <AlertDetail alert={detail} />
        </Modal>
      )}
    </>
  );
}
function Metric({
  icon,
  label,
  value,
  suffix,
  sub,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: any;
  suffix?: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className={`metric ${accent ? 'metric-accent' : ''}`}>
      <span className="metric-icon">{icon}</span>
      <div>
        <label>{label}</label>
        <strong>
          {value}
          <small>{suffix}</small>
        </strong>
        {sub && <span className="metric-sub">{sub}</span>}
      </div>
    </div>
  );
}
function Admin({ notify }: { notify: (s: string) => void }) {
  const [tab, setTab] = useState('overview');
  const [overview, setOverview] = useState<any>();
  const [news, setNews] = useState<any>({ items: [], total: 0 });
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [settings, setSettings] = useState<any>();
  const [detail, setDetail] = useState<any>();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [createUser, setCreateUser] = useState(false);
  const [resetUser, setResetUser] = useState<any>();
  const load = useCallback(async () => {
    try {
      setOverview(await api('/admin/overview'));
      if (tab === 'news')
        setNews(await api(`/admin/news?page=${page}&search=${encodeURIComponent(search)}`));
      if (tab === 'alerts') setAlerts(await api('/admin/alerts'));
      if (tab === 'users') setUsers(await api('/admin/users'));
      if (tab === 'settings') setSettings(await api('/admin/config'));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [tab, page, search]);
  useEffect(() => {
    load();
    if (tab === 'overview' || tab === 'news') {
      const t = setInterval(load, 10000);
      return () => clearInterval(t);
    }
  }, [load, tab]);
  const action = async (fn: () => Promise<any>, message: string) => {
    setBusy(true);
    try {
      await fn();
      notify(message);
      await load();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">DEVELOPER WORKSPACE</span>
          <h1>开发者工作台</h1>
          <p>管理信息来源与分析流程，让每一条预警可追溯。</p>
        </div>
        <button
          disabled={busy || overview?.busy}
          className="button primary"
          onClick={() =>
            action(() => send('/admin/collect'), '采集任务已提交，可在运行记录查看进度。')
          }
        >
          <RefreshCw size={16} className={overview?.busy ? 'spin' : ''} />
          {overview?.busy ? '任务执行中' : '立即采集'}
        </button>
      </div>
      <div className="admin-tabs">
        {[
          ['overview', '运行概览', LayoutDashboard],
          ['news', '新闻数据库', Database],
          ['alerts', '预警管理', ShieldCheck],
          ['settings', '采集与模型', Settings2],
          ['users', '账号管理', Users],
        ].map(([v, l, Icon]: any) => (
          <button
            key={v}
            className={tab === v ? 'active' : ''}
            onClick={() => {
              setTab(v);
              setDetail(null);
            }}
          >
            <Icon size={17} />
            {l}
          </button>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      {tab === 'overview' && (
        <>
          <div className="metrics admin-metrics">
            <Metric
              icon={<Database />}
              label="已收录新闻"
              value={overview?.news ?? '—'}
              suffix="篇"
            />
            <Metric
              icon={<ShieldCheck />}
              label="已发布预警"
              value={overview?.alerts ?? '—'}
              suffix="条"
              accent
            />
            <Metric
              icon={<AlertTriangle />}
              label="待重试新闻"
              value={overview?.failed ?? '—'}
              suffix="篇"
            />
            <Metric icon={<Users />} label="启用账号" value={overview?.users ?? '—'} suffix="个" />
          </div>
          <section className="panel">
            <div className="section-heading">
              <h2>任务运行记录</h2>
              <span className="muted">每 10 秒更新</span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>任务</th>
                    <th>开始时间</th>
                    <th>状态</th>
                    <th>处理结果 / 错误</th>
                  </tr>
                </thead>
                <tbody>
                  {overview?.jobs.map((j: any) => (
                    <tr key={j.id}>
                      <td>
                        #{j.id} · {statusNames[j.kind] || j.kind}
                      </td>
                      <td>{fmt(j.started_at)}</td>
                      <td>
                        <Status value={j.status} />
                      </td>
                      <td>
                        {j.summary &&
                          (() => {
                            const s = JSON.parse(j.summary);
                            return (
                              <p>
                                发现 {s.discovered} · 抓取 {s.processed} · 新增 {s.added} · 分析{' '}
                                {s.analyzed}
                              </p>
                            );
                          })()}
                        {j.error && <pre className="inline-error">{j.error}</pre>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!overview?.jobs.length && <Empty text="暂无运行记录，点击“立即采集”开始。" />}
          </section>
        </>
      )}
      {tab === 'news' && (
        <section className="panel">
          <div className="section-heading">
            <h2>
              新闻数据库 <span>{news.total} 篇</span>
            </h2>
            <div className="search">
              <Search size={16} />
              <input
                value={search}
                placeholder="搜索新闻标题"
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </div>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>新闻标题</th>
                  <th>发布时间</th>
                  <th>处理状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {news.items.map((n: any) => (
                  <tr key={n.id}>
                    <td className="title-cell">
                      <strong>{n.title}</strong>
                      <small>
                        #{n.id} · 收录于 {fmt(n.created_at)}
                      </small>
                    </td>
                    <td>{fmt(n.published_at)}</td>
                    <td>
                      <Status value={n.status} />
                    </td>
                    <td>
                      <div className="table-actions">
                        <button className="text-button" onClick={() => setDetail(n)}>
                          查看详情
                        </button>
                        {['crawl_failed', 'analysis_failed', 'pending'].includes(n.status) && (
                          <button
                            disabled={busy || overview?.busy}
                            className="text-button"
                            onClick={() =>
                              action(() => send(`/admin/news/${n.id}/retry`), '已提交重试任务')
                            }
                          >
                            重试
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!news.items.length && <Empty text="暂无新闻记录" />}
          <div className="pagination">
            <button className="button" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              上一页
            </button>
            <span>
              第 {page} / {Math.max(1, Math.ceil(news.total / 30))} 页
            </span>
            <button
              className="button"
              disabled={page * 30 >= news.total}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </button>
          </div>
        </section>
      )}
      {tab === 'alerts' && (
        <section className="panel">
          <div className="section-heading">
            <h2>预警与来源追溯</h2>
            <span className="muted">最近 300 条</span>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>预警对象</th>
                  <th>风险因素</th>
                  <th>发布状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <strong>
                        {a.payload.region} {a.payload.food}
                      </strong>
                      <small>{fmt(a.published_at)}</small>
                    </td>
                    <td className="title-cell">{a.payload.factor}</td>
                    <td>
                      <span className={`tag ${a.withdrawn ? 'neutral' : 'green'}`}>
                        {a.withdrawn ? '已撤下' : '已发布'}
                      </span>
                    </td>
                    <td>
                      <div className="table-actions">
                        <button className="text-button" onClick={() => setDetail(a)}>
                          分析与来源
                        </button>
                        {!a.withdrawn && (
                          <button
                            className="text-button red"
                            disabled={busy}
                            onClick={() => {
                              if (confirm('撤下后用户将无法查看此预警，确定撤下？'))
                                action(() => send(`/admin/alerts/${a.id}/withdraw`), '预警已撤下');
                            }}
                          >
                            撤下
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!alerts.length && <Empty text="暂无已生成的预警" />}
        </section>
      )}
      {tab === 'settings' && settings && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action(
              () =>
                send(
                  '/admin/config',
                  { crawler: settings.crawler, prompt: settings.prompt.content },
                  'PUT',
                ),
              '配置已保存，提示词将在后续分析中生效',
            );
          }}
        >
          <section className="panel">
            <div className="section-heading">
              <h2>采集配置</h2>
              <span className="tag green">食品伙伴网</span>
            </div>
            <div className="form-grid">
              {[
                ['intervalHours', '采集间隔（小时）', 1, 168],
                ['lookbackDays', '回溯范围（天）', 1, 365],
                ['maxArticles', '单次处理上限（篇）', 1, 1000],
              ].map(([key, label, min, max]) => (
                <label key={key}>
                  {label}
                  <input
                    type="number"
                    min={min}
                    max={max}
                    required
                    value={settings.crawler[key]}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        crawler: { ...settings.crawler, [key]: Number(e.target.value) },
                      })
                    }
                  />
                </label>
              ))}
            </div>
            <label>
              来源栏目（每行一个食品伙伴网链接）
              <textarea
                rows={3}
                value={settings.crawler.sources.join('\n')}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    crawler: { ...settings.crawler, sources: e.target.value.split('\n') },
                  })
                }
              />
            </label>
            <p className="muted">遇到访问限制会记录失败；已采集正文按指纹合并，保留各来源链接。</p>
          </section>
          <section className="panel">
            <div className="section-heading">
              <h2>模型与分析提示词</h2>
              <span className={`tag ${settings.model.configured ? 'green' : 'amber'}`}>
                {settings.model.configured ? '密钥已配置' : '密钥未配置'}
              </span>
            </div>
            <div className="model-info">
              <div>
                <label>模型名称</label>
                <code>{settings.model.name}</code>
              </div>
              <div>
                <label>接口地址</label>
                <code>{settings.model.baseUrl || '使用内置阿里云兼容地址'}</code>
              </div>
            </div>
            <p className="muted">
              API 密钥由服务器 .env 管理，不在页面中显示。新闻正文作为不可信材料处理。
            </p>
            <label>
              系统提示词 · 版本 {settings.prompt.id}
              <textarea
                rows={16}
                required
                minLength={100}
                value={settings.prompt.content}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    prompt: { ...settings.prompt, content: e.target.value },
                  })
                }
              />
            </label>
            <div className="form-actions">
              <button
                type="button"
                disabled={busy}
                className="button"
                onClick={() => action(() => send('/admin/model/test'), '模型连接及结构校验成功')}
              >
                测试已保存配置
              </button>
              <button className="button primary" disabled={busy}>
                保存配置
              </button>
            </div>
          </section>
        </form>
      )}
      {tab === 'users' && (
        <section className="panel">
          <div className="section-heading">
            <h2>账号管理</h2>
            <button className="button primary" onClick={() => setCreateUser(true)}>
              <Users size={16} />
              创建账号
            </button>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>账号</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th>创建时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <strong>{u.username}</strong>
                    </td>
                    <td>{u.role === 'developer' ? '开发者' : '普通用户'}</td>
                    <td>
                      <span className={`tag ${u.active ? 'green' : 'neutral'}`}>
                        {u.active ? '启用' : '停用'}
                      </span>
                    </td>
                    <td>{fmt(u.created_at)}</td>
                    <td>
                      <div className="table-actions">
                        <button className="text-button" onClick={() => setResetUser(u)}>
                          重置密码
                        </button>
                        <button
                          disabled={busy}
                          className="text-button"
                          onClick={() =>
                            action(
                              () => send(`/admin/users/${u.id}`, { active: !u.active }, 'PATCH'),
                              u.active ? '账号已停用' : '账号已启用',
                            )
                          }
                        >
                          {u.active ? '停用' : '启用'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {detail && (
        <Modal
          title={detail.payload ? '预警分析与来源' : '新闻内容与处理记录'}
          onClose={() => setDetail(null)}
        >
          {detail.payload ? (
            <AlertDetail alert={detail} />
          ) : (
            <div className="detail">
              <Status value={detail.status} />
              <h3>{detail.title}</h3>
              <p className="muted">发布时间：{fmt(detail.published_at)}</p>
              {detail.error && <div className="error">{detail.error}</div>}
              <div className="source-list">
                {detail.sources.map((s: any) => (
                  <a key={s.url} href={s.url} target="_blank" rel="noreferrer">
                    {s.url}
                    <ArrowUpRight size={16} />
                  </a>
                ))}
              </div>
              <h4>新闻正文</h4>
              <pre className="news-body">{detail.body || '正文尚未成功获取'}</pre>
              <h4>分析记录</h4>
              {detail.analyses.map((a: any) => (
                <div className="analysis-record" key={a.id}>
                  <p>
                    {statusNames[a.status] || a.status} · {a.model} · 提示词 v{a.prompt_id} · 尝试{' '}
                    {a.attempts} 次
                  </p>
                  <small>{fmt(a.created_at)}</small>
                  {a.error && <div className="error">{a.error}</div>}
                  {a.result && (
                    <pre className="news-body">{JSON.stringify(JSON.parse(a.result), null, 2)}</pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
      {(createUser || resetUser) && (
        <Modal
          title={resetUser ? `重置密码 · ${resetUser.username}` : '创建账号'}
          onClose={() => {
            setCreateUser(false);
            setResetUser(null);
          }}
        >
          <form
            className="detail"
            onSubmit={async (e) => {
              e.preventDefault();
              const d = Object.fromEntries(new FormData(e.currentTarget));
              setBusy(true);
              try {
                if (resetUser)
                  await send(`/admin/users/${resetUser.id}`, { password: d.password }, 'PATCH');
                else await send('/admin/users', d);
                setCreateUser(false);
                setResetUser(null);
                notify('账号信息已保存');
                load();
              } catch (e) {
                notify((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {!resetUser && (
              <>
                <label>
                  用户名
                  <input name="username" required minLength={2} maxLength={32} />
                </label>
                <label>
                  角色
                  <select name="role">
                    <option value="user">普通用户</option>
                    <option value="developer">开发者</option>
                  </select>
                </label>
              </>
            )}
            <label>
              密码（至少 10 位）
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={10}
                maxLength={128}
              />
            </label>
            <button className="button primary" disabled={busy}>
              保存
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
function Status({ value }: { value: string }) {
  return (
    <span
      className={`tag ${
        /failed|interrupted/.test(value)
          ? 'danger'
          : /published|completed/.test(value)
          ? 'green'
          : 'neutral'
      }`}
    >
      {statusNames[value] || value}
    </span>
  );
}
function Empty({ text }: { text: string }) {
  return (
    <div className="empty">
      <Database size={32} />
      <p>{text}</p>
    </div>
  );
}
function App() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState('dashboard');
  const [toast, setToast] = useState('');
  const [password, setPassword] = useState(false);
  const notify = useCallback((s: string) => setToast(s), []);
  useEffect(() => {
    api('/me')
      .then(setUser)
      .catch(() => {})
      .finally(() => setReady(true));
    const expired = () => setUser(null);
    window.addEventListener('session-expired', expired);
    return () => window.removeEventListener('session-expired', expired);
  }, []);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(''), 12000);
      return () => clearTimeout(t);
    }
  }, [toast]);
  if (!ready)
    return (
      <div className="boot">
        <ShieldCheck size={40} />
        <p>正在连接食安瞭望…</p>
      </div>
    );
  if (!user)
    return (
      <Login
        onLogin={(u) => {
          setUser(u);
          setView('dashboard');
        }}
      />
    );
  return (
    <div className="app">
      <header className="topbar">
        <Brand />
        <nav>
          <button
            className={view === 'dashboard' ? 'selected' : ''}
            onClick={() => setView('dashboard')}
          >
            <Radio size={16} />
            预警动态
          </button>
          {user.role === 'developer' && (
            <button className={view === 'admin' ? 'selected' : ''} onClick={() => setView('admin')}>
              <LayoutDashboard size={16} />
              开发者后台
            </button>
          )}
        </nav>
        <div className="account">
          <span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span>
          <span>
            {user.username}
            <small>{user.role === 'developer' ? '开发者' : '用户'}</small>
          </span>
          <button
            className="icon-button"
            aria-label="修改密码"
            title="修改密码"
            onClick={() => setPassword(true)}
          >
            <KeyRound size={17} />
          </button>
          <button
            className="icon-button"
            aria-label="退出登录"
            title="退出登录"
            onClick={async () => {
              try {
                await send('/logout');
                setUser(null);
              } catch (e) {
                notify((e as Error).message);
              }
            }}
          >
            <LogOut size={17} />
          </button>
        </div>
      </header>
      <main className="main">
        {view === 'admin' ? <Admin notify={notify} /> : <Dashboard notify={notify} />}
      </main>
      <footer className="site-footer">
        <Brand />
        <span>食品资讯监测与智能分析平台</span>
        <span>信息有依据 · 预警可追溯</span>
      </footer>
      {toast && (
        <div className="toast" role="status">
          <Bell size={19} />
          <span>{toast}</span>
          <button className="icon-button" onClick={() => setToast('')} aria-label="关闭提醒">
            <X size={16} />
          </button>
        </div>
      )}
      {password && (
        <Modal title="修改密码" onClose={() => setPassword(false)}>
          <form
            className="detail"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await send('/password', Object.fromEntries(new FormData(e.currentTarget)));
                setPassword(false);
                setUser(null);
                notify('密码已修改，请重新登录');
              } catch (e) {
                notify((e as Error).message);
              }
            }}
          >
            <label>
              原密码
              <input
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            <label>
              新密码（至少 10 位）
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={10}
                maxLength={128}
              />
            </label>
            <button className="button primary">修改并重新登录</button>
          </form>
        </Modal>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
