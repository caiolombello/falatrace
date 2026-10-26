import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// An empty or waiting state: icon, title, one line, up to two buttons.
ColumnLayout {
    id: empty
    property string iconName: "note"
    property string title: ""
    property string body: ""
    property string primaryText: ""
    property string primaryIcon: ""
    property string secondaryText: ""
    property bool busy: false
    property bool primaryEnabled: true
    property alias primaryButton: primaryButton
    property alias secondaryButton: secondaryButton
    signal primaryClicked()
    signal secondaryClicked()
    spacing: 10
    Rectangle {
        Layout.alignment: Qt.AlignHCenter
        implicitWidth: 48; implicitHeight: 48; radius: 24
        color: accentSoft
        visible: !empty.busy && empty.iconName !== ""
        FtIcon { anchors.centerIn: parent; name: empty.iconName; tint: accent; size: 22 }
    }
    BusyIndicator { Layout.alignment: Qt.AlignHCenter; visible: empty.busy; running: empty.busy; implicitWidth: 36; implicitHeight: 36 }
    Label { Layout.fillWidth: true; visible: text !== ""; text: empty.title; textFormat: Text.PlainText; color: ink; font.pixelSize: 16; font.weight: Font.DemiBold; horizontalAlignment: Text.AlignHCenter; wrapMode: Text.WordWrap }
    Label { Layout.fillWidth: true; visible: text !== ""; text: empty.body; textFormat: Text.PlainText; color: muted; font.pixelSize: 14; horizontalAlignment: Text.AlignHCenter; wrapMode: Text.WordWrap; lineHeight: 1.15 }
    Flow {
        Layout.alignment: Qt.AlignHCenter
        Layout.maximumWidth: empty.width
        Layout.topMargin: 4
        spacing: 8
        // From the texts, not the buttons: a hidden parent makes its children report invisible, which would never undo itself.
        visible: empty.primaryText !== "" || empty.secondaryText !== ""
        FtButton { id: primaryButton; visible: empty.primaryText !== ""; enabled: empty.primaryEnabled; variant: "primary"; iconName: empty.primaryIcon; text: empty.primaryText; onClicked: empty.primaryClicked() }
        FtButton { id: secondaryButton; visible: empty.secondaryText !== ""; variant: "outline"; text: empty.secondaryText; onClicked: empty.secondaryClicked() }
    }
}
