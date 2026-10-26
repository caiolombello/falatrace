#!/usr/bin/env python3
"""Render the actual Studio settings dialog and first-use assistant with a synthetic bridge.

Offline, disposable HOME. No device, service, provider or configuration file outside the
fixture is touched. Each mode patches Main.qml with timed actions and assertions, runs the
Studio shell (native or the PySide6 runner) against a stub bridge and records the
requests the UI sent. Exit 77 means no Studio runtime is available.
"""
from pathlib import Path
import hashlib, json, secrets, subprocess, sys, tempfile, runpy

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / 'scripts'))
from studio_fixture import copy_qml_siblings, qml_sources_digest, qml_steps, require_assertion_lines, require_studio_command, runner_kind
command = require_studio_command()
out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(tempfile.mkdtemp(dir='/tmp', prefix='falatrace-settings-ux-'))
out.mkdir(parents=True, exist_ok=True)
source = (repo / 'src/desktop/Main.qml').read_text()

STUB = r'''#!/usr/bin/python3
import sys, json, os, hashlib
mode = os.environ['FALATRACE_TEST_MODE']; receipt = os.environ['FALATRACE_RECEIPT']
apps = [{'id':'slack','label':'Slack','kind':'app','defaultEnabled':True},{'id':'zen','label':'Zen','kind':'browser','defaultEnabled':True},
        {'id':'helium','label':'Helium','kind':'browser','defaultEnabled':True},{'id':'chromium','label':'Chromium','kind':'browser','defaultEnabled':True},
        {'id':'firefox','label':'Firefox','kind':'browser','defaultEnabled':True},{'id':'zoom','label':'Zoom','kind':'app','defaultEnabled':True},
        {'id':'discord','label':'Discord','kind':'app','defaultEnabled':False}]
first = mode in ('first-run', 'wizard-flow', 'wizard-test-audio', 'wizard-english', 'wizard-key-cancel', 'wizard-key-finish', 'wizard-download-cancel', 'wizard-reload', 'wizard-recommended-review',
                 'wizard-download-double', 'wizard-use-installed', 'wizard-record-test', 'wizard-download-all', 'wizard-finish-after-download')
values = {'callDetection.enabled': not first, 'callDetection.mode':'record', 'callDetection.enqueueOnStop':True, 'callDetection.dryRun':False,
          'callDetection.entryDebounceSeconds':5, 'callDetection.exitTimeoutSeconds':15, 'callDetection.networkSampleSeconds':5,
          'callDetection.apps.slack':True,'callDetection.apps.zen':True,'callDetection.apps.helium':True,'callDetection.apps.chromium':True,
          'callDetection.apps.firefox':True,'callDetection.apps.zoom':True,'callDetection.apps.discord':False,
          'backend': 'simple' if first or mode == 'legacy' else 'gpu-screen-recorder','recordingsDir':'/home/synthetic/Videos/Recordings','capture.audioSource':'both',
          'capture.microphone':'default','capture.desktop':'default','capture.profile':'standard','capture.encoder':'gpu','capture.framerate':30,
          'capture.startupTimeoutSeconds':90,'features.namingTemplate':'YYYY-MM-DD_HH-mm_[title]',
          'obs.enabled':False,'obs.autoLaunch':False,'obs.host':'127.0.0.1','obs.port':4455,
          'transcription.provider':'whisper-cpp' if first else 'gemini' if mode == 'wizard-gemini-key' else 'openai','transcription.language':'auto','transcription.expectedLanguages':[],'transcription.openaiPrompt':'Termos: FalaTrace' if mode == 'tab-processing' else '',
          'transcription.openaiModel':'gpt-transcribe','transcription.geminiModel':'gemini-3.5-transcribe','transcription.whisperCpp.command':'whisper-cli',
          'transcription.whisperCpp.modelPath':'/home/synthetic/model.bin','transcription.whisperCpp.threads':8,
          'summary.provider':'ollama' if first else 'openai','summary.ollamaUrl':'http://127.0.0.1:11434','summary.ollamaModel':'qwen3.5:9b','summary.openaiModel':'gpt-6-luna',
          'summary.maxInputCharacters':24000,'processing.defaultTarget':'remote' if mode == 'wizard-automation-review' else 'local','processing.autoEnqueue':not first,'processing.syncIntervalMinutes':5,
          'processing.notifyOnCompletion':True,'remote.host':'worker.lan' if mode == 'integrations' else 'worker.example.invalid','remote.user':'synthetic','remote.port':22,
          'remote.identityFile':None,'remote.archiveDir':'~/Videos/RecordingArchive','archive.enabled':False,'archive.vaio':True,'archive.proton':True,
          'archive.syncIntervalMinutes':5,'proton.enabled':False,'proton.targetFolder':'/my-files/RecordingArchive','proton.policy':'artifacts',
          's3.enabled':False,'s3.bucket':'','s3.region':'us-east-1','s3.prefix':'recordings/','s3.profile':None,
          'timesheet.enabled':False,'timesheet.automaticFromCalls':False,'timesheet.aiClassification':False,'timesheet.aiModel':'gpt-6-luna',
          'timesheet.readyConfidence':0.8,'timesheet.contextPath':'/home/synthetic/timesheet-context.json','aiContext.enabled':False,'aiContext.autoBuild':True,
          'aiContext.maxMeetingsPerClient':12,'aiContext.maxCharactersPerClient':18000,'calendar.enabled':False,
          'gnome.framerate':30,'gnome.drawCursor':True,'gnome.audioSource':'both','visualReview.maxInferences':24,'visualReview.maxPreviews':16,
          'studio.language':'en' if mode in ('english', 'wizard-english') else 'auto',
          'retention.localCompletedWorkDays':7,'retention.remoteIncomingDays':2,'retention.remoteResultsDays':30,'retention.remoteFailuresDays':30,
          # Sections 10–15 (notes, assistant, reminders, live, sharing, privacy).
          'notes.enabled':True,'summary.useNotes':True,'summary.language':'auto','summary.template':'auto','summary.templateDetection':'ai','processing.fastPath':False,
          'assistant.provider':'acp','assistant.localModel':'qwen3.5:9b','assistant.apiPreset':'openrouter','assistant.apiBaseUrl':'','assistant.apiModel':'','assistant.acpAgent':'codex',
          'assistant.acpCommand':'','assistant.cliTool':'claude','assistant.cliModel':'','assistant.chatgptModel':'','assistant.maxContextCharacters':60000,'assistant.embeddingModel':'',
          'reminders.mode':'auto','reminders.leadMinutes':2,'reminders.brief':True,'live.enabled':False,'live.provider':'whisper-cpp','live.chunkSeconds':15,
          'live.whisperModelPath':'/home/synthetic/models/ggml-base.bin','live.whisperThreads':2,'live.openaiModel':'gpt-transcribe','live.groqModel':'whisper-large-v3-turbo',
          'media.retention':'keep','media.graceDays':1,'destinations.obsidianVault':'','destinations.obsidianFolder':'FalaTrace','destinations.notionParentId':'','destinations.aiApp':'chatgpt-web',
          'google.clientId':'','google.calendar':True}
# The meeting features only some modes advertise (ux-capabilities); the others see the bridge of before.
FEATURES = {'notes-section', 'assistant-section', 'template-editor-light', 'recipe-editor-compact'}
templates = [{'id':'standup','name':'Daily','description':'Short daily check-in.','builtIn':True,'version':1,'sectionTitles':['Ontem','Hoje','Bloqueios'],
              'template':{'id':'standup','version':1,'builtIn':True,'name':{'pt-BR':'Daily','en':'Stand-up','es':'Daily'},'description':'Short daily check-in.','titleKeywords':['daily'],'transcriptKeywords':[],
                          'sections':[{'id':'yesterday','title':{'pt-BR':'Ontem','en':'Yesterday','es':'Ayer'},'instruction':'What each person did.'},
                                      {'id':'today','title':{'pt-BR':'Hoje','en':'Today','es':'Hoy'},'instruction':'What each person will do.'},
                                      {'id':'blockers','title':{'pt-BR':'Bloqueios','en':'Blockers','es':'Bloqueos'},'instruction':'What is in the way.'}],'guidance':'Keep it short.'}}]
recipes = [{'id':'follow-up-email','name':'E-mail de follow-up','description':'Writes a follow-up email.','scope':'meeting','builtIn':True,'prompt':'Write a follow-up email for {{meeting.title}}.','version':1,
            'names':{'pt-BR':'E-mail de follow-up','en':'Follow-up email','es':'Correo de seguimiento'}}]
revision = 'a' * 64
# Assistant modes on an existing OpenAI setup that already has its key; wizard-key-required has none.
key_present = mode in ('wizard-disable-monitor', 'wizard-disable-unknown', 'wizard-download-finish', 'wizard-download-pending', 'wizard-gemini-key', 'wizard-lost', 'wizard-ffmpeg-review', 'wizard-automation-review',
                       'wizard-skip-services', 'wizard-monitor-stale', 'wizard-reread-fail', 'wizard-unknown-services', 'wizard-ollama-pending')
details = [{'name':'OPENAI_API_KEY','source':'secrets.env' if key_present else 'missing','sessionOnly':mode == 'keys','shadowsStudioKey':False,'savedInStudio':key_present},
           {'name':'GEMINI_API_KEY','source':'missing','sessionOnly':False,'shadowsStudioKey':False,'savedInStudio':False},
           {'name':'RECORDING_CLI_OBS_PASSWORD','source':'missing','sessionOnly':False,'shadowsStudioKey':False,'savedInStudio':False}]
def credentials(): return {'openai':details[0]['source'],'gemini':'missing','details':details,'files':[],'managerEnvironment':'unavailable' if mode == 'keys-manager-unknown' else 'read'}
def settings(): return {'revision':revision,'exists':not first,'values':values,'apps':apps,'nullable':['remote.user','remote.identityFile','s3.profile'],
    'emptyAllowed':['transcription.openaiPrompt','s3.bucket','s3.prefix'],
    'readOnly':{'backendOutsideList':'simple' if values['backend'] == 'simple' else None,'backendExplicit':not first,'obsEnabled':False,
                'remoteConfigured':mode == 'integrations','summaryLocal':True,'visualPolicyDeclared':False,'legacyApiKeyInConfig':False,'obsPasswordInConfig':False},
    'credentials':credentials()}
timer = {'installed':False,'enabled':False,'active':False,'outdated':False,'nextRunAt':None,'lastResult':None}
services = {'calls':{'installed':not first,'enabled':not first,'active':not first and mode != 'wizard-skip-services','outdated':False,'staleConfig':mode == 'services'},
            'tray':{'installed':True,'enabled':True,'active':True,'outdated':False,'staleConfig':False},'sync':dict(timer),'archive':dict(timer),'backup':dict(timer),
            'reminders':{'installed':False,'enabled':False,'active':False,'outdated':False,'staleConfig':False}}
catalog = {'whisper':{'directory':'/home/synthetic/models','source':'https://huggingface.co/','models':[
    {'id':'tiny','file':'ggml-tiny.bin','bytes':77691713,'sha256':'0'*64,'quality':'Muito rápido.','installed':False,'selected':False,'path':'/home/synthetic/models/ggml-tiny.bin'},
    {'id':'large-v3-turbo-q5_0','file':'ggml-large-v3-turbo-q5_0.bin','bytes':574041195,'sha256':'1'*64,'quality':'Padrão.','recommended':True,'installed':mode == 'wizard-use-installed','selected':False,'path':'/home/synthetic/models/ggml-large-v3-turbo-q5_0.bin'}]},
    'ollama':{'url':'http://127.0.0.1:11434','loopback':True,'reachable':True,'installed':['qwen3.5:9b'],'configured':'qwen3.5:9b'}}
log = []; cancelled = False
for line in sys.stdin:
    r = json.loads(line); op = r['op']; p = r.get('payload', {})
    logged = dict(p)
    # Keep only a digest of credential values in the receipt.
    if 'value' in logged: logged['value'] = 'sha256:' + hashlib.sha256(logged['value'].encode()).hexdigest()
    log.append({'op':op,'payload':logged}); open(receipt,'w').write(json.dumps(log))
    # The configuration cannot be read again after reconnecting.
    if op == 'settings-read' and mode == 'wizard-reread-fail' and any(q['op'] == 'settings-read' for q in log[:-1]):
        print(json.dumps({'id':r['id'],'ok':False,'error':'Não foi possível ler a configuração.'}), flush=True); continue
    if op == 'settings-read': v = settings()
    elif op == 'settings-diagnose':
        # Like the bridge, the checks follow the unsaved choices the assistant sends.
        summary = p.get('changes', {}).get('summary.provider', values['summary.provider'])
        transcription = p.get('changes', {}).get('transcription.provider', values['transcription.provider'])
        ffmpeg = {'id':'ffmpeg','label':'FFmpeg','status':'ok','detail':'Encontrado.'} if mode != 'wizard-ffmpeg-review' else \
                 {'id':'ffmpeg','label':'FFmpeg','status':'missing','detail':'Necessário para gravar só áudio e para extrair o áudio antes da transcrição. Instale pelo gerenciador de pacotes.'}
        v = {'checks':[ffmpeg,
                       *([{'id':'whisper-model','label':'Modelo do Whisper','status':'missing','detail':'Não encontrado.','action':'whisper-model'}] if transcription == 'whisper-cpp' else []),
                       {'id':'ollama','label':'Ollama','status':'warning','action':'ollama-model','detail':'Ollama respondeu, mas o modelo qwen3.5:9b não está instalado.'} if summary == 'ollama'
                       else {'id':'summary-key','label':'Resumo · OPENAI_API_KEY','status':'missing','detail':'Chave não encontrada.'}],
             'automation':[{'id':'automatic-backend','label':'Gravação automática','status':'missing','detail':'Usa o OBS desativado.','action':'capture'}] if mode == 'services' else
                          [{'id':'automatic-backend','label':'Gravação automática','status':'missing','action':'capture','detail':'O modo “Controlar o OBS” exige o OBS ativado em Integrações.'},
                           {'id':'remote-worker','label':'Worker remoto','status':'missing','action':'remote','detail':'O processamento está marcado como remoto, mas nenhum worker foi configurado. Configure-o em Integrações ou volte para “Neste computador”.'}] if mode == 'wizard-automation-review' else
                          [{'id':'automatic-backend','label':'Gravação automática','status':'warning','action':'calls-apply','detail':'O monitor de chamadas não está rodando: nada será gravado automaticamente. Aplique o monitor em Serviços.'},
                           {'id':'processing-timer','label':'Processamento automático','status':'warning','action':'sync-apply','detail':'Gravações novas entram na fila, mas ficam pendentes até você processá-las: ative o processamento em segundo plano em Serviços.'}] if mode == 'wizard-skip-services' else
                          [{'id':'automatic-backend','label':'Gravação automática','status':'skipped','detail':'Estado do monitor de chamadas indisponível; não dá para confirmar que as chamadas serão gravadas.'},
                           {'id':'processing-timer','label':'Processamento automático','status':'skipped','detail':'Estado do timer de processamento indisponível.'}] if mode == 'wizard-unknown-services' else [],
             'audio':{'devices':[{'name':'alsa_input.synthetic-mic','description':'Microfone sintético','monitor':False},
                                 {'name':'alsa_output.synthetic.monitor','description':'Monitor sintético','monitor':True}],
                      'defaultMicrophone':'alsa_input.synthetic-mic','defaultDesktop':'alsa_output.synthetic.monitor'},
             'services':None if mode in ('wizard-disable-unknown', 'services-unknown', 'wizard-unknown-services') else services,'recording':{'selectedBackend':'gpu-screen-recorder','blockedReason':None,'warnings':[],'session':None,'capabilities':{'gpuRecorder':True,'ffmpeg':True,'obsLauncher':False,'sessionType':'wayland'}},
             'automatic':None,'credentials':credentials()}
    elif op == 'settings-save':
        values.update(p['changes']); revision = 'b' * 64
        v = dict(settings(), saved=True, changed=list(p['changes']), backupCreated=not first, cleanupPending=False, needsReload=False, prunedBackups=0)
        # Published, but the reread failed: no values come back.
        if mode == 'wizard-reload': v = {'saved':True, 'changed':list(p['changes']), 'backupCreated':False, 'cleanupPending':False, 'needsReload':True, 'prunedBackups':0}
    elif op == 'settings-service':
        services['calls']['staleConfig'] = False
        if p['action'] == 'sync-apply': services['sync'].update({'installed':True,'enabled':True,'active':True,'nextRunAt':'2026-10-05T12:00:00.000Z'})
        if p['action'] == 'reminders-apply': services['reminders'].update({'installed':True,'enabled':True,'active':True})
        v = {'action':p['action'],'services':services}
    elif op == 'settings-secret-set' and mode == 'keys-lost': continue
    elif op == 'settings-secret-test' and mode == 'keys-test-lost': continue
    elif op == 'settings-save' and mode == 'wizard-lost': continue
    elif op == 'settings-restore' and mode == 'restore-pending': continue
    elif op == 'settings-secret-set' and mode == 'wizard-key-fail':
        print(json.dumps({'id':r['id'],'ok':False,'error':'secrets.env tem permissões amplas demais.'}), flush=True); continue
    elif op == 'settings-secret-set':
        details[0].update({'source':'secrets.env','savedInStudio':True,'sessionOnly':False}); v = {'name':p['name'],'saved':True,'credentials':credentials()}
        # Saved, but the status could not be read again.
        if mode == 'keys-refresh': v = {'name':p['name'],'saved':True,'needsReload':True}
    elif op == 'settings-secret-remove':
        details[0].update({'source':'missing','savedInStudio':False}); v = {'name':p['name'],'removed':True,'credentials':credentials()}
    elif op == 'settings-secret-test': v = {'provider':p['service'],'status':'ok','source':'secrets.env','detail':'Chave aceita pelo provedor. O teste não envia áudio nem texto.'}
    # Like the bridge, the Ollama listed is the one at the address the request names.
    elif op == 'settings-model-catalog': v = dict(catalog, ollama=dict(catalog['ollama'], url=p.get('ollamaUrl', catalog['ollama']['url'])))
    elif op in ('settings-model-download', 'settings-model-status'):
        v = {'kind':p['kind'],'id':p['model'],'state':'running','receivedBytes':1048576,'totalBytes':77691713}
        if cancelled: v.update({'state':'failed','error':'O download foi interrompido. Tente novamente.'})
        # Both downloads finish on their first status poll; Finish then runs by itself.
        if mode == 'wizard-finish-after-download' and op == 'settings-model-status':
            v.update({'state':'completed','receivedBytes':77691713})
            if p['kind'] == 'whisper': v['path'] = '/home/synthetic/models/ggml-large-v3-turbo-q5_0.bin'
        # The model finishes downloading while transcription still goes to OpenAI.
        if mode == 'models-cloud' and op == 'settings-model-status':
            v.update({'state':'completed','receivedBytes':77691713,'path':'/home/synthetic/models/ggml-tiny.bin'}); catalog['whisper']['models'][0]['installed'] = True
    elif op == 'settings-model-cancel': cancelled = True; v = {'kind':p['kind'],'id':p['model'],'cancelled':True}
    elif op == 'settings-backups': v = {'backups':[{'name':'config.json.bak-0b8c3a0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e','modifiedAt':'2026-10-04T10:00:00.000Z','bytes':2048,'valid':True}]}
    elif op == 'settings-restore':
        v = {'restored':p['backup'],'backupCreated':True,'prunedBackups':0,'settings':settings()}
        if mode == 'restore-reload': v = {'restored':p['backup'],'backupCreated':True,'prunedBackups':0,'needsReload':True}
    elif op == 'settings-remote-check': v = {'ok':True,'host':'worker','commands':[{'name':'ffmpeg','ok':True},{'name':'whisper-cli','ok':False}],'disk':'/dev/sda1 100G 10G 90G 10% /home'}
    elif op == 'settings-obs-check': v = {'ok':False,'detail':'O OBS não respondeu.'}
    elif op == 'settings-audio-test': v = {'seconds':5,'tracks':[{'label':'Microfone','hasSignal':True,'peakDb':-12}],'warnings':[]}
    elif op == 'capture-status': v = {'active':False,'paused':False,'audio':{'configured':False}}
    # The library list sent at startup is still pending when the save commits.
    elif op == 'list' and mode == 'save-list-pending' and [q['op'] for q in log].count('list') == 1: continue
    elif op in ('list','list-cached','jobs-list'): v = {'items':[]}
    elif op == 'ux-capabilities':
        v = {'mockFrames':False,'realFrames':False}
        if mode in FEATURES: v.update({'features':{name: True for name in ('notes','live','assistant','recipes','share','actions','people','clients','upcoming','openInbox','mediaRemoval','templates','librarySearch')},'firstRun':{}})
    elif op == 'settings-google-status': v = {'connected':True,'email':'dono@example.com','clientConfigured':True,'flow':'idle'}
    elif op == 'templates-list' and mode in FEATURES: v = {'templates':templates,'default':'auto','problems':[]}
    elif op == 'templates-save' and mode in FEATURES:
        t = p['template']; saved = dict(t, version=1)
        templates.append({'id':t['id'],'name':t['name']['pt-BR'],'description':t['description'],'builtIn':False,'version':1,'sectionTitles':[s['title']['pt-BR'] for s in t['sections']],'template':saved})
        v = {'template':templates[-1]}
    elif op == 'recipes-list' and mode in FEATURES: v = {'recipes':recipes,'problems':[]}
    elif op == 'recipes-save' and mode in FEATURES:
        rc = p['recipe']; recipes.append(dict(rc, name=rc['name']['pt-BR'], names=rc['name'], version=1)); v = {'recipe':recipes[-1]}
    elif op == 'assistant-detect' and mode in FEATURES:
        v = {'acp':[{'agent':'claude','found':False},{'agent':'codex','found':True}],'cli':[{'tool':'claude','found':True,'signedIn':True},{'tool':'codex','found':False,'signedIn':False}],
             'chatgpt':{'signedIn':True,'email':'dono@example.com'}}
    else:
        print(json.dumps({'id':r['id'],'ok':False,'error':'Operação recusada no fixture.'}), flush=True); continue
    print(json.dumps({'id':r['id'],'ok':True,'result':v}), flush=True)
'''

# mode: (action at 600 ms, assertions at 1500 ms, follow-up at 2300 ms, final at 3100 ms); each step waits until the
# settings requests sent before it were answered (bounded), never a fixed delay.
MODES = {
    'first-run': ('', 'check("first use opens the assistant, not settings", setupWizard.visible && !settingsDialog.visible && setupWizard.step===0); check("continuing needs the consent acknowledgment", !wizardConsentGate()); check("assistant read the configuration", !!setupWizard.data.revision); '
                  'check("the welcome says the audio test and the downloads run before Finish, from their own buttons", findObject(setupWizard.contentItem, "wizardNothingYet").text.indexOf("downloads só acontecem nos próprios botões")>=0)', '', ''),
    'wizard-flow': ('setupWizard.consentAck=true', 'setupWizard.recommend(); check("recommended defaults go to review", setupWizard.step===4 && setupWizard.value("backend")==="audio" && setupWizard.preset()==="local" && setupWizard.value("callDetection.enabled")===false); setupWizard.finish()',
                    'check("assistant finished and reports the save", setupWizard.step===5 && setupWizard.results.length===1 && setupWizard.results[0].ok)', ''),
    'wizard-key-cancel': ('setupWizard.consentAck=true',
                          'setupWizard.step=2; setupWizard.applyPreset("cloud"); setupWizard.useKey("sk-synthetic-wizard-key"); check("a typed key waits for Finish", setupWizard.pendingKey!=="" && setupWizard.keyReady() && !setupWizard.hasPending("settings-secret-set"))',
                          'setupWizard.close(); check("closing the assistant forgets the key", !setupWizard.visible && setupWizard.pendingKey==="")', ''),
    'wizard-key-finish': ('setupWizard.consentAck=true',
                          'setupWizard.applyPreset("cloud"); setupWizard.useKey("sk-synthetic-wizard-key"); setupWizard.step=4; check("review lists the key before anything is saved", setupWizard.pendingKey!=="" && !setupWizard.hasPending("settings-secret-set")); setupWizard.finish()',
                          'check("Finish saves the configuration, then the key", setupWizard.step===5 && setupWizard.results.length===2 && setupWizard.results[1].ok && setupWizard.pendingKey==="")', ''),
    'wizard-download-cancel': ('setupWizard.consentAck=true',
                               'setupWizard.step=2; setupWizard.request("settings-model-download",{kind:"whisper",model:"large-v3-turbo-q5_0",consent:true})',
                               'check("a running download can be cancelled from the assistant", !!setupWizard.downloadState("whisper","large-v3-turbo-q5_0") && setupWizard.downloadState("whisper","large-v3-turbo-q5_0").state==="running"); setupWizard.cancelDownload("whisper","large-v3-turbo-q5_0")',
                               'check("the cancelled download shows its stopped state without an error", setupWizard.error==="" && setupWizard.downloadState("whisper","large-v3-turbo-q5_0").state==="failed")'),
    'wizard-disable-monitor': ('setupWizard.open(); setupWizard.consentAck=true; setupWizard.applyTimer=false',
                               'setupWizard.set("callDetection.enabled", false); setupWizard.step=4; setupWizard.finish()',
                               'check("turning detection off in the assistant stops the installed monitor", setupWizard.step===5 && setupWizard.results.some(function(r){return r.label==="Monitor de chamadas" && r.ok}))', ''),
    'wizard-draft-ollama': ('setupWizard.open(); setupWizard.consentAck=true; setupWizard.step=2',
                            'check("the saved OpenAI configuration has no Ollama check", !setupWizard.check("ollama") && !setupWizard.offersOllamaDownload()); setupWizard.applyPreset("local")',
                            'check("picking the local preset diagnoses the draft and offers the missing Ollama model", setupWizard.check("ollama").status==="warning" && setupWizard.offersOllamaDownload())', ''),
    'wizard-disable-unknown': ('setupWizard.open(); setupWizard.consentAck=true; setupWizard.applyTimer=false',
                               'check("the service status could not be read", !!setupWizard.diag.checks && !setupWizard.diag.services); setupWizard.set("callDetection.enabled", false); setupWizard.step=4; setupWizard.finish()',
                               'check("turning detection off stops the monitor even when its state is unknown", setupWizard.step===5 && setupWizard.results.some(function(r){return r.label==="Monitor de chamadas" && r.ok}))', ''),
    'wizard-reload': ('setupWizard.consentAck=true',
                      'setupWizard.recommend(); setupWizard.set("callDetection.enabled", true); setupWizard.set("callDetection.mode", "notify-only"); setupWizard.finish()',
                      'check("a save without values still applies the reviewed services", setupWizard.step===5 && setupWizard.results.some(function(r){return r.label==="Monitor de chamadas" && r.ok}))', ''),
    'wizard-test-audio': ('setupWizard.consentAck=true; setupWizard.step=1; setupWizard.set("capture.microphone","alsa_input.synthetic-mic")', 'setupWizard.request("settings-audio-test",{seconds:5,audioSource:setupWizard.value("capture.audioSource"),microphone:setupWizard.value("capture.microphone"),desktop:setupWizard.value("capture.desktop")})',
                          'check("audio test result is shown", !!setupWizard.audioTest && setupWizard.audioTest.tracks.length===1)', ''),
    'tab-calls': ('settingsDialog.open()', 'check("settings loaded", !!settingsData.revision && !settingsHasChanges()); check("sixteen sections", settingsDialog.sections.length===16); check("automatic backend status follows the draft", settingsDialog.automaticBackendText().indexOf("tela e áudio")>=0)', '', ''),
    'tab-capture': ('settingsDialog.open(); settingsTabs.currentIndex=1', 'check("devices listed from diagnose", settingsDeviceOptions(false).some(function(o){return o.value==="alsa_input.synthetic-mic"}) && settingsDeviceOptions(true).length===2)', '', ''),
    'legacy': ('settingsDialog.open(); settingsTabs.currentIndex=0', 'check("legacy backend explained as OBS for automatic recording", settingsDialog.automaticBackendText().indexOf("OBS")>=0 && !settingsDialog.automaticBackendOk())', '', ''),
    'tab-processing': ('settingsDialog.open(); settingsTabs.currentIndex=2', 'settingsDialog.applyPreset("local"); check("preset changes providers in the draft", settingsChanges()["transcription.provider"]==="whisper-cpp" && settingsChanges()["summary.provider"]==="ollama"); '
                       'setSettingsField("transcription.openaiPrompt",""); check("a cleared vocabulary is saved as empty text", settingsChanges()["transcription.openaiPrompt"]===""); '
                       'setSettingsField("summary.ollamaModel",""); check("a cleared required field stays an unfinished edit", !Object.prototype.hasOwnProperty.call(settingsChanges(),"summary.ollamaModel"))', '', ''),
    'keys': ('settingsDialog.open(); settingsTabs.currentIndex=3', 'check("session-only key explained", settingsDialog.secretSourceText(settingsData.credentials.details[0]).indexOf("só no ambiente desta sessão")>=0); '
             'const unknown = findObject(settingsDialog.contentItem, "keysManagerUnknown"); check("no precedence warning while the user services\' environment is read", !!unknown && !unknown.visible); settingsDialog.saveSecret("OPENAI_API_KEY","sk-synthetic-ui-key")',
             'check("saved key reported by source only", settingsData.credentials.details[0].savedInStudio===true && settingsNotice.indexOf("arquivo privado")>=0); settingsDialog.testSecret("openai")', 'check("key test result shown", !!settingsDialog.keyTests.openai && settingsDialog.keyTests.openai.status==="ok")'),
    'keys-refresh': ('settingsDialog.open(); settingsTabs.currentIndex=3', 'settingsDialog.saveSecret("OPENAI_API_KEY","sk-synthetic-refresh-key")',
                     'check("a saved key whose status could not be read again is reported as saved", settingsError==="" && settingsNotice.indexOf("arquivo privado")>=0 && settingsNotice.indexOf("releia")>=0)', ''),
    'wizard-download-finish': ('setupWizard.open(); setupWizard.consentAck=true; setupWizard.applyMonitor=false; setupWizard.applyTimer=false',
                               'setupWizard.request("settings-model-download",{kind:"whisper",model:"large-v3-turbo-q5_0",consent:true})',
                               'setupWizard.set("processing.notifyOnCompletion", false); setupWizard.step=4; setupWizard.finish(); check("Finish waits while a model download runs", setupWizard.modelDownloadRunning() && setupWizard.step===4 && !setupWizard.hasPending("settings-save") && setupWizard.error!==""); setupWizard.cancelDownload("whisper","large-v3-turbo-q5_0")',
                               'check("once the download stops, Finish is available again", !setupWizard.modelDownloadRunning()); setupWizard.finish()'),
    'keys-lost': ('settingsDialog.open(); settingsTabs.currentIndex=3', 'settingsDialog.saveSecret("OPENAI_API_KEY","sk-synthetic-lost-key"); check("a key save in flight locks the key fields", settingsDialog.secretBusy)',
                  'settingsConnectionLost(); check("a lost connection unlocks the key fields", !settingsDialog.secretBusy)', ''),
    'keys-test-lost': ('settingsDialog.open(); settingsTabs.currentIndex=3', 'settingsDialog.testSecret("openai"); check("a key test in flight locks the Test buttons", settingsDialog.keyTestPending==="openai")',
                       'settingsConnectionLost(); check("a lost connection unlocks the Test buttons", settingsDialog.keyTestPending==="")', ''),
    'wizard-lost': ('setupWizard.open(); setupWizard.consentAck=true; setupWizard.applyMonitor=false; setupWizard.applyTimer=false',
                    'setupWizard.set("processing.notifyOnCompletion", false); setupWizard.step=4; setupWizard.finish(); check("Finish is saving", setupWizard.busy); '
                    'settingsConnectionLost(); const next = findObject(setupWizard.footer, "wizardNext"); check("a lost connection stops the assistant with the outcome unknown", setupWizard.stale && setupWizard.error!=="" && !setupWizard.busy && !!next && !next.enabled)',
                    'setupWizard.reconnected(); const next = findObject(setupWizard.footer, "wizardNext"); check("the assistant stays stopped while it reads the configuration again", setupWizard.stale && !!next && !next.enabled)',
                    'const next = findObject(setupWizard.footer, "wizardNext"); check("once read again the assistant continues and keeps its choices", !setupWizard.stale && setupWizard.value("processing.notifyOnCompletion")===false && !!next && next.enabled)'),
    'wizard-reread-fail': ('setupWizard.open(); setupWizard.consentAck=true; setupWizard.applyMonitor=false; setupWizard.applyTimer=false',
                           'setupWizard.step=4; settingsConnectionLost()', 'setupWizard.reconnected()',
                           'const next = findObject(setupWizard.footer, "wizardNext"); check("a failed reread after reconnecting keeps the assistant stopped", setupWizard.stale && setupWizard.error!=="" && !!next && !next.enabled)'),
    'restore-pending': ('settingsDialog.open(); settingsDialog.goToSection(9)',
                        'settingsDialog.confirmRestore=settingsDialog.backups[0].name; const confirm = findObject(settingsDialog.contentItem, "settingsRestoreConfirm"); for (let i = 0; i < 2; i++) if (confirm && confirm.enabled) confirm.clicked(); check("the restore confirmation is disabled while a restore is pending", !!confirm && !confirm.enabled)', '', ''),
    'wizard-key-required': ('setupWizard.open(); setupWizard.consentAck=true; setupWizard.applyMonitor=false; setupWizard.applyTimer=false',
                            'setupWizard.step=4; setupWizard.finish(); check("Finish waits for the OpenAI key the reviewed setup needs", setupWizard.missingRequiredKey() && setupWizard.step===4 && setupWizard.error!=="" && !setupWizard.hasPending("settings-save") && !setupWizard.hasPending("settings-secret-set"))',
                            'setupWizard.useKey("sk-synthetic-wizard-key"); setupWizard.finish()',
                            'check("with the key typed, Finish writes it and completes", setupWizard.step===5 && setupWizard.results.some(function(r){return r.label==="Chave da OpenAI" && r.ok}))'),
    'wizard-key-fail': ('setupWizard.open(); setupWizard.consentAck=true',
                        'setupWizard.applyPreset("cloud"); setupWizard.useKey("sk-synthetic-wizard-key"); setupWizard.step=4; setupWizard.finish()',
                        'check("a failed key write keeps the assistant on review with the key and applies no service", setupWizard.step===4 && setupWizard.error!=="" && setupWizard.pendingKey!=="" && !setupWizard.hasPending("settings-service"))', ''),
    'wizard-download-pending': ('setupWizard.open(); setupWizard.consentAck=true; setupWizard.applyMonitor=false; setupWizard.applyTimer=false',
                                'setupWizard.set("processing.notifyOnCompletion", false); setupWizard.step=4; setupWizard.request("settings-model-download",{kind:"whisper",model:"large-v3-turbo-q5_0",consent:true}); setupWizard.finish(); check("Finish waits for a download request that has not been answered", setupWizard.step===4 && setupWizard.error!=="" && !setupWizard.hasPending("settings-save"))', '', ''),
    'models': ('settingsDialog.open(); settingsDialog.goToSection(4)', 'check("catalog loaded on demand", !!settingsDialog.catalog.whisper && settingsDialog.catalog.whisper.models.length===2); settingsDialog.confirmDownload="whisper:tiny"; settingsDialog.startDownload("whisper","tiny")',
               'check("download progress tracked", !!settingsDialog.downloads["whisper:tiny"] && settingsDialog.downloads["whisper:tiny"].state==="running"); settingsDialog.cancelDownload("whisper","tiny")',
               'check("cancelling refreshes the stopped download without an error", settingsError==="" && settingsDialog.downloads["whisper:tiny"].state==="failed")'),
    'models-cloud': ('settingsDialog.open(); settingsDialog.goToSection(4)', 'settingsDialog.startDownload("whisper","tiny")',
                     'send("settings-model-status", "", { kind: "whisper", model: "tiny" })',
                     'check("a model downloaded while transcription uses OpenAI is not marked in use", !Object.prototype.hasOwnProperty.call(settingsChanges(), "transcription.whisperCpp.modelPath") && settingsDraft["transcription.provider"]==="openai" && settingsNotice.indexOf("Usar este modelo")>=0 && !settingsDialog.modelInUse("/home/synthetic/models/ggml-tiny.bin")); '
                     'setSettingsField("transcription.whisperCpp.modelPath", "/home/synthetic/models/ggml-tiny.bin"); setSettingsField("transcription.provider", "whisper-cpp"); check("using the model switches transcription to this computer", settingsDialog.modelInUse("/home/synthetic/models/ggml-tiny.bin"))'),
    'wizard-gemini-key': ('setupWizard.open(); setupWizard.consentAck=true; setupWizard.applyMonitor=false; setupWizard.applyTimer=false',
                          'setupWizard.step=4; setupWizard.finish(); check("Finish waits for the Gemini key the reviewed transcription needs", setupWizard.missingRequiredKey() && setupWizard.step===4 && setupWizard.error!=="" && !setupWizard.hasPending("settings-save"))',
                          'setupWizard.applyPreset("cloud"); setupWizard.finish()',
                          'check("a preset the saved keys cover lets Finish complete", setupWizard.step===5 && !setupWizard.missingRequiredKey())'),
    'wizard-recommended-review': ('setupWizard.consentAck=true', 'setupWizard.recommend()',
                                  'const row = findObject(setupWizard.contentItem, "wizardReviewProcessing"), missing = findObject(setupWizard.contentItem, "wizardShowMissing"); '
                                  'check("review flags the local models that are missing", setupWizard.step===4 && !!row && row.status==="warning" && !!missing && missing.visible); '
                                  'if (missing) missing.clicked(); check("review leads to the step that offers the downloads", setupWizard.step===2); setupWizard.step=4; setupWizard.finish()',
                                  'const title = findObject(setupWizard.contentItem, "wizardDoneTitle"); check("the last page does not say all set while the models are missing", setupWizard.step===5 && !!title && title.text!=="Tudo pronto")'),
    'wizard-ffmpeg-review': ('setupWizard.open(); setupWizard.consentAck=true; setupWizard.applyMonitor=false; setupWizard.applyTimer=false',
                             'setupWizard.step=4; const row = findObject(setupWizard.contentItem, "wizardReviewProcessing"), missing = findObject(setupWizard.contentItem, "wizardShowMissing"); '
                             'check("review flags the FFmpeg that processing on this computer needs", !setupWizard.missingRequiredKey() && !!row && row.detail.indexOf("extrair o áudio")>=0 && !!missing && missing.visible); '
                             'if (missing) missing.clicked(); const ffmpeg = findObject(setupWizard.contentItem, "wizardProblem-ffmpeg"); check("the processing step shows what is missing", setupWizard.step===2 && !!ffmpeg && ffmpeg.visible); setupWizard.step=4; setupWizard.finish()',
                             'const title = findObject(setupWizard.contentItem, "wizardDoneTitle"); check("the last page lists FFmpeg instead of saying all set", setupWizard.step===5 && !!title && title.text!=="Tudo pronto" && setupWizard.pendingIssues().some(function(issue){ return issue.label==="FFmpeg" })); '
                             'setupWizard.set("processing.defaultTarget", "remote"); check("jobs sent to the remote worker do not need FFmpeg here", !setupWizard.processingProblems().length)', ''),
    'keys-manager-unknown': ('settingsDialog.open(); settingsTabs.currentIndex=3',
                             'const unknown = findObject(settingsDialog.contentItem, "keysManagerUnknown"); check("keys warn that a key in the unread user services\' environment would win", !!unknown && unknown.visible)', '', ''),
    'wizard-automation-review': ('setupWizard.open(); setupWizard.consentAck=true; setupWizard.applyMonitor=false; setupWizard.applyTimer=false',
                                 'setupWizard.step=4; const row = findObject(setupWizard.contentItem, "wizardReviewAutomation"); '
                                 'check("review flags automatic recording that cannot record", !!row && row.status==="warning" && row.detail.indexOf("exige o OBS ativado")>=0); '
                                 'const missing = findObject(setupWizard.contentItem, "wizardShowMissing"); if (missing) missing.clicked(); const worker = findObject(setupWizard.contentItem, "wizardProblem-remote-worker"); '
                                 'check("the processing step shows the remote worker that is missing", setupWizard.step===2 && !!worker && worker.visible); setupWizard.step=4; setupWizard.finish()',
                                 'const title = findObject(setupWizard.contentItem, "wizardDoneTitle"), labels = setupWizard.pendingIssues().map(function(issue){ return issue.label }); '
                                 'check("the last page lists automatic recording and the remote worker", setupWizard.step===5 && !!title && title.text!=="Tudo pronto" && labels.indexOf("Gravação automática")>=0 && labels.indexOf("Worker remoto")>=0)', ''),
    'wizard-skip-services': ('setupWizard.open(); setupWizard.consentAck=true',
                             'setupWizard.step=4; const before = setupWizard.pendingIssues().map(function(issue){ return issue.label }); '
                             'check("warnings that Finish fixes are not pending", before.indexOf("Gravação automática")<0 && before.indexOf("Processamento automático")<0); '
                             'setupWizard.applyMonitor=false; setupWizard.applyTimer=false; const row = findObject(setupWizard.contentItem, "wizardReviewAutomation"), timer = findObject(setupWizard.contentItem, "wizardReviewProblem-processing-timer"); '
                             'check("review flags the monitor and the processing timer left off", !!row && row.status==="warning" && row.detail.indexOf("não está rodando")>=0 && !!timer && timer.visible); setupWizard.finish()',
                             'const title = findObject(setupWizard.contentItem, "wizardDoneTitle"), labels = setupWizard.pendingIssues().map(function(issue){ return issue.label }); '
                             'check("the last page lists the monitor and the timer that were not applied", setupWizard.step===5 && !!title && title.text!=="Tudo pronto" && labels.indexOf("Gravação automática")>=0 && labels.indexOf("Processamento automático")>=0)', ''),
    'wizard-monitor-stale': ('setupWizard.open(); setupWizard.consentAck=true; setupWizard.applyTimer=false',
                             'setupWizard.step=4; const stale = function(){ return setupWizard.pendingIssues().some(function(issue){ return issue.detail.indexOf("configuração anterior")>=0 }) }; '
                             'check("a running monitor with nothing changed is not pending", !stale()); setupWizard.applyMonitor=false; setupWizard.set("callDetection.mode", "notify-only"); '
                             'check("a running monitor left with the previous configuration is pending", stale()); setupWizard.applyMonitor=true; check("applying the monitor clears it", !stale()); '
                             'setupWizard.applyMonitor=false; setupWizard.finish()',
                             'const title = findObject(setupWizard.contentItem, "wizardDoneTitle"); check("after saving, the last page still names the monitor left on the previous configuration", setupWizard.step===5 && !!title && title.text!=="Tudo pronto" && setupWizard.pendingIssues().some(function(issue){ return issue.detail.indexOf("configuração anterior")>=0 }))', ''),
    'wizard-unknown-services': ('setupWizard.open(); setupWizard.consentAck=true',
                                'setupWizard.step=4; const labels = function(){ return setupWizard.pendingIssues().map(function(issue){ return issue.label }) }; '
                                'check("unknown services that Finish applies are not pending", labels().indexOf("Gravação automática")<0 && labels().indexOf("Processamento automático")<0); '
                                'setupWizard.applyMonitor=false; setupWizard.applyTimer=false; check("unknown services left off are pending", labels().indexOf("Gravação automática")>=0 && labels().indexOf("Processamento automático")>=0); setupWizard.finish()',
                                'const title = findObject(setupWizard.contentItem, "wizardDoneTitle"); check("the last page does not say all set while those services cannot be confirmed", setupWizard.step===5 && !!title && title.text!=="Tudo pronto")', ''),
    'diagnose-draft': ('settingsDialog.open()',
                       'setSettingsField("transcription.provider", "whisper-cpp"); settingsTabs.currentIndex=8; runSettingsDiagnose()',
                       'const outdated = findObject(settingsDialog.contentItem, "settingsDiagOutdated"); check("a diagnostic of the current draft is not flagged", !!outdated && !outdated.visible); '
                       'setSettingsField("summary.provider", "ollama"); check("an edit after the check flags the diagnostic as out of date", !!outdated && outdated.visible)', ''),
    'wizard-ollama-pending': ('setupWizard.open(); setupWizard.consentAck=true; setupWizard.applyMonitor=false; setupWizard.applyTimer=false',
                              'setupWizard.request("settings-model-download",{kind:"ollama",model:"qwen3.5:9b",consent:true,ollamaUrl:"http://127.0.0.1:11434"})',
                              'setupWizard.step=4; setupWizard.finish(); check("Finish waits for an Ollama pull started here", setupWizard.downloads["ollama:qwen3.5:9b"].state==="running" && setupWizard.step===4 && setupWizard.error!=="")', ''),
    'save-list-pending': ('settingsDialog.open()', 'setSettingsField("callDetection.apps.discord", true); saveSettingsDraft()', '', ''),
    'wizard-download-double': ('setupWizard.consentAck=true',
                               'setupWizard.step=2; const download = findObject(setupWizard.contentItem, "wizardDownloadModel"); for (let i = 0; i < 2; i++) if (download && download.enabled) download.clicked(); '
                               'check("the download button waits for the reply to the first click", !!download && !download.enabled)', '', ''),
    'wizard-use-installed': ('setupWizard.consentAck=true',
                             'setupWizard.step=2; const use = findObject(setupWizard.contentItem, "wizardUseModel"); check("an installed recommended model is offered when the configured file is missing", !!use && use.visible); '
                             'if (use) use.clicked(); check("using it points transcription at the installed model", setupWizard.value("transcription.whisperCpp.modelPath")==="/home/synthetic/models/ggml-large-v3-turbo-q5_0.bin")', '', ''),
    'models-ollama-draft': ('settingsDialog.open()',
                            'setSettingsField("summary.provider", "ollama"); setSettingsField("summary.ollamaUrl", "http://127.0.0.1:11435"); setSettingsField("summary.ollamaModel", "llama4:8b"); settingsDialog.goToSection(4)',
                            'check("the list shows the Ollama at the unsaved address", !!settingsDialog.catalog.ollama && settingsDialog.catalog.ollama.url==="http://127.0.0.1:11435"); settingsDialog.startDownload("ollama", "llama4:8b"); '
                            'setSettingsField("summary.ollamaUrl", "http://127.0.0.1:11436"); const stale = findObject(settingsDialog.contentItem, "ollamaCatalogStale"); check("a list from another address is flagged", !!stale && stale.visible); settingsDialog.startDownload("ollama", "llama4:8b")',
                            'check("a download is refused until the list matches the chosen address", settingsError!=="")'),
    'models-two': ('settingsDialog.open(); settingsDialog.goToSection(4)', 'settingsDialog.startDownload("whisper","tiny"); settingsDialog.startDownload("whisper","large-v3-turbo-q5_0")',
                   'settingsDialog.pollDownloads(); check("two downloads are tracked", !!settingsDialog.downloads["whisper:tiny"] && !!settingsDialog.downloads["whisper:large-v3-turbo-q5_0"])', ''),
    'integrations': ('settingsDialog.open(); settingsDialog.goToSection(5)', 'check("remote check available once configured", settingsData.readOnly.remoteConfigured); send("settings-remote-check",""); setSettingsField("remote.user", null); check("cleared optional field becomes a null change", settingsChanges()["remote.user"]===null)',
                     'check("remote check result shown", !!settingsDialog.remoteCheck && settingsDialog.remoteCheck.ok)', ''),
    'services': ('settingsDialog.open(); settingsTabs.currentIndex=8', 'check("stale monitor flagged", settingsServiceStatus("calls")==="warning" && settingsServiceText("calls").indexOf("configuração anterior")>=0); check("automation check offers a fix", settingsDiag.automation.length===1 && settingsDialog.checkActionLabel("capture")!=="")', 'runSettingsService("calls-apply"); runSettingsService("sync-apply")',
                 'check("apply clears stale flag", settingsServiceStatus("calls")==="ok"); check("timer status shown", settingsDialog.timerStatus(settingsDiag.services.sync)==="ok"); '
                 'check("an enabled but stopped timer is not shown as healthy", settingsDialog.timerStatus({installed:true,enabled:true,active:false,outdated:false})==="warning" && settingsDialog.timerText({installed:true,enabled:true,active:false,outdated:false}).indexOf("parado")>=0)'),
    'services-unknown': ('settingsDialog.open(); settingsTabs.currentIndex=8', 'check("an unreadable service status is shown as unknown", !!settingsDiag.checks && !settingsDiag.services && settingsServiceStatus("calls")==="skipped"); check("the monitor can still be disabled while its state is unknown", settingsDialog.canDisableMonitor())', '', ''),
    'backups': ('settingsDialog.open(); settingsDialog.goToSection(9)', 'check("backups listed", settingsDialog.backups.length===1); settingsDialog.confirmRestore=settingsDialog.backups[0].name; send("settings-restore","",{revision:settingsData.revision,backup:settingsDialog.backups[0].name})',
                'check("restore reloads the settings", settingsNotice.indexOf("restaurada")>=0)', ''),
    'restore-reload': ('settingsDialog.open(); settingsDialog.goToSection(9)', 'settingsDialog.confirmRestore=settingsDialog.backups[0].name; send("settings-restore","",{revision:settingsData.revision,backup:settingsDialog.backups[0].name})',
                       'check("a restore whose reread failed still reports success and reads again", settingsNotice.indexOf("restaurada")>=0 && settingsError==="" && !!settingsData.revision)', ''),
    'save': ('settingsDialog.open()', 'setSettingsField("callDetection.apps.discord", true); setSettingsField("backend", "audio"); check("diff has two changes", Object.keys(settingsChanges()).length===2); saveSettingsDraft()',
             'check("saved notice asks to apply monitor", settingsNotice.indexOf("Aplique o monitor")>=0 && !settingsHasChanges() && settingsData.revision==="' + 'b' * 64 + '")', ''),
    'compact': ('window.width=900; window.height=640; settingsDialog.open(); settingsTabs.currentIndex=0', 'check("dialog fits compact window", settingsDialog.width<=window.width && settingsDialog.height<=window.height); check("sections become a list", !settingsTabs.visible)', '', ''),
    'english': ('settingsDialog.open(); settingsTabs.currentIndex=1', 'check("saved English applies to the whole dialog", uiLanguage==="en" && settingsDialog.sections[0].title==="Automatic recording" && settingsDialog.sections[8].title==="Services and diagnostics"); check("choices show English and keep the saved value", settingsDialog.backendChoice.combo.displayText==="Screen and audio (GPU Screen Recorder)"); check("automatic backend status in English", settingsDialog.automaticBackendText().indexOf("screen and audio")>=0)', '', ''),
    'language-preview': ('settingsDialog.open(); settingsTabs.currentIndex=1', 'check("starts in Portuguese", uiLanguage==="pt" && settingsDialog.sections[0].title==="Gravação automática"); setSettingsField("studio.language","en"); check("the draft previews English at once", uiLanguage==="en" && settingsDialog.sections[0].title==="Automatic recording"); check("choices keep their value across the switch", settingsDialog.backendChoice.combo.displayText==="Screen and audio (GPU Screen Recorder)")',
                         'settingsDialog.reject(); check("discarding returns to the saved language", uiLanguage==="pt")', ''),
    'wizard-english': ('', 'check("assistant opens in the saved language", setupWizard.visible && setupWizard.steps[0]==="Welcome"); check("step counter fills its placeholders", tf("Passo %1 de %2 · %3", 1, setupWizard.steps.length, setupWizard.steps[0])==="Step 1 of 6 · Welcome")', '', ''),
    'discard': ('settingsDialog.open()', 'setSettingsField("callDetection.enabled", false); check("unsaved change counted", settingsHasChanges()); settingsDialog.reject(); check("discard closes and clears draft", !settingsDialog.visible && Object.keys(settingsDraft).length===0)', '', ''),
    # ── Sections 10–15 (DESIGN-STUDIO §2.13): grouped, in display order, each feature on its own page ──
    'sections-grouped': ('settingsDialog.open(); settingsTabs.currentIndex=0',
                         'check("the meeting sections come first, then recording and processing, then the system", JSON.stringify(settingsDialog.sectionOrder)==="[10,11,12,13,14,15,0,1,2,4,3,5,6,7,8,9]" && settingsDialog.sectionGroups.length===3 && settingsDialog.sections[10].title==="Notas e resumos" && settingsDialog.sections[15].title==="Privacidade e retenção"); '
                         'check("every section has its entry in the list", settingsDialog.sectionOrder.every(function(i){ const b = findObject(settingsDialog.contentItem, "settingsSection-"+i); return !!b && b.visible })); '
                         'settingsTabs.currentIndex=15; settingsDialog.stepSection(1); check("Down follows the display order", settingsTabs.currentIndex===0); settingsDialog.stepSection(-1); check("Up follows it back", settingsTabs.currentIndex===15); '
                         'check("without the new bridge no feature op is sent from a section", !hasPending("templates-list") && !hasPending("assistant-detect"))',
                         'settingsDialog.goToSection(15); setSettingsField("media.retention","audio-only"); const warning = findObject(settingsDialog.contentItem, "retentionWarning"); '
                         'check("keeping only the audio says plainly the video can no longer be watched", !!warning && warning.visible && warning.text.indexOf("não poderão mais ser assistidas")>=0); '
                         'setSettingsField("media.retention","transcript-only"); check("keeping only the text says it can no longer be watched or listened to", warning.text.indexOf("assistidas nem ouvidas")>=0); '
                         'check("each choice says what stops working", findObject(settingsDialog.contentItem, "retentionAudio").detail.indexOf("não dá mais para assistir")>=0); '
                         'check("only the audio: the transcript can no longer be redone (no reprocessing without the video file), listening and speakers keep working", findObject(settingsDialog.contentItem, "retentionAudio").detail.indexOf("nem refazer a transcrição")>=0 && findObject(settingsDialog.contentItem, "retentionAudio").detail.indexOf("Ouvir e identificar falantes continuam")>=0)',
                         'settingsDialog.goToSection(13); check("live transcript lists where the audio goes, with cost and delay", findObject(settingsDialog.contentItem, "liveGroq").detail.indexOf("US$ 0,04")>=0 && findObject(settingsDialog.contentItem, "liveWhisper").detail.indexOf("não sai daqui")>=0); '
                         'setSettingsField("live.provider","groq"); const groq = findObject(findObject(settingsDialog.contentItem, "settingsLive"), "secretInput_GROQ_API_KEY"); check("a cloud live provider shows its key inline", !!groq && groq.visible); settingsDialog.goToSection(15)'),
    'notes-section': ('settingsDialog.open(); settingsDialog.goToSection(10)',
                      'const row = findObject(settingsDialog.contentItem, "templateRow-standup"); check("the templates are listed on Notas e resumos", settingsDialog.notesPage.loaded && !!row && row.visible); '
                      'check("the default template offers the list", settingsDialog.notesPage.templateOptions.some(function(o){ return o.value==="standup" && o.label==="Daily" })); '
                      'const fast = findObject(settingsDialog.contentItem, "settingsFastPath"); check("the fast path needs processing on this computer", !!fast && !fast.enabled); '
                      'findObject(settingsDialog.contentItem, "templateNew").forceActiveFocus(); templateEditor.openCopy(settingsDialog.notesPage.templates[0])',
                      'check("the editor opens on a copy, Cancel focused", templateEditor.visible && findObject(templateEditor.footer, "templateCancel").activeFocus && templateEditor.sections.length===3 && templateEditor.problem===""); '
                      'templateEditor.moveSection(2, -1); check("sections can be reordered", templateEditor.sections[1].id==="blockers"); templateEditor.save()',
                      'check("saved, closed and listed", !templateEditor.visible && settingsDialog.notesPage.notice.indexOf("salvo")>=0 && settingsDialog.notesPage.templates.length===2 && errorText==="" && settingsError===""); '
                      'check("the focus is back on the button that opened the editor", findObject(settingsDialog.contentItem, "templateNew").activeFocus)'),
    'assistant-section': ('settingsDialog.open(); settingsDialog.goToSection(11)',
                          'check("detection marks the installed agent", settingsDialog.assistantPage.agentLabel({value:"codex",label:"Codex"})==="Codex · encontrado" && settingsDialog.assistantPage.agentLabel({value:"claude",label:"Claude Agent"})==="Claude Agent · não instalado"); '
                          'const signIn = findObject(settingsDialog.contentItem, "chatgptSignIn"); check("the ChatGPT account shows as connected", settingsDialog.assistantPage.chatgpt.state==="signed-in" && signIn.text==="Sair"); '
                          'check("each choice says what leaves this computer and what it costs", findObject(settingsDialog.contentItem, "assistantApi").detail.indexOf("Cobrado por uso")>=0 && findObject(settingsDialog.contentItem, "assistantLocal").detail.indexOf("Nada sai daqui")>=0); '
                          'setSettingsField("assistant.provider","api"); setSettingsField("assistant.apiPreset","anthropic"); const key = findObject(findObject(settingsDialog.contentItem, "settingsAssistant"), "secretInput_ANTHROPIC_API_KEY"); check("an API shows its key inline", !!key && key.visible); '
                          'recipeEditor.openNew()',
                          'check("the recipe editor opens with Cancel focused", recipeEditor.visible && findObject(recipeEditor.footer, "recipeCancel").activeFocus && recipeEditor.problem!==""); '
                          'findObject(recipeEditor.contentItem, "recipeName").text = "Resumo para o cliente"; findObject(recipeEditor.contentItem, "recipeDescription").text = "Um resumo curto para mandar ao cliente"; '
                          'const prompt = findObject(recipeEditor.contentItem, "recipePrompt"); prompt.text = "Resuma para o cliente: "; prompt.cursorPosition = prompt.length; recipeEditor.insertVariable("meeting.title"); check("a variable goes in at the cursor, which stays in the request", prompt.text==="Resuma para o cliente: {{meeting.title}}" && prompt.activeFocus && recipeEditor.problem===""); recipeEditor.save()',
                          'check("the recipe is saved and listed", !recipeEditor.visible && settingsDialog.assistantPage.recipes.length===2 && settingsDialog.assistantPage.notice.indexOf("salva")>=0)'),
    'template-editor-light': ('window.lightTheme=true; settingsDialog.open(); settingsDialog.goToSection(10)',
                              'templateEditor.openCopy(settingsDialog.notesPage.templates[0])',
                              'check("the template editor fits the window, in the light theme", templateEditor.visible && templateEditor.height <= window.height - 48 && window.lightTheme); '
                              'templateEditor.addSection(); check("a section can be added, up to eight", templateEditor.sections.length===4 && templateEditor.problem!==""); '
                              'const added = templateEditor.sections[3]; added.title = "Riscos"; added.instruction = "Riscos e como reduzi-los."; templateEditor.touched(); '
                              'check("a section with a title and an instruction makes it valid again, its field shown", templateEditor.problem==="" && !!findObject(templateEditor.contentItem, "templateSectionTitle-3"))',
                              'check("nothing was saved while editing", !hasPending("templates-save") && templateEditor.visible)'),
    'recipe-editor-compact': ('window.width=900; window.height=640; settingsDialog.open(); settingsDialog.goToSection(11)',
                              'recipeEditor.openCopy(settingsDialog.assistantPage.recipes[0])',
                              'check("the recipe editor fits the compact window", recipeEditor.visible && recipeEditor.width <= window.width - 48 && recipeEditor.height <= window.height - 48); '
                              'check("a copy keeps the request, named as a copy", findObject(recipeEditor.contentItem, "recipeName").text==="E-mail de follow-up (cópia)" && findObject(recipeEditor.contentItem, "recipePrompt").text.indexOf("{{meeting.title}}")>=0 && recipeEditor.problem==="")', ''),
    'reminders-section': ('settingsDialog.open(); settingsDialog.goToSection(12)',
                          'const status = findObject(settingsDialog.contentItem, "remindersCalendarStatus"); check("the calendar line says it is connected", !!status && status.text.indexOf("dono@example.com")>=0); '
                          'check("the service row says it is not installed yet", settingsDiag.services.reminders.installed===false); '
                          'runSettingsService("reminders-apply")',
                          'check("applying the reminders is said in Settings, and the service shows as running", settingsNotice.indexOf("Lembretes de reunião aplicados")>=0 && settingsDiag.services.reminders.active===true)', ''),
    'share-section': ('settingsDialog.open(); settingsDialog.goToSection(14)',
                      'const sharePage = findObject(settingsDialog.contentItem, "settingsShare"), notion = findObject(sharePage, "secretInput_NOTION_TOKEN"), slack = findObject(sharePage, "secretInput_SLACK_WEBHOOK_URL"); '
                      'check("the Notion and Slack keys go through the key flow on Compartilhar", !!notion && notion.visible && !!slack && slack.visible); '
                      'setSettingsField("destinations.aiApp","codex-cli"); check("the AI app is a choice", settingsChanges()["destinations.aiApp"]==="codex-cli")', '', ''),
    'keys-new': ('settingsDialog.open(); settingsTabs.currentIndex=3',
                 'check("the key section lists the assistant and sharing keys", ["OPENROUTER_API_KEY","ANTHROPIC_API_KEY","XAI_API_KEY","GROQ_API_KEY","MISTRAL_API_KEY","DEEPSEEK_API_KEY","TOGETHER_API_KEY","CUSTOM_API_KEY","NOTION_TOKEN","SLACK_WEBHOOK_URL"].every(function(name){ const field = findObject(settingsDialog.contentItem, "secretInput_" + name); return !!field && field.visible }))', '', ''),
    'compact-sections': ('window.width=900; window.height=640; settingsDialog.open(); settingsTabs.currentIndex=0',
                         'const combo = findObject(settingsDialog.contentItem, "settingsSectionCombo"); check("the compact list follows the display order", !!combo && combo.visible && combo.model[0]==="Notas e resumos" && combo.currentIndex===settingsDialog.sectionOrder.indexOf(0)); '
                         'combo.activated(4); check("picking an entry opens that section", settingsTabs.currentIndex===14)', '', ''),
    'shortcuts': ('shortcutsDialog.show(shortcutsButton)',
                  'check("F1 or ? opens the shortcuts, Close focused", shortcutsDialog.visible && uxModal && findObject(shortcutsDialog.footer, "shortcutsClose").activeFocus && shortcutsDialog.groups.length===3)',
                  'shortcutsDialog.close(); check("closing returns the focus to the ? button", !shortcutsDialog.visible && shortcutsButton.activeFocus)', 'shortcutsDialog.show(shortcutsButton)'),
    'wizard-record-test': ('setupWizard.consentAck=true',
                           'setupWizard.recommend(); check("the quick start turns on the notes as soon as a recording stops", setupWizard.value("processing.fastPath")===true && setupWizard.preset()==="local"); setupWizard.finish()',
                           'const record = findObject(setupWizard.contentItem, "wizardRecordTest"); check("the last step offers the one-minute test recording", setupWizard.step===5 && !!record && record.visible && record.enabled); if (record) record.clicked()',
                           'check("it opens the capture consent for the test conversation, in test mode", !setupWizard.visible && captureConsent.visible && captureConsent.captureTitle==="Conversa de teste" && liveView.testMode===true); '
                           'check("Cancel keeps the focus, and nothing is recorded before consenting", findObject(captureConsent.footer, "captureConsentCancel").activeFocus && !hasPending("capture-start") && !captureStatus.active)'),
    'wizard-download-all': ('setupWizard.consentAck=true; setupWizard.step=2',
                            'const all = findObject(setupWizard.contentItem, "wizardDownloadAll"), estimate = findObject(setupWizard.contentItem, "wizardDownloadEstimate"); '
                            'check("both missing models can start at once, with size and time", !!all && all.visible && setupWizard.missingDownloads().length===2 && estimate.text.indexOf("min a 100 Mb/s")>=0 && estimate.text.indexOf("Ollama")>=0); if (all) all.clicked()',
                            'check("both downloads run while the setup goes on", setupWizard.modelDownloadRunning() && !!setupWizard.downloadState("whisper","large-v3-turbo-q5_0") && !!setupWizard.downloadState("ollama","qwen3.5:9b") && setupWizard.downloadsText().indexOf("Baixando")===0)', ''),
    'wizard-finish-after-download': ('setupWizard.consentAck=true', 'setupWizard.recommend()',
                                     'const start = findObject(setupWizard.contentItem, "wizardReviewDownload"); check("the review offers the downloads too", setupWizard.step===4 && !!start && start.visible && setupWizard.missingDownloads().length===2); if (start) start.clicked(); '
                                     'const auto = findObject(setupWizard.contentItem, "wizardFinishAfterDownload"); check("while they run, Finish waits and can finish by itself", setupWizard.downloadBlocksFinish() && !!auto && auto.visible); setupWizard.finishWhenDownloaded=true',
                                     'check("once both finish, the setup is saved by itself", setupWizard.step===5 && setupWizard.results.length>=1 && setupWizard.results[0].ok && !setupWizard.finishWhenDownloaded)'),
}
# Requests each mode is expected to send; anything outside the list fails the journey.
SIDE_EFFECTS = {'save': {'settings-save'}, 'services': {'settings-service'}, 'wizard-flow': {'settings-save'}, 'backups': {'settings-restore'}, 'restore-reload': {'settings-restore'},
                'wizard-key-finish': {'settings-save', 'settings-secret-set'}, 'wizard-download-cancel': {'settings-model-download'},
                'wizard-reload': {'settings-save', 'settings-service'}, 'wizard-disable-monitor': {'settings-save', 'settings-service'},
                'wizard-disable-unknown': {'settings-save', 'settings-service'},
                'keys': {'settings-secret-set'}, 'models': {'settings-model-download'}, 'models-two': {'settings-model-download'},
                'keys-refresh': {'settings-secret-set'}, 'wizard-download-finish': {'settings-model-download', 'settings-save'},
                'wizard-key-fail': {'settings-save', 'settings-secret-set'}, 'wizard-download-pending': {'settings-model-download'},
                'keys-lost': {'settings-secret-set'}, 'wizard-key-required': {'settings-save', 'settings-secret-set'},
                'models-cloud': {'settings-model-download'}, 'wizard-gemini-key': {'settings-save'}, 'wizard-recommended-review': {'settings-save'},
                'wizard-lost': {'settings-save'}, 'restore-pending': {'settings-restore'}, 'wizard-ffmpeg-review': {'settings-save'}, 'models-ollama-draft': {'settings-model-download'}, 'wizard-automation-review': {'settings-save'},
                'wizard-skip-services': {'settings-save'}, 'wizard-monitor-stale': {'settings-save'},
                'wizard-unknown-services': {'settings-save'},
                'wizard-ollama-pending': {'settings-model-download'}, 'save-list-pending': {'settings-save'},
                'wizard-download-double': {'settings-model-download'}, 'notes-section': {'templates-save'}, 'assistant-section': {'recipes-save'},
                'reminders-section': {'settings-service'}, 'wizard-record-test': {'settings-save'}, 'wizard-download-all': {'settings-model-download'},
                'wizard-finish-after-download': {'settings-model-download', 'settings-save'}}
GUARDED = {'settings-save', 'settings-service', 'settings-secret-set', 'settings-secret-remove', 'settings-model-download', 'settings-restore',
           'templates-save', 'templates-delete', 'recipes-save', 'recipes-delete', 'assistant-chatgpt-login', 'assistant-chatgpt-logout', 'capture-start'}
# Extra state a step waits for (bounded) on top of the settings replies: assertion, follow-up, final.
READY = {'wizard-record-test': ('', 'setupWizard.step===5 && captureKnown', 'captureConsent.visible'),
         'wizard-finish-after-download': ('', 'setupWizard.missingDownloads().length===2', 'setupWizard.step===5 && setupWizard.results.length>=1'),
         'notes-section': ('settingsDialog.notesPage.loaded', '', '!templateEditor.visible'),
         'assistant-section': ('settingsDialog.assistantPage.recipesLoaded && !!settingsDialog.assistantPage.detected', '', '!recipeEditor.visible'),
         'template-editor-light': ('settingsDialog.notesPage.loaded', '', ''), 'recipe-editor-compact': ('settingsDialog.assistantPage.recipesLoaded', '', '')}
# Modes whose steps wait for a download to finish need more time before the snapshot deadline.
SNAPSHOT_MS = {'wizard-finish-after-download': '16000'}
# The request the stub leaves unanswered on purpose in these modes; the steps do not wait for it.
UNANSWERED = {'keys-lost': 'settings-secret-set', 'keys-test-lost': 'settings-secret-test', 'wizard-lost': 'settings-save', 'restore-pending': 'settings-restore'}

checks = []; screens = []
with tempfile.TemporaryDirectory(dir='/tmp', prefix='falatrace-settings-fixture-') as scratch:
    root = Path(scratch); nonce = secrets.token_hex(16)
    (root / '.falatrace-qa').write_text(nonce); (root / '.falatrace-qa').chmod(0o600)
    for name in ['home', 'runtime', 'config', 'state', 'data', 'cache', 'tmp']: (root / name).mkdir(mode=0o700)
    stub = root / 'bridge-stub.py'; stub.write_text(STUB); stub.chmod(0o700)
    for mode, (action, assertion, follow, final) in MODES.items():
        qml = root / mode; qml.mkdir()
        base = source.replace('../../docs/assets/', (repo / 'docs/assets').as_uri() + '/').rstrip()
        def timer(body):
            return (f'const a=[]; function check(name,pass){{a.push({{name:"{mode}: "+name,pass:!!pass}})}}; '
                    f'{body}; console.log("UX_ASSERTIONS "+JSON.stringify(a))')
        helpers = (' function wizardConsentGate() { return setupWizard.step!==0 || setupWizard.consentAck }\n'
                   ' function findObject(item, name) { if (!item) return null; if (item.objectName === name) return item; const kids = item.children || []; for (let i = 0; i < kids.length; i++) { const found = findObject(kids[i], name); if (found) return found } return null }\n')
        # The startup read answered, and no settings request (the assistant's included) is still waiting for its reply.
        # The settings sections' own families (templates, recipes, assistant detection) count as settings requests.
        quiet = ('settingsFirstRunChecked && !Object.keys(pending).some(function(id){ const op = pending[id].op; '
                 'return ["settings-", "templates-", "recipes-", "assistant-"].some(function(prefix){ return op.indexOf(prefix) === 0 }) && op !== "%s" })' % UNANSWERED.get(mode, ''))
        ready = [quiet + (' && (' + extra + ')' if extra else '') for extra in READY.get(mode, ('', '', ''))]
        extra = '\n' + helpers + qml_steps([(600, quiet, action), (1500, ready[0], timer(assertion)), (2300, ready[1], timer(follow)), (3100, ready[2], timer(final), 10000 if mode in SNAPSHOT_MS else 6000)], 500)
        (qml / 'Main.qml').write_text(base[:-1] + extra + '}\n'); copy_qml_siblings(qml)
        image = out / f'settings-{mode}.png'; receipt_path = root / f'{mode}-requests.json'
        env = {'FALATRACE_QA_ISOLATED': '1', 'FALATRACE_QA_ROOT': str(root), 'FALATRACE_QA_NONCE': nonce,
               'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_STATE_HOME': str(root / 'state'), 'XDG_DATA_HOME': str(root / 'data'),
               'HOME': str(root / 'home'), 'XDG_RUNTIME_DIR': str(root / 'runtime'), 'XDG_CACHE_HOME': str(root / 'cache'),
               'TMPDIR': str(root / 'tmp'), 'LANG': 'C.UTF-8', 'PATH': '/usr/bin:/bin', 'QT_QPA_PLATFORM': 'offscreen',
               'QT_QUICK_BACKEND': 'software', 'RECORDING_DESKTOP_SOFTWARE_SMOKE': '1', 'RECORDING_DESKTOP_SMOKE_KEY': '',
               'RECORDING_DESKTOP_SNAPSHOT': str(image), 'RECORDING_DESKTOP_SNAPSHOT_MS': SNAPSHOT_MS.get(mode, '8000'),
               'FALATRACE_TEST_MODE': mode, 'FALATRACE_RECEIPT': str(receipt_path)}
        runpy.run_path(str(repo / 'scripts/qa-run.py'))['require_isolated'](env)
        r = subprocess.run([*command, str(qml), str(stub)], env=env, capture_output=True, text=True, timeout=40)
        (out / f'settings-{mode}.stderr').write_text(r.stderr)
        problems = [line for line in r.stderr.splitlines() if any(marker in line for marker in ('ReferenceError', 'TypeError', 'failed to load component', 'Unable to assign', 'is not a type', 'unavailable'))]
        require_assertion_lines(r.stderr, 'UX_ASSERTIONS ', 3, mode)
        if not image.exists() or problems:
            raise SystemExit(f'QML failure: {mode}: ' + ('\n'.join(problems) or r.stderr[-4000:]))
        for line in r.stderr.splitlines():
            if 'UX_ASSERTIONS ' in line: checks.extend(json.loads(line.split('UX_ASSERTIONS ', 1)[1]))
        requests = json.loads(receipt_path.read_text()) if receipt_path.exists() else []
        if mode == 'save':
            saves = [q for q in requests if q['op'] == 'settings-save']
            checks.append({'name': 'save: bridge received exactly the diff', 'pass': len(saves) == 1 and saves[0]['payload']['changes'] == {'callDetection.apps.discord': True, 'backend': 'audio'} and saves[0]['payload']['revision'] == 'a' * 64})
        if mode == 'wizard-flow':
            saves = [q for q in requests if q['op'] == 'settings-save']
            checks.append({'name': 'wizard-flow: first save initializes with explicit choices', 'pass': len(saves) == 1 and saves[0]['payload'].get('initialize') is True and saves[0]['payload']['changes'].get('backend') == 'audio' and saves[0]['payload']['changes'].get('transcription.provider') == 'whisper-cpp'})
            checks.append({'name': 'wizard-flow: the quick start saves the fast path for notes', 'pass': len(saves) == 1 and saves[0]['payload']['changes'].get('processing.fastPath') is True})
        if mode == 'notes-section':
            saves = [q['payload'] for q in requests if q['op'] == 'templates-save']
            template = saves[0]['template'] if len(saves) == 1 else {}
            checks.append({'name': 'notes-section: the copy is saved once as a new custom template, sections in the new order, keeping their translations',
                           'pass': len(saves) == 1 and 'expectedVersion' not in saves[0] and template.get('id') == 'custom:daily-copia' and template.get('name') == {'pt-BR': 'Daily (cópia)', 'en': 'Daily (cópia)', 'es': 'Daily (cópia)'}
                           and [section['id'] for section in template.get('sections', [])] == ['yesterday', 'blockers', 'today'] and template['sections'][0]['title'] == {'pt-BR': 'Ontem', 'en': 'Yesterday', 'es': 'Ayer'}})
        if mode == 'assistant-section':
            saves = [q['payload'] for q in requests if q['op'] == 'recipes-save']
            recipe = saves[0]['recipe'] if len(saves) == 1 else {}
            checks.append({'name': 'assistant-section: the new recipe is saved once with its variable', 'pass': len(saves) == 1 and recipe.get('id') == 'custom:resumo-para-o-cliente' and recipe.get('scope') == 'meeting'
                           and recipe.get('prompt') == 'Resuma para o cliente: {{meeting.title}}' and 'expectedVersion' not in saves[0]})
            checks.append({'name': 'assistant-section: opening the section only detects and lists', 'pass': {q['op'] for q in requests if q['op'].startswith(('assistant-', 'recipes-'))} == {'assistant-detect', 'recipes-list', 'recipes-save'}})
        if mode == 'reminders-section':
            applied = [q['payload'] for q in requests if q['op'] == 'settings-service']
            checks.append({'name': 'reminders-section: only the reminders service is applied', 'pass': applied == [{'action': 'reminders-apply'}]})
        if mode in ('sections-grouped', 'share-section', 'keys-new', 'compact-sections', 'reminders-section'):
            checks.append({'name': f'{mode}: without the feature flags no section asks for templates, recipes or detection', 'pass': not any(q['op'].startswith(('templates-', 'recipes-', 'assistant-')) for q in requests)})
        if mode == 'wizard-download-all':
            downloads = [q['payload'] for q in requests if q['op'] == 'settings-model-download']
            checks.append({'name': 'wizard-download-all: one click starts both downloads, each with consent', 'pass': downloads == [{'kind': 'whisper', 'model': 'large-v3-turbo-q5_0', 'consent': True},
                                                                                                                    {'kind': 'ollama', 'model': 'qwen3.5:9b', 'consent': True, 'ollamaUrl': 'http://127.0.0.1:11434'}]})
        if mode == 'wizard-finish-after-download':
            ops = [q['op'] for q in requests]
            saves = [q['payload'] for q in requests if q['op'] == 'settings-save']
            last_status = max((i for i, op in enumerate(ops) if op == 'settings-model-status'), default=len(ops))
            checks.append({'name': 'wizard-finish-after-download: saved once, only after both downloads finished, with the new model',
                           'pass': ops.count('settings-model-download') == 2 and len(saves) == 1 and ops.index('settings-save') > last_status
                           and saves[0]['changes'].get('transcription.whisperCpp.modelPath') == '/home/synthetic/models/ggml-large-v3-turbo-q5_0.bin' and saves[0]['changes'].get('processing.fastPath') is True})
        if mode == 'keys':
            sets = [q for q in requests if q['op'] == 'settings-secret-set']
            checks.append({'name': 'keys: the key went to the bridge once', 'pass': len(sets) == 1 and sets[0]['payload']['name'] == 'OPENAI_API_KEY' and sets[0]['payload']['value'] == 'sha256:' + hashlib.sha256(b'sk-synthetic-ui-key').hexdigest()})
            checks.append({'name': 'keys: the key never appears in Studio output', 'pass': 'sk-synthetic-ui-key' not in r.stderr})
        if mode == 'wizard-key-fail':
            ops = [q['op'] for q in requests]
            checks.append({'name': 'wizard-key-fail: the key write is tried once and no service follows it', 'pass': ops.count('settings-secret-set') == 1 and 'settings-service' not in ops})
        if mode == 'keys-refresh':
            checks.append({'name': 'keys-refresh: the key never appears in Studio output', 'pass': 'sk-synthetic-refresh-key' not in r.stderr})
        if mode == 'wizard-download-finish':
            ops = [q['op'] for q in requests]
            checks.append({'name': 'wizard-download-finish: nothing is saved until the download stops', 'pass': 'settings-save' in ops and 'settings-model-cancel' in ops and ops.index('settings-save') > ops.index('settings-model-cancel')})
        if mode == 'wizard-key-finish':
            ops = [q['op'] for q in requests if q['op'] in ('settings-save', 'settings-secret-set')]
            sets = [q for q in requests if q['op'] == 'settings-secret-set']
            checks.append({'name': 'wizard-key-finish: the key is written once, after the configuration', 'pass': ops == ['settings-save', 'settings-secret-set']
                           and sets[0]['payload'] == {'name': 'OPENAI_API_KEY', 'value': 'sha256:' + hashlib.sha256(b'sk-synthetic-wizard-key').hexdigest()}})
        if mode == 'diagnose-draft':
            diagnoses = [q['payload'] for q in requests if q['op'] == 'settings-diagnose']
            checks.append({'name': 'diagnose-draft: Settings diagnoses the unsaved draft', 'pass': any(d.get('changes', {}).get('transcription.provider') == 'whisper-cpp' for d in diagnoses)})
        if mode == 'models-ollama-draft':
            catalogs = [q['payload'] for q in requests if q['op'] == 'settings-model-catalog']
            downloads = [q['payload'] for q in requests if q['op'] == 'settings-model-download']
            checks.append({'name': 'models-ollama-draft: the list and the pull use the unsaved Ollama address', 'pass': bool(catalogs) and catalogs[0] == {'ollamaUrl': 'http://127.0.0.1:11435'}
                           and downloads == [{'kind': 'ollama', 'model': 'llama4:8b', 'consent': True, 'ollamaUrl': 'http://127.0.0.1:11435'}]})
        if mode == 'models-two':
            polled = {q['payload'].get('model') for q in requests if q['op'] == 'settings-model-status'}
            checks.append({'name': 'models-two: every running download is polled', 'pass': {'tiny', 'large-v3-turbo-q5_0'} <= polled})
        if mode in ('wizard-disable-monitor', 'wizard-disable-unknown'):
            applied = [q['payload'] for q in requests if q['op'] == 'settings-service']
            checks.append({'name': f'{mode}: only the monitor is disabled', 'pass': applied == [{'action': 'calls-disable'}]})
        if mode == 'wizard-download-double':
            checks.append({'name': 'wizard-download-double: a double click starts one download', 'pass': [q['op'] for q in requests].count('settings-model-download') == 1})
        if mode == 'wizard-use-installed':
            diagnoses = [q['payload'] for q in requests if q['op'] == 'settings-diagnose']
            checks.append({'name': 'wizard-use-installed: the choice is diagnosed as a draft', 'pass': any(d.get('changes', {}).get('transcription.whisperCpp.modelPath') == '/home/synthetic/models/ggml-large-v3-turbo-q5_0.bin' for d in diagnoses)})
        if mode == 'save-list-pending':
            ops = [q['op'] for q in requests]
            checks.append({'name': 'save-list-pending: a list pending from before the save does not stop the library from being listed again', 'pass': 'settings-save' in ops and 'list' in ops[ops.index('settings-save') + 1:]})
        if mode in ('save', 'backups'):
            ops = [q['op'] for q in requests]
            change = 'settings-save' if mode == 'save' else 'settings-restore'
            checks.append({'name': f'{mode}: the library is listed again after the committed change', 'pass': change in ops and 'list' in ops[ops.index(change) + 1:]})
        if mode == 'wizard-lost':
            ops = [q['op'] for q in requests]
            checks.append({'name': 'wizard-lost: the configuration is read again after reconnecting', 'pass': 'settings-save' in ops and 'settings-read' in ops[ops.index('settings-save') + 1:]})
        if mode == 'restore-pending':
            checks.append({'name': 'restore-pending: a double click sends one restore', 'pass': [q['op'] for q in requests].count('settings-restore') == 1})
        if mode == 'wizard-gemini-key':
            saves = [q['payload'] for q in requests if q['op'] == 'settings-save']
            checks.append({'name': 'wizard-gemini-key: nothing is saved until the setup no longer needs the missing key', 'pass': len(saves) == 1 and saves[0]['changes'].get('transcription.provider') == 'openai'})
        if mode == 'wizard-draft-ollama':
            diagnoses = [q['payload'] for q in requests if q['op'] == 'settings-diagnose']
            checks.append({'name': 'wizard-draft-ollama: the preset is diagnosed as a draft, not saved', 'pass': len(diagnoses) >= 2 and 'changes' not in diagnoses[0]
                           and diagnoses[-1].get('changes', {}).get('summary.provider') == 'ollama' and diagnoses[-1]['changes'].get('transcription.provider') == 'whisper-cpp'})
        if mode == 'restore-reload':
            ops = [q['op'] for q in requests]
            checks.append({'name': 'restore-reload: the configuration is read again after the restore', 'pass': 'settings-restore' in ops and 'settings-read' in ops[ops.index('settings-restore') + 1:]})
        if mode == 'wizard-reload':
            applied = [q for q in requests if q['op'] == 'settings-service']
            reads = [q for q in requests if q['op'] == 'settings-read']
            checks.append({'name': 'wizard-reload: the monitor is applied once and the configuration is read again', 'pass': [q['payload'] for q in applied] == [{'action': 'calls-apply'}] and len(reads) >= 2})
        if mode == 'wizard-download-cancel':
            ops = [q['op'] for q in requests]
            after = requests[ops.index('settings-model-cancel') + 1:] if 'settings-model-cancel' in ops else []
            checks.append({'name': 'wizard-download-cancel: the cancel and the poll after it name the model', 'pass': {'kind': 'whisper', 'model': 'large-v3-turbo-q5_0'} in [q['payload'] for q in requests if q['op'] == 'settings-model-cancel']
                           and any(q['op'] == 'settings-model-status' and q['payload'] == {'kind': 'whisper', 'model': 'large-v3-turbo-q5_0'} for q in after)})
        if mode.startswith('wizard-key'):
            checks.append({'name': f'{mode}: the key never appears in Studio output', 'pass': 'sk-synthetic-wizard-key' not in r.stderr})
        if mode == 'models':
            downloads = [q for q in requests if q['op'] == 'settings-model-download']
            checks.append({'name': 'models: download carries explicit consent', 'pass': len(downloads) == 1 and downloads[0]['payload'] == {'kind': 'whisper', 'model': 'tiny', 'consent': True}})
            ops = [q['op'] for q in requests]
            after = requests[ops.index('settings-model-cancel') + 1:] if 'settings-model-cancel' in ops else []
            statuses = [q for q in after if q['op'] == 'settings-model-status']
            checks.append({'name': 'models: the status poll after a cancel names the model', 'pass': bool(statuses) and all(q['payload'] == {'kind': 'whisper', 'model': 'tiny'} for q in statuses)})
        unexpected = sorted({q['op'] for q in requests if q['op'] in GUARDED} - SIDE_EFFECTS.get(mode, set()))
        checks.append({'name': f'{mode}: no unexpected save, service, key, download or restore', 'pass': not unexpected, **({'unexpected': unexpected} if unexpected else {})})
        screens.append({'mode': mode, 'file': image.name, 'sha256': hashlib.sha256(image.read_bytes()).hexdigest()})
failed = [c for c in checks if not c['pass']]
(out / 'settings-receipt.json').write_text(json.dumps({'actualQmlSha256': qml_sources_digest(), 'runner': runner_kind(command), 'assertions': checks, 'screens': screens, 'platform': 'Qt offscreen software', 'syntheticBackend': True}, indent=2) + '\n')
print(json.dumps({'screens': len(screens), 'assertions': len(checks), 'failed': failed, 'output': str(out)}, ensure_ascii=False))
if failed or not checks: sys.exit(1)
