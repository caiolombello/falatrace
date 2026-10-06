import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

TextField {
    id: fieldControl
    property string leadingIcon: ""
    implicitHeight: 38
    leftPadding: leadingIcon ? 36 : 12
    rightPadding: 12
    color: ink
    placeholderTextColor: muted
    selectionColor: accent
    selectedTextColor: onAccent
    font.pixelSize: 14
    background: Rectangle {
        radius: 8
        color: fieldSurface
        opacity: fieldControl.enabled ? 1 : 0.6
        border.width: fieldControl.activeFocus ? 2 : 1
        border.color: fieldControl.activeFocus ? accent : fieldControl.hovered ? dividerStrong : divider
        FtIcon { name: fieldControl.leadingIcon; tint: muted; size: 16; anchors.left: parent.left; anchors.leftMargin: 12; anchors.verticalCenter: parent.verticalCenter }
    }
}
