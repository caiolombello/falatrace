import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Button {
    id: navControl
    property string iconName: ""
    // The view this entry opens is the one on screen (sidebar navigation).
    property bool current: false
    // A short count or hint on the right ("12", "Ctrl+1").
    property string badge: ""
    // Only the icon (a narrow sidebar); the text becomes the tooltip and stays the accessible name.
    property bool iconOnly: false
    Layout.fillWidth: !iconOnly
    implicitHeight: 38
    implicitWidth: iconOnly ? implicitHeight : implicitContentWidth + leftPadding + rightPadding
    leftPadding: iconOnly ? 0 : 10
    rightPadding: iconOnly ? 0 : 10
    hoverEnabled: true
    font.pixelSize: 14
    opacity: enabled ? 1 : 0.45
    Accessible.name: text + (badge !== "" ? ", " + badge : "")
    ToolTip.visible: iconOnly && hovered && text !== ""
    ToolTip.text: text
    ToolTip.delay: 400
    contentItem: RowLayout {
        spacing: 10
        FtIcon { name: navControl.iconName; tint: accent; size: 17; Layout.alignment: Qt.AlignHCenter }
        Label { visible: !navControl.iconOnly; text: navControl.text; font.pixelSize: navControl.font.pixelSize; font.weight: navControl.current ? Font.DemiBold : Font.Normal; color: ink; elide: Text.ElideRight; textFormat: Text.PlainText; Layout.fillWidth: true }
        Label { visible: navControl.badge !== "" && !navControl.iconOnly; text: navControl.badge; textFormat: Text.PlainText; color: muted; font.pixelSize: 12 }
    }
    background: Rectangle {
        radius: 8
        color: navControl.down ? selectedSurface : navControl.current ? selectedSurface : navControl.hovered ? hoverSurface : "transparent"
        border.width: navControl.visualFocus ? 2 : 0
        border.color: accent
    }
}
