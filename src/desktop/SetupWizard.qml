import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Guided first use. Nothing is saved, recorded or installed until "Concluir"; the audio
// test and model downloads only run on their own explicit buttons. Saving goes through
// the same allowlist, revision check and backup as the settings dialog.
FtDialog {
    id:setupWizard; objectName:"setupWizard"; title:t("Configurar o FalaTrace")
    anchors.centerIn:parent; width:Math.min(window.width-48,760); height:Math.min(window.height-48,720); modal:true
    closePolicy:busy?Popup.NoAutoClose:Popup.CloseOnEscape
    readonly property var steps: [t("Boas-vindas"), t("Captura"), t("Processamento"), t("Gravação automática"), t("Revisão"), t("Pronto")]
    property int step: 0
    property int generation: 0
    property var data: ({})
    property var draft: ({})
    property var diag: ({})
    property var audioTest: null
    property var catalog: ({})
    property var downloads: ({})
    property bool consentAck: false
    property bool applyMonitor: true
    property bool applyTimer: true
    property bool applyTray: false
    property var results: []
    property string error: ""
    property string notice: ""
    property bool busy: hasPending("settings-save") || hasPending("settings-service")
    readonly property bool fresh: data.exists === false

    onOpened:{ generation += 1; step = 0; data = ({}); draft = ({}); diag = ({}); audioTest = null; catalog = ({}); downloads = ({}); consentAck = false; results = []; error = ""; notice = ""; applyTray = false; load(); wizardNext.forceActiveFocus(Qt.TabFocusReason) }
    onClosed:{ languagePreview = ""; generation += 1; data = ({}); draft = ({}); onboardingButton.forceActiveFocus(Qt.TabFocusReason) }

    function request(op, payload, extra) { return send(op, "", payload || ({}), Object.assign({ origin: "wizard", wizardGeneration: generation }, extra || ({}))) }
    function hasPending(op) { return Object.keys(pending).some(function(id){ return pending[id].origin === "wizard" && pending[id].op === op && pending[id].wizardGeneration === generation }) }
    function load() { if (!backend.available) { error = t("Serviço indisponível. Reconecte e abra o assistente de novo."); return } request("settings-read"); request("settings-diagnose"); request("settings-model-catalog") }
    function value(field) { return Object.prototype.hasOwnProperty.call(draft, field) ? draft[field] : (data.values || ({}))[field] }
    function set(field, newValue) { const next = Object.assign({}, draft); next[field] = newValue; draft = next; if (field === "studio.language") languagePreview = newValue }
    function changes() {
        // On first use every explicit choice is written, even when it equals today's default,
        // so a later release changing a default cannot silently change what the user picked.
        const values = data.values || ({}), result = {}
        for (const field in draft) if (fresh || JSON.stringify(draft[field]) !== JSON.stringify(values[field])) result[field] = draft[field]
        return result
    }
    function recommend() {
        // Least capture and no external destination: audio only, local processing, detection off.
        set("backend", "audio"); set("capture.audioSource", "both"); set("capture.microphone", "default"); set("capture.desktop", "default")
        applyPreset("local"); set("callDetection.enabled", false); set("processing.autoEnqueue", false); set("processing.notifyOnCompletion", true)
        if (!value("backend") || ["audio", "gpu-screen-recorder", "obs"].indexOf(value("backend")) < 0) set("backend", "audio")
        step = 4
    }
    function applyPreset(name) {
        if (name === "local") { set("transcription.provider", "whisper-cpp"); set("summary.provider", "ollama"); set("summary.ollamaUrl", "http://127.0.0.1:11434") }
        else if (name === "hybrid") { set("transcription.provider", "whisper-cpp"); set("summary.provider", "openai") }
        else { set("transcription.provider", "openai"); set("summary.provider", "openai") }
        set("processing.defaultTarget", "local")
    }
    function preset() {
        const tr = value("transcription.provider"), su = value("summary.provider")
        return tr === "whisper-cpp" && su === "ollama" ? "local" : tr === "whisper-cpp" && su === "openai" ? "hybrid" : tr === "openai" && su === "openai" ? "cloud" : "custom"
    }
    function check(id) { return ((diag.checks || []).concat(diag.automation || [])).find(function(item){ return item.id === id }) || null }
    function credential(name) { return ((data.credentials && data.credentials.details) || []).find(function(detail){ return detail.name === name }) || ({}) }
    function needsKey(name) {
        if (name === "OPENAI_API_KEY") return value("transcription.provider") === "openai" || value("summary.provider") === "openai"
        return value("transcription.provider") === "gemini"
    }
    function deviceOptions(monitor) {
        const audio = diag.audio || ({}), current = value(monitor ? "capture.desktop" : "capture.microphone")
        const fallback = monitor ? audio.defaultDesktop : audio.defaultMicrophone
        const options = [{ label: t("Padrão do sistema") + (fallback ? " (" + fallback + ")" : ""), value: "default" }]
        for (const device of (audio.devices || [])) if (device.monitor === monitor) options.push({ label: device.description + " · " + device.name, value: device.name })
        if (current && current !== "default" && !options.some(function(option){ return option.value === current })) options.push({ label: current + t(" (não encontrado agora)"), value: current })
        return options
    }
    function recommendedModel() { return ((catalog.whisper && catalog.whisper.models) || []).find(function(model){ return model.recommended }) || null }
    function downloadState(kind, id) { return downloads[kind + ":" + id] || null }
    function finish() {
        error = ""; notice = ""; results = []
        // An existing configuration with nothing changed only needs the services step.
        if (!fresh && !Object.keys(changes()).length) { addResult(t("Configuração"), true, t("Sem alterações.")); runServices(); return }
        request("settings-save", { revision: data.revision, changes: changes(), initialize: fresh })
    }
    function runServices() {
        const actions = []
        if (applyMonitor && value("callDetection.enabled") === true) actions.push("calls-apply")
        if (applyTimer && value("processing.autoEnqueue") === true) actions.push("sync-apply")
        if (applyTray) actions.push("tray-apply")
        pendingActions = actions
        nextService()
    }
    property var pendingActions: []
    function nextService() {
        if (!pendingActions.length) { step = 5; return }
        const action = pendingActions[0]
        pendingActions = pendingActions.slice(1)
        request("settings-service", { action: action }, { action: action })
    }
    function serviceLabel(action) { return action === "calls-apply" ? t("Monitor de chamadas") : action === "sync-apply" ? t("Processamento em segundo plano") : action === "tray-apply" ? t("Bandeja") : action }
    function addResult(label, ok, detail) { results = results.concat([{ label: label, ok: ok, detail: detail }]) }

    function handleResponse(req, message) {
        if (req.wizardGeneration !== generation || !setupWizard.visible) return
        const result = message.result
        if (req.op === "settings-read") {
            if (!message.ok) { error = message.error; return }
            data = result
            if (["audio", "gpu-screen-recorder", "obs"].indexOf(result.values.backend) < 0) set("backend", "audio")
        } else if (req.op === "settings-diagnose") {
            if (message.ok) diag = result
        } else if (req.op === "settings-model-catalog") {
            if (message.ok) catalog = result
        } else if (req.op === "settings-audio-test") {
            audioTest = message.ok ? result : { error: message.error }
        } else if (req.op === "settings-secret-set") {
            if (!message.ok) { error = message.error; return }
            data = Object.assign({}, data, { credentials: result.credentials }); notice = t("Chave salva em arquivo privado.")
            request("settings-diagnose")
        } else if (req.op === "settings-model-download" || req.op === "settings-model-status") {
            if (!message.ok) { error = message.error; return }
            const next = Object.assign({}, downloads); next[result.kind + ":" + result.id] = result; downloads = next
            if (result.state === "completed") {
                if (result.kind === "whisper" && result.path) set("transcription.whisperCpp.modelPath", result.path)
                request("settings-model-catalog"); request("settings-diagnose")
            }
        } else if (req.op === "settings-save") {
            if (!message.ok) { error = message.error; return }
            addResult(t("Configuração"), true, result.backupCreated ? t("Salva, com cópia de segurança da anterior.") : t("Salva."))
            if (result.values) data = result
            draft = ({})
            runServices()
        } else if (req.op === "settings-service") {
            addResult(serviceLabel(req.action), message.ok, message.ok ? t("Aplicado.") : message.error)
            nextService()
        }
    }
    Timer {
        interval:2000; repeat:true
        running:setupWizard.visible && Object.keys(setupWizard.downloads).some(function(key){ return setupWizard.downloads[key].state === "running" })
        onTriggered:{ for (const key in setupWizard.downloads) { const state = setupWizard.downloads[key]; if (state.state === "running" && !setupWizard.hasPending("settings-model-status")) setupWizard.request("settings-model-status", { kind: state.kind, model: state.id }) } }
    }

    component Choice: Button {
        id:choice
        property string heading: ""
        property string detail: ""
        property bool selected: false
        Layout.fillWidth:true; implicitHeight:choiceColumn.implicitHeight + 20; hoverEnabled:true
        Accessible.role:Accessible.RadioButton; Accessible.name:heading; Accessible.checked:selected
        contentItem:ColumnLayout { id:choiceColumn; spacing:2
            Label { text:choice.heading; color:ink; font.weight:Font.DemiBold; wrapMode:Text.WordWrap; Layout.fillWidth:true }
            Label { text:choice.detail; color:muted; font.pixelSize:12; wrapMode:Text.WordWrap; Layout.fillWidth:true; visible:!!text }
        }
        background:Rectangle { radius:10; color:choice.selected?selectedSurface:choice.hovered?hoverSurface:surfaceAlt; border.width:choice.visualFocus?2:choice.selected?2:1; border.color:choice.visualFocus||choice.selected?accent:divider }
    }
    component Status: RowLayout {
        id:statusRow
        property string label: ""
        property string status: ""
        property string detail: ""
        Layout.fillWidth:true; spacing:8
        FtChip { Layout.alignment:Qt.AlignTop; text:statusRow.status==="ok"?"OK":statusRow.status==="skipped"?"—":t("Atenção"); kind:statusRow.status==="ok"?"accent":statusRow.status==="skipped"?"neutral":"warning"; iconName:statusRow.status==="ok"?"check":"" }
        ColumnLayout { Layout.fillWidth:true; spacing:0
            Label { text:t(statusRow.label); color:ink; font.weight:Font.DemiBold; wrapMode:Text.WordWrap; Layout.fillWidth:true }
            Label { text:t(statusRow.detail); color:muted; font.pixelSize:12; wrapMode:Text.WordWrap; Layout.fillWidth:true; textFormat:Text.PlainText }
        }
    }

    contentItem:ColumnLayout { spacing:12
      RowLayout { Layout.fillWidth:true; spacing:6
        Repeater { model:setupWizard.steps
          Rectangle { required property int index; Layout.fillWidth:true; implicitHeight:4; radius:2; color:index<=setupWizard.step?accent:divider }
        }
      }
      Label { text:tf("Passo %1 de %2 · %3", setupWizard.step + 1, setupWizard.steps.length, setupWizard.steps[setupWizard.step]); color:muted; font.pixelSize:12 }
      Label { visible:!!setupWizard.error; text:t(setupWizard.error); color:errorColor; wrapMode:Text.WordWrap; Layout.fillWidth:true; textFormat:Text.PlainText }
      Label { visible:!!setupWizard.notice; text:t(setupWizard.notice); color:accent; wrapMode:Text.WordWrap; Layout.fillWidth:true; textFormat:Text.PlainText }
      StackLayout { currentIndex:setupWizard.step; Layout.fillWidth:true; Layout.fillHeight:true

        // 0 · Boas-vindas
        ColumnLayout { spacing:12
          Label { text:t("Bem-vindo ao FalaTrace"); color:ink; font.pixelSize:22; font.weight:Font.DemiBold; wrapMode:Text.WordWrap; Layout.fillWidth:true }
          Label { text:t("O FalaTrace grava chamadas e reuniões que você autorizar, transcreve e resume com rastreio até o trecho original. Em poucos passos você escolhe o que gravar, onde processar e o que roda sozinho."); color:ink; wrapMode:Text.WordWrap; Layout.fillWidth:true }
          Label { text:t("Nada é gravado, enviado ou instalado até você concluir. O teste de áudio e os downloads só acontecem nos próprios botões."); color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
          RowLayout {
            Layout.fillWidth:true; spacing:10
            Label { text:t("Idioma do Studio"); color:ink }
            // Reading the model in currentIndex re-selects the choice when the labels change language.
            FtComboBox {
              objectName:"wizardLanguage"; Layout.preferredWidth:300
              textRole:"label"; valueRole:"value"
              model:[{label:t("Automático (idioma do sistema)"),value:"auto"},{label:"Português (Brasil)",value:"pt-BR"},{label:"English",value:"en"}]
              currentIndex:model.length ? Math.max(0, ["auto","pt-BR","en"].indexOf(setupWizard.value("studio.language") || "auto")) : -1
              onActivated:function(index){ setupWizard.set("studio.language", ["auto","pt-BR","en"][index]) }
              Accessible.name:t("Idioma do Studio")
            }
          }
          WrappedCheck { objectName:"wizardConsent"; text:t("Vou gravar só com a permissão das pessoas envolvidas e conforme as regras que valem para mim."); checked:setupWizard.consentAck; onToggled:setupWizard.consentAck = checked }
          Item { Layout.fillHeight:true }
          FtButton { objectName:"wizardRecommended"; text:t("Usar os padrões recomendados"); iconName:"shield"; variant:"outline"; enabled:setupWizard.consentAck && !!setupWizard.data.revision; onClicked:setupWizard.recommend() }
          Label { text:t("Padrões recomendados: só áudio, processamento neste computador com Whisper.cpp e Ollama e gravação automática desligada."); color:muted; font.pixelSize:12; wrapMode:Text.WordWrap; Layout.fillWidth:true }
        }

        // 1 · Captura
        ScrollView { id:captureScroll; clip:true; contentWidth:availableWidth
         ColumnLayout { width:captureScroll.availableWidth; spacing:10
          Label { text:t("O que gravar"); color:ink; font.pixelSize:16; font.weight:Font.DemiBold }
          Choice { heading:t("Só áudio"); detail:t("Microfone e som do sistema com o FFmpeg. Basta para transcrever e resumir. Recomendado."); selected:setupWizard.value("backend")==="audio"; onClicked:setupWizard.set("backend","audio") }
          Choice { heading:t("Tela e áudio"); detail:setupWizard.diag.recording&&setupWizard.diag.recording.capabilities&&!setupWizard.diag.recording.capabilities.gpuRecorder?t("Precisa do GPU Screen Recorder, que não foi encontrado neste computador."):t("Grava a tela pelo GPU Screen Recorder; o sistema pede permissão para compartilhar a tela."); selected:setupWizard.value("backend")==="gpu-screen-recorder"; onClicked:setupWizard.set("backend","gpu-screen-recorder") }
          Label { text:t("Quem usa o OBS pode escolhê-lo depois em Configurações, em Integrações."); color:muted; font.pixelSize:12; wrapMode:Text.WordWrap; Layout.fillWidth:true }
          Label { text:t("Áudio"); color:ink; font.pixelSize:16; font.weight:Font.DemiBold; Layout.topMargin:6 }
          FtComboBox { Layout.fillWidth:true; textRole:"label"; valueRole:"value"; model:[{label:t("Microfone e áudio do sistema"),value:"both"},{label:t("Só microfone"),value:"microphone"},{label:t("Só áudio do sistema"),value:"desktop"}]
            currentIndex:model.findIndex(function(option){ return option.value===setupWizard.value("capture.audioSource") }); onActivated:function(index){ setupWizard.set("capture.audioSource", model[index].value) }; Accessible.name:t("Fontes de áudio") }
          Label { text:t("Microfone"); color:ink }
          FtComboBox { Layout.fillWidth:true; textRole:"label"; valueRole:"value"; model:setupWizard.deviceOptions(false); currentIndex:model.findIndex(function(option){ return option.value===setupWizard.value("capture.microphone") }); onActivated:function(index){ setupWizard.set("capture.microphone", model[index].value) }; Accessible.name:t("Microfone") }
          Label { text:t("Áudio do sistema"); color:ink }
          FtComboBox { Layout.fillWidth:true; textRole:"label"; valueRole:"value"; model:setupWizard.deviceOptions(true); currentIndex:model.findIndex(function(option){ return option.value===setupWizard.value("capture.desktop") }); onActivated:function(index){ setupWizard.set("capture.desktop", model[index].value) }; Accessible.name:t("Áudio do sistema") }
          RowLayout { spacing:8
            FtButton { objectName:"wizardAudioTest"; text:setupWizard.hasPending("settings-audio-test")?t("Gravando 5 s…"):t("Testar áudio (5 s)"); iconName:"record"; compact:true; enabled:backend.available&&!setupWizard.hasPending("settings-audio-test"); onClicked:{ setupWizard.audioTest=null; setupWizard.request("settings-audio-test",{seconds:5,audioSource:setupWizard.value("capture.audioSource"),microphone:setupWizard.value("capture.microphone"),desktop:setupWizard.value("capture.desktop")}) } }
            Label { text:t("Grava 5 segundos neste computador, mede o nível e apaga. Fale e toque algum som."); color:muted; font.pixelSize:12; wrapMode:Text.WordWrap; Layout.fillWidth:true }
          }
          Repeater { model:setupWizard.audioTest&&setupWizard.audioTest.tracks?setupWizard.audioTest.tracks:[]
            RowLayout { required property var modelData; Layout.fillWidth:true; spacing:10
              Label { text:modelData.label; color:ink; Layout.preferredWidth:140 }
              Rectangle { Layout.fillWidth:true; implicitHeight:10; radius:5; color:surfaceAlt; border.width:1; border.color:divider
                Rectangle { height:parent.height; radius:5; width:parent.width*Math.max(0,Math.min(1,modelData.peakDb===null?0:(modelData.peakDb+60)/60)); color:modelData.hasSignal?accent:warningColor }
              }
              Label { text:modelData.peakDb===null?t("silêncio"):Math.round(modelData.peakDb)+" dB"; color:modelData.hasSignal?muted:warningColor; Layout.preferredWidth:70 }
            }
          }
          Repeater { model:setupWizard.audioTest?(setupWizard.audioTest.warnings||[]):[]; Label { required property var modelData; text:modelData; color:warningColor; wrapMode:Text.WordWrap; Layout.fillWidth:true; font.pixelSize:12 } }
          Label { visible:!!(setupWizard.audioTest&&setupWizard.audioTest.error); text:setupWizard.audioTest&&setupWizard.audioTest.error?t(setupWizard.audioTest.error):""; color:warningColor; wrapMode:Text.WordWrap; Layout.fillWidth:true }
         }
        }

        // 2 · Processamento
        ScrollView { id:processingScroll; clip:true; contentWidth:availableWidth
         ColumnLayout { width:processingScroll.availableWidth; spacing:10
          Label { text:t("Onde transcrever e resumir"); color:ink; font.pixelSize:16; font.weight:Font.DemiBold }
          Choice { objectName:"wizardPresetLocal"; heading:t("Tudo neste computador"); detail:t("Whisper.cpp transcreve e o Ollama resume. Nada sai do computador; precisa dos modelos instalados."); selected:setupWizard.preset()==="local"; onClicked:setupWizard.applyPreset("local") }
          Choice { heading:t("Transcrição local, resumo pela OpenAI"); detail:t("O áudio fica aqui; só o texto da transcrição vai para a OpenAI. Precisa de uma chave de API."); selected:setupWizard.preset()==="hybrid"; onClicked:setupWizard.applyPreset("hybrid") }
          Choice { heading:t("Tudo pela OpenAI"); detail:t("O áudio e a transcrição vão para a OpenAI. Não exige modelos locais; precisa de uma chave de API e gera custo na sua conta."); selected:setupWizard.preset()==="cloud"; onClicked:setupWizard.applyPreset("cloud") }
          Label { text:t("O que falta"); color:ink; font.pixelSize:16; font.weight:Font.DemiBold; Layout.topMargin:6 }
          Label { visible:!setupWizard.diag.checks; text:t("Verificando este computador…"); color:muted }
          Status { visible:setupWizard.value("transcription.provider")==="whisper-cpp"; label:"Whisper.cpp"; status:setupWizard.check("whisper")?setupWizard.check("whisper").status:"skipped"; detail:setupWizard.check("whisper")?setupWizard.check("whisper").detail:t("Salve e verifique depois em Serviços e diagnóstico.") }
          ColumnLayout { visible:setupWizard.value("transcription.provider")==="whisper-cpp"&&!!setupWizard.recommendedModel(); Layout.fillWidth:true; spacing:6
            readonly property var model: setupWizard.recommendedModel()
            readonly property var download: model ? setupWizard.downloadState("whisper", model.id) : null
            Status { label:t("Modelo do Whisper"); status:parent.model&&parent.model.installed?"ok":"warning"; detail:parent.model&&parent.model.installed?t("Modelo recomendado instalado."):t("O modelo recomendado (")+(parent.model?parent.model.id:"")+", "+(parent.model?Math.round(parent.model.bytes/1048576):0)+t(" MiB) ainda não foi baixado.") }
            RowLayout { visible:!!parent.model&&!parent.model.installed; spacing:8
              FtButton { objectName:"wizardDownloadModel"; text:parent.parent.download&&parent.parent.download.state==="running"?t("Baixando…"):t("Baixar o modelo recomendado"); compact:true; variant:"outline"; enabled:backend.available&&!(parent.parent.download&&parent.parent.download.state==="running"); onClicked:setupWizard.request("settings-model-download",{kind:"whisper",model:parent.parent.model.id,consent:true}) }
              Label { text:parent.parent.download?(parent.parent.download.state==="running"&&parent.parent.download.totalBytes?Math.floor(100*parent.parent.download.receivedBytes/parent.parent.download.totalBytes)+"%":parent.parent.download.state==="failed"?(parent.parent.download.error||t("Falhou.")):parent.parent.download.state==="completed"?t("Conferido pelo SHA-256."):""):t("Baixa de huggingface.co e confere pelo SHA-256."); color:muted; font.pixelSize:12; wrapMode:Text.WordWrap; Layout.fillWidth:true }
            }
          }
          Status { visible:setupWizard.value("summary.provider")==="ollama"; label:"Ollama"; status:setupWizard.check("ollama")?setupWizard.check("ollama").status:"skipped"; detail:setupWizard.check("ollama")?setupWizard.check("ollama").detail:"" }
          RowLayout { visible:setupWizard.value("summary.provider")==="ollama"&&!!setupWizard.check("ollama")&&setupWizard.check("ollama").status==="warning"; spacing:8
            readonly property var download: setupWizard.downloadState("ollama", String(setupWizard.value("summary.ollamaModel")||""))
            FtButton { text:parent.download&&parent.download.state==="running"?t("Baixando…"):t("Baixar ")+setupWizard.value("summary.ollamaModel")+t(" pelo Ollama"); compact:true; variant:"outline"; enabled:backend.available&&!(parent.download&&parent.download.state==="running"); onClicked:setupWizard.request("settings-model-download",{kind:"ollama",model:String(setupWizard.value("summary.ollamaModel")),consent:true}) }
            Label { text:parent.download&&parent.download.state==="failed"?(t(parent.download.error)||t("Falhou.")):t("O Ollama deste computador baixa do registro dele."); color:muted; font.pixelSize:12; wrapMode:Text.WordWrap; Layout.fillWidth:true }
          }
          ColumnLayout { visible:setupWizard.needsKey("OPENAI_API_KEY"); Layout.fillWidth:true; spacing:6
            Status { label:t("Chave da OpenAI"); status:setupWizard.credential("OPENAI_API_KEY").source&&setupWizard.credential("OPENAI_API_KEY").source!=="missing"?"ok":"warning"; detail:setupWizard.credential("OPENAI_API_KEY").source&&setupWizard.credential("OPENAI_API_KEY").source!=="missing"?t("Configurada."):t("Cole a chave da API da OpenAI. Ela fica num arquivo privado e nunca é mostrada.") }
            RowLayout { spacing:8
              FtTextField { id:wizardKey; objectName:"wizardOpenAIKey"; Layout.fillWidth:true; echoMode:TextInput.Password; passwordCharacter:"•"; placeholderText:t("sk-…"); inputMethodHints:Qt.ImhSensitiveData|Qt.ImhNoPredictiveText; Accessible.name:t("Chave da OpenAI") }
              FtButton { text:t("Salvar chave"); compact:true; enabled:wizardKey.text.trim().length>0&&!setupWizard.hasPending("settings-secret-set"); onClicked:{ setupWizard.request("settings-secret-set",{name:"OPENAI_API_KEY",value:wizardKey.text.trim()}); wizardKey.text="" } }
            }
          }
          Label { text:t("Dá para trocar cada escolha depois em Configurações, em Processamento e IA."); color:muted; font.pixelSize:12; wrapMode:Text.WordWrap; Layout.fillWidth:true }
         }
        }

        // 3 · Gravação automática
        ColumnLayout { spacing:10
          Label { text:t("Gravar chamadas sozinho?"); color:ink; font.pixelSize:16; font.weight:Font.DemiBold }
          Label { text:t("O FalaTrace percebe quando navegadores e apps como Zoom, Teams e Slack usam o microfone. Ele não sabe qual serviço, aba ou pessoa está na chamada; ditado e teste de câmera também contam."); color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
          Choice { heading:t("Não, eu inicio as gravações"); detail:t("Use Gravar… no Studio ou a bandeja."); selected:setupWizard.value("callDetection.enabled")!==true; onClicked:setupWizard.set("callDetection.enabled", false) }
          Choice { heading:t("Avisar quando uma chamada começar"); detail:t("Uma notificação aparece; nada é gravado sozinho. Bom para começar."); selected:setupWizard.value("callDetection.enabled")===true&&setupWizard.value("callDetection.mode")==="notify-only"; onClicked:{ setupWizard.set("callDetection.enabled", true); setupWizard.set("callDetection.mode", "notify-only") } }
          Choice { objectName:"wizardAutoRecord"; heading:t("Gravar automaticamente"); detail:t("Começa a gravar com o backend escolhido e para quando a chamada termina. Confirme a permissão das pessoas antes."); selected:setupWizard.value("callDetection.enabled")===true&&setupWizard.value("callDetection.mode")==="record"; onClicked:{ setupWizard.set("callDetection.enabled", true); setupWizard.set("callDetection.mode", "record") } }
          WrappedCheck { text:t("Processar cada gravação nova automaticamente"); checked:setupWizard.value("processing.autoEnqueue")===true; onToggled:setupWizard.set("processing.autoEnqueue", checked) }
          WrappedCheck { text:t("Avisar quando um processamento terminar"); checked:setupWizard.value("processing.notifyOnCompletion")!==false; onToggled:setupWizard.set("processing.notifyOnCompletion", checked) }
          Label { text:t("Discord, Signal, Telegram e Element ficam desligados por levarem ligações pessoais; ative-os em Configurações se quiser."); color:muted; font.pixelSize:12; wrapMode:Text.WordWrap; Layout.fillWidth:true }
          Item { Layout.fillHeight:true }
        }

        // 4 · Revisão
        ScrollView { id:reviewScroll; clip:true; contentWidth:availableWidth
         ColumnLayout { width:reviewScroll.availableWidth; spacing:10
          Label { text:t("Revise antes de concluir"); color:ink; font.pixelSize:16; font.weight:Font.DemiBold }
          Status { label:t("Captura"); status:"ok"; detail:(setupWizard.value("backend")==="gpu-screen-recorder"?t("Tela e áudio"):setupWizard.value("backend")==="obs"?"OBS":t("Só áudio"))+" · "+({both:t("microfone e áudio do sistema"),microphone:t("só microfone"),desktop:t("só áudio do sistema"),none:t("sem áudio")})[setupWizard.value("capture.audioSource")||"both"] }
          Status { label:t("Processamento"); status:setupWizard.preset()==="local"?"ok":"warning"; detail:setupWizard.preset()==="local"?t("Tudo neste computador."):setupWizard.preset()==="hybrid"?t("Transcrição aqui; o texto vai para a OpenAI para resumir."):setupWizard.preset()==="cloud"?t("Áudio e texto vão para a OpenAI."):t("Combinação personalizada; veja Configurações.") }
          Status { label:t("Gravação automática"); status:setupWizard.value("callDetection.enabled")===true&&setupWizard.value("callDetection.mode")==="record"?"warning":"ok"; detail:setupWizard.value("callDetection.enabled")!==true?t("Desligada."):setupWizard.value("callDetection.mode")==="record"?t("Grava sozinho as chamadas detectadas."):t("Só avisa.") }
          Label { text:t("Aplicar agora"); color:ink; font.pixelSize:16; font.weight:Font.DemiBold; Layout.topMargin:6 }
          WrappedCheck { visible:setupWizard.value("callDetection.enabled")===true; text:t("Iniciar o monitor de chamadas"); checked:setupWizard.applyMonitor; onToggled:setupWizard.applyMonitor=checked }
          WrappedCheck { visible:setupWizard.value("processing.autoEnqueue")===true; text:t("Ativar o processamento em segundo plano"); checked:setupWizard.applyTimer; onToggled:setupWizard.applyTimer=checked }
          WrappedCheck { text:t("Instalar o indicador na bandeja (REC, pausar, parar)"); checked:setupWizard.applyTray; onToggled:setupWizard.applyTray=checked }
          Label { text:setupWizard.fresh?t("Concluir cria a configuração. Você pode mudar tudo depois em Configurações."):t("Concluir salva só o que você mudou, com cópia de segurança da configuração atual."); color:muted; font.pixelSize:12; wrapMode:Text.WordWrap; Layout.fillWidth:true }
         }
        }

        // 5 · Pronto
        ColumnLayout { spacing:10
          Label { text:t("Tudo pronto"); color:ink; font.pixelSize:22; font.weight:Font.DemiBold }
          Repeater { model:setupWizard.results; Status { required property var modelData; label:modelData.label; status:modelData.ok?"ok":"warning"; detail:modelData.detail } }
          Label { text:t("Para gravar agora, use Gravar… no topo. As gravações aparecem na biblioteca; use Processar… numa gravação para transcrever e resumir."); color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
          Item { Layout.fillHeight:true }
        }
      }
    }
    footer:Item { implicitHeight:60; RowLayout { anchors.fill:parent; anchors.margins:12; spacing:10
      FtButton { text:setupWizard.step===5?t("Fechar"):t("Agora não"); variant:"outline"; enabled:!setupWizard.busy; onClicked:setupWizard.close() }
      Item { Layout.fillWidth:true }
      FtButton { visible:setupWizard.step>0&&setupWizard.step<5; text:t("Voltar"); variant:"outline"; enabled:!setupWizard.busy; onClicked:setupWizard.step-=1 }
      FtButton { visible:setupWizard.step===5; text:t("Abrir configurações"); variant:"outline"; onClicked:{ setupWizard.close(); settingsDialog.open() } }
      FtButton {
        id:wizardNext; objectName:"wizardNext"
        visible:setupWizard.step<5
        highlighted:enabled
        text:setupWizard.step===4?(setupWizard.busy?t("Concluindo…"):t("Concluir")):setupWizard.step===0?t("Configurar passo a passo"):t("Continuar")
        enabled:backend.available&&!!setupWizard.data.revision&&!setupWizard.busy&&(setupWizard.step!==0||setupWizard.consentAck)
        onClicked:if (setupWizard.step===4) setupWizard.finish(); else setupWizard.step+=1
      }
    } }
}
