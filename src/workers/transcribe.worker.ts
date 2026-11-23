/// <reference lib="webworker" />
import {
  pipeline,WhisperTextStreamer,
  type AutomaticSpeechRecognitionPipeline,type ProgressInfo,type WhisperTokenizer
} from '@huggingface/transformers';
import type {Chunk} from '../lib/captions';
export type Device='auto'|'webgpu'|'wasm';
export type WorkerRequest={type:'transcribe'; jobId:number; audio:Float32Array; model:string; language:string|null; device:Device};
export type WorkerResponse=
 | {type:'loading';jobId:number;progress:number;loaded:number;total:number}
 | {type:'ready';jobId:number;device:'webgpu'|'wasm'}
 | {type:'partial';jobId:number;text:string}
 | {type:'done';jobId:number;chunks:Chunk[];seconds:number;device:string}
 | {type:'error';jobId:number;message:string};
const emit=(v:WorkerResponse)=>self.postMessage(v);
let cache:{model:string;device:'webgpu'|'wasm';asr:AutomaticSpeechRecognitionPipeline}|null=null;
async function canWebGPU():Promise<boolean>{
  try {const gpu=(navigator as Navigator & {gpu?:{requestAdapter:()=>Promise<unknown>}}).gpu;
    return Boolean(gpu && await gpu.requestAdapter());
  }catch{return false;}
}
async function getModel(req:WorkerRequest){
  const requested=req.device==='auto'?(await canWebGPU()?'webgpu':'wasm'):req.device;
  if(cache?.model===req.model&&cache.device===requested)return cache;
  await cache?.asr.dispose();cache=null;
  const load=async(device:'webgpu'|'wasm')=>{
    const asr=await pipeline('automatic-speech-recognition',req.model,{
      device,dtype:device==='webgpu'?{encoder_model:'fp32',decoder_model_merged:'q4'}:'q8',
      progress_callback:(p:ProgressInfo)=>{
        if(p.status==='progress_total')emit({type:'loading',jobId:req.jobId,progress:p.progress,loaded:p.loaded,total:p.total});
      }
    }) as AutomaticSpeechRecognitionPipeline;
    cache={model:req.model,device,asr};return cache;
  };
  try{return await load(requested);}catch(error){
    if(req.device==='auto'&&requested==='webgpu')return await load('wasm');
    throw error;
  }
}
self.onmessage=async(e:MessageEvent<WorkerRequest>)=>{
  const req=e.data;
  if(req.type!=='transcribe')return;
  try{
    const {asr,device}=await getModel(req);
    emit({type:'ready',jobId:req.jobId,device});
    let partial='';
    const streamer=new WhisperTextStreamer(asr.tokenizer as WhisperTokenizer,{
      skip_prompt:true,callback_function:(str:string)=>{
        partial+=str;
        emit({type:'partial',jobId:req.jobId,text:partial.slice(-400)});
      }
    });
    const time=performance.now();
    const out=await asr(req.audio,{
      return_timestamps:true,chunk_length_s:30,stride_length_s:5,
      ...(req.model.endsWith('.en')?{}:{language:req.language??undefined,task:'transcribe'}),
      streamer
    });
    const result=Array.isArray(out)?out[0]:out;
    emit({type:'done',jobId:req.jobId,chunks:(result.chunks||[]) as Chunk[],seconds:(performance.now()-time)/1000,device});
  }catch(err){
    emit({type:'error',jobId:req.jobId,message:err instanceof Error?err.message:String(err)});
  }
};
