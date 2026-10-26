import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

FtDialog {
    id: captureConsent
    property string intent: "capture"
    // The meeting's name when the capture starts from the calendar (Início); empty otherwise.
    property string captureTitle: ""
    objectName: "captureConsent"
    title: intent === "resume" ? t("Retomar gravações automáticas") : t("Antes de gravar")
    anchors.centerIn: parent
    width: Math.min(window.width - 64, 540)
    modal: true
    closePolicy: Popup.CloseOnEscape
    contentItem: RowLayout {
        spacing: 14
        Rectangle {
            Layout.alignment: Qt.AlignTop
            implicitWidth: 40; implicitHeight: 40; radius: 10
            color: captureConsent.intent === "resume" ? accentSoft : recordingSoft
            FtIcon { anchors.centerIn: parent; size: 20; name: captureConsent.intent === "resume" ? "automation-play" : "record"; tint: captureConsent.intent === "resume" ? accent : recordingColor }
        }
        Label {
            Layout.fillWidth: true
            // The consent facts only: who must know, what is recorded, and that closing does not stop it.
            text: captureConsent.intent === "resume"
                ? t("A gravação automática volta a valer para as próximas chamadas; nada começa agora. Avise as pessoas antes de gravar.") + "\n\n" + audioSummary()
                : (captureConsent.captureTitle ? tf("Reunião: %1", captureConsent.captureTitle) + "\n\n" : "") + t("Todos na conversa sabem que você vai gravar?") + "\n\n" + audioSummary() + "\n\n" + t("Fechar o Studio não para a gravação. Use Parar para terminar.")
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            color: ink
            Accessible.name: text
        }
    }
    footer: Item {
        implicitHeight: 64
        RowLayout {
            anchors.fill: parent; anchors.leftMargin: 20; anchors.rightMargin: 20
            spacing: 10
            Item { Layout.fillWidth: true }
            FtButton { id: captureConsentCancel; objectName: "captureConsentCancel"; text: t("Cancelar"); variant: "outline"; onClicked: captureConsent.reject() }
            FtButton { id: captureConsentAccept; objectName: "captureConsentAccept"; text: captureConsent.intent === "resume" ? t("Retomar automação") : t("Gravar"); variant: "primary"; iconName: captureConsent.intent === "resume" ? "automation-play" : "record"; onClicked: captureConsent.accept() }
        }
    }
    // Cancel keeps the initial focus: an accidental Enter never starts a capture.
    onOpened: { captureRequested = false; captureConsentCancel.forceActiveFocus(Qt.TabFocusReason) }
    // A test capture (liveView.testMode, which stops by itself after a minute) is armed only for the
    // capture this dialog starts: closed without starting one, the next capture is a real one again.
    // (Dialog emits accepted before closed.)
    property bool captureRequested: false
    onClosed: {
        if (intent !== "resume" && !captureRequested && !captureStatus.active) liveView.testMode = false
        captureTitle = ""; captureRequested = false
    }
    onAccepted: {
        if (backend.available && !captureBusy && (intent === "resume" || !captureStatus.active)) {
            captureBusy = true
            if (send(intent === "resume" ? "automation-resume" : "capture-start", "", intent === "resume" ? ({}) : {title: captureTitle}) < 0) captureBusy = false
            else if (intent !== "resume") captureRequested = true
        }
    }
}
