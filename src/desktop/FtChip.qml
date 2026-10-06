import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Rectangle {
    id: chipControl
    property string text: ""
    property string kind: "neutral"
    property string iconName: ""
    property real maximumWidth: 420
    readonly property color foreground: kindColor(kind)
    implicitHeight: 24
    implicitWidth: Math.min(maximumWidth, (chipIcon.visible ? 27 : 10) + chipLabel.implicitWidth + 10)
    radius: 12
    color: kind === "accent" ? accentSoft : kind === "warning" ? warningSoft : kind === "danger" ? errorSoft : kind === "recording" ? recordingSoft : surfaceAlt
    border.width: kind === "neutral" ? 1 : 0
    border.color: divider
    FtIcon { id: chipIcon; name: chipControl.iconName; tint: chipControl.foreground; size: 13; anchors.left: parent.left; anchors.leftMargin: 9; anchors.verticalCenter: parent.verticalCenter }
    Label {
        id: chipLabel
        anchors.left: parent.left
        anchors.leftMargin: chipIcon.visible ? 27 : 10
        anchors.right: parent.right
        anchors.rightMargin: 10
        anchors.verticalCenter: parent.verticalCenter
        text: chipControl.text
        textFormat: Text.PlainText
        color: chipControl.foreground
        font.pixelSize: 12
        font.weight: Font.Medium
        elide: Text.ElideRight
    }
}
