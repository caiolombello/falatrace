import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// One value of a settings field shown as a card: a title, one line on what leaves this computer
// and what it costs, and, while it is the chosen value, the fields that go with it.
Rectangle {
    id: card
    property string field: ""
    property var value
    property string heading: ""
    property string detail: ""
    property string iconName: ""
    default property alias extra: extraColumn.data
    readonly property bool selected: settingsDraft[field] === value
    Layout.fillWidth: true
    implicitHeight: cardColumn.implicitHeight + 20
    radius: 10
    color: selected ? selectedSurface : surfaceAlt
    border.width: chooser.visualFocus ? 2 : selected ? 2 : 1
    border.color: chooser.visualFocus || selected ? accent : divider
    ColumnLayout {
        id: cardColumn
        anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top
        anchors.margins: 10
        spacing: 6
        AbstractButton {
            id: chooser
            objectName: card.objectName ? card.objectName + "Choose" : ""
            Layout.fillWidth: true
            implicitHeight: chooserRow.implicitHeight
            hoverEnabled: true
            focusPolicy: Qt.StrongFocus
            enabled: settingsEditable
            Accessible.role: Accessible.RadioButton
            Accessible.name: card.heading
            Accessible.description: card.detail
            Accessible.checked: card.selected
            onClicked: if (!card.selected) setSettingsField(card.field, card.value)
            Keys.onSpacePressed: clicked()
            contentItem: Item {}
            background: Item {}
            RowLayout {
                id: chooserRow
                anchors.left: parent.left; anchors.right: parent.right
                spacing: 10
                Rectangle {
                    Layout.alignment: Qt.AlignTop; Layout.topMargin: 2
                    implicitWidth: 16; implicitHeight: 16; radius: 8
                    color: "transparent"; border.width: 2; border.color: card.selected ? accent : dividerStrong
                    opacity: chooser.enabled ? 1 : 0.5
                    Rectangle { anchors.centerIn: parent; width: 8; height: 8; radius: 4; color: accent; visible: card.selected }
                }
                FtIcon { visible: !!card.iconName; Layout.alignment: Qt.AlignTop; name: card.iconName; tint: card.selected ? accent : muted; size: 16 }
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 2
                    Label { text: card.heading; textFormat: Text.PlainText; color: ink; font.weight: Font.DemiBold; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                    Label { visible: text !== ""; text: card.detail; textFormat: Text.PlainText; color: muted; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                }
            }
        }
        ColumnLayout {
            id: extraColumn
            visible: card.selected && children.length > 0
            Layout.fillWidth: true
            Layout.leftMargin: 26
            spacing: 8
        }
    }
}
