import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase,all,one,run,now } from '../server/db.js';
import {initialize,Worker,setSetting} from '../server/service.js';
import {createTask,executeTask,taskProgress,crawlState,refreshSchedule,DAY} from '../server/collection.js';
import {stageArticle,analyzeStaged,attachmentText} from '../server/pipeline.js';
import {validateAnalysis} from '../server/model.js';
import {extractListing,extractArticle,canonicalUrl} from '../server/crawler.js';
import {createApp} from '../server/app.js';
import {failureCounts} from '../server/failure-counts.js';
import {failureTotals,failureLabel,collectionCounts} from '../src/failure-status.js';
import {taskTitle,taskPhase,sourceCollectionMode} from '../src/task-labels.js';
import {hashPassword} from '../server/auth.js';
import * as XLSX from 'xlsx';
const END='2026-11-04T12:00:00.000Z';
const ROOT='https://news.foodmate.net/guonei/';
const noWarning={shouldWarn:false,summary:'会议宣传，未披露具体食品风险。',alerts:[]};
const body='日本草莓检出残留农药不合格，涉事产品退运。此次通报仅涉及本次检验的涉事产品。';
const warning={shouldWarn:true,summary:'涉事草莓检出农药残留不合格。',alerts:[{food:'草莓',region:'日本',company:'',batch:'',factor:'农药残留',impact:'',advice:'关注涉事产品',evidence:'日本草莓检出残留农药不合格，涉事产品退运。',seasoning:false,risks:[{category:'chemical',subtype:'农药残留',note:'仅限涉事产品'}]}]};
const article=(text=body)=>({title:'固定验证样例',body:text,publishedAt:'2026-11-04T02:00:00.000Z',attachments:[]});
const html=(text=body)=>`<h1>固定验证样例</h1><p>时间：2026-11-04 10:00</p><div id="article">${text}</div>`;
const list=(ids:number[])=>ids.map(id=>`<li class="catlist_li"><span>2026-11-04 10:00</span><a href="/2026/11/${id}.html">固定样例${id}</a></li>`).join('');
function db(){const d=openDatabase(':memory:');initialize(d);setSetting(d,'crawler',{intervalHours:24,sources:[ROOT]});setSetting(d,'crawlState',{initialized:false,nextRunAt:END,lastRunAt:null,initialDays:3,scheduleVersion:2});return d;}
async function idle(worker:Worker){for(let i=0;worker.busy&&i<1000;i++)await new Promise(r=>setTimeout(r,1));assert.equal(worker.busy,false);}
const execute=(d:any,id:number,fetcher:any,analyzer:any)=>executeTask(d,id,{fetcher,analyzer,enrich:async a=>a,pause:async()=>{}});

test('失败提示只分采集与模型分析两类，旧记录细项合并且保留正确单位',()=>{
 assert.deepEqual(failureTotals({pageFailed:2,readFailed:3,dateUnknown:1,modelFailed:4}),{collection:6,analysis:4});
 assert.deepEqual(failureTotals({collectionFailed:5,pageFailed:2,modelFailed:1}),{collection:5,analysis:1});
 for(const status of ['read_failed','date_unknown','crawl_failed'])assert.equal(failureLabel(status),'采集失败');
 assert.equal(failureLabel('failed'),'模型分析失败');assert.equal(failureLabel('pending'),undefined);
});
test('新增待判定=采集新闻-采集失败-去重，三行统计在失败和重复并存时一致',()=>{
 const d=db();const job=createTask(d,'manual',undefined,END);
 run(d,"UPDATE task_pages SET status='failed' WHERE job_id=?",job);
 const rows=[['new','warning'],['new','no_warning'],['new','failed'],['new','pending'],['duplicate','none'],['duplicate','none'],['read_failed','none'],['date_unknown','none'],['outside','none'],['pending','none']];
 rows.forEach(([result,model],index)=>run(d,'INSERT INTO task_items(job_id,url,result,model_status) VALUES(?,?,?,?)',job,ROOT+index,result,model));
 const s=taskProgress(d,job);assert.equal(s.collected,8);assert.equal(s.collectionFailed,2);assert.equal(s.deduplicated,2);assert.equal(s.added,4);
 assert.equal(s.added,s.collected-s.collectionFailed-s.deduplicated);
 assert.equal(s.added,s.warningArticles+s.noWarning+s.modelFailed+s.modelPending);
 assert.deepEqual(collectionCounts(s),{collected:8,failed:2,deduplicated:2,added:4});
 assert.deepEqual(collectionCounts({collected:6,readFailed:1,dateUnknown:1,pageFailed:1,collectionFailed:3,deduplicated:2,added:4}),collectionCounts(s));
 assert.equal(taskProgress(d,job).collected,8);
 run(d,'UPDATE jobs SET summary=? WHERE id=?',JSON.stringify({version:3,collected:6,readFailed:1,dateUnknown:1,pageFailed:1,added:4}),job);
 run(d,'DELETE FROM migrations WHERE version=6');initialize(d);
 const migrated=JSON.parse(one(d,'SELECT summary FROM jobs WHERE id=?',job)!.summary);assert.equal(migrated.countVersion,2);assert.equal(migrated.collected,8);assert.equal(migrated.added,4);assert.equal(failureTotals(migrated).collection,3);d.close();
});
test('当前采集失败合并页面与文章问题，恢复后不重复累计旧失败记录',()=>{
 const d=db();const job=createTask(d,'manual',undefined,END);
 run(d,"UPDATE task_pages SET status='failed' WHERE job_id=?",job);
 run(d,"INSERT INTO task_items(job_id,url,result) VALUES(?,?,'read_failed')",job,ROOT+'a');
 run(d,"INSERT INTO task_items(job_id,url,result) VALUES(?,?,'date_unknown')",job,ROOT+'b');
 assert.equal(failureCounts(d).collection,3);
 assert.equal(taskProgress(d,job).collectionFailed,2);
 assert.equal(taskProgress(d,job).collectionIssues,3);
 const next=createTask(d,'manual',undefined,END);
 run(d,"UPDATE task_pages SET status='completed' WHERE job_id=?",next);
 for(const suffix of ['a','b'])run(d,"INSERT INTO task_items(job_id,url,result) VALUES(?,?,'outside')",next,ROOT+suffix);
 assert.deepEqual(failureCounts(d),{collection:0,analysis:0});d.close();
});
test('首次72小时；断网超过24h后补齐原窗口；失败源保留初始边界',async()=>{
 const d=db();let id=createTask(d,'manual',undefined,END);
 const initial=one(d,'SELECT * FROM job_sources WHERE job_id=?',id)!;assert.equal(Date.parse(END)-Date.parse(initial.window_start),3*DAY);
 await execute(d,id,async()=>{throw new Error('offline');},async()=>noWarning);
 const later=new Date(Date.parse(END)+3*DAY).toISOString();id=createTask(d,'scheduled',undefined,later);
 assert.equal(one(d,'SELECT window_start FROM job_sources WHERE job_id=?',id)!.window_start,initial.window_start);
 await execute(d,id,async()=>'<div>暂无新闻</div>',async()=>noWarning);
 const next=new Date(Date.parse(later)+2*DAY).toISOString();id=createTask(d,'scheduled',undefined,next);
 assert.equal(one(d,'SELECT window_start FROM job_sources WHERE job_id=?',id)!.window_start,later);
 assert.equal(one(d,'SELECT start_inclusive FROM job_sources WHERE job_id=?',id)!.start_inclusive,0);d.close();
});
test('失败源保留缺口，但不会在24小时内提前新建自动任务',async()=>{
 const d=db();const other='https://www.cfsn.cn/news/2037.html';setSetting(d,'crawler',{intervalHours:24,sources:[ROOT,other]});
 const id=createTask(d,'scheduled',undefined,END);await execute(d,id,async(url:string)=>{if(url===other)throw new Error('offline');return '暂无新闻';},async()=>noWarning);
 const later=new Date(Date.parse(END)+600000).toISOString();assert.throws(()=>createTask(d,'scheduled',undefined,later),/24小时/);assert.equal(one(d,'SELECT COUNT(*) n FROM jobs')!.n,1);
 assert.equal(crawlState(d).nextRunAt,new Date(Date.parse(END)+DAY).toISOString());
 const next=createTask(d,'scheduled',undefined,new Date(Date.parse(END)+DAY).toISOString());
 assert.deepEqual(all(d,'SELECT url FROM job_sources WHERE job_id=? ORDER BY rowid',next).map(s=>s.url),[ROOT,other]);
 assert.equal(one(d,'SELECT window_start FROM job_sources WHERE job_id=? AND url=?',next,other)!.window_start,new Date(Date.parse(END)-3*DAY).toISOString());d.close();
});
test('统一24小时调度：配置保存、重复tick及重启不新增任务，到期和离线补采只各运行一次',async()=>{
 const d=db();let clock=END;const fetcher=async()=>'<div>暂无新闻</div>';const worker=new Worker(d,fetcher,async()=>noWarning,()=>clock);
 try{
  worker.tick();worker.tick();await idle(worker);assert.equal(one(d,'SELECT COUNT(*) n FROM jobs')!.n,1);
  clock=new Date(Date.parse(END)+600000).toISOString();setSetting(d,'crawler',{intervalHours:24,sources:[ROOT,'https://www.cfsn.cn/news/2037.html']});refreshSchedule(d,clock);
  worker.tick();await idle(worker);assert.equal(one(d,'SELECT COUNT(*) n FROM jobs')!.n,1);assert.equal(crawlState(d).nextRunAt,new Date(Date.parse(END)+DAY).toISOString());
  const restarted=new Worker(d,fetcher,async()=>noWarning,()=>clock);restarted.start();await idle(restarted);await restarted.stop();assert.equal(one(d,'SELECT COUNT(*) n FROM jobs')!.n,1);
  clock=new Date(Date.parse(END)+DAY-1).toISOString();worker.tick();assert.equal(one(d,'SELECT COUNT(*) n FROM jobs')!.n,1);
  clock=new Date(Date.parse(END)+DAY).toISOString();worker.tick();worker.tick();await idle(worker);assert.equal(one(d,'SELECT COUNT(*) n FROM jobs')!.n,2);
  const newSource=one(d,'SELECT * FROM job_sources WHERE job_id=2 AND url=?','https://www.cfsn.cn/news/2037.html')!;assert.equal(newSource.window_start,new Date(Date.parse(clock)-3*DAY).toISOString());
  clock=new Date(Date.parse(END)+4*DAY).toISOString();worker.tick();await idle(worker);worker.tick();assert.equal(one(d,'SELECT COUNT(*) n FROM jobs')!.n,3);
  const catchup=one(d,'SELECT * FROM job_sources WHERE job_id=3 AND url=?',ROOT)!;assert.equal(catchup.window_start,new Date(Date.parse(END)+DAY).toISOString());assert.equal(catchup.window_end,clock);
 }finally{await worker.stop();d.close();}
});
test('手动采集明确记为manual，后续自动采集从手动开始时刻计24小时',async()=>{
 const d=db();let clock=END;const worker=new Worker(d,async()=>'<div>暂无新闻</div>',async()=>noWarning,()=>clock);
 try{worker.tick();await idle(worker);clock=new Date(Date.parse(END)+3600000).toISOString();assert.ok(worker.launch());await idle(worker);assert.equal(one(d,'SELECT kind FROM jobs WHERE id=2')!.kind,'manual');assert.equal(crawlState(d).nextRunAt,new Date(Date.parse(clock)+DAY).toISOString());worker.tick();assert.equal(one(d,'SELECT COUNT(*) n FROM jobs')!.n,2);}finally{await worker.stop();d.close();}
});
test('恢复未完成任务复用任务编号，结束记录不再重复显示完成阶段',async()=>{
 const d=db();const id=createTask(d,'scheduled',undefined,END);run(d,"UPDATE jobs SET status='interrupted' WHERE id=?",id);let clock=new Date(Date.parse(END)+600000).toISOString();const worker=new Worker(d,async()=>'<div>暂无新闻</div>',async()=>noWarning,()=>clock);
 try{worker.tick();await idle(worker);assert.equal(one(d,'SELECT COUNT(*) n FROM jobs')!.n,1);assert.equal(one(d,'SELECT status FROM jobs WHERE id=?',id)!.status,'completed');assert.equal(crawlState(d).lastRunAt,END);}finally{await worker.stop();d.close();}
 for(const status of ['completed','partial_failed','failed'])assert.equal(taskPhase({status,summary:JSON.stringify({phase:'finished'})}),null);
 assert.equal(taskTitle({kind:'maintenance'}),'维护补采（历史）');assert.equal(taskTitle({kind:'configuration'}),'配置触发（历史）');assert.equal(taskTitle({kind:'scheduled',summary:JSON.stringify({trigger:'initial'})}),'首次采集');
});
test('第一篇立即分析发布，再获取第二篇；无需预警正文不入库且被清除',async()=>{
 const d=db();const events:string[]=[];const id=createTask(d,'manual',undefined,END);
 await execute(d,id,async(url:string)=>{if(url===ROOT)return list([1,2]);events.push('fetch:'+url.split('/').at(-1));if(url.endsWith('2.html'))assert.equal(one(d,'SELECT COUNT(*) n FROM alerts')!.n,1);return url.endsWith('1.html')?html():html('举办调味品新品会议，介绍最新酱油产品。新闻没有披露任何具体食品风险，仅为会议宣传。');},async(_p:string,b:string)=>{events.push('model');return b.includes('日本')?warning:noWarning;});
 assert.deepEqual(events,['fetch:1.html','model','fetch:2.html','model']);assert.equal(one(d,'SELECT COUNT(*) n FROM news')!.n,1);
 assert.equal(one(d,"SELECT body FROM pipeline_items WHERE status='no_warning'")!.body,'');assert.equal(one(d,'SELECT COUNT(*) n FROM analyses')!.n,1);
 const s=taskProgress(d,id);assert.equal(s.collected-s.deduplicated,s.added);assert.equal(s.added,s.warningArticles+s.noWarning+s.modelFailed+s.modelPending);d.close();
});
test('URL及跨站正文指纹去重；不重复调用模型；需预警重复报道关联来源',async()=>{
 const d=db();const prompt=one(d,'SELECT MAX(id) id FROM prompts')!.id;
 const a=stageArticle(d,article(),'https://news.foodmate.net/2026/11/1.html',prompt);await analyzeStaged(d,a.id,async()=>warning as any);
 const duplicate=stageArticle(d,article(),'https://www.cfsn.cn/news/detail/2040/2.html',prompt);assert.equal(duplicate.inserted,false);assert.equal(one(d,'SELECT COUNT(*) n FROM sources')!.n,2);
 const b=stageArticle(d,article('本次开展食品知识宣传会议，现场介绍调味品新品，未发现具体风险。'),'https://news.foodmate.net/2026/11/3.html',prompt);await analyzeStaged(d,b.id,async()=>noWarning);
 assert.equal(stageArticle(d,article('本次开展食品知识宣传会议，现场介绍调味品新品，未发现具体风险。'),'https://www.cfsn.cn/news/detail/2040/4.html',prompt).inserted,false);d.close();
});
test('失败不入新闻库，暂存正文并支持单篇重试',async()=>{
 const d=db();const id=stageArticle(d,article(),'https://news.foodmate.net/2026/11/1.html',one(d,'SELECT MAX(id) id FROM prompts')!.id).id;
 await analyzeStaged(d,id,async()=>{throw new Error('timeout');});assert.equal(one(d,'SELECT COUNT(*) n FROM news')!.n,0);assert.equal(one(d,'SELECT attempts FROM pipeline_items WHERE id=?',id)!.attempts,1);
 assert.ok(one(d,'SELECT body FROM pipeline_items WHERE id=?',id)!.body);
 const worker=new Worker(d,async()=>'',async()=>warning as any);assert.ok(worker.launch('retry',id));await worker.stop();assert.equal(one(d,'SELECT status FROM pipeline_items WHERE id=?',id)!.status,'warning');d.close();
});
test('一篇多对象、多分类；非法分类或编造证据不能发布',async()=>{
 const d=db();const input={...warning,alerts:[warning.alerts[0],{...warning.alerts[0],food:'日本草莓',factor:'本次农药残留',risks:[{category:'other',subtype:'其他风险',note:'仍需原文支持'}]}]};
 const id=stageArticle(d,article(),'https://news.foodmate.net/2026/11/1.html',one(d,'SELECT MAX(id) id FROM prompts')!.id).id;await analyzeStaged(d,id,async()=>input as any);
 assert.equal(one(d,'SELECT COUNT(*) n FROM news')!.n,1);assert.equal(one(d,'SELECT COUNT(*) n FROM alerts')!.n,2);
 assert.deepEqual(JSON.parse(one(d,'SELECT categories FROM news')!.categories),['chemical','other']);
 assert.throws(()=>validateAnalysis({...warning,alerts:[{...warning.alerts[0],risks:[{category:'bad',subtype:'x',note:'x'}]}]},body));
 assert.throws(()=>validateAnalysis({...warning,alerts:[{...warning.alerts[0],evidence:'不存在的草莓原文证据'}]},body));d.close();
});
test('来源独立成功检查点，正文缺失/时间不明不能误记无预警',async()=>{
 const d=db();setSetting(d,'crawler',{intervalHours:24,sources:[ROOT,'https://www.cfsn.cn/news/2037.html']});const id=createTask(d,'manual',undefined,END);
 await execute(d,id,async(url:string)=>{if(url.includes('cfsn'))throw new Error('403');if(url===ROOT)return list([1,2]);if(url.endsWith('1.html'))return '<h1>正文缺失</h1>';return '<h1>时间缺失</h1><div id="article">这个食品的文章有足够长的正文，但是没有可确认的发布时间，不能投入模型分析。</div>';},async()=>{throw new Error('不应调用模型');});
 assert.equal(one(d,'SELECT COUNT(*) n FROM news')!.n,0);const s=taskProgress(d,id);assert.equal(s.readFailed,1);assert.equal(s.dateUnknown,1);assert.equal(s.noWarning,0);assert.equal(sourcesCount(d),2);d.close();
 function sourcesCount(d:any){return one(d,'SELECT COUNT(*) n FROM job_sources WHERE status=\'failed\'')!.n;}
});
test('窗口外旧图文页先按发布元数据排除，不因没有正文误报采集失败',async()=>{
 const d=db();const root='https://scjgj.cq.gov.cn/zt_225/spaqzb/';setSetting(d,'crawler',{intervalHours:24,sources:[root]});const id=createTask(d,'manual',undefined,END);
 await execute(d,id,async(url:string)=>url.includes('t20250408_')?'<meta name="PubDate" content="2025-04-08 12:00"><meta name="ArticleTitle" content="旧科普图文"><img src="old.png">':'<a href="https://scjgj.cq.gov.cn/zt_225/spaqzb/ggfw/202504/t20250408_1.html">一图读懂保健食品</a>',async()=>{throw new Error('窗口外不得调用模型');});
 const s=taskProgress(d,id);assert.equal(s.outside,1);assert.equal(s.readFailed,0);assert.equal(one(d,'SELECT status FROM jobs WHERE id=?',id)!.status,'completed');assert.equal(one(d,'SELECT last_end FROM source_states WHERE url=?',root)!.last_end,END);d.close();
});
test('中断的模型调用不会自动重复，保留正文并标为模型失败等待手动重试',async()=>{
 const d=db();const job=createTask(d,'manual',undefined,END);const p=one(d,'SELECT MAX(id) id FROM prompts')!.id;
 const item=stageArticle(d,article(),'https://news.foodmate.net/2026/11/1.html',p);run(d,"INSERT INTO task_items(job_id,url,staging_id,result,model_status,source_name) VALUES(?,?,?,'new','running','食品伙伴网')",job,'https://news.foodmate.net/2026/11/1.html',item.id);
 run(d,"UPDATE pipeline_items SET status='running' WHERE id=?",item.id);run(d,"UPDATE task_pages SET status='completed' WHERE job_id=?",job);
 let calls=0;await execute(d,job,async()=>{throw new Error('不应重新读取');},async()=>{calls++;return warning;});assert.equal(calls,0);assert.equal(one(d,'SELECT COUNT(*) n FROM news')!.n,0);assert.equal(one(d,'SELECT status FROM jobs WHERE id=?',job)!.status,'partial_failed');assert.equal(one(d,'SELECT status FROM pipeline_items WHERE id=?',item.id)!.status,'failed');assert.ok(one(d,'SELECT body FROM pipeline_items WHERE id=?',item.id)!.body);d.close();
});
test('每篇模型只调用一次，后续自动任务不会重试失败文章，人工重试才再次调用',async()=>{
 const d=db();let calls=0;const fetcher=async(url:string)=>url===ROOT?list([1]):html();const analyzer=async()=>{calls++;throw new Error('固定超时');};
 const first=createTask(d,'scheduled',undefined,END);await execute(d,first,fetcher,analyzer);assert.equal(calls,1);assert.equal(taskProgress(d,first).modelFailed,1);
 const next=createTask(d,'scheduled',undefined,new Date(Date.parse(END)+DAY).toISOString());await execute(d,next,fetcher,analyzer);assert.equal(calls,1);assert.equal(one(d,"SELECT COUNT(*) n FROM pipeline_items WHERE status='failed'")!.n,1);
 const failed=one(d,"SELECT id FROM pipeline_items WHERE status='failed'")!;const worker=new Worker(d,fetcher,async()=>{calls++;return warning as any;});assert.ok(worker.launch('retry',failed.id));await idle(worker);await worker.stop();assert.equal(calls,2);assert.equal(one(d,'SELECT COUNT(*) n FROM news')!.n,1);d.close();
});
test('采集请求失败只调用一次，不重复请求或另建维护任务',async()=>{
 const d=db();let requests=0;const first=createTask(d,'scheduled',undefined,END);await execute(d,first,async()=>{requests++;throw new Error('offline');},async()=>noWarning);assert.equal(requests,1);assert.equal(one(d,'SELECT COUNT(*) n FROM jobs')!.n,1);assert.equal(one(d,'SELECT status FROM jobs')!.status,'partial_failed');d.close();
});
test('不同来源独立记录首次和增量窗口，不保存误导性的统一时间段',async()=>{
 const d=db();const first=createTask(d,'manual',undefined,END);await execute(d,first,async()=>'<div>暂无新闻</div>',async()=>noWarning);
 const other='https://www.cfsn.cn/news/2037.html';setSetting(d,'crawler',{intervalHours:24,sources:[ROOT,other]});const end=new Date(Date.parse(END)+DAY).toISOString();const next=createTask(d,'scheduled',undefined,end);
 const old=one(d,'SELECT * FROM job_sources WHERE job_id=? AND url=?',next,ROOT)!;const added=one(d,'SELECT * FROM job_sources WHERE job_id=? AND url=?',next,other)!;
 assert.equal(old.mode,'incremental');assert.equal(old.window_start,END);assert.equal(old.start_inclusive,0);assert.equal(added.mode,'initial');assert.equal(added.window_start,new Date(Date.parse(end)-3*DAY).toISOString());assert.equal(added.start_inclusive,1);
 assert.equal(sourceCollectionMode(old),'增量采集');assert.equal(sourceCollectionMode(added),'首次采集（近三天）');const summary=JSON.parse(one(d,'SELECT summary FROM jobs WHERE id=?',next)!.summary);assert.equal(summary.windowStart,undefined);assert.equal(summary.windowEnd,undefined);d.close();
});
test('发布事务提交后、任务日志更新前崩溃，不会重复分析或卡住',async()=>{
 const d=db();const job=createTask(d,'manual',undefined,END);const p=one(d,'SELECT MAX(id) id FROM prompts')!.id;const item=stageArticle(d,article(),'https://news.foodmate.net/2026/11/1.html',p);
 run(d,"INSERT INTO task_items(job_id,url,staging_id,result,model_status) VALUES(?,?,?,'new','running')",job,'https://news.foodmate.net/2026/11/1.html',item.id);await analyzeStaged(d,item.id,async()=>warning as any);run(d,"UPDATE task_pages SET status='completed' WHERE job_id=?",job);
 await execute(d,job,async()=>{throw new Error('不应重新获取');},async()=>{throw new Error('不应再次分析');});assert.equal(taskProgress(d,job).warningArticles,1);assert.equal(one(d,'SELECT COUNT(*) n FROM alerts')!.n,1);d.close();
});
test('后续启动不再清库，新闻和预警发布序号保留',async()=>{
 const d=db();const item=stageArticle(d,article(),'https://news.foodmate.net/2026/11/1.html',one(d,'SELECT MAX(id) id FROM prompts')!.id);await analyzeStaged(d,item.id,async()=>warning as any);
 const max=one(d,'SELECT MAX(id) id FROM alerts')!.id;initialize(d);assert.equal(one(d,'SELECT COUNT(*) n FROM news')!.n,1);assert.equal(one(d,'SELECT MAX(id) id FROM alerts')!.id,max);
 const worker=new Worker(d,async()=>'',async()=>noWarning);assert.equal(worker.launch('analysis_reset'),false);assert.equal(worker.launch('model_retry'),false);assert.equal(worker.launch('retry'),false);d.close();
});
test('新来源适配、重庆JS附件链接、分页与跨域限制',()=>{
 assert.throws(()=>canonicalUrl('http://127.0.0.1/'));assert.throws(()=>canonicalUrl('https://scjgj.cq.gov.cn:3000/'));
 const a=extractArticle(`<meta name="ArticleTitle" content="抽检通告"><meta name="PubDate" content="2026-11-04 12:00"><div class="zwxl-article"><div class="zwxl-article-con">本次抽检发现食品不合格，详见附件中的具体产品、批次和不合格项目。</div><a onclick="downloadFj('不合格信息.xlsx','./data.xlsx')">下载</a></div>`,'https://scjgj.cq.gov.cn/a/b.html');assert.equal(a.attachments[0].url,'https://scjgj.cq.gov.cn/a/data.xlsx');
 const l=extractListing('<li><a href="./202611/t20261104_1.html">食品安全抽检通告</a><span>2026-11-04</span></li><script>createPage(3, 0, "index", "html");</script>','https://scjgj.cq.gov.cn/list/');assert.equal(l.next,'https://scjgj.cq.gov.cn/list/index_1.html');
 const c=extractListing('<div class="listconli"><a href="/news/detail/2040/1.html">食品安全通报</a><span>2026-11-04</span></div><a href="/news/2040.html?page=2"><img></a>','https://www.cfsn.cn/news/2040.html');assert.equal(c.next,'https://www.cfsn.cn/news/2040.html?page=2');
 const dated=extractArticle('<h1>2026-10-01食品风险回顾</h1><p>时间：2026-11-04 12:30</p><div id="article">这篇文章回顾了食品安全事件，实际发布时间必须取时间栏，不能取标题里的历史日期。</div>');assert.equal(dated.publishedAt,'2026-11-04T04:30:00.000Z');assert.equal(dated.datePrecise,true);
});
test('Excel附件支持xls/xlsx并保留工作表与行定位',async()=>{
 const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['食品','项目'],['草莓','农药残留']]),'不合格表');
 for(const bookType of ['xlsx','xls'] as const){const text=await attachmentText(XLSX.write(book,{type:'buffer',bookType}),'https://scjgj.cq.gov.cn/a.'+bookType);assert.match(text,/工作表 不合格表 第2行：草莓 \| 农药残留/);}
});
test('文本型PDF保留页码定位，扫描件不能凭空生成证据',async()=>{
 const text='Strawberry pesticide residue failed inspection batch ABC123.';
 const stream=`BT /F1 12 Tf 50 700 Td (${text}) Tj ET`;
 const parts=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
 let pdf='%PDF-1.4\n';const offsets=[0];parts.forEach((p,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${p}\nendobj\n`;});
 const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF`;
 const extracted=await attachmentText(Buffer.from(pdf),'https://scjgj.cq.gov.cn/a.pdf');assert.match(extracted,/第1页/);assert.match(extracted,/Strawberry pesticide/);
 await assert.rejects(()=>attachmentText(Buffer.from('invalid pdf'),'https://scjgj.cq.gov.cn/b.pdf'));
});
test('移除重置与批量重试接口，仅允许失败暂存区单篇重试',async()=>{
 const d=db();const prompt=one(d,'SELECT MAX(id) id FROM prompts')!.id;
 const saved=stageArticle(d,article(),'https://news.foodmate.net/2026/11/1.html',prompt);await analyzeStaged(d,saved.id,async()=>warning as any);
 const failed=stageArticle(d,article(body+'另一篇固定新闻的附加说明。'),'https://news.foodmate.net/2026/11/2.html',prompt);await analyzeStaged(d,failed.id,async()=>{throw new Error('固定失败');});
 run(d,"INSERT INTO users(username,password_hash,role,created_at) VALUES('developer-fixture',?,'developer',?)",hashPassword('fixture-only-password'),now());
 const worker=new Worker(d,async()=>'',async()=>warning as any);const server=createApp(d,worker).listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const base=`http://127.0.0.1:${(server.address() as any).port}/api/admin`;
 try{
  const login=await fetch(base.replace('/admin','')+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'developer-fixture',password:'fixture-only-password'})});
  const headers={Cookie:login.headers.get('set-cookie')!.split(';')[0],'Content-Type':'application/json'};
  for(const [path,method] of [['/analysis-reset/preview','GET'],['/analysis-reset','POST'],['/retry-failed','POST']]){
   const r=await fetch(base+path,{method,headers,...(method==='POST'?{body:JSON.stringify({confirmed:true})}:{})});assert.equal(r.status,404);
  }
  assert.equal(one(d,'SELECT COUNT(*) n FROM news')!.n,1);assert.equal(one(d,'SELECT COUNT(*) n FROM alerts')!.n,1);
  const items:any=await(await fetch(base+'/failures',{headers})).json();assert.equal(items.items[0].id,failed.id);
  const retry=await fetch(base+`/failures/${failed.id}/retry`,{method:'POST',headers,body:'{}'});assert.equal(retry.status,202);await worker.stop();
  assert.equal(one(d,'SELECT status FROM pipeline_items WHERE id=?',failed.id)!.status,'warning');assert.equal(one(d,'SELECT COUNT(*) n FROM news')!.n,2);assert.equal(one(d,'SELECT COUNT(*) n FROM alerts')!.n,2);
 }finally{await worker.stop();await new Promise<void>(r=>server.close(()=>r()));d.close();}
});
test('账号登录、普通用户角色越权及发布后的已读/提醒接口',async()=>{
 const d=db();run(d,"INSERT INTO users(username,password_hash,role,created_at) VALUES('fixture',?,'user',?)",hashPassword('fixture-only-password'),now());
 const item=stageArticle(d,article(),'https://news.foodmate.net/2026/11/1.html',one(d,'SELECT MAX(id) id FROM prompts')!.id);await analyzeStaged(d,item.id,async()=>warning as any);
 const app=createApp(d);const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const addr=server.address() as any;const base=`http://127.0.0.1:${addr.port}/api`;
 try{
   const login=await fetch(base+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'fixture',password:'fixture-only-password'})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!.split(';')[0];assert.match(login.headers.get('set-cookie')!,/HttpOnly/);
   const headers={Cookie:cookie,'Content-Type':'application/json'};assert.equal((await fetch(base+'/admin/news',{headers})).status,403);
   const feed:any=await (await fetch(base+'/alerts',{headers})).json();assert.equal(feed.items.length,1);assert.equal(feed.items[0].payload.risks[0].category,'chemical');
   assert.equal((await fetch(base+'/alerts/'+feed.items[0].id+'/read',{method:'POST',headers,body:'{}'})).status,200);
   const next:any=await(await fetch(base+'/alerts',{headers})).json();assert.equal(next.unread,0);
   const claim=()=>fetch(base+'/notifications/claim',{method:'POST',headers,body:'{}'}).then(r=>r.json()) as Promise<any>;
   const claims=await Promise.all([claim(),claim()]);assert.equal(claims.reduce((n,c)=>n+c.count,0),1);
 }finally{await new Promise<void>(r=>server.close(()=>r()));d.close();}
});
