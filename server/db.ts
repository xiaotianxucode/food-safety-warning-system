import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export type Row = Record<string, any>;
export const now = () => new Date().toISOString();
export function openDatabase(path = process.env.DATABASE_PATH || './data/food-safety.sqlite') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','developer')), active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS prompts(id INTEGER PRIMARY KEY,content TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,error TEXT,summary TEXT);
    CREATE TABLE IF NOT EXISTS news(id INTEGER PRIMARY KEY,title TEXT NOT NULL,published_at TEXT,body TEXT NOT NULL DEFAULT '',fingerprint TEXT UNIQUE,status TEXT NOT NULL DEFAULT 'pending',error TEXT,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sources(id INTEGER PRIMARY KEY,news_id INTEGER NOT NULL REFERENCES news(id),url TEXT UNIQUE NOT NULL,title TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS analyses(id INTEGER PRIMARY KEY,news_id INTEGER NOT NULL REFERENCES news(id),status TEXT NOT NULL,model TEXT NOT NULL,prompt_id INTEGER REFERENCES prompts(id),result TEXT,error TEXT,attempts INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,finished_at TEXT);
    CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY AUTOINCREMENT,news_id INTEGER NOT NULL REFERENCES news(id),analysis_id INTEGER NOT NULL REFERENCES analyses(id),object_key TEXT NOT NULL,payload TEXT NOT NULL,published_at TEXT NOT NULL,withdrawn INTEGER NOT NULL DEFAULT 0,UNIQUE(news_id,object_key));
    CREATE TABLE IF NOT EXISTS reads(user_id INTEGER NOT NULL REFERENCES users(id),alert_id INTEGER NOT NULL REFERENCES alerts(id),read_at TEXT NOT NULL,PRIMARY KEY(user_id,alert_id));
    CREATE TABLE IF NOT EXISTS notifications(user_id INTEGER PRIMARY KEY REFERENCES users(id),cursor INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS locks(name TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reanalysis_queue(job_id INTEGER NOT NULL REFERENCES jobs(id),news_id INTEGER NOT NULL REFERENCES news(id),status TEXT NOT NULL DEFAULT 'pending',error TEXT,PRIMARY KEY(job_id,news_id));
    INSERT OR IGNORE INTO migrations VALUES(1,datetime('now'));`);
  return db;
}
export type DB = ReturnType<typeof openDatabase>;
export function one(db: DB, sql: string, ...args: any[]): Row | undefined {
  return db.prepare(sql).get(...args) as Row | undefined;
}
export function all(db: DB, sql: string, ...args: any[]): Row[] {
  return db.prepare(sql).all(...args) as Row[];
}
export function run(db: DB, sql: string, ...args: any[]) {
  return db.prepare(sql).run(...args);
}
export function transaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
