import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// The meeting page (DESIGN-STUDIO §2.4–2.6): notes first. Header with the meeting's facts and
// "Gerar notas…", tabs in the order Notas (1), Transcrição (0), Falantes (2), Agentes (3) (the values
// keep their old meaning), the document, and the player strip at the bottom.
ColumnLayout {
    id: detailView
    objectName: "detailView"
    property alias tabs: tabs
    property alias notesMode: notesMode
    property alias playerStrip: playerStrip
    property alias notesDocument: notesDocument
    property alias notesEditor: meetingNotesEditor
    property alias video: playerStrip.video
    property alias videoFrame: playerStrip.videoFrame
    property alias captionOverlay: playerStrip.captionOverlay
    property alias captionViewport: playerStrip.captionViewport
    property alias caption: playerStrip.caption
    property alias captionToggle: playerStrip.captionToggle
    property alias timeline: playerStrip.timeline
    property alias openRecordingButton: playerStrip.openRecordingButton
    property alias revisionSegmentsList: revisionSegmentsList
    property alias revisionSpeakersList: revisionSpeakersList
    property alias revisionTurnsList: revisionTurnsList
    property alias contextExcerpts: contextExcerpts
    property alias contextArea: contextArea
    property alias compactContext: compactContext
    property alias processButton: processButton
    property alias agentAccessButton: agentAccessButton
    property alias visualSummaryButton: notesDocument.visualSummaryButton
    property alias summaryRegenerateButton: notesDocument.summaryRegenerateButton
    property alias exportButton: exportButton
    property alias reviewNoteButton: reviewNoteButton
    property alias speakerSuggestButton: speakerSuggestButton
    property alias templatePicker: templatePicker
    property alias regenerateBar: regenerateBar
    property alias shareButton: shareButton
    property alias askToggle: askToggle
    readonly property bool menuOpen: meetingMenu.visible || notesDocument.regenerateMenuOpen
    readonly property bool templatePickerOpen: templatePicker.visible
    // What the media left by retention still allows (detail.media.features); unknown means yes.
    function mediaAllows(name) { return !(detail.media && detail.media.features && detail.media.features[name] === false) }
    readonly property bool mediaRemovable: feature("mediaRemoval") && !!selected.key && selected.sourceExists !== false && !mediaGone(selected) && mediaState !== "removed"
    // The transcript line a citation asked for, flashed for 1.5 s.
    property int flashIndex: -1
    property var pendingFocus: null
    readonly property var meetingPeople: {
        const fromDetail = asList(detail.people).map(function(person){ return person.name || "" }).filter(function(name){ return !!name })
        return fromDetail.length ? fromDetail : asList(selected.people)
    }
    readonly property string meetingClient: asList(detail.clients).length ? (asList(detail.clients)[0].name || "") : (selected.client || "")
    readonly property string mediaState: detail.media && detail.media.state ? detail.media.state : selected.media || ""
    readonly property string recordingStatus: String(detail.status || selected.status || "")
    anchors.fill: parent
    spacing: 0
    visible: currentView === "meeting"

    // A cited moment shown in the transcript: switch to Transcrição, scroll to the segment and flash it.
    // Before the transcript arrives, the request waits for it.
    function focusSegment(segmentId, seconds) {
        tabs.currentIndex = 0
        pendingFocus = {id: segmentId || "", start: Number(seconds) || 0}
        Qt.callLater(applyFocus)
    }
    function applyFocus() {
        const wanted = pendingFocus, segments = detail.transcript.segments || []
        if (!wanted || !segments.length) return
        let index = wanted.id ? segments.findIndex(function(segment){ return segment.id === wanted.id }) : -1
        if (index < 0) index = segments.findIndex(function(segment){ return segment.start <= wanted.start && wanted.start < segment.end })
        if (index < 0) { index = 0; for (let i = 0; i < segments.length; i++) if (segments[i].start <= wanted.start) index = i }
        pendingFocus = null
        revisionSegmentsList.positionViewAtIndex(index, ListView.Center)
        flashIndex = index
        flashTimer.restart()
    }
    Timer { id: flashTimer; interval: 1500; onTriggered: detailView.flashIndex = -1 }
    Connections {
        target: window
        function onDetailChanged() { if (detailView.pendingFocus) Qt.callLater(detailView.applyFocus) }
        function onGenerationChanged() { detailView.flashIndex = -1; detailView.pendingFocus = null }
    }
    function meetingDate() {
        const start = detail.calendar && detail.calendar.startAt ? detail.calendar.startAt : selected.modifiedAt
        return longDate(typeof start === "string" ? Date.parse(start) : start)
    }

    // ── Header ──
    Rectangle {
        objectName: "meetingHeader"
        Layout.fillWidth: true
        implicitHeight: headerRow.implicitHeight + (compactLayout ? 18 : 26)
        color: canvas
        RowLayout {
            id: headerRow
            anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
            anchors.leftMargin: compactLayout ? 12 : 20; anchors.rightMargin: compactLayout ? 12 : 20
            spacing: 10
            FtButton { objectName: "backButton"; iconOnly: true; variant: "ghost"; iconName: "back"; text: t("Voltar à biblioteca (Esc)"); Accessible.name: t("Voltar à biblioteca"); Layout.alignment: Qt.AlignTop; enabled: !revisionPending() && !hasPending("export-save"); onClicked: backToLibrary() }
            ColumnLayout {
                Layout.fillWidth: true
                spacing: 5
                Label { text: recordingTitle(selected) || selected.fileName || ""; textFormat: Text.PlainText; color: ink; font.pixelSize: compactLayout ? 19 : 22; font.weight: Font.DemiBold; wrapMode: Text.Wrap; maximumLineCount: 2; elide: Text.ElideRight; Layout.fillWidth: true }
                Flow {
                    objectName: "meetingMeta"
                    Layout.fillWidth: true
                    spacing: 8
                    Label { visible: text !== ""; text: detailView.meetingDate() + (selected.durationSeconds ? " · " + durationText(selected.durationSeconds) : ""); textFormat: Text.PlainText; color: muted; font.pixelSize: 13; height: 24; verticalAlignment: Text.AlignVCenter }
                    Row {
                        objectName: "peopleChips"
                        visible: detailView.meetingPeople.length > 0
                        spacing: -6
                        height: 24
                        Repeater { model: detailView.meetingPeople.slice(0, 3); FtAvatar { required property var modelData; name: modelData; size: 24 } }
                        Label { visible: detailView.meetingPeople.length > 3; text: " +" + (detailView.meetingPeople.length - 3); color: muted; font.pixelSize: 12; height: 24; verticalAlignment: Text.AlignVCenter; leftPadding: 10 }
                        HoverHandler { id: peopleHover }
                        ToolTip.visible: peopleHover.hovered
                        ToolTip.text: detailView.meetingPeople.join(", ")
                        Accessible.role: Accessible.StaticText
                        Accessible.name: detailView.meetingPeople.join(", ")
                    }
                    FtChip {
                        id: clientChip
                        objectName: "clientChip"
                        visible: detailView.meetingClient !== "" || (feature("clients") && !!detail.jobId)
                        iconName: "building"
                        text: detailView.meetingClient || t("Sem cliente")
                        opacity: detailView.meetingClient ? 1 : 0.8
                        maximumWidth: 220
                        Accessible.role: feature("clients") ? Accessible.Button : Accessible.StaticText
                        Accessible.name: (detailView.meetingClient ? tf("Cliente: %1", detailView.meetingClient) : t("Sem cliente")) + (feature("clients") ? t(", definir cliente") : "")
                        MouseArea { anchors.fill: parent; enabled: feature("clients") && !!detail.jobId && backend.available; cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor; onClicked: clientDialog.openAssign() }
                    }
                    FtChip { visible: detailView.mediaState === "audio-only" || detailView.mediaState === "removed" || selected.location === "missing"; kind: selected.location === "missing" ? "warning" : "neutral"; iconName: selected.location === "missing" ? "alert" : detailView.mediaState === "audio-only" ? "wave" : "transcript"; text: selected.location === "missing" ? t("Arquivo não encontrado") : detailView.mediaState === "audio-only" ? t("Só áudio") : t("Só transcrição") }
                    FtChip { visible: detailView.recordingStatus !== "" && ["completed", "archived"].indexOf(detailView.recordingStatus) < 0; kind: statusKind(detailView.recordingStatus); text: statusText(detailView.recordingStatus) || "" }
                    Repeater {
                        model: ["completed", "archived"].indexOf(detailView.recordingStatus) < 0 ? artifactChips(selected.artifactStatus) : []
                        FtChip { required property var modelData; kind: modelData.ready ? "accent" : "neutral"; iconName: modelData.ready ? "check" : ""; text: modelData.text }
                    }
                }
            }
            FtButton { id:processButton; objectName:"processButton"; compact:true; variant: "primary"; iconName:"spark"; iconOnly:compactLayout; text:t("Gerar notas…"); Layout.alignment:Qt.AlignTop; visible:!!selected.key && ["completed","processing","transferring"].indexOf(detail.status || selected.status) < 0; enabled:backend.available && !detailLoading && detailView.mediaAllows("reprocess"); Accessible.name:t("Ver para onde vão o áudio e o texto e gerar as notas desta reunião"); onClicked:processDialog.open() }
            FtButton { id: shareButton; objectName: "shareButton"; compact: true; variant: "outline"; iconName: "share"; iconOnly: compactLayout; text: t("Enviar"); Layout.alignment: Qt.AlignTop; visible: feature("share") && !!detail.jobId; enabled: backend.available; Accessible.name: t("Enviar estas notas (Ctrl+Shift+E)"); onClicked: shareDialog.openMeeting() }
            FtButton { id: askToggle; objectName: "askToggle"; compact: true; variant: askPanel.shown ? "secondary" : "ghost"; iconName: "chat"; iconOnly: compactLayout; text: t("Perguntar"); Layout.alignment: Qt.AlignTop; visible: feature("assistant") && !!(detail.jobId || selected.jobId); Accessible.name: t("Perguntar sobre esta reunião (Ctrl+J)"); onClicked: askPanel.toggle() }
            FtButton {
                id: meetingMore
                objectName: "meetingMore"
                Layout.alignment: Qt.AlignTop
                iconOnly: true; compact: true; variant: "ghost"; iconName: "more"
                text: t("Mais ações desta reunião")
                Accessible.name: text
                onClicked: meetingMenu.popup(meetingMore, meetingMore.width - meetingMenu.implicitWidth, meetingMore.height + 4)
                FtMenu {
                    id: meetingMenu
                    Action { text: t("Gerar notas de novo…"); enabled: backend.available && !!detail.review && !revisionPending() && !detailLoading && !summaryBusy(); onTriggered: openSummary() }
                    Action { text: t("Exportar transcrição ou legendas…"); enabled: backend.available && !!detail.review && !revisionPending(); onTriggered: exportDialog.open() }
                    Action { text: !detailView.mediaAllows("diarize") ? t("Identificar falantes · precisa do áudio original") : diarizationQueued ? t("Identificação em preparação…") : t("Identificar falantes"); enabled: backend.available && !!detail.diarizationId && !diarizationQueued && detail.diarization.state !== "review" && detailView.mediaAllows("diarize"); onTriggered: { diarizationQueued = true; if (send("diarization", detail.diarizationId) < 0) diarizationQueued = false } }
                    Action { text: !detailView.mediaAllows("subtitles") ? t("Legendas · precisam do áudio original") : subtitleQueued ? t("Legendas em preparação…") : t("Gerar legendas no worker configurado"); enabled: backend.available && !!detail.subtitleId && !subtitleQueued && detail.subtitleState !== "ready" && detailView.mediaAllows("subtitles"); onTriggered: { subtitleQueued = true; if (send("subtitles", detail.subtitleId) < 0) subtitleQueued = false } }
                    Action { text: !detailView.mediaAllows("frames") ? t("Análise visual · precisa do vídeo original") : mockFramesEnabled ? t("Frames · mock local…") : t("Análise visual…"); enabled: backend.available && (mockFramesEnabled || realFramesEnabled) && !!selected.key && detailView.mediaAllows("frames"); onTriggered: { cancelFramePreview(); framesDialog.open() } }
                    Action { text: t("Definir cliente…"); enabled: feature("clients") && backend.available && !!detail.jobId; onTriggered: clientDialog.openAssign() }
                    MenuSeparator {}
                    Action { text: t("Acesso para agentes (MCP)…"); enabled: backend.available && !!selected.recordingId; onTriggered: openAgentAccess() }
                    Action { text: t("Contexto para agentes"); onTriggered: tabs.currentIndex = 3 }
                    MenuSeparator {}
                    Action { text: t("Remover mídia agora…"); enabled: backend.available && detailView.mediaRemovable; onTriggered: mediaRemoveDialog.open() }
                }
            }
        }
    }

    // ── Tabs (and, on Notas, the switch between the full notes and only yours) ──
    RowLayout {
        Layout.fillWidth: true
        Layout.leftMargin: compactLayout ? 12 : 20; Layout.rightMargin: compactLayout ? 12 : 20
        Layout.bottomMargin: 10
        spacing: 10
        FtSegmented {
            id: tabs
            objectName: "meetingTabs"
            accessibleName: t("Partes da reunião")
            showIcons: !compactLayout
            useShortLabels: compactLayout
            currentIndex: 1
            model: [{value: 1, label: t("Notas"), icon: "note"}, {value: 0, label: t("Transcrição"), shortLabel: t("Transcr."), icon: "transcript"}, {value: 2, label: t("Falantes"), icon: "users"}, {value: 3, label: t("Agentes"), icon: "context"}]
        }
        Item { Layout.fillWidth: true }
        FtSegmented {
            id: notesMode
            objectName: "notesMode"
            visible: tabs.currentIndex === 1 && feature("notes")
            compact: true
            showIcons: false
            accessibleName: t("Quais notas mostrar")
            currentIndex: 0
            model: [{value: 0, label: t("Completas")}, {value: 1, label: t("Minhas notas")}]
        }
    }

    // ── Generating the notes again: confirm, progress and a failure, inline (never a modal for local work) ──
    Rectangle {
        id: regenerateBar
        objectName: "regenerateBar"
        Layout.fillWidth: true
        Layout.leftMargin: compactLayout ? 12 : 20; Layout.rightMargin: compactLayout ? 12 : 20
        Layout.bottomMargin: visible ? 10 : 0
        visible: summaryStage !== ""
        implicitHeight: visible ? regenerateRow.implicitHeight + 16 : 0
        radius: 10
        color: summaryStage === "failed" ? errorSoft : accentSoft
        readonly property string message: {
            const name = regenerateTemplateName(), language = regenerateLanguageName(regenerateRequest.language || "")
            if (summaryStage === "confirm") return (name ? tf("Gerar de novo com “%1”?", name) : t("Gerar as notas de novo?")) + (language ? " " + tf("Em %1.", language) : "") + " " + t("As notas da IA serão reescritas; as suas ficam.")
            if (summaryStage === "planning") return t("Preparando…")
            if (summaryStage === "consent") return t("Confirme o envio para gerar as notas.")
            if (summaryStage === "running") return name ? tf("Gerando com “%1”…", name) : t("Gerando as notas…")
            if (summaryStage === "failed") return t("Não deu para gerar as notas.") + (summaryError ? " " + t(summaryError) : "")
            return ""
        }
        RowLayout {
            id: regenerateRow
            anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
            anchors.leftMargin: 12; anchors.rightMargin: 8
            spacing: 8
            BusyIndicator { visible: summaryStage === "planning" || summaryStage === "running"; running: visible; implicitWidth: 22; implicitHeight: 22 }
            FtIcon { visible: summaryStage === "confirm" || summaryStage === "consent" || summaryStage === "failed"; name: summaryStage === "failed" ? "alert" : "spark"; tint: summaryStage === "failed" ? errorColor : accent; size: 16 }
            Label { objectName: "regenerateMessage"; Layout.fillWidth: true; text: regenerateBar.message; textFormat: Text.PlainText; color: ink; font.pixelSize: 13; wrapMode: Text.WordWrap }
            FtButton { objectName: "regenerateConfirm"; visible: summaryStage === "confirm"; compact: true; variant: "primary"; iconName: "spark"; text: t("Gerar"); enabled: canRegenerate(); onClicked: prepareSummary() }
            FtButton { objectName: "regenerateRetry"; visible: summaryStage === "failed"; compact: true; variant: "outline"; iconName: "refresh"; text: t("Tentar de novo"); enabled: canRegenerate(); onClicked: prepareSummary() }
            FtButton { objectName: "regenerateCancel"; visible: summaryStage !== "consent"; compact: true; variant: "ghost"; text: summaryStage === "failed" ? t("Fechar") : t("Cancelar"); onClicked: summaryStage === "running" ? stopRegenerate() : cancelRegenerate() }
        }
    }
    TemplatePicker { id: templatePicker }

    // ── Video and pages. Expanded, the video sits above the document; in cinema mode it takes most of the
    // page, with the notes in a column beside it (a wide window) or below it (compact). ──
    GridLayout {
        id: stage
        objectName: "meetingStage"
        readonly property bool cinema: playerStrip.cinema && playerStrip.videoExpanded && playerStrip.hasVideo
        readonly property bool side: cinema && window.width >= 1100
        Layout.fillWidth: true
        Layout.fillHeight: true
        columns: side ? 2 : 1
        rowSpacing: 0; columnSpacing: 0

        // The same frame as the thumbnail in the strip.
        Item {
            id: videoPane
            objectName: "videoPane"
            Layout.fillWidth: true
            Layout.fillHeight: stage.side
            Layout.leftMargin: compactLayout ? 12 : 20; Layout.rightMargin: stage.side ? 12 : compactLayout ? 12 : 20
            Layout.bottomMargin: playerStrip.videoExpanded ? 10 : 0
            Layout.preferredHeight: !playerStrip.videoExpanded ? 0 : stage.side ? -1 : stage.cinema ? Math.round(stage.height * 0.62) : Math.min(width * 9 / 16, detailView.height * (compactLayout ? 0.36 : 0.45))
            visible: playerStrip.videoExpanded
        }

        Rectangle {
            id: pageArea
            objectName: "meetingPages"
            Layout.fillWidth: !stage.side
            Layout.preferredWidth: stage.side ? Math.round(Math.max(360, Math.min(460, stage.width * 0.34))) : -1
            Layout.fillHeight: true
            color: pageSurface
            Rectangle { anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; height: 1; color: divider }

            // Notas (1): the notes document, or your notepad.
            Item {
                anchors.fill: parent
                anchors.topMargin: 1
                visible: tabs.currentIndex === 1
                NotesDocument {
                    id: notesDocument
                    anchors.fill: parent
                    visible: notesMode.currentIndex === 0 || !feature("notes")
                }
                ColumnLayout {
                    visible: notesMode.currentIndex === 1 && feature("notes")
                    width: Math.min(docMaxWidth + 60, parent.width - (compactLayout ? 24 : 48))
                    x: (parent.width - width) / 2
                    anchors.top: parent.top; anchors.bottom: parent.bottom
                    anchors.topMargin: compactLayout ? 10 : 16; anchors.bottomMargin: 8
                    spacing: 8
                    Rectangle {
                        Layout.fillWidth: true
                        visible: !!detail.notesDoc && detail.notesDoc.stale === "notes"
                        implicitHeight: mineStaleRow.implicitHeight + 14
                        radius: 10; color: accentSoft
                        RowLayout {
                            id: mineStaleRow
                            anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; anchors.margins: 10
                            spacing: 8
                            Label { Layout.fillWidth: true; text: t("As notas completas usam estas linhas como base."); textFormat: Text.PlainText; color: ink; font.pixelSize: 13; wrapMode: Text.WordWrap }
                            FtButton { compact: true; variant: "outline"; text: t("Atualizar notas"); enabled: backend.available && !!detail.review && !summaryBusy(); onClicked: openSummary() }
                        }
                    }
                    NotesEditor {
                        id: meetingNotesEditor
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        origin: "meetingNotes"
                        placeholder: t("Escreva o que quiser lembrar desta reunião. Suas linhas entram nas próximas notas geradas.")
                        notesKey: notesMode.currentIndex === 1 && feature("notes") && tabs.currentIndex === 1 ? (detail.notes && detail.notes.id ? detail.notes.id : detail.jobId || "") : ""
                    }
                    Label {
                        visible: !detail.jobId && !(detail.notes && detail.notes.id)
                        Layout.fillWidth: true
                        text: t("Gere as notas desta reunião para poder anotar nela.")
                        textFormat: Text.PlainText; color: muted; font.pixelSize: 13; wrapMode: Text.WordWrap
                    }
                }
            }

            // Transcrição (0), Falantes (2) and Agentes (3).
            ColumnLayout {
                id: workColumn
                visible: tabs.currentIndex !== 1
                width: Math.min(900, parent.width - (compactLayout ? 24 : 48))
                x: (parent.width - width) / 2
                anchors.top: parent.top; anchors.bottom: parent.bottom
                anchors.topMargin: compactLayout ? 10 : 16; anchors.bottomMargin: 10
                spacing: 10

                ColumnLayout {
                    visible: tabs.currentIndex === 3
                    Layout.fillWidth: true
                    spacing: 6
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 8
                        Label { text: t("Contexto para agentes"); textFormat: Text.PlainText; color: ink; font.pixelSize: 16; font.weight: Font.DemiBold; Layout.fillWidth: true }
                        FtButton { id:agentAccessButton; objectName:"agentAccessButton"; compact:true; variant:"outline"; iconName:"key"; iconOnly:compactLayout; text:t("Acesso para agentes…"); enabled:backend.available && !!selected.recordingId; onClicked:openAgentAccess() }
                        FtButton { compact: true; variant: "ghost"; text: t("Voltar às notas"); onClicked: tabs.currentIndex = 1 }
                    }
                    Flow {
                        Layout.fillWidth: true
                        spacing: 6
                        FtChip { iconName: mediaReady && location ? "play" : ""; kind: selected.location === "missing" ? "warning" : "neutral"; text: mediaReady && location ? t("Reproduzindo · ") + origin(location) : origin(selected.location) }
                        FtChip { visible: !!selected.backup && selected.backup !== "none"; text: t("Cópias: ") + String(selected.backup || "").replace("+", " + ").toUpperCase() }
                    }
                }
                ColumnLayout {
                    visible: !!detail.review && (tabs.currentIndex === 0 || tabs.currentIndex === 2)
                    Layout.fillWidth: true
                    spacing: 6
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 6
                        Rectangle {
                            implicitHeight: 26
                            implicitWidth: revisionStateLabel.implicitWidth + 20
                            Layout.maximumWidth: workColumn.width - 150
                            radius: 13
                            color: detail.review && detail.review.derivedStale ? warningSoft : accentSoft
                            Label {
                                id: revisionStateLabel; objectName: "revisionState"
                                anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; anchors.leftMargin: 10; anchors.rightMargin: 10
                                text: !detail.review ? "" : (detail.review.revision.revision > 0 ? tf("Editado (%1)", detail.review.revision.revision) : t("Original")) + (detail.review.derivedStale ? t(" · as notas são de antes da correção") : "")
                                color: detail.review && detail.review.derivedStale ? warningColor : accent
                                font.pixelSize: 12; font.weight: Font.Medium; elide: Text.ElideRight
                            }
                        }
                        Item { Layout.fillWidth: true }
                        FtButton { id:reviewNoteButton; objectName:"reviewNoteButton"; compact:true; variant:"ghost"; iconName:"note"; iconOnly:workColumn.width < 430; text:t("Nota"); Accessible.name:t("Adicionar nota humana sem tempo"); enabled:backend.available&&!revisionPending(); onClicked:openReview("note",({})) }
                        FtButton { objectName:"revisionUndo"; compact:true; variant:"ghost"; iconName:"undo"; iconOnly:workColumn.width < 430; text:t("Desfazer"); Accessible.name:t("Desfazer última revisão humana"); enabled:backend.available&&!!detail.review&&detail.review.canUndo===true&&!revisionPending(); onClicked:undoRevision() }
                        FtButton { id:exportButton; objectName:"exportButton"; compact:true; variant:"ghost"; iconName:"export"; iconOnly:workColumn.width < 430; text:t("Exportar"); enabled:backend.available&&!revisionPending(); onClicked:exportDialog.open() }
                    }
                    Label { visible:!!detail.review&&(detail.review.notes||[]).length>0; text:detail.review&&(detail.review.notes||[]).length>0 ? t("Notas humanas sem tempo: ")+detail.review.notes.length+t(". Última prévia: ")+detail.review.notes[detail.review.notes.length-1].slice(0,180)+(detail.review.notes[detail.review.notes.length-1].length>180?"…":"")+t(" · conteúdo completo no JSON/Markdown exportado.") : ""; textFormat:Text.PlainText; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true; font.pixelSize:12; maximumLineCount: 3; elide: Text.ElideRight }
                    Label { visible:tabs.currentIndex===0&&!!detail.review&&detail.review.segmentEditUnavailable===true; text:t("Trechos sem correspondência literal no texto original aceitam somente uma nota sem tempo."); color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true; font.pixelSize:12 }
                }
                Label { visible: tabs.currentIndex === 0 && detail.transcript.timing === "block"; text: t("Tempos aproximados por bloco; a revisão não cria alinhamento por palavra."); textFormat: Text.PlainText; color: warningColor; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 12 }

                ListView {
                    id:revisionSegmentsList; objectName:"revisionSegmentsList"
                    visible: tabs.currentIndex === 0 && (detail.transcript.segments || []).length > 0
                    Layout.fillWidth: true; Layout.fillHeight: true; model: detail.transcript.segments || []; clip: true; spacing: 2
                    ScrollBar.vertical: ScrollBar {}
                    delegate: ItemDelegate {
                        id: segmentItem
                        required property var modelData; required property int index
                        readonly property bool activeLine: activeSegment === index
                        width: ListView.view.width
                        hoverEnabled: true
                        leftPadding: 12; rightPadding: 8; topPadding: 8; bottomPadding: 10
                        Accessible.name: (modelData.speaker ? modelData.speaker + ", " : "") + clock(modelData.start) + ". " + modelData.text
                        background: Rectangle {
                            radius: 8
                            color: segmentItem.index === detailView.flashIndex ? flashSurface : segmentItem.activeLine ? selectedSurface : segmentItem.hovered ? hoverSurface : "transparent"
                            border.width: segmentItem.visualFocus ? 2 : 0; border.color: accent
                            Rectangle { visible: segmentItem.activeLine; width: 3; radius: 1.5; color: accent; anchors.left: parent.left; anchors.top: parent.top; anchors.bottom: parent.bottom; anchors.topMargin: 8; anchors.bottomMargin: 8 }
                        }
                        contentItem: ColumnLayout {
                            id: segmentContent
                            spacing: 3
                            RowLayout {
                                Layout.fillWidth: true
                                spacing: 8
                                Label { text: clock(segmentItem.modelData.start); color: accent; font.pixelSize: 12; font.family: "monospace"; font.weight: Font.DemiBold }
                                Label { visible: !!segmentItem.modelData.speaker; text: segmentItem.modelData.speaker || ""; textFormat: Text.PlainText; color: ink; font.pixelSize: 12; font.weight: Font.DemiBold; elide: Text.ElideRight; Layout.fillWidth: true }
                                Item { visible: !segmentItem.modelData.speaker; Layout.fillWidth: true }
                                FtChip { visible: segmentItem.modelData.humanEdited === true; text: t("Revisado"); kind: "accent"; implicitHeight: 20 }
                                FtButton { objectName:"segmentReview-"+(segmentItem.modelData.id||segmentItem.index); text:t("Revisar"); Accessible.name: t("Revisar trecho ") + clock(segmentItem.modelData.start); iconName: "edit"; iconOnly: true; compact: true; variant: "ghost"; implicitHeight: 28; visible:!!segmentItem.modelData.id; enabled:backend.available&&!revisionPending()&&!!segmentItem.modelData.textRange; onClicked:openReview("segment-text",segmentItem.modelData) }
                            }
                            Label { text: segmentItem.modelData.text; textFormat: Text.PlainText; color: ink; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 14; lineHeight: 1.12 }
                        }
                        onClicked: seek(modelData.start)
                    }
                }

                ColumnLayout {
                    visible: tabs.currentIndex === 2
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    spacing: 8
                    Label { textFormat: Text.PlainText; text: t(detail.diarization.message || "") || t("Identifique os falantes para revisar suas participações nesta gravação."); color: detail.diarization.state === "failed" ? errorColor : muted; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                    Label { visible: (detail.diarization.turns || []).length > 0; text: t("Os horários das falas vêm da identificação automática."); color: muted; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                    FtOverline { text: t("Nomes dos falantes"); visible: speakerRows.length > 0 }
                    RowLayout {
                        Layout.fillWidth: true; spacing: 8; visible: speakerRows.length > 0
                        Item { Layout.fillWidth: true }
                        FtButton { id: speakerApplyButton; objectName: "speakerApplySuggestions"; visible: applicableSuggestions().length > 0; text: t("Aplicar sugestões"); compact: true; variant: "secondary"; iconName: "check"; implicitHeight: 30
                            Accessible.name: t("Aplicar as sugestões aos falantes ainda sem nome, como revisão humana")
                            enabled: backend.available && !revisionPending() && !!detail.review; onClicked: applySpeakerSuggestions() }
                        FtButton { id: speakerSuggestButton; objectName: "speakerSuggestButton"; text: speakersQueued ? t("Procurando nomes…") : t("Sugerir nomes…"); compact: true; variant: "outline"; iconName: "spark"; implicitHeight: 30
                            Accessible.name: t("Sugerir nomes dos falantes pelo microfone e, se você autorizar, pela conversa")
                            enabled: backend.available && !speakersQueued && !revisionPending() && !!detail.review && speakerSuggestions.state !== "unavailable"; onClicked: speakerSuggestDialog.open() }
                    }
                    Label { objectName: "speakerSuggestionStatus"; visible: speakerRows.length > 0 && !!speakerSuggestionStatus(); text: speakerSuggestionStatus(); textFormat: Text.PlainText; color: speakerSuggestions.state === "failed" ? errorColor : muted; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                    ListView {
                        id:revisionSpeakersList; objectName:"revisionSpeakersList"
                        visible: speakerRows.length > 0
                        Layout.fillWidth: true; Layout.preferredHeight: Math.min(236, speakerRows.reduce(function(total, row){return total + 44 + suggestionsFor(row.speakerId).length * 30}, 0)); model: speakerRows; clip: true; spacing: 2
                        ScrollBar.vertical: ScrollBar {}
                        delegate: ItemDelegate {
                            id: speakerItem
                            required property var modelData
                            property var suggestions: suggestionsFor(modelData.speakerId)
                            width: ListView.view.width; height: 42 + suggestions.length * 30
                            enabled: backend.available && !!selected.key
                            leftPadding: 8; rightPadding: 4
                            Accessible.name: (modelData.label || t("Falante incerto")) + (suggestions.length ? t(", com sugestão de nome") : "")
                            background: Rectangle { radius: 8; color: speakerItem.hovered ? hoverSurface : "transparent"; border.width: speakerItem.visualFocus ? 2 : 0; border.color: accent }
                            contentItem: ColumnLayout {
                                spacing: 0
                                RowLayout {
                                    spacing: 8; Layout.fillWidth: true; Layout.preferredHeight: 34
                                    FtChip { text: speakerItem.modelData.speakerId; kind: "accent"; maximumWidth: 90 }
                                    Label { text:speakerItem.modelData.label||t("Falante incerto"); textFormat:Text.PlainText; color:speakerItem.modelData.label ? ink : muted; Layout.fillWidth:true; elide:Text.ElideRight }
                                    FtButton { objectName:"speakerReview-"+speakerItem.modelData.speakerId; text:t("Revisar"); compact:true; variant:"ghost"; iconName:"edit"; implicitHeight: 30; Accessible.name:t("Revisar nome do falante ")+speakerItem.modelData.speakerId; enabled:backend.available&&!revisionPending()&&!!detail.review; onClicked:openReview("speaker-label",speakerItem.modelData) }
                                }
                                Repeater {
                                    model: speakerItem.suggestions
                                    delegate: RowLayout {
                                        id: suggestionRow
                                        required property var modelData
                                        Layout.fillWidth: true; Layout.preferredHeight: 30; spacing: 8
                                        Label { id: suggestionLabel; objectName: "speakerSuggestion-" + speakerItem.modelData.speakerId + "-" + suggestionRow.modelData.source; text: t("Sugestão: ") + suggestionName(suggestionRow.modelData) + " · " + suggestionDetail(suggestionRow.modelData); textFormat: Text.PlainText; color: muted; font.pixelSize: 12; Layout.fillWidth: true; elide: Text.ElideRight; leftPadding: 4
                                            HoverHandler { id: suggestionHover }
                                            ToolTip.visible: suggestionHover.hovered && suggestionLabel.truncated; ToolTip.text: suggestionLabel.text; ToolTip.delay: 400 }
                                        FtButton { objectName: "speakerUseSuggestion-" + speakerItem.modelData.speakerId + "-" + suggestionRow.modelData.source; text: t("Usar"); compact: true; variant: "ghost"; iconName: "edit"; implicitHeight: 26
                                            Accessible.name: tf("Revisar o nome sugerido %1 para o falante %2", suggestionName(suggestionRow.modelData), speakerItem.modelData.speakerId)
                                            enabled: backend.available && !revisionPending() && !!detail.review
                                            onClicked: openReview("speaker-label", {speakerId: speakerItem.modelData.speakerId, label: suggestionName(suggestionRow.modelData)}) }
                                    }
                                }
                            }
                        }
                    }
                    FtOverline { text: t("Falas identificadas automaticamente"); Layout.fillWidth: true; wrapMode: Text.WordWrap }
                    Label { visible: !!detail.diarization.textCoverage && detail.diarization.textCoverage.shownTurns < detail.diarization.textCoverage.totalTurns; text: detail.diarization.textCoverage ? t("Texto parcial na interface: ") + detail.diarization.textCoverage.shownTurns + "/" + detail.diarization.textCoverage.totalTurns + t(" falas. Os horários e nomes continuam disponíveis; o resultado local completo foi preservado.") : ""; textFormat: Text.PlainText; color: warningColor; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 12 }
                    ListView {
                        id:revisionTurnsList; objectName:"revisionTurnsList"
                        Layout.fillWidth: true; Layout.fillHeight: true; model: detail.diarization.turns || []; clip: true; spacing: 2
                        ScrollBar.vertical: ScrollBar {}
                        delegate: ItemDelegate {
                            id: turnItem
                            required property var modelData
                            width: ListView.view.width; enabled: true
                            hoverEnabled: true
                            leftPadding: 10; rightPadding: 8; topPadding: 8; bottomPadding: 10
                            Accessible.name: (modelData.label || modelData.speaker || t("Falante incerto")) + ", " + preciseClock(modelData.start) + " a " + preciseClock(modelData.end) + ". " + (modelData.text !== undefined ? modelData.text : t("Texto não disponível nesta prévia."))
                            background: Rectangle { radius: 8; color: turnItem.hovered ? hoverSurface : "transparent"; border.width: turnItem.visualFocus ? 2 : 0; border.color: accent }
                            contentItem: ColumnLayout {
                                id: turnContent; spacing: 4
                                RowLayout {
                                    spacing: 8
                                    Label { text: preciseClock(turnItem.modelData.start) + "–" + preciseClock(turnItem.modelData.end); color: accent; font.family: "monospace"; font.pixelSize: 11 }
                                    Label { text: turnItem.modelData.label || turnItem.modelData.speaker || t("Falante incerto"); textFormat: Text.PlainText; color: ink; font.pixelSize: 12; font.weight: Font.DemiBold; Layout.fillWidth: true; elide: Text.ElideRight }
                                }
                                Label { text: turnItem.modelData.text !== undefined ? turnItem.modelData.text : t("Texto não disponível nesta prévia."); textFormat: Text.PlainText; color: turnItem.modelData.text !== undefined ? ink : muted; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 13 }
                                FtButton { objectName:"turnReview-"+(turnItem.modelData.id||""); text:t("Revisar atribuição"); compact:true; variant:"outline"; iconName:"edit"; implicitHeight: 30; visible:!!turnItem.modelData.id; enabled:backend.available&&!revisionPending()&&!!detail.review; onClicked:openReview("turn-speaker",turnItem.modelData) }
                            }
                            onClicked: seek(Number(modelData.start))
                        }
                    }
                }

                ColumnLayout {
                    visible: tabs.currentIndex === 3
                    Layout.fillWidth: true
                    Layout.fillHeight: !!contextData
                    spacing: 8
                    Flow {
                        Layout.fillWidth: true
                        spacing: 6
                        FtButton { compact: true; variant: contextText ? "secondary" : "primary"; iconName: "context"; text: contextLoading ? t("Preparando contexto…") : t("Pedir contexto"); enabled: backend.available && !!diarizationKey() && !contextLoading; onClicked: requestMeetingContext() }
                        FtButton { compact: true; variant: "outline"; iconName: "copy"; text: t("Copiar contexto"); enabled: !!contextText && !!contextCopyText; onClicked: { compactContext.selectAll(); compactContext.copy(); compactContext.deselect(); notice = t("Contexto copiado como JSON para a área de transferência.") } }
                    }
                    Label { text: t("Trechos com horário que agentes de IA recebem desta reunião."); color: muted; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                    Label { textFormat: Text.PlainText; visible: !!contextPath; text: t("Fonte: ") + contextPath; color: muted; font.pixelSize: 11; elide: Text.ElideMiddle; Layout.fillWidth: true }
                    Label { textFormat: Text.PlainText; visible: contextCitations.length > 0; text: t("Citações: ") + contextCitations.join(" · "); color: muted; font.pixelSize: 11; elide: Text.ElideRight; Layout.fillWidth: true }
                    ListView {
                        id: contextExcerpts
                        objectName: "contextExcerpts"
                        visible: !!contextData
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        clip: true
                        spacing: 8
                        model: contextData ? contextData.excerpts : []
                        ScrollBar.vertical: ScrollBar {}
                        header: Item {
                            width: contextExcerpts.width
                            height: contextHeader.implicitHeight + 10
                            Flow {
                                id: contextHeader
                                width: parent.width
                                spacing: 6
                                FtChip { visible: !!(contextData && contextData.title); text: contextData && contextData.title ? contextData.title : ""; maximumWidth: contextExcerpts.width }
                                FtChip { visible: !!(contextData && contextData.budget); text: contextData && contextData.budget ? contextData.budget.characters + t(" de ") + contextData.budget.maxCharacters + t(" caracteres") + (contextData.budget.truncated ? t(" · truncado") : "") : "" }
                            }
                        }
                        delegate: Rectangle {
                            id: excerptCard
                            required property var modelData
                            width: contextExcerpts.width - 8
                            height: excerptColumn.implicitHeight + 20
                            radius: 10; color: surfaceAlt; border.width: 1; border.color: divider
                            ColumnLayout {
                                id: excerptColumn
                                anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 10
                                spacing: 6
                                Flow {
                                    Layout.fillWidth: true
                                    spacing: 6
                                    FtButton { visible: !!excerptCard.modelData.timestamps; compact: true; variant: "outline"; implicitHeight: 26; iconName: "play"; text: excerptCard.modelData.timestamps ? clock(excerptCard.modelData.timestamps.start) + "–" + clock(excerptCard.modelData.timestamps.end) : ""; Accessible.name: t("Ir à origem ") + text; enabled: mediaReady; onClicked: seek(excerptCard.modelData.timestamps.start) }
                                    FtChip { kind: excerptCard.modelData.timing === "segment" ? "accent" : "warning"; text: excerptCard.modelData.timing === "segment" ? t("horário do segmento") : excerptCard.modelData.timing === "block" ? t("bloco aproximado") : t("sem horário") }
                                    FtChip { visible: excerptCard.modelData.textOrigin === "human-revision"; text: t("revisão humana") }
                                }
                                Label { text: excerptCard.modelData.text || ""; textFormat: Text.PlainText; color: ink; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 13 }
                                Label { visible: (excerptCard.modelData.segmentIds || []).length > 0; text: (excerptCard.modelData.segmentIds || []).join(", "); color: muted; font.pixelSize: 11; font.family: "monospace"; elide: Text.ElideRight; Layout.fillWidth: true }
                            }
                        }
                    }
                }
                TextEdit { id: compactContext; visible: false; text: contextCopyText; textFormat: TextEdit.PlainText }

                ScrollView {
                    visible: (tabs.currentIndex === 0 && !(detail.transcript.segments || []).length) || (tabs.currentIndex === 3 && !contextData)
                    Layout.fillWidth: true; Layout.fillHeight: true; clip: true
                    TextArea { id: contextArea; readOnly: true; selectByMouse: true; wrapMode: TextEdit.Wrap; textFormat: TextEdit.PlainText; color: ink; font.pixelSize: 14; text: tabs.currentIndex === 0 ? detail.transcript.text || (detailLoading ? t("Carregando…") : t("Transcrição ainda não disponível.")) : tabs.currentIndex === 1 ? (showVisualSummary && detail.visualReview ? detail.visualReview.summaryMarkdown : detail.summary) || t("Resumo ainda não disponível.") : tabs.currentIndex === 3 ? (contextText || (contextLoading ? t("Preparando contexto sob demanda…") : t("Peça o contexto para esta gravação quando precisar."))) : detail.timesheet || t("Nenhum apontamento vinculado a esta gravação.")
                        background: Item {} }
                }
                // Like the menu above: what needs the media is off once retention removed it, and says why.
                FtButton { objectName: "transcriptSubtitles"; visible: tabs.currentIndex === 0 && !!detail.subtitleId; Layout.fillWidth: true; variant: "outline"; iconName: "transcript"; text: !detailView.mediaAllows("subtitles") ? t("Legendas · precisam do áudio original") : subtitleQueued ? t("Legendas em preparação…") : t("Gerar legendas no worker configurado"); enabled: backend.available && !subtitleQueued && detail.subtitleState !== "ready" && detailView.mediaAllows("subtitles"); onClicked: { subtitleQueued = true; if (send("subtitles", detail.subtitleId) < 0) subtitleQueued = false } }
                FtButton { objectName: "transcriptDiarize"; visible: (tabs.currentIndex === 0 || tabs.currentIndex === 2) && !!detail.diarizationId && !(tabs.currentIndex === 2 && detail.diarization.state === "review"); Layout.fillWidth: true; variant: "outline"; iconName: "users"; text: diarizationQueued ? t("Identificação em preparação…") : detail.diarization.state === "review" ? t("Ver falantes") : !detailView.mediaAllows("diarize") ? t("Identificar falantes · precisa do áudio original") : t("Identificar falantes"); enabled: backend.available && !diarizationQueued && (detail.diarization.state === "review" || detailView.mediaAllows("diarize")); onClicked: { if (detail.diarization.state === "review") tabs.currentIndex = 2; else { diarizationQueued = true; if (send("diarization", detail.diarizationId) < 0) diarizationQueued = false } } }
            }
        }
    }

    PlayerStrip {
        id: playerStrip
        Layout.fillWidth: true
        expandedSlot: videoPane
        fullScreenSlot: videoFullScreen
    }
}
