import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

FtDialog {
    id: captureConsent
    property string intent: "capture"
    objectName: "captureConsent"
    title: intent === "resume" ? t("Retomar gravações automáticas") : t("Antes de iniciar a gravação")
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
            text: (captureConsent.intent === "resume" ? t("As regras já configuradas poderão iniciar novas gravações. Esta ação não inicia uma captura manual. ") : "") + t("Confirme a permissão das pessoas envolvidas. A captura usa a tela e as fontes de áudio configuradas. Revise o áudio antes de continuar.\n\n") + audioSummary() + t("\n\nFechar o Studio não encerra a captura. Use Parar para finalizá-la. O processamento usa os providers configurados; serviços externos podem receber conteúdo.")
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
            FtButton { id: captureConsentAccept; objectName: "captureConsentAccept"; text: captureConsent.intent === "resume" ? t("Retomar automação") : t("Iniciar gravação"); variant: "primary"; iconName: captureConsent.intent === "resume" ? "automation-play" : "record"; onClicked: captureConsent.accept() }
        }
    }
    // Cancel keeps the initial focus: an accidental Enter never starts a capture.
    onOpened: captureConsentCancel.forceActiveFocus(Qt.TabFocusReason)
    onAccepted: {
        if (backend.available && !captureBusy && (intent === "resume" || !captureStatus.active)) {
            captureBusy = true
            if (send(intent === "resume" ? "automation-resume" : "capture-start", "", intent === "resume" ? ({}) : {title: ""}) < 0) captureBusy = false
        }
    }
}
