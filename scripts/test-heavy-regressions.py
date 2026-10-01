#!/usr/bin/env python3
"""Bounded offline regression subset; synthetic HOME/XDG, no capture/services/providers."""
import tempfile,subprocess,pathlib,shutil,sys,secrets
source=pathlib.Path(__file__).resolve().parents[1]
bun=shutil.which('bun') or str(pathlib.Path.home()/'.bun/bin/bun')
with tempfile.TemporaryDirectory(dir='/tmp',prefix='falatrace-admission-regression-') as temporary:
 root=pathlib.Path(temporary);nonce=secrets.token_hex(16);(root/'.falatrace-qa').write_text(nonce);(root/'.falatrace-qa').chmod(0o600)
 for key in ['home','state','config','data','runtime','cache','tmp','bin']:(root/key).mkdir(mode=0o700)
 for name in ['ssh','sshfs','systemctl','systemd-run','gdbus','pactl','pw-dump','obs','notify-send','flatpak','gpu-screen-recorder','wf-recorder','aws','rclone']:
  path=root/'bin'/name;path.write_text('#!/bin/sh\nexit 97\n');path.chmod(0o755)
 env={'FALATRACE_QA_ISOLATED':'1','FALATRACE_QA_ROOT':str(root),'FALATRACE_QA_NONCE':nonce,'HOME':str(root/'home'),'XDG_STATE_HOME':str(root/'state'),'XDG_CONFIG_HOME':str(root/'config'),'XDG_DATA_HOME':str(root/'data'),'XDG_RUNTIME_DIR':str(root/'runtime'),'XDG_CACHE_HOME':str(root/'cache'),'TMPDIR':str(root/'tmp'),'PATH':str(root/'bin')+':/usr/bin:/bin','FALATRACE_HEAVY_PAUSE':'off'}
 files=['src/visual/__tests__/authoritative-policy.test.ts','src/visual/__tests__/planner-cache.test.ts','src/jobs/__tests__/visual-pipeline.test.ts','src/runtime/__tests__/qa-isolation.test.ts','src/visual/__tests__/scope.test.ts','src/visual/__tests__/planner.test.ts','src/diarization/__tests__/service.test.ts','src/recording/__tests__/profile.test.ts','src/visual/__tests__/admission-order.test.ts','src/visual/__tests__/visual.test.ts','src/visual/__tests__/session.test.ts','src/visual/__tests__/manual-session.test.ts','src/jobs/__tests__/admission-worker.test.ts','src/visual/__tests__/seek.test.ts','src/runtime/__tests__/heavy-admission.test.ts','src/visual/__tests__/studio-flow.test.ts','src/jobs/__tests__/sync-selected.test.ts','src/jobs/__tests__/queue.test.ts','src/jobs/__tests__/review-regressions.test.ts','src/desktop/bridge.test.ts']
 result=subprocess.run(['/usr/bin/python3','-I',str(source/'scripts/qa-run.py'),str(pathlib.Path(bun).resolve()),'test','--preload',str(source/'scripts/offline-network.ts'),*files,*sys.argv[1:]],cwd=source,env=env,timeout=65)
 sys.exit(result.returncode)
