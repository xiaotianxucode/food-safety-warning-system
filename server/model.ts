import { z } from 'zod';
const alertSchema = z
  .object({
    food: z.string().trim().min(1).max(200),
    region: z.string().max(200),
    company: z.string().max(500),
    batch: z.string().max(500),
    factor: z.string().trim().min(1).max(1000),
    impact: z.string().max(1500),
    advice: z.string().max(1500),
    evidence: z.string().trim().min(4).max(3000),
    seasoning: z.boolean(),
  })
  .strict();
const analysisSchema = z
  .object({
    shouldWarn: z.boolean(),
    summary: z.string().trim().min(1).max(3000),
    alerts: z.array(alertSchema).max(50),
  })
  .strict();
export type AlertPayload = z.infer<typeof alertSchema> & { summary: string };
export function validateAnalysis(input: unknown, body: string) {
  const result = analysisSchema.parse(input);
  if (result.shouldWarn !== result.alerts.length > 0) throw new Error('预警判定与对象列表不一致');
  const normalized = body.replace(/\s+/g, '');
  for (const a of result.alerts) {
    if (
      !normalized.includes(a.evidence.replace(/\s+/g, '')) ||
      !a.evidence.replace(/\s+/g, '').includes(a.food.replace(/\s+/g, ''))
    )
      throw new Error('预警证据无法与原文及食品名称匹配');
    for (const [name, field] of Object.entries({
      region: a.region,
      company: a.company,
      batch: a.batch,
    }))
      if (field && !normalized.includes(field.replace(/\s+/g, '')))
        throw new Error(`字段 ${name} 缺少原文支持，结果需核查`);
  }
  return result;
}
export const modelName = () => process.env.MODEL_NAME || 'deepseek-v4.1-flash-1017';
export async function callModel(prompt: string, body: string, fetcher: typeof fetch = fetch) {
  if (!process.env.MODEL_API_KEY) throw new Error('未配置 MODEL_API_KEY，请在服务端 .env 中设置');
  const base =
    process.env.MODEL_BASE_URL ||
    'https://ws-8mjq4t0bsufiaamq.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
  const response = await fetcher(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.MODEL_API_KEY}`,
    },
    body: JSON.stringify({
      model: modelName(),
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: JSON.stringify({ news: body }) },
      ],
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) throw new Error(`模型接口返回 HTTP ${response.status}`);
  const data: any = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('模型接口没有返回文本结果');
  return validateAnalysis(
    JSON.parse(content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')),
    body,
  );
}
