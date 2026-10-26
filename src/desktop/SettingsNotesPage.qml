import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Settings 10 · Notas e resumos: the notepad, how the notes are made (language, default template,
// detection, the fast path) and the templates you keep. The template list (templates-list,
// templates-delete) is sent only with features.templates and fails into this page's own state.
SettingsPage {
    id: notesPage
    objectName: "settingsNotes"
    property var templates: []
    property int problemCount: 0
    property bool loading: false
    property bool loaded: false
    property string error: ""
    property string notice: ""
    property string confirmDelete: ""
    property int pageGeneration: 0
    readonly property bool localDraft: settingsDraft["transcription.provider"] === "whisper-cpp" && settingsDraft["summary.provider"] === "ollama" && settingsLoopback(settingsDraft["summary.ollamaUrl"])
    readonly property var templateOptions: [{label: t("Automático: pelo título da agenda ou pela conversa"), value: "auto"}].concat(templates.map(function(item){ return {label: item.name, value: item.id} }))

    function reset() { pageGeneration += 1; templates = []; problemCount = 0; loading = false; loaded = false; error = ""; notice = ""; confirmDelete = "" }
    function load() {
        if (!feature("templates") || !backend.available || loading) return
        loading = true; error = ""
        if (send("templates-list", "", ({}), {origin: "settingsNotes", pageGeneration: pageGeneration}) < 0) { loading = false; error = t("Sem conexão com o FalaTrace.") }
    }
    function remove(item) {
        if (!backend.available || item.builtIn) return
        error = ""; notice = ""
        if (send("templates-delete", "", {id: item.id, expectedVersion: item.version}, {origin: "settingsNotes", pageGeneration: pageGeneration, templateName: item.name}) < 0) error = t("Sem conexão com o FalaTrace.")
    }
    function saved(template) { notice = tf("Modelo “%1” salvo.", template.name || ""); loading = false; load() }
    function handleResponse(request, message) {
        if (request.pageGeneration !== pageGeneration) return
        if (request.op === "templates-list") {
            loading = false
            if (!message.ok) { error = t("Não deu para carregar os modelos agora."); return }
            loaded = true
            templates = asList(message.result.templates).map(function(item){ return {id: item.id, name: item.name, description: item.description || "", builtIn: item.builtIn === true, version: item.version, sectionTitles: asList(item.sectionTitles), template: item.template || null} })
            problemCount = asList(message.result.problems).length
        } else if (request.op === "templates-delete") {
            confirmDelete = ""
            if (!message.ok) { error = t(message.error); return }
            notice = tf("Modelo “%1” excluído.", request.templateName || "")
            load()
        }
    }
    function connectionLost() { if (loading) error = t("Sem conexão com o FalaTrace."); loading = false; confirmDelete = ""; pageGeneration += 1 }

    SettingsSection { text: t("Durante a reunião") }
    SettingsCheck { objectName: "settingsNotesEnabled"; field: "notes.enabled"; text: t("Bloco de notas durante a gravação") }
    SettingsHint { text: t("Cada linha que você escreve guarda o momento em que foi escrita.") }

    SettingsSection { text: t("Notas geradas") }
    SettingsCheck { field: "summary.useNotes"; text: t("Usar minhas notas como base") }
    SettingsHint { text: t("Suas linhas aparecem como você escreveu; a IA completa o resto.") }
    SettingsChoice {
        field: "summary.language"; label: t("Idioma das notas")
        options: [{label: t("Igual ao da conversa"), value: "auto"}, {label: "Português (Brasil)", value: "pt-BR"}, {label: "English", value: "en"}, {label: "Español", value: "es"}]
    }
    SettingsChoice { objectName: "settingsDefaultTemplate"; field: "summary.template"; label: t("Modelo padrão"); options: notesPage.templateOptions }
    SettingsChoice {
        field: "summary.templateDetection"; label: t("Quando a agenda não diz o tipo")
        options: [{label: t("Deixar a IA escolher"), value: "ai"}, {label: t("Só por palavras-chave (senão, Geral)"), value: "keywords"}]
    }
    SettingsCheck {
        objectName: "settingsFastPath"; field: "processing.fastPath"
        text: t("Gerar as notas assim que a gravação parar")
        enabled: settingsEditable && (notesPage.localDraft || settingsDraft["processing.fastPath"] === true)
    }
    SettingsHint { text: notesPage.localDraft ? t("Só com processamento neste computador: nada sai daqui.") : t("Só com processamento neste computador. Hoje a transcrição ou o resumo vão para fora.") ; color: notesPage.localDraft ? muted : warningColor }
    FtButton { visible: !notesPage.localDraft; compact: true; variant: "outline"; text: t("Abrir Processamento e IA"); onClicked: settingsDialog.goToSection(2) }

    SettingsSection { visible: feature("templates"); text: t("Modelos") }
    RowLayout {
        visible: feature("templates")
        Layout.fillWidth: true
        spacing: 8
        SettingsHint { text: t("Um modelo diz quais seções as notas têm. Os embutidos não mudam; duplique um para ajustar.") }
        FtButton { objectName: "templateNew"; compact: true; variant: "outline"; iconName: "plus"; text: t("Novo modelo…"); enabled: backend.available && notesPage.loaded; onClicked: templateEditor.openNew() }
    }
    BusyIndicator { visible: notesPage.loading; running: visible; implicitWidth: 28; implicitHeight: 28 }
    Label { visible: !!notesPage.error; text: notesPage.error; textFormat: Text.PlainText; color: warningColor; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
    Label { objectName: "templatesNotice"; visible: !!notesPage.notice; text: notesPage.notice; textFormat: Text.PlainText; color: accent; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
    Label { visible: notesPage.problemCount > 0; text: tf("%1 arquivo(s) de modelo com erro ficaram de fora. Corrija ou apague o arquivo na pasta templates.", notesPage.problemCount); textFormat: Text.PlainText; color: warningColor; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
    Repeater {
        model: feature("templates") ? notesPage.templates : []
        delegate: Rectangle {
            id: templateRow
            required property var modelData
            objectName: "templateRow-" + modelData.id
            Layout.fillWidth: true
            implicitHeight: templateColumn.implicitHeight + 16
            radius: 10; color: surfaceAlt; border.width: 1; border.color: divider
            ColumnLayout {
                id: templateColumn
                anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                anchors.leftMargin: 12; anchors.rightMargin: 8
                spacing: 4
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8
                    FtIcon { name: "template"; tint: templateRow.modelData.builtIn ? muted : accent; size: 16 }
                    Label { text: templateRow.modelData.name; textFormat: Text.PlainText; color: ink; font.weight: Font.DemiBold; elide: Text.ElideRight; Layout.fillWidth: true }
                    FtChip { visible: templateRow.modelData.builtIn; text: t("Embutido") }
                    FtChip { visible: settingsDraft["summary.template"] === templateRow.modelData.id; kind: "accent"; text: t("Padrão") }
                    FtButton { compact: true; variant: "ghost"; iconName: "copy"; iconOnly: compactLayout; text: t("Duplicar"); Accessible.name: tf("Duplicar o modelo %1", templateRow.modelData.name); enabled: backend.available && !!templateRow.modelData.template; onClicked: templateEditor.openCopy(templateRow.modelData) }
                    FtButton { visible: !templateRow.modelData.builtIn; compact: true; variant: "ghost"; iconName: "edit"; iconOnly: compactLayout; text: t("Editar"); Accessible.name: tf("Editar o modelo %1", templateRow.modelData.name); enabled: backend.available && !!templateRow.modelData.template; onClicked: templateEditor.openEdit(templateRow.modelData) }
                    FtButton { visible: !templateRow.modelData.builtIn; compact: true; variant: "ghost"; iconName: "trash"; iconOnly: true; text: t("Excluir"); Accessible.name: tf("Excluir o modelo %1", templateRow.modelData.name); enabled: backend.available; onClicked: notesPage.confirmDelete = templateRow.modelData.id }
                }
                Label { visible: text !== ""; text: templateRow.modelData.sectionTitles.join(" · "); textFormat: Text.PlainText; color: aiInk; font.pixelSize: 12; elide: Text.ElideRight; Layout.fillWidth: true }
                RowLayout {
                    visible: notesPage.confirmDelete === templateRow.modelData.id
                    Layout.fillWidth: true
                    spacing: 8
                    SettingsHint { color: warningColor; text: tf("Excluir “%1”? Não dá para desfazer.", templateRow.modelData.name) }
                    FtButton { compact: true; variant: "outline"; text: t("Cancelar"); onClicked: notesPage.confirmDelete = "" }
                    FtButton { objectName: "templateDeleteConfirm"; compact: true; variant: "danger"; text: t("Excluir"); enabled: backend.available && !hasPending("templates-delete"); onClicked: notesPage.remove(templateRow.modelData) }
                }
            }
        }
    }
}
