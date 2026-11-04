import React,{useEffect,useState} from 'react';
export function FailurePanel({blocked}:{blocked:boolean}) {
  const [data,setData]=useState<any>({items:[],total:0});const [page,setPage]=useState(1);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  const load=()=>fetch(`/api/admin/failures?page=${page}`).then(async r=>{const v=await r.json();if(!r.ok)throw new Error(v.error);setData(v);}).catch(e=>setError(e.message));
  useEffect(()=>{load();const t=setInterval(load,5000);return()=>clearInterval(t);},[page]);
  return <section className="panel"><div className="section-heading"><div><h2>模型分析失败暂存区（{data.total} 篇）</h2><p>失败正文单独保存，不计入新闻库；无需预警的正文已舍弃。</p></div></div>
    {error&&<p className="error">{error}</p>}
    <div className="table-scroll"><table><thead><tr><th>文章与来源</th><th>处理状态</th><th>操作</th></tr></thead><tbody>{data.items.map((i:any)=><tr key={i.id}><td className="title-cell"><strong>{i.title}</strong><small>{i.source_name} · 已尝试 {i.attempts} 次 · 提示词 v{i.prompt_id}</small><a href={i.url} target="_blank" rel="noreferrer">查看原文</a></td><td className="title-cell"><span className="tag danger">模型分析失败</span><details><summary>查看失败原因</summary>{i.error}</details></td><td><button className="button" disabled={busy||blocked} onClick={async()=>{setBusy(true);setError('');try{const r=await fetch(`/api/admin/failures/${i.id}/retry`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const v=await r.json();if(!r.ok)throw new Error(v.error);await load();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>单篇重试</button></td></tr>)}</tbody></table></div>
    {!data.total&&<p className="muted">暂无模型失败文章。</p>}
    <div className="pagination"><button className="button" disabled={page===1} onClick={()=>setPage(p=>p-1)}>上一页</button><span>{page} / {Math.max(1,Math.ceil(data.total/30))}</span><button className="button" disabled={page*30>=data.total} onClick={()=>setPage(p=>p+1)}>下一页</button></div>
  </section>;
}
