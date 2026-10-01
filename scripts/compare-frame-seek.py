#!/usr/bin/env python3
"""Small, fixed synthetic comparison; no capture, providers or personal media."""
from pathlib import Path
import tempfile,subprocess,time,resource,re,hashlib,json,sys
output=Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory(prefix='falatrace-frame-seek-') as temporary:
 root=Path(temporary);source=root/'synthetic.mp4'
 subprocess.run(['/usr/bin/ffmpeg','-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=10','-t','20','-an','-c:v','mpeg4','-bf','2','-g','30','-threads','2',str(source)],check=True,capture_output=True,timeout=10)
 source_hash=hashlib.sha256(source.read_bytes()).hexdigest();rows=[]
 for label in ['legacy-output-seek','accurate-input-seek']:
  path=root/(label+'.jpg');common=['/usr/bin/ffmpeg','-nostdin','-loglevel','debug']
  seek=['-i',str(source),'-ss','17.35'] if label.startswith('legacy') else ['-ss','17.35','-accurate_seek','-i',str(source)]
  before=resource.getrusage(resource.RUSAGE_CHILDREN);start=time.monotonic()
  r=subprocess.run(common+seek+['-frames:v','1','-vf',"scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease",'-q:v','3','-y',str(path)],check=True,capture_output=True,text=True,timeout=10)
  elapsed=time.monotonic()-start;after=resource.getrusage(resource.RUSAGE_CHILDREN)
  counts=re.findall(r'(\d+) frames decoded',r.stderr)
  rows.append({'variant':label,'wallSeconds':round(elapsed,6),'childCpuSeconds':round(after.ru_utime+after.ru_stime-before.ru_utime-before.ru_stime,6),'decodedFrameCounts':[int(n) for n in counts],'jpegSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'jpegBytes':path.stat().st_size})
 assert rows[0]['jpegSha256']==rows[1]['jpegSha256']
 assert hashlib.sha256(source.read_bytes()).hexdigest()==source_hash
 data={'fixture':{'synthetic':True,'codec':'mpeg4','container':'mp4','durationSeconds':20,'size':'160x90','fps':10,'bFrames':2,'gop':30,'timestampRequested':17.35,'sourceSha256':source_hash},'runs':rows,'identicalJpeg':True,'originalUnchanged':True,'limits':['One pair, not statistical latency or real-call improvement','No audio, display/mic capture, private media or provider','Frame metadata stores requested time; nearest decoded frame bounded by source frame rate, not certified physical seek','Generation decoder/encoder uses two threads only for the fixture; no runtime capture settings changed']}
 output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(data,indent=2)+'\n');print(json.dumps(data,indent=2))
