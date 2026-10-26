import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Live capture (DESIGN-STUDIO §2.8): the notepad is the page, so typing notes while recording is the
// obvious thing to do. Each line keeps the moment it was written. "Parar e gerar notas" stops like
// the top bar's Parar; afterwards the page shows the steps until the new meeting appears in the list,
// then opens it on Notas (its notes are ready there, or arrive there).
Rectangle {
    id: liveView
    objectName: "liveView"
    property alias notesEditor: liveNotesEditor
    property alias transcriptPanel: transcriptPanel
    // The capture being written: its session id is the notes id and becomes the job id.
    property string sessionId: ""
    property string sessionStartedAt: ""
    property bool startedHere: false
    property bool afterStop: false
    property var stopResult: ({})
    property int listTries: 0
    property string awaitingJobId: ""
    // Test capture (first steps): stops by itself after a minute.
    property bool testMode: false
    property bool testStopSent: false
    readonly property real elapsed: captureStatus.active && sessionStartedAt ? Math.max(0, (statusNow - Date.parse(sessionStartedAt)) / 1000) : 0
    readonly property bool recording: captureStatus.active && !!captureStatus.session && captureStatus.session.id === sessionId && sessionId !== ""
    anchors.fill: parent
    color: pageSurface
    visible: currentView === "live"

    function syncSession() {
        const session = captureStatus.session
        if (!captureStatus.active || !session || !session.id) return
        if (session.id !== sessionId) {
            sessionId = session.id; sessionStartedAt = session.startedAt || ""
            afterStop = false; stopResult = ({}); listTries = 0; testStopSent = false
            // Test mode is set before the test capture starts: only a capture this Studio did not ask for
            // (an automatic one) clears it. A status poll can report the new session before capture-start answers.
            if (!startedHere && !hasPending("capture-start")) testMode = false
        }
    }
    // capture-start answered by this Studio: the notepad opens (when notes are on).
    function captureStarted() {
        startedHere = true
        syncSession()
        if (feature("notes")) navigate("live")
    }
    // Right before Parar: what was typed is saved first.
    function prepareStop() { if (recording) liveNotesEditor.saveNow() }
    function captureStopped(result) {
        const ours = !!sessionId && (currentView === "live" || startedHere)
        startedHere = false
        if (!ours) return
        afterStop = true; stopResult = result || ({}); listTries = 0
        awaitingJobId = result && result.jobId ? String(result.jobId) : ""
        liveNotesEditor.saveNow()
    }
    // A fresh list may hold the stopped meeting: open it on Notas.
    function libraryUpdated() {
        if (!afterStop || currentView !== "live") return
        const id = sessionId.toLowerCase(), job = awaitingJobId.toLowerCase()
        let item = items.find(function(entry){ return [entry.jobId, entry.recordingId].some(function(value){ return !!value && (String(value).toLowerCase() === id || (job && String(value).toLowerCase() === job)) }) })
        if (!item && !job) {
            // Without a job (automatic processing off) the newest recording since the capture began is it.
            const since = Date.parse(sessionStartedAt) - 5000
            const recent = items.filter(function(entry){ return timeValue(entry.modifiedAt) >= since }).sort(function(a, b){ return timeValue(b.modifiedAt) - timeValue(a.modifiedAt) })
            item = recent.length ? recent[0] : null
        }
        if (!item) return
        afterStop = false
        selectRecording(item)
    }
    function appendToNotes(text) {
        const line = String(text || "").trim()
        if (!line || !liveNotesEditor.loaded) return
        const area = liveNotesEditor.area
        const prefix = area.text && !area.text.endsWith("\n") ? "\n" : ""
        area.insert(area.length, prefix + "“" + line + "”")
        liveNotesEditor.saveSoon(true)
    }
    function stepState(step) {
        // 0 saving, 1 transcribing, 2 generating notes.
        if (!afterStop) return "todo"
        if (step === 0) return "done"
        if (!awaitingJobId) return "todo"
        return step === 1 ? "active" : "todo"
    }

    Connections { target: window; function onCaptureStatusChanged() { liveView.syncSession() } }
    Connections {
        target: window
        // The notes of the meeting this page stopped: say when they are ready.
        function onDetailChanged() {
            if (!liveView.awaitingJobId || detail.jobId !== liveView.awaitingJobId) return
            if (detail.notesDoc || detail.summary) { liveView.awaitingJobId = ""; toast.show(t("Notas prontas"), "", null) }
            else if (detail.status === "failed") { liveView.awaitingJobId = ""; toast.show(t("Não deu para gerar as notas desta reunião."), "", null, {kind: "warning"}) }
        }
    }
    // Until the meeting shows up in the list, ask again (bounded: about half a minute).
    Timer { interval: 2000; repeat: true; running: liveView.afterStop && liveView.visible && liveView.listTries < 15; onTriggered: { liveView.listTries += 1; refreshLibrary() } }
    // Test capture: one minute, then it stops by itself.
    Timer { interval: 1000; repeat: true; running: liveView.testMode && liveView.recording && !liveView.testStopSent; onTriggered: { if (liveView.elapsed >= 60) { liveView.testStopSent = true; stopCapture() } } }
    onVisibleChanged: if (visible && liveNotesEditor.loaded) liveNotesEditor.area.forceActiveFocus(Qt.OtherFocusReason)

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        // ── Header: REC, the title, the live transcript switch and Parar ──
        Rectangle {
            objectName: "liveHeader"
            Layout.fillWidth: true
            implicitHeight: headerRow.implicitHeight + (compactLayout ? 18 : 24)
            color: canvas
            Rectangle { anchors.left: parent.left; anchors.right: parent.right; anchors.bottom: parent.bottom; height: 1; color: divider }
            RowLayout {
                id: headerRow
                anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                anchors.leftMargin: compactLayout ? 14 : 22; anchors.rightMargin: compactLayout ? 14 : 22
                spacing: 12
                Rectangle {
                    implicitWidth: 12; implicitHeight: 12; radius: liveView.recording ? 2 : 6
                    color: liveView.recording ? recordingColor : "transparent"
                    border.width: liveView.recording ? 0 : 2; border.color: muted
                    SequentialAnimation on opacity { running: liveView.recording && liveView.visible; loops: Animation.Infinite; NumberAnimation { to: 0.35; duration: 700 } NumberAnimation { to: 1; duration: 700 } }
                }
                Label {
                    text: liveView.recording ? t("REC ") + captureClock() : liveView.afterStop ? t("Gravação parada") : t("Sem gravação")
                    textFormat: Text.PlainText; color: liveView.recording ? recordingColor : muted
                    font.pixelSize: 14; font.weight: Font.DemiBold; font.family: liveView.recording ? "monospace" : font.family
                }
                TextField {
                    id: liveTitle
                    objectName: "liveTitle"
                    Layout.fillWidth: true
                    Layout.minimumWidth: 120
                    enabled: liveNotesEditor.loaded
                    text: liveNotesEditor.title
                    placeholderText: liveView.testMode ? t("Conversa de teste") : t("Reunião sem título")
                    placeholderTextColor: muted
                    color: ink
                    font.pixelSize: compactLayout ? 17 : 19
                    font.weight: Font.DemiBold
                    Accessible.name: t("Título desta reunião")
                    background: Rectangle { color: "transparent"; radius: 6; border.width: liveTitle.activeFocus ? 2 : 0; border.color: accent }
                    onTextEdited: { liveNotesEditor.title = text; liveNotesEditor.saveSoon(false) }
                    Connections { target: liveNotesEditor; function onTitleChanged() { if (!liveTitle.activeFocus && liveTitle.text !== liveNotesEditor.title) liveTitle.text = liveNotesEditor.title } }
                    Keys.onReturnPressed: liveNotesEditor.area.forceActiveFocus(Qt.TabFocusReason)
                }
                FtButton {
                    id: liveTranscriptToggle
                    objectName: "liveTranscriptToggle"
                    visible: feature("live")
                    compact: true
                    variant: transcriptPanel.shown ? "secondary" : "outline"
                    iconName: "wave"
                    iconOnly: compactLayout
                    text: transcriptPanel.shown ? t("Ocultar ao vivo") : t("Transcrição ao vivo")
                    Accessible.name: transcriptPanel.shown ? t("Ocultar a transcrição ao vivo") : t("Mostrar a transcrição ao vivo")
                    onClicked: transcriptPanel.shown = !transcriptPanel.shown
                }
                FtButton {
                    id: liveStop
                    objectName: "liveStop"
                    visible: liveView.recording
                    variant: "danger"
                    compact: true
                    iconName: "stop"
                    text: compactLayout ? t("Parar") : t("Parar e gerar notas")
                    Accessible.name: t("Parar a gravação e gerar as notas")
                    enabled: backend.available && captureKnown && !captureBusy
                    Keys.onReturnPressed: clicked()
                    Keys.onEnterPressed: clicked()
                    onClicked: stopCapture()
                }
            }
        }

        // ── Body: the notepad (with the after-stop steps above it) and, when shown, the live transcript ──
        RowLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 0
            Item {
                Layout.fillWidth: true
                Layout.fillHeight: true
                ColumnLayout {
                    width: Math.min(docMaxWidth + 60, parent.width - (compactLayout ? 24 : 48))
                    x: (parent.width - width) / 2
                    anchors.top: parent.top; anchors.bottom: parent.bottom
                    anchors.topMargin: compactLayout ? 10 : 18; anchors.bottomMargin: 8
                    spacing: 10

                    Label {
                        objectName: "liveCoach"
                        visible: liveView.recording && (liveView.testMode || !liveNotesEditor.savedText)
                        Layout.fillWidth: true
                        text: liveView.testMode ? tf("Conversa de teste · para sozinha em %1. Fale por uns 30 segundos e anote uma ou duas linhas.", clock(Math.max(0, 60 - liveView.elapsed))) : t("Escreva uma linha quando algo importar: cada linha guarda o momento em que foi escrita, e o FalaTrace completa o resto depois.")
                        textFormat: Text.PlainText; color: muted; font.pixelSize: 13; wrapMode: Text.WordWrap
                    }

                    // After Parar: the steps until the notes exist; the notepad stays editable.
                    Rectangle {
                        objectName: "liveAfterStop"
                        visible: liveView.afterStop
                        Layout.fillWidth: true
                        implicitHeight: stepsColumn.implicitHeight + 24
                        radius: 12; color: surfaceAlt; border.width: 1; border.color: divider
                        ColumnLayout {
                            id: stepsColumn
                            anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 12
                            spacing: 8
                            Flow {
                                Layout.fillWidth: true
                                spacing: 14
                                Repeater {
                                    model: [t("Salvando a gravação"), t("Transcrevendo"), t("Gerando notas")]
                                    delegate: RowLayout {
                                        id: stepRow
                                        required property string modelData
                                        required property int index
                                        readonly property string stepStatus: liveView.stepState(index)
                                        spacing: 6
                                        Accessible.role: Accessible.StaticText
                                        Accessible.name: modelData + (stepStatus === "done" ? t(", feito") : stepStatus === "active" ? t(", em andamento") : "")
                                        Rectangle {
                                            implicitWidth: 18; implicitHeight: 18; radius: 9
                                            color: stepRow.stepStatus === "done" ? accent : "transparent"
                                            border.width: stepRow.stepStatus === "done" ? 0 : 2
                                            border.color: stepRow.stepStatus === "active" ? accent : dividerStrong
                                            FtIcon { anchors.centerIn: parent; visible: stepRow.stepStatus === "done"; name: "check"; tint: onAccent; size: 12 }
                                        }
                                        Label { text: stepRow.modelData; textFormat: Text.PlainText; color: stepRow.stepStatus === "todo" ? muted : ink; font.pixelSize: 13; font.weight: stepRow.stepStatus === "active" ? Font.DemiBold : Font.Normal }
                                    }
                                }
                            }
                            Label {
                                Layout.fillWidth: true
                                text: liveView.stopResult.stopWarning ? t("Captura parada, com aviso: ") + t(liveView.stopResult.stopWarning)
                                    : liveView.awaitingJobId ? (liveView.listTries >= 15 ? t("A gravação foi salva e as notas estão sendo feitas. Ela aparece na lista de reuniões em instantes.") : t("Abrindo a reunião… Você pode continuar anotando aqui."))
                                    : t("Gravação salva. Gere as notas quando quiser, na página da reunião.")
                                textFormat: Text.PlainText; color: liveView.stopResult.stopWarning ? warningColor : muted; font.pixelSize: 13; wrapMode: Text.WordWrap
                            }
                            FtButton { visible: liveView.listTries >= 15; compact: true; variant: "outline"; iconName: "refresh"; text: t("Atualizar a lista"); onClicked: { liveView.listTries = 0; refreshLibrary() } }
                        }
                    }

                    FtEmptyState {
                        visible: !feature("notes") || (!liveView.sessionId && !liveView.afterStop)
                        Layout.fillWidth: true
                        Layout.topMargin: 30
                        iconName: "note"
                        title: !feature("notes") ? t("O bloco de notas está desligado.") : t("Nenhuma gravação em andamento.")
                        body: !feature("notes") ? t("Ligue em Configurações para anotar durante as reuniões.") : t("Comece uma gravação para anotar enquanto ela acontece.")
                        primaryText: !feature("notes") ? t("Abrir configurações") : captureStatus.active ? "" : t("Gravar…")
                        primaryIcon: !feature("notes") ? "settings" : "record"
                        onPrimaryClicked: { if (!feature("notes")) settingsDialog.open(); else { captureConsent.intent = "capture"; captureConsent.open() } }
                    }
                    NotesEditor {
                        id: liveNotesEditor
                        objectName: "liveNotesEditor"
                        visible: feature("notes") && !!liveView.sessionId
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        origin: "liveNotes"
                        live: true
                        sendTitle: true
                        notesKey: feature("notes") ? liveView.sessionId : ""
                        onLoadedChanged: if (loaded && liveView.visible) area.forceActiveFocus(Qt.OtherFocusReason)
                    }
                }
            }
            LiveTranscriptPanel {
                id: transcriptPanel
                visible: shown && feature("live")
                Layout.preferredWidth: compactLayout ? 280 : 360
                Layout.fillHeight: true
                sessionId: liveView.sessionId
                onAddToNotes: text => liveView.appendToNotes(text)
            }
        }
    }
}
