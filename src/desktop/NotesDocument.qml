import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// The meeting's notes (DESIGN-STUDIO §2.6). Your lines are in ink and medium weight with a "•";
// lines the AI completed are in aiInk with a spark and the moments they cite (click to listen, Shift
// for the transcript). Actions have a checkbox (action-set, optimistic, with Desfazer). Summaries from
// before the notes format (Markdown) use the same look through summaryBlocks().
Flickable {
    id: doc
    objectName: "notesDocument"
    property alias summaryRegenerateButton: summaryRegenerateButton
    property alias visualSummaryButton: visualSummaryButton
    property var notesDoc: detail.notesDoc && detail.notesDoc.version === 2 ? detail.notesDoc : null
    readonly property bool visualShown: showVisualSummary && !!detail.visualReview && !!detail.visualReview.summaryMarkdown
    readonly property string recordingStatus: String(detail.status || selected.status || "")
    readonly property var myNotes: asList(detail.notes && detail.notes.entries)
    readonly property string docState: {
        if (visualShown) return "visual"
        if (notesDoc) return "v2"
        if (detail.summary) return "legacy"
        if (detailLoading && !detail.jobId && !detail.status) return "loading"
        if (["queued", "processing", "transferring", "pending"].indexOf(recordingStatus) >= 0) return "processing"
        if (recordingStatus === "failed") return "failed"
        if (recordingStatus === "completed" || recordingStatus === "archived") return "noSummary"
        return "empty"
    }
    readonly property var legacyBlocks: docState === "legacy" || docState === "visual" ? summaryBlocks(visualShown ? detail.visualReview.summaryMarkdown : detail.summary) : []
    property bool aboutOpen: false
    property bool orphansOpen: false
    // Optimistic action state: actionId → {status, rev, pending, sha}.
    property var actionState: ({})
    // The actions of one recording share one revision (its actions file): the newest one this page
    // saved, per mediaSha256, so a second action is saved against the file as it is now.
    property var fileRevs: ({})
    contentWidth: width
    contentHeight: column.implicitHeight + 56
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    ScrollBar.vertical: ScrollBar {}

    Connections {
        target: window
        // Another meeting (or none): back to the top with a clean state. A refresh of the same meeting
        // (the list after a job finishes, a detail reread) keeps the place in the notes.
        function onGenerationChanged() { doc.actionState = ({}); doc.fileRevs = ({}); doc.aboutOpen = false; doc.orphansOpen = false; doc.contentY = 0 }
    }

    function templateLabel(template) { return !template ? "" : template.id === "auto" ? t("Automático") : (template.name || template.id || "") }
    function templateReason(template) {
        if (!template) return ""
        return ({user: t("você escolheu"), calendar: t("pela agenda"), keywords: t("pelas palavras da conversa"), ai: t("escolhido pela IA"), "default": t("padrão"), fallback: t("padrão")})[template.source] || ""
    }
    function languageName(code) { return ({"pt-BR": t("Português"), en: t("Inglês"), es: t("Espanhol")})[code] || code || "" }
    function generatedText() {
        if (!notesDoc) return ""
        const at = notesDoc.generatedAt ? new Date(notesDoc.generatedAt) : null
        const when = at && !isNaN(at.getTime()) ? Qt.formatDateTime(at, new Date(clockDay).toDateString() === at.toDateString() ? "HH:mm" : t("dd/MM · HH:mm")) : ""
        const model = notesDoc.model && notesDoc.model.label ? notesDoc.model.label : ""
        return when ? tf("Notas de %1", when) + (model ? " · " + model : "") : model
    }
    // What this page did to an action, unless a newer read of the meeting (another window changed the
    // file after this page's save) says otherwise.
    function stateFor(action) {
        const state = action && action.actionId ? actionState[action.actionId] : null
        return state && (state.pending || !(Number(action.rev) > state.rev)) ? state : null
    }
    function effectiveStatus(action) { const state = stateFor(action); return state ? state.status : action && action.status ? action.status : "open" }
    function effectiveRev(action) { return !action ? 0 : Math.max(Number(action.rev) || 0, Number(fileRevs[action.mediaSha256]) || 0) }
    // One save at a time per recording: a second one sent meanwhile would carry a revision the first changes.
    function filePending(sha) {
        for (const id in actionState) if (actionState[id].pending && actionState[id].sha === sha) return true
        return false
    }
    function actionEditable(action) { return !!action && !!action.actionId && feature("actions") && backend.available && !filePending(action.mediaSha256) }
    function setAction(action, status, undo) {
        if (!actionEditable(action)) return
        const previousStatus = effectiveStatus(action), previousRev = effectiveRev(action)
        const next = Object.assign({}, actionState)
        next[action.actionId] = {status: status, rev: previousRev, pending: true, sha: action.mediaSha256}
        actionState = next
        const meta = {origin: "notesDocument", actionId: action.actionId, sha: action.mediaSha256, requestedStatus: status, previousStatus: previousStatus, previousRev: previousRev, undo: !!undo}
        if (send("action-set", "", {mediaSha256: action.mediaSha256, actionId: action.actionId, status: status, expectedRev: previousRev}, meta) < 0) rollback(meta, t("Sem conexão com o FalaTrace."))
    }
    function rollback(request, message) {
        const next = Object.assign({}, actionState)
        next[request.actionId] = {status: request.previousStatus, rev: request.previousRev, pending: false, sha: request.sha}
        actionState = next
        toast.show(message, "", null, {kind: "warning"})
    }
    function handleResponse(request, message) {
        if (request.op !== "action-set" || request.generation !== generation) return
        if (!message.ok) {
            const changed = message.error === "As ações mudaram em outra janela; recarregue e tente de novo."
            rollback(request, changed ? t("Essa ação mudou em outra janela; atualizei.") : t(message.error))
            if (changed && selected.key && !detailLoading) { detailLoading = true; send("detail", selected.key) }
            return
        }
        const rev = Number(message.result.rev) || request.previousRev + 1
        const next = Object.assign({}, actionState)
        next[request.actionId] = {status: request.requestedStatus, rev: rev, pending: false, sha: request.sha}
        actionState = next
        const revs = Object.assign({}, fileRevs)
        revs[request.sha] = Math.max(rev, Number(revs[request.sha]) || 0)
        fileRevs = revs
        if (request.requestedStatus === "done" && !request.undo) {
            const actionId = request.actionId
            toast.show(t("Ação concluída"), t("Desfazer"), function() { doc.setAction(doc.findAction(actionId), "open", true) })
        }
    }
    function findAction(actionId) {
        if (!notesDoc) return ({})
        for (const section of asList(notesDoc.sections)) for (const item of asList(section.items)) if (item.action && item.action.actionId === actionId) return item.action
        return ({})
    }
    function connectionLost() {
        const next = Object.assign({}, actionState)
        for (const id in next) if (next[id].pending) next[id] = Object.assign({}, next[id], {pending: false})
        actionState = next
    }

    ColumnLayout {
        id: column
        width: Math.min(docMaxWidth, doc.width - (compactLayout ? 32 : 56))
        x: (doc.width - width) / 2
        y: compactLayout ? 16 : 24
        spacing: 12

        // Header: template and when/what made these notes; regenerate on the right.
        RowLayout {
            Layout.fillWidth: true
            visible: doc.docState === "v2" || doc.docState === "legacy"
            spacing: 8
            Rectangle {
                id: templateChip
                objectName: "templateChip"
                implicitHeight: 28
                implicitWidth: Math.min(column.width * 0.6, templateRow.implicitWidth + 20)
                radius: 14
                color: surfaceAlt
                border.width: 1; border.color: divider
                readonly property string chipText: templateName.text + (templateWhy.text ? " · " + templateWhy.text : "")
                Accessible.role: Accessible.StaticText
                Accessible.name: chipText
                RowLayout {
                    id: templateRow
                    anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                    anchors.leftMargin: 10; anchors.rightMargin: 10
                    spacing: 6
                    FtIcon { name: "template"; tint: accent; size: 14 }
                    Label { id: templateName; text: doc.notesDoc ? doc.templateLabel(doc.notesDoc.template) : t("Formato antigo"); textFormat: Text.PlainText; color: ink; font.pixelSize: 12; font.weight: Font.Medium; elide: Text.ElideRight; Layout.maximumWidth: 200 }
                    Label { id: templateWhy; visible: text !== ""; text: doc.notesDoc ? doc.templateReason(doc.notesDoc.template) : t("gere de novo para usar um modelo"); textFormat: Text.PlainText; color: muted; font.pixelSize: 12; elide: Text.ElideRight; Layout.fillWidth: true }
                }
            }
            Label {
                objectName: "notesStatus"
                Layout.fillWidth: true
                text: doc.notesDoc ? doc.generatedText() : ""
                textFormat: Text.PlainText; color: muted; font.pixelSize: 12; elide: Text.ElideRight
                horizontalAlignment: Text.AlignRight
                HoverHandler { id: statusHover }
                ToolTip.visible: statusHover.hovered && !!doc.notesDoc
                ToolTip.text: doc.notesDoc && doc.notesDoc.model && doc.notesDoc.model.local ? t("Feitas neste computador") : t("Feitas por um serviço fora deste computador")
            }
            FtButton { id: summaryRegenerateButton; objectName: "summaryRegenerateButton"; compact: true; variant: "ghost"; iconName: "spark"; iconOnly: compactLayout; text: t("Gerar de novo…"); enabled: backend.available && !!detail.review && !revisionPending() && !detailLoading && !summaryBusy(); onClicked: openSummary(); Accessible.name: t("Gerar as notas de novo") }
        }

        // The visual summary someone asked for replaces the notes until they go back.
        Rectangle {
            Layout.fillWidth: true
            visible: doc.visualShown
            implicitHeight: visualRow.implicitHeight + 16
            radius: 10; color: warningSoft
            RowLayout {
                id: visualRow
                anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; anchors.margins: 10
                spacing: 8
                FtIcon { name: "frames"; tint: warningColor; size: 16 }
                Label { Layout.fillWidth: true; text: detail.visualReview && detail.visualReview.scope ? t("PARCIAL · ") + preciseClock(detail.visualReview.scope.startSeconds) + "–" + preciseClock(detail.visualReview.scope.endSeconds) + t(" · restante omitido; revisar origem") : t("Resumo visual solicitado · revisar origem"); textFormat: Text.PlainText; color: warningColor; wrapMode: Text.WordWrap; font.pixelSize: 12 }
                FtButton { compact: true; variant: "outline"; text: t("Voltar às notas"); onClicked: showVisualSummary = false }
            }
        }

        // Stale notes: one line and the way to refresh them.
        Rectangle {
            objectName: "notesStale"
            Layout.fillWidth: true
            visible: doc.docState === "v2" && !!doc.notesDoc.stale
            implicitHeight: staleRow.implicitHeight + 16
            radius: 10; color: warningSoft
            RowLayout {
                id: staleRow
                anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; anchors.margins: 10
                spacing: 8
                FtIcon { name: "alert"; tint: warningColor; size: 16 }
                Label { Layout.fillWidth: true; text: doc.notesDoc && doc.notesDoc.stale === "transcript" ? t("Você corrigiu a transcrição depois destas notas.") : t("Estas notas não incluem a versão atual das suas notas."); textFormat: Text.PlainText; color: ink; wrapMode: Text.WordWrap; font.pixelSize: 13 }
                FtButton { compact: true; variant: "outline"; text: t("Atualizar notas"); enabled: backend.available && !!detail.review && !summaryBusy(); onClicked: openSummary() }
            }
        }

        // States without AI notes.
        ColumnLayout {
            Layout.fillWidth: true
            visible: doc.docState === "processing"
            spacing: 8
            RowLayout {
                objectName: "notesProgress"
                spacing: 10
                BusyIndicator { running: parent.visible; implicitWidth: 26; implicitHeight: 26 }
                ColumnLayout {
                    spacing: 2
                    Label { text: (detail.transcript.segments || []).length ? t("Gerando notas…") : t("Transcrevendo…"); textFormat: Text.PlainText; color: ink; font.pixelSize: 15; font.weight: Font.DemiBold }
                    Label { text: t("As notas aparecem aqui assim que ficarem prontas. Você pode continuar anotando em Minhas notas."); textFormat: Text.PlainText; color: muted; font.pixelSize: 13; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                }
            }
        }
        FtEmptyState {
            Layout.fillWidth: true
            Layout.topMargin: 24
            visible: doc.docState === "loading"
            busy: true
            title: t("Carregando…")
        }
        FtEmptyState {
            objectName: "notesEmpty"
            Layout.fillWidth: true
            Layout.topMargin: doc.myNotes.length ? 0 : 24
            visible: doc.docState === "empty" || doc.docState === "failed" || doc.docState === "noSummary"
            iconName: doc.docState === "failed" ? "alert" : "spark"
            title: doc.docState === "failed" ? t("Não deu para gerar as notas.") : doc.myNotes.length ? t("Só as suas notas, por enquanto.") : t("Ainda sem notas para esta reunião.")
            body: doc.docState === "empty" ? t("Gere as notas: o FalaTrace transcreve, completa o que você escreveu e liga cada ponto ao momento em que foi dito.") : t(detail.artifactMessage || "")
            primaryText: doc.docState === "failed" ? t("Tentar de novo") : t("Gerar notas…")
            primaryIcon: "spark"
            secondaryText: (detail.transcript.segments || []).length || detail.transcript.text ? t("Ver transcrição") : ""
            primaryEnabled: backend.available && !detailLoading
            onPrimaryClicked: { if (doc.docState === "noSummary" && detail.review) openSummary(); else processDialog.open() }
            onSecondaryClicked: tabs.currentIndex = 0
        }
        // Your notes while there are no AI notes yet.
        ColumnLayout {
            Layout.fillWidth: true
            visible: doc.myNotes.length > 0 && ["processing", "empty", "failed", "noSummary"].indexOf(doc.docState) >= 0
            spacing: 6
            FtOverline { text: t("Suas notas") }
            Repeater {
                model: doc.myNotes
                delegate: RowLayout {
                    required property var modelData
                    Layout.fillWidth: true
                    spacing: 10
                    Accessible.role: Accessible.StaticText
                    Accessible.name: t("Sua nota: ") + modelData.text
                    Label { text: modelData.at || ""; textFormat: Text.PlainText; color: muted; font.pixelSize: 11; font.family: "monospace"; Layout.preferredWidth: 40; topPadding: 3 }
                    Label { text: modelData.text; textFormat: Text.PlainText; color: noteInk; font.pixelSize: 15; font.weight: Font.Medium; wrapMode: Text.Wrap; lineHeight: 1.3; Layout.fillWidth: true }
                }
            }
        }

        // ── Notes (v2) ──
        ColumnLayout {
            Layout.fillWidth: true
            visible: doc.docState === "v2"
            spacing: 6
            Label {
                objectName: "notesOverview"
                visible: text !== ""
                Layout.fillWidth: true
                text: doc.notesDoc && doc.notesDoc.overview ? doc.notesDoc.overview.text || "" : ""
                textFormat: Text.PlainText; color: aiInk; font.pixelSize: 15; lineHeight: 1.35; wrapMode: Text.Wrap
                Accessible.name: t("Completado pela IA: ") + text
            }
            Flow {
                Layout.fillWidth: true
                spacing: 6
                visible: overviewCitations.count > 0
                Repeater { id: overviewCitations; model: doc.notesDoc && doc.notesDoc.overview ? asList(doc.notesDoc.overview.citations).slice(0, 4) : []; FtCitation { required property var modelData; segmentId: modelData.segmentId || ""; start: Number(modelData.start) || 0 } }
            }
            Repeater {
                model: doc.notesDoc ? asList(doc.notesDoc.sections) : []
                delegate: ColumnLayout {
                    id: sectionBlock
                    required property var modelData
                    required property int index
                    Layout.fillWidth: true
                    Layout.topMargin: 10
                    spacing: 8
                    Label { text: sectionBlock.modelData.heading || ""; textFormat: Text.PlainText; color: ink; font.pixelSize: 16; font.weight: Font.DemiBold; wrapMode: Text.Wrap; Layout.fillWidth: true; Accessible.role: Accessible.Heading }
                    Repeater {
                        model: asList(sectionBlock.modelData.items)
                        delegate: Item {
                            id: noteItem
                            required property var modelData
                            required property int index
                            readonly property bool mine: modelData.origin === "user"
                            // Authorship is shown by colour, weight, marker and accessible name.
                            readonly property color inkColor: mine ? noteInk : aiInk
                            objectName: "noteItem-" + sectionBlock.index + "-" + index
                            Layout.fillWidth: true
                            implicitHeight: modelData.kind === "action" ? actionLine.implicitHeight : textLine.implicitHeight
                            ActionRow {
                                id: actionLine
                                visible: noteItem.modelData.kind === "action"
                                width: parent.width
                                action: noteItem.modelData.action || ({})
                                text: noteItem.modelData.text || ""
                                origin: noteItem.modelData.origin || "ai"
                                uncertain: noteItem.modelData.uncertain === true
                                citations: noteItem.modelData.kind === "action" ? noteItem.modelData.citations || [] : []
                                at: noteItem.modelData.at || ""
                                status: doc.effectiveStatus(noteItem.modelData.action)
                                editable: doc.actionEditable(noteItem.modelData.action)
                                onToggleRequested: done => doc.setAction(noteItem.modelData.action, done ? "done" : "open", false)
                            }
                            RowLayout {
                                id: textLine
                                visible: noteItem.modelData.kind !== "action"
                                width: parent.width
                                spacing: 8
                                Accessible.role: Accessible.ListItem
                                Accessible.name: (noteItem.mine ? t("Sua nota: ") : t("Completado pela IA: ")) + (noteItem.modelData.kind === "decision" ? t("decisão: ") : "") + (noteItem.modelData.text || "")
                                Item {
                                    Layout.preferredWidth: 22; Layout.preferredHeight: 20
                                    Layout.alignment: Qt.AlignTop
                                    Label { anchors.centerIn: parent; visible: noteItem.mine && noteItem.modelData.kind !== "decision"; text: "•"; color: noteInk; font.pixelSize: 18; font.weight: Font.Bold }
                                    FtIcon { anchors.centerIn: parent; visible: !noteItem.mine && noteItem.modelData.kind !== "decision"; name: "spark"; tint: aiInk; size: 12 }
                                    FtIcon { anchors.centerIn: parent; visible: noteItem.modelData.kind === "decision"; name: "flag"; tint: noteItem.mine ? noteInk : accent; size: 14 }
                                }
                                Label {
                                    Layout.fillWidth: true
                                    text: noteItem.modelData.text || ""
                                    textFormat: Text.PlainText; wrapMode: Text.Wrap
                                    font.pixelSize: 15; lineHeight: 1.3
                                    font.weight: noteItem.mine ? Font.Medium : Font.Normal
                                    color: noteItem.inkColor
                                }
                                Rectangle {
                                    visible: noteItem.modelData.uncertain === true
                                    Layout.alignment: Qt.AlignTop
                                    implicitWidth: 20; implicitHeight: 20; radius: 10
                                    color: warningSoft
                                    Label { anchors.centerIn: parent; text: "?"; color: warningColor; font.pixelSize: 12; font.weight: Font.DemiBold }
                                    HoverHandler { id: uncertainHover }
                                    ToolTip.visible: uncertainHover.hovered
                                    ToolTip.text: t("Pouco claro na gravação")
                                }
                                Rectangle {
                                    visible: noteItem.mine && !!noteItem.modelData.at
                                    Layout.alignment: Qt.AlignTop
                                    implicitHeight: 22; implicitWidth: mineAt.implicitWidth + 14; radius: 11
                                    color: "transparent"; border.width: 1; border.color: dividerStrong
                                    Label { id: mineAt; anchors.centerIn: parent; text: noteItem.modelData.at || ""; textFormat: Text.PlainText; color: muted; font.pixelSize: 11; font.family: "monospace" }
                                    HoverHandler { id: atHover }
                                    ToolTip.visible: atHover.hovered
                                    ToolTip.text: t("Quando você escreveu esta nota")
                                }
                                Repeater {
                                    model: noteItem.mine || noteItem.modelData.kind === "action" ? [] : asList(noteItem.modelData.citations).slice(0, 3)
                                    FtCitation { required property var modelData; Layout.alignment: Qt.AlignTop; segmentId: modelData.segmentId || ""; start: Number(modelData.start) || 0 }
                                }
                                Label { visible: !noteItem.mine && asList(noteItem.modelData.citations).length > 3; Layout.alignment: Qt.AlignTop; text: "+" + (asList(noteItem.modelData.citations).length - 3); color: citationInk; font.pixelSize: 11; topPadding: 3 }
                            }
                        }
                    }
                }
            }
        }

        // ── Notes before the notes format (Markdown) and the visual summary ──
        Repeater {
            model: doc.legacyBlocks
            delegate: RowLayout {
                id: legacyBlock
                required property var modelData
                required property int index
                readonly property bool heading: modelData.kind === "heading" || modelData.kind === "title"
                Layout.fillWidth: true
                Layout.topMargin: heading && index > 0 ? 10 : 0
                spacing: 8
                Item {
                    visible: legacyBlock.modelData.kind === "bullet"
                    Layout.preferredWidth: 22; Layout.preferredHeight: 20; Layout.alignment: Qt.AlignTop
                    FtIcon { anchors.centerIn: parent; name: "spark"; tint: aiInk; size: 12 }
                }
                Label {
                    Layout.fillWidth: true
                    text: legacyBlock.modelData.kind === "heading" ? t(legacyBlock.modelData.text) : legacyBlock.modelData.seconds >= 0 ? legacyBlock.modelData.text.replace(/\s*\[\d{1,2}:\d{2}(?::\d{2})?[^\]]*\]/g, "") : legacyBlock.modelData.text
                    textFormat: Text.PlainText; wrapMode: Text.Wrap
                    color: legacyBlock.heading ? ink : aiInk
                    font.pixelSize: legacyBlock.modelData.kind === "title" ? 18 : legacyBlock.heading ? 16 : 15
                    font.weight: legacyBlock.heading ? Font.DemiBold : Font.Normal
                    lineHeight: legacyBlock.heading ? 1 : 1.3
                    Accessible.name: (legacyBlock.heading ? "" : t("Completado pela IA: ")) + text
                }
                FtCitation {
                    visible: legacyBlock.modelData.seconds >= 0
                    objectName: "legacyCitation-" + legacyBlock.index
                    Layout.alignment: Qt.AlignTop
                    start: Math.max(0, legacyBlock.modelData.seconds)
                }
            }
        }

        // Actions no longer in the current notes keep their state, out of the way.
        ColumnLayout {
            Layout.fillWidth: true
            Layout.topMargin: 8
            visible: doc.docState === "v2" && asList(doc.notesDoc.orphanActions).length > 0
            spacing: 6
            FtButton { compact: true; variant: "ghost"; iconName: doc.orphansOpen ? "chevron-down" : "chevron-right"; text: tf("Não aparecem mais nas notas atuais (%1)", doc.notesDoc ? asList(doc.notesDoc.orphanActions).length : 0); onClicked: doc.orphansOpen = !doc.orphansOpen }
            Repeater {
                model: doc.orphansOpen && doc.notesDoc ? asList(doc.notesDoc.orphanActions) : []
                delegate: Label { required property var modelData; Layout.fillWidth: true; leftPadding: 30; text: (modelData.status === "done" ? "☑ " : "☐ ") + (modelData.text || ""); textFormat: Text.PlainText; color: muted; font.pixelSize: 13; wrapMode: Text.Wrap }
            }
        }

        // About these notes: template and why, language, model, transcript, limits, unused notes.
        ColumnLayout {
            Layout.fillWidth: true
            Layout.topMargin: 12
            visible: doc.docState === "v2" || doc.docState === "legacy" || doc.docState === "visual"
            spacing: 6
            Rectangle { Layout.fillWidth: true; Layout.preferredHeight: 1; color: divider }
            FtButton { objectName: "notesAboutToggle"; compact: true; variant: "ghost"; iconName: doc.aboutOpen ? "chevron-down" : "chevron-right"; text: t("Sobre estas notas"); onClicked: doc.aboutOpen = !doc.aboutOpen; Accessible.name: text + (doc.aboutOpen ? t(", aberto") : t(", fechado")) }
            ColumnLayout {
                objectName: "notesAbout"
                Layout.fillWidth: true
                Layout.leftMargin: 10
                visible: doc.aboutOpen
                spacing: 6
                Label { visible: !!doc.notesDoc; text: doc.notesDoc ? tf("Modelo: %1", doc.templateLabel(doc.notesDoc.template)) + (doc.templateReason(doc.notesDoc.template) ? " · " + doc.templateReason(doc.notesDoc.template) : "") : ""; textFormat: Text.PlainText; color: ink; font.pixelSize: 13; wrapMode: Text.Wrap; Layout.fillWidth: true }
                Label { visible: !!doc.notesDoc && !!doc.notesDoc.language; text: doc.notesDoc ? tf("Idioma: %1", doc.languageName(doc.notesDoc.language)) : ""; textFormat: Text.PlainText; color: ink; font.pixelSize: 13; Layout.fillWidth: true }
                Label { visible: !!doc.notesDoc && !!doc.notesDoc.model; text: doc.notesDoc && doc.notesDoc.model ? tf("Feitas por %1", doc.notesDoc.model.label) + " · " + (doc.notesDoc.model.local ? t("neste computador") : t("fora deste computador")) : ""; textFormat: Text.PlainText; color: ink; font.pixelSize: 13; wrapMode: Text.Wrap; Layout.fillWidth: true }
                Label { visible: !doc.notesDoc && !!detail.summaryInfo; text: t("Resumo: ") + t(detail.summaryInfo || ""); textFormat: Text.PlainText; color: ink; font.pixelSize: 13; wrapMode: Text.Wrap; Layout.fillWidth: true }
                Label { text: detail.review && detail.review.revision && detail.review.revision.revision > 0 ? t("Feitas a partir da transcrição corrigida por você.") : t("Feitas a partir da transcrição original."); textFormat: Text.PlainText; color: muted; font.pixelSize: 13; wrapMode: Text.Wrap; Layout.fillWidth: true }
                Label { visible: !!detail.artifactMessage; text: t(detail.artifactMessage || ""); textFormat: Text.PlainText; color: muted; font.pixelSize: 12; wrapMode: Text.Wrap; Layout.fillWidth: true }
                FtOverline { visible: !!doc.notesDoc && asList(doc.notesDoc.limitations).length > 0; text: t("Limites desta gravação"); Layout.topMargin: 4 }
                Repeater { model: doc.notesDoc ? asList(doc.notesDoc.limitations) : []; Label { required property var modelData; text: "– " + modelData; textFormat: Text.PlainText; color: aiInk; font.pixelSize: 13; wrapMode: Text.Wrap; Layout.fillWidth: true } }
                FtOverline { visible: !!doc.notesDoc && asList(doc.notesDoc.unusedNotes).length > 0; text: t("Notas suas que não entraram"); Layout.topMargin: 4 }
                Repeater {
                    model: doc.notesDoc ? asList(doc.notesDoc.unusedNotes) : []
                    RowLayout {
                        required property var modelData
                        Layout.fillWidth: true
                        spacing: 8
                        Label { text: modelData.at || ""; textFormat: Text.PlainText; color: muted; font.pixelSize: 11; font.family: "monospace"; Layout.preferredWidth: 40 }
                        Label { text: modelData.text || ""; textFormat: Text.PlainText; color: noteInk; font.pixelSize: 14; font.weight: Font.Medium; wrapMode: Text.Wrap; Layout.fillWidth: true }
                    }
                }
                FtButton { id: visualSummaryButton; objectName: "visualSummaryButton"; compact: true; variant: "outline"; iconName: "frames"; visible: !!detail.visualReview && !!detail.visualReview.summaryMarkdown; text: showVisualSummary ? t("Voltar às notas") : (detail.visualReview && detail.visualReview.scope ? t("Ver resumo parcial do intervalo visual") : t("Ver resumo visual solicitado")); onClicked: showVisualSummary=!showVisualSummary }
            }
        }
    }
}
