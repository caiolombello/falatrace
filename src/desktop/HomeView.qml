import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Início (DESIGN-STUDIO §2.10): where the day starts. The first-run card until the first notes are
// celebrated, "A seguir" (the next meetings, each with what was left from the last one and a
// Pular/Gravar choice), the open actions, the notes being made and the Ask bar. No stat tiles and no
// recents: the meetings list is in the sidebar. home-read is sent only with the upcoming or actions
// feature; its failures stay here (a muted line), never in errorText or notice.
Flickable {
    id: homeView
    objectName: "homeView"
    anchors.fill: parent
    visible: currentView === "home"
    clip: true
    contentWidth: width
    contentHeight: homeColumn.implicitHeight + 2 * homeColumn.y
    boundsBehavior: Flickable.StopAtBounds
    ScrollBar.vertical: ScrollBar {}

    // home-read: its own generation, state and error.
    property var home: ({})
    property bool homeLoaded: false
    property bool homeLoading: false
    property string homeError: ""
    property int homeGeneration: 0
    readonly property bool homeWanted: feature("upcoming") || feature("actions")
    readonly property var upcoming: asList(home.upcoming)
    readonly property var openActions: asList(home.openActions)
    // The event row shown open, and an event asked for by a link before the list arrived.
    property string expanded: ""
    property string focusWanted: ""
    // Per event: a decision on its way, and a note from the last answer.
    property var overridePending: ({})
    property var eventNotes: ({})
    // Optimistic action state (actionId → {status, pending, sha}) and the newest revision per recording.
    property var actionState: ({})
    property var fileRevs: ({})
    // First run (ux-capabilities.firstRun): until the first notes are celebrated.
    property bool firstRunClosed: false
    readonly property bool firstRunShown: newBridge && !!firstRun.wizardOpenedAt && !firstRun.celebrationDismissedAt && !firstRunClosed
    readonly property bool firstRunWaiting: firstRunShown && !firstRun.firstSummaryAt
    readonly property string firstRunState: firstRun.firstSummaryAt ? "done" : captureStatus.active ? "recording" : firstRun.firstRecordingAt ? "generating" : "start"
    readonly property var processingJobs: jobs.filter(function(job){ return ["pending", "transferring", "queued", "processing"].indexOf(job.state) >= 0 }).slice(0, 6)

    function loadHome() {
        if (!homeWanted || !backend.available || homeLoading) return
        homeGeneration += 1; homeLoading = true
        if (send("home-read", "", ({}), {origin: "home", homeGeneration: homeGeneration}) < 0) { homeLoading = false; homeError = t("Sem conexão com o FalaTrace.") }
    }
    Timer {
        interval: homeView.home.refreshing === true ? 5000 : 60000
        repeat: true
        triggeredOnStart: true
        running: homeView.visible && homeView.homeWanted && backend.available
        onTriggered: homeView.loadHome()
    }
    function handleResponse(request, message) {
        if (request.op === "first-run-dismiss") {
            if (message.ok && message.result && message.result.firstRun) firstRun = message.result.firstRun
            return
        }
        if (request.op === "action-set") { actionAnswered(request, message); return }
        if (request.op === "meeting-override") { overrideAnswered(request, message); return }
        if (request.homeGeneration !== homeGeneration) return
        homeLoading = false
        if (!message.ok) { homeError = t("Não deu para atualizar o início agora."); return }
        home = message.result; homeLoaded = true; homeError = ""
        indexRefreshSeen(message.result.refreshing === true)
        if (focusWanted && upcoming.some(function(event){ return event.eventIdHash === focusWanted })) { expanded = focusWanted; focusWanted = "" }
    }
    function connectionLost() {
        homeLoading = false; overridePending = ({})
        const next = Object.assign({}, actionState)
        for (const id in next) if (next[id].pending) next[id] = Object.assign({}, next[id], {pending: false})
        actionState = next
    }
    // A link to an event (a reminder's "Ver resumo anterior"): that row open.
    function focusEvent(hash) {
        if (upcoming.some(function(event){ return event.eventIdHash === hash })) expanded = hash
        else { focusWanted = hash; loadHome() }
        contentY = 0
    }

    // ── Upcoming meetings ──
    function timeOf(value) { const date = new Date(value); return isNaN(date.getTime()) ? "" : Qt.formatDateTime(date, "HH:mm") }
    function eventDay(value) {
        const date = new Date(value)
        if (isNaN(date.getTime())) return ""
        const today = new Date(clockDay); today.setHours(0, 0, 0, 0)
        const day = new Date(date.getTime()); day.setHours(0, 0, 0, 0)
        const days = Math.round((day.getTime() - today.getTime()) / 86400000)
        return days === 0 ? "" : days === 1 ? t("Amanhã") : Qt.formatDate(date, t("dd/MM"))
    }
    function planText(plan) {
        return ({record: t("Será gravada"), notify: t("Só aviso"), skip: t("Pulada"), "record-override": t("Gravar quando começar")})[plan] || ""
    }
    function planKind(plan) { return plan === "record" || plan === "record-override" ? "accent" : plan === "skip" ? "warning" : "neutral" }
    // "Gravar agora" from ten minutes before the start until the end.
    function recordNowAllowed(event) {
        // statusNow ticks every second while recording, clockDay every minute: enough for a ten-minute window.
        const now = Math.max(statusNow, clockDay)
        return Date.parse(event.startAt) - 10 * 60000 <= now && now <= Date.parse(event.endAt)
    }
    function attendeesText(event) {
        const count = asList(event.attendees).length
        return count === 0 ? "" : count === 1 ? t("1 pessoa") : tf("%1 pessoas", count)
    }
    function decide(event, decision) {
        if (!backend.available || overridePending[event.eventIdHash]) return
        const next = Object.assign({}, overridePending); next[event.eventIdHash] = decision; overridePending = next
        const notes = Object.assign({}, eventNotes); delete notes[event.eventIdHash]; eventNotes = notes
        if (send("meeting-override", "", {eventIdHash: event.eventIdHash, decision: decision}, {origin: "home", eventIdHash: event.eventIdHash, title: event.title, startAt: event.startAt, endAt: event.endAt}) < 0) overrideAnswered({eventIdHash: event.eventIdHash}, {ok: false, error: t("Sem conexão com o FalaTrace.")})
    }
    function overrideAnswered(request, message) {
        const pendingNext = Object.assign({}, overridePending); delete pendingNext[request.eventIdHash]; overridePending = pendingNext
        const notes = Object.assign({}, eventNotes)
        if (!message.ok) { notes[request.eventIdHash] = t(message.error); eventNotes = notes; return }
        const result = message.result
        if (result.startCapture === true) {
            // The call monitor does not record here: the Studio records, with the usual confirmation.
            if (recordNowAllowed(request)) startCaptureFor(request.title, false)
            else { notes[request.eventIdHash] = t("Nesta configuração o FalaTrace não grava sozinho. Use Gravar agora quando a reunião começar."); eventNotes = notes }
        } else if (result.saved) {
            const updated = Object.assign({}, home)
            updated.upcoming = upcoming.map(function(event){ return event.eventIdHash === request.eventIdHash ? Object.assign({}, event, {plan: result.plan}) : event })
            home = updated
            toast.show(result.plan === "skip" ? tf("“%1” não será gravada.", request.title) : result.plan === "record-override" ? tf("“%1” será gravada quando começar.", request.title) : tf("“%1” volta ao normal.", request.title),
                result.plan === "skip" || result.plan === "record-override" ? t("Desfazer") : "", result.plan === "skip" || result.plan === "record-override" ? function() { homeView.decide({eventIdHash: request.eventIdHash, title: request.title, startAt: request.startAt, endAt: request.endAt}, "clear") } : null)
        }
    }

    // ── Open actions (optimistic, one save per recording at a time, like the notes) ──
    function actionStatus(action) { const state = action && action.actionId ? actionState[action.actionId] : null; return state ? state.status : action && action.status ? action.status : "open" }
    function filePending(sha) { for (const id in actionState) if (actionState[id].pending && actionState[id].sha === sha) return true; return false }
    function actionEditable(action) { return !!action && !!action.actionId && !!action.mediaSha256 && feature("actions") && backend.available && !filePending(action.mediaSha256) }
    function setAction(action, status) {
        if (!actionEditable(action)) return
        const previous = actionStatus(action)
        const next = Object.assign({}, actionState); next[action.actionId] = {status: status, pending: true, sha: action.mediaSha256}; actionState = next
        const rev = Math.max(Number(action.rev) || 0, Number(fileRevs[action.mediaSha256]) || 0)
        const payload = {mediaSha256: action.mediaSha256, actionId: action.actionId, status: status}
        if (typeof action.rev === "number" || fileRevs[action.mediaSha256] !== undefined) payload.expectedRev = rev
        const meta = {origin: "home", actionId: action.actionId, sha: action.mediaSha256, previousStatus: previous, requestedStatus: status, text: action.text || ""}
        if (send("action-set", "", payload, meta) < 0) actionAnswered(meta, {ok: false, error: t("Sem conexão com o FalaTrace.")})
    }
    function actionAnswered(request, message) {
        const next = Object.assign({}, actionState)
        if (!message.ok) {
            next[request.actionId] = {status: request.previousStatus, pending: false, sha: request.sha}; actionState = next
            toast.show(message.error === "As ações mudaram em outra janela; recarregue e tente de novo." ? t("Essa ação mudou em outra janela; atualizei.") : t(message.error), "", null, {kind: "warning"})
            loadHome()
            return
        }
        next[request.actionId] = {status: request.requestedStatus, pending: false, sha: request.sha}; actionState = next
        const revs = Object.assign({}, fileRevs); revs[request.sha] = Number(message.result.rev) || 0; fileRevs = revs
        if (request.requestedStatus === "done") toast.show(t("Ação concluída"), t("Desfazer"), function() { homeView.setAction({actionId: request.actionId, mediaSha256: request.sha, text: request.text}, "open") })
    }

    function ttfsText(ms) {
        const total = Math.max(1, Math.round(Number(ms) / 1000))
        const minutes = Math.floor(total / 60), seconds = total % 60
        return minutes ? tf("%1 min %2 s", minutes, seconds) : tf("%1 s", seconds)
    }
    function newestNotes() {
        const done = items.filter(function(item){ return item.status === "completed" }).sort(function(a, b){ return timeValue(b.modifiedAt) - timeValue(a.modifiedAt) })
        return done.length ? done[0] : null
    }
    function dismissFirstRun() {
        firstRunClosed = true
        if (backend.available) send("first-run-dismiss", "", ({}), {origin: "firstRun"})
    }
    function jobTitle(job) {
        const item = findMeeting(job.id)
        return item ? (recordingTitle(item) || item.fileName || "") : (recordingTitle(job) || t("Reunião"))
    }

    ColumnLayout {
        id: homeColumn
        x: Math.max(compactLayout ? 22 : 34, (homeView.width - 880) / 2)
        y: compactLayout ? 20 : 28
        width: Math.min(880, homeView.width - 2 * (compactLayout ? 22 : 34))
        spacing: 18

        RowLayout {
            Layout.fillWidth: true
            spacing: 10
            Label { text: t("Início"); textFormat: Text.PlainText; color: ink; font.pixelSize: compactLayout ? 22 : 26; font.weight: Font.DemiBold; Layout.fillWidth: true }
            FtButton {
                objectName: "homeRecord"
                visible: backend.available && captureKnown && !captureStatus.active
                variant: "primary"; iconName: "record"; iconTint: onAccent
                text: t("Gravar…")
                enabled: !captureBusy
                Accessible.name: t("Iniciar uma gravação manual após confirmação")
                onClicked: startCaptureFor("", false)
            }
        }

        // Disconnected, or the library could not be read.
        Rectangle {
            Layout.fillWidth: true
            visible: !backend.available || (!loading && !!errorText && items.length === 0)
            implicitHeight: homeAlertRow.implicitHeight + 28
            radius: 12; color: errorSoft
            RowLayout {
                id: homeAlertRow
                anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; anchors.margins: 14
                spacing: 12
                FtIcon { name: backend.available ? "alert" : "plug"; tint: errorColor; size: 20 }
                Label { Layout.fillWidth: true; text: backend.available ? t(errorText) : t("Sem conexão com o FalaTrace. Nada foi apagado; reconecte para continuar."); textFormat: Text.PlainText; color: ink; wrapMode: Text.WordWrap }
                FtButton { text: backend.available ? t("Tentar novamente") : t("Reconectar"); compact: true; onClicked: { if (backend.available) { loading = true; send("list", "") } else backend.reconnect() } }
            }
        }

        // A capture running (from the call monitor or here): one click back to its notes.
        Rectangle {
            objectName: "homeRecording"
            Layout.fillWidth: true
            visible: captureStatus.active === true
            implicitHeight: recordingRow.implicitHeight + 24
            radius: 12; color: recordingSoft
            border.width: 1; border.color: recordingColor
            RowLayout {
                id: recordingRow
                anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; anchors.margins: 14
                spacing: 10
                Rectangle { implicitWidth: 10; implicitHeight: 10; radius: 2; color: recordingColor }
                Label { Layout.fillWidth: true; text: tf("Gravando agora · %1", captureClock()); textFormat: Text.PlainText; color: ink; font.pixelSize: 15; font.weight: Font.DemiBold }
                FtButton { visible: liveAvailable(); compact: true; variant: "outline"; iconName: "note"; text: t("Abrir notas"); onClicked: openLive() }
            }
        }

        // First run: until the first notes are celebrated (the times are measured on this computer).
        FtCard {
            id: firstRunCard
            objectName: homeView.firstRunState === "done" ? "firstRunCelebration" : "firstRunCard"
            Layout.fillWidth: true
            visible: homeView.firstRunShown
            color: homeView.firstRunState === "done" ? accentSoft : surface
            implicitHeight: firstRunColumn.implicitHeight + 32
            ColumnLayout {
                id: firstRunColumn
                anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 16
                spacing: 10
                RowLayout {
                    spacing: 10
                    FtIcon { name: homeView.firstRunState === "done" ? "check" : "spark"; tint: accent; size: 20 }
                    Label {
                        Layout.fillWidth: true
                        text: homeView.firstRunState === "done" ? (firstRun.ttfsMs ? tf("Suas primeiras notas ficaram prontas em %1.", homeView.ttfsText(firstRun.ttfsMs)) : t("Suas primeiras notas ficaram prontas."))
                            : t("Suas primeiras notas em 5 minutos")
                        textFormat: Text.PlainText; color: ink; font.pixelSize: 16; font.weight: Font.DemiBold; wrapMode: Text.WordWrap
                    }
                }
                Flow {
                    visible: homeView.firstRunState !== "done"
                    Layout.fillWidth: true
                    spacing: 16
                    Repeater {
                        model: [{label: t("Configurado"), done: true}, {label: t("Grave 1 minuto"), done: !!firstRun.firstRecordingAt}, {label: t("Veja as notas"), done: !!firstRun.firstSummaryAt}]
                        delegate: Row {
                            required property var modelData
                            spacing: 6
                            Rectangle {
                                width: 18; height: 18; radius: 9
                                color: modelData.done ? accent : "transparent"
                                border.width: modelData.done ? 0 : 1.5; border.color: dividerStrong
                                anchors.verticalCenter: parent.verticalCenter
                                FtIcon { anchors.centerIn: parent; visible: modelData.done; name: "check"; tint: onAccent; size: 12 }
                            }
                            Label { text: modelData.label; textFormat: Text.PlainText; color: modelData.done ? ink : muted; font.pixelSize: 13; anchors.verticalCenter: parent.verticalCenter }
                        }
                    }
                }
                Label {
                    Layout.fillWidth: true
                    text: homeView.firstRunState === "start" ? t("Grave um minuto de conversa para ver como fica.")
                        : homeView.firstRunState === "recording" ? t("Gravando… fale e anote uma ou duas linhas.")
                        : homeView.firstRunState === "generating" ? (processingWait ? t(processingWait) : t("Gerando suas primeiras notas…"))
                        : t("Cada ponto das notas leva ao momento em que foi dito.")
                    textFormat: Text.PlainText; color: muted; font.pixelSize: 13; wrapMode: Text.WordWrap
                }
                Flow {
                    Layout.fillWidth: true
                    spacing: 8
                    FtButton { objectName: "firstRunRecord"; visible: homeView.firstRunState === "start"; variant: "primary"; iconName: "record"; iconTint: onAccent; text: t("Gravar conversa de teste"); enabled: backend.available && captureKnown && !captureBusy; onClicked: startCaptureFor(t("Conversa de teste"), true) }
                    FtButton { visible: homeView.firstRunState === "recording" && liveAvailable(); variant: "outline"; iconName: "note"; text: t("Abrir notas"); onClicked: openLive() }
                    FtButton { objectName: "firstRunOpen"; visible: homeView.firstRunState === "done" && !!homeView.newestNotes(); variant: "primary"; iconName: "note"; text: t("Ver notas"); onClicked: { const item = homeView.newestNotes(); if (item) selectRecording(item) } }
                    FtButton { objectName: "firstRunDismiss"; visible: homeView.firstRunState === "done"; variant: "outline"; text: t("Fechar"); onClicked: homeView.dismissFirstRun() }
                }
            }
        }

        // ── A seguir ──
        ColumnLayout {
            objectName: "upcomingList"
            Layout.fillWidth: true
            visible: feature("upcoming")
            spacing: 8
            RowLayout {
                Layout.fillWidth: true
                FtOverline { text: t("A seguir"); Layout.fillWidth: true }
                BusyIndicator { visible: homeView.homeLoading && !homeView.homeLoaded; running: visible; implicitWidth: 20; implicitHeight: 20 }
            }
            Label { visible: homeView.homeLoaded && !homeView.upcoming.length && !homeView.home.calendarError; text: t("Nada na agenda nas próximas horas."); textFormat: Text.PlainText; color: muted; font.pixelSize: 13 }
            RowLayout {
                visible: !!homeView.home.calendarError || (!!homeView.homeError && !homeView.homeLoaded)
                spacing: 6
                Label { text: homeView.home.calendarError ? t("Não deu para ler a agenda agora.") : homeView.homeError; textFormat: Text.PlainText; color: muted; font.pixelSize: 13 }
                FtButton { iconOnly: true; compact: true; variant: "ghost"; iconName: "refresh"; text: t("Tentar de novo"); enabled: backend.available && !homeView.homeLoading; onClicked: homeView.loadHome() }
            }
            Repeater {
                model: homeView.upcoming
                delegate: FtCard {
                    id: eventCard
                    required property var modelData
                    readonly property string hash: modelData.eventIdHash
                    readonly property bool open: homeView.expanded === hash
                    readonly property string pendingDecision: homeView.overridePending[hash] || ""
                    objectName: "upcomingEvent-" + hash
                    Layout.fillWidth: true
                    implicitHeight: eventColumn.implicitHeight + 20
                    border.color: open ? dividerStrong : divider
                    ColumnLayout {
                        id: eventColumn
                        anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 10
                        anchors.leftMargin: 14
                        spacing: 8
                        RowLayout {
                            Layout.fillWidth: true
                            spacing: 10
                            ColumnLayout {
                                spacing: 0
                                Layout.preferredWidth: 58
                                Label { text: homeView.timeOf(eventCard.modelData.startAt); textFormat: Text.PlainText; color: ink; font.pixelSize: 15; font.weight: Font.DemiBold; font.family: "monospace" }
                                Label { visible: text !== ""; text: homeView.eventDay(eventCard.modelData.startAt); textFormat: Text.PlainText; color: muted; font.pixelSize: 11 }
                            }
                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 2
                                Label { text: eventCard.modelData.title || t("Reunião sem título"); textFormat: Text.PlainText; color: ink; font.pixelSize: 14; font.weight: Font.Medium; elide: Text.ElideRight; Layout.fillWidth: true }
                                Label {
                                    visible: text !== ""
                                    text: [homeView.attendeesText(eventCard.modelData), eventCard.modelData.template ? tf("Modelo: %1", eventCard.modelData.template.name) : ""].filter(function(part){ return !!part }).join(" · ")
                                    textFormat: Text.PlainText; color: muted; font.pixelSize: 12; elide: Text.ElideRight; Layout.fillWidth: true
                                }
                            }
                            FtChip { visible: !compactLayout || !eventCard.open; text: homeView.planText(eventCard.modelData.plan); kind: homeView.planKind(eventCard.modelData.plan); iconName: eventCard.modelData.plan === "skip" ? "skip" : eventCard.modelData.plan === "notify" ? "bell" : "record" }
                            FtButton {
                                objectName: "eventMore-" + eventCard.hash
                                iconOnly: true; compact: true; variant: "ghost"
                                iconName: eventCard.open ? "chevron-down" : "chevron-right"
                                text: eventCard.open ? t("Fechar detalhes") : t("Ver o que ficou da última vez")
                                Accessible.name: text + ": " + (eventCard.modelData.title || "")
                                onClicked: homeView.expanded = eventCard.open ? "" : eventCard.hash
                            }
                        }
                        ColumnLayout {
                            visible: eventCard.open
                            Layout.fillWidth: true
                            Layout.leftMargin: compactLayout ? 0 : 68
                            spacing: 10
                            BriefCard { visible: !!eventCard.modelData.brief; Layout.fillWidth: true; info: eventCard.modelData.brief || null; eventHash: eventCard.hash }
                            Label { visible: !eventCard.modelData.brief; text: t("Nenhuma reunião anterior parecida."); textFormat: Text.PlainText; color: muted; font.pixelSize: 12 }
                            Label { visible: !!homeView.eventNotes[eventCard.hash]; text: homeView.eventNotes[eventCard.hash] || ""; textFormat: Text.PlainText; color: warningColor; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                            Flow {
                                Layout.fillWidth: true
                                spacing: 8
                                FtButton { objectName: "eventSkip-" + eventCard.hash; visible: eventCard.modelData.plan === "record"; compact: true; variant: "outline"; iconName: "skip"; text: t("Pular esta gravação"); enabled: backend.available && !eventCard.pendingDecision; onClicked: homeView.decide(eventCard.modelData, "skip") }
                                FtButton { objectName: "eventRecord-" + eventCard.hash; visible: eventCard.modelData.plan === "notify"; compact: true; variant: "outline"; iconName: "record"; iconTint: recordingColor; text: t("Gravar esta reunião"); enabled: backend.available && !eventCard.pendingDecision; onClicked: homeView.decide(eventCard.modelData, "record") }
                                FtButton { objectName: "eventClear-" + eventCard.hash; visible: eventCard.modelData.plan === "skip" || eventCard.modelData.plan === "record-override"; compact: true; variant: "ghost"; iconName: "undo"; text: t("Desfazer a escolha"); enabled: backend.available && !eventCard.pendingDecision; onClicked: homeView.decide(eventCard.modelData, "clear") }
                                FtButton { objectName: "eventRecordNow-" + eventCard.hash; visible: homeView.recordNowAllowed(eventCard.modelData) && !captureStatus.active; compact: true; variant: "primary"; iconName: "record"; iconTint: onAccent; text: t("Gravar agora"); enabled: backend.available && captureKnown && !captureBusy; onClicked: startCaptureFor(eventCard.modelData.title, false) }
                            }
                        }
                    }
                    TapHandler { enabled: !eventCard.open; onTapped: homeView.expanded = eventCard.hash }
                }
            }
        }
        // No calendar: one muted line, no empty section.
        RowLayout {
            objectName: "homeNoCalendar"
            visible: newBridge && !feature("upcoming")
            Layout.fillWidth: true
            spacing: 8
            FtIcon { name: "calendar"; tint: muted; size: 16 }
            Label { Layout.fillWidth: true; text: t("Conecte sua agenda para ver as próximas reuniões e receber lembretes."); textFormat: Text.PlainText; color: muted; font.pixelSize: 13; wrapMode: Text.WordWrap }
            FtButton { compact: true; variant: "ghost"; text: t("Conectar agenda"); enabled: backend.available; onClicked: { settingsDialog.open(); settingsDialog.goToSection(5) } }
        }

        // ── Ações abertas ──
        ColumnLayout {
            objectName: "homeActions"
            Layout.fillWidth: true
            visible: feature("actions") && homeView.homeLoaded && homeView.openActions.length > 0
            spacing: 6
            RowLayout {
                Layout.fillWidth: true
                FtOverline { text: tf("Ações abertas · %1", Number(homeView.home.openActionsTotal || homeView.openActions.length)); Layout.fillWidth: true }
                FtButton { objectName: "homeAllActions"; visible: viewAvailable("actions"); compact: true; variant: "ghost"; text: t("Ver todas →"); onClicked: navigate("actions") }
            }
            Repeater {
                model: homeView.openActions
                delegate: RowLayout {
                    id: homeAction
                    required property var modelData
                    readonly property string status: homeView.actionStatus(modelData)
                    objectName: "homeAction-" + modelData.actionId
                    Layout.fillWidth: true
                    spacing: 8
                    FtCheck {
                        objectName: "homeActionCheck-" + homeAction.modelData.actionId
                        Layout.alignment: Qt.AlignTop
                        checked: homeAction.status === "done"
                        enabled: homeView.actionEditable(homeAction.modelData)
                        text: (checked ? t("Reabrir a ação: ") : t("Concluir a ação: ")) + (homeAction.modelData.text || "")
                        onToggled: homeView.setAction(homeAction.modelData, checked ? "done" : "open")
                    }
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 1
                        Label {
                            Layout.fillWidth: true
                            text: homeAction.modelData.text || ""
                            textFormat: Text.PlainText; wrapMode: Text.Wrap; font.pixelSize: 14
                            font.weight: homeAction.modelData.origin === "note" ? Font.Medium : Font.Normal
                            font.strikeout: homeAction.status === "done"
                            color: homeAction.status === "done" ? muted : homeAction.modelData.origin === "note" ? noteInk : aiInk
                        }
                        Label {
                            Layout.fillWidth: true
                            text: [homeAction.modelData.owner || "", homeAction.modelData.dueDate ? tf("até %1", homeAction.modelData.dueDate) : ""].filter(function(part){ return !!part }).join(" · ")
                            visible: text !== ""
                            textFormat: Text.PlainText; color: muted; font.pixelSize: 12; elide: Text.ElideRight
                        }
                    }
                    FtButton {
                        compact: true; variant: "ghost"; implicitHeight: 28
                        Layout.maximumWidth: compactLayout ? 190 : 260
                        text: (homeAction.modelData.title || "") + (homeAction.modelData.date ? " · " + Qt.formatDate(new Date(homeAction.modelData.date), t("dd/MM")) : "")
                        Accessible.name: tf("Abrir a reunião %1", homeAction.modelData.title || "")
                        enabled: !!findMeeting(homeAction.modelData.jobId)
                        onClicked: openMeetingAt(homeAction.modelData.jobId, asList(homeAction.modelData.segmentIds)[0] || "", typeof homeAction.modelData.start === "number" ? homeAction.modelData.start : -1)
                    }
                }
            }
        }

        // ── Gerando notas ──
        ColumnLayout {
            objectName: "homeProcessing"
            Layout.fillWidth: true
            visible: homeView.processingJobs.length > 0
            spacing: 4
            FtOverline { text: t("Gerando notas") }
            Repeater {
                model: homeView.processingJobs
                delegate: ItemDelegate {
                    id: jobRow
                    required property var modelData
                    Layout.fillWidth: true
                    hoverEnabled: true
                    enabled: !!findMeeting(modelData.id)
                    leftPadding: 4; rightPadding: 8; topPadding: 6; bottomPadding: 6
                    Accessible.name: homeView.jobTitle(modelData) + ", " + statusText(modelData.state)
                    background: Rectangle { radius: 8; color: jobRow.hovered ? hoverSurface : "transparent"; border.width: jobRow.visualFocus ? 2 : 0; border.color: accent }
                    contentItem: RowLayout {
                        spacing: 8
                        BusyIndicator { running: jobRow.modelData.state === "processing"; visible: running; implicitWidth: 18; implicitHeight: 18 }
                        Rectangle { visible: jobRow.modelData.state !== "processing"; implicitWidth: 8; implicitHeight: 8; radius: 4; color: warningColor; Layout.leftMargin: 5; Layout.rightMargin: 5 }
                        Label { text: homeView.jobTitle(jobRow.modelData); textFormat: Text.PlainText; color: ink; font.pixelSize: 14; elide: Text.ElideRight; Layout.fillWidth: true }
                        Label { text: jobRow.modelData.state === "processing" ? t("Transcrevendo e gerando notas…") : statusText(jobRow.modelData.state); textFormat: Text.PlainText; color: muted; font.pixelSize: 12 }
                    }
                    onClicked: openMeetingAt(modelData.id, "", -1)
                }
            }
        }

        RowLayout {
            visible: loading && backend.available
            spacing: 10
            BusyIndicator { running: parent.visible; implicitWidth: 28; implicitHeight: 28 }
            Label { text: t("Carregando a biblioteca…"); color: muted }
        }
        // An empty library: the first recording is the next step.
        FtEmptyState {
            objectName: "homeEmpty"
            Layout.fillWidth: true
            Layout.topMargin: 12
            visible: !loading && backend.available && items.length === 0 && !errorText && !homeView.firstRunShown
            iconName: "record"
            title: t("Nenhuma reunião ainda")
            body: t("Grave sua primeira reunião. As notas aparecem aqui.")
            primaryText: t("Gravar…")
            primaryIcon: "record"
            primaryEnabled: backend.available && captureKnown && !captureBusy && !captureStatus.active
            secondaryText: t("Configurações…")
            onPrimaryClicked: startCaptureFor("", false)
            onSecondaryClicked: settingsDialog.open()
        }
        // Nothing to do right now.
        FtEmptyState {
            objectName: "homeIdle"
            Layout.fillWidth: true
            Layout.topMargin: 12
            visible: !loading && backend.available && items.length > 0 && !homeView.firstRunShown && !captureStatus.active && !homeView.processingJobs.length
                && !(feature("upcoming") && homeView.upcoming.length) && !(feature("actions") && homeView.openActions.length)
            iconName: "check"
            title: t("Tudo em dia")
            body: t("Escolha uma reunião na lista ao lado ou grave uma nova.")
        }
        AskBar { Layout.fillWidth: true; Layout.topMargin: 4 }
    }
}
