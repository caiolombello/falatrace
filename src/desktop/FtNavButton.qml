import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Button {
    id: navControl
    property string iconName: ""
    Layout.fillWidth: true
    implicitHeight: 38
    leftPadding: 10
    rightPadding: 10
    hoverEnabled: true
    font.pixelSize: 14
    opacity: enabled ? 1 : 0.45
    contentItem: RowLayout {
        spacing: 10
        FtIcon { name: navControl.iconName; tint: accent; size: 17 }
        Label { text: navControl.text; font: navControl.font; color: ink; elide: Text.ElideRight; textFormat: Text.PlainText; Layout.fillWidth: true }
    }
    background: Rectangle {
        radius: 8
        color: navControl.down ? selectedSurface : navControl.hovered ? hoverSurface : "transparent"
        border.width: navControl.visualFocus ? 2 : 0
        border.color: accent
    }
}
