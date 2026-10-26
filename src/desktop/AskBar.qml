import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// "✦ Pergunte sobre …  Ctrl+J" at the bottom of Início, a person or a client: opens Ask with that scope.
AbstractButton {
    id: askBar
    objectName: "askBar"
    property string placeholder: t("Pergunte sobre suas reuniões…")
    visible: feature("assistant")
    implicitHeight: 44
    focusPolicy: Qt.StrongFocus
    hoverEnabled: true
    Accessible.role: Accessible.Button
    Accessible.name: placeholder + " (Ctrl+J)"
    onClicked: askPanel.openWith(askPanel.viewScope(), "", null)
    background: Rectangle {
        radius: 12
        color: askBar.hovered ? hoverSurface : surface
        border.width: askBar.visualFocus ? 2 : 1
        border.color: askBar.visualFocus ? accent : divider
    }
    contentItem: RowLayout {
        spacing: 10
        FtIcon { name: "spark"; tint: accent; size: 16; Layout.leftMargin: 14 }
        Label { text: askBar.placeholder; textFormat: Text.PlainText; color: muted; font.pixelSize: 14; elide: Text.ElideRight; Layout.fillWidth: true }
        Label { visible: !compactLayout; text: "Ctrl+J"; textFormat: Text.PlainText; color: muted; font.pixelSize: 12; Layout.rightMargin: 14 }
    }
}
