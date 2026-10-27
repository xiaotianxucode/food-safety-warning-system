import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { openDatabase, one, run, now } from './db.js';
import { initialize } from './service.js';
import { hashPassword } from './auth.js';
const db = openDatabase();
initialize(db);
if (!one(db, "SELECT id FROM users WHERE role='developer'")) {
  const password = randomBytes(18).toString('base64url');
  run(
    db,
    'INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)',
    'admin',
    hashPassword(password),
    'developer',
    now(),
  );
  writeFileSync(
    'CREDENTIALS.local.txt',
    `本机食品安全预警系统\n地址：http://127.0.0.1:3000\n开发者账号：admin\n初始密码：${password}\n\n该密码随机生成，仅保存在本机，已排除在 Git 之外。登录后可修改密码，并在后台创建普通用户。\n`,
    'utf8',
  );
  console.log('已初始化本机开发者账号，访问方式见 CREDENTIALS.local.txt（未输出密码）。');
} else console.log('开发者账号已存在，不覆盖现有账号。');
db.close();
