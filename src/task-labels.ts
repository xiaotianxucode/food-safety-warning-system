const kinds:Record<string,string>={manual:'手动采集',scheduled:'自动采集',model_retry:'暂存区单篇重试',maintenance:'维护补采（历史）',configuration:'配置触发（历史）'};
export function taskTitle(job:{kind:string;summary?:string}) {
  const s=JSON.parse(job.summary||'{}');
  return job.kind==='scheduled'&&s.trigger==='initial'?'首次采集':kinds[job.kind]||job.kind;
}
export function taskPhase(job:{status:string;summary?:string}) {
  const phase=JSON.parse(job.summary||'{}').phase;
  if(job.status!=='running'||phase==='finished')return null;
  return ({streaming:'逐篇采集与分析',scanning:'扫描栏目',collecting:'读取正文',analyzing:'模型分析'} as Record<string,string>)[phase]||null;
}
