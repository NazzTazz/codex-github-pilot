import { useCallback, useEffect, useRef, useState } from 'react';
import type { QuotaResponse } from './types';

export function useQuota() {
  const [data,setData]=useState<QuotaResponse|null>(null);
  const [loading,setLoading]=useState(true);
  const [networkError,setNetworkError]=useState(false);
  const request=useRef<AbortController|null>(null);
  const active=useRef(false);
  const refresh=useCallback(async()=>{
    if(request.current || !active.current)return;
    const controller=new AbortController();request.current=controller;
    const timeout=setTimeout(()=>controller.abort(),10000);
    setLoading(true);
    try {
      const response=await fetch('/api/quota',{signal:controller.signal,cache:'no-store'});
      if(!response.ok)throw new Error('Quota unavailable');
      const next:QuotaResponse=await response.json();
      if(!next || !['empty','ok','partial','error'].includes(next.collectionStatus) || !Array.isArray(next.errors))throw new Error('Invalid quota payload');
      if(active.current && request.current===controller){setData(next);setNetworkError(false);}
    } catch {
      if(active.current && request.current===controller)setNetworkError(true);
    } finally {
      clearTimeout(timeout);
      if(request.current===controller){request.current=null;if(active.current)setLoading(false);}
    }
  },[]);
  useEffect(()=>{
    active.current=true;void refresh();
    const timer=setInterval(()=>{void refresh();},15000);
    return ()=>{active.current=false;clearInterval(timer);request.current?.abort();request.current=null;};
  },[refresh]);
  return {data,loading,networkError,refresh};
}
