import { openDatabase, run, now } from '../../server/db.js';
import { createApp } from '../../server/app.js';
import { initialize, ingest, analyzeNews, Worker } from '../../server/service.js';
import { hashPassword } from '../../server/auth.js';
const db = openDatabase(':memory:');
initialize(db);
for (const [username, role] of [
  ['e2eadmin', 'developer'],
  ['e2euser', 'user'],
])
  run(
    db,
    'INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)',
    username,
    hashPassword('e2e-password-only'),
    role,
    now(),
  );
const evidence = '测试样例：日本草莓检出残留农药不合格，涉事批次退运。';
const { id } = ingest(
  db,
  { title: '测试样例 · 边境抽检信息', body: evidence, publishedAt: now() },
  'https://news.foodmate.net/2026/10/999999.html',
);
await analyzeNews(db, id, async () => ({
  shouldWarn: true,
  summary: '【测试样例】边境抽检发现一批日本草莓不合格。',
  alerts: [
    {
      food: '草莓',
      region: '日本',
      company: '',
      batch: '',
      factor: '【测试样例】检出残留农药',
      impact: '涉事批次退运',
      advice: '关注涉事批次',
      evidence,
      seasoning: false,
    },
  ],
}));
const worker = new Worker(
  db,
  async () => '<html></html>',
  async () => ({ shouldWarn: false, summary: '重置验收测试：样例不发布为真实预警。', alerts: [] }),
);
createApp(db, worker).listen(3101, '127.0.0.1');
