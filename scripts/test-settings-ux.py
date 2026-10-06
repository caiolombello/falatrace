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
from studio_fixture import copy_qml_siblings, qml_sources_digest, require_studio_command, runner_kind
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
first = mode in ('first-run', 'wizard-flow', 'wizard-test-audio', 'wizard-english', 'wizard-key-cancel', 'wizard-key-finish', 'wizard-download-cancel', 'wizard-reload')
values = {'callDetection.enabled': not first, 'callDetection.mode':'record', 'callDetection.enqueueOnStop':True, 'callDetection.dryRun':False,
          'callDetection.entryDebounceSeconds':5, 'callDetection.exitTimeoutSeconds':15, 'callDetection.networkSampleSeconds':5,
          'callDetection.apps.slack':True,'callDetection.apps.zen':True,'callDetection.apps.helium':True,'callDetection.apps.chromium':True,
          'callDetection.apps.firefox':True,'callDetection.apps.zoom':True,'callDetection.apps.discord':False,
          'backend': 'simple' if first or mode == 'legacy' else 'gpu-screen-recorder','recordingsDir':'/home/synthetic/Videos/Recordings','capture.audioSource':'both',
          'capture.microphone':'default','capture.desktop':'default','capture.profile':'standard','capture.encoder':'gpu','capture.framerate':30,
          'capture.startupTimeoutSeconds':90,'features.namingTemplate':'YYYY-MM-DD_HH-mm_[title]',
          'obs.enabled':False,'obs.autoLaunch':False,'obs.host':'127.0.0.1','obs.port':4455,
          'transcription.provider':'whisper-cpp' if first else 'openai','transcription.language':'auto','transcription.expectedLanguages':[],'transcription.openaiPrompt':'Termos: FalaTrace' if mode == 'tab-processing' else '',
          'transcription.openaiModel':'gpt-transcribe','transcription.geminiModel':'gemini-3.5-transcribe','transcription.whisperCpp.command':'whisper-cli',
          'transcription.whisperCpp.modelPath':'/home/synthetic/model.bin','transcription.whisperCpp.threads':8,
          'summary.provider':'ollama' if first else 'openai','summary.ollamaUrl':'http://127.0.0.1:11434','summary.ollamaModel':'qwen3.5:9b','summary.openaiModel':'gpt-6-luna',
          'summary.maxInputCharacters':24000,'processing.defaultTarget':'local','processing.autoEnqueue':not first,'processing.syncIntervalMinutes':5,
          'processing.notifyOnCompletion':True,'remote.host':'worker.lan' if mode == 'integrations' else 'worker.example.invalid','remote.user':'synthetic','remote.port':22,
          'remote.identityFile':None,'remote.archiveDir':'~/Videos/RecordingArchive','archive.enabled':False,'archive.vaio':True,'archive.proton':True,
          'archive.syncIntervalMinutes':5,'proton.enabled':False,'proton.targetFolder':'/my-files/RecordingArchive','proton.policy':'artifacts',
          's3.enabled':False,'s3.bucket':'','s3.region':'us-east-1','s3.prefix':'recordings/','s3.profile':None,
          'timesheet.enabled':False,'timesheet.automaticFromCalls':False,'timesheet.aiClassification':False,'timesheet.aiModel':'gpt-6-luna',
          'timesheet.readyConfidence':0.8,'timesheet.contextPath':'/home/synthetic/timesheet-context.json','aiContext.enabled':False,'aiContext.autoBuild':True,
          'aiContext.maxMeetingsPerClient':12,'aiContext.maxCharactersPerClient':18000,'calendar.enabled':False,
          'gnome.framerate':30,'gnome.drawCursor':True,'gnome.audioSource':'both','visualReview.maxInferences':24,'visualReview.maxPreviews':16,
          'studio.language':'en' if mode in ('english', 'wizard-english') else 'auto',
          'retention.localCompletedWorkDays':7,'retention.remoteIncomingDays':2,'retention.remoteResultsDays':30,'retention.remoteFailuresDays':30}
revision = 'a' * 64
details = [{'name':'OPENAI_API_KEY','source':'missing','sessionOnly':mode == 'keys','shadowsStudioKey':False,'savedInStudio':False},
           {'name':'GEMINI_API_KEY','source':'missing','sessionOnly':False,'shadowsStudioKey':False,'savedInStudio':False},
           {'name':'RECORDING_CLI_OBS_PASSWORD','source':'missing','sessionOnly':False,'shadowsStudioKey':False,'savedInStudio':False}]
def credentials(): return {'openai':details[0]['source'],'gemini':'missing','details':details,'files':[],'managerEnvironment':'unavailable'}
def settings(): return {'revision':revision,'exists':not first,'values':values,'apps':apps,'nullable':['remote.user','remote.identityFile','s3.profile'],
    'emptyAllowed':['transcription.openaiPrompt','s3.bucket','s3.prefix'],
    'readOnly':{'backendOutsideList':'simple' if values['backend'] == 'simple' else None,'backendExplicit':not first,'obsEnabled':False,
                'remoteConfigured':mode == 'integrations','summaryLocal':True,'visualPolicyDeclared':False,'legacyApiKeyInConfig':False,'obsPasswordInConfig':False},
    'credentials':credentials()}
timer = {'installed':False,'enabled':False,'active':False,'outdated':False,'nextRunAt':None,'lastResult':None}
services = {'calls':{'installed':not first,'enabled':not first,'active':not first,'outdated':False,'staleConfig':mode == 'services'},
            'tray':{'installed':True,'enabled':True,'active':True,'outdated':False,'staleConfig':False},'sync':dict(timer),'archive':dict(timer),'backup':dict(timer)}
catalog = {'whisper':{'directory':'/home/synthetic/models','source':'https://huggingface.co/','models':[
    {'id':'tiny','file':'ggml-tiny.bin','bytes':77691713,'sha256':'0'*64,'quality':'Muito rápido.','installed':False,'selected':False,'path':'/home/synthetic/models/ggml-tiny.bin'},
    {'id':'large-v3-turbo-q5_0','file':'ggml-large-v3-turbo-q5_0.bin','bytes':574041195,'sha256':'1'*64,'quality':'Padrão.','recommended':True,'installed':False,'selected':False,'path':'/home/synthetic/models/ggml-large-v3-turbo-q5_0.bin'}]},
    'ollama':{'url':'http://127.0.0.1:11434','loopback':True,'reachable':True,'installed':['qwen3.5:9b'],'configured':'qwen3.5:9b'}}
log = []; cancelled = False
for line in sys.stdin:
    r = json.loads(line); op = r['op']; p = r.get('payload', {})
    logged = dict(p)
    # Keep only a digest of credential values in the receipt.
    if 'value' in logged: logged['value'] = 'sha256:' + hashlib.sha256(logged['value'].encode()).hexdigest()
    log.append({'op':op,'payload':logged}); open(receipt,'w').write(json.dumps(log))
    if op == 'settings-read': v = settings()
    elif op == 'settings-diagnose':
        # Like the bridge, the checks follow the unsaved choices the assistant sends.
        summary = p.get('changes', {}).get('summary.provider', values['summary.provider'])
        v = {'checks':[{'id':'ffmpeg','label':'FFmpeg','status':'ok','detail':'Encontrado.'},
                       {'id':'whisper-model','label':'Modelo do Whisper','status':'missing','detail':'Não encontrado.','action':'whisper-model'},
                       {'id':'ollama','label':'Ollama','status':'warning','action':'ollama-model','detail':'Ollama respondeu, mas o modelo qwen3.5:9b não está instalado.'} if summary == 'ollama'
                       else {'id':'summary-key','label':'Resumo · OPENAI_API_KEY','status':'missing','detail':'Chave não encontrada.'}],
             'automation':[{'id':'automatic-backend','label':'Gravação automática','status':'missing','detail':'Usa o OBS desativado.','action':'capture'}] if mode == 'services' else [],
             'audio':{'devices':[{'name':'alsa_input.synthetic-mic','description':'Microfone sintético','monitor':False},
                                 {'name':'alsa_output.synthetic.monitor','description':'Monitor sintético','monitor':True}],
                      'defaultMicrophone':'alsa_input.synthetic-mic','defaultDesktop':'alsa_output.synthetic.monitor'},
             'services':None if mode in ('wizard-disable-unknown', 'services-unknown') else services,'recording':{'selectedBackend':'gpu-screen-recorder','blockedReason':None,'warnings':[],'session':None,'capabilities':{'gpuRecorder':True,'ffmpeg':True,'obsLauncher':False,'sessionType':'wayland'}},
             'automatic':None,'credentials':credentials()}
    elif op == 'settings-save':
        values.update(p['changes']); revision = 'b' * 64
        v = dict(settings(), saved=True, changed=list(p['changes']), backupCreated=not first, cleanupPending=False, needsReload=False, prunedBackups=0)
        # Published, but the reread failed: no values come back.
        if mode == 'wizard-reload': v = {'saved':True, 'changed':list(p['changes']), 'backupCreated':False, 'cleanupPending':False, 'needsReload':True, 'prunedBackups':0}
    elif op == 'settings-service':
        services['calls']['staleConfig'] = False
        if p['action'] == 'sync-apply': services['sync'].update({'installed':True,'enabled':True,'active':True,'nextRunAt':'2026-10-05T12:00:00.000Z'})
        v = {'action':p['action'],'services':services}
    elif op == 'settings-secret-set' and mode == 'wizard-key-fail':
        print(json.dumps({'id':r['id'],'ok':False,'error':'secrets.env tem permissões amplas demais.'}), flush=True); continue
    elif op == 'settings-secret-set':
        details[0].update({'source':'secrets.env','savedInStudio':True,'sessionOnly':False}); v = {'name':p['name'],'saved':True,'credentials':credentials()}
        # Saved, but the status could not be read again.
        if mode == 'keys-refresh': v = {'name':p['name'],'saved':True,'needsReload':True}
    elif op == 'settings-secret-remove':
        details[0].update({'source':'missing','savedInStudio':False}); v = {'name':p['name'],'removed':True,'credentials':credentials()}
    elif op == 'settings-secret-test': v = {'provider':p['service'],'status':'ok','source':'secrets.env','detail':'Chave aceita pelo provedor. O teste não envia áudio nem texto.'}
    elif op == 'settings-model-catalog': v = catalog
    elif op in ('settings-model-download', 'settings-model-status'):
        v = {'kind':p['kind'],'id':p['model'],'state':'running','receivedBytes':1048576,'totalBytes':77691713}
        if cancelled: v.update({'state':'failed','error':'O download foi interrompido. Tente novamente.'})
    elif op == 'settings-model-cancel': cancelled = True; v = {'kind':p['kind'],'id':p['model'],'cancelled':True}
    elif op == 'settings-backups': v = {'backups':[{'name':'config.json.bak-0b8c3a0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e','modifiedAt':'2026-10-04T10:00:00.000Z','bytes':2048,'valid':True}]}
    elif op == 'settings-restore':
        v = {'restored':p['backup'],'backupCreated':True,'prunedBackups':0,'settings':settings()}
        if mode == 'restore-reload': v = {'restored':p['backup'],'backupCreated':True,'prunedBackups':0,'needsReload':True}
    elif op == 'settings-remote-check': v = {'ok':True,'host':'worker','commands':[{'name':'ffmpeg','ok':True},{'name':'whisper-cli','ok':False}],'disk':'/dev/sda1 100G 10G 90G 10% /home'}
    elif op == 'settings-obs-check': v = {'ok':False,'detail':'O OBS não respondeu.'}
    elif op == 'settings-audio-test': v = {'seconds':5,'tracks':[{'label':'Microfone','hasSignal':True,'peakDb':-12}],'warnings':[]}
    elif op == 'capture-status': v = {'active':False,'paused':False,'audio':{'configured':False}}
    elif op in ('list','list-cached','jobs-list'): v = {'items':[]}
    elif op == 'ux-capabilities': v = {'mockFrames':False,'realFrames':False}
    else:
        print(json.dumps({'id':r['id'],'ok':False,'error':'Operação recusada no fixture.'}), flush=True); continue
    print(json.dumps({'id':r['id'],'ok':True,'result':v}), flush=True)
'''

# mode: (action at 600 ms, assertions at 1500 ms, follow-up at 2300 ms, final at 3100 ms)
MODES = {
    'first-run': ('', 'check("first use opens the assistant, not settings", setupWizard.visible && !settingsDialog.visible && setupWizard.step===0); check("continuing needs the consent acknowledgment", !wizardConsentGate()); check("assistant read the configuration", !!setupWizard.data.revision)', '', ''),
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
    'tab-calls': ('settingsDialog.open()', 'check("settings loaded", !!settingsData.revision && !settingsHasChanges()); check("ten sections", settingsDialog.sections.length===10); check("automatic backend status follows the draft", settingsDialog.automaticBackendText().indexOf("tela e áudio")>=0)', '', ''),
    'tab-capture': ('settingsDialog.open(); settingsTabs.currentIndex=1', 'check("devices listed from diagnose", settingsDeviceOptions(false).some(function(o){return o.value==="alsa_input.synthetic-mic"}) && settingsDeviceOptions(true).length===2)', '', ''),
    'legacy': ('settingsDialog.open(); settingsTabs.currentIndex=0', 'check("legacy backend explained as OBS for automatic recording", settingsDialog.automaticBackendText().indexOf("OBS")>=0 && !settingsDialog.automaticBackendOk())', '', ''),
    'tab-processing': ('settingsDialog.open(); settingsTabs.currentIndex=2', 'settingsDialog.applyPreset("local"); check("preset changes providers in the draft", settingsChanges()["transcription.provider"]==="whisper-cpp" && settingsChanges()["summary.provider"]==="ollama"); '
                       'setSettingsField("transcription.openaiPrompt",""); check("a cleared vocabulary is saved as empty text", settingsChanges()["transcription.openaiPrompt"]===""); '
                       'setSettingsField("summary.ollamaModel",""); check("a cleared required field stays an unfinished edit", !Object.prototype.hasOwnProperty.call(settingsChanges(),"summary.ollamaModel"))', '', ''),
    'keys': ('settingsDialog.open(); settingsTabs.currentIndex=3', 'check("session-only key explained", settingsDialog.secretSourceText(settingsData.credentials.details[0]).indexOf("só no ambiente desta sessão")>=0); settingsDialog.saveSecret("OPENAI_API_KEY","sk-synthetic-ui-key")',
             'check("saved key reported by source only", settingsData.credentials.details[0].savedInStudio===true && settingsNotice.indexOf("arquivo privado")>=0); settingsDialog.testSecret("openai")', 'check("key test result shown", !!settingsDialog.keyTests.openai && settingsDialog.keyTests.openai.status==="ok")'),
    'keys-refresh': ('settingsDialog.open(); settingsTabs.currentIndex=3', 'settingsDialog.saveSecret("OPENAI_API_KEY","sk-synthetic-refresh-key")',
                     'check("a saved key whose status could not be read again is reported as saved", settingsError==="" && settingsNotice.indexOf("arquivo privado")>=0 && settingsNotice.indexOf("releia")>=0)', ''),
    'wizard-download-finish': ('setupWizard.open(); setupWizard.consentAck=true; setupWizard.applyMonitor=false; setupWizard.applyTimer=false',
                               'setupWizard.request("settings-model-download",{kind:"whisper",model:"large-v3-turbo-q5_0",consent:true})',
                               'setupWizard.set("processing.notifyOnCompletion", false); setupWizard.step=4; setupWizard.finish(); check("Finish waits while a model download runs", setupWizard.whisperDownloadRunning() && setupWizard.step===4 && !setupWizard.hasPending("settings-save") && setupWizard.error!==""); setupWizard.cancelDownload("whisper","large-v3-turbo-q5_0")',
                               'check("once the download stops, Finish is available again", !setupWizard.whisperDownloadRunning()); setupWizard.finish()'),
    'wizard-key-fail': ('setupWizard.open(); setupWizard.consentAck=true',
                        'setupWizard.applyPreset("cloud"); setupWizard.useKey("sk-synthetic-wizard-key"); setupWizard.step=4; setupWizard.finish()',
                        'check("a failed key write keeps the assistant on review with the key and applies no service", setupWizard.step===4 && setupWizard.error!=="" && setupWizard.pendingKey!=="" && !setupWizard.hasPending("settings-service"))', ''),
    'wizard-download-pending': ('setupWizard.open(); setupWizard.consentAck=true; setupWizard.applyMonitor=false; setupWizard.applyTimer=false',
                                'setupWizard.set("processing.notifyOnCompletion", false); setupWizard.step=4; setupWizard.request("settings-model-download",{kind:"whisper",model:"large-v3-turbo-q5_0",consent:true}); setupWizard.finish(); check("Finish waits for a download request that has not been answered", setupWizard.step===4 && setupWizard.error!=="" && !setupWizard.hasPending("settings-save"))', '', ''),
    'models': ('settingsDialog.open(); settingsDialog.goToSection(4)', 'check("catalog loaded on demand", !!settingsDialog.catalog.whisper && settingsDialog.catalog.whisper.models.length===2); settingsDialog.confirmDownload="whisper:tiny"; settingsDialog.startDownload("whisper","tiny")',
               'check("download progress tracked", !!settingsDialog.downloads["whisper:tiny"] && settingsDialog.downloads["whisper:tiny"].state==="running"); settingsDialog.cancelDownload("whisper","tiny")',
               'check("cancelling refreshes the stopped download without an error", settingsError==="" && settingsDialog.downloads["whisper:tiny"].state==="failed")'),
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
}
# Requests each mode is expected to send; anything outside the list fails the journey.
SIDE_EFFECTS = {'save': {'settings-save'}, 'services': {'settings-service'}, 'wizard-flow': {'settings-save'}, 'backups': {'settings-restore'}, 'restore-reload': {'settings-restore'},
                'wizard-key-finish': {'settings-save', 'settings-secret-set'}, 'wizard-download-cancel': {'settings-model-download'},
                'wizard-reload': {'settings-save', 'settings-service'}, 'wizard-disable-monitor': {'settings-save', 'settings-service'},
                'wizard-disable-unknown': {'settings-save', 'settings-service'},
                'keys': {'settings-secret-set'}, 'models': {'settings-model-download'}, 'models-two': {'settings-model-download'},
                'keys-refresh': {'settings-secret-set'}, 'wizard-download-finish': {'settings-model-download', 'settings-save'},
                'wizard-key-fail': {'settings-save', 'settings-secret-set'}, 'wizard-download-pending': {'settings-model-download'}}
GUARDED = {'settings-save', 'settings-service', 'settings-secret-set', 'settings-secret-remove', 'settings-model-download', 'settings-restore'}

checks = []; screens = []
with tempfile.TemporaryDirectory(dir='/tmp', prefix='falatrace-settings-fixture-') as scratch:
    root = Path(scratch); nonce = secrets.token_hex(16)
    (root / '.falatrace-qa').write_text(nonce); (root / '.falatrace-qa').chmod(0o600)
    for name in ['home', 'runtime', 'config', 'state', 'data', 'cache', 'tmp']: (root / name).mkdir(mode=0o700)
    stub = root / 'bridge-stub.py'; stub.write_text(STUB); stub.chmod(0o700)
    for mode, (action, assertion, follow, final) in MODES.items():
        qml = root / mode; qml.mkdir()
        base = source.replace('../../docs/assets/', (repo / 'docs/assets').as_uri() + '/').rstrip()
        def timer(ms, body):
            return (f' Timer {{ interval: {ms}; running: true; repeat: false; onTriggered: {{ const a=[]; function check(name,pass){{a.push({{name:"{mode}: "+name,pass:!!pass}})}}; '
                    f'{body}; console.log("UX_ASSERTIONS "+JSON.stringify(a)) }} }}\n')
        helpers = ' function wizardConsentGate() { return setupWizard.step!==0 || setupWizard.consentAck }\n'
        extra = '\n' + helpers + f' Timer {{ interval: 600; running: true; repeat: false; onTriggered: {{ {action} }} }}\n' + timer(1500, assertion) + timer(2300, follow) + timer(3100, final)
        (qml / 'Main.qml').write_text(base[:-1] + extra + '}\n'); copy_qml_siblings(qml)
        image = out / f'settings-{mode}.png'; receipt_path = root / f'{mode}-requests.json'
        env = {'FALATRACE_QA_ISOLATED': '1', 'FALATRACE_QA_ROOT': str(root), 'FALATRACE_QA_NONCE': nonce,
               'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_STATE_HOME': str(root / 'state'), 'XDG_DATA_HOME': str(root / 'data'),
               'HOME': str(root / 'home'), 'XDG_RUNTIME_DIR': str(root / 'runtime'), 'XDG_CACHE_HOME': str(root / 'cache'),
               'TMPDIR': str(root / 'tmp'), 'LANG': 'C.UTF-8', 'PATH': '/usr/bin:/bin', 'QT_QPA_PLATFORM': 'offscreen',
               'QT_QUICK_BACKEND': 'software', 'RECORDING_DESKTOP_SOFTWARE_SMOKE': '1', 'RECORDING_DESKTOP_SMOKE_KEY': '',
               'RECORDING_DESKTOP_SNAPSHOT': str(image), 'RECORDING_DESKTOP_SNAPSHOT_MS': '3600',
               'FALATRACE_TEST_MODE': mode, 'FALATRACE_RECEIPT': str(receipt_path)}
        runpy.run_path(str(repo / 'scripts/qa-run.py'))['require_isolated'](env)
        r = subprocess.run([*command, str(qml), str(stub)], env=env, capture_output=True, text=True, timeout=40)
        (out / f'settings-{mode}.stderr').write_text(r.stderr)
        problems = [line for line in r.stderr.splitlines() if any(marker in line for marker in ('ReferenceError', 'TypeError', 'failed to load component', 'Unable to assign', 'is not a type', 'unavailable'))]
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
        if mode == 'models-two':
            polled = {q['payload'].get('model') for q in requests if q['op'] == 'settings-model-status'}
            checks.append({'name': 'models-two: every running download is polled', 'pass': {'tiny', 'large-v3-turbo-q5_0'} <= polled})
        if mode in ('wizard-disable-monitor', 'wizard-disable-unknown'):
            applied = [q['payload'] for q in requests if q['op'] == 'settings-service']
            checks.append({'name': f'{mode}: only the monitor is disabled', 'pass': applied == [{'action': 'calls-disable'}]})
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
