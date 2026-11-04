import {one,type DB} from './db.js';
export function failureCounts(db:DB) {
  const articles=one(db,"SELECT COUNT(*) AS count FROM task_items i WHERE i.result IN ('read_failed','date_unknown') AND NOT EXISTS(SELECT 1 FROM task_items newer WHERE newer.url=i.url AND newer.id>i.id AND newer.result<>'pending')")!.count;
  const pages=one(db,"SELECT COUNT(*) AS count FROM task_pages p WHERE p.status='failed' AND NOT EXISTS(SELECT 1 FROM task_pages newer WHERE newer.url=p.url AND newer.job_id>p.job_id AND newer.status<>'pending')")!.count;
  const analysis=one(db,"SELECT COUNT(*) AS count FROM pipeline_items WHERE status='failed'")!.count;
  return {collection:articles+pages,analysis};
}
