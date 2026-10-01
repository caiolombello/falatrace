import type { AppConfig } from '../config/defaults';
import type { CaptureBackend, CaptureCommand } from './capture';
import { runCommand } from '../jobs/command';
export type CaptureProfile = 'standard'|'call-light';
export const CALL_LIGHT_PROFILE={maxFps:15,maxResolution:'1280x720',quality:'high',encoder:'gpu',cpuFallback:false} as const;
export function assertCaptureProfile(backend:CaptureBackend|'obs',config:AppConfig['capture']) {
 const profile=config.profile??'standard';
 if(!['standard','call-light'].includes(profile))throw Error('Unknown capture profile; standard must be chosen explicitly');
 if(profile==='call-light'&&(backend!=='gpu-screen-recorder'||config.encoder!=='gpu'))throw Error('call-light requires GPU Screen Recorder with encoder=gpu; no automatic backend/CPU fallback');
 return profile as CaptureProfile;
}
export function supportsCallLightHelp(help:string):boolean {
 return /usage:/i.test(help)&&['-s ','-f ','-q ','-encoder ','-fallback-cpu-encoding '].every(flag=>help.includes(flag));
}
/** Help only. Some GSR versions exit 1 for --help; accept that only with a complete usage response. */
export async function verifyCallLightSupport(launcher:CaptureCommand,run=runCommand):Promise<void> {
 let help='';
 try{const result=await run(launcher.command,[...launcher.args,'--help'],{timeoutMs:5000});help=result.stdout+'\n'+result.stderr;}
 catch(error){const message=error instanceof Error?error.message:'';if(/failed with code 1:/.test(message))help=message;}
 if(!supportsCallLightHelp(help))throw Error('call-light options could not be verified; capture was not started. Choose standard explicitly or validate this encoder version');
}
export const captureProfileNotice=(config:AppConfig['capture'])=>config.profile==='call-light'
 ? `call-light solicitado: vídeo até ${Math.min(config.framerate,15)} FPS, 1280×720, qualidade high. Menor qualidade visual explícita; áudio preservado; sem fallback CPU. Benefício em chamada não validado.`
 : 'Perfil standard: parâmetros configurados preservados.';
