import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Settings 13 · Transcrição ao vivo: whether every capture shows what is being said, and where that
// audio goes (three choices with cost, delay and destination), the light model for this computer,
// and the advanced knobs.
SettingsPage {
    id: livePage
    objectName: "settingsLive"
    // The Whisper model the live transcript reads, when it is one of the catalog's files.
    readonly property var liveModel: {
        const models = settingsDialog.catalog.whisper ? asList(settingsDialog.catalog.whisper.models) : []
        return models.find(function(model){ return model.path === settingsDraft["live.whisperModelPath"] }) || null
    }
    readonly property var liveDownload: liveModel ? settingsDialog.downloads[settingsDialog.downloadKey("whisper", liveModel.id)] : null

    SettingsCheck { objectName: "settingsLiveEnabled"; field: "live.enabled"; text: t("Transcrição ao vivo em toda gravação") }
    SettingsHint { text: t("Mostra o que está sendo dito enquanto você grava. A transcrição final é feita depois, com mais qualidade.") }

    SettingsSection { text: t("Onde transcrever ao vivo") }
    SettingsRadioCard {
        objectName: "liveWhisper"; field: "live.provider"; value: "whisper-cpp"; iconName: "lock"
        heading: t("Neste computador (Whisper)")
        detail: t("Grátis, usa a CPU. ≈ 20 s de atraso. O áudio não sai daqui.")
        SettingsText { field: "live.whisperModelPath"; label: t("Modelo leve (ggml)"); picker: "file"; placeholder: "/home/voce/.local/share/recording-cli/models/ggml-base.bin" }
        RowLayout {
            visible: !!livePage.liveModel && !livePage.liveModel.installed
            Layout.fillWidth: true
            spacing: 8
            FtButton {
                objectName: "liveModelDownload"
                visible: !(livePage.liveDownload && livePage.liveDownload.state === "running")
                compact: true; variant: "outline"
                text: livePage.liveModel ? tf("Baixar este modelo (%1)", settingsDialog.mib(livePage.liveModel.bytes)) : ""
                enabled: backend.available
                onClicked: settingsDialog.confirmDownload = settingsDialog.downloadKey("whisper", livePage.liveModel.id)
            }
            Label {
                Layout.fillWidth: true
                text: !livePage.liveDownload ? t("O arquivo ainda não foi baixado.") : livePage.liveDownload.state === "running" ? settingsDialog.downloadProgress(livePage.liveDownload) : livePage.liveDownload.state === "failed" ? (t(livePage.liveDownload.error) || t("O download falhou.")) : t("Baixado e conferido.")
                textFormat: Text.PlainText; color: muted; font.pixelSize: 12; wrapMode: Text.WordWrap
            }
        }
        ColumnLayout {
            visible: !!livePage.liveModel && settingsDialog.confirmDownload === settingsDialog.downloadKey("whisper", livePage.liveModel.id)
            Layout.fillWidth: true
            spacing: 6
            SettingsHint { color: warningColor; text: livePage.liveModel ? t("Baixar ") + settingsDialog.mib(livePage.liveModel.bytes) + t(" de huggingface.co para a pasta de modelos? Nenhum dado seu é enviado; o download continua mesmo se você fechar o Studio.") : "" }
            RowLayout {
                spacing: 8
                FtButton { text: t("Baixar agora"); compact: true; highlighted: true; onClicked: settingsDialog.startDownload("whisper", livePage.liveModel.id) }
                FtButton { text: t("Cancelar"); compact: true; variant: "outline"; onClicked: settingsDialog.confirmDownload = "" }
            }
        }
        SettingsNumber { field: "live.whisperThreads"; label: t("Threads do Whisper.cpp"); from: 1; to: 64 }
    }
    SettingsRadioCard {
        objectName: "liveGroq"; field: "live.provider"; value: "groq"; iconName: "cloud"
        heading: "Groq"
        detail: t("US$ 0,04 por hora de gravação. ≈ 16 s de atraso. O áudio vai para a Groq durante a reunião.")
        SecretField { name: "GROQ_API_KEY"; label: t("Chave da Groq"); testService: "groq" }
    }
    SettingsRadioCard {
        objectName: "liveOpenai"; field: "live.provider"; value: "openai"; iconName: "cloud"
        heading: "OpenAI"
        detail: t("US$ 0,27 por hora de gravação. 20–35 s de atraso. O áudio vai para a OpenAI durante a reunião.")
        SecretField { name: "OPENAI_API_KEY"; label: t("Chave da OpenAI"); testService: "openai" }
    }
    SettingsHint { text: t("Preços conferidos em 25/10/2026. Com a opção ligada e um provedor fora deste computador, o áudio de toda gravação vai para ele enquanto você grava.") }

    SettingsSection { text: t("Avançado") }
    SettingsNumber { field: "live.chunkSeconds"; label: t("Enviar o áudio em trechos de (segundos)"); from: 5; to: 60 }
    SettingsText { field: "live.openaiModel"; label: t("Modelo da OpenAI") }
    SettingsText { field: "live.groqModel"; label: t("Modelo da Groq") }
}
