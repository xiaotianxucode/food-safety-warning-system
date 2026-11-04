export function failureTotals(summary: Record<string, any>) {
  return {
    collection: summary.collectionFailed ??
      ((summary.pageFailed || 0) + (summary.readFailed || 0) + (summary.dateUnknown || 0)),
    analysis: summary.modelFailed || 0,
  };
}
export function failureLabel(status: string) {
  if (['read_failed', 'date_unknown', 'crawl_failed'].includes(status)) return '采集失败';
  if (['failed', 'analysis_failed'].includes(status)) return '模型分析失败';
  return undefined;
}
