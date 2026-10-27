import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';
import { createHash } from 'node:crypto';
export const DEFAULT_SOURCES = ['https://news.foodmate.net/', 'https://fsc.foodmate.net/'];
export function canonicalUrl(raw: string, base?: string) {
  const u = new URL(raw, base);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('不支持的链接协议');
  if (u.hostname !== 'foodmate.net' && !u.hostname.endsWith('.foodmate.net'))
    throw new Error('只允许食品伙伴网来源');
  u.hash = '';
  for (const key of [...u.searchParams.keys()])
    if (/^utm_|^(from|spm)$/i.test(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  return u.href;
}
export const fingerprint = (body: string) =>
  createHash('sha256').update(body.replace(/\s+/g, '')).digest('hex');
export async function fetchHtml(url: string) {
  let current = canonicalUrl(url);
  for (let redirects = 0; redirects < 4; redirects++) {
    const response = await fetch(current, {
      headers: {
        'User-Agent': 'FoodSafetyMonitor/1.0 (+local food-safety research)',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(25000),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      current = canonicalUrl(response.headers.get('location') || '', current);
      continue;
    }
    if (!response.ok) throw new Error(`采集 HTTP ${response.status}：${current}`);
    if (Number(response.headers.get('content-length') || 0) > 5_000_000)
      throw new Error('网页超过大小限制');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('响应正文为空');
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 5_000_000) {
        await reader.cancel();
        throw new Error('网页超过大小限制');
      }
      chunks.push(value);
    }
    const buffer = Buffer.concat(chunks);
    const header = buffer.subarray(0, 4096).toString('ascii');
    const charset =
      response.headers.get('content-type')?.match(/charset=([^;\s]+)/i)?.[1] ||
      header.match(/charset=["']?([\w-]+)/i)?.[1] ||
      'utf-8';
    return iconv.decode(buffer, charset);
  }
  throw new Error('网页重定向次数过多');
}
export function extractLinks(html: string, base: string) {
  const $ = cheerio.load(html);
  const links = new Set<string>();
  $('a[href]').each((_, a) => {
    try {
      const u = canonicalUrl($(a).attr('href')!, base);
      if (/\/\d{4}\/\d{2}\/\d+\.html|show\.php\?itemid=\d+/.test(u)) links.add(u);
    } catch {}
  });
  return [...links];
}
export function extractArticle(html: string) {
  const $ = cheerio.load(html);
  $('script,style,iframe,noscript').remove();
  const title = $('h1').first().text().trim();
  const content = $('#article,#content,.article-content,.content,.article')
    .filter((_, el) => $(el).text().trim().length >= 20)
    .first();
  content.find('tr').each((_, row) => {
    $(row).find('td,th').append(' | ');
    $(row).append('\n');
  });
  content.find('p,br').append('\n');
  const body = content
    .text()
    .replace(/[ \t\r]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
  const pageText = $('body').text();
  const raw = pageText.match(
    /(?:时间|发布时间|日期)\s*[：:]?\s*(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?/,
  );
  const publishedAt = raw
    ? new Date(`${raw[1]}T${raw[2] || '00:00'}:00+08:00`).toISOString()
    : null;
  if (!title || body.length < 30) throw new Error('无法提取新闻标题或正文，需检查来源页面结构');
  return { title, body, publishedAt };
}

export function extractListing(html: string, base: string) {
  const $ = cheerio.load(html);
  const rows = $('li.catlist_li');
  const entries: { url: string; publishedAt: string | null; precise: boolean }[] = [];
  const read = (a: any, rowText: string) => {
    try {
      const url = canonicalUrl($(a).attr('href')!, base);
      if (!/\/\d{4}\/\d{2}\/\d+\.html|show\.php\?itemid=\d+/.test(url)) return;
      const match = rowText.match(/(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?/);
      entries.push({
        url,
        publishedAt: match
          ? new Date(`${match[1]}T${match[2] || '00:00'}:00+08:00`).toISOString()
          : null,
        precise: !!match?.[2],
      });
    } catch {}
  };
  if (rows.length)
    rows.each((_, row) => {
      $(row)
        .find('a[href]')
        .each((_, a) => read(a, $(row).find('span').first().text()));
    });
  else $('a[href]').each((_, a) => read(a, $(a).closest('li').find('span').first().text()));
  let next: string | undefined;
  $('a[href]').each((_, a) => {
    if (!next && /^下一页\s*[»›>]*$/i.test($(a).text().trim()))
      try {
        next = canonicalUrl($(a).attr('href')!, base);
      } catch {}
  });
  const seeds: string[] = [];
  const u = new URL(base);
  if (u.hostname === 'news.foodmate.net' && u.pathname === '/')
    for (const path of ['guonei', 'guoji', 'yujing'])
      if ($(`a[href*="/${path}/"]`).length) seeds.push(`https://news.foodmate.net/${path}/`);
  if (u.hostname === 'fsc.foodmate.net' && u.pathname === '/' && $('a[href*="list.php"]').length)
    seeds.push('https://fsc.foodmate.net/list.php');
  return { entries, next, seeds, ordered: rows.length > 0 };
}
