import { all, one, run, transaction, now, type DB } from './db.js';
import { extractArticle, extractPublication, extractListing, fetchHtml } from './crawler.js';
import { analyzeStaged, stageArticle, enrichArticle, pause } from './pipeline.js';
import { callModel } from './model.js';
import { sourceName } from './source-registry.js';
export const DAY=86400_000;
export const INITIAL_DAYS=3;
export const weekBefore=(end:string)=>new Date(Date.parse(end)-INITIAL_DAYS*DAY).toISOString();
export const crawlState=(db:DB)=>JSON.parse(one(db,"SELECT value FROM settings WHERE key='crawlState'")!.value);
export function saveCrawlState(db:DB,state:any) {run(db,"INSERT INTO settings VALUES('crawlState',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",JSON.stringify(state));}
export const windowContains=(start:string,end:string,date:string,inclusive:boolean)=>(inclusive?date>=start:date>start)&&date<=end;
export function automaticDue(db:DB,at=now()) {
  const state=crawlState(db);
  const due=state.lastRunAt?Date.parse(state.lastRunAt)+DAY:Date.parse(state.nextRunAt);
  return Number.isFinite(due)&&Date.parse(at)>=due;
}
export function refreshSchedule(db:DB,at=now()) {
  const state=crawlState(db);
  const enabled=JSON.parse(one(db,"SELECT value FROM settings WHERE key='crawler'")!.value).sources as string[];
  const states=all(db,'SELECT * FROM source_states').filter(s=>enabled.includes(s.url));
  const latest=one(db,"SELECT started_at FROM jobs WHERE kind IN ('manual','scheduled') ORDER BY started_at DESC,id DESC LIMIT 1");
  const lastRunAt=state.lastRunAt||latest?.started_at||null;
  const ends=states.map(s=>s.last_end).filter(Boolean).sort();
  const nextRunAt=lastRunAt?new Date(Date.parse(lastRunAt)+DAY).toISOString():state.nextRunAt||at;
  const next={...state,scheduleVersion:2,lastRunAt,nextRunAt,initialized:states.length===enabled.length&&states.every(s=>!!s.last_end),lastSuccessEnd:ends[0]||null,initialDays:3};
  saveCrawlState(db,next);
  for(const s of states)run(db,'UPDATE source_states SET next_run_at=? WHERE url=?',nextRunAt,s.url);
  return next;
}
export function createTask(db:DB,kind:string,ids?:number[],end=now(),withinTransaction=false) {
  if(!['manual','scheduled','model_retry'].includes(kind))throw new Error('不支持的任务类型');
  if(kind==='model_retry'&&ids?.length!==1)throw new Error('请从失败暂存区选择单篇新闻重试');
  const write=()=>{
    if(kind==='scheduled'&&!automaticDue(db,end))throw new Error('尚未到24小时自动采集时间');
    const summary:any={version:3,phase:'streaming',initialDays:3,trigger:kind==='manual'?'manual':kind==='scheduled'?(crawlState(db).lastRunAt?'scheduled':'initial'):'retry',promptId:one(db,'SELECT id FROM prompts ORDER BY id DESC LIMIT 1')!.id};
    const id=Number(run(db,"INSERT INTO jobs(kind,status,started_at,summary) VALUES(?,'running',?,?)",kind,end,JSON.stringify(summary)).lastInsertRowid);
    if(kind==='model_retry') {
      for(const itemId of ids||[]) {
        const item=one(db,'SELECT * FROM pipeline_items WHERE id=?',itemId)!;
        const url=one(db,'SELECT * FROM pipeline_urls WHERE item_id=? LIMIT 1',itemId)!;
        run(db,"INSERT INTO task_items(job_id,url,staging_id,published_at,result,model_status,title,source_name) VALUES(?,?,?,?,?,'pending',?,?)",id,url.url,itemId,item.published_at,'retry',item.title,url.source_name);
      }
    } else {
      const cfg=JSON.parse(one(db,"SELECT value FROM settings WHERE key='crawler'")!.value);
      const starts:string[]=[];
      for(const url of cfg.sources) {
        const state=one(db,'SELECT * FROM source_states WHERE url=?',url);
        const start=state?.last_end||state?.initial_start||weekBefore(end);starts.push(start);
        run(db,'INSERT OR IGNORE INTO source_states(url,next_run_at,initial_start) VALUES(?,?,?)',url,end,start);
        run(db,'INSERT INTO job_sources(job_id,url,name,window_start,window_end,start_inclusive) VALUES(?,?,?,?,?,?)',id,url,sourceName(url),start,end,state?.last_end?0:1);
        run(db,'INSERT INTO task_pages(job_id,url,source_url) VALUES(?,?,?)',id,url,url);
      }
      summary.windowStart=starts.sort()[0];summary.windowEnd=end;summary.startInclusive=all(db,'SELECT * FROM job_sources WHERE job_id=? AND start_inclusive=0',id).length===0;
      summary.mode=summary.startInclusive?'initial':'incremental';
      run(db,'UPDATE jobs SET summary=? WHERE id=?',JSON.stringify(summary),id);
      saveCrawlState(db,{...crawlState(db),scheduleVersion:2,lastRunAt:end,nextRunAt:new Date(Date.parse(end)+DAY).toISOString()});
    }
    return id;
  };
  return withinTransaction?write():transaction(db,write);
}
export function taskProgress(db:DB,id:number) {
  const initial=JSON.parse(one(db,'SELECT summary FROM jobs WHERE id=?',id)!.summary);
  const counts=one(db,`SELECT COUNT(*) AS discovered,COALESCE(SUM(result IN ('new','duplicate')),0) AS collected,COALESCE(SUM(result='duplicate'),0) AS deduplicated,COALESCE(SUM(result='new'),0) AS added,COALESCE(SUM(result='read_failed'),0) AS readFailed,COALESCE(SUM(result='date_unknown'),0) AS dateUnknown,COALESCE(SUM(result='outside'),0) AS outside,COALESCE(SUM(model_status='warning'),0) AS warningArticles,COALESCE(SUM(model_status='no_warning'),0) AS noWarning,COALESCE(SUM(model_status='failed'),0) AS modelFailed,COALESCE(SUM(model_status IN ('pending','running')),0) AS modelPending,COALESCE(SUM(result='pending'),0) AS readingPending FROM task_items WHERE job_id=?`,id)!;
  const pages=one(db,"SELECT COUNT(*) AS pages,COALESCE(SUM(status='failed'),0) AS pageFailed,COALESCE(SUM(status='pending'),0) AS pagesPending FROM task_pages WHERE job_id=?",id)!;
  const collectionFailed=counts.readFailed+counts.dateUnknown;
  const summary={...initial,...counts,...pages,countVersion:2,collected:counts.collected+collectionFailed,collectionFailed,collectionIssues:pages.pageFailed+collectionFailed,insertedNews:counts.warningArticles,publishedAlerts:one(db,'SELECT COUNT(*) AS count FROM alerts WHERE analysis_id IN (SELECT analysis_id FROM task_items WHERE job_id=?)',id)!.count,processed:counts.warningArticles+counts.noWarning+counts.modelFailed};
  run(db,'UPDATE jobs SET summary=? WHERE id=?',JSON.stringify(summary),id);return summary;
}
type Hooks={fetcher:typeof fetchHtml;analyzer:typeof callModel;enrich?:typeof enrichArticle;pause:()=>Promise<unknown>;shouldStop?:()=>boolean};
export async function executeTask(db:DB,id:number,hooks:Hooks) {
  const summary=JSON.parse(one(db,'SELECT summary FROM jobs WHERE id=?',id)!.summary);
  const checkStop=()=>{if(hooks.shouldStop?.())throw new Error('服务停止，任务已保存，重启后继续');};
  run(db,"UPDATE jobs SET status='running',error=NULL,finished_at=NULL WHERE id=?",id);
  // Publication and outcome are committed atomically; reconcile a crash before the job log update.
  for(const item of all(db,"SELECT t.id,p.status,p.news_id FROM task_items t JOIN pipeline_items p ON p.id=t.staging_id WHERE t.job_id=? AND t.model_status IN ('pending','running') AND p.status IN ('warning','no_warning','failed')",id)) {
    // Explicit retry items are intentionally pending even when the old outcome was failed.
    if(item.status==='failed'&&one(db,'SELECT model_status FROM task_items WHERE id=?',item.id)!.model_status==='pending')continue;
    run(db,'UPDATE task_items SET model_status=?,news_id=?,analysis_id=(SELECT id FROM analyses WHERE news_id=? ORDER BY id DESC LIMIT 1),error=(SELECT error FROM pipeline_items WHERE id=(SELECT staging_id FROM task_items WHERE id=?)) WHERE id=?',item.status,item.news_id,item.news_id,item.id,item.id);
  }
  run(db,"UPDATE pipeline_items SET status='pending' WHERE status='running' AND id IN (SELECT staging_id FROM task_items WHERE job_id=?)",id);
  run(db,"UPDATE task_items SET model_status='pending' WHERE job_id=? AND model_status='running'",id);
  const analyze=async(itemId:number,stageId:number)=>{
    checkStop();
    run(db,"UPDATE task_items SET model_status='running' WHERE id=?",itemId);taskProgress(db,id);
    const result=await analyzeStaged(db,stageId,hooks.analyzer);
    const err=one(db,'SELECT error FROM pipeline_items WHERE id=?',stageId)?.error;
    run(db,'UPDATE task_items SET model_status=?,news_id=?,analysis_id=?,error=? WHERE id=?',result.status,result.newsId,result.analysisId,err||null,itemId);
    taskProgress(db,id);
  };
  for(const item of all(db,"SELECT * FROM task_items WHERE job_id=? AND model_status='pending' AND staging_id IS NOT NULL ORDER BY id",id))await analyze(item.id,item.staging_id);
  const read=async(item:any,source:any)=>{
    checkStop();
    if(item.result==='pending') {
      try {
        let article;
        for(let a=1;a<=3;a++){
          try{
            const html=await hooks.fetcher(item.url);
            const publication=extractPublication(html,item.url);
            if(publication.publishedAt){
              const inside=publication.datePrecise?windowContains(source.window_start,source.window_end,publication.publishedAt,!!source.start_inclusive):Date.parse(publication.publishedAt)+DAY>Date.parse(source.window_start)&&publication.publishedAt<=source.window_end;
              if(!inside){run(db,"UPDATE task_items SET result='outside',published_at=?,error=NULL WHERE id=?",publication.publishedAt,item.id);return;}
            }
            article=extractArticle(html,item.url);break;
          }catch(e){if(a===3)throw e;await hooks.pause();}
        }
        if(!article)throw new Error('正文缺失');
        if(!article.publishedAt){run(db,"UPDATE task_items SET result='date_unknown',title=?,error='发布时间无法确认，未投入分析' WHERE id=?",article.title,item.id);return;}
        const inside=article.datePrecise?windowContains(source.window_start,source.window_end,article.publishedAt,!!source.start_inclusive):Date.parse(article.publishedAt)+DAY>Date.parse(source.window_start)&&article.publishedAt<=source.window_end;
        if(!inside){run(db,"UPDATE task_items SET result='outside',title=?,published_at=? WHERE id=?",article.title,article.publishedAt,item.id);return;}
        article=await (hooks.enrich||enrichArticle)(article);
        const staged=transaction(db,()=>{
          const staged=stageArticle(db,article!,item.url,summary.promptId,true);
          run(db,'UPDATE task_items SET result=?,title=?,published_at=?,staging_id=?,model_status=?,error=NULL WHERE id=?',staged.inserted?'new':'duplicate',article!.title,article!.publishedAt,staged.id,staged.inserted?'pending':'none',item.id);
          return staged;
        });
        if(staged.inserted)await analyze(item.id,staged.id);
      }catch(e){run(db,"UPDATE task_items SET result='read_failed',error=? WHERE id=?",e instanceof Error?e.message:'正文读取失败',item.id);}
    }
    taskProgress(db,id);await hooks.pause();
  };
  for(const source of all(db,"SELECT * FROM job_sources WHERE job_id=? AND status<>'completed' ORDER BY rowid",id)) {
    checkStop();
    run(db,"UPDATE job_sources SET status='running',error=NULL WHERE job_id=? AND url=?",id,source.url);
    for(const item of all(db,"SELECT * FROM task_items WHERE job_id=? AND source_name=? AND result='pending' ORDER BY id",id,source.name))await read(item,source);
    let page:any;
    while((page=one(db,"SELECT * FROM task_pages WHERE job_id=? AND source_url=? AND status='pending' ORDER BY rowid LIMIT 1",id,source.url))) {
      checkStop();
      try {
        let html='';for(let a=1;a<=3;a++){try{html=await hooks.fetcher(page.url);break;}catch(e){if(a===3)throw e;await hooks.pause();}}
        const listing=extractListing(html,page.url);
        if(!listing.entries.length&&!listing.seeds.length&&!/暂无|没有找到|无相关|no results/i.test(html))throw new Error('未识别有效新闻列表，不能确认覆盖完整');
        const before=listing.ordered&&listing.entries.length>0&&listing.entries.every(e=>e.publishedAt&&Date.parse(e.publishedAt)+(e.precise?0:DAY)<Date.parse(source.window_start));
        transaction(db,()=>{
          for(const e of listing.entries){
            const known=one(db,'SELECT u.*,p.status,p.news_id FROM pipeline_urls u JOIN pipeline_items p ON p.id=u.item_id WHERE u.url=?',e.url);
            const date=(e.precise?e.publishedAt:null)||known?.published_at||one(db,'SELECT published_at FROM task_items WHERE url=? AND published_at IS NOT NULL ORDER BY id DESC LIMIT 1',e.url)?.published_at;
            const outside=(e.publishedAt&&!e.precise&&(Date.parse(e.publishedAt)+DAY<=Date.parse(source.window_start)||e.publishedAt>source.window_end))||(date&&!windowContains(source.window_start,source.window_end,date,!!source.start_inclusive));
            const result=outside?'outside':known?'duplicate':'pending';
            run(db,'INSERT OR IGNORE INTO task_items(job_id,url,staging_id,published_at,result,source_name,title) VALUES(?,?,?,?,?,?,?)',id,e.url,known?.item_id||null,date||null,result,source.name,known?.title||'');
          }
          for(const url of [...listing.seeds,...(!before&&listing.next?[listing.next]:[])])run(db,'INSERT OR IGNORE INTO task_pages(job_id,url,source_url) VALUES(?,?,?)',id,url,source.url);
          run(db,"UPDATE task_pages SET status='completed',error=NULL WHERE job_id=? AND url=?",id,page.url);
        });
        for(const item of all(db,"SELECT * FROM task_items WHERE job_id=? AND source_name=? AND result='pending' ORDER BY id",id,source.name))await read(item,source);
      }catch(e){run(db,"UPDATE task_pages SET status='failed',error=? WHERE job_id=? AND url=?",e instanceof Error?e.message:'栏目读取失败',id,page.url);}
      checkStop();taskProgress(db,id);await hooks.pause();
    }
    const errors=[...all(db,"SELECT error FROM task_pages WHERE job_id=? AND source_url=? AND status='failed'",id,source.url),...all(db,"SELECT error FROM task_items WHERE job_id=? AND source_name=? AND result IN ('read_failed','date_unknown')",id,source.name)];
    transaction(db,()=>{
      run(db,'UPDATE job_sources SET status=?,error=? WHERE job_id=? AND url=?',errors.length?'failed':'completed',errors.map(e=>e.error).join('\n')||null,id,source.url);
      run(db,'INSERT INTO source_states(url,last_end,next_run_at) VALUES(?,?,?) ON CONFLICT(url) DO UPDATE SET last_end=COALESCE(excluded.last_end,last_end),next_run_at=excluded.next_run_at',source.url,errors.length?null:source.window_end,new Date(Date.parse(source.window_end)+DAY).toISOString());
    });
  }
  const sources=all(db,'SELECT * FROM job_sources WHERE job_id=?',id);
  refreshSchedule(db);
  const progress=taskProgress(db,id);const failed=progress.pageFailed+progress.readFailed+progress.dateUnknown+progress.modelFailed;
  run(db,'UPDATE jobs SET status=?,finished_at=?,error=?,summary=? WHERE id=?',failed?'partial_failed':'completed',now(),sources.filter(s=>s.error).map(s=>s.error).join('\n')||null,JSON.stringify({...progress,phase:'finished'}),id);
}
