export type QuotaWindow = {
  limitId:string|null; limitName:string|null; window:string|null;
  usedPercent:number|null; remainingPercent:number|null;
  windowMinutes:number|null; resetsAt:number|null; reachedType:string|null;
};
export type QuotaResponse = {
  serverTime:string; staleAfterMs:number; collectionStatus:'empty'|'ok'|'partial'|'error';
  collectedAt:string|null; errors:string[];
  quota:null|{observedAt:string;stale:boolean;ordinaryUsageAllowed:boolean|null;windows:QuotaWindow[]};
  usage:null|{observedAt:string;stale:boolean;lifetimeTokens:number|null;peakDailyTokens:number|null;
    dailyBuckets:null|{date:string|null;tokens:number|null}[]};
};
