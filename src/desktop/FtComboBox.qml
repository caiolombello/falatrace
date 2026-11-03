import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ComboBox {
    id: comboControl
    implicitHeight: 38
    font.pixelSize: 14
    // Popup rows: readable highlight in both themes (the window palette would paint accent ink on a light row).
    palette.light: selectedSurface
    palette.highlightedText: ink
    palette.window: surface
    palette.mid: divider
    ToolTip.visible: hovered && comboLabel.truncated
    ToolTip.text: displayText
    ToolTip.delay: 400
    // Never editable: a plain label that elides long names before the arrow.
    contentItem: Label {
        id: comboLabel
        leftPadding: 12
        rightPadding: 1
        text: comboControl.displayText
        font: comboControl.font
        color: comboControl.enabled ? ink : muted
        elide: Text.ElideRight
        verticalAlignment: Text.AlignVCenter
        textFormat: Text.PlainText
    }
    background: Rectangle {
        implicitWidth: 140
        implicitHeight: 38
        radius: 8
        color: fieldSurface
        border.width: comboControl.visualFocus ? 2 : 1
        border.color: comboControl.visualFocus ? accent : comboControl.hovered ? dividerStrong : divider
    }
}
