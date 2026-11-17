import { one, type DB } from './db.js';

export type SourceEntry = { url: string; name: string };

export const SOURCE_DEFINITIONS = [
  { url: 'https://news.foodmate.net/', name: '食品伙伴网·食品资讯', adapter: 'foodmate' },
  { url: 'https://fsc.foodmate.net/', name: '食品伙伴网·食品安全', adapter: 'foodmate' },
  { url: 'https://www.cfsn.cn/news/2037.html', name: '中国食品安全网·食安特报', adapter: 'cfsn' },
  { url: 'http://www.chinacondiment.com/', name: '中国调味品协会', adapter: 'condiment' },
  { url: 'https://scjgj.cq.gov.cn/zt_225/spaqzb/', name: '重庆市市场监督管理局·食品安全', adapter: 'cq' },
  { url: 'https://scjgj.cq.gov.cn/zz/qjq/zwgk/fdzdgknr_146781/jdjc_146793/spyp/jcjg/', name: '綦江区市场监督管理局·抽检结果', adapter: 'cq' },
  { url: 'https://scjgj.cq.gov.cn/zz/tnq/zwgk/fdzdgknr_146781/jdjc_146793/spyp/jcjg/', name: '潼南区市场监督管理局·抽检结果', adapter: 'cq' },
] as const;
export function sourceDefinition(url: string) {
  const exact = SOURCE_DEFINITIONS.filter(s => url.startsWith(s.url)).sort((a,b)=>b.url.length-a.url.length)[0];
  if (exact) return exact;
  const host = new URL(url).hostname.replace(/^www\./, '');
  if (host === 'scjgj.cq.gov.cn') return { url, name: '重庆市市场监督管理局', adapter: 'cq' };
  if (host === 'cfsn.cn') return { url, name: '中国食品安全网', adapter: 'cfsn' };
  if (host === 'chinacondiment.com') return { url, name: '中国调味品协会', adapter: 'condiment' };
  return { url, name: '食品伙伴网', adapter: 'foodmate' };
}
export function sourceName(url: string) { return sourceDefinition(url).name; }

export function sourceCatalog(db: DB): SourceEntry[] {
  const crawler = JSON.parse(one(db, "SELECT value FROM settings WHERE key='crawler'")!.value);
  return crawler.catalog ?? [...new Set<string>([
    ...SOURCE_DEFINITIONS.map((source) => source.url),
    ...crawler.sources,
  ])].map((url) => ({ url, name: sourceName(url) }));
}
