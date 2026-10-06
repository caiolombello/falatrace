import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ComboBox {
    id: comboControl
    implicitHeight: 38
    font.pixelSize: 14
    background: Rectangle {
        implicitWidth: 140
        implicitHeight: 38
        radius: 8
        color: fieldSurface
        border.width: comboControl.visualFocus ? 2 : 1
        border.color: comboControl.visualFocus ? accent : comboControl.hovered ? dividerStrong : divider
    }
}
