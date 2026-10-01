import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Recording 1.0

ApplicationWindow {
    id: window
    width: 1320; height: 820
    minimumWidth: 900; minimumHeight: 640
    visible: true
    title: "FalaTrace Studio"
    color: canvas
    property real position: 0
    property real duration: 0
    property string location: ""
    property bool mediaReady: false
    property string errorText: ""
    property bool lightTheme: false
    property color canvas: lightTheme ? "#F4F1E9" : "#0B1716"
    property color surface: lightTheme ? "#FFFFFF" : "#142725"
    property color panel: lightTheme ? "#E8EEE7" : "#102B2A"
    property color buttonSurface: lightTheme ? "#DDE8E0" : "#243D37"
    property color selectedSurface: lightTheme ? "#DDEFE4" : "#24443B"
    property color hoverSurface: lightTheme ? "#E6EEE8" : "#1A342E"
    property color warningColor: lightTheme ? "#A34125" : "#FFB377"
    property color errorColor: lightTheme ? "#A34125" : "#FFB4AB"
    property color recordingColor: lightTheme ? "#B62234" : "#FF7373"
    property color ink: lightTheme ? "#102B2A" : "#F4F1E9"
    property color muted: lightTheme ? "#566B66" : "#AAC0B8"
    property color accent: lightTheme ? "#0F705A" : "#57D5B0"
    property double statusNow: Date.now()
    property var items: []
    property var filtered: items.filter(item => (item.title + " " + item.fileName).toLocaleLowerCase().includes(search.text.toLocaleLowerCase()))
    property var selected: ({})
    property var detail: ({transcript: {segments: [], text: "", timing: "none"}, diarization: {state: "idle"}})
    property var pending: ({})
    property int generation: 0
    property bool loading: true
    property bool resolving: false
    property bool detailLoading: false
    property bool paused: true
    property bool playerInitialized: false
    property bool captions: true
    property bool subtitleQueued: false
    property string notice: ""
    property string pendingPath: ""
    property string playbackOperation: ""
    property bool operationPolling: false
    property bool diarizationQueued: false
    property string initialTranscriptTiming: ""
    property string transcriptTiming: detail.transcript.timing
    property int transcriptSegments: (detail.transcript.segments || []).length
    property int activeSegment: -1
    property var captionTrack: detail.captionTranscript || detail.transcript
    property int activeCaptionSegment: -1
    property int diarizationTurns: (detail.diarization.turns || []).length
    property bool diarizationTab: tabs.currentIndex === 2
    property var captureStatus: ({active: false, session: null, audio: {configured: false}})
    property var jobs: []
    property var selectedJob: ({})
    property string contextText: ""
    property string contextCopyText: ""
    property string contextPath: ""
    property var contextCitations: []
    property bool contextLoading: false
    property bool captureBusy: false
    property bool captureKnown: false
    property var speakerRows: {
        const rows = []
        const seen = ({})
        for (const turn of (detail.diarization.turns || [])) {
            const id = turn.speaker || turn.label || "anonymous"
            if (seen[id]) continue
            seen[id] = true
            rows.push({speakerId: id, label: turn.label || "", anonymous: !turn.label})
        }
        return rows
    }
    palette.window: canvas
    palette.windowText: ink
    palette.text: ink
    palette.placeholderText: muted
    palette.disabled.text: muted
    palette.disabled.buttonText: muted
    palette.buttonText: ink
    palette.button: buttonSurface
    palette.base: surface
    palette.highlight: accent
    palette.highlightedText: lightTheme ? "#FFFFFF" : "#0B1716"

    property bool textHasFocus: !!activeFocusItem && typeof activeFocusItem.cursorPosition === "number"

    function clock(seconds) {
        const value = Math.max(0, Math.floor(seconds || 0))
        return Math.floor(value / 60).toString().padStart(2, "0") + ":" + (value % 60).toString().padStart(2, "0")
    }
    function preciseClock(seconds) {
        const value = Math.max(0, Number(seconds) || 0)
        return clock(value) + "." + Math.floor((value % 1) * 10)
    }
    function origin(value) { return ({local: "Neste computador", vaio: "Worker remoto", proton: "Proton Drive", missing: "Mídia indisponível"})[value] || "" }
    function statusText(value) { return ({completed: "Processada", archived: "Backup concluído", failed: "Processamento falhou", queued: "Na fila", processing: "Processando", "archive-pending": "Backup pendente", unprocessed: "Sem processamento"})[value] || value }
    function speakerLabel(segment) { return segment.speaker || "Falante incerto" }
    function audioSummary() {
        const configured = captureStatus.audio && captureStatus.audio.configured
        if (!configured) return "Áudio ainda não validado"
        if (configured.audioSource === "none") return "Áudio desativado na configuração"
        const selected = captureStatus.audio.selected || {}
        const mic = selected.microphone || configured.microphone || "Padrão do sistema"
        const desktop = selected.desktop || configured.desktop || "Padrão do sistema"
        return "Mic: " + mic + " · Desktop: " + desktop
    }
    function diarizationKey() { return detail.diarizationId || detail.jobId || "" }
    function hasPending(op) { return Object.keys(pending).some(id => pending[id].op === op) }
    function activeSpeakerLabels(seconds) {
        const turns = (detail.diarization && detail.diarization.turns) || []
        const labels = turns.filter(turn => Number(turn.start) <= seconds && seconds < Number(turn.end)).map(turn => turn.label || turn.speaker || "Falante incerto")
        return labels.filter((label, index) => labels.indexOf(label) === index).join(" + ")
    }
    function send(op, key, payload) {
        const id = backend.request(op, key || "", payload || ({}))
        if (id < 0) { errorText = "O serviço da biblioteca está indisponível. Reabra esta janela."; return -1 }
        const next = Object.assign({}, pending)
        next[id] = {op: op, key: key, generation: generation}
        pending = next
        return id
    }
    function backToLibrary() {
        generation += 1; selected = ({}); detail = {transcript: {segments: [], text: "", timing: "none"}, diarization: {state: "idle"}}
        detailLoading = false; resolving = false; contextLoading = false; contextText = ""; contextCopyText = ""; contextPath = ""; contextCitations = []
        mediaReady = false; pendingPath = ""; position = 0; duration = 0; location = ""; playbackOperation = ""; operationPolling = false; errorText = ""; notice = ""
        if (playerInitialized) video.commandAsync(["stop"])
        search.forceActiveFocus()
    }
    function selectRecording(item) {
        generation += 1
        selected = item
        detail = {transcript: {segments: [], text: "", timing: "none"}, diarization: {state: "idle"}}
        detailLoading = true; errorText = ""; notice = ""; subtitleQueued = false
        mediaReady = false; pendingPath = ""; position = 0; duration = 0; location = ""
        resolving = false; playbackOperation = ""; operationPolling = false; initialTranscriptTiming = ""; diarizationQueued = false
        contextText = ""; contextCopyText = ""; contextPath = ""; contextCitations = []; contextLoading = false
        if (playerInitialized) video.commandAsync(["stop"])
        send("detail", item.key)
        // Explicit open keeps remote retrieval under the user's control.
        if (item.location === "local" || smokeKey) openRecording()
    }
    function openRecording() {
        if (!backend.available || !selected.key || resolving) return
        resolving = true; errorText = ""; notice = "Verificando e recuperando a mídia…"
        if (send("resolve", selected.key) < 0) { resolving = false; notice = "" }
    }
    function loadMedia() {
        if (!playerInitialized || !pendingPath) return
        video.setPropertyAsync("pause", true)
        video.commandAsync(["loadfile", pendingPath, "replace"])
        pendingPath = ""
    }
    function seek(seconds) {
        if (mediaReady) video.commandAsync(["seek", String(Math.max(0, Math.min(duration, seconds))), "absolute+exact"])
    }
    function togglePlay() { if (mediaReady) video.setPropertyAsync("pause", !paused) }
    function requestMeetingContext() {
        const id = diarizationKey()
        if (!backend.available || !id || contextLoading) return
        contextLoading = true; contextText = ""; contextCopyText = ""; tabs.currentIndex = 3
        if (send("context-meeting", id, {maxCharacters: 10000}) < 0) contextLoading = false
    }
    Shortcut { sequence: "Space"; enabled: mediaReady && !textHasFocus && !captureConsent.visible; onActivated: togglePlay() }
    Shortcut { sequence: "Right"; enabled: mediaReady && !textHasFocus && !captureConsent.visible; onActivated: seek(position + 5) }
    Shortcut { sequence: "Left"; enabled: mediaReady && !textHasFocus && !captureConsent.visible; onActivated: seek(position - 5) }
    Dialog {
        id: captureConsent
        property string intent: "capture"
        objectName: "captureConsent"
        title: intent === "resume" ? "Retomar gravações automáticas" : "Antes de iniciar a gravação"
        anchors.centerIn: parent
        width: Math.min(window.width - 64, 520)
        modal: true
        standardButtons: Dialog.Ok | Dialog.Cancel
        closePolicy: Popup.CloseOnEscape
        contentItem: Label {
            text: (captureConsent.intent === "resume" ? "As regras já configuradas poderão iniciar novas gravações. Esta ação não inicia uma captura manual. " : "") + "Confirme a permissão das pessoas envolvidas. A captura usa a tela e as fontes de áudio configuradas. Revise o áudio antes de continuar.\n\n" + audioSummary() + "\n\nFechar o Studio não encerra a captura. Use Parar para finalizá-la. O processamento usa os providers configurados; serviços externos podem receber conteúdo."
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            color: ink
            Accessible.name: text
        }
        onOpened: { standardButton(Dialog.Ok).text = intent === "resume" ? "Retomar automação" : "Iniciar gravação"; standardButton(Dialog.Cancel).text = "Cancelar" }
        onAccepted: {
            if (backend.available && !captureBusy && (intent === "resume" || !captureStatus.active)) {
                captureBusy = true
                if (send(intent === "resume" ? "automation-resume" : "capture-start", "", intent === "resume" ? ({}) : {title: ""}) < 0) captureBusy = false
            }
        }
    }
    Shortcut { sequence: "Escape"; enabled: !!selected.key && !captureConsent.visible; onActivated: backToLibrary() }
    Timer { interval: 1000; running: captureStatus.active; repeat: true; onTriggered: statusNow = Date.now() }
    Component.onCompleted: if (backend.available) { send("list", ""); send("capture-status", ""); send("jobs-list", "") }
    Connections {
        target: backend
        function onFailed(message) { captureKnown = false; pending = {}; errorText = message; loading = false; resolving = false; detailLoading = false; operationPolling = false; captureBusy = false; contextLoading = false }
        function onAvailabilityChanged() {
            if (!backend.available) { captureKnown = false; pending = {}; loading = false; resolving = false; detailLoading = false; operationPolling = false; captureBusy = false; contextLoading = false; notice = "Serviço desconectado. Use Reconectar para continuar." }
            else { errorText = ""; notice = "Serviço conectado."; send("capture-status", ""); send("jobs-list", ""); send("list", "") }
        }
        function onResponse(message) {
            const request = pending[message.id]
            if (!request) return
            const next = Object.assign({}, pending)
            delete next[message.id]
            pending = next
            if (["detail", "resolve", "playback-status", "context-meeting", "diarization-name", "subtitles", "diarization"].includes(request.op) && request.generation !== generation) return
            if (request.op === "playback-status") operationPolling = false
            if (request.op === "list") loading = false
            if (request.op === "detail") detailLoading = false
            if (!message.ok) { errorText = message.error; notice = ""; captureBusy = false; contextLoading = false; if (request.op === "subtitles") subtitleQueued = false; if (request.op === "diarization") diarizationQueued = false; if (request.op === "resolve" || request.op === "playback-status") { resolving = false; playbackOperation = "" } return }
            const result = message.result
            if (request.op === "list") {
                items = result.items
                if (selected.key) { const current = items.find(item => item.key === selected.key); if (current) { selected = current; detailLoading = true; send("detail", selected.key) } else backToLibrary() }
                if (!selected.key && smokeKey) {
                    const target = items.find(item => item.key === smokeKey)
                    if (target) selectRecording(target); else errorText = "Gravação de verificação ausente."
                }
            } else if (request.op === "automation-pause" || request.op === "automation-resume" || request.op === "capture-status" || request.op === "capture-start" || request.op === "capture-stop" || request.op === "capture-recover" || request.op === "audio-defaults") {
                captureStatus = result
                captureKnown = true
                if (request.op !== "capture-status" || !["capture-start", "capture-stop", "capture-recover", "audio-defaults", "automation-pause", "automation-resume"].some(op => hasPending(op))) captureBusy = false
                if (request.op !== "capture-status") notice = request.op === "automation-pause" ? "Novas gravações automáticas pausadas. A captura atual continua até Parar." : request.op === "automation-resume" ? "Automação retomada para futuras chamadas; confira suas regras." : request.op === "capture-start" ? "Captura iniciada." : request.op === "capture-stop" ? "Captura finalizada e enfileirada." : request.op === "capture-recover" ? "Recuperação solicitada." : "Áudio padrão atualizado."
            } else if (request.op === "jobs-list") {
                jobs = result.items || []
                if (selectedJob.id) selectedJob = jobs.find(job => job.id === selectedJob.id) || ({})
            } else if (request.op === "job-process" || request.op === "job-retry") {
                notice = result.warning || (result.status === "completed" ? "Este job já está concluído." : result.status === "active" ? "Este job já está em processamento." : "Job enviado para processamento.")
                send("jobs-list", "")
            } else if (request.op === "diarization-name") {
                notice = "Nome do falante salvo nesta gravação."
                detailLoading = true; send("detail", selected.key)
            } else if (request.op === "context-meeting") {
                contextLoading = false
                contextCopyText = JSON.stringify(result)
                contextText = result.context || result.text || JSON.stringify(result, null, 2)
                contextPath = result.path || result.sourcePath || ""
                contextCitations = result.citations || []
            } else if (request.op === "detail") {
                if (!initialTranscriptTiming) initialTranscriptTiming = result.transcript.timing
                selected = Object.assign({}, selected, {status: result.status, backup: result.backup})
                if (JSON.stringify(detail) !== JSON.stringify(result)) detail = result
                if (diarizationQueued && result.diarization.state === "review") notice = "Falantes identificados. Abra a aba Falantes para revisar."
                else if (diarizationQueued && result.diarization.state === "failed") { notice = ""; errorText = result.diarization.message || "A identificação não foi concluída." }
                diarizationQueued = result.diarization.state === "running"
                if (smokeDiarization && (result.diarization.turns || []).length > 0) tabs.currentIndex = 2
                if (subtitleQueued && result.subtitleState === "ready") { subtitleQueued = false; notice = "Legendas prontas." }
                else if (result.subtitleState === "running") subtitleQueued = true
                else if (subtitleQueued && ["idle", "failed"].includes(result.subtitleState)) { subtitleQueued = false; notice = ""; errorText = "A geração terminou sem produzir legendas. Você pode tentar novamente." }
            } else if (request.op === "resolve" || request.op === "playback-status") {
                if (result.state === "running") { playbackOperation = result.operationId; return }
                resolving = false; playbackOperation = ""
                if (result.state === "failed") { errorText = result.message; notice = ""; return }
                location = result.location; pendingPath = result.path; notice = ""; loadMedia()
            } else if (request.op === "subtitles") {
                subtitleQueued = true; notice = "Legendas solicitadas ao worker configurado. Esta janela atualizará quando estiverem prontas."
            } else if (request.op === "diarization") {
                diarizationQueued = true
                detail = Object.assign({}, detail, {diarization: {state: "running", message: "Identificação automática em preparação…"}, diarizationId: result.id})
                notice = "Identificação de falantes em preparação."
            }
        }
    }
    Timer {
        interval: 5000; repeat: true; running: backend.available && !!selected.key && (subtitleQueued || diarizationQueued || ["pending", "transferring", "queued", "processing"].includes(selected.status) || !!smokeKey)
        onTriggered: { if (!detailLoading) { detailLoading = true; send("detail", selected.key) } }
    }
    Timer {
        interval: 5000; repeat: true; running: backend.available
        onTriggered: {
            if (!hasPending("capture-status")) send("capture-status", "")
            if (!hasPending("jobs-list")) send("jobs-list", "")
        }
    }
    Timer {
        interval: 1000; repeat: true; running: backend.available && !!playbackOperation
        onTriggered: { if (!operationPolling) { operationPolling = true; send("playback-status", playbackOperation) } }
    }
    Timer {
        interval: 200; repeat: true; running: playerInitialized
        onTriggered: {
            const length = Number(video.getProperty("duration")) || 0
            duration = length
            mediaReady = length > 0
            position = Number(video.getProperty("time-pos")) || 0
            paused = video.getProperty("pause") !== false
            const segments = detail.transcript.segments || []
            activeSegment = segments.findIndex(segment => segment.start <= position && position < segment.end)
            activeCaptionSegment = (captionTrack.segments || []).findIndex(segment => segment.start <= position && position < segment.end)
        }
    }

    ColumnLayout {
        anchors.fill: parent; spacing: 0
        Rectangle {
            Layout.fillWidth: true; Layout.preferredHeight: 76; color: panel
            RowLayout {
                anchors.fill: parent; anchors.margins: 22; spacing: 14
                Image { source: lightTheme ? "../../docs/assets/falatrace-mark-light.svg" : "../../docs/assets/falatrace-mark-dark.svg"; sourceSize.width: 40; sourceSize.height: 40; Layout.preferredWidth: 40; Layout.preferredHeight: 40; Accessible.name: "FalaTrace" }
                ColumnLayout {
                    spacing: 2
                    Label { text: "FalaTrace Studio"; color: ink; font.pixelSize: 20; font.weight: Font.DemiBold }
                    Label { text: "Alpha experimental · Linux · notas ligadas à origem"; color: muted; font.pixelSize: 12 }
                }
                Item { Layout.fillWidth: true }
                ColumnLayout {
                    spacing: 4
                    Label { text: !captureKnown ? "Captura: estado desconhecido" : captureStatus.active ? "■ REC · " + clock(Math.max(0, (statusNow - Date.parse(captureStatus.session && captureStatus.session.startedAt || new Date(statusNow).toISOString())) / 1000)) : "○ Captura parada"; color: captureStatus.active ? recordingColor : muted; font.pixelSize: 11 }
                    Label { text: captureStatus.audio && captureStatus.audio.configured && captureStatus.audio.configured.audioSource ? "Áudio: " + captureStatus.audio.configured.audioSource : "Áudio não validado"; color: captureStatus.audio && captureStatus.audio.configured ? muted : warningColor; font.pixelSize: 10 }
                }
                Button { opacity: enabled ? 1 : 0.5; text: lightTheme ? "Tema escuro" : "Tema claro"; Accessible.name: text; onClicked: lightTheme = !lightTheme }
                Button { opacity: enabled ? 1 : 0.5; text: "Atualizar biblioteca"; enabled: backend.available && !loading; onClicked: { loading = true; send("list", "") } }
                Button { opacity: enabled ? 1 : 0.5; text: backend.available ? "Reconectar" : "Reconectar serviço"; enabled: !backend.available; onClicked: backend.reconnect() }
            }
        }
        RowLayout {
            Layout.fillWidth: true; Layout.fillHeight: true; spacing: 0
            Rectangle {
                Layout.preferredWidth: window.width < 1100 ? 248 : 276; Layout.fillHeight: true; color: surface
                ColumnLayout {
                    anchors.fill: parent; anchors.margins: 16; spacing: 14
                    RowLayout { Label { text: "Gravações"; color: ink; font.pixelSize: 16; font.bold: true } Item { Layout.fillWidth: true } Label { text: items.length; color: muted } }
                    TextField { id: search; Layout.fillWidth: true; placeholderText: "Buscar gravação…"; Accessible.name: "Buscar gravação" }
                    BusyIndicator { Layout.alignment: Qt.AlignHCenter; running: loading; visible: loading }
                    Label { visible: !loading && !filtered.length; text: items.length ? "Nenhum resultado." : "Nenhuma gravação encontrada."; color: muted; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                    Rectangle {
                        Layout.fillWidth: true; Layout.preferredHeight: 220; color: panel; radius: 8
                        ColumnLayout {
                            anchors.fill: parent; anchors.margins: 10; spacing: 6
                            RowLayout { Label { text: "Captura"; color: ink; font.bold: true; font.pixelSize: 12 } Item { Layout.fillWidth: true } Label { text: captureStatus.active ? "ativa" : "parada"; color: captureStatus.active ? recordingColor : muted; font.pixelSize: 11 } }
                            RowLayout {
                                Button { opacity: enabled ? 1 : 0.5; Layout.preferredWidth: 68; text: "Iniciar"; enabled: backend.available && captureKnown && !captureBusy && !captureStatus.active; onClicked: { captureConsent.intent = "capture"; captureConsent.open() } }
                                Button { opacity: enabled ? 1 : 0.5; Layout.preferredWidth: 68; text: "Parar"; enabled: backend.available && captureKnown && !captureBusy && captureStatus.active; onClicked: { captureBusy = true; if (send("capture-stop", "") < 0) captureBusy = false } }
                                Button { opacity: enabled ? 1 : 0.5; Layout.preferredWidth: 82; text: "Recuperar"; enabled: backend.available && captureKnown && !captureBusy && !captureStatus.active; onClicked: { captureBusy = true; if (send("capture-recover", "") < 0) captureBusy = false } }
                            }
                            Label { textFormat: Text.PlainText; text: captureStatus.warning || (captureStatus.audio && captureStatus.audio.error) || audioSummary(); color: captureStatus.warning || (captureStatus.audio && captureStatus.audio.error) ? warningColor : muted; font.pixelSize: 10; elide: Text.ElideRight; Layout.fillWidth: true; HoverHandler { id: audioHover } ToolTip.visible: audioHover.hovered; ToolTip.text: audioSummary() }
                            Label { text: captureStatus.paused ? "Automação pausada · captura atual continua" : "Automação: confira suas regras"; color: muted; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 10 }
                            Button { opacity: enabled ? 1 : 0.5; text: captureStatus.paused ? "Retomar automação…" : "Pausar novas gravações"; enabled: backend.available && !captureBusy; onClicked: { if (captureStatus.paused) { captureConsent.intent = "resume"; captureConsent.open() } else { captureBusy = true; if (send("automation-pause", "") < 0) captureBusy = false } } }
                            Button { opacity: enabled ? 1 : 0.5; text: "Configurar áudio"; enabled: backend.available && !captureBusy; onClicked: { captureBusy = true; if (send("audio-defaults", "") < 0) captureBusy = false } }
                        }
                    }
                    Rectangle {
                        visible: jobs.length > 0
                        Layout.fillWidth: true; Layout.preferredHeight: 145; color: panel; radius: 8
                        ColumnLayout {
                            anchors.fill: parent; anchors.margins: 10; spacing: 5
                            RowLayout { Label { text: "Jobs"; color: ink; font.bold: true; font.pixelSize: 12 } Item { Layout.fillWidth: true } Label { text: jobs.length; color: muted; font.pixelSize: 11 } }
                            ComboBox { id: jobPicker; Layout.fillWidth: true; model: jobs; textRole: "title"; currentIndex: jobs.findIndex(job => job.id === selectedJob.id); displayText: selectedJob.title || "Selecione um job"; enabled: backend.available; onActivated: selectedJob = jobs[index] || ({}) }
                            Label { textFormat: Text.PlainText; text: selectedJob.id ? (statusText(selectedJob.state) + (selectedJob.error ? " · " + selectedJob.error : "")) : "Selecione um job"; color: selectedJob.error ? errorColor : muted; font.pixelSize: 10; elide: Text.ElideRight; Layout.fillWidth: true }
                            RowLayout {
                                Button { opacity: enabled ? 1 : 0.5; text: "Processar"; enabled: backend.available && !hasPending("job-process") && !hasPending("job-retry") && !!selectedJob.id && ["pending", "queued", "transferring"].includes(selectedJob.state); onClicked: send("job-process", selectedJob.id) }
                                Button { opacity: enabled ? 1 : 0.5; text: "Repetir"; enabled: backend.available && !hasPending("job-process") && !hasPending("job-retry") && !!selectedJob.id && selectedJob.state === "failed"; onClicked: send("job-retry", selectedJob.id) }
                            }
                        }
                    }
                    ListView {
                        id: libraryView
                        currentIndex: filtered.findIndex(item => item.key === selected.key)
                        Layout.fillWidth: true; Layout.fillHeight: true; clip: true; spacing: 6; model: filtered
                        ScrollBar.vertical: ScrollBar {}
                        delegate: ItemDelegate {
                            required property var modelData
                            width: ListView.view.width; height: 102
                            enabled: backend.available
                            Accessible.name: modelData.title + ", " + origin(modelData.location)
                            background: Rectangle { radius: 8; color: selected.key === modelData.key ? selectedSurface : parent.hovered ? hoverSurface : "transparent" }
                            contentItem: ColumnLayout {
                                spacing: 5
                                Label { text: modelData.title; color: ink; font.pixelSize: 13; font.weight: Font.Medium; wrapMode: Text.Wrap; maximumLineCount: 2; elide: Text.ElideRight; Layout.fillWidth: true; textFormat: Text.PlainText }
                                Label { text: Qt.formatDateTime(new Date(modelData.modifiedAt), "dd MMM · hh:mm"); color: muted; font.pixelSize: 11 }
                                Label { text: origin(modelData.location) + " · " + statusText(modelData.status); color: selected.key === modelData.key ? accent : muted; font.pixelSize: 10; elide: Text.ElideRight; Layout.fillWidth: true }
                            }
                            onClicked: selectRecording(modelData)
                        }
                    }
                }
            }
            ColumnLayout {
                Layout.fillWidth: true; Layout.fillHeight: true; Layout.margins: 22; spacing: 14
                Button { opacity: enabled ? 1 : 0.5; visible: !!selected.key; text: "← Biblioteca"; onClicked: backToLibrary(); Accessible.name: "Voltar à biblioteca" }
                Label { text: selected.title || "Sua biblioteca de gravações"; color: ink; font.pixelSize: 21; font.weight: Font.DemiBold; Layout.fillWidth: true; elide: Text.ElideRight; textFormat: Text.PlainText }
                Label { text: selected.key ? (mediaReady && location ? "Reproduzindo de " + origin(location) : "Origem: " + origin(selected.location)) + (selected.backup && selected.backup !== "none" ? "  ·  Cópias: " + selected.backup.replace("+", " + ").toUpperCase() : "") : "Selecione uma gravação para acessar o vídeo e o conteúdo."; color: muted; font.pixelSize: 12; Layout.fillWidth: true; elide: Text.ElideRight }
                RowLayout {
                    Layout.fillWidth: true; Layout.fillHeight: true; spacing: 18
                    ColumnLayout {
                        Layout.fillWidth: true; Layout.fillHeight: true; spacing: 10
                        Rectangle {
                            Layout.fillWidth: true; Layout.fillHeight: true; Layout.minimumHeight: 220; color: "#05080d"; radius: 8; clip: true
                            RecordingVideo {
                                id: video; objectName: "recordingVideo"; anchors.fill: parent
                                onReady: { playerInitialized = true; setPropertyAsync("pause", true); setPropertyAsync("hwdec", smokeSoftware ? "no" : "auto-safe"); setPropertyAsync("volume", 70); loadMedia() }
                            }
                            ColumnLayout {
                                anchors.centerIn: parent; width: parent.width - 48; visible: !mediaReady
                                BusyIndicator { Layout.alignment: Qt.AlignHCenter; running: resolving; visible: resolving }
                                Label { Layout.fillWidth: true; text: resolving ? "Preparando a gravação…" : selected.key ? "Vídeo pronto para abrir" : "Escolha uma gravação"; color: "#F4F1E9"; font.pixelSize: 18; horizontalAlignment: Text.AlignHCenter; wrapMode: Text.WordWrap }
                                Button { opacity: enabled ? 1 : 0.5; Layout.alignment: Qt.AlignHCenter; visible: !!selected.key && !resolving; enabled: backend.available && selected.location !== "missing"; text: "Abrir gravação"; onClicked: openRecording() }
                            }
                            Rectangle {
                                anchors.top: parent.top; anchors.left: parent.left; anchors.margins: 12
                                width: currentVoices.implicitWidth + 20; height: currentVoices.implicitHeight + 12; radius: 5; color: "#d910141a"
                                visible: mediaReady && !!activeSpeakerLabels(position)
                                Label { id: currentVoices; anchors.centerIn: parent; text: activeSpeakerLabels(position) + " · automático"; textFormat: Text.PlainText; color: accent; font.pixelSize: 12 }
                            }
                            Rectangle {
                                anchors.bottom: parent.bottom; anchors.bottomMargin: 24; anchors.horizontalCenter: parent.horizontalCenter
                                width: Math.min(parent.width - 36, caption.implicitWidth + 28); height: caption.implicitHeight + 16; radius: 5; color: "#d910141a"
                                visible: captions && mediaReady && captionTrack.timing === "segment" && activeCaptionSegment >= 0
                                Label { id: caption; anchors.centerIn: parent; width: parent.width - 28; text: activeCaptionSegment >= 0 ? captionTrack.segments[activeCaptionSegment].text : ""; textFormat: Text.PlainText; color: "white"; wrapMode: Text.WordWrap; horizontalAlignment: Text.AlignHCenter; font.pixelSize: 16 }
                            }
                        }
                        Slider { id: timeline; Layout.fillWidth: true; from: 0; to: window.duration || 1; value: window.position; enabled: mediaReady; Accessible.name: "Posição do vídeo"; onMoved: window.seek(value) }
                        RowLayout {
                            Button { Layout.minimumWidth: 40; Layout.preferredWidth: window.width < 1100 ? 40 : 100; Accessible.name: paused ? "Reproduzir" : "Pausar"; opacity: enabled ? 1 : 0.5; text: window.width < 1100 ? (paused ? "▶" : "Ⅱ") : paused ? "▶ Reproduzir" : "Ⅱ Pausar"; enabled: mediaReady; onClicked: togglePlay() }
                            Button { Layout.minimumWidth: 54; Layout.preferredWidth: window.width < 1100 ? 54 : 100; Accessible.name: "Voltar dez segundos"; opacity: enabled ? 1 : 0.5; text: "−10 s"; enabled: mediaReady; onClicked: seek(position - 10) }
                            Label { text: clock(position) + " / " + clock(duration); color: muted; font.family: "monospace"; font.pixelSize: 12 }
                            Item { Layout.fillWidth: true }
                            CheckBox { text: window.width < 1100 ? "CC" : "Legendas"; Accessible.name: "Legendas"; checked: captions; enabled: captionTrack.timing === "segment"; onToggled: captions = checked }
                        }
                    }
                    Rectangle {
                        Layout.preferredWidth: Math.max(290, Math.min(390, window.width * 0.28)); Layout.fillHeight: true; color: surface; radius: 8
                        ColumnLayout {
                            anchors.fill: parent; anchors.margins: 14; spacing: 12
                            TabBar {
                                id: tabs; Layout.fillWidth: true
                                Repeater {
                                model: ["Transcrição", "Resumo", "Falantes", "Contexto IA"]
                                    TabButton { opacity: enabled ? 1 : 0.5;
                                        required property string modelData
                                        text: modelData
                                        contentItem: Label { text: parent.text; color: parent.checked ? accent : muted; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter; font.pixelSize: 12 }
                                        background: Rectangle { color: parent.checked ? selectedSurface : canvas; radius: 4 }
                                    }
                                }
                            }
                            Label { visible: tabs.currentIndex === 1; text: detail.summaryInfo ? "Configuração do job: " + detail.summaryInfo + " · Resumo de IA: confira a fonte e os avisos de revisão." : "Resumo de IA: confira a fonte e os avisos de revisão."; textFormat: Text.PlainText; color: muted; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 11 }
                            Label { visible: tabs.currentIndex === 0 && detail.transcript.timing === "block"; text: "Texto original; tempos aproximados por bloco."; color: muted; font.pixelSize: 11; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                            Label { visible: tabs.currentIndex === 2; textFormat: Text.PlainText; text: detail.diarization.message || "Identifique os falantes para revisar suas participações nesta gravação."; color: detail.diarization.state === "failed" ? errorColor : muted; font.pixelSize: 11; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                            Label { visible: tabs.currentIndex === 2 && (detail.diarization.turns || []).length > 0; text: "A aba Transcrição mantém o texto original. Os horários desta aba pertencem à identificação de vozes."; color: muted; font.pixelSize: 11; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                            ListView {
                                visible: tabs.currentIndex === 0 && (detail.transcript.segments || []).length > 0
                                Layout.fillWidth: true; Layout.fillHeight: true; model: detail.transcript.segments || []; clip: true; spacing: 6
                                ScrollBar.vertical: ScrollBar {}
                                delegate: ItemDelegate {
                                    required property var modelData; required property int index
                                    width: ListView.view.width; height: segmentContent.implicitHeight + 20
                                    enabled: mediaReady
                                    background: Rectangle { radius: 6; color: activeSegment === index ? selectedSurface : parent.hovered ? hoverSurface : "transparent" }
                                    contentItem: ColumnLayout { id: segmentContent; spacing: 5; Label { text: clock(modelData.start); color: accent; font.pixelSize: 11; font.family: "monospace" } Label { text: modelData.text; textFormat: Text.PlainText; color: ink; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 13 } }
                                    onClicked: seek(modelData.start)
                                }
                            }
                            ColumnLayout {
                                visible: tabs.currentIndex === 2
                                Layout.fillWidth: true; Layout.fillHeight: true; spacing: 6
                                Label { text: "Nomes dos falantes"; color: muted; font.pixelSize: 10 }
                                ListView {
                                    Layout.fillWidth: true; Layout.preferredHeight: Math.min(112, Math.max(54, speakerRows.length * 54)); model: speakerRows; clip: true; spacing: 4
                                    delegate: ItemDelegate {
                                        required property var modelData
                                        width: ListView.view.width; height: 50
                                        enabled: backend.available && !!selected.key
                                        Accessible.name: modelData.label || "Falante incerto"
                                        contentItem: RowLayout {
                                            spacing: 6
                                            Label { text: modelData.speakerId; color: accent; Layout.preferredWidth: 70; elide: Text.ElideRight; font.pixelSize: 10 }
                                            TextField { id: renameField; placeholderText: "Falante incerto"; text: modelData.label; Layout.fillWidth: true; font.pixelSize: 11; onAccepted: if (text.trim()) send("diarization-name", diarizationKey(), {speakerId: modelData.speakerId, label: text.trim()}) }
                                            Button { opacity: enabled ? 1 : 0.5; text: "Salvar"; Layout.preferredWidth: 58; enabled: backend.available && !!renameField.text.trim() && renameField.text.trim() !== modelData.label; onClicked: send("diarization-name", diarizationKey(), {speakerId: modelData.speakerId, label: renameField.text.trim()}) }
                                        }
                                    }
                                }
                                Label { text: "Linha acústica · clique para navegar"; color: muted; font.pixelSize: 10 }
                                ListView {
                                    Layout.fillWidth: true; Layout.fillHeight: true; model: detail.diarization.turns || []; clip: true; spacing: 3
                                    ScrollBar.vertical: ScrollBar {}
                                    delegate: ItemDelegate {
                                        required property var modelData
                                        width: ListView.view.width; height: 38; enabled: mediaReady
                                        Accessible.name: (modelData.label || modelData.speaker || "Falante incerto") + ", " + preciseClock(modelData.start) + " a " + preciseClock(modelData.end)
                                        contentItem: RowLayout { spacing: 6; Label { text: preciseClock(modelData.start) + "–" + preciseClock(modelData.end); color: accent; font.family: "monospace"; font.pixelSize: 10; Layout.preferredWidth: 92 } Label { text: modelData.label || modelData.speaker || "Falante incerto"; textFormat: Text.PlainText; color: ink; font.pixelSize: 12; Layout.fillWidth: true; elide: Text.ElideRight } }
                                        onClicked: seek(Number(modelData.start))
                                    }
                                }
                            }
                            RowLayout {
                                visible: tabs.currentIndex === 3
                                Layout.fillWidth: true
                                Button { opacity: enabled ? 1 : 0.5; text: contextLoading ? "Preparando contexto…" : "Pedir contexto"; enabled: backend.available && !!diarizationKey() && !contextLoading; onClicked: requestMeetingContext() }
                                Button { opacity: enabled ? 1 : 0.5; text: "Copiar contexto"; enabled: !!contextText && !!contextCopyText; onClicked: { compactContext.selectAll(); compactContext.copy(); compactContext.deselect() } }
                            }
                            TextEdit { id: compactContext; visible: false; text: contextCopyText; textFormat: TextEdit.PlainText }
                            Label { textFormat: Text.PlainText; visible: tabs.currentIndex === 3 && !!contextPath; text: "Fonte: " + contextPath; color: muted; font.pixelSize: 10; elide: Text.ElideMiddle; Layout.fillWidth: true }
                            Label { textFormat: Text.PlainText; visible: tabs.currentIndex === 3 && contextCitations.length > 0; text: "Citações: " + contextCitations.join(" · "); color: muted; font.pixelSize: 10; elide: Text.ElideRight; Layout.fillWidth: true }
                            ScrollView {
                                visible: tabs.currentIndex !== 0 && tabs.currentIndex !== 2 || (tabs.currentIndex === 0 && !(detail.transcript.segments || []).length)
                                Layout.fillWidth: true; Layout.fillHeight: true; clip: true
                                TextArea { id: contextArea; readOnly: true; selectByMouse: true; wrapMode: TextEdit.Wrap; textFormat: TextEdit.PlainText; color: ink; font.pixelSize: 13; text: tabs.currentIndex === 0 ? detail.transcript.text || (detailLoading ? "Carregando…" : "Transcrição ainda não disponível.") : tabs.currentIndex === 1 ? detail.summary || "Resumo ainda não disponível." : tabs.currentIndex === 3 ? (contextText || (contextLoading ? "Preparando contexto sob demanda…" : "Peça o contexto para esta gravação quando precisar.")) : detail.timesheet || "Nenhum apontamento vinculado a esta gravação." }
                            }
                            Button { opacity: enabled ? 1 : 0.5; visible: tabs.currentIndex === 0 && !!detail.subtitleId; Layout.fillWidth: true; text: subtitleQueued ? "Legendas em preparação…" : "Gerar legendas no worker configurado"; enabled: backend.available && !subtitleQueued && detail.subtitleState !== "ready"; onClicked: { subtitleQueued = true; if (send("subtitles", detail.subtitleId) < 0) subtitleQueued = false } }
                            Button { opacity: enabled ? 1 : 0.5; visible: (tabs.currentIndex === 0 || tabs.currentIndex === 2) && !!detail.diarizationId && !(tabs.currentIndex === 2 && detail.diarization.state === "review"); Layout.fillWidth: true; text: diarizationQueued ? "Identificação em preparação…" : detail.diarization.state === "review" ? "Ver falantes" : "Identificar falantes"; enabled: backend.available && !diarizationQueued; onClicked: { if (detail.diarization.state === "review") tabs.currentIndex = 2; else { diarizationQueued = true; if (send("diarization", detail.diarizationId) < 0) diarizationQueued = false } } }
                        }
                    }
                }
                Label { textFormat: Text.PlainText; text: (errorText ? "⚠ " + errorText : "") || notice || "Espaço: reproduzir/pausar · Setas: ±5 s · Esc: biblioteca · Trechos: navegar à origem"; color: errorText ? errorColor : muted; font.pixelSize: 11; wrapMode: Text.WordWrap; Layout.fillWidth: true }
            }
        }
        Label { Layout.fillWidth: true; leftPadding: 22; bottomPadding: 12; topPadding: 10; text: "Captura, processamento e backups continuam nos serviços ao fechar esta janela."; color: muted; font.pixelSize: 11 }
    }
}
