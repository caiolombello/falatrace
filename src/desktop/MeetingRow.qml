import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// One meeting in a list: title on one line, then "14:00 · 47 min · Ana, Bruno". A dot appears only
// while the notes are not ready (amber: queued or being made; red: failed; ring: not processed yet).
ItemDelegate {
    id: row
    property var item: ({})
    property bool current: false
    property bool keyboardCurrent: false
    readonly property string recordingStatus: String(item.status || "")
    readonly property string dotKind: ["queued", "processing", "transferring", "pending"].indexOf(recordingStatus) >= 0 ? "warning" : recordingStatus === "failed" ? "danger" : recordingStatus === "unprocessed" ? "ring" : ""
    objectName: "meetingRow-" + (item.jobId || item.key || "")
    width: ListView.view ? ListView.view.width : implicitWidth
    hoverEnabled: true
    leftPadding: 12; rightPadding: 10; topPadding: 8; bottomPadding: 8
    Accessible.name: recordingTitle(item) + ", " + meetingMeta(item) + (recordingStatus ? ", " + statusText(recordingStatus) : "")
    background: Rectangle {
        radius: 9
        color: row.current ? selectedSurface : row.hovered ? hoverSurface : "transparent"
        border.width: row.visualFocus || row.keyboardCurrent ? 2 : 0
        border.color: accent
        Rectangle { visible: row.current; width: 3; radius: 1.5; color: accent; anchors.left: parent.left; anchors.top: parent.top; anchors.bottom: parent.bottom; anchors.topMargin: 9; anchors.bottomMargin: 9 }
    }
    contentItem: RowLayout {
        spacing: 8
        ColumnLayout {
            Layout.fillWidth: true
            spacing: 2
            Label { text: recordingTitle(row.item) || row.item.fileName || ""; textFormat: Text.PlainText; color: ink; font.pixelSize: 14; font.weight: row.current ? Font.DemiBold : Font.Medium; elide: Text.ElideRight; maximumLineCount: 1; Layout.fillWidth: true }
            Label { text: meetingMeta(row.item); textFormat: Text.PlainText; color: row.item.location === "missing" ? warningColor : muted; font.pixelSize: 12; elide: Text.ElideRight; Layout.fillWidth: true }
        }
        Rectangle {
            visible: row.dotKind !== ""
            Layout.alignment: Qt.AlignVCenter
            implicitWidth: 8; implicitHeight: 8; radius: 4
            color: row.dotKind === "ring" ? "transparent" : kindColor(row.dotKind)
            border.width: row.dotKind === "ring" ? 1.5 : 0
            border.color: muted
            HoverHandler { id: dotHover }
            ToolTip.visible: dotHover.hovered
            ToolTip.text: statusText(row.recordingStatus)
        }
    }
}
