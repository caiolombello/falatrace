/** Must preload before any production module in QA. Refuse inherited user paths before filesystem access. */
import {lstatSync,realpathSync,readFileSync} from 'node:fs';
import {isAbsolute,resolve,dirname,join} from 'node:path';
const keys=['HOME','XDG_CONFIG_HOME','XDG_STATE_HOME','XDG_DATA_HOME','XDG_RUNTIME_DIR','XDG_CACHE_HOME','TMPDIR'] as const;
export function assertQaIsolation(env:NodeJS.ProcessEnv=process.env){
 const root=env.FALATRACE_QA_ROOT,nonce=env.FALATRACE_QA_NONCE;
 if(env.FALATRACE_QA_ISOLATED!=='1'||!root||!isAbsolute(root)||dirname(root)!=='/tmp'||!nonce||!/^[a-f0-9]{32,64}$/.test(nonce))throw Error('QA refused: a marked temporary HOME/XDG root is required before product imports');
 for(const key of keys){const value=env[key];if(!value||!isAbsolute(value)||resolve(value)===root||!resolve(value).startsWith(root+'/'))throw Error('QA refused: inherited or missing HOME/XDG');}
 const stat=lstatSync(root);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||realpathSync(root)!==root)throw Error('QA refused: unsafe temporary root');
 const marker=join(root,'.falatrace-qa');const ms=lstatSync(marker);if(!ms.isFile()||ms.isSymbolicLink()||ms.size>128||ms.uid!==stat.uid||(ms.mode&0o077)!==0||readFileSync(marker,'utf8')!==nonce)throw Error('QA refused: invalid temporary marker');
 for(const key of keys){const value=env[key]!;const s=lstatSync(value);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==stat.uid||!realpathSync(value).startsWith(root+'/'))throw Error('QA refused: unsafe HOME/XDG directory');}
 return {isolated:true,scope:'temporary-home-xdg'};
}
assertQaIsolation();
