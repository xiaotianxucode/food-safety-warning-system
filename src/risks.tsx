import React from 'react';
export const riskNames: Record<string,string>={biological:'生物性风险',chemical:'化学性风险',physical:'物理性风险',other:'其他风险'};
export type Risk={category:string;subtype:string;note:string};
export function RiskTags({categories=[],risks=[]}:{categories?:string[];risks?:Risk[]}) {
  const names=[...new Set([...categories,...risks.map(r=>r.category)])];
  return <span className="risk-tags">{names.map(c=><span className={`tag risk-${c}`} key={c}>{riskNames[c]||c}</span>)}</span>;
}
