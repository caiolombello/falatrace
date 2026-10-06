import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Settings, organised in sections. The controller state (settingsData, settingsDraft,
// settingsDiag and the save/read functions) lives in Main.qml; the features added on top
// of it (keys, models, checks, backups, import/export) keep their state here.
FtDialog {
    id:settingsDialog; objectName:"settingsDialog"; title:t("Configurações")
    property alias settingsTabs: settingsTabs
    property alias backendChoice: backendChoice
    readonly property var sections: [
        { title: t("Gravação automática"), icon: "automation-play" },
        { title: t("Captura e áudio"), icon: "record" },
        { title: t("Processamento e IA"), icon: "spark" },
        { title: t("Chaves de API"), icon: "key" },
        { title: t("Modelos"), icon: "transcript" },
        { title: t("Integrações"), icon: "plug" },
        { title: t("Recursos opcionais"), icon: "clock" },
        { title: t("Avançado"), icon: "tools" },
        { title: t("Serviços e diagnóstico"), icon: "shield" },
        { title: t("Backups e transferência"), icon: "export" }
    ]
    readonly property int sectionServices: 8
    readonly property bool pickerAvailable: pickerLoader.status === Loader.Ready
    property var keyTests: ({})
    // The service whose key test is in flight, read from the pending request: a lost connection drops the
    // request and so never leaves the Test buttons locked.
    readonly property string keyTestPending: { const id = Object.keys(pending).find(function(key){ return pending[key].op === "settings-secret-test" && pending[key].settingsGeneration === settingsGeneration }); return id ? String(pending[id].service || "") : "" }
    // Derived from the requests in flight, so a lost connection never leaves the key fields locked.
    readonly property bool secretBusy: hasSettingsPending("settings-secret-set") || hasSettingsPending("settings-secret-remove")
    property var remoteCheck: null
    property var obsCheck: null
    property var audioTest: null
    property var backups: []
    property var catalog: ({})
    property var downloads: ({})
    property string confirmDownload: ""
    property string confirmRestore: ""
    property string importSummary: ""
    anchors.centerIn:parent; width:Math.min(window.width-48,980); height:Math.min(window.height-48,780); modal:true
    closePolicy:hasSettingsPending("settings-save")||hasSettingsPending("settings-service")?Popup.NoAutoClose:Popup.CloseOnEscape
    onOpened:{settingsError="";settingsNotice="";resetExtras();settingsTabs.currentIndex=settingsFirstRun?0:settingsTabs.currentIndex;loadSettings(true);settingsTabs.forceActiveFocus(Qt.TabFocusReason)}
    onClosed:{languagePreview="";settingsGeneration+=1;settingsDraft=({});settingsData=({});settingsDiag=({});settingsFirstRun=false;resetExtras();onboardingButton.forceActiveFocus(Qt.TabFocusReason)}

    function resetExtras() { keyTests=({}); remoteCheck=null; obsCheck=null; audioTest=null; confirmDownload=""; confirmRestore=""; importSummary="" }
    function draft(field) { return settingsDraft[field] }
    function goToSection(index) { settingsTabs.currentIndex = index; sectionLoaded(index) }
    function sectionLoaded(index) {
        if (!backend.available) return
        if (index === 4 && !hasSettingsPending("settings-model-catalog")) requestCatalog()
        if (index === 9 && !hasSettingsPending("settings-backups")) send("settings-backups", "")
    }
    function choosePath(mode, title, start, done) { if (pickerLoader.item) pickerLoader.item.open(mode, title, start, done) }
    function fieldChanged(field) { return Object.prototype.hasOwnProperty.call(settingsChanges(), field) }

    // Keys
    function saveSecret(name, value) { if (!value.trim()) return; settingsError = ""; settingsNotice = ""; send("settings-secret-set", "", { name: name, value: value.trim() }) }
    function removeSecret(name) { settingsError = ""; settingsNotice = ""; send("settings-secret-remove", "", { name: name }) }
    function testSecret(service) { const next = Object.assign({}, keyTests); delete next[service]; keyTests = next; send("settings-secret-test", "", { service: service }, { service: service }) }
    function secretSourceText(report) {
        if (!report || !report.name) return ""
        if (report.source === "missing") return report.sessionOnly ? t("Existe só no ambiente desta sessão; o processamento em segundo plano não a recebe. Salve-a aqui.") : t("Nenhuma chave encontrada.")
        const where = report.source === "secrets.env" ? t("Salva pelo Studio, em arquivo privado.") : report.source === "worker.env" ? t("Vem de worker.env.") : report.source === "calls.env" ? t("Vem de calls.env.") : report.source === "environment" ? t("Vem do ambiente do systemd do usuário.") : report.source === "config" ? t("Está no config.json, formato antigo: salve-a aqui para tirá-la de lá.") : ""
        return where + (report.shadowsStudioKey ? t(" Ela tem prioridade sobre a chave salva pelo Studio.") : "")
    }

    // Models
    // Stops the transient unit; the status poll that follows uses the model the bridge echoes back.
    function cancelDownload(kind, id) { send("settings-model-cancel", "", { kind: kind, model: id }) }
    function downloadKey(kind, id) { return kind + ":" + id }
    // A Whisper model is in use only while transcription runs on this computer.
    function modelInUse(path) { return path === settingsDraft["transcription.whisperCpp.modelPath"] && settingsDraft["transcription.provider"] === "whisper-cpp" }
    // Ollama is listed and pulled into at the draft's address, which may not be saved yet, so the model lands
    // where processing will look for it; the download waits for a list read from that same address.
    function draftOllamaUrl() { return String(settingsDraft["summary.ollamaUrl"] || (settingsData.values || {})["summary.ollamaUrl"] || "") }
    function requestCatalog() { send("settings-model-catalog", "", draftOllamaUrl() ? { ollamaUrl: draftOllamaUrl() } : ({})) }
    function ollamaCatalogCurrent() { return !!catalog.ollama && catalog.ollama.url === draftOllamaUrl() }
    function startDownload(kind, id) {
        confirmDownload = ""; settingsError = ""
        if (kind !== "ollama") { send("settings-model-download", "", { kind: kind, model: id, consent: true }); return }
        if (!ollamaCatalogCurrent()) { settingsError = t("Atualize a lista para baixar no Ollama do endereço escolhido."); return }
        send("settings-model-download", "", { kind: kind, model: id, consent: true, ollamaUrl: catalog.ollama.url })
    }
    // One status request in flight per download, so concurrent downloads all progress.
    function statusPending(key) { return Object.keys(pending).some(function(id){ return pending[id].op === "settings-model-status" && pending[id].downloadKey === key && pending[id].settingsGeneration === settingsGeneration }) }
    function pollDownloads() {
        for (const key in downloads) {
            const state = downloads[key]
            if (state && state.state === "running" && !statusPending(key)) send("settings-model-status", "", { kind: state.kind, model: state.id }, { downloadKey: key })
        }
    }
    function downloadProgress(state) {
        if (!state || !state.totalBytes) return state && state.state === "running" ? t("Baixando…") : ""
        return Math.floor(100 * state.receivedBytes / state.totalBytes) + t("% de ") + mib(state.totalBytes)
    }
    function mib(bytes) { return bytes >= 1024 * 1024 * 1024 ? (bytes / 1024 / 1024 / 1024).toFixed(1) + t(" GiB") : Math.round(bytes / 1024 / 1024) + t(" MiB") }

    // Presets and derived labels
    function applyPreset(name) {
        if (name === "local") { setSettingsField("transcription.provider", "whisper-cpp"); setSettingsField("summary.provider", "ollama"); setSettingsField("summary.ollamaUrl", "http://127.0.0.1:11434"); setSettingsField("processing.defaultTarget", "local") }
        else if (name === "hybrid") { setSettingsField("transcription.provider", "whisper-cpp"); setSettingsField("summary.provider", "openai"); setSettingsField("processing.defaultTarget", "local") }
        else { setSettingsField("transcription.provider", "openai"); setSettingsField("summary.provider", "openai"); setSettingsField("processing.defaultTarget", "local") }
        settingsNotice = t("Predefinição aplicada ao rascunho. Revise e salve.")
    }
    // What automatic recording would do with the draft: off, notify, none, obs-disabled, audio, gpu-screen-recorder or obs.
    function automaticBackendState() {
        const mode = draft("callDetection.mode"), backendValue = draft("backend")
        if (draft("callDetection.enabled") !== true) return "off"
        if (mode === "notify-only") return "notify"
        const automatic = mode === "obs" ? "obs" : (backendValue === "audio" || backendValue === "gpu-screen-recorder") ? backendValue : ["obs", "obs-ws", "obs-cli", "simple"].indexOf(backendValue) >= 0 ? "obs" : ""
        if (!automatic) return "none"
        if (automatic === "obs" && draft("obs.enabled") !== true) return "obs-disabled"
        return automatic
    }
    function automaticBackendText() {
        const state = automaticBackendState()
        if (state === "off") return t("A gravação automática está desligada.")
        if (state === "notify") return t("Só notifica: nenhuma gravação começa sozinha.")
        if (state === "none") return t("O backend atual não grava automaticamente. Escolha um em Captura e áudio.")
        if (state === "obs-disabled") return t("Do jeito atual, a gravação automática usaria o OBS, que está desativado. Escolha Só áudio ou Tela e áudio em Captura e áudio, ou ative o OBS em Integrações.")
        return state === "audio" ? t("As chamadas detectadas serão gravadas com só áudio.") : state === "gpu-screen-recorder" ? t("As chamadas detectadas serão gravadas com tela e áudio pelo GPU Screen Recorder.") : t("As chamadas detectadas serão gravadas com o OBS.")
    }
    function automaticBackendOk() { return ["none", "obs-disabled"].indexOf(automaticBackendState()) < 0 }
    function remoteConfiguredDraft() {
        const host = String(draft("remote.host") || "")
        return !!host && !/(\.invalid|\.example|\.test|\.localhost)$/i.test(host) && !/(^|\.)example\.(com|net|org)$/i.test(host)
    }
    function serviceAction(action) { runSettingsService(action) }
    function checkAction(action) {
        if (action === "keys") goToSection(3)
        else if (action === "capture") goToSection(1)
        else if (action === "remote") goToSection(5)
        else if (action === "whisper-model" || action === "ollama-model") goToSection(4)
        else if (action) runSettingsService(action)
    }
    function checkActionLabel(action) {
        return action === "keys" ? t("Abrir Chaves de API") : action === "capture" ? t("Abrir Captura e áudio") : action === "remote" ? t("Abrir Integrações")
            : action === "whisper-model" || action === "ollama-model" ? t("Abrir Modelos") : action === "sync-apply" ? t("Ativar processamento em segundo plano")
            : action === "archive-apply" ? t("Ativar timer de arquivo") : action === "backup-apply" ? t("Ativar timer de backup")
            : action === "calls-apply" ? t("Aplicar o monitor de chamadas") : ""
    }
    function timerText(timer) {
        if (!timer) return ""
        if (!timer.installed) return t("Não instalado.")
        // Enabled but not active (stopped by hand or failed to start): nothing runs.
        return (!timer.enabled ? t("Instalado, mas desativado") : timer.active ? t("Ativo") : t("Ativado, mas parado")) + (timer.nextRunAt ? t(". Próxima execução: ") + new Date(timer.nextRunAt).toLocaleString(Qt.locale(), Locale.ShortFormat) : "") + (timer.lastResult && timer.lastResult !== "success" ? t(". Última execução: ") + timer.lastResult : "") + (timer.outdated ? t(". Usa um intervalo ou pasta antigos: aplique de novo.") : ".")
    }
    function timerStatus(timer) { return !timer ? "skipped" : !timer.installed ? "missing" : timer.enabled && timer.active && !timer.outdated ? "ok" : "warning" }
    // Disabling a monitor that is not there changes nothing: only a status that shows it absent turns this off.
    function canDisableMonitor() { const calls = settingsDiag.services && settingsDiag.services.calls; return !(calls && calls.installed === false) }

    function handleExtra(request, message) {
        const result = message.result
        if (request.op === "settings-secret-set" || request.op === "settings-secret-remove") {
            if (!message.ok) { settingsError = message.error; return }
            // The key file changed even when its status could not be read again: say so and ask for a reread.
            if (result.credentials) settingsData = Object.assign({}, settingsData, { credentials: result.credentials })
            settingsNotice = (request.op === "settings-secret-set" ? t("Chave salva em arquivo privado. Ela vale para o processamento em segundo plano a partir de agora.") : result.removed ? t("Chave removida do arquivo do Studio.") : t("Não havia chave salva pelo Studio com esse nome."))
                + (result.credentials ? "" : t(" Não foi possível atualizar o estado das chaves; releia a configuração para conferir."))
            runSettingsDiagnose()
        } else if (request.op === "settings-secret-test") {
            const service = request.service
            const next = Object.assign({}, keyTests)
            next[service] = message.ok ? result : { status: "unreachable", detail: message.error }
            keyTests = next
        } else if (request.op === "settings-remote-check") {
            remoteCheck = message.ok ? result : { ok: false, hint: message.error }
        } else if (request.op === "settings-obs-check") {
            obsCheck = message.ok ? result : { ok: false, detail: message.error }
        } else if (request.op === "settings-audio-test") {
            audioTest = message.ok ? result : { error: message.error }
        } else if (request.op === "settings-backups") {
            backups = message.ok ? result.backups : []
            if (!message.ok) settingsError = message.error
        } else if (request.op === "settings-restore") {
            confirmRestore = ""
            if (!message.ok) { settingsError = message.error; return }
            // Restored even when the reread failed: read it again instead of keeping the old values.
            if (result.settings) { settingsData = result.settings; settingsDraft = Object.assign({}, result.settings.values) }
            else loadSettings(false)
            settingsNotice = t("Configuração restaurada. A anterior também foi guardada como cópia de segurança. Aplique os serviços para valer.")
            send("settings-backups", ""); runSettingsDiagnose(); refreshLibraryAfterSettings()
        } else if (request.op === "settings-export") {
            settingsNotice = message.ok ? t("Configuração exportada sem chaves para ") + result.exported + "." : ""
            if (!message.ok) settingsError = message.error
        } else if (request.op === "settings-import-read") {
            if (!message.ok) { settingsError = message.error; return }
            let applied = 0
            for (const field in result.values) { setSettingsField(field, result.values[field]); applied += 1 }
            importSummary = applied + t(" campo(s) carregado(s) no rascunho.") + (result.rejected.length ? t(" Valores inválidos ignorados: ") + result.rejected.join(", ") + "." : "") + (result.ignored.length ? t(" Itens que o Studio não edita foram ignorados: ") + result.ignored.slice(0, 8).join(", ") + (result.ignored.length > 8 ? "…" : "") + "." : "") + (result.credentialsIgnored ? t(" Chaves no arquivo foram ignoradas.") : "") + t(" Revise e salve.")
        } else if (request.op === "settings-model-catalog") {
            catalog = message.ok ? result : ({})
            if (!message.ok) settingsError = message.error
        } else if (request.op === "settings-model-download" || request.op === "settings-model-status") {
            if (!message.ok) { settingsError = message.error; return }
            const next = Object.assign({}, downloads)
            next[downloadKey(result.kind, result.id)] = result
            downloads = next
            if (result.state === "completed" || result.state === "failed") requestCatalog()
            if (result.state === "completed" && result.kind === "whisper" && result.path) {
                // Only local transcription takes the new model at once; with an external provider the audio
                // would still go there, so "Usar este modelo" switches both.
                if (settingsDraft["transcription.provider"] === "whisper-cpp") {
                    setSettingsField("transcription.whisperCpp.modelPath", result.path)
                    settingsNotice = t("Modelo baixado e conferido. Salve para usá-lo na transcrição.")
                } else settingsNotice = t("Modelo baixado e conferido. Para transcrever neste computador com ele, use “Usar este modelo” e salve.")
            }
        } else if (request.op === "settings-model-cancel") {
            // The pending entry holds no payload: poll the model the bridge reports as cancelled.
            if (!message.ok) { settingsError = message.error; return }
            send("settings-model-status", "", { kind: result.kind, model: result.id })
        }
    }

    Loader { id:pickerLoader; source:"FilePicker.qml"; active:settingsDialog.visible }
    Timer { interval:2000; repeat:true; running:settingsDialog.visible && Object.keys(settingsDialog.downloads).some(function(key){ return settingsDialog.downloads[key] && settingsDialog.downloads[key].state === "running" }); onTriggered:settingsDialog.pollDownloads() }

    component SectionPage: ScrollView {
        id:page
        default property alias content: pageColumn.data
        clip:true; contentWidth:availableWidth
        ColumnLayout { id:pageColumn; width:page.availableWidth; spacing:10 }
    }
    component StatusLine: Label {
        property bool good: true
        color:good?accent:warningColor; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true; font.pixelSize:12
    }

    contentItem:ColumnLayout { spacing:10
     Label { objectName:"settingsFirstRun"; visible:settingsFirstRun; text:t("Bem-vindo ao FalaTrace. Escolha quando gravar, o que capturar e onde processar. Nada é gravado ou enviado até você salvar e ativar."); textFormat:Text.PlainText; wrapMode:Text.WordWrap; color:accent; Layout.fillWidth:true }
     Label { objectName:"settingsError"; visible:!!settingsError; text:t(settingsError); textFormat:Text.PlainText; wrapMode:Text.WordWrap; color:errorColor; Layout.fillWidth:true; Accessible.name:text }
     Label { objectName:"settingsNotice"; visible:!!settingsNotice; text:t(settingsNotice); textFormat:Text.PlainText; wrapMode:Text.WordWrap; color:accent; Layout.fillWidth:true; Accessible.name:text }
     FtComboBox {
        visible:compactLayout; Layout.fillWidth:true
        model:settingsDialog.sections.map(function(section){ return section.title })
        currentIndex:settingsTabs.currentIndex
        onActivated:function(index){ settingsDialog.goToSection(index) }
        Accessible.name:t("Seção das configurações")
     }
     RowLayout { Layout.fillWidth:true; Layout.fillHeight:true; spacing:14
      ColumnLayout {
        id:settingsTabs; objectName:"settingsTabs"
        property int currentIndex: 0
        visible:!compactLayout; Layout.preferredWidth:226; Layout.fillHeight:true; Layout.alignment:Qt.AlignTop; spacing:2
        activeFocusOnTab:true
        Keys.onDownPressed:settingsDialog.goToSection(Math.min(settingsDialog.sections.length - 1, currentIndex + 1))
        Keys.onUpPressed:settingsDialog.goToSection(Math.max(0, currentIndex - 1))
        Accessible.role:Accessible.PageTabList; Accessible.name:t("Seções das configurações")
        Repeater {
            model:settingsDialog.sections
            Button {
                id:sectionButton
                required property var modelData
                required property int index
                Layout.fillWidth:true; implicitHeight:36; hoverEnabled:true; focusPolicy:Qt.NoFocus
                checked:settingsTabs.currentIndex === index
                onClicked:settingsDialog.goToSection(index)
                Accessible.role:Accessible.PageTab; Accessible.name:modelData.title
                contentItem:RowLayout { spacing:8
                    FtIcon { name:sectionButton.modelData.icon; tint:sectionButton.checked?accent:muted; size:16 }
                    Label { text:sectionButton.modelData.title; color:sectionButton.checked?ink:muted; font.weight:sectionButton.checked?Font.DemiBold:Font.Normal; elide:Text.ElideRight; Layout.fillWidth:true }
                }
                background:Rectangle { radius:8; color:sectionButton.checked?selectedSurface:sectionButton.hovered?hoverSurface:"transparent"; border.width:settingsTabs.activeFocus&&sectionButton.checked?2:0; border.color:accent }
            }
        }
        Item { Layout.fillHeight:true }
      }
      ColumnLayout { Layout.fillWidth:true; Layout.fillHeight:true; spacing:8
       Label { visible:!settingsData.revision; text:hasSettingsPending("settings-read")?t("Lendo configuração…"):t("Releia a configuração para editar."); color:muted; Layout.fillWidth:true }
       StackLayout {
        visible:!!settingsData.revision
        currentIndex:settingsTabs.currentIndex; Layout.fillWidth:true; Layout.fillHeight:true

        // 0 · Gravação automática
        SectionPage {
          RowLayout { Layout.fillWidth:true; spacing:8
            SettingsHint { text:t("Prefere um passo a passo? O assistente revisa captura, processamento e gravação automática e salva só o que você mudar.") }
            FtButton { text:t("Abrir o assistente"); compact:true; variant:"outline"; enabled:backend.available&&!settingsHasChanges(); onClicked:{ settingsDialog.close(); setupWizard.open() } }
          }
          SettingsCheck { objectName:"settingsCallsEnabled"; field:"callDetection.enabled"; text:t("Ativar a gravação automática de chamadas") }
          SettingsHint { text:t("Detecta quando um app usa o microfone ou a câmera. Não identifica o serviço, a aba nem quem participa; ditado ou teste de câmera também contam. Confirme a permissão das pessoas antes de gravar.") }
          SettingsChoice { field:"callDetection.mode"; label:t("Quando detectar uma chamada"); options:[{label:t("Só notificar"),value:"notify-only"},{label:t("Gravar automaticamente"),value:"record"}].concat(settingsDraft["obs.enabled"]===true||settingsDraft["callDetection.mode"]==="obs"?[{label:t("Controlar o OBS"),value:"obs"}]:[]) }
          StatusLine { objectName:"settingsAutomaticBackend"; text:settingsDialog.automaticBackendText(); good:settingsDialog.automaticBackendOk() }
          SettingsCheck { visible:settingsDraft["callDetection.mode"]==="obs"; field:"callDetection.enqueueOnStop"; text:t("No modo OBS, enfileirar a gravação quando a chamada terminar") }
          SettingsHint { text:t("Processar cada gravação depois da chamada segue a opção “Processar automaticamente cada gravação nova”, em Processamento e IA.") }
          SettingsSection { text:t("Navegadores") }
          GridLayout { columns:compactLayout?2:3; Layout.fillWidth:true; columnSpacing:12; rowSpacing:2
           Repeater { model:(settingsData.apps||[]).filter(function(a){return a.kind==="browser"})
            SettingsCheck { required property var modelData; field:"callDetection.apps."+modelData.id; text:modelData.label; Layout.fillWidth:true }
           }
          }
          SettingsSection { text:t("Apps de chamada") }
          GridLayout { columns:compactLayout?2:3; Layout.fillWidth:true; columnSpacing:12; rowSpacing:2
           Repeater { model:(settingsData.apps||[]).filter(function(a){return a.kind==="app"})
            SettingsCheck { required property var modelData; field:"callDetection.apps."+modelData.id; text:modelData.label+(modelData.defaultEnabled?"":t(" · opcional")); Layout.fillWidth:true }
           }
          }
          SettingsHint { text:t("Apps marcados como opcionais também levam ligações pessoais e ficam desligados até você ativar. Zoom, Meet e Teams na web são detectados pelo navegador.") }
          SettingsSection { text:t("Tempos") }
          SettingsNumber { field:"callDetection.entryDebounceSeconds"; label:t("Confirmar a chamada após (segundos)"); from:1; to:120 }
          SettingsNumber { field:"callDetection.exitTimeoutSeconds"; label:t("Encerrar após o app parar de usar o microfone (segundos)"); from:1; to:300 }
          SettingsHint { text:t("O monitor lê estas opções ao iniciar: depois de salvar, aplique-o em Serviços e diagnóstico.") }
        }

        // 1 · Captura e áudio
        SectionPage {
          SettingsChoice { id:backendChoice; objectName:"settingsBackend"; field:"backend"; label:t("O que gravar"); options:[{label:t("Só áudio (FFmpeg)"),value:"audio"},{label:t("Tela e áudio (GPU Screen Recorder)"),value:"gpu-screen-recorder"},{label:t("OBS (cena configurada no OBS)"),value:"obs"}] }
          SettingsHint { visible:!!(settingsData.readOnly&&settingsData.readOnly.backendOutsideList)&&!settingsDialog.fieldChanged("backend"); color:warningColor; text:t("O backend atual (“")+(settingsData.readOnly?settingsData.readOnly.backendOutsideList:"")+t("”) é legado. Na gravação automática ele usa o OBS; nas capturas manuais depende da área de trabalho. Escolha um dos três acima.") }
          SettingsHint { visible:settingsDraft["backend"]==="obs"&&settingsDraft["obs.enabled"]!==true; color:warningColor; text:t("Ative e configure o OBS em Integrações para usar esta opção.") }
          SettingsChoice { field:"capture.audioSource"; label:t("Fontes de áudio"); options:[{label:t("Microfone e áudio do sistema"),value:"both"},{label:t("Só microfone"),value:"microphone"},{label:t("Só áudio do sistema"),value:"desktop"},{label:t("Sem áudio"),value:"none"}] }
          SettingsChoice { field:"capture.microphone"; label:t("Microfone"); options:settingsDeviceOptions(false) }
          SettingsChoice { field:"capture.desktop"; label:t("Áudio do sistema (monitor da saída)"); options:settingsDeviceOptions(true) }
          RowLayout { Layout.fillWidth:true
           SettingsHint { text:settingsDiag.audio?(settingsDiag.audio.devices||[]).length+t(" dispositivos encontrados."):(hasSettingsPending("settings-diagnose")?t("Procurando dispositivos…"):t("Lista de dispositivos indisponível; “Padrão do sistema” segue o PipeWire.")) }
           FtButton { text:t("Atualizar dispositivos"); variant:"outline"; compact:true; enabled:backend.available&&!hasSettingsPending("settings-diagnose"); onClicked:runSettingsDiagnose() }
          }
          SettingsSection { text:t("Teste de áudio") }
          SettingsHint { text:t("Grava alguns segundos com as fontes salvas, mede o nível de cada faixa e apaga o arquivo. Nada é enviado nem entra na biblioteca. Fale e toque algum som durante o teste.") }
          RowLayout { Layout.fillWidth:true; spacing:8
           FtButton { objectName:"settingsAudioTest"; text:hasSettingsPending("settings-audio-test")?t("Gravando 5 s…"):t("Testar áudio (5 s)"); iconName:"record"; compact:true; enabled:backend.available&&!hasSettingsPending("settings-audio-test")&&!settingsHasChanges(); onClicked:{ settingsDialog.audioTest=null; send("settings-audio-test","",{seconds:5}) } }
           SettingsHint { visible:settingsHasChanges(); text:t("Salve antes de testar: o teste usa a configuração salva.") }
          }
          Repeater { model:settingsDialog.audioTest&&settingsDialog.audioTest.tracks?settingsDialog.audioTest.tracks:[]
           RowLayout { required property var modelData; Layout.fillWidth:true; spacing:10
            Label { text:modelData.label; color:ink; Layout.preferredWidth:150 }
            Rectangle { Layout.fillWidth:true; implicitHeight:10; radius:5; color:surfaceAlt; border.width:1; border.color:divider
             Rectangle { height:parent.height; radius:5; width:parent.width*Math.max(0,Math.min(1,modelData.peakDb===null?0:(modelData.peakDb+60)/60)); color:modelData.hasSignal?accent:warningColor }
            }
            Label { text:modelData.peakDb===null?t("silêncio"):Math.round(modelData.peakDb)+" dB"; color:modelData.hasSignal?muted:warningColor; Layout.preferredWidth:70 }
           }
          }
          Repeater { model:settingsDialog.audioTest?(settingsDialog.audioTest.warnings||[]):[]; StatusLine { required property var modelData; text:modelData; good:false } }
          StatusLine { visible:!!(settingsDialog.audioTest&&settingsDialog.audioTest.error); text:settingsDialog.audioTest&&settingsDialog.audioTest.error?t(settingsDialog.audioTest.error):""; good:false }
          StatusLine { visible:!!(settingsDialog.audioTest&&settingsDialog.audioTest.tracks&&!(settingsDialog.audioTest.warnings||[]).length); text:t("Todas as faixas tiveram sinal."); good:true }
          SettingsSection { text:t("Vídeo") }
          SettingsChoice { visible:settingsDraft["backend"]==="gpu-screen-recorder"; field:"capture.encoder"; label:t("Codificação de vídeo"); options:[{label:t("GPU (recomendado)"),value:"gpu"},{label:"CPU",value:"cpu"}] }
          SettingsChoice { visible:settingsDraft["backend"]==="gpu-screen-recorder"; field:"capture.profile"; label:t("Qualidade do vídeo"); options:[{label:t("Padrão"),value:"standard"},{label:t("Leve para chamadas (menor resolução e fps)"),value:"call-light"}] }
          SettingsNumber { visible:settingsDraft["backend"]==="gpu-screen-recorder"; field:"capture.framerate"; label:t("Quadros por segundo"); from:1; to:60 }
          SettingsHint { visible:settingsDraft["backend"]!=="gpu-screen-recorder"; text:t("As opções de vídeo valem para Tela e áudio (GPU Screen Recorder). No OBS, o vídeo segue a cena configurada nele.") }
          SettingsSection { text:t("Pasta das gravações") }
          SettingsText { field:"recordingsDir"; label:t("Pasta das gravações"); placeholder:t("/home/voce/Videos/Recordings"); picker:"folder" }
          SettingsHint { visible:settingsDialog.fieldChanged("recordingsDir"); color:warningColor; text:t("As gravações da pasta atual não serão movidas. As que ainda não foram processadas deixam de aparecer na biblioteca até você voltar a esta pasta. Depois de salvar, aplique de novo o monitor e o processamento em segundo plano em Serviços.") }
          SettingsHint { visible:!settingsDialog.fieldChanged("recordingsDir"); text:t("Use um caminho absoluto. Se mudar a pasta, aplique de novo o monitor e o processamento em segundo plano em Serviços.") }
        }

        // 2 · Processamento e IA
        SectionPage {
          SettingsSection { text:t("Predefinições") }
          SettingsHint { text:t("Aplicam um conjunto de escolhas ao rascunho; nada é salvo até você clicar em Salvar.") }
          Flow { Layout.fillWidth:true; spacing:8
           FtButton { objectName:"presetLocal"; text:t("Tudo neste computador"); iconName:"shield"; variant:"outline"; compact:true; enabled:settingsEditable; onClicked:settingsDialog.applyPreset("local") }
           FtButton { objectName:"presetHybrid"; text:t("Transcrição local, resumo OpenAI"); variant:"outline"; compact:true; enabled:settingsEditable; onClicked:settingsDialog.applyPreset("hybrid") }
           FtButton { objectName:"presetCloud"; text:t("Tudo pela OpenAI"); variant:"outline"; compact:true; enabled:settingsEditable; onClicked:settingsDialog.applyPreset("cloud") }
          }
          SettingsSection { text:t("Transcrição") }
          SettingsChoice { objectName:"settingsTranscription"; field:"transcription.provider"; label:t("Quem transcreve"); options:[{label:t("Whisper.cpp neste computador"),value:"whisper-cpp"},{label:t("OpenAI (serviço externo)"),value:"openai"},{label:t("Gemini (serviço externo)"),value:"gemini"}] }
          SettingsHint { visible:settingsDraft["transcription.provider"]!=="whisper-cpp"; color:warningColor; text:t("O áudio das gravações é enviado para ")+(settingsDraft["transcription.provider"]==="openai"?t("a OpenAI"):t("o Google"))+t(". Custos dependem da sua conta de API. Configure a chave em Chaves de API.") }
          SettingsText { visible:settingsDraft["transcription.provider"]==="whisper-cpp"; field:"transcription.whisperCpp.command"; label:t("Comando do Whisper.cpp"); placeholder:"whisper-cli"; picker:"file"; hint:t("Para usar a GPU, aponte para um whisper-cli compilado com Vulkan ou CUDA.") }
          SettingsText { visible:settingsDraft["transcription.provider"]==="whisper-cpp"; field:"transcription.whisperCpp.modelPath"; label:t("Arquivo do modelo (ggml)"); placeholder:"/home/voce/.local/share/recording-cli/models/ggml-large-v3-turbo-q5_0.bin"; picker:"file" }
          FtButton { visible:settingsDraft["transcription.provider"]==="whisper-cpp"; text:t("Baixar um modelo…"); variant:"outline"; compact:true; onClicked:settingsDialog.goToSection(4) }
          SettingsNumber { visible:settingsDraft["transcription.provider"]==="whisper-cpp"; field:"transcription.whisperCpp.threads"; label:t("Threads do Whisper.cpp"); from:1; to:256 }
          SettingsText { visible:settingsDraft["transcription.provider"]==="openai"; field:"transcription.openaiModel"; label:t("Modelo de transcrição da OpenAI") }
          SettingsText { visible:settingsDraft["transcription.provider"]==="gemini"; field:"transcription.geminiModel"; label:t("Modelo de transcrição do Gemini") }
          SettingsChoice { field:"transcription.language"; label:t("Idioma das chamadas"); options:[{label:t("Detectar automaticamente"),value:"auto"},{label:t("Português"),value:"pt"},{label:t("Inglês"),value:"en"},{label:t("Espanhol"),value:"es"},{label:t("Francês"),value:"fr"},{label:t("Alemão"),value:"de"},{label:t("Italiano"),value:"it"}] }
          SettingsText { visible:settingsDraft["transcription.provider"]==="openai"; field:"transcription.expectedLanguages"; list:true; label:t("Idiomas esperados (códigos separados por vírgula)"); placeholder:t("pt, en"); hint:t("Ajuda o modelo gpt-transcribe da OpenAI em chamadas com mais de um idioma.") }
          SettingsTextArea { visible:settingsDraft["transcription.provider"]==="openai"; field:"transcription.openaiPrompt"; label:t("Vocabulário e contexto da transcrição"); placeholder:t("Nomes, siglas e termos que aparecem nas suas chamadas"); hint:t("Enviado à OpenAI junto com o áudio.") }
          SettingsSection { text:t("Resumo") }
          SettingsChoice { field:"summary.provider"; label:t("Quem resume"); options:[{label:"Ollama",value:"ollama"},{label:t("OpenAI (serviço externo)"),value:"openai"}] }
          SettingsText { visible:settingsDraft["summary.provider"]==="ollama"; field:"summary.ollamaUrl"; label:t("Endereço do Ollama"); placeholder:"http://127.0.0.1:11434" }
          SettingsHint { visible:settingsDraft["summary.provider"]==="ollama"&&!settingsLoopback(settingsDraft["summary.ollamaUrl"]); color:warningColor; text:String(settingsDraft["summary.ollamaUrl"]||"").indexOf("http://")===0?t("Fora deste computador, use HTTPS: o resumo não envia a transcrição por HTTP a outro endereço."):t("Esse endereço não é este computador: a transcrição será enviada para ele.") }
          SettingsText { visible:settingsDraft["summary.provider"]==="ollama"; field:"summary.ollamaModel"; label:t("Modelo do Ollama"); placeholder:"qwen3.5:9b" }
          SettingsText { visible:settingsDraft["summary.provider"]==="openai"; field:"summary.openaiModel"; label:t("Modelo de resumo da OpenAI") }
          SettingsHint { visible:settingsDraft["summary.provider"]==="openai"; color:warningColor; text:t("A transcrição é enviada para a OpenAI para resumir. Configure a chave em Chaves de API.") }
          SettingsNumber { visible:settingsDraft["summary.provider"]==="ollama"; field:"summary.maxInputCharacters"; label:t("Limite de texto por pedido ao Ollama (caracteres)"); from:4096; to:200000 }
          SettingsSection { text:t("Execução") }
          SettingsChoice { field:"processing.defaultTarget"; label:t("Onde processar"); options:[{label:t("Neste computador"),value:"local"}].concat(settingsDialog.remoteConfiguredDraft()||settingsDraft["processing.defaultTarget"]==="remote"?[{label:t("Worker remoto configurado"),value:"remote"}]:[]) }
          SettingsHint { visible:!settingsDialog.remoteConfiguredDraft(); text:t("Para processar em outra máquina, configure o worker remoto em Integrações.") }
          SettingsCheck { field:"processing.autoEnqueue"; text:t("Processar automaticamente cada gravação nova") }
          SettingsHint { visible:settingsDraft["processing.autoEnqueue"]===true; text:t("Gravações paradas pelo Studio começam na hora. As da gravação automática precisam do processamento em segundo plano, em Serviços.") }
          SettingsCheck { field:"processing.notifyOnCompletion"; text:t("Avisar quando um processamento terminar ou falhar") }
          FtButton { text:t("Rotas e privacidade…"); iconName:"shield"; variant:"outline"; enabled:backend.available&&!settingsHasChanges(); onClicked:onboardingDialog.open() }
          SettingsHint { text:settingsHasChanges()?t("Salve ou descarte as alterações antes de abrir o resumo de rotas e privacidade."):t("Mostra para onde vai cada etapa e permite escolher o processamento local com um clique.") }
        }

        // 3 · Chaves de API
        SectionPage {
          SettingsHint { text:t("As chaves ficam num arquivo privado (permissão 600) ao lado da configuração e valem para todo processamento, inclusive em segundo plano. O Studio nunca mostra uma chave salva.") }
          StatusLine { visible:!!(settingsData.readOnly&&settingsData.readOnly.legacyApiKeyInConfig); good:false; text:t("Há uma chave da OpenAI no config.json, formato antigo. Salve-a aqui; depois você pode removê-la do arquivo.") }
          StatusLine { objectName:"keysManagerUnknown"; visible:!!(settingsData.credentials&&settingsData.credentials.managerEnvironment==="unavailable"); good:false; text:t("O ambiente dos serviços do usuário não pôde ser lido: uma chave definida nele não aparece aqui e teria prioridade.") }
          Repeater { model:((settingsData.credentials&&settingsData.credentials.files)||[]).filter(function(f){ return f.exists&&(f.tooOpen||!f.usable) })
           StatusLine { required property var modelData; good:false; text:modelData.file+(modelData.usable?t(" pode ser lido por outros usuários: ajuste a permissão para 600."):" "+(t(modelData.problem||"")||t("não pôde ser usado."))) }
          }
          SecretField { name:"OPENAI_API_KEY"; label:"OpenAI"; testService:"openai"; purpose:t("Usada para transcrever ou resumir pela OpenAI, identificar falantes e classificar apontamentos com IA.") }
          Rectangle { Layout.fillWidth:true; Layout.preferredHeight:1; color:divider }
          SecretField { name:"GEMINI_API_KEY"; label:"Google Gemini"; testService:"gemini"; purpose:t("Usada para transcrever pelo Gemini.") }
          Rectangle { Layout.fillWidth:true; Layout.preferredHeight:1; color:divider }
          SecretField { name:"RECORDING_CLI_OBS_PASSWORD"; label:t("Senha do WebSocket do OBS"); purpose:t("Usada para controlar o OBS neste computador. Teste a conexão em Integrações.") }
        }

        // 4 · Modelos
        SectionPage {
          SettingsSection { text:"Whisper.cpp" }
          SettingsHint { text:t("Modelos oficiais do whisper.cpp no Hugging Face. Cada arquivo é conferido pelo tamanho e pelo SHA-256 antes de ser usado; um arquivo diferente com o mesmo nome é preservado.") + (settingsDialog.catalog.whisper ? t(" Pasta: ") + settingsDialog.catalog.whisper.directory : "") }
          Label { visible:!settingsDialog.catalog.whisper; text:hasSettingsPending("settings-model-catalog")?t("Lendo modelos…"):t("Lista indisponível."); color:muted }
          Repeater { model:settingsDialog.catalog.whisper?settingsDialog.catalog.whisper.models:[]
           ColumnLayout { required property var modelData; Layout.fillWidth:true; spacing:4
            readonly property var download: settingsDialog.downloads[settingsDialog.downloadKey("whisper", modelData.id)]
            RowLayout { Layout.fillWidth:true; spacing:8
             Label { text:modelData.id; color:ink; font.weight:Font.DemiBold }
             FtChip { visible:!!modelData.recommended; text:t("Recomendado"); kind:"accent" }
             FtChip { visible:modelData.installed; text:t("Instalado"); kind:"accent"; iconName:"check" }
             FtChip { visible:settingsDialog.modelInUse(modelData.path); text:t("Em uso"); kind:"neutral" }
             Item { Layout.fillWidth:true }
             Label { text:settingsDialog.mib(modelData.bytes); color:muted }
            }
            SettingsHint { text:t(modelData.quality) }
            RowLayout { Layout.fillWidth:true; spacing:8
             FtButton { visible:!modelData.installed&&!(parent.parent.download&&parent.parent.download.state==="running"); text:t("Baixar"); compact:true; variant:"outline"; enabled:backend.available; onClicked:settingsDialog.confirmDownload=settingsDialog.downloadKey("whisper",modelData.id) }
             FtButton { visible:modelData.installed&&!settingsDialog.modelInUse(modelData.path); text:t("Usar este modelo"); compact:true; variant:"outline"; enabled:settingsEditable; onClicked:{ setSettingsField("transcription.whisperCpp.modelPath", modelData.path); if (settingsDraft["transcription.provider"]!=="whisper-cpp") setSettingsField("transcription.provider","whisper-cpp") } }
             FtButton { visible:!!(parent.parent.download&&parent.parent.download.state==="running"); text:t("Cancelar"); compact:true; variant:"outline"; onClicked:settingsDialog.cancelDownload("whisper",modelData.id) }
             StatusLine { visible:!!parent.parent.download; good:!!(parent.parent.download&&parent.parent.download.state!=="failed"); text:!parent.parent.download?"":parent.parent.download.state==="running"?settingsDialog.downloadProgress(parent.parent.download):parent.parent.download.state==="failed"?(t(parent.parent.download.error)||t("O download falhou.")):parent.parent.download.state==="completed"?t("Baixado e conferido."):"" }
            }
            ColumnLayout { visible:settingsDialog.confirmDownload===settingsDialog.downloadKey("whisper",modelData.id); Layout.fillWidth:true; spacing:6
             SettingsHint { color:warningColor; text:t("Baixar ") + settingsDialog.mib(modelData.bytes) + t(" de huggingface.co para a pasta de modelos? Nenhum dado seu é enviado; o download continua mesmo se você fechar o Studio.") }
             RowLayout { spacing:8
              FtButton { text:t("Baixar agora"); compact:true; highlighted:true; onClicked:settingsDialog.startDownload("whisper", modelData.id) }
              FtButton { text:t("Cancelar"); compact:true; variant:"outline"; onClicked:settingsDialog.confirmDownload="" }
             }
            }
            Rectangle { Layout.fillWidth:true; Layout.preferredHeight:1; color:divider }
           }
          }
          SettingsSection { text:"Ollama" }
          SettingsHint { text:!settingsDialog.catalog.ollama?"":!settingsDialog.catalog.ollama.loopback?t("O Ollama configurado não está neste computador; o Studio não baixa modelos nele."):!settingsDialog.catalog.ollama.reachable?t("O Ollama não respondeu em ")+settingsDialog.catalog.ollama.url+t(". Instale e inicie o Ollama."):t("Modelos instalados: ")+(settingsDialog.catalog.ollama.installed.length?settingsDialog.catalog.ollama.installed.join(", "):t("nenhum"))+"." }
          SettingsHint { objectName:"ollamaCatalogStale"; visible:!!settingsDialog.catalog.ollama&&!settingsDialog.ollamaCatalogCurrent(); color:warningColor; text:t("Esta lista é do Ollama em ")+(settingsDialog.catalog.ollama?settingsDialog.catalog.ollama.url:"")+t(". Atualize a lista para ver o endereço escolhido.") }
          RowLayout { visible:!!(settingsDialog.catalog.ollama&&settingsDialog.catalog.ollama.loopback&&settingsDialog.catalog.ollama.reachable&&settingsDialog.ollamaCatalogCurrent()); Layout.fillWidth:true; spacing:8
           readonly property string model: String(settingsDraft["summary.ollamaModel"]||"")
           readonly property var download: settingsDialog.downloads[settingsDialog.downloadKey("ollama", model)]
           readonly property bool installed: !!settingsDialog.catalog.ollama && (settingsDialog.catalog.ollama.installed.indexOf(model)>=0||settingsDialog.catalog.ollama.installed.indexOf(model+":latest")>=0)
           Label { text:t("Modelo configurado: ")+parent.model; color:ink; Layout.fillWidth:true; wrapMode:Text.WordWrap }
           FtChip { visible:parent.installed; text:t("Instalado"); kind:"accent"; iconName:"check" }
           FtButton { visible:!parent.installed&&!(parent.download&&parent.download.state==="running"); text:t("Baixar pelo Ollama"); compact:true; variant:"outline"; enabled:backend.available&&!!parent.model; onClicked:settingsDialog.confirmDownload=settingsDialog.downloadKey("ollama",parent.model) }
           FtButton { objectName:"ollamaCancel"; visible:!!(parent.download&&parent.download.state==="running"); text:t("Cancelar"); compact:true; variant:"outline"; onClicked:settingsDialog.cancelDownload("ollama",parent.model) }
           StatusLine { visible:!!parent.download; good:!!(parent.download&&parent.download.state!=="failed"); text:!parent.download?"":parent.download.state==="running"?settingsDialog.downloadProgress(parent.download):parent.download.state==="failed"?(t(parent.download.error)||t("O download falhou.")):t("Modelo instalado.") }
          }
          ColumnLayout { visible:settingsDialog.confirmDownload.indexOf("ollama:")===0; Layout.fillWidth:true; spacing:6
           SettingsHint { color:warningColor; text:t("Pedir ao Ollama deste computador para baixar “")+settingsDialog.confirmDownload.slice(7)+t("”? O Ollama baixa do registro dele; nenhum dado seu é enviado.") }
           RowLayout { spacing:8
            FtButton { text:t("Baixar agora"); compact:true; highlighted:true; onClicked:settingsDialog.startDownload("ollama", settingsDialog.confirmDownload.slice(7)) }
            FtButton { text:t("Cancelar"); compact:true; variant:"outline"; onClicked:settingsDialog.confirmDownload="" }
           }
          }
          FtButton { text:t("Atualizar lista"); iconName:"refresh"; variant:"outline"; compact:true; enabled:backend.available&&!hasSettingsPending("settings-model-catalog"); onClicked:settingsDialog.requestCatalog() }
        }

        // 5 · Integrações
        SectionPage {
          SettingsSection { text:"OBS" }
          SettingsCheck { field:"obs.enabled"; text:t("Usar o OBS para gravar") }
          SettingsHint { text:t("Configure a cena, as fontes de áudio e o servidor WebSocket no próprio OBS. O FalaTrace só controla um OBS neste computador.") }
          SettingsChoice { field:"obs.host"; label:t("Endereço do WebSocket"); options:[{label:"127.0.0.1",value:"127.0.0.1"},{label:"localhost",value:"localhost"},{label:"::1",value:"::1"}] }
          SettingsNumber { field:"obs.port"; label:t("Porta do WebSocket"); from:1; to:65535 }
          SettingsCheck { field:"obs.autoLaunch"; text:t("Abrir o OBS automaticamente quando for gravar") }
          RowLayout { spacing:8
           FtButton { text:hasSettingsPending("settings-obs-check")?t("Testando…"):t("Testar conexão com o OBS"); compact:true; variant:"outline"; enabled:backend.available&&!hasSettingsPending("settings-obs-check")&&!settingsHasChanges(); onClicked:{ settingsDialog.obsCheck=null; send("settings-obs-check","") } }
           SettingsHint { visible:settingsHasChanges(); text:t("Salve antes de testar.") }
          }
          StatusLine { visible:!!settingsDialog.obsCheck; good:!!(settingsDialog.obsCheck&&settingsDialog.obsCheck.ok); text:settingsDialog.obsCheck?t(settingsDialog.obsCheck.detail):"" }
          SettingsSection { text:t("Worker remoto") }
          SettingsHint { text:t("Uma máquina com Whisper.cpp e Ollama que processa por SSH com chave. O host precisa estar no known_hosts.") }
          SettingsText { field:"remote.host"; label:t("Host"); placeholder:"worker.lan" }
          SettingsText { field:"remote.user"; label:t("Usuário (opcional)"); nullable:true; placeholder:"seu-usuario" }
          SettingsNumber { field:"remote.port"; label:t("Porta SSH"); from:1; to:65535 }
          SettingsText { field:"remote.identityFile"; label:t("Chave SSH (opcional)"); nullable:true; placeholder:"/home/voce/.ssh/id_ed25519"; picker:"file" }
          SettingsText { field:"remote.archiveDir"; label:t("Pasta de arquivo no worker"); placeholder:"~/Videos/RecordingArchive" }
          RowLayout { spacing:8
           FtButton { objectName:"settingsRemoteCheck"; text:hasSettingsPending("settings-remote-check")?t("Testando…"):t("Testar conexão"); compact:true; variant:"outline"; enabled:backend.available&&!hasSettingsPending("settings-remote-check")&&!settingsHasChanges()&&!!(settingsData.readOnly&&settingsData.readOnly.remoteConfigured); onClicked:{ settingsDialog.remoteCheck=null; send("settings-remote-check","") } }
           SettingsHint { text:settingsHasChanges()?t("Salve antes de testar."):!(settingsData.readOnly&&settingsData.readOnly.remoteConfigured)?t("Informe e salve um host para testar."):t("Conecta por SSH e lista as ferramentas do worker.") }
          }
          StatusLine { visible:!!settingsDialog.remoteCheck; good:!!(settingsDialog.remoteCheck&&settingsDialog.remoteCheck.ok); text:!settingsDialog.remoteCheck?"":settingsDialog.remoteCheck.ok?(t("Conectado a ")+(settingsDialog.remoteCheck.host||"worker")+". "+(settingsDialog.remoteCheck.commands||[]).map(function(c){ return c.name+(c.ok?" ok":t(" ausente")) }).join(" · ")+(settingsDialog.remoteCheck.disk?t(". Disco: ")+settingsDialog.remoteCheck.disk:"")):settingsDialog.remoteCheck.hint }
          SettingsSection { text:t("Arquivo de originais") }
          SettingsCheck { field:"archive.enabled"; text:t("Guardar cópias verificadas das gravações originais") }
          SettingsCheck { field:"archive.vaio"; text:t("No worker remoto") }
          SettingsCheck { field:"archive.proton"; text:t("No Proton Drive") }
          SettingsNumber { field:"archive.syncIntervalMinutes"; label:t("Tentar de novo a cada (minutos)"); from:1; to:1440 }
          SettingsHint { text:t("As cópias saem deste computador. Depois de salvar, ative o timer de arquivo em Serviços.") }
          SettingsSection { text:"Proton Drive" }
          SettingsCheck { field:"proton.enabled"; text:t("Fazer backup dos resultados no Proton Drive") }
          SettingsText { field:"proton.targetFolder"; label:t("Pasta no Proton Drive"); placeholder:"/my-files/RecordingArchive" }
          SettingsChoice { field:"proton.policy"; label:t("O que copiar"); options:[{label:t("Só transcrição e resumo"),value:"artifacts"},{label:t("Tudo, inclusive a mídia"),value:"full"}] }
          SettingsHint { text:t("Exige o rclone configurado para o Proton Drive. Depois de salvar, ative o timer de backup em Serviços.") }
          SettingsSection { text:t("Amazon S3 (legado)") }
          SettingsCheck { field:"s3.enabled"; text:t("Ativar o envio legado para o S3") }
          SettingsText { field:"s3.bucket"; label:t("Bucket"); placeholder:"meu-bucket" }
          SettingsText { field:"s3.region"; label:t("Região"); placeholder:"us-east-1" }
          SettingsText { field:"s3.prefix"; label:t("Prefixo"); placeholder:"recordings/" }
          SettingsText { field:"s3.profile"; label:t("Perfil da AWS CLI (opcional)"); nullable:true; placeholder:"default" }
          SettingsHint { text:t("Usado só pelos comandos legados de envio. Credenciais ficam no perfil da AWS CLI.") }
        }

        // 6 · Recursos opcionais
        SectionPage {
          SettingsSection { text:t("Apontamento de horas") }
          SettingsCheck { field:"timesheet.enabled"; text:t("Registrar horas das gravações") }
          SettingsCheck { field:"timesheet.automaticFromCalls"; text:t("Criar apontamentos a partir das chamadas detectadas") }
          SettingsCheck { field:"timesheet.aiClassification"; text:t("Sugerir cliente e tipo de tarefa com IA (OpenAI)") }
          SettingsHint { visible:settingsDraft["timesheet.aiClassification"]===true; color:warningColor; text:t("O catálogo de clientes, o resumo e um trecho da transcrição são enviados à OpenAI.") }
          SettingsText { field:"timesheet.aiModel"; label:t("Modelo da classificação") }
          SettingsChoice { field:"timesheet.readyConfidence"; label:t("Confiança para marcar como pronto"); options:[0.5,0.6,0.7,0.8,0.85,0.9,0.95,1].map(function(v){ return {label:Math.round(v*100)+"%",value:v} }) }
          SettingsText { field:"timesheet.contextPath"; label:t("Catálogo de clientes e tarefas"); picker:"file"; hint:t("Arquivo JSON local. Crie um vazio com: falatrace time init-context") }
          SettingsSection { text:t("Contexto para IA") }
          SettingsCheck { field:"aiContext.enabled"; text:t("Montar contexto por cliente a partir das reuniões") }
          SettingsCheck { field:"aiContext.autoBuild"; text:t("Atualizar o contexto depois de cada processamento") }
          SettingsNumber { field:"aiContext.maxMeetingsPerClient"; label:t("Reuniões por cliente"); from:1; to:100 }
          SettingsNumber { field:"aiContext.maxCharactersPerClient"; label:t("Tamanho máximo por cliente (caracteres)"); from:8000; to:200000 }
          SettingsSection { text:t("Calendário") }
          SettingsCheck { field:"calendar.enabled"; text:t("Usar o título do evento do GNOME Agenda na transcrição") }
          SettingsHint { text:t("Consulta o calendário local só quando uma gravação é enfileirada.") }
        }

        // 7 · Avançado
        SectionPage {
          SettingsSection { text:t("Interface") }
          // Language names stay in their own language so they are recognizable in either one.
          SettingsChoice { objectName:"settingsLanguage"; field:"studio.language"; label:t("Idioma do Studio"); options:[{label:t("Automático (idioma do sistema)"),value:"auto"},{label:"Português (Brasil)",value:"pt-BR"},{label:"English",value:"en"}] }
          SettingsHint { text:t("A mudança aparece na hora; salve para manter.") }
          SettingsSection { text:t("Detecção") }
          SettingsNumber { field:"callDetection.networkSampleSeconds"; label:t("Intervalo da amostra de rede (segundos)"); from:1; to:60 }
          SettingsCheck { field:"callDetection.dryRun"; text:t("Modo de teste: detectar e registrar sem gravar") }
          SettingsSection { text:t("Captura") }
          SettingsNumber { field:"capture.startupTimeoutSeconds"; label:t("Esperar a captura começar por até (segundos)"); from:5; to:300 }
          SettingsText { field:"features.namingTemplate"; label:t("Nome das pastas das gravações"); placeholder:"YYYY-MM-DD_HH-mm_[title]"; hint:t("Use YYYY, MM, DD, HH, mm e [title].") }
          SettingsSection { visible:["simple","gnome","wf-recorder"].indexOf(String(settingsDraft["backend"]))>=0; text:t("Gravação legada do GNOME") }
          SettingsNumber { visible:["simple","gnome","wf-recorder"].indexOf(String(settingsDraft["backend"]))>=0; field:"gnome.framerate"; label:t("Quadros por segundo"); from:1; to:60 }
          SettingsCheck { visible:["simple","gnome","wf-recorder"].indexOf(String(settingsDraft["backend"]))>=0; field:"gnome.drawCursor"; text:t("Mostrar o cursor") }
          SettingsChoice { visible:["simple","gnome","wf-recorder"].indexOf(String(settingsDraft["backend"]))>=0; field:"gnome.audioSource"; label:t("Áudio"); options:[{label:t("Microfone e sistema"),value:"both"},{label:t("Só microfone"),value:"microphone"},{label:t("Só sistema"),value:"desktop"},{label:t("Sem áudio"),value:"none"}] }
          SettingsSection { text:t("Limites da revisão visual") }
          SettingsHint { text:(settingsData.readOnly&&settingsData.readOnly.visualPolicyDeclared?"":t("Hoje valem os limites provisórios da versão alpha. "))+t("São limites de toda a instalação, sem renovação automática.") }
          SettingsNumber { field:"visualReview.maxInferences"; label:t("Pedidos de inferência"); from:1; to:1000 }
          SettingsNumber { field:"visualReview.maxPreviews"; label:t("Prévias de quadros"); from:1; to:1000 }
          SettingsSection { text:t("Retenção (dias)") }
          SettingsNumber { field:"retention.localCompletedWorkDays"; label:t("Arquivos de trabalho locais concluídos"); from:0; to:3650 }
          SettingsNumber { field:"retention.remoteIncomingDays"; label:t("Entradas no worker"); from:0; to:3650 }
          SettingsNumber { field:"retention.remoteResultsDays"; label:t("Resultados no worker"); from:0; to:3650 }
          SettingsNumber { field:"retention.remoteFailuresDays"; label:t("Falhas no worker"); from:0; to:3650 }
          SettingsHint { text:t("A limpeza só remove dados de trabalho elegíveis, nunca o original. Veja o que seria removido com: falatrace jobs cleanup --dry-run") }
          SettingsSection { text:t("Processamento em segundo plano") }
          SettingsNumber { field:"processing.syncIntervalMinutes"; label:t("Verificar a fila a cada (minutos)"); from:1; to:1440 }
        }

        // 8 · Serviços e diagnóstico
        SectionPage {
          RowLayout { Layout.fillWidth:true
           SettingsHint { text:t("Verifica dependências e serviços sem gravar, transcrever nem contatar serviços externos.") }
           FtButton { objectName:"settingsDiagnose"; text:hasSettingsPending("settings-diagnose")?t("Verificando…"):t("Verificar agora"); variant:"outline"; compact:true; enabled:backend.available&&!hasSettingsPending("settings-diagnose"); onClicked:runSettingsDiagnose() }
          }
          SettingsHint { objectName:"settingsDiagOutdated"; visible:!!settingsDiag.checks&&settingsDiagChanges!==JSON.stringify(settingsChanges()); color:warningColor; text:t("O rascunho mudou depois desta verificação. Clique em Verificar agora para atualizar.") }
          SettingsSection { text:t("Processamento") }
          Repeater { model:settingsDiag.checks||[]
           ColumnLayout { required property var modelData; Layout.fillWidth:true; spacing:4
            SettingsCheckRow { label:modelData.label; status:modelData.status; detail:modelData.detail }
            FtButton { visible:!!modelData.action&&modelData.status!=="ok"&&!!settingsDialog.checkActionLabel(modelData.action); text:settingsDialog.checkActionLabel(modelData.action); compact:true; variant:"outline"; Layout.leftMargin:80; onClicked:settingsDialog.checkAction(modelData.action) }
           }
          }
          SettingsSection { visible:(settingsDiag.automation||[]).length>0; text:t("Automação") }
          Repeater { model:settingsDiag.automation||[]
           ColumnLayout { required property var modelData; Layout.fillWidth:true; spacing:4
            SettingsCheckRow { label:modelData.label; status:modelData.status; detail:modelData.detail }
            FtButton { visible:!!modelData.action&&modelData.status!=="ok"&&!!settingsDialog.checkActionLabel(modelData.action); text:settingsDialog.checkActionLabel(modelData.action); compact:true; variant:"outline"; Layout.leftMargin:80; enabled:backend.available&&!settingsHasChanges()&&!hasSettingsPending("settings-service"); onClicked:settingsDialog.checkAction(modelData.action) }
           }
          }
          SettingsSection { text:t("Gravação manual") }
          SettingsCheckRow {
            visible:!!settingsDiag.recording
            label:t("Backend das capturas pelo Studio")
            status:settingsDiag.recording&&settingsDiag.recording.selectedBackend?((settingsDiag.recording.warnings||[]).length?"warning":"ok"):"missing"
            detail:settingsDiag.recording?(settingsDiag.recording.selectedBackend?t("Vai usar: ")+settingsDiag.recording.selectedBackend+".":(t(settingsDiag.recording.blockedReason)||t("Indisponível.")))+((settingsDiag.recording.warnings||[]).length?"\n"+settingsDiag.recording.warnings.join("\n"):""):""
          }
          SettingsSection { text:t("Monitor de chamadas") }
          SettingsCheckRow { visible:!!settingsDiag.services; label:t("Serviço recording-cli-calls"); status:settingsServiceStatus("calls"); detail:settingsServiceText("calls") }
          Flow { Layout.fillWidth:true; spacing:8
           FtButton { objectName:"settingsApplyCalls"; text:hasSettingsPending("settings-service")?t("Aplicando…"):t("Aplicar e reiniciar monitor"); highlighted:enabled&&!!settingsDiag.services&&(settingsDiag.services.calls.staleConfig||settingsDiag.services.calls.outdated||!settingsDiag.services.calls.active); enabled:backend.available&&!settingsHasChanges()&&!!settingsData.values&&settingsData.values["callDetection.enabled"]===true&&!hasSettingsPending("settings-service"); onClicked:runSettingsService("calls-apply") }
           FtButton { text:t("Desativar monitor"); variant:"outline"; enabled:backend.available&&settingsDialog.canDisableMonitor()&&!hasSettingsPending("settings-service"); onClicked:runSettingsService("calls-disable") }
          }
          SettingsHint { text:settingsHasChanges()?t("Salve as alterações antes de aplicar o monitor."):settingsData.values&&settingsData.values["callDetection.enabled"]!==true?t("Ative a gravação automática e salve para poder aplicar o monitor."):t("O monitor lê a configuração ao iniciar; aplique depois de salvar mudanças de gravação. Nunca é reiniciado durante uma gravação.") }
          SettingsSection { text:t("Processamento em segundo plano") }
          SettingsCheckRow { visible:!!settingsDiag.services; label:t("Timer recording-cli-sync"); status:settingsDialog.timerStatus(settingsDiag.services?settingsDiag.services.sync:null); detail:settingsDialog.timerText(settingsDiag.services?settingsDiag.services.sync:null) }
          Flow { Layout.fillWidth:true; spacing:8
           FtButton { objectName:"settingsApplySync"; text:t("Ativar ou reaplicar"); variant:"outline"; enabled:backend.available&&!settingsHasChanges()&&!hasSettingsPending("settings-service"); onClicked:runSettingsService("sync-apply") }
           FtButton { text:t("Desativar"); variant:"outline"; enabled:backend.available&&!!(settingsDiag.services&&settingsDiag.services.sync&&settingsDiag.services.sync.installed)&&!hasSettingsPending("settings-service"); onClicked:runSettingsService("sync-disable") }
          }
          SettingsHint { text:t("Processa a fila de tempos em tempos, inclusive gravações da gravação automática. A fila continua guardada se você desativar.") }
          SettingsSection { text:t("Arquivo de originais e backup") }
          SettingsCheckRow { visible:!!settingsDiag.services; label:t("Timer recording-cli-archive"); status:settingsDialog.timerStatus(settingsDiag.services?settingsDiag.services.archive:null); detail:settingsDialog.timerText(settingsDiag.services?settingsDiag.services.archive:null) }
          Flow { Layout.fillWidth:true; spacing:8
           FtButton { text:t("Ativar ou reaplicar"); variant:"outline"; enabled:backend.available&&!settingsHasChanges()&&!!settingsData.values&&settingsData.values["archive.enabled"]===true&&!hasSettingsPending("settings-service"); onClicked:runSettingsService("archive-apply") }
           FtButton { text:t("Desativar"); variant:"outline"; enabled:backend.available&&!!(settingsDiag.services&&settingsDiag.services.archive&&settingsDiag.services.archive.installed)&&!hasSettingsPending("settings-service"); onClicked:runSettingsService("archive-disable") }
          }
          SettingsCheckRow { visible:!!settingsDiag.services; label:t("Timer recording-cli-proton-backup"); status:settingsDialog.timerStatus(settingsDiag.services?settingsDiag.services.backup:null); detail:settingsDialog.timerText(settingsDiag.services?settingsDiag.services.backup:null) }
          Flow { Layout.fillWidth:true; spacing:8
           FtButton { text:t("Ativar ou reaplicar"); variant:"outline"; enabled:backend.available&&!settingsHasChanges()&&!!settingsData.values&&settingsData.values["proton.enabled"]===true&&!hasSettingsPending("settings-service"); onClicked:runSettingsService("backup-apply") }
           FtButton { text:t("Desativar"); variant:"outline"; enabled:backend.available&&!!(settingsDiag.services&&settingsDiag.services.backup&&settingsDiag.services.backup.installed)&&!hasSettingsPending("settings-service"); onClicked:runSettingsService("backup-disable") }
          }
          SettingsSection { text:t("Bandeja") }
          SettingsCheckRow { visible:!!settingsDiag.services; label:t("Indicador na bandeja (REC, pausar, parar)"); status:settingsServiceStatus("tray"); detail:settingsServiceText("tray") }
          Flow { Layout.fillWidth:true; spacing:8
           FtButton { text:t("Instalar ou reiniciar a bandeja"); variant:"outline"; enabled:backend.available&&!hasSettingsPending("settings-service"); onClicked:runSettingsService("tray-apply") }
           FtButton { text:t("Remover a bandeja"); variant:"outline"; enabled:backend.available&&!!(settingsDiag.services&&settingsDiag.services.tray&&settingsDiag.services.tray.installed)&&!hasSettingsPending("settings-service"); onClicked:runSettingsService("tray-disable") }
          }
        }

        // 9 · Backups e transferência
        SectionPage {
          SettingsSection { text:t("Cópias de segurança") }
          SettingsHint { text:t("Cada salvamento guarda a configuração anterior. As 20 cópias mais recentes são mantidas; restaurar também guarda a atual antes.") }
          Label { visible:!settingsDialog.backups.length; text:hasSettingsPending("settings-backups")?t("Lendo cópias…"):t("Nenhuma cópia de segurança."); color:muted }
          Repeater { model:settingsDialog.backups
           ColumnLayout { required property var modelData; Layout.fillWidth:true; spacing:4
            RowLayout { Layout.fillWidth:true; spacing:8
             Label { text:new Date(modelData.modifiedAt).toLocaleString(Qt.locale(), Locale.ShortFormat); color:ink; Layout.fillWidth:true }
             FtChip { visible:!modelData.valid; text:t("Inválida"); kind:"warning" }
             Label { text:Math.max(1, Math.round(modelData.bytes/1024))+t(" KiB"); color:muted }
             FtButton { text:t("Restaurar…"); compact:true; variant:"outline"; enabled:modelData.valid&&backend.available&&!settingsHasChanges()&&!hasSettingsPending("settings-restore"); onClicked:settingsDialog.confirmRestore=modelData.name }
            }
            RowLayout { visible:settingsDialog.confirmRestore===modelData.name; spacing:8
             SettingsHint { text:t("Substituir a configuração atual por esta cópia?"); color:warningColor }
             FtButton { objectName:"settingsRestoreConfirm"; text:t("Restaurar"); compact:true; highlighted:true; enabled:!hasSettingsPending("settings-restore"); onClicked:send("settings-restore","",{revision:settingsData.revision,backup:modelData.name}) }
             FtButton { text:t("Cancelar"); compact:true; variant:"outline"; onClicked:settingsDialog.confirmRestore="" }
            }
           }
          }
          SettingsHint { visible:settingsHasChanges(); text:t("Salve ou descarte as alterações antes de restaurar.") }
          SettingsSection { text:t("Exportar e importar") }
          SettingsHint { text:t("A exportação nunca inclui chaves. A importação carrega no rascunho só os campos que o Studio edita; revise e salve.") }
          Flow { Layout.fillWidth:true; spacing:8
           FtButton { text:t("Exportar…"); iconName:"export"; variant:"outline"; enabled:backend.available&&settingsDialog.pickerAvailable; onClicked:settingsDialog.choosePath("save", t("Exportar configuração"), "", function(path){ send("settings-export","",{path:path.endsWith(".json")?path:path+".json"}) }) }
           FtButton { text:t("Importar…"); variant:"outline"; enabled:settingsEditable&&settingsDialog.pickerAvailable; onClicked:settingsDialog.choosePath("json", t("Importar configuração"), "", function(path){ settingsDialog.importSummary=""; send("settings-import-read","",{path:path}) }) }
          }
          SettingsHint { visible:!settingsDialog.pickerAvailable; text:t("O seletor de arquivos do sistema não está disponível; use a CLI para exportar.") }
          StatusLine { visible:!!settingsDialog.importSummary; text:settingsDialog.importSummary }
        }
       }
      }
     }
    }
    footer:Item { implicitHeight:60; RowLayout { anchors.fill:parent; anchors.margins:12; spacing:10
     Label { text:settingsHasChanges()?Object.keys(settingsChanges()).length+t(" alteração(ões) não salva(s)"):""; color:warningColor; Layout.fillWidth:true; elide:Text.ElideRight }
     FtButton { objectName:"settingsCancel"; text:settingsHasChanges()?t("Descartar e fechar"):t("Fechar"); enabled:!hasSettingsPending("settings-save")&&!hasSettingsPending("settings-service"); onClicked:settingsDialog.reject() }
     FtButton { visible:settingsNeedsReload||!!settingsError; text:backend.available?t("Reler configuração"):t("Reconectar"); enabled:!hasSettingsPending("settings-read")&&!hasSettingsPending("settings-save"); onClicked:{if(backend.available)loadSettings(false);else backend.reconnect()} }
     FtButton { objectName:"settingsSave"; highlighted:enabled; text:hasSettingsPending("settings-save")?t("Salvando…"):t("Salvar"); enabled:backend.available&&settingsEditable&&settingsHasChanges(); onClicked:saveSettingsDraft() }
    } }
}
