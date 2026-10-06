import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

FtDialog {
    id: aboutDialog; objectName: "aboutDialog"; title: t("Sobre o FalaTrace")
    anchors.centerIn: parent; width: Math.min(520, window.width - 32); modal: true
    closePolicy: Popup.CloseOnEscape
    onOpened: aboutClose.forceActiveFocus(Qt.TabFocusReason)
    onClosed: aboutButton.forceActiveFocus(Qt.TabFocusReason)
    contentItem: ColumnLayout { spacing: 12
        RowLayout {
            Layout.fillWidth: true; spacing: 14
            BrandMark { size: 44 }
            ColumnLayout {
                Layout.fillWidth: true; spacing: 2
                Label { text: "FalaTrace Studio"; color: ink; font.pixelSize: 17; font.weight: Font.DemiBold }
                Label { text: t("Gravações e contexto com origem para Linux · experimental"); color: muted; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
            }
        }
        Rectangle { Layout.fillWidth: true; Layout.preferredHeight: 1; color: divider }
        Label { objectName:"aboutVersion"; text: t("Studio em execução: ") + Qt.application.version; color: ink; Layout.fillWidth:true; wrapMode:Text.WordWrap }
        Label { text: t("Build local: ") + studioBuildId; color: muted; Layout.fillWidth:true; wrapMode:Text.WordWrap }
        Label { objectName:"aboutRelease"; text: t("Release instalada: ") + (releaseInfo.name ? releaseInfo.name + t(" · commit ") + releaseInfo.commit : backend.available && cliVersion ? t("não identificada (execução pelo código-fonte)") : t("indisponível")); color: muted; Layout.fillWidth:true; wrapMode:Text.WordWrap }
        Label { text: t("CLI conectado: ") + (backend.available && cliVersion ? cliVersion : t("indisponível")); color: muted; Layout.fillWidth:true; wrapMode:Text.WordWrap }
        Label { text: cliVersion && cliVersion !== Qt.application.version ? t("Studio e CLI têm versões diferentes. Feche e reabra o Studio após atualizar.") : t("Versão publicada: não consultada. Esta tela não verifica atualizações pela rede."); color: cliVersion && cliVersion !== Qt.application.version ? warningColor : muted; Layout.fillWidth:true; wrapMode:Text.WordWrap }
        Label { text: t("No terminal: falatrace --version"); color: ink; Layout.fillWidth:true; wrapMode:Text.WordWrap }
    }
    footer: Item { implicitHeight: 64; FtButton { id:aboutClose; text:t("Fechar"); anchors.right: parent.right; anchors.rightMargin: 20; anchors.verticalCenter: parent.verticalCenter; onClicked:aboutDialog.close() } }
}
