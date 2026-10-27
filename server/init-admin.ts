import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Writable } from 'node:stream';
import { openDatabase, one, run, now } from './db.js';
import { initialize } from './service.js';
import { hashPassword } from './auth.js';
const db = openDatabase();
initialize(db);
let muted = false;
const terminalOutput = new Writable({
  write(chunk, _encoding, callback) {
    if (!muted) output.write(chunk);
    callback();
  },
});
const rl = createInterface({ input, output: terminalOutput, terminal: !!input.isTTY });
try {
  const username = (
    process.env.INIT_ADMIN_USERNAME ||
    (await rl.question('开发者用户名（2–32 个中文、字母、数字或下划线）：'))
  ).trim();
  let password = process.env.INIT_ADMIN_PASSWORD;
  if (!password) {
    output.write('开发者密码（至少 10 位，输入不回显）：');
    muted = true;
    password = await rl.question('');
    muted = false;
    output.write('\n');
  }
  if (!/^[\p{L}\p{N}_-]{2,32}$/u.test(username) || password.length < 10 || password.length > 128)
    throw new Error('用户名或密码不符合要求');
  if (one(db, 'SELECT id FROM users WHERE username=?', username))
    throw new Error('账号已存在，请在后台管理，不覆盖密码');
  run(
    db,
    'INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)',
    username,
    hashPassword(password),
    'developer',
    now(),
  );
  console.log('开发者账号创建成功。');
} catch (e) {
  console.error(e instanceof Error ? e.message : '初始化失败');
  process.exitCode = 1;
} finally {
  rl.close();
  db.close();
}
