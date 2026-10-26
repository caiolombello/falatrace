import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Generating the notes with a destination outside this computer (DESIGN-STUDIO §2.7): one sentence
// says where the transcript (and your notes) go, a box gives consent for exactly this plan, and the
// request limit is behind "Detalhes" (a new limit plans again). A destination on this computer never
// opens this dialog: the click on Gerar in the regenerate bar is the consent.
FtDialog {
    id: summaryDialog
    objectName: "summaryDialog"
    title: regenerateTemplateName() ? tf("Gerar as notas com “%1”", regenerateTemplateName()) : t("Gerar as notas de novo")
    property alias summaryBudget: summaryBudget
    property alias summaryConsent: summaryConsent
    property bool detailsOpen: false
    anchors.centerIn: parent
    width: Math.min(560, window.width - 48)
    modal: true
    closePolicy: Popup.CloseOnEscape
    onOpened: { detailsOpen = false; summaryBudget.value = summaryMaxRequests; summaryCancelButton.forceActiveFocus(Qt.TabFocusReason) }
    // Closed without generating (Cancelar, Esc): nothing runs and the plan is released.
    onClosed: { if (summaryStage === "consent" || summaryStage === "planning") cancelRegenerate(); if (summaryRegenerateButton.visible) summaryRegenerateButton.forceActiveFocus(Qt.TabFocusReason) }
    contentItem: ColumnLayout {
        spacing: 12
        RowLayout {
            Layout.fillWidth: true
            spacing: 12
            Rectangle {
                Layout.alignment: Qt.AlignTop
                implicitWidth: 36; implicitHeight: 36; radius: 10
                color: warningSoft
                FtIcon { anchors.centerIn: parent; name: "cloud"; tint: warningColor; size: 18 }
            }
            ColumnLayout {
                Layout.fillWidth: true
                spacing: 6
                Label { objectName: "summaryPlanInfo"; text: summaryPlan.requestId ? summaryPlanText() : t("Preparando…"); textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: ink; font.pixelSize: 15; Layout.fillWidth: true }
                Label { text: t("As notas da IA serão reescritas; as suas ficam."); textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: muted; font.pixelSize: 13; Layout.fillWidth: true }
            }
        }
        WrappedCheck {
            id: summaryConsent
            objectName: "summaryConsent"
            enabled: !!summaryPlan.requestId && !summaryBusy()
            text: summaryPlan.destination ? tf("Enviar para %1 (fora deste computador)", t(summaryPlan.destination.where || "")) : t("Enviar para fora deste computador")
            Accessible.name: text
        }
        FtButton {
            objectName: "summaryDetailsToggle"
            compact: true; variant: "ghost"
            iconName: summaryDialog.detailsOpen ? "chevron-down" : "chevron-right"
            text: t("Detalhes")
            Accessible.name: text + (summaryDialog.detailsOpen ? t(", aberto") : t(", fechado"))
            onClicked: summaryDialog.detailsOpen = !summaryDialog.detailsOpen
        }
        ColumnLayout {
            visible: summaryDialog.detailsOpen
            Layout.fillWidth: true
            Layout.leftMargin: 10
            spacing: 8
            Label { text: summaryDetailsText(); visible: text !== ""; textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: muted; font.pixelSize: 13; Layout.fillWidth: true }
            RowLayout {
                Layout.fillWidth: true
                spacing: 8
                Label { text: t("Máximo de chamadas ao modelo"); color: ink; font.pixelSize: 13; Layout.fillWidth: true; wrapMode: Text.WordWrap }
                SpinBox { id: summaryBudget; objectName: "summaryBudget"; from: 1; to: 8; value: 8; editable: false; enabled: !summaryBusy(); Accessible.name: t("Máximo de chamadas ao modelo") }
                FtButton { compact: true; variant: "outline"; text: t("Aplicar"); enabled: backend.available && !summaryBusy() && summaryBudget.value !== summaryMaxRequests; onClicked: { summaryMaxRequests = summaryBudget.value; prepareSummary() } }
            }
            Label { text: t("Um limite novo prepara outro plano; nada é enviado antes de você confirmar."); textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: muted; font.pixelSize: 12; Layout.fillWidth: true }
        }
        Label { objectName: "summaryError"; visible: !!summaryError; text: t(summaryError); textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: errorColor; Layout.fillWidth: true }
    }
    footer: Item {
        implicitHeight: 64
        RowLayout {
            anchors.fill: parent; anchors.leftMargin: 20; anchors.rightMargin: 20
            spacing: 10
            Item { Layout.fillWidth: true }
            FtButton { id: summaryCancelButton; objectName: "summaryCancelButton"; variant: "outline"; text: t("Cancelar"); onClicked: summaryDialog.close() }
            FtButton { id: summaryRunButton; objectName: "summaryRunButton"; variant: "primary"; iconName: "send"; text: t("Enviar e gerar"); enabled: backend.available && !!summaryPlan.requestId && summaryConsent.checked && !summaryBusy(); onClicked: generateSummary() }
        }
    }
}
