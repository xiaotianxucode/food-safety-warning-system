import { randomUUID } from 'node:crypto';
import { all, one, run, transaction, now, type DB } from './db.js';
import { DEFAULT_PROMPT } from './prompt.js';
import { callModel } from './model.js';
import { DEFAULT_SOURCES, fetchHtml } from './crawler.js';
import { createTask, executeTask, taskProgress, crawlState, saveCrawlState } from './collection.js';
import { pipelineSchema, pause } from './pipeline.js';
export function setSetting(db:DB,key:string,value:unknown){run(db,'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,JSON.stringify(value));}
export const config=(db:DB)=>JSON.parse(one(db,"SELECT value FROM settings WHERE key='crawler'")!.value);
export const sleep=pause;
export function initialize(db:DB){
  pipelineSchema(db);
  if(!one(db,'SELECT version FROM migrations WHERE version=5'))transaction(db,()=>{
    // One-time authorized reset. Never reset sqlite_sequence or user/session/config credentials.
    for(const table of ['reads','notifications','task_items','task_pages','job_sources','reanalysis_queue','pipeline_urls','pipeline_items','source_states','alerts','analyses','sources','news','jobs','locks'])run(db,`DELETE FROM ${table}`);
    const generation=JSON.parse(one(db,"SELECT value FROM settings WHERE key='feedGeneration'")?.value||'0');
    setSetting(db,'feedGeneration',generation+1);
    const old=one(db,"SELECT value FROM settings WHERE key='crawler'");
    const previous=old?JSON.parse(old.value).sources:[];
    setSetting(db,'crawler',{intervalHours:24,sources:[...new Set([...previous,...DEFAULT_SOURCES])]});
    saveCrawlState(db,{initialized:false,lastSuccessEnd:null,nextRunAt:now(),initialDays:3});
    run(db,'INSERT INTO prompts(content,created_at) VALUES(?,?)',DEFAULT_PROMPT,now());
    for(const version of [2,3,4,5])run(db,'INSERT OR IGNORE INTO migrations VALUES(?,?)',version,now());
  });
  if(!one(db,'SELECT version FROM migrations WHERE version=6'))transaction(db,()=>{
    for(const job of all(db,'SELECT id,summary FROM jobs')){
      const version=JSON.parse(job.summary||'{}').version;
      if(version===2||version===3)taskProgress(db,job.id);
    }
    run(db,'INSERT INTO migrations VALUES(6,?)',now());
  });
}
export class Worker {
  busy=false; jobId?:number;
  private timer?:ReturnType<typeof setInterval>;private active?:Promise<void>;private owner=randomUUID();private stopping=false;
  constructor(public db:DB,private fetcher=fetchHtml,private analyzer=callModel){}
  start(){this.stopping=false;this.timer=setInterval(()=>this.tick(),60000);this.tick();}
  async stop(){this.stopping=true;if(this.timer)clearInterval(this.timer);await this.active;}
  canAnalyze(){return this.analyzer!==callModel||!!process.env.MODEL_API_KEY;}
  hasUnfinishedTask(){return !!one(this.db,"SELECT id FROM jobs WHERE status IN ('running','interrupted') LIMIT 1");}
  tick(){if(!this.busy&&!this.stopping&&(this.hasUnfinishedTask()||Date.parse(crawlState(this.db).nextRunAt)<=Date.now()))this.launch('scheduled');}
  private acquire(){
    if(this.busy||this.stopping)return false;
    return transaction(this.db,()=>{
      if(one(this.db,"SELECT name FROM locks WHERE name='worker' AND expires_at>?",now()))return false;
      run(this.db,"INSERT INTO locks VALUES('worker',?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at",this.owner,new Date(Date.now()+180000).toISOString());return true;
    });
  }
  private release(){run(this.db,"DELETE FROM locks WHERE name='worker' AND owner=?",this.owner);}
  launch(kind='manual',retryId?:number){
    if(!['manual','scheduled','retry'].includes(kind))return false;
    if(kind==='retry'&&(this.hasUnfinishedTask()||!retryId||!one(this.db,"SELECT id FROM pipeline_items WHERE id=? AND status='failed' AND trim(body)<>''",retryId)))return false;
    if(!this.canAnalyze()||!this.acquire())return false;
    try {
      const unfinished=one(this.db,"SELECT id FROM jobs WHERE status IN ('running','interrupted') ORDER BY id LIMIT 1");
      let id=unfinished?.id;
      if(!id){
        let ids:number[]|undefined;
        if(kind==='retry'){ids=[retryId!];kind='model_retry';}
        id=createTask(this.db,kind,ids);
      }
      this.runActive(id);return true;
    }catch(e){this.release();throw e;}
  }
  private runActive(id:number){
    this.jobId=id;this.busy=true;
    const heartbeat=setInterval(()=>run(this.db,"UPDATE locks SET expires_at=? WHERE name='worker' AND owner=?",new Date(Date.now()+180000).toISOString(),this.owner),30000);
    this.active=executeTask(this.db,id,{fetcher:this.fetcher,analyzer:this.analyzer,shouldStop:()=>this.stopping,pause:()=>this.fetcher===fetchHtml?pause(800):Promise.resolve(),enrich:this.fetcher===fetchHtml?undefined:async(a)=>a})
      .catch(e=>{run(this.db,"UPDATE jobs SET status='interrupted',error=? WHERE id=?",e instanceof Error?e.message:'任务中断',id);})
      .finally(()=>{clearInterval(heartbeat);this.release();this.busy=false;});
  }
}
