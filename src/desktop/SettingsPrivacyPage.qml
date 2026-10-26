import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Settings 15 · Privacidade e retenção: what happens to the recorded media once the transcript is
// verified. Each choice says plainly what stops working, so nobody loses the video by surprise.
SettingsPage {
    id: privacyPage
    objectName: "settingsPrivacy"
    readonly property string savedRetention: String((settingsData.values || {})["media.retention"] || "keep")
    readonly property bool retentionChanged: settingsDraft["media.retention"] !== undefined && settingsDraft["media.retention"] !== savedRetention

    SettingsSection { text: t("Guardar a mídia") }
    SettingsRadioCard {
        objectName: "retentionKeep"; field: "media.retention"; value: "keep"; iconName: "video"
        heading: t("Guardar tudo")
        detail: t("Vídeo, áudio e transcrição ficam neste computador. Dá para assistir e ouvir quando quiser.")
    }
    SettingsRadioCard {
        objectName: "retentionAudio"; field: "media.retention"; value: "audio-only"; iconName: "wave"
        heading: t("Só o áudio")
        detail: t("O vídeo é apagado: não dá mais para assistir às gravações. Ouvir, identificar falantes e refazer a transcrição continuam.")
    }
    SettingsRadioCard {
        objectName: "retentionText"; field: "media.retention"; value: "transcript-only"; iconName: "transcript"
        heading: t("Só o texto")
        detail: t("Vídeo e áudio são apagados: não dá mais para assistir nem ouvir, identificar falantes de novo ou refazer a transcrição. Notas, perguntas e envio continuam.")
    }
    Label {
        objectName: "retentionWarning"
        visible: privacyPage.retentionChanged && settingsDraft["media.retention"] !== "keep"
        Layout.fillWidth: true
        text: settingsDraft["media.retention"] === "audio-only"
            ? tf("Depois de salvar, o processamento em segundo plano apaga o vídeo das gravações já transcritas (após a identificação de falantes, ou %1 dia(s) depois do processamento). Elas não poderão mais ser assistidas. Sem volta.", Number(settingsDraft["media.graceDays"]) || 0)
            : tf("Depois de salvar, o processamento em segundo plano apaga o vídeo e o áudio das gravações já transcritas (após a identificação de falantes, ou %1 dia(s) depois do processamento). Elas não poderão mais ser assistidas nem ouvidas. Sem volta.", Number(settingsDraft["media.graceDays"]) || 0)
        textFormat: Text.PlainText; color: warningColor; font.pixelSize: 13; wrapMode: Text.WordWrap
    }
    SettingsNumber { field: "media.graceDays"; label: t("Esperar antes de apagar (dias)"); from: 0; to: 3650 }
    SettingsHint { text: t("Conta a partir do processamento, se a identificação de falantes ainda não terminou. Uma gravação ou chamada em andamento adia a limpeza.") }
    SettingsHint { text: t("Cópias no Proton Drive e no outro computador não são apagadas por aqui. Cada reunião também tem “Remover mídia agora…”.") }

    SettingsSection { text: t("Rotas e privacidade") }
    SettingsHint { text: settingsHasChanges() ? t("Salve ou descarte as alterações antes de abrir o resumo de rotas e privacidade.") : t("Mostra para onde vai cada etapa e permite escolher o processamento local com um clique.") }
    FtButton { text: t("Rotas e privacidade…"); iconName: "shield"; variant: "outline"; enabled: backend.available && !settingsHasChanges(); onClicked: onboardingDialog.open() }
}
