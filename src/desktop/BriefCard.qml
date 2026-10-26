import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// What was left from earlier meetings with the same people (home-read's brief): up to three decisions
// with the moment they were said, open actions you can tick, and the related meetings. Nothing
// relevant means no brief at all (the bridge sends none), never filler.
ColumnLayout {
    id: brief
    property var info: null
    property string eventHash: ""
    objectName: "briefPanel-" + eventHash
    spacing: 8
    readonly property var decisions: info ? asList(info.recentDecisions).slice(0, 3) : []
    readonly property var actions: info ? asList(info.openActions).slice(0, 5) : []
    readonly property var meetings: info ? asList(info.recentMeetings).slice(0, 3) : []
    function dayOf(value) { const date = new Date(value); return isNaN(date.getTime()) ? "" : Qt.formatDate(date, t("dd/MM")) }
    // A decision carries its meeting, not its date: the date comes from that meeting.
    function meetingDay(jobId) { for (const meeting of asList(info ? info.recentMeetings : [])) if (meeting.jobId === jobId) return dayOf(meeting.date); return "" }

    FtOverline { visible: brief.meetings.length > 0; text: tf("Da última vez (%1)", brief.dayOf(brief.meetings.length ? brief.meetings[0].date : "")) }
    Repeater {
        model: brief.decisions
        delegate: RowLayout {
            required property var modelData
            Layout.fillWidth: true
            spacing: 8
            FtIcon { name: "flag"; tint: accent; size: 13; Layout.alignment: Qt.AlignTop; Layout.topMargin: 3 }
            Label { text: modelData.text || ""; textFormat: Text.PlainText; color: ink; font.pixelSize: 13; wrapMode: Text.Wrap; Layout.fillWidth: true }
            FtButton {
                visible: !!modelData.citation
                compact: true; variant: "ghost"; implicitHeight: 26
                iconName: "play"
                text: modelData.citation ? [brief.meetingDay(modelData.citation.jobId || modelData.jobId), typeof modelData.citation.start === "number" ? clock(modelData.citation.start) : ""].filter(function(part){ return !!part }).join(" · ") || t("Abrir") : ""
                Accessible.name: t("Abrir a reunião neste momento")
                onClicked: openMeetingAt(modelData.citation.jobId || modelData.jobId, modelData.citation.segmentId || "", typeof modelData.citation.start === "number" ? modelData.citation.start : -1)
            }
        }
    }
    Repeater {
        model: brief.actions
        delegate: RowLayout {
            id: briefAction
            required property var modelData
            readonly property string status: homeView.actionStatus(modelData)
            Layout.fillWidth: true
            spacing: 6
            FtCheck {
                objectName: "briefActionCheck-" + briefAction.modelData.actionId
                checked: briefAction.status === "done"
                enabled: homeView.actionEditable(briefAction.modelData)
                text: (checked ? t("Reabrir a ação: ") : t("Concluir a ação: ")) + (briefAction.modelData.text || "")
                onToggled: homeView.setAction(briefAction.modelData, checked ? "done" : "open")
            }
            Label {
                Layout.fillWidth: true
                text: (briefAction.modelData.text || "") + (briefAction.modelData.ownerText ? " — " + briefAction.modelData.ownerText : "") + (briefAction.modelData.dueDate ? " · " + tf("até %1", briefAction.modelData.dueDate) : "")
                textFormat: Text.PlainText; wrapMode: Text.Wrap; font.pixelSize: 13
                font.strikeout: briefAction.status === "done"
                color: briefAction.status === "done" ? muted : ink
            }
        }
    }
    Flow {
        visible: brief.meetings.length > 0
        Layout.fillWidth: true
        spacing: 6
        Repeater {
            model: brief.meetings
            delegate: FtButton {
                required property var modelData
                compact: true; variant: "outline"; implicitHeight: 28; iconName: "note"
                text: (modelData.title || "") + " · " + brief.dayOf(modelData.date)
                enabled: !!findMeeting(modelData.jobId)
                onClicked: openMeetingAt(modelData.jobId, "", -1)
            }
        }
    }
}
