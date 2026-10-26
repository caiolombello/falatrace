import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Your own notes template (Configurações › Notas e resumos): a name, one line on when to use it, the
// sections (3 to 8, each with a title and what the AI should write there; Alt+↑/↓ reorders) and
// words of the calendar title that pick it. A new template or a copy starts as "custom:<name>";
// saving goes through templates-save with the version it was loaded at. Failures stay here.
FtDialog {
    id: templateEditor
    objectName: "templateEditor"
    property string mode: "new"
    property var source: null
    property var sections: []
    property int revision: 0
    property bool nameEdited: false
    property bool saving: false
    property string error: ""
    property int editorGeneration: 0
    // The button that opened the editor gets the focus back when it closes (when it is still there).
    property Item opener: null
    readonly property string language: uiLanguage === "en" ? "en" : "pt-BR"
    readonly property var problem: { revision; return validation() }
    title: mode === "edit" ? t("Editar modelo") : t("Novo modelo")
    anchors.centerIn: parent
    width: Math.min(700, window.width - 48)
    height: Math.min(window.height - 48, 760)
    modal: true
    closePolicy: saving ? Popup.NoAutoClose : Popup.CloseOnEscape

    function fold(text) {
        let value = String(text || "")
        if (typeof value.normalize === "function") value = value.normalize("NFD").replace(/[̀-ͯ]/g, "")
        return value.toLowerCase().replace(/\s+/g, " ").trim()
    }
    function slug(text) { return fold(text).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "modelo" }
    function localizedText(value) { return value && typeof value === "object" ? (value[language] || value["pt-BR"] || "") : String(value || "") }
    function begin(newMode, template) {
        editorGeneration += 1; mode = newMode; source = template; error = ""; saving = false; nameEdited = newMode !== "edit"
        const copySuffix = t(" (cópia)")
        nameField.text = template ? localizedText(template.name) + (newMode === "copy" ? copySuffix : "") : ""
        descriptionField.text = template ? String(template.description || "") : ""
        keywordsField.text = template && newMode === "edit" ? (template.titleKeywords || []).join(", ") : ""
        sections = template ? asList(template.sections).map(function(section){ return {id: section.id, title: localizedText(section.title), titles: section.title, instruction: section.instruction || "", edited: false} })
            : [{id: "section-1", title: "", titles: null, instruction: "", edited: true}, {id: "section-2", title: "", titles: null, instruction: "", edited: true}, {id: "section-3", title: "", titles: null, instruction: "", edited: true}]
        revision += 1
        opener = window.activeFocusItem
        open()
    }
    function openNew() { begin("new", null) }
    function openCopy(item) { if (item && item.template) begin("copy", item.template) }
    function openEdit(item) { if (item && item.template) begin("edit", item.template) }
    function touched() { revision += 1 }
    function freeSectionId() { let index = sections.length + 1; while (sections.some(function(section){ return section.id === "section-" + index })) index += 1; return "section-" + index }
    function addSection() { if (sections.length >= 8) return; sections = sections.concat([{id: freeSectionId(), title: "", titles: null, instruction: "", edited: true}]); touched() }
    function removeSection(index) { if (sections.length <= 3) return; const next = sections.slice(); next.splice(index, 1); sections = next; touched() }
    function moveSection(index, delta) {
        const target = index + delta
        if (target < 0 || target >= sections.length) return
        const next = sections.slice(); const item = next.splice(index, 1)[0]; next.splice(target, 0, item); sections = next; touched()
        Qt.callLater(function(){ const field = sectionRepeater.itemAt(target); if (field) field.focusTitle() })
    }
    function keywords() {
        const seen = []
        for (const part of keywordsField.text.split(",")) {
            const value = fold(part)
            if (value && /[a-z0-9]/.test(value) && seen.indexOf(value) < 0) seen.push(value)
        }
        return seen.slice(0, 40)
    }
    function validation() {
        if (!nameField.text.trim() || nameField.text.trim().length > 80) return t("Dê um nome de até 80 caracteres.")
        if (!descriptionField.text.trim() || descriptionField.text.length > 300) return t("Escreva em uma linha quando usar este modelo.")
        if (sections.length < 3 || sections.length > 8) return t("Use de 3 a 8 seções.")
        const titles = []
        for (const section of sections) {
            if (!section.title.trim() || section.title.length > 80 || !section.instruction.trim() || section.instruction.length > 600) return t("Cada seção precisa de um título e do que a IA deve escrever nela.")
            const folded = fold(section.title)
            if (titles.indexOf(folded) >= 0) return t("Duas seções têm o mesmo título.")
            titles.push(folded)
        }
        return ""
    }
    function localized(text, original, edited) {
        const value = text.trim()
        if (!edited && original && typeof original === "object") return {"pt-BR": original["pt-BR"], en: original.en, es: original.es}
        return {"pt-BR": value, en: value, es: value}
    }
    function templateId() {
        if (mode === "edit" && source) return source.id
        const taken = settingsDialog.notesPage.templates.map(function(item){ return item.id })
        const base = "custom:" + slug(nameField.text)
        let id = base, index = 2
        while (taken.indexOf(id) >= 0) { id = base + "-" + index; index += 1 }
        return id
    }
    function save() {
        if (saving || problem || !backend.available) return
        const name = nameField.text.trim()
        const template = {
            id: templateId(), version: mode === "edit" && source ? source.version : 1, builtIn: false,
            name: mode === "edit" ? localized(name, source.name, nameEdited) : {"pt-BR": name, en: name, es: name},
            description: descriptionField.text.trim(),
            titleKeywords: keywords(),
            transcriptKeywords: source && mode !== "new" ? asList(source.transcriptKeywords) : [],
            sections: sections.map(function(section){ return {id: section.id, title: localized(section.title, section.titles, section.edited), instruction: section.instruction.trim()} }),
            guidance: source && mode !== "new" ? String(source.guidance || "") : ""
        }
        const payload = mode === "edit" ? {template: template, expectedVersion: source.version} : {template: template}
        error = ""; saving = true
        if (send("templates-save", "", payload, {origin: "templateEditor", editorGeneration: editorGeneration}) < 0) { saving = false; error = t("Sem conexão com o FalaTrace.") }
    }
    function handleResponse(request, message) {
        if (request.editorGeneration !== editorGeneration) return
        saving = false
        if (!message.ok) { error = t(message.error); return }
        const saved = message.result.template || ({})
        close()
        settingsDialog.notesPage.saved(saved)
    }
    function connectionLost() { if (saving) { saving = false; error = t("Não deu para confirmar se o modelo foi salvo. Recarregue e confira.") } }

    onOpened: templateCancel.forceActiveFocus(Qt.TabFocusReason)
    onClosed: { editorGeneration += 1; saving = false; const back = opener; opener = null; if (back && back.visible) back.forceActiveFocus(Qt.TabFocusReason) }

    contentItem: ScrollView {
        id: editorScroll
        clip: true
        contentWidth: availableWidth
        ColumnLayout {
            width: editorScroll.availableWidth
            spacing: 10
            Label { text: t("Nome"); color: ink; font.pixelSize: 13 }
            FtTextField { id: nameField; objectName: "templateName"; Layout.fillWidth: true; maximumLength: 80; placeholderText: t("Ex.: Revisão semanal"); Accessible.name: t("Nome do modelo"); onTextEdited: { templateEditor.nameEdited = true; templateEditor.touched() } }
            Label { text: t("Quando usar"); color: ink; font.pixelSize: 13 }
            FtTextField { id: descriptionField; objectName: "templateDescription"; Layout.fillWidth: true; maximumLength: 300; placeholderText: t("Ex.: Reunião semanal do time para revisar entregas"); Accessible.name: t("Quando usar este modelo"); onTextEdited: templateEditor.touched() }
            SettingsHint { text: t("A IA também lê esta linha ao escolher o modelo de uma reunião.") }
            RowLayout {
                Layout.fillWidth: true
                Layout.topMargin: 4
                Label { text: t("Seções"); color: ink; font.pixelSize: 15; font.weight: Font.DemiBold; Layout.fillWidth: true }
                FtButton { objectName: "templateAddSection"; compact: true; variant: "outline"; iconName: "plus"; text: t("Adicionar seção"); enabled: templateEditor.sections.length < 8; onClicked: templateEditor.addSection() }
            }
            SettingsHint { text: t("Na ordem em que aparecem nas notas. Alt+↑ e Alt+↓ mudam a ordem.") }
            Repeater {
                id: sectionRepeater
                model: templateEditor.sections
                delegate: Rectangle {
                    id: sectionRow
                    required property var modelData
                    required property int index
                    function focusTitle() { titleField.forceActiveFocus(Qt.TabFocusReason) }
                    Layout.fillWidth: true
                    implicitHeight: sectionColumn.implicitHeight + 16
                    radius: 10; color: surfaceAlt; border.width: 1; border.color: divider
                    ColumnLayout {
                        id: sectionColumn
                        anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                        anchors.leftMargin: 10; anchors.rightMargin: 8
                        spacing: 6
                        RowLayout {
                            Layout.fillWidth: true
                            spacing: 6
                            Label { text: String(sectionRow.index + 1); color: muted; font.pixelSize: 12; font.family: "monospace"; Layout.preferredWidth: 16 }
                            FtTextField {
                                id: titleField
                                objectName: "templateSectionTitle-" + sectionRow.index
                                Layout.fillWidth: true; maximumLength: 80
                                text: sectionRow.modelData.title
                                placeholderText: t("Título da seção")
                                Accessible.name: tf("Título da seção %1", sectionRow.index + 1)
                                onTextEdited: { const section = templateEditor.sections[sectionRow.index]; section.title = text; section.edited = true; templateEditor.touched() }
                                Keys.onPressed: event => {
                                    if (!(event.modifiers & Qt.AltModifier)) return
                                    if (event.key === Qt.Key_Up) { templateEditor.moveSection(sectionRow.index, -1); event.accepted = true }
                                    else if (event.key === Qt.Key_Down) { templateEditor.moveSection(sectionRow.index, 1); event.accepted = true }
                                }
                            }
                            FtButton { compact: true; iconOnly: true; variant: "ghost"; iconName: "arrow-up"; text: t("Subir a seção (Alt+↑)"); enabled: sectionRow.index > 0; onClicked: templateEditor.moveSection(sectionRow.index, -1) }
                            FtButton { compact: true; iconOnly: true; variant: "ghost"; iconName: "arrow-down"; text: t("Descer a seção (Alt+↓)"); enabled: sectionRow.index < templateEditor.sections.length - 1; onClicked: templateEditor.moveSection(sectionRow.index, 1) }
                            FtButton { compact: true; iconOnly: true; variant: "ghost"; iconName: "trash"; text: t("Tirar a seção"); enabled: templateEditor.sections.length > 3; onClicked: templateEditor.removeSection(sectionRow.index) }
                        }
                        FtTextField {
                            Layout.fillWidth: true; Layout.leftMargin: 22; maximumLength: 600
                            text: sectionRow.modelData.instruction
                            placeholderText: t("O que a IA deve escrever aqui")
                            Accessible.name: tf("O que a IA deve escrever na seção %1", sectionRow.index + 1)
                            onTextEdited: { templateEditor.sections[sectionRow.index].instruction = text; templateEditor.touched() }
                        }
                    }
                }
            }
            Label { text: t("Palavras do título da agenda (opcional)"); color: ink; font.pixelSize: 13; Layout.topMargin: 4 }
            FtTextField { id: keywordsField; Layout.fillWidth: true; placeholderText: t("revisão semanal, weekly"); Accessible.name: t("Palavras do título da agenda que escolhem este modelo") }
            SettingsHint { text: t("Separadas por vírgula. Uma reunião cujo título tenha uma delas usa este modelo.") }
            Label { visible: !!templateEditor.error; text: templateEditor.error; textFormat: Text.PlainText; color: errorColor; font.pixelSize: 13; wrapMode: Text.WordWrap; Layout.fillWidth: true }
        }
    }
    footer: Item {
        implicitHeight: 64
        RowLayout {
            anchors.fill: parent; anchors.leftMargin: 20; anchors.rightMargin: 20
            spacing: 10
            Label { Layout.fillWidth: true; text: templateEditor.problem; textFormat: Text.PlainText; color: muted; font.pixelSize: 12; elide: Text.ElideRight }
            FtButton { id: templateCancel; objectName: "templateCancel"; variant: "outline"; text: t("Cancelar"); enabled: !templateEditor.saving; onClicked: templateEditor.close() }
            FtButton { objectName: "templateSave"; variant: "primary"; text: templateEditor.saving ? t("Salvando…") : t("Salvar modelo"); enabled: backend.available && !templateEditor.saving && !templateEditor.problem; onClicked: templateEditor.save() }
        }
    }
}
