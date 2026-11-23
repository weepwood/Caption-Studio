import {useCallback,useEffect,useRef,useState} from 'react';
import type {Chunk} from '../lib/captions';
import type {Device,WorkerRequest,WorkerResponse} from '../workers/transcribe.worker';
export type TranscriptionState={phase:'idle'|'loading'|'running'|'done'|'error';progress:number;partial:string;device:string;message:string;seconds:number};
const initial:TranscriptionState={phase:'idle',progress:0,partial:'',device:'',message:'',seconds:0};
export function useTranscriber(onResult:(chunks:Chunk[])=>void){
  const [state,setState]=useState<TranscriptionState>(initial);
  const worker=useRef<Worker|null>(null);
  const sequence=useRef(0);
  const onResultRef=useRef(onResult);
  useEffect(()=>{onResultRef.current=onResult},[onResult]);
  const stop=useCallback(()=>{sequence.current++;worker.current?.terminate();worker.current=null;setState(initial)},[]);
  useEffect(()=>()=>{worker.current?.terminate()},[]);
  const transcribe=useCallback((audio:Float32Array,model:string,language:string|null,device:Device)=>{
    const jobId=++sequence.current;
    if(!worker.current){
      worker.current=new Worker(new URL('../workers/transcribe.worker.ts',import.meta.url),{type:'module'});
    }
    const w=worker.current;
    w.onmessage=(e:MessageEvent<WorkerResponse>)=>{
      const msg=e.data;if(msg.jobId!==sequence.current)return;
      if(msg.type==='loading')setState(s=>({...s,phase:'loading',progress:msg.progress}));
      if(msg.type==='ready')setState(s=>({...s,phase:'running',device:msg.device}));
      if(msg.type==='partial')setState(s=>({...s,partial:msg.text}));
      if(msg.type==='done'){
        onResultRef.current(msg.chunks);
        setState(s=>({...s,phase:'done',seconds:msg.seconds,device:msg.device,progress:100}));
      }
      if(msg.type==='error')setState(s=>({...s,phase:'error',message:msg.message}));
    };
    w.onerror=e=>setState(s=>({...s,phase:'error',message:e.message||'转录 Worker 出现异常'}));
    setState({...initial,phase:'loading'});
    const req:WorkerRequest={type:'transcribe',jobId,audio,model,language,device};
    w.postMessage(req,[audio.buffer]);
  },[]);
  return {state,transcribe,stop};
}
