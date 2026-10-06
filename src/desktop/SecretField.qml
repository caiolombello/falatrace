import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Write-only credential entry. The value goes straight to the bridge and the field is
// cleared; the Studio only ever shows where a key comes from, never the key.
ColumnLayout {
    id:secretControl
    property string name: ""
    property string label: ""
    property string testService: ""
    property string purpose: ""
    readonly property var report: ((settingsData.credentials && settingsData.credentials.details) || []).find(function(detail){ return detail.name === secretControl.name }) || ({})
    readonly property var testResult: settingsDialog.keyTests[secretControl.testService] || null
    Layout.fillWidth:true; spacing:6
    RowLayout {
        Layout.fillWidth:true; spacing:8
        Label { text:secretControl.label; color:ink; font.pixelSize:14; font.weight:Font.DemiBold; Layout.fillWidth:true; wrapMode:Text.WordWrap }
        FtChip {
            text:secretControl.report.source && secretControl.report.source !== "missing" ? t("Configurada") : t("Sem chave")
            kind:secretControl.report.source && secretControl.report.source !== "missing" ? "accent" : "neutral"
            iconName:secretControl.report.source && secretControl.report.source !== "missing" ? "check" : ""
        }
    }
    SettingsHint { visible:!!secretControl.purpose; text:secretControl.purpose }
    SettingsHint { text:settingsDialog.secretSourceText(secretControl.report) }
    RowLayout {
        Layout.fillWidth:true; spacing:8
        FtTextField {
            id:secretInput
            objectName:"secretInput_" + secretControl.name
            Layout.fillWidth:true; maximumLength:4096
            echoMode:TextInput.Password; passwordCharacter:"•"
            placeholderText:secretControl.report.savedInStudio ? t("Cole uma nova chave para substituir a salva") : t("Cole a chave aqui")
            enabled:backend.available && !settingsDialog.secretBusy
            inputMethodHints:Qt.ImhSensitiveData | Qt.ImhNoPredictiveText | Qt.ImhNoAutoUppercase
            Accessible.name:secretControl.label
            Keys.onReturnPressed:saveButton.clicked()
        }
        FtButton {
            id:saveButton
            text:t("Salvar chave"); compact:true
            enabled:backend.available && !settingsDialog.secretBusy && secretInput.text.trim().length > 0
            onClicked:{ settingsDialog.saveSecret(secretControl.name, secretInput.text); secretInput.text = "" }
        }
    }
    Flow {
        Layout.fillWidth:true; spacing:8
        FtButton {
            visible:!!secretControl.testService
            text:settingsDialog.keyTestPending === secretControl.testService ? t("Testando…") : t("Testar chave")
            variant:"outline"; compact:true
            enabled:backend.available && !settingsDialog.secretBusy && !settingsDialog.keyTestPending && !!secretControl.report.source && secretControl.report.source !== "missing"
            onClicked:settingsDialog.testSecret(secretControl.testService)
        }
        FtButton {
            visible:!!secretControl.report.savedInStudio
            text:t("Remover a chave salva"); variant:"outline"; compact:true
            enabled:backend.available && !settingsDialog.secretBusy
            onClicked:settingsDialog.removeSecret(secretControl.name)
        }
    }
    SettingsHint {
        visible:!!secretControl.testService
        text:t("O teste pede ao provedor só a lista de modelos: nenhum áudio ou texto é enviado.")
    }
    Label {
        visible:!!secretControl.testResult
        text:secretControl.testResult ? t(secretControl.testResult.detail) : ""
        color:secretControl.testResult && secretControl.testResult.status === "ok" ? accent : warningColor
        textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true; font.pixelSize:12
    }
}
