export function failureTotals(summary: Record<string, any>) {
  return {
    collection: summary.collectionIssues ?? (summary.countVersion === 2 ?
      ((summary.collectionFailed || 0) + (summary.pageFailed || 0)) : summary.collectionFailed) ??
      ((summary.pageFailed || 0) + (summary.readFailed || 0) + (summary.dateUnknown || 0)),
    analysis: summary.modelFailed || 0,
  };
}
export function collectionCounts(summary: Record<string, any>) {
  // Earlier summaries counted only successfully retrieved news in `collected`.
  const failed = summary.countVersion === 2 ? (summary.collectionFailed || 0) :
    ((summary.readFailed || 0) + (summary.dateUnknown || 0));
  return {
    collected: (summary.collected || 0) + (summary.countVersion === 2 ? 0 : failed),
    failed,
    deduplicated: summary.deduplicated || 0,
    added: summary.added || 0,
  };
}
export function failureLabel(status: string) {
  if (['read_failed', 'date_unknown', 'crawl_failed'].includes(status)) return '采集失败';
  if (['failed', 'analysis_failed'].includes(status)) return '模型分析失败';
  return undefined;
}
