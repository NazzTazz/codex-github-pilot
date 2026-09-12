import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountsQuotaResponse } from './types';

export function useQuota() {
  const [data,setData]=useState<AccountsQuotaResponse|null>(null);
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
      const response=await fetch('/api/accounts/quota',{signal:controller.signal,cache:'no-store'});
      if(!response.ok)throw new Error('Quota unavailable');
      const next:AccountsQuotaResponse=await response.json();
      if(!next || !Array.isArray(next.accounts)||next.accounts.some(account=>!['empty','ok','partial','error'].includes(account.collectionStatus)||!Array.isArray(account.errors)))throw new Error('Invalid quota payload');
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
