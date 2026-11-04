import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase,all,one,run,now } from '../server/db.js';
import {initialize,Worker,setSetting} from '../server/service.js';
import {createTask,executeTask,taskProgress,DAY} from '../server/collection.js';
import {stageArticle,analyzeStaged,attachmentText} from '../server/pipeline.js';
import {validateAnalysis} from '../server/model.js';
import {extractListing,extractArticle,canonicalUrl} from '../server/crawler.js';
import {createApp} from '../server/app.js';
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
function db(){const d=openDatabase(':memory:');initialize(d);setSetting(d,'crawler',{intervalHours:24,sources:[ROOT]});return d;}
const execute=(d:any,id:number,fetcher:any,analyzer:any)=>executeTask(d,id,{fetcher,analyzer,enrich:async a=>a,pause:async()=>{}});

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
test('失败源补采不会提前重跑尚未到期的成功源',async()=>{
 const d=db();const other='https://www.cfsn.cn/news/2037.html';setSetting(d,'crawler',{intervalHours:24,sources:[ROOT,other]});
 const id=createTask(d,'scheduled',undefined,END);await execute(d,id,async(url:string)=>{if(url===other)throw new Error('offline');return '暂无新闻';},async()=>noWarning);
 const later=new Date(Date.parse(END)+600000).toISOString();const next=createTask(d,'scheduled',undefined,later);
 assert.deepEqual(all(d,'SELECT url FROM job_sources WHERE job_id=?',next).map(s=>s.url),[other]);d.close();
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
 await analyzeStaged(d,id,async()=>{throw new Error('timeout');});assert.equal(one(d,'SELECT COUNT(*) n FROM news')!.n,0);assert.equal(one(d,'SELECT attempts FROM pipeline_items WHERE id=?',id)!.attempts,3);
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
test('重启恢复已抓取暂存文章，无需重新获取正文',async()=>{
 const d=db();const job=createTask(d,'manual',undefined,END);const p=one(d,'SELECT MAX(id) id FROM prompts')!.id;
 const item=stageArticle(d,article(),'https://news.foodmate.net/2026/11/1.html',p);run(d,"INSERT INTO task_items(job_id,url,staging_id,result,model_status,source_name) VALUES(?,?,?,'new','running','食品伙伴网')",job,'https://news.foodmate.net/2026/11/1.html',item.id);
 run(d,"UPDATE pipeline_items SET status='running' WHERE id=?",item.id);run(d,"UPDATE task_pages SET status='completed' WHERE job_id=?",job);
 await execute(d,job,async()=>{throw new Error('不应重新读取');},async()=>warning);assert.equal(one(d,'SELECT COUNT(*) n FROM news')!.n,1);assert.equal(one(d,'SELECT status FROM jobs WHERE id=?',job)!.status,'completed');d.close();
});
test('发布事务提交后、任务日志更新前崩溃，不会重复分析或卡住',async()=>{
 const d=db();const job=createTask(d,'manual',undefined,END);const p=one(d,'SELECT MAX(id) id FROM prompts')!.id;const item=stageArticle(d,article(),'https://news.foodmate.net/2026/11/1.html',p);
 run(d,"INSERT INTO task_items(job_id,url,staging_id,result,model_status) VALUES(?,?,?,'new','running')",job,'https://news.foodmate.net/2026/11/1.html',item.id);await analyzeStaged(d,item.id,async()=>warning as any);run(d,"UPDATE task_pages SET status='completed' WHERE job_id=?",job);
 await execute(d,job,async()=>{throw new Error('不应重新获取');},async()=>{throw new Error('不应再次分析');});assert.equal(taskProgress(d,job).warningArticles,1);assert.equal(one(d,'SELECT COUNT(*) n FROM alerts')!.n,1);d.close();
});
test('重置后无预警会删除新闻与对应预警；清库迁移只执行一次',async()=>{
 const d=db();const item=stageArticle(d,article(),'https://news.foodmate.net/2026/11/1.html',one(d,'SELECT MAX(id) id FROM prompts')!.id);await analyzeStaged(d,item.id,async()=>warning as any);
 const max=one(d,'SELECT MAX(id) id FROM alerts')!.id;initialize(d);assert.equal(one(d,'SELECT COUNT(*) n FROM news')!.n,1);
 const worker=new Worker(d,async()=>'',async()=>noWarning);const result=worker.resetAnalysis();assert.ok(result);await worker.stop();assert.equal(one(d,'SELECT COUNT(*) n FROM news')!.n,0);assert.equal(one(d,'SELECT COUNT(*) n FROM alerts')!.n,0);assert.equal(one(d,'SELECT seq FROM sqlite_sequence WHERE name=\'alerts\'')!.seq,max);d.close();
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
