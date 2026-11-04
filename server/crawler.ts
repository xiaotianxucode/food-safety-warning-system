import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';
import { createHash } from 'node:crypto';
import { SOURCE_DEFINITIONS, sourceDefinition } from './source-registry.js';
export const DEFAULT_SOURCES = SOURCE_DEFINITIONS.map(s => s.url);
export function canonicalUrl(raw: string, base?: string) {
  const u = new URL(raw, base);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('不支持的链接协议');
  if (!(u.hostname === 'foodmate.net' || u.hostname.endsWith('.foodmate.net') ||
    ['cfsn.cn','www.cfsn.cn','chinacondiment.com','www.chinacondiment.com','scjgj.cq.gov.cn'].includes(u.hostname)))
    throw new Error('只允许已支持的食品新闻与重庆市场监管来源');
  if (u.username || u.password || (u.port && !['80','443'].includes(u.port))) throw new Error('不允许自定义端口或网址凭据');
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
export function extractArticle(html: string, url = 'https://news.foodmate.net/') {
  const $ = cheerio.load(html);
  $('script,style,iframe,noscript').remove();
  const title = $('meta[name="ArticleTitle"]').attr('content') || $('h1,.zwxl-title').first().text().trim();
  const adapter=sourceDefinition(url).adapter;
  const selector=adapter==='cq'?'.zwxl-article-con,.TRS_Editor':adapter==='condiment'?'.article-content':adapter==='cfsn'?'.content':'#article,#content,.article-content,.content,.article';
  const content = $(selector)
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
  const info=$('h1').parent().clone();info.find('h1').remove();
  const pageText = adapter==='condiment'?$('.article-meta').text():adapter==='cfsn'?info.text():$('body').text();
  const metaDate = $('meta[name="PubDate"],meta[name="publishdate"],meta[property="article:published_time"],meta[name="publishDate"]').first().attr('content');
  const datePattern=/(\d{4})[-年/.](\d{1,2})[-月/.](\d{1,2})日?(?:[T\s]+(\d{2}:\d{2})(?::(\d{2}))?)?/;
  const labelled=pageText.match(/(?:发布时间|时间|日期)\s*[：:]?\s*(\d{4}[-年/.]\d{1,2}[-月/.]\d{1,2}日?(?:[T\s]+\d{2}:\d{2}(?::\d{2})?)?)/);
  const raw = (metaDate || labelled?.[1] || (adapter==='foodmate'?'':pageText)).match(datePattern);
  const publishedAt = raw
    ? new Date(`${raw[1]}-${raw[2].padStart(2,'0')}-${raw[3].padStart(2,'0')}T${raw[4] || '00:00'}:${raw[5] || '00'}+08:00`).toISOString()
    : null;
  if (!title || body.length < 30) throw new Error('无法提取新闻标题或正文，需检查来源页面结构');
  const attachments: {url: string; title: string}[] = [];
  const attachmentScope=adapter==='cq'?$('.zwxl-content'):content;
  attachmentScope.find('a[href],a[onclick]').add(adapter==='cq'?'a[onclick*="downloadFj"]':[]).each((_, a) => {
    const call=$(a).attr('onclick')?.match(/downloadFj\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
    const href = call?.[2] || $(a).attr('href') || '';
    if (/\.(?:xlsx?|pdf)(?:\?|$)/i.test(href)) {
      try { const link=canonicalUrl(href,url);if(!attachments.some(a=>a.url===link))attachments.push({url:link, title: call?.[1] || $(a).text().trim() || '抽检附件'}); }
      catch { throw new Error('公告附件链接不在受支持来源范围内，需核查'); }
    }
  });
  return { title, body, publishedAt, attachments, datePrecise: !!raw?.[4] };
}

export function extractListing(html: string, base: string) {
  const adapter = sourceDefinition(base).adapter;
  if (adapter !== 'foodmate') return extractOtherListing(html,base,adapter);
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

function extractOtherListing(html: string, base: string, adapter: string) {
  const $ = cheerio.load(html);
  const entries: {url:string;publishedAt:string|null;precise:boolean}[] = [];
  const seeds: string[] = [];
  let next: string | undefined;
  $('a[href]').each((_, a) => {
    let url: string;
    try { url = canonicalUrl($(a).attr('href')!,base); } catch { return; }
    const text = $(a).text().trim();
    if (/^(下一页|下页|Next)\s*[»›>]*$/i.test(text)) { next ||= url; return; }
    const isArticle = adapter === 'cq' ? /\/t\d{8}_\d+\.html/.test(url)
      : adapter === 'cfsn' ? /\/news\/detail\/(?:2038|2039|2040|2041)\//.test(url)
      : /\/(?:news|article|detail|content|info)[^/]*\/|(?:id|articleid)=\d+/i.test(url);
    if (isArticle && text.length >= 4 && !/下一页/.test(text)) {
      const row = $(a).closest('li,tr,.item,.news-item,.list-item,.listconli');
      const raw = row.text().match(/(\d{4})[-年/.](\d{1,2})[-月/.](\d{1,2})日?(?:\s+(\d{2}:\d{2}))?/);
      const publishedAt = raw ? new Date(`${raw[1]}-${raw[2].padStart(2,'0')}-${raw[3].padStart(2,'0')}T${raw[4] || '00:00'}:00+08:00`).toISOString() : null;
      if (!entries.some(e=>e.url===url)) entries.push({url,publishedAt,precise:!!raw?.[4]});
    }
    if (adapter === 'cq' && /食品.*(?:抽检|监督抽查)|抽检.*(?:信息|通告)/.test(text) && !isArticle && new URL(url).pathname.endsWith('/')) seeds.push(url);
    if (adapter === 'condiment' && /新闻|行业动态|食品安全|协会动态/.test(text) && !isArticle && url !== base) seeds.push(url);
    if (adapter === 'cfsn' && /\/news\/(?:2038|2039|2040|2041)\.html$/.test(url) && url!==base) seeds.push(url);
  });
  const baseUrl=new URL(base);
  if(adapter==='cq'&&baseUrl.pathname==='/zt_225/spaqzb/')seeds.push('https://scjgj.cq.gov.cn/zfxxgk_225/fdzdgknr/jdcj/spaq_1/jcjgxx/');
  if(adapter==='cfsn'&&!next) {
    const current=Number(baseUrl.searchParams.get('page')||1);
    $('a[href]').each((_,a)=>{try{const u=new URL($(a).attr('href')!,base);if(u.pathname===baseUrl.pathname&&Number(u.searchParams.get('page'))===current+1)next=canonicalUrl(u.href);}catch{}});
  }
  if (adapter === 'cq' && !next) {
    const page = new URL(base).pathname.match(/index(?:_(\d+))?\.html$/);
    const count = html.match(/createPage(?:HTML)?\s*\(\s*(\d+)\s*,\s*(\d+)/);
    if (count && Number(count[2])+1<Number(count[1])) next = new URL(`index_${Number(count[2])+1}.html`,base).href;
    else if (!page && /index_1\.html/.test(html)) next = new URL('index_1.html',base).href;
  }
  const inList=adapter==='condiment'?$('.news-ul-list a[href]'):adapter==='cfsn'?$('.listconli a[href]'):null;
  const allowed=inList?.length?new Set(inList.toArray().map(a=>{try{return canonicalUrl($(a).attr('href')!,base);}catch{return '';}})):null;
  const filtered=allowed?entries.filter(e=>allowed.has(e.url)):entries;
  return {entries:filtered,next,seeds:[...new Set(seeds)],ordered:adapter==='cq'||!!allowed};
}
