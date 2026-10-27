import 'dotenv/config';
import { fetchHtml, extractArticle, extractLinks } from './crawler.js';
import { callModel } from './model.js';
import { DEFAULT_PROMPT } from './prompt.js';
const urls = [
  'https://news.foodmate.net/',
  'https://fsc.foodmate.net/',
  'https://fsc.foodmate.net/show.php?itemid=735478',
];
let article: ReturnType<typeof extractArticle> | undefined;
for (const url of urls) {
  try {
    const html = await fetchHtml(url);
    console.log(
      JSON.stringify({ kind: 'crawler', url, ok: true, links: extractLinks(html, url).length }),
    );
    if (url.includes('show.php')) {
      article = extractArticle(html);
      console.log(
        JSON.stringify({
          kind: 'article',
          title: article.title,
          bodyLength: article.body.length,
          publishedAt: article.publishedAt,
        }),
      );
    }
  } catch (e) {
    console.log(
      JSON.stringify({
        kind: 'crawler',
        url,
        ok: false,
        error: e instanceof Error ? e.message : '采集失败',
      }),
    );
  }
}
try {
  const body =
    article?.body ||
    '【联调测试样例，非真实新闻】台湾食药署通报，日本草莓检出残留农药不合格，涉事批次退运。';
  const result = await callModel(DEFAULT_PROMPT, body);
  console.log(
    JSON.stringify({
      kind: 'model',
      ok: true,
      input: article ? '真实来源正文' : '明确标记的测试样例',
      shouldWarn: result.shouldWarn,
      foods: result.alerts.map((a) => a.food),
    }),
  );
} catch (e) {
  console.log(
    JSON.stringify({
      kind: 'model',
      ok: false,
      error: e instanceof Error ? e.message : '模型失败',
    }),
  );
  process.exitCode = 1;
}
