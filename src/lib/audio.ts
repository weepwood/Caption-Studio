export const WHISPER_SAMPLE_RATE = 16000;
export interface DecodedAudio { pcm: Float32Array; peaks: number[]; seconds: number }
/** Browser codec support varies by file and platform; this is not FFmpeg extraction. */
export async function decodeAudio(file: File): Promise<DecodedAudio> {
  const bytes = await file.arrayBuffer();
  const ctx = new AudioContext({sampleRate: WHISPER_SAMPLE_RATE});
  try {
    const decoded = await ctx.decodeAudioData(bytes);
    const samples = new Float32Array(decoded.length);
    for(let ch=0;ch<decoded.numberOfChannels;ch++) {
      const track=decoded.getChannelData(ch);
      const weight=1/decoded.numberOfChannels;
      for(let i=0;i<samples.length;i++)samples[i]+=track[i]*weight;
    }
    return {pcm:samples,peaks:makePeaks(samples),seconds:decoded.duration};
  } catch {
    throw new Error('浏览器无法解码该媒体音轨。请尝试 WAV / MP3 / WebM，或将视频音频转换为 WAV 后重试。');
  } finally {
    void ctx.close();
  }
}
/** Coarsened peaks only, to avoid retaining raw PCM in React state. */
export function makePeaks(pcm:Float32Array,count=2200):number[]{
  if(pcm.length===0)return [];
  const size=Math.max(1,Math.ceil(pcm.length/count));
  const peaks:number[]=[];
  for(let i=0;i<pcm.length;i+=size){
    let max=0;
    for(let j=i;j<Math.min(i+size,pcm.length);j++)max=Math.max(max,Math.abs(pcm[j]));
    peaks.push(Math.min(1,max));
  }
  return peaks;
}
