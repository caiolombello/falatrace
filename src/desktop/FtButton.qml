import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Button {
    id: buttonControl
    property string variant: highlighted ? "primary" : "secondary"
    property string iconName: ""
    property color iconTint: foreground
    property bool iconOnly: false
    property bool compact: false
    readonly property bool flatVariant: variant === "ghost" || variant === "outline"
    readonly property color baseColor: variant === "primary" ? accent : variant === "danger" ? recordingColor : buttonSurface
    readonly property color foreground: variant === "primary" ? onAccent : variant === "danger" ? (lightTheme ? "#FFFFFF" : "#2B0B0E") : ink
    implicitHeight: compact ? 32 : 36
    implicitWidth: iconOnly ? implicitHeight : Math.max(implicitHeight, implicitContentWidth + leftPadding + rightPadding)
    leftPadding: iconOnly ? 0 : (compact ? 10 : 14)
    rightPadding: iconOnly ? 0 : (compact ? 10 : 14)
    topPadding: 0
    bottomPadding: 0
    font.pixelSize: compact ? 13 : 14
    font.weight: Font.DemiBold
    hoverEnabled: true
    opacity: enabled ? 1 : 0.45
    ToolTip.visible: iconOnly && hovered && text !== ""
    ToolTip.text: text
    ToolTip.delay: 400
    contentItem: Item {
        implicitWidth: (buttonIcon.visible ? buttonIcon.width : 0) + (buttonLabel.visible ? buttonLabel.implicitWidth + (buttonIcon.visible ? 7 : 0) : 0)
        implicitHeight: Math.max(buttonIcon.visible ? buttonIcon.height : 0, buttonLabel.implicitHeight)
        Row {
            anchors.centerIn: parent
            spacing: 7
            FtIcon { id: buttonIcon; name: buttonControl.iconName; tint: buttonControl.iconTint; size: buttonControl.compact ? 15 : 16; anchors.verticalCenter: parent.verticalCenter }
            Label {
                id: buttonLabel
                visible: !buttonControl.iconOnly && buttonControl.text !== ""
                width: Math.min(implicitWidth, Math.max(0, buttonControl.availableWidth - (buttonIcon.visible ? buttonIcon.width + 7 : 0)))
                text: buttonControl.text
                font: buttonControl.font
                color: buttonControl.foreground
                elide: Text.ElideRight
                textFormat: Text.PlainText
                anchors.verticalCenter: parent.verticalCenter
            }
        }
    }
    background: Rectangle {
        radius: 8
        color: buttonControl.flatVariant
            ? (buttonControl.down ? selectedSurface : buttonControl.hovered ? hoverSurface : "transparent")
            : (buttonControl.down ? shade(buttonControl.baseColor, 0.16) : buttonControl.hovered ? shade(buttonControl.baseColor, 0.08) : buttonControl.baseColor)
        border.width: buttonControl.variant === "outline" ? 1 : 0
        border.color: dividerStrong
        Rectangle {
            anchors.fill: parent
            anchors.margins: -3
            radius: 11
            color: "transparent"
            border.width: 2
            border.color: accent
            visible: buttonControl.visualFocus
        }
    }
}
