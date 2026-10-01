import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {runCommand} from '../jobs/command';
import {privateDirectory} from '../visual/app-budget';
export type DecodedFrame={file:string;sha256:string;bytes:number;mimeType:'image/jpeg';width:number;height:number;requestedTimestampSeconds:number;decodedTimestampSeconds:number|null;sourcePtsSeconds:number|null;precision:'decoded-pts'|'unverified-requested-seek'};
/** PTS is reported only when showinfo and the container start offset are available.
 * Seek positions are never presented as exact decoded timestamps. */
export async function decodeFrames(source:string,times:number[],directory:string,maxBytes:number,signal?:AbortSignal):Promise<DecodedFrame[]> {
 await privateDirectory(directory);
 const {stdout}=await runCommand('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-select_streams','v:0','-show_entries','format=duration,start_time:stream=width,height','-of','json',source],{timeoutMs:10000,signal});
 const meta=JSON.parse(stdout);const duration=Number(meta.format?.duration),start=Number(meta.format?.start_time);
 if(!meta.streams?.length||!Number.isFinite(duration)||duration<=0)throw Error('No decodable video stream');
 if(times.some(t=>t>=duration))throw Error('Timestamp outside recording duration');
 const frames:DecodedFrame[]=[];let total=0;
 for(const [i,time] of times.entries()) {
  signal?.throwIfAborted();const file=join(directory,`frame-${i}.jpg`);
  const {stderr}=await runCommand('ffmpeg',['-nostdin','-v','info','-protocol_whitelist','file,pipe','-threads','1','-copyts','-ss',String(time),'-i',source,'-map','0:v:0','-frames:v','1','-vf',"scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease,showinfo",'-fps_mode','passthrough','-q:v','3','-y',file],{timeoutMs:30000,signal});
  const st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.size<=0||st.size>maxBytes-total)throw Error('Frame byte budget exceeded');
  await fs.chmod(file,0o600);const pixels=await fs.readFile(file);total+=pixels.length;
  if(pixels[0]!==0xff||pixels[1]!==0xd8)throw Error('Invalid decoded JPEG');
  const ptsMatch=stderr.match(/\[Parsed_showinfo_[^\]]*\].*?\bn:\s*0\s+pts:\s*[-\d]+\s+pts_time:([-\d.e+]+).*?\bs:(\d+)x(\d+)/);
  const pts=ptsMatch?Number(ptsMatch[1]):NaN;const normalized=pts-start;
  const verified=Number.isFinite(pts)&&Number.isFinite(start)&&normalized>=0&&normalized<duration;
  const width=ptsMatch?Number(ptsMatch[2]):0,height=ptsMatch?Number(ptsMatch[3]):0;
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>1280||height>1280)throw Error('Decoded image dimensions unavailable');
  frames.push({file,sha256:createHash('sha256').update(pixels).digest('hex'),bytes:pixels.length,mimeType:'image/jpeg',width,height,requestedTimestampSeconds:time,decodedTimestampSeconds:verified?normalized:null,sourcePtsSeconds:Number.isFinite(pts)?pts:null,precision:verified?'decoded-pts':'unverified-requested-seek'});
 }
 return frames;
}
