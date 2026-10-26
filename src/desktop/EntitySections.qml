import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// The body of a person or a client page: open actions (tick them here), recent decisions (each opens
// its meeting at that moment) and the meetings. Fast to scan; every meeting row opens the meeting.
ColumnLayout {
    id: sections
    property var entity: null
    property string origin: "people"
    // Optimistic action state, one save per recording at a time.
    property var actionState: ({})
    property var fileRevs: ({})
    signal reload()
    spacing: 16
    readonly property var openItems: entity ? asList(entity.openActionItems) : []
    readonly property var decisions: entity ? asList(entity.recentDecisions).slice(0, 8) : []
    readonly property var meetings: entity ? asList(entity.meetings).slice(0, 30) : []
    function dayOf(value) { const date = new Date(value); return isNaN(date.getTime()) ? "" : Qt.formatDate(date, t("dd/MM")) }
    function statusOf(action) { const state = actionState[action.actionId]; return state ? state.status : action.status }
    function filePending(sha) { for (const id in actionState) if (actionState[id].pending && actionState[id].sha === sha) return true; return false }
    function editable(action) { return feature("actions") && backend.available && !filePending(action.mediaSha256) }
    function setStatus(action, status) {
        if (!editable(action)) return
        const previous = statusOf(action)
        const rev = Math.max(Number(action.rev) || 0, Number(fileRevs[action.mediaSha256]) || 0)
        const next = Object.assign({}, actionState); next[action.actionId] = {status: status, pending: true, sha: action.mediaSha256}; actionState = next
        const meta = {origin: origin, actionId: action.actionId, sha: action.mediaSha256, previousStatus: previous, requestedStatus: status, text: action.text}
        if (send("action-set", "", {mediaSha256: action.mediaSha256, actionId: action.actionId, status: status, expectedRev: rev}, meta) < 0) handleAction(meta, {ok: false, error: t("Sem conexão com o FalaTrace.")})
    }
    function handleAction(request, message) {
        const next = Object.assign({}, actionState)
        if (!message.ok) {
            next[request.actionId] = {status: request.previousStatus, pending: false, sha: request.sha}; actionState = next
            const changed = message.error === "As ações mudaram em outra janela; recarregue e tente de novo."
            toast.show(changed ? t("Essa ação mudou em outra janela; atualizei.") : t(message.error), "", null, {kind: "warning"})
            if (changed) sections.reload()
            return
        }
        next[request.actionId] = {status: request.requestedStatus, pending: false, sha: request.sha}; actionState = next
        const revs = Object.assign({}, fileRevs); revs[request.sha] = Number(message.result.rev) || 0; fileRevs = revs
        if (request.requestedStatus === "done") toast.show(t("Ação concluída"), t("Desfazer"), function() { sections.setStatus({actionId: request.actionId, mediaSha256: request.sha, status: "done", text: request.text}, "open") })
    }
    onEntityChanged: { actionState = ({}); fileRevs = ({}) }

    ColumnLayout {
        Layout.fillWidth: true
        spacing: 6
        visible: !!sections.entity
        FtOverline { text: sections.openItems.length ? tf("Ações abertas · %1", sections.openItems.length) : t("Ações abertas") }
        Label { visible: !sections.openItems.length; text: t("Nada em aberto."); textFormat: Text.PlainText; color: muted; font.pixelSize: 13 }
        Repeater {
            model: sections.openItems
            delegate: RowLayout {
                id: entityAction
                required property var modelData
                readonly property string status: sections.statusOf(modelData)
                objectName: "entityAction-" + modelData.actionId
                Layout.fillWidth: true
                spacing: 8
                FtCheck {
                    objectName: "entityActionCheck-" + entityAction.modelData.actionId
                    Layout.alignment: Qt.AlignTop
                    checked: entityAction.status === "done"
                    enabled: sections.editable(entityAction.modelData)
                    text: (checked ? t("Reabrir a ação: ") : t("Concluir a ação: ")) + entityAction.modelData.text
                    onToggled: sections.setStatus(entityAction.modelData, checked ? "done" : "open")
                }
                // The text first (full width), then who and when, and the meeting it came from.
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 0
                    Label {
                        Layout.fillWidth: true
                        text: entityAction.modelData.text
                        textFormat: Text.PlainText; wrapMode: Text.Wrap; font.pixelSize: 14
                        font.weight: entityAction.modelData.origin === "note" ? Font.Medium : Font.Normal
                        font.strikeout: entityAction.status === "done"
                        color: entityAction.status === "done" ? muted : entityAction.modelData.origin === "note" ? noteInk : aiInk
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 6
                        Label {
                            text: [entityAction.modelData.owner || "", entityAction.modelData.dueDate ? tf("até %1", entityAction.modelData.dueDate) : ""].filter(function(part){ return !!part }).join(" · ")
                            visible: text !== ""
                            textFormat: Text.PlainText; color: muted; font.pixelSize: 12
                        }
                        FtButton {
                            compact: true; variant: "ghost"; implicitHeight: 26
                            iconName: typeof entityAction.modelData.start === "number" ? "play" : "note"
                            Layout.maximumWidth: 240
                            text: (entityAction.modelData.title || "") + " · " + sections.dayOf(entityAction.modelData.date)
                            Accessible.name: tf("Abrir a reunião %1 neste momento", entityAction.modelData.title || "")
                            enabled: !!findMeeting(entityAction.modelData.jobId)
                            onClicked: openMeetingAt(entityAction.modelData.jobId, asList(entityAction.modelData.segmentIds)[0] || "", typeof entityAction.modelData.start === "number" ? entityAction.modelData.start : -1)
                        }
                        Item { Layout.fillWidth: true }
                    }
                }
            }
        }
    }
    ColumnLayout {
        Layout.fillWidth: true
        spacing: 6
        visible: sections.decisions.length > 0
        FtOverline { text: t("Decisões recentes") }
        Repeater {
            model: sections.decisions
            delegate: RowLayout {
                required property var modelData
                Layout.fillWidth: true
                spacing: 8
                FtIcon { name: "flag"; tint: accent; size: 13; Layout.alignment: Qt.AlignTop; Layout.topMargin: 3 }
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 0
                    Label { text: modelData.text; textFormat: Text.PlainText; color: aiInk; font.pixelSize: 14; wrapMode: Text.Wrap; Layout.fillWidth: true }
                    FtButton {
                        compact: true; variant: "ghost"; implicitHeight: 26; iconName: "transcript"
                        Layout.maximumWidth: 240
                        text: (modelData.title || "") + " · " + sections.dayOf(modelData.date)
                        Accessible.name: tf("Ver na transcrição de %1", modelData.title || "")
                        enabled: !!findMeeting(modelData.jobId)
                        onClicked: openMeetingAt(modelData.jobId, asList(modelData.segmentIds)[0] || "", -1)
                    }
                }
            }
        }
    }
    ColumnLayout {
        Layout.fillWidth: true
        spacing: 2
        visible: sections.meetings.length > 0
        FtOverline { text: t("Reuniões"); Layout.bottomMargin: 4 }
        Repeater {
            model: sections.meetings
            delegate: ItemDelegate {
                id: entityMeeting
                required property var modelData
                Layout.fillWidth: true
                hoverEnabled: true
                enabled: !!findMeeting(modelData.jobId)
                leftPadding: 6; rightPadding: 8; topPadding: 6; bottomPadding: 6
                Accessible.name: (modelData.title || "") + ", " + sections.dayOf(modelData.date)
                background: Rectangle { radius: 8; color: entityMeeting.hovered ? hoverSurface : "transparent"; border.width: entityMeeting.visualFocus ? 2 : 0; border.color: accent }
                contentItem: RowLayout {
                    spacing: 10
                    Label { text: sections.dayOf(entityMeeting.modelData.date); textFormat: Text.PlainText; color: muted; font.pixelSize: 12; font.family: "monospace"; Layout.preferredWidth: 44 }
                    Label { text: entityMeeting.modelData.title || ""; textFormat: Text.PlainText; color: ink; font.pixelSize: 14; elide: Text.ElideRight; Layout.fillWidth: true }
                    Label { visible: text !== ""; text: entityMeeting.modelData.role === "speaker" ? t("falou") : entityMeeting.modelData.role === "attendee" ? t("convidada(o)") : entityMeeting.modelData.source === "manual" ? t("definido por você") : ""; textFormat: Text.PlainText; color: muted; font.pixelSize: 12 }
                }
                onClicked: openMeetingAt(modelData.jobId, "", -1)
            }
        }
    }
}
