import { all, one, run, transaction, now, type DB } from './db.js';
import { canonicalUrl, fingerprint, fetchHtml, type extractArticle } from './crawler.js';
import { callModel, modelName, validateAnalysis } from './model.js';
import { sourceName } from './source-registry.js';
export type Article = ReturnType<typeof extractArticle>;
export const pause = (ms:number) => new Promise(r=>setTimeout(r,ms));

export function pipelineSchema(db: DB) {
  db.exec(`CREATE TABLE IF NOT EXISTS pipeline_items(
    id INTEGER PRIMARY KEY, fingerprint TEXT UNIQUE, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
    published_at TEXT, status TEXT NOT NULL DEFAULT 'pending', prompt_id INTEGER REFERENCES prompts(id),
    model TEXT, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, news_id INTEGER REFERENCES news(id),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pipeline_urls(url TEXT PRIMARY KEY,item_id INTEGER NOT NULL REFERENCES pipeline_items(id),
    title TEXT NOT NULL,source_name TEXT NOT NULL,published_at TEXT);
    CREATE TABLE IF NOT EXISTS source_states(url TEXT PRIMARY KEY,last_end TEXT,next_run_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS job_sources(job_id INTEGER NOT NULL REFERENCES jobs(id),url TEXT NOT NULL,name TEXT NOT NULL,
    window_start TEXT NOT NULL,window_end TEXT NOT NULL,start_inclusive INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',error TEXT,
    PRIMARY KEY(job_id,url));
    CREATE INDEX IF NOT EXISTS pipeline_status ON pipeline_items(status);`);
  const add = (table:string,column:string,definition:string) => {
    if (!all(db,`PRAGMA table_info(${table})`).some(c=>c.name===column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  add('task_items','staging_id','INTEGER');
  add('task_items','source_name',"TEXT NOT NULL DEFAULT ''");
  add('task_items','title',"TEXT NOT NULL DEFAULT ''");
  add('task_pages','source_url',"TEXT NOT NULL DEFAULT ''");
  add('news','categories',"TEXT NOT NULL DEFAULT '[]'");
  add('sources','source_name',"TEXT NOT NULL DEFAULT ''");
  add('source_states','initial_start','TEXT');
  add('source_states','last_attempt_end','TEXT');
  add('job_sources','mode',"TEXT NOT NULL DEFAULT 'initial'");
  add('job_sources','started_at','TEXT');
  add('job_sources','finished_at','TEXT');
  add('pipeline_items','attachments',"TEXT NOT NULL DEFAULT '[]'");
}

export function stageArticle(db:DB, article:Article, url:string, promptId:number,withinTransaction=false, name=sourceName(url)) {
  url = canonicalUrl(url);
  const write=()=>{
    const hash = fingerprint(article.body);
    const existing = one(db,'SELECT * FROM pipeline_items WHERE fingerprint=?',hash);
    const id = existing?.id || Number(run(db,
      `INSERT INTO pipeline_items(fingerprint,title,body,published_at,prompt_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`,
      hash,article.title,article.body,article.publishedAt,promptId,now(),now()).lastInsertRowid);
    if(!existing)run(db,'UPDATE pipeline_items SET attachments=? WHERE id=?',JSON.stringify(article.attachments),id);
    run(db,'INSERT INTO pipeline_urls(url,item_id,title,source_name,published_at) VALUES(?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET item_id=excluded.item_id,title=excluded.title,source_name=excluded.source_name,published_at=excluded.published_at',
      url,id,article.title,name,article.publishedAt);
    if (existing?.news_id) run(db,'INSERT OR IGNORE INTO sources(news_id,url,title,source_name) VALUES(?,?,?,?)',existing.news_id,url,article.title,name);
    return {id,inserted:!existing};
  };
  return withinTransaction?write():transaction(db,write);
}

export function removeNews(db:DB,id:number) {
  run(db,'DELETE FROM reads WHERE alert_id IN (SELECT id FROM alerts WHERE news_id=?)',id);
  run(db,'DELETE FROM alerts WHERE news_id=?',id);
  run(db,'UPDATE task_items SET news_id=NULL,analysis_id=NULL WHERE news_id=?',id);
  run(db,'DELETE FROM reanalysis_queue WHERE news_id=?',id);
  run(db,'UPDATE pipeline_items SET news_id=NULL WHERE news_id=?',id);
  run(db,'DELETE FROM analyses WHERE news_id=?',id);
  run(db,'DELETE FROM sources WHERE news_id=?',id);
  run(db,'DELETE FROM news WHERE id=?',id);
}

export async function analyzeStaged(db:DB,id:number,analyzer=callModel) {
  const item = one(db,'SELECT * FROM pipeline_items WHERE id=?',id)!;
  if (!item || !item.body) throw new Error('暂存正文缺失，不能分析');
  const prompt = one(db,'SELECT * FROM prompts WHERE id=?',item.prompt_id)!;
  run(db,"UPDATE pipeline_items SET status='running',error=NULL,model=?,updated_at=? WHERE id=?",modelName(),now(),id);
  let error='';
    run(db,'UPDATE pipeline_items SET attempts=attempts+1 WHERE id=?',id);
    try {
      const result = validateAnalysis(await analyzer(prompt.content,item.body),item.body);
      return transaction(db,()=>{
        if (!result.shouldWarn) {
          if (item.news_id) removeNews(db,item.news_id);
          run(db,"UPDATE pipeline_items SET status='no_warning',body='',title='',news_id=NULL,error=NULL,updated_at=? WHERE id=?",now(),id);
          return {status:'no_warning',newsId:null,analysisId:null};
        }
        const categories=[...new Set(result.alerts.flatMap(a=>a.risks.map(r=>r.category)))];
        let newsId=item.news_id;
        if (!newsId) newsId=Number(run(db,"INSERT INTO news(title,body,published_at,fingerprint,status,created_at,categories) VALUES(?,?,?,?,'published',?,?)",
          item.title,item.body,item.published_at,item.fingerprint,now(),JSON.stringify(categories)).lastInsertRowid);
        else run(db,"UPDATE news SET status='published',categories=?,error=NULL WHERE id=?",JSON.stringify(categories),newsId);
        const analysisId=Number(run(db,"INSERT INTO analyses(news_id,status,model,prompt_id,result,attempts,created_at,finished_at) VALUES(?,'completed',?,?,?,?,?,?)",
          newsId,modelName(),item.prompt_id,JSON.stringify(result),one(db,'SELECT attempts FROM pipeline_items WHERE id=?',id)!.attempts,now(),now()).lastInsertRowid);
        for (const source of all(db,'SELECT * FROM pipeline_urls WHERE item_id=?',id))
          run(db,'INSERT OR IGNORE INTO sources(news_id,url,title,source_name) VALUES(?,?,?,?)',newsId,source.url,source.title,source.source_name);
        for(const a of JSON.parse(item.attachments || '[]'))run(db,'INSERT OR IGNORE INTO sources(news_id,url,title,source_name) VALUES(?,?,?,?)',newsId,a.url,`原文附件：${a.title}`,sourceName(a.url));
        for (const alert of result.alerts) {
          const key=fingerprint(JSON.stringify([alert.food,alert.region,alert.company,alert.batch,alert.factor]));
          run(db,'INSERT OR IGNORE INTO alerts(news_id,analysis_id,object_key,payload,published_at) VALUES(?,?,?,?,?)',newsId,analysisId,key,JSON.stringify({...alert,summary:result.summary}),now());
        }
        run(db,"UPDATE pipeline_items SET status='warning',news_id=?,body='',error=NULL,updated_at=? WHERE id=?",newsId,now(),id);
        return {status:'warning',newsId,analysisId};
      });
    } catch(e) { error=e instanceof Error?e.message:'模型分析失败'; }
  run(db,"UPDATE pipeline_items SET status='failed',error=?,updated_at=? WHERE id=?",error,now(),id);
  return {status:'failed',newsId:item.news_id || null,analysisId:null};
}

export async function fetchBinary(url:string,limit=15_000_000) {
  let current=canonicalUrl(url);
  for(let i=0;i<4;i++) {
    const res=await fetch(current,{redirect:'manual',signal:AbortSignal.timeout(30000),headers:{'User-Agent':'FoodSafetyMonitor/2.0'}});
    if(res.status>=300&&res.status<400) {current=canonicalUrl(res.headers.get('location')||'',current);continue;}
    if(!res.ok) throw new Error(`附件 HTTP ${res.status}`);
    const reader=res.body!.getReader();const chunks:Uint8Array[]=[];let size=0;
    while(true) {const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>limit){await reader.cancel();throw new Error('附件超过15MB限制');}chunks.push(r.value);}
    return Buffer.concat(chunks);
  }
  throw new Error('附件重定向次数过多');
}
export async function attachmentText(buffer:Buffer,url:string) {
  if(/\.pdf(?:\?|$)/i.test(url)) {
    const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task=getDocument({data:new Uint8Array(buffer),useSystemFonts:true,isEvalSupported:false});
    const pdf=await task.promise;
    try {
      const lines:string[]=[];
      for(let p=1;p<=pdf.numPages;p++) {
        const content=await (await pdf.getPage(p)).getTextContent();
        let line=''; let row=1;
        for(const it of content.items) if('str' in it) {line+=it.str+' | ';if(it.hasEOL){lines.push(`第${p}页 第${row++}行：${line}`);line='';}}
        if(line.trim())lines.push(`第${p}页 第${row}行：${line}`);
      }
      const text=lines.join('\n');if(text.replace(/第\d+页 第\d+行：|[\s|]/g,'').length<20)throw new Error('PDF无可用文本，需人工核查扫描件');return text;
    } finally { await task.destroy(); }
  }
  const XLSX=await import('xlsx');
  const book=XLSX.read(buffer,{type:'buffer'});
  const lines:string[]=[];
  for(const name of book.SheetNames) {
    const rows=XLSX.utils.sheet_to_json<any[]>(book.Sheets[name],{header:1,defval:'',raw:false});
    rows.forEach((row,i)=>{if(row.some(c=>String(c).trim()))lines.push(`工作表 ${name} 第${i+1}行：${row.join(' | ')}`);});
  }
  if(!lines.length)throw new Error('Excel附件无可用数据');return lines.join('\n');
}
export async function enrichArticle(article:Article) {
  let body=article.body;
  for(const a of article.attachments) {
    const text=await attachmentText(await fetchBinary(a.url),a.url);
    // Explicitly labelled compliant inventories do not contain failed products. Keep their provenance;
    // avoid drowning a small non-compliant table in thousands of unrelated compliant rows.
    const compliant=/合格/.test(a.title)&&!/不合格/.test(a.title);
    body+=`\n\n【原文附件：${a.title}；来源：${a.url}】\n${compliant?`该附件明确标为合格信息，已成功解析${text.split('\n').length}行；不从合格名单提取预警对象。`:text}`;
  }
  if(body.length>250000)throw new Error('正文及附件过长，需核查后分批分析');
  return {...article,body};
}
