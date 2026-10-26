import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// A short message at the bottom with an optional action ("Desfazer", "Abrir"). It hides after 6 s,
// or stays until closed when `persistent`. It never takes focus by itself and is not a Popup, so the
// window shortcuts and the journeys keep working while it shows.
Rectangle {
    id: toast
    objectName: "noticeToast"
    property string message: ""
    property string actionText: ""
    property var action: null
    property bool persistent: false
    property string kind: "info"
    property alias actionButton: toastAction
    function show(text, actionLabel, callback, options) {
        message = text || ""
        actionText = actionLabel || ""
        action = callback || null
        persistent = !!(options && options.persistent)
        kind = options && options.kind ? options.kind : "info"
        opened = message !== ""
        if (opened && !persistent) hideTimer.restart(); else hideTimer.stop()
    }
    function hide() { opened = false; hideTimer.stop(); action = null }
    property bool opened: false
    visible: opened
    z: 90
    width: Math.min(parent ? parent.width - 32 : 480, toastRow.implicitWidth + 28)
    height: toastRow.implicitHeight + 16
    radius: 10
    color: lightTheme ? "#102B2A" : "#E9F1EC"
    border.width: kind === "warning" ? 2 : 0
    border.color: warningColor
    Accessible.role: Accessible.AlertMessage
    Accessible.name: message
    Timer { id: hideTimer; interval: 6000; onTriggered: toast.hide() }
    HoverHandler { onHoveredChanged: { if (hovered) hideTimer.stop(); else if (toast.opened && !toast.persistent) hideTimer.restart() } }
    RowLayout {
        id: toastRow
        anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
        anchors.leftMargin: 14; anchors.rightMargin: 6
        spacing: 10
        FtIcon { name: toast.kind === "warning" ? "alert" : "check"; tint: toast.kind === "warning" ? warningColor : (lightTheme ? "#57D5B0" : "#0F705A"); size: 16 }
        Label { Layout.fillWidth: true; Layout.maximumWidth: 520; text: toast.message; textFormat: Text.PlainText; color: lightTheme ? "#F4F1E9" : "#102B2A"; font.pixelSize: 13; wrapMode: Text.WordWrap }
        Button {
            id: toastAction
            objectName: "noticeToastAction"
            visible: toast.actionText !== ""
            text: toast.actionText
            flat: true
            focusPolicy: Qt.StrongFocus
            implicitHeight: 30
            leftPadding: 10; rightPadding: 10
            contentItem: Label { text: toastAction.text; textFormat: Text.PlainText; color: lightTheme ? "#57D5B0" : "#0F705A"; font.pixelSize: 13; font.weight: Font.DemiBold; verticalAlignment: Text.AlignVCenter }
            background: Rectangle { radius: 7; color: toastAction.hovered ? (lightTheme ? "#1E3B36" : "#D3E3DA") : "transparent"; border.width: toastAction.visualFocus ? 2 : 0; border.color: lightTheme ? "#57D5B0" : "#0F705A" }
            onClicked: { const callback = toast.action; toast.hide(); if (typeof callback === "function") callback() }
        }
        Button {
            id: toastClose
            text: t("Fechar aviso")
            focusPolicy: Qt.StrongFocus
            implicitWidth: 30; implicitHeight: 30
            Accessible.name: text
            contentItem: FtIcon { name: "close"; tint: lightTheme ? "#AAC0B8" : "#566B66"; size: 14 }
            background: Rectangle { radius: 7; color: toastClose.hovered ? (lightTheme ? "#1E3B36" : "#D3E3DA") : "transparent"; border.width: toastClose.visualFocus ? 2 : 0; border.color: lightTheme ? "#57D5B0" : "#0F705A" }
            onClicked: toast.hide()
        }
    }
}
