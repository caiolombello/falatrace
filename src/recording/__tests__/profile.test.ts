import {test,expect} from 'bun:test';
import {DEFAULT_CONFIG} from '../../config/defaults';
import {buildCaptureCommand} from '../capture';
import {assertCaptureProfile,verifyCallLightSupport,supportsCallLightHelp} from '../profile';
const help='usage: gpu-screen-recorder -s WxH -f fps -q quality -encoder gpu -fallback-cpu-encoding no';
test('standard capture remains identical; call-light explicitly limits video and preserves audio and GPU fallback refusal',()=>{
 const config=structuredClone(DEFAULT_CONFIG.capture),sources={microphone:'synthetic-mic',desktop:'synthetic-desktop'};
 const standard=buildCaptureCommand('gpu-screen-recorder',config,sources,'/tmp/synthetic.mkv','/tmp/token');
 expect(buildCaptureCommand('gpu-screen-recorder',{...config,profile:'standard'},sources,'/tmp/synthetic.mkv','/tmp/token')).toEqual(standard);
 const light=buildCaptureCommand('gpu-screen-recorder',{...config,profile:'call-light'},sources,'/tmp/synthetic.mkv','/tmp/token');
 expect(light.args.join(' ')).toContain('-f 15');expect(light.args.join(' ')).toContain('-s 1280x720');expect(light.args.join(' ')).toContain('-q high');expect(light.args.join(' ')).toContain('-encoder gpu -fallback-cpu-encoding no');
 const audio=(args:string[])=>args.flatMap((x,i)=>x==='-a'?[args[i+1]]:[]);expect(audio(light.args)).toEqual(audio(standard.args));expect(audio(light.args)).toHaveLength(3);
 expect(buildCaptureCommand('gpu-screen-recorder',{...config,framerate:10,profile:'call-light'},sources,'/tmp/synthetic.mkv','/tmp/token').args.join(' ')).toContain('-f 10');
 expect(()=>assertCaptureProfile('audio',{...config,profile:'call-light'})).toThrow('no automatic');expect(()=>assertCaptureProfile('gpu-screen-recorder',{...config,profile:'call-light',encoder:'cpu'})).toThrow('no automatic');
 expect(()=>assertCaptureProfile('gpu-screen-recorder',{...config,profile:'' as any})).toThrow('Unknown');
});
test('only complete encoder help accepts standard nonzero usage; timeout, cancellation and incomplete help fail closed',async()=>{
 expect(supportsCallLightHelp(help)).toBe(true);expect(supportsCallLightHelp('usage: -f fps')).toBe(false);
 const launcher={command:'synthetic-gsr',args:['synthetic-prefix']};
 const calls:string[][]=[];await verifyCallLightSupport(launcher,async(_,args)=>{calls.push(args);return {stdout:help,stderr:''};});expect(calls).toEqual([['synthetic-prefix','--help']]);
 await verifyCallLightSupport(launcher,async()=>{throw Error('synthetic-gsr failed with code 1: '+help);});
 for(const message of ['timed out after 5000ms: '+help,'cancelled: '+help,'failed with code 2: '+help,'failed with code 1: usage: -f fps'])await expect(verifyCallLightSupport(launcher,async()=>{throw Error(message);})).rejects.toThrow('capture was not started');
});
