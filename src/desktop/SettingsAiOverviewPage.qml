import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Settings 16 · Visão geral da IA: every place FalaTrace uses AI, who does it, and whether it leaves
// this computer, with a way to each page that changes it. Reads the draft only; it saves nothing.
SettingsPage {
    id: aiOverview
    objectName: "settingsAiOverview"

    function loopback(url) { return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(String(url || "")) }
    function presetLabel(value) {
        const option = settingsDialog.assistantPage.presetOptions.find(function(entry){ return entry.value === value })
        return option ? option.label : String(value || "")
    }
    function toolLabel(value) {
        const option = settingsDialog.assistantPage.subscriptionOptions.find(function(entry){ return entry.tool === value })
        return option ? option.label : String(value || "")
    }
    function agentLabel(value) {
        const option = settingsDialog.assistantPage.acpAgents.find(function(entry){ return entry.value === value })
        return option ? option.label : String(value || "")
    }
    readonly property bool remoteWorker: settingsDraft["processing.defaultTarget"] === "remote"
    // A key the chosen provider needs and that no source has (Chaves de API lists where each one comes from).
    function keyMissing(name) {
        if (!name) return false
        const entry = asList(settingsData.credentials && settingsData.credentials.details).find(function(detail){ return detail.name === name })
        return !!entry && (!entry.source || entry.source === "missing")
    }
    // One row per use of AI: what it does, who does it now, whether that stays here, and where to change it.
    readonly property var rows: {
        const d = settingsDraft
        const transcription = d["transcription.provider"]
        const summary = d["summary.provider"]
        const assistant = d["assistant.provider"]
        const live = d["live.provider"]
        const list = []
        list.push({key: "transcription", icon: "transcript", title: t("Transcrição das gravações"), section: 2,
                   who: transcription === "whisper-cpp" ? t("Whisper.cpp") : transcription === "gemini" ? "Gemini" : "OpenAI",
                   local: transcription === "whisper-cpp" && !remoteWorker,
                   apiKey: transcription === "openai" ? "OPENAI_API_KEY" : transcription === "gemini" ? "GEMINI_API_KEY" : ""})
        list.push({key: "summary", icon: "note", title: t("Notas e resumos"), section: 2,
                   who: summary === "ollama" ? "Ollama" + (d["summary.ollamaModel"] ? " · " + d["summary.ollamaModel"] : "") : "OpenAI" + (d["summary.openaiModel"] ? " · " + d["summary.openaiModel"] : ""),
                   local: summary === "ollama" && loopback(d["summary.ollamaUrl"]) && !ollamaCloudModel(d["summary.ollamaModel"]) && !remoteWorker,
                   apiKey: summary === "openai" ? "OPENAI_API_KEY" : ""})
        list.push({key: "assistant", icon: "chat", title: t("Perguntar às reuniões"), section: 11,
                   who: assistant === "local" ? "Ollama" + (d["assistant.localModel"] ? " · " + d["assistant.localModel"] : "")
                      : assistant === "chatgpt" ? t("ChatGPT, pela sua conta")
                      : assistant === "cli" ? tf("%1, pela linha de comando", toolLabel(d["assistant.cliTool"]))
                      : assistant === "acp" ? tf("Agente ACP · %1", agentLabel(d["assistant.acpAgent"]))
                      : tf("API · %1", presetLabel(d["assistant.apiPreset"])),
                   local: assistant === "local" && !ollamaCloudModel(d["assistant.localModel"]),
                   apiKey: assistant === "api" ? (settingsDialog.assistantPage.presetKeys[d["assistant.apiPreset"]] || "") : ""})
        list.push({key: "live", icon: "wave", title: t("Transcrição ao vivo"), section: 13,
                   who: d["live.enabled"] !== true ? t("Desligada") : live === "whisper-cpp" ? t("Whisper.cpp") : live === "groq" ? "Groq" : "OpenAI",
                   local: d["live.enabled"] !== true || live === "whisper-cpp", off: d["live.enabled"] !== true,
                   apiKey: d["live.enabled"] === true && live === "groq" ? "GROQ_API_KEY" : d["live.enabled"] === true && live === "openai" ? "OPENAI_API_KEY" : ""})
        return list
    }
    readonly property int savedKeys: asList(settingsData.credentials && settingsData.credentials.details).filter(function(entry){ return entry.source && entry.source !== "missing" }).length

    SettingsHint { text: t("Onde o FalaTrace usa IA, quem faz cada parte e o que sai deste computador. Nada aqui é salvo: abra a página de cada item para mudar.") }
    Rectangle {
        objectName: "aiOverviewRemote"
        visible: aiOverview.remoteWorker
        Layout.fillWidth: true
        implicitHeight: remoteLabel.implicitHeight + 16
        radius: 8; color: accentSoft
        Label { id: remoteLabel; anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; anchors.margins: 10; text: t("A transcrição e o resumo rodam no worker remoto configurado em Integrações, não neste computador."); textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: ink; font.pixelSize: 13 }
    }
    Repeater {
        model: aiOverview.rows
        delegate: Rectangle {
            id: useRow
            required property var modelData
            objectName: "aiOverview-" + modelData.key
            Layout.fillWidth: true
            implicitHeight: useLayout.implicitHeight + 20
            radius: 10; color: surfaceAlt; border.width: 1; border.color: divider
            RowLayout {
                id: useLayout
                anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                anchors.leftMargin: 12; anchors.rightMargin: 10
                spacing: 12
                FtIcon { name: useRow.modelData.icon; tint: accent; size: 18; Layout.alignment: Qt.AlignTop; Layout.topMargin: 2 }
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 2
                    Label { text: useRow.modelData.title; textFormat: Text.PlainText; color: ink; font.weight: Font.DemiBold; Layout.fillWidth: true; elide: Text.ElideRight }
                    Label { text: useRow.modelData.who; textFormat: Text.PlainText; color: muted; font.pixelSize: 13; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                }
                FtChip {
                    objectName: "aiOverviewKeyMissing-" + useRow.modelData.key
                    visible: aiOverview.keyMissing(useRow.modelData.apiKey || "")
                    Layout.alignment: Qt.AlignVCenter
                    iconName: "key"; kind: "danger"
                    text: t("Falta a chave")
                    HoverHandler { id: keyHover }
                    ToolTip.visible: keyHover.hovered; ToolTip.text: tf("%1 não foi encontrada. Salve-a em Chaves de API.", useRow.modelData.apiKey || ""); ToolTip.delay: 300
                }
                FtChip {
                    visible: !useRow.modelData.off
                    Layout.alignment: Qt.AlignVCenter
                    iconName: useRow.modelData.local ? "lock" : "cloud"
                    kind: useRow.modelData.local ? "accent" : "warning"
                    text: useRow.modelData.local ? t("Neste computador") : t("Sai deste computador")
                }
                FtButton { compact: true; variant: "ghost"; iconName: "chevron-right"; text: t("Abrir"); Accessible.name: tf("Abrir as configurações de %1", useRow.modelData.title); onClicked: settingsDialog.goToSection(useRow.modelData.section) }
            }
        }
    }
    SettingsSection { text: t("Contas e modelos") }
    RowLayout {
        Layout.fillWidth: true
        spacing: 8
        Label { Layout.fillWidth: true; text: aiOverview.savedKeys === 1 ? t("1 chave de API salva.") : tf("%1 chaves de API salvas.", aiOverview.savedKeys); textFormat: Text.PlainText; color: muted; font.pixelSize: 13; wrapMode: Text.WordWrap }
        FtButton { objectName: "aiOverviewKeys"; compact: true; variant: "outline"; iconName: "key"; text: t("Chaves de API"); onClicked: settingsDialog.goToSection(3) }
    }
    RowLayout {
        Layout.fillWidth: true
        spacing: 8
        Label { Layout.fillWidth: true; text: t("Modelos que rodam neste computador: Whisper para transcrever, Ollama para notas e perguntas, e o reconhecimento de voz."); textFormat: Text.PlainText; color: muted; font.pixelSize: 13; wrapMode: Text.WordWrap }
        FtButton { objectName: "aiOverviewModels"; compact: true; variant: "outline"; iconName: "transcript"; text: t("Modelos locais"); onClicked: settingsDialog.goToSection(4) }
    }
}
