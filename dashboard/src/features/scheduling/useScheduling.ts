import { useCallback,useEffect,useRef,useState } from 'react';
import type { SchedulingResponse } from './types';

export function useScheduling() {
  const [data,setData]=useState<SchedulingResponse|null>(null),[loading,setLoading]=useState(true),[networkError,setNetworkError]=useState(false);
  const request=useRef<AbortController|null>(null),active=useRef(false),sequence=useRef(0);
  const refresh=useCallback(async()=>{
    if(request.current||!active.current)return;
    const controller=new AbortController(),id=++sequence.current;request.current=controller;
    const timeout=setTimeout(()=>controller.abort(),10000);setLoading(true);
    try {const response=await fetch('/api/scheduling',{signal:controller.signal,cache:'no-store'});if(!response.ok)throw new Error('Scheduling unavailable');
      const next:SchedulingResponse=await response.json();if(next?.version!==1||next.projectionKind!=='preview'||!Array.isArray(next.jobs)||!Array.isArray(next.runs))throw new Error('Invalid scheduling payload');
      if(active.current&&id===sequence.current){setData(next);setNetworkError(false);}}
    catch {if(active.current&&id===sequence.current)setNetworkError(true);}
    finally {clearTimeout(timeout);if(request.current===controller){request.current=null;if(active.current)setLoading(false);}}
  },[]);
  useEffect(()=>{active.current=true;void refresh();const timer=setInterval(()=>void refresh(),15000);
    return()=>{active.current=false;clearInterval(timer);sequence.current++;request.current?.abort();request.current=null;};},[refresh]);
  return {data,loading,networkError,refresh};
}
