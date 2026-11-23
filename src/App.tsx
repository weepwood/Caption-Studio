import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Activity,AlertTriangle,ArrowDownToLine,AudioLines,Check,ChevronDown,Clock3,Download,FileAudio,FileText,FileVideo,FolderOpen,HardDriveDownload,Info,Languages,LoaderCircle,Pause,Play,Plus,RotateCcw,Scissors,Search,Settings2,ShieldCheck,SkipBack,SkipForward,Split,Subtitles,Trash2,Undo2,Redo2,UploadCloud,Volume2,WandSparkles,X} from 'lucide-react';
import {Timeline} from './components/Timeline';
import {useHistory} from './hooks/useHistory';
import {useTranscriber} from './hooks/useTranscriber';
import {decodeAudio} from './lib/audio';
import {chunksToCues,defaultStyle,fmt,lintCue,mergeNext,parseSubtitles,parseTime,round3,shiftCues,shortTime,sorted,splitCue,toSRT,toVTT,uid,type CaptionStyle,type Chunk,type Cue,type Issue} from './lib/captions';
import {clearProject,loadProject,saveProject,verifyProject,type Project} from './lib/storage';
import type {Device} from './workers/transcribe.worker';

const MODELS=[
  {id:'onnx-community/whisper-tiny',title:'Tiny · 快速',size:'~40 MB'},
  {id:'onnx-community/whisper-base',title:'Base · 均衡',size:'~80 MB'},
  {id:'onnx-community/whisper-small',title:'Small · 较准确',size:'~250 MB'},
  {id:'onnx-community/whisper-tiny.en',title:'Tiny · 仅英语',size:'~40 MB'},
  {id:'onnx-community/whisper-base.en',title:'Base · 仅英语',size:'~80 MB'},
];
const LANGS=[['auto','自动检测'],['chinese','中文'],['english','英语'],['japanese','日语'],['korean','韩语'],['spanish','西班牙语'],['french','法语'],['german','德语'],['russian','俄语'],['hindi','印地语']];
type Tab='cues'|'style'|'export';
type RenderState={phase:'idle'|'working'|'error';progress:number;message:string};
const issueNames:Record<Issue,string>={empty:'空白内容',time:'无效时间',overlap:'时间重叠',fast:'阅读太快',long:'字幕过长'};
const download=(data:Blob,name:string)=>{
  const href=URL.createObjectURL(data),a=document.createElement('a');
  a.href=href;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(href),15000);
};
const sizeText=(b:number)=>b>1024*1024?`${(b/1024/1024).toFixed(1)} MB`:`${(b/1024).toFixed(0)} KB`;
const baseName=(n:string)=>n.replace(/\.[^.]+$/,'')||'captions';
const sampleCues: Cue[]=[
  {id:uid(),start:0.4,end:3.1,text:'欢迎使用 Caption Studio。'},
  {id:uid(),start:3.3,end:6.7,text:'所有视频和字幕编辑都在你的浏览器中进行。'},
  {id:uid(),start:7,end:10.8,text:'导入本地视频，即可体验 AI 转录与精确校对。'},
];
function iconStatus(text:string){return <span className="pill-status"><ShieldCheck size={13}/>{text}</span>}

export default function App(){
  const [file,setFile]=useState<File|null>(null);
  const [projectName,setProjectName]=useState('未命名项目');
  const [originalMediaName,setOriginalMediaName]=useState('');
  const [duration,setDuration]=useState(0);
  const [time,setTime]=useState(0);
  const [playing,setPlaying]=useState(false);
  const [peaks,setPeaks]=useState<number[]>([]);
  const [decoding,setDecoding]=useState(false);
  const [model,setModel]=useState(MODELS[1].id);
  const [language,setLanguage]=useState('auto');
  const [device,setDevice]=useState<Device>('auto');
  const [maxChars,setMaxChars]=useState(30);
  const [style,setStyle]=useState<CaptionStyle>(defaultStyle);
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const [tab,setTab]=useState<Tab>('cues');
  const [query,setQuery]=useState('');
  const [error,setError]=useState('');
  const [saved,setSaved]=useState<'loading'|'saved'|'saving'|'error'>('loading');
  const [hydrated,setHydrated]=useState(false);
  const [renderState,setRenderState]=useState<RenderState>({phase:'idle',progress:0,message:''});
  const [font,setFont]=useState<File|null>(null);
  const [shift,setShift]=useState('0.5');
  const video=useRef<HTMLVideoElement>(null);
  const mediaInput=useRef<HTMLInputElement>(null);
  const captionsInput=useRef<HTMLInputElement>(null);
  const projectInput=useRef<HTMLInputElement>(null);
  const fontInput=useRef<HTMLInputElement>(null);
  const renderAbort=useRef<AbortController|null>(null);
  const decodeSequence=useRef(0);
  const {value:cues,set:setCues,reset:resetCues,undo,redo,canUndo,canRedo}=useHistory<Cue[]>([]);
  const [mediaURL,setMediaURL]=useState<string|null>(null);
  useEffect(()=>{
    if(!file){setMediaURL(null);return}
    const url=URL.createObjectURL(file);setMediaURL(url);
    return()=>URL.revokeObjectURL(url);
  },[file]);
  const isVideo=Boolean(file?.type.startsWith('video/')||file?.name.match(/\.(mp4|mov|webm|m4v)$/i));
  const effectiveDuration=Math.max(duration,...cues.map(c=>c.end),0);
  const activeCue=useMemo(()=>cues.find(c=>time>=c.start&&time<c.end)??null,[cues,time]);
  const selectedCue=cues.find(c=>c.id===selectedId)??null;
  const problemCount=useMemo(()=>cues.reduce((n,c,i)=>n+lintCue(c,cues[i+1]).length,0),[cues]);
  const shown=useMemo(()=>cues.filter(c=>c.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())),[cues,query]);
  const onChunks=useCallback((chunks:Chunk[])=>{
    setCues(chunksToCues(chunks,maxChars,duration||undefined));
    setTab('cues');setSelectedId(null);
  },[duration,maxChars,setCues]);
  const transcriber=useTranscriber(onChunks);
  const busy=decoding||['loading','running'].includes(transcriber.state.phase);

  useEffect(()=>{
    let cancelled=false;
    loadProject().then(p=>{
      if(!p||cancelled)return;
      const clean=verifyProject(p);
      setProjectName(clean.name);setOriginalMediaName(clean.mediaName);
      setDuration(clean.duration);setStyle(clean.style);resetCues(clean.cues);
    }).then(()=>{if(!cancelled)setSaved('saved')}).catch(()=>{if(!cancelled)setSaved('error')}).finally(()=>{if(!cancelled)setHydrated(true)});
    return()=>{cancelled=true};
  },[resetCues]);
  useEffect(()=>{
    if(!hydrated)return;
    setSaved('saving');
    const timer=setTimeout(()=>{
      const p:Project={version:1,name:projectName,mediaName:file?.name||originalMediaName,duration:effectiveDuration,cues,style,updatedAt:Date.now()};
      saveProject(p).then(()=>setSaved('saved')).catch(()=>setSaved('error'));
    },600);
    return()=>clearTimeout(timer);
  },[hydrated,projectName,file,originalMediaName,effectiveDuration,cues,style]);

  const loadMedia=(f:File)=>{
    if(!f.type.startsWith('video/')&&!f.type.startsWith('audio/')&&!/\.(mp4|mov|webm|m4v|mp3|m4a|wav|ogg|flac|aac)$/i.test(f.name)){
      setError('请选择音频或视频文件');return;
    }
    const relink=Boolean(cues.length&&(!file&&!originalMediaName||originalMediaName===f.name));
    if(cues.length&&!relink&&!window.confirm('打开新媒体将清空当前字幕。请先导出工程或字幕。确定继续？'))return;
    decodeSequence.current++;transcriber.stop();setDecoding(false);setError('');setFile(f);
    if(!relink){setProjectName(baseName(f.name));setDuration(0);setSelectedId(null);resetCues([])}
    setOriginalMediaName(f.name);setTime(0);setPeaks([]);
    setRenderState({phase:'idle',progress:0,message:''});
  };
  const openMediaOrSubtitle=(f:File)=>{
    if(/\.(srt|vtt)$/i.test(f.name)){void importSubtitles(f);return;}
    if(/\.json$/i.test(f.name)){void importProject(f);return;}
    loadMedia(f);
  };
  const importSubtitles=async(f:File)=>{
    setError('');
    try{
      const buffer=await f.arrayBuffer();
      let text=new TextDecoder('utf-8').decode(buffer);
      if((text.match(/�/g)||[]).length>2)text=new TextDecoder('gb18030').decode(buffer);
      const parsed=parseSubtitles(text);
      if(!parsed.length)throw Error('未检测到有效的字幕时间轴');
      resetCues(parsed);setSelectedId(parsed[0].id);setTab('cues');
      if(!file)setProjectName(baseName(f.name));
    }catch(e){setError(`字幕导入失败：${String(e instanceof Error?e.message:e)}`)}
  };
  const importProject=async(f:File)=>{
    try{
      const p=verifyProject(JSON.parse(await f.text()));
      decodeSequence.current++;transcriber.stop();setDecoding(false);setFile(null);setPeaks([]);setTime(0);
      setDuration(p.duration);setProjectName(p.name);setOriginalMediaName(p.mediaName);
      setStyle(p.style);resetCues(p.cues);setSelectedId(null);setError('');setTab('cues');
    }catch(e){setError(`项目导入失败：${String(e instanceof Error?e.message:e)}`)}
  };
  const reset=async()=>{
    decodeSequence.current++;transcriber.stop();setDecoding(false);resetCues([]);setFile(null);setPeaks([]);setProjectName('未命名项目');
    setOriginalMediaName('');setDuration(0);setTime(0);setSelectedId(null);setStyle(defaultStyle);setError('');
    try{await clearProject()}catch{/* next autosave will replace */}
  };
  const seek=(s:number)=>{
    const t=Math.max(0,Math.min(s,effectiveDuration));
    if(video.current)video.current.currentTime=t;
    setTime(t);
  };
  const play=()=>{if(!video.current)return;if(video.current.paused)void video.current.play();else video.current.pause()};
  const startTranscription=async()=>{
    if(!file)return;
    if(file.size>350*1024*1024){setError('媒体文件超过 350 MB。当前浏览器解码实现需要完整加载音轨，建议先提取音频或压缩视频后再转录。');return;}
    if(cues.length&&!window.confirm('重新转录将替换当前所有字幕。是否继续？'))return;
    const token=++decodeSequence.current;setError('');setDecoding(true);
    try{
      const decoded=await decodeAudio(file);
      if(token!==decodeSequence.current)return;
      setPeaks(decoded.peaks);
      transcriber.transcribe(decoded.pcm,model,language==='auto'?null:language,device);
    }catch(e){if(token===decodeSequence.current)setError(String(e instanceof Error?e.message:e))}
    finally{if(token===decodeSequence.current)setDecoding(false)}
  };
  const makeWaveform=async()=>{
    if(!file)return;
    if(file.size>350*1024*1024){setError('文件过大，请先提取音轨');return;}
    const token=++decodeSequence.current;setDecoding(true);setError('');
    try{const d=await decodeAudio(file);if(token===decodeSequence.current)setPeaks(d.peaks);}catch(e){if(token===decodeSequence.current)setError(String(e instanceof Error?e.message:e))}
    finally{if(token===decodeSequence.current)setDecoding(false)}
  };
  const cancelTask=()=>{decodeSequence.current++;transcriber.stop();setDecoding(false)};
  const updateCue=(id:string,patch:Partial<Cue>)=>setCues(list=>{
    const next=list.map(c=>c.id===id?{...c,...patch}:c);
    return 'start' in patch?sorted(next):next;
  },'text' in patch?`text:${id}`:'');
  const insertAfter=(id?:string)=>{
    const index=id?cues.findIndex(c=>c.id===id):cues.length-1;
    const start=index>=0?(cues[index]?.end||0):0;
    const next=cues[index+1]?.start;
    const end=next&&next>start+0.1?Math.min(next,start+2):start+2;
    const cue:Cue={id:uid(),start:round3(start),end:round3(end),text:''};
    setCues(list=>[...list.slice(0,index+1),cue,...list.slice(index+1)]);setSelectedId(cue.id);
  };
  const exportAs=(kind:'srt'|'vtt'|'json')=>{
    const valid=cues.filter(c=>c.end>c.start&&c.text.trim());
    if(!valid.length){setError('没有可导出的有效字幕');return;}
    const p:Project={version:1,name:projectName,mediaName:file?.name||originalMediaName,duration:effectiveDuration,cues,style,updatedAt:Date.now()};
    const data=kind==='srt'?toSRT(valid):kind==='vtt'?toVTT(valid):JSON.stringify(p,null,2);
    download(new Blob([data],{type:kind==='json'?'application/json':'text/plain;charset=utf-8'}),`${baseName(projectName)}.${kind}`);
  };
  const renderVideo=async()=>{
    if(!file||!isVideo||!cues.length)return;
    setError('');setRenderState({phase:'working',progress:0,message:'正在下载 FFmpeg 并准备文件…'});
    const controller=new AbortController();renderAbort.current=controller;
    try{
      const {burnVideo}=await import('./lib/burn');
      const out=await burnVideo({file,cues,style,font:font??undefined,signal:controller.signal,onProgress:p=>setRenderState({phase:'working',progress:p,message:'正在编码视频…'})});
      download(out,`${baseName(projectName)}-captioned.mp4`);
      setRenderState({phase:'idle',progress:0,message:'视频已导出'});
    }catch(e){setRenderState({phase:'error',progress:0,message:controller.signal.aborted?'已取消渲染':String(e instanceof Error?e.message:e)})}
    finally{renderAbort.current=null}
  };
  const exportProject=()=>{
    const p:Project={version:1,name:projectName,mediaName:file?.name||originalMediaName,duration:effectiveDuration,cues,style,updatedAt:Date.now()};
    download(new Blob([JSON.stringify(p,null,2)],{type:'application/json'}),`${baseName(projectName)}.caption-project.json`);
  };
  useEffect(()=>{
    const handle=(e:KeyboardEvent)=>{
      const input=(e.target as HTMLElement).closest('textarea,input,select,[contenteditable]');
      if(input)return;
      if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){
        e.preventDefault();if(e.shiftKey)redo();else undo();
      }else if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='y'){e.preventDefault();redo()}
      else if(e.code==='Space'){e.preventDefault();play()}
    };
    window.addEventListener('keydown',handle);return()=>window.removeEventListener('keydown',handle);
  });
  const mediaMissing=Boolean(originalMediaName&&!file);

  return <div className="app-shell" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(e.dataTransfer.files[0])openMediaOrSubtitle(e.dataTransfer.files[0])}}>
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><AudioLines size={20} strokeWidth={2.5}/></span><div><b>caption<span className="brand-light">studio</span></b><small>LOCAL FIRST EDITOR</small></div></div>
      <span className="header-divider"/>
      <div className="project-name"><input aria-label="项目名称" value={projectName} onChange={e=>setProjectName(e.target.value)} maxLength={100}/><ChevronDown size={14}/></div>
      <div className="header-spacer"/>
      <div className="save-indicator">{saved==='saved'?<Check size={14}/>:saved==='saving'?<LoaderCircle className="spin" size={14}/>:<AlertTriangle size={14}/>} <span>{saved==='saved'?'已保存到本地':saved==='saving'?'正在保存':saved==='loading'?'正在读取':'保存失败'}</span></div>
      <button className="btn small outline" onClick={exportProject}><HardDriveDownload size={16}/>导出工程</button>
      <button className="btn small primary" onClick={()=>mediaInput.current?.click()}><FolderOpen size={16}/>打开媒体</button>
    </header>
    <input ref={mediaInput} type="file" accept="video/*,audio/*,.mp4,.m4a,.webm,.wav,.mov" hidden onChange={e=>{if(e.target.files?.[0])loadMedia(e.target.files[0]);e.target.value=''}}/>
    <input ref={captionsInput} type="file" accept=".srt,.vtt" hidden onChange={e=>{if(e.target.files?.[0])void importSubtitles(e.target.files[0]);e.target.value=''}}/>
    <input ref={projectInput} type="file" accept=".json" hidden onChange={e=>{if(e.target.files?.[0])void importProject(e.target.files[0]);e.target.value=''}}/>
    <input ref={fontInput} type="file" accept=".ttf,.otf" hidden onChange={e=>{setFont(e.target.files?.[0]??null);e.target.value=''}}/>

    <div className="workspace">
      <aside className="nav-rail" aria-label="工作区">
        <span className="rail-label">WORKSPACE</span>
        <button className="rail-item selected"><Subtitles size={18}/>字幕工作台</button>
        <button className="rail-item" onClick={()=>captionsInput.current?.click()}><FileText size={18}/>导入字幕</button>
        <button className="rail-item" onClick={()=>projectInput.current?.click()}><FolderOpen size={18}/>打开工程</button>
        <div className="rail-spacer"/>
        <div className="rail-info"><ShieldCheck size={17}/><div><b>纯本地处理</b><small>媒体不会上传到服务端。模型与运行资源需首次联网下载。</small></div></div>
        <button className="rail-item reset" onClick={()=>{if(window.confirm('确定新建空白工程？未导出的媒体不会保存。'))void reset()}}><RotateCcw size={17}/>新建工程</button>
        <div className="rail-version">CAPTION STUDIO · 0.2.0</div>
      </aside>
      <main className="editor-area">
        <div className="editor-header">
          <div><div className="eyebrow">EDITOR / LOCAL WORKSPACE</div><h1>字幕编辑工作台</h1><p>导入媒体 · 本地识别 · 精确校对 · 导出成片</p></div>
          <div className="editor-header-actions">{iconStatus('无需上传视频')}<span className="line-separator"/><span className="header-meta">{cues.length} 条字幕</span></div>
        </div>
        {error&&<div className="error-banner" role="alert"><AlertTriangle size={16}/><span>{error}</span><button aria-label="关闭错误提示" onClick={()=>setError('')}><X size={16}/></button></div>}
        {mediaMissing&&<div className="notice-banner"><Info size={16}/>已恢复字幕工程，但媒体文件不会自动保存。请重新打开「{originalMediaName}」以继续视频预览。</div>}
        <div className="content-grid">
          <div className="main-column">
            <section className="video-panel surface">
              <div className="section-title"><div><strong>视频预览</strong><span className="subtle">PREVIEW</span></div><span className="chip">{isVideo?'视频':'本地媒体'}</span></div>
              <div className="video-frame">
                {mediaURL?<>
                  <video ref={video} src={mediaURL} playsInline onTimeUpdate={e=>setTime(e.currentTarget.currentTime)} onLoadedMetadata={e=>{if(Number.isFinite(e.currentTarget.duration))setDuration(e.currentTarget.duration)}} onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onEnded={()=>setPlaying(false)} onClick={play}/>
                  {activeCue&&<div className={`caption-overlay ${style.position}`}><span style={{color:style.textColor,backgroundColor:colorAlpha(style.boxColor,style.boxOpacity),fontSize:`clamp(14px,${(style.fontSize/1080*100).toFixed(2)}cqh,${style.fontSize}px)`,fontWeight:style.bold?700:400}}>{activeCue.text}</span></div>}
                  {!isVideo&&<div className="audio-backdrop"><Activity size={50} strokeWidth={1.1}/><p>音频预览</p></div>}
                </>:<div className="empty-media"><div className="empty-icon"><UploadCloud size={25}/></div><h2>从这里开始</h2><p>拖入 MP4、WebM、MP3 或 WAV，或直接导入已有字幕文件。</p><div className="empty-actions"><button className="btn primary" onClick={()=>mediaInput.current?.click()}><FileVideo size={16}/>选择媒体文件</button><button className="btn outline" onClick={()=>captionsInput.current?.click()}><FileText size={16}/>导入 SRT / VTT</button></div>{!cues.length&&<button className="text-button" onClick={()=>{resetCues(sampleCues.map(c=>({...c,id:uid()})));setSelectedId(null);setProjectName('示例字幕')}}>仅体验编辑器：加载示例字幕</button>}</div>}
              </div>
              <div className="playback-controls">
                <button className="play-button" onClick={play} disabled={!file} aria-label={playing?'暂停':'播放'}>{playing?<Pause size={17} fill="currentColor"/>:<Play size={17} fill="currentColor"/>}</button>
                <button className="icon-btn" title="后退 5 秒" onClick={()=>seek(time-5)}><SkipBack size={17}/></button>
                <button className="icon-btn" title="前进 5 秒" onClick={()=>seek(time+5)}><SkipForward size={17}/></button>
                <span className="playback-time">{shortTime(time)} <span>/ {shortTime(effectiveDuration)}</span></span>
                <input type="range" min={0} max={effectiveDuration||1} step={.01} value={Math.min(time,effectiveDuration)} aria-label="跳转播放位置" onChange={e=>seek(Number(e.target.value))}/>
                <span className="playback-volume"><Volume2 size={17}/></span>
              </div>
              <div className="media-info"><div><FileAudio size={15}/><span>{file?.name??'尚未打开媒体文件'}</span></div><span>{file?sizeText(file.size):'—'}</span></div>
            </section>
            <section className="transcribe-panel surface">
              <div className="section-title"><div><strong>AI 语音识别</strong><span className="subtle">WHISPER · ON DEVICE</span></div><span className="chip"><Activity size={13}/> Local AI</span></div>
              <div className="settings-grid">
                <label>识别模型 <select value={model} disabled={busy} onChange={e=>setModel(e.target.value)}>{MODELS.map(m=><option key={m.id} value={m.id}>{m.title} ({m.size})</option>)}</select></label>
                <label>原文语言 <select value={language} disabled={busy||model.endsWith('.en')} onChange={e=>setLanguage(e.target.value)}>{LANGS.map(([id,title])=><option key={id} value={id}>{title}</option>)}</select></label>
                <label>计算后端 <select value={device} disabled={busy} onChange={e=>setDevice(e.target.value as Device)}><option value="auto">自动 (GPU 优先)</option><option value="webgpu">WebGPU</option><option value="wasm">CPU / WASM</option></select></label>
                <label>每条字幕最大字符 <input type="number" min={8} max={120} value={maxChars} disabled={busy} onChange={e=>setMaxChars(Math.min(120,Math.max(8,Number(e.target.value)||30)))}/></label>
              </div>
              <div className="transcribe-bottom"><div className="transcribe-helper"><Info size={15}/><span>支持中文标点智能分句。首次运行需联网下载模型，推理在本地设备完成。</span></div>
                {busy?<button className="btn danger-ghost" onClick={cancelTask}><X size={15}/>取消任务</button>:<button className="btn primary" disabled={!file} onClick={()=>void startTranscription()}><WandSparkles size={16}/>{cues.length?'重新生成字幕':'开始自动转录'}</button>}</div>
              {decoding&&<div className="task-status"><LoaderCircle className="spin" size={15}/>正在提取媒体音轨并生成波形…</div>}
              {transcriber.state.phase==='loading'&&<div className="task-status"><LoaderCircle className="spin" size={15}/>正在准备模型 {Math.round(transcriber.state.progress)}% <progress value={transcriber.state.progress} max="100"/></div>}
              {transcriber.state.phase==='running'&&<div className="task-status"><LoaderCircle className="spin" size={15}/>正在使用 {transcriber.state.device==='webgpu'?'WebGPU':'WASM'} 识别… {transcriber.state.partial&&<span className="transcript-snippet">{transcriber.state.partial}</span>}</div>}
              {transcriber.state.phase==='done'&&<div className="task-status done"><Check size={15}/>转录完成 · {transcriber.state.device} · {transcriber.state.seconds.toFixed(1)} 秒</div>}
              {transcriber.state.phase==='error'&&<div className="task-status failed"><AlertTriangle size={15}/>{transcriber.state.message}</div>}
            </section>
          </div>
          <aside className="side-panel surface">
            <div className="side-tabs" role="tablist" aria-label="工作区功能">
              <button role="tab" aria-selected={tab==='cues'} className={tab==='cues'?'active':''} onClick={()=>setTab('cues')}><Subtitles size={16}/>字幕</button>
              <button role="tab" aria-selected={tab==='style'} className={tab==='style'?'active':''} onClick={()=>setTab('style')}><Settings2 size={16}/>样式</button>
              <button role="tab" aria-selected={tab==='export'} className={tab==='export'?'active':''} onClick={()=>setTab('export')}><ArrowDownToLine size={16}/>导出</button>
            </div>
            {tab==='cues'&&<>
              <div className="side-tools"><div className="subtitle-search"><Search size={15}/><input placeholder="搜索字幕内容" aria-label="搜索字幕" value={query} onChange={e=>setQuery(e.target.value)}/></div><div className="history-buttons"><button className="icon-btn" disabled={!canUndo} onClick={undo} title="撤销 (Ctrl+Z)"><Undo2 size={16}/></button><button className="icon-btn" disabled={!canRedo} onClick={redo} title="重做"><Redo2 size={16}/></button></div></div>
              <div className="cue-stats"><span>{shown.length} / {cues.length} 条字幕</span><span className={problemCount?'issue-count':''}>{problemCount?<AlertTriangle size={13}/>:<Check size={13}/>} {problemCount} 项检查提示</span></div>
              <div className="cue-list">
                {!cues.length?<div className="empty-cues"><FileText size={29}/><h3>还没有字幕</h3><p>识别语音、导入字幕，或手动新增一条。</p><button className="btn outline" onClick={()=>insertAfter()}><Plus size={15}/>新增字幕</button></div>:shown.length===0?<div className="empty-cues"><Search size={22}/>没有匹配的字幕</div>:
                  shown.map((c)=>{const index=cues.findIndex(x=>x.id===c.id),issues=lintCue(c,cues[index+1]);return <article key={c.id} className={`cue-row ${selectedId===c.id?'selected':''} ${activeCue?.id===c.id?'playing':''}`} onClick={()=>setSelectedId(c.id)}>
                    <div className="cue-row-top"><button className="cue-number" onClick={e=>{e.stopPropagation();seek(c.start);setSelectedId(c.id)}}>{String(index+1).padStart(2,'0')}</button><span className="cue-duration">{(c.end-c.start).toFixed(1)}s</span><div className="cue-row-actions"><button title="在当前位置拆分" onClick={()=>setCues(xs=>splitCue(xs,c.id))}><Scissors size={14}/></button><button title="与下一条合并" disabled={index===cues.length-1} onClick={()=>setCues(xs=>mergeNext(xs,c.id))}><Split size={14}/></button><button title="新增下一条" onClick={()=>insertAfter(c.id)}><Plus size={14}/></button><button title="删除字幕" onClick={()=>setCues(xs=>xs.filter(x=>x.id!==c.id))}><Trash2 size={14}/></button></div></div>
                    <textarea aria-label={`第 ${index+1} 条字幕`} rows={Math.max(2,Math.min(4,Math.ceil(c.text.length/30)))} value={c.text} onChange={e=>updateCue(c.id,{text:e.target.value})} onFocus={()=>setSelectedId(c.id)}/>
                    <div className="cue-row-bottom"><TimeEditor label="开始时间" time={c.start} onCommit={v=>updateCue(c.id,{start:v})}/><span>→</span><TimeEditor label="结束时间" time={c.end} onCommit={v=>updateCue(c.id,{end:v})}/><button className="cue-seek" onClick={()=>{seek(c.start);setSelectedId(c.id)}} title="跳转到字幕"><Play size={12}/></button></div>
                    {issues.length>0&&<div className="cue-issues">{issues.map(issue=><span key={issue}>{issueNames[issue]}</span>)}</div>}
                  </article>})}
              </div>
              <div className="cue-footer"><div className="shift-controls"><span>整体偏移</span><input aria-label="偏移秒数" type="number" step="0.1" value={shift} onChange={e=>setShift(e.target.value)}/><span>秒</span><button onClick={()=>setCues(c=>shiftCues(c,-(Number(shift)||0)))} title="提前字幕">−</button><button onClick={()=>setCues(c=>shiftCues(c,Number(shift)||0))} title="延后字幕">+</button></div><button className="btn outline full" onClick={()=>insertAfter(cues[cues.length-1]?.id)}><Plus size={15}/>新增字幕</button></div>
            </>}
            {tab==='style'&&<div className="style-editor">
              <div className="section-subheading"><strong>预览样式</strong><small>适用于播放器与视频烧录</small></div>
              <div className="style-fields">
                <label>字号 <div className="size-range"><input type="range" min={24} max={92} value={style.fontSize} onChange={e=>setStyle(s=>({...s,fontSize:Number(e.target.value)}))}/><output>{style.fontSize}px</output></div></label>
                <label>文字颜色 <input type="color" value={style.textColor} onChange={e=>setStyle(s=>({...s,textColor:e.target.value}))}/></label>
                <label>背景颜色 <input type="color" value={style.boxColor} onChange={e=>setStyle(s=>({...s,boxColor:e.target.value}))}/></label>
                <label>背景透明度 <div className="size-range"><input type="range" min={0} max={100} value={style.boxOpacity*100} onChange={e=>setStyle(s=>({...s,boxOpacity:Number(e.target.value)/100}))}/><output>{Math.round(style.boxOpacity*100)}%</output></div></label>
                <label>字幕位置 <select value={style.position} onChange={e=>setStyle(s=>({...s,position:e.target.value as CaptionStyle['position']}))}><option value="bottom">底部居中</option><option value="middle">画面居中</option><option value="top">顶部居中</option></select></label>
                <label className="switch-row">文字加粗 <input type="checkbox" checked={style.bold} onChange={e=>setStyle(s=>({...s,bold:e.target.checked}))}/></label>
              </div>
              <button className="btn outline full" onClick={()=>setStyle(defaultStyle)}>恢复默认样式</button>
              <div className="style-note"><Info size={15}/> 浏览器字幕预览与 FFmpeg 烧录可能存在字体度量差异。中文烧录建议手动选择支持中文的字体文件。</div>
            </div>}
            {tab==='export'&&<div className="export-editor">
              <div className="section-subheading"><strong>字幕文件</strong><small>兼容常见播放器与剪辑软件</small></div>
              <div className="export-grid"><button disabled={!cues.length} onClick={()=>exportAs('srt')}><FileText size={22}/><strong>SRT</strong><small>通用字幕文件</small><Download size={15}/></button><button disabled={!cues.length} onClick={()=>exportAs('vtt')}><FileText size={22}/><strong>VTT</strong><small>网页视频字幕</small><Download size={15}/></button></div>
              <button className="btn outline full" onClick={exportProject}><HardDriveDownload size={16}/>导出可恢复的 JSON 工程</button>
              <div className="section-subheading render-heading"><strong>烧录字幕到视频</strong><small>实验功能 · 适合短视频</small></div>
              <button className="file-pick" onClick={()=>fontInput.current?.click()}><Languages size={17}/>{font?.name||'选择中文字体 .ttf / .otf（推荐）'}<ChevronDown size={14}/></button>
              {renderState.phase==='working'?<div className="render-progress"><progress value={renderState.progress} max={1}/><span>{renderState.message} {Math.round(renderState.progress*100)}%</span><button className="btn outline full" onClick={()=>renderAbort.current?.abort()}>取消烧录</button></div>:<button className="btn primary full" disabled={!isVideo||!cues.length} onClick={()=>void renderVideo()}><FileVideo size={16}/>生成带字幕 MP4</button>}
              {renderState.phase==='error'&&<div className="style-note warning">{renderState.message}</div>}
              {renderState.message&&renderState.phase==='idle'&&<div className="task-status done"><Check size={15}/>{renderState.message}</div>}
              <div className="style-note"><AlertTriangle size={15}/> 网页端 MP4 重新编码可能很慢且占用大量内存。长视频建议导出 SRT 后使用桌面 FFmpeg 烧录。</div>
            </div>}
          </aside>
        </div>
        <Timeline duration={effectiveDuration} cues={cues} peaks={peaks} time={time} selectedId={selectedId} onSeek={seek} onSelect={setSelectedId} onUpdate={updateCue}/>
        <div className="bottom-meta"><div><Clock3 size={14}/> {effectiveDuration?`媒体时长 ${fmt(effectiveDuration,'vtt')}`:'等待媒体'} <span className="dot">·</span>{selectedCue?`已选中第 ${cues.findIndex(c=>c.id===selectedId)+1} 条字幕`:'未选择字幕'}</div><div><button onClick={()=>void makeWaveform()} disabled={!file||decoding||busy}><AudioLines size={14}/> {peaks.length?'重新提取波形':'提取音频波形'}</button><span className="dot">·</span><a href="https://github.com/sudesh1456/whisper-caption-editor" target="_blank" rel="noreferrer">原项目 / MIT</a></div></div>
      </main>
    </div>
  </div>;
}

function TimeEditor({time,label,onCommit}:{time:number;label:string;onCommit:(time:number)=>void}){
  const [draft,setDraft]=useState<string|null>(null);
  const commit=()=>{if(draft!==null){const value=parseTime(draft);if(Number.isFinite(value)&&value>=0)onCommit(round3(value));setDraft(null)}};
  return <input className="time-input" aria-label={label} title={label} value={draft??shortTime(time)} onChange={e=>setDraft(e.target.value)} onBlur={commit} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();if(e.key==='Escape')setDraft(null)}}/>;
}
function colorAlpha(hex:string,a:number){const h=hex.replace('#','');return `rgba(${parseInt(h.slice(0,2),16)},${parseInt(h.slice(2,4),16)},${parseInt(h.slice(4,6),16)},${a})`}
