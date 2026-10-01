#!/usr/bin/env python3
"""Invoke Bun QA only after validating all temporary data paths; use python -I."""
import os,sys,stat,re,pathlib

def require_isolated(env):
 root=env.get('FALATRACE_QA_ROOT','');nonce=env.get('FALATRACE_QA_NONCE','')
 if env.get('FALATRACE_QA_ISOLATED')!='1' or not pathlib.Path(root).is_absolute() or pathlib.Path(root).parent!=pathlib.Path('/tmp') or not re.fullmatch('[a-f0-9]{32,64}',nonce):raise ValueError('marked temporary HOME/XDG required')
 values=[env.get(key,'') for key in ['HOME','XDG_CONFIG_HOME','XDG_STATE_HOME','XDG_DATA_HOME','XDG_RUNTIME_DIR','XDG_CACHE_HOME','TMPDIR']]
 # Reject lexical inherited paths BEFORE stat/resolve/Bun startup can access them.
 if any(not value or not pathlib.Path(value).is_absolute() or not str(pathlib.Path(os.path.normpath(value))).startswith(root+'/') for value in values):raise ValueError('inherited or missing HOME/XDG')
 path=pathlib.Path(root);s=path.lstat()
 if not stat.S_ISDIR(s.st_mode) or path.is_symlink() or s.st_uid!=os.getuid() or stat.S_IMODE(s.st_mode)&0o077 or str(path.resolve())!=root:raise ValueError('unsafe QA root')
 marker=path/'.falatrace-qa';s=marker.lstat()
 if not stat.S_ISREG(s.st_mode) or marker.is_symlink() or s.st_uid!=os.getuid() or stat.S_IMODE(s.st_mode)&0o077 or s.st_size>128 or marker.read_text()!=nonce:raise ValueError('invalid QA marker')
 for value in values:
  p=pathlib.Path(value);s=p.lstat()
  if not stat.S_ISDIR(s.st_mode) or p.is_symlink() or s.st_uid!=os.getuid() or not str(p.resolve()).startswith(root+'/'):raise ValueError('unsafe QA data directory')
 return True

if __name__=='__main__':
 try:
  require_isolated(os.environ)
  if len(sys.argv)<2 or pathlib.Path(sys.argv[1]).name!='bun' or not pathlib.Path(sys.argv[1]).is_absolute():raise ValueError('explicit existing Bun executable required')
  os.execve(sys.argv[1],sys.argv[1:],dict(os.environ))
 except (ValueError,OSError) as error:
  print('QA refused before Bun/product imports: '+str(error),file=sys.stderr);sys.exit(97)
