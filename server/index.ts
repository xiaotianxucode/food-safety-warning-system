import 'dotenv/config';
import { openDatabase } from './db.js';
import { createApp } from './app.js';
import { Worker } from './service.js';
const db = openDatabase();
const worker = new Worker(db);
const app = createApp(db, worker);
const server = app.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => {
  console.log(
    `食品安全预警系统：http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 3000}`,
  );
  if (process.env.SCHEDULER_ENABLED !== 'false') worker.start();
});
async function shutdown() {
  server.close();
  await worker.stop();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
