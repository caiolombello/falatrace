import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Your own recipe (Configurações › Perguntar e receitas): a name (what / shows in Perguntar), one line
// on what it does, whether it runs on one meeting or several, and the request with variables such as
// {{meeting.title}}. Saved through recipes-save; built-in recipes are copied, never changed.
FtDialog {
    id: recipeEditor
    objectName: "recipeEditor"
    property string mode: "new"
    property var source: null
    property string scope: "meeting"
    property bool nameEdited: false
    property bool saving: false
    property string error: ""
    property int editorGeneration: 0
    readonly property var variables: ["meeting.title", "meeting.date", "meeting.people", "client", "person", "me", "today", "language"]
    readonly property string problem: {
        if (!nameField.text.trim() || nameField.text.trim().length > 80) return t("Dê um nome de até 80 caracteres.")
        if (!descriptionField.text.trim()) return t("Escreva em uma linha o que a receita faz.")
        const length = promptArea.text.trim().length
        if (length < 10 || length > 8000) return t("O pedido precisa ter de 10 a 8000 caracteres.")
        return ""
    }
    title: mode === "edit" ? t("Editar receita") : t("Nova receita")
    anchors.centerIn: parent
    width: Math.min(680, window.width - 48)
    height: Math.min(window.height - 48, 700)
    modal: true
    closePolicy: saving ? Popup.NoAutoClose : Popup.CloseOnEscape

    function slug(text) {
        let value = String(text || "")
        if (typeof value.normalize === "function") value = value.normalize("NFD").replace(/[̀-ͯ]/g, "")
        return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "receita"
    }
    function begin(newMode, recipe) {
        editorGeneration += 1; mode = newMode; source = recipe; error = ""; saving = false; nameEdited = newMode !== "edit"
        nameField.text = recipe ? String(recipe.name || "") + (newMode === "copy" ? t(" (cópia)") : "") : ""
        descriptionField.text = recipe ? String(recipe.description || "") : ""
        scope = recipe && recipe.scope === "library" ? "library" : "meeting"
        promptArea.text = recipe ? String(recipe.prompt || "") : ""
        open()
    }
    function openNew() { begin("new", null) }
    function openCopy(recipe) { if (recipe) begin("copy", recipe) }
    function openEdit(recipe) { if (recipe) begin("edit", recipe) }
    function insertVariable(name) {
        const text = "{{" + name + "}}"
        promptArea.insert(promptArea.cursorPosition, text)
        promptArea.forceActiveFocus(Qt.TabFocusReason)
    }
    function recipeId() {
        if (mode === "edit" && source) return source.id
        const taken = settingsDialog.assistantPage.recipes.map(function(item){ return item.id })
        const base = "custom:" + slug(nameField.text)
        let id = base, index = 2
        while (taken.indexOf(id) >= 0) { id = base + "-" + index; index += 1 }
        return id
    }
    function save() {
        if (saving || problem || !backend.available) return
        const name = nameField.text.trim()
        const names = mode === "edit" && !nameEdited && source && source.names ? {"pt-BR": source.names["pt-BR"], en: source.names.en, es: source.names.es} : {"pt-BR": name, en: name, es: name}
        const recipe = {id: recipeId(), version: mode === "edit" && source ? source.version : 1, builtIn: false, name: names, description: descriptionField.text.trim(), scope: scope, prompt: promptArea.text.trim()}
        const payload = mode === "edit" ? {recipe: recipe, expectedVersion: source.version} : {recipe: recipe}
        error = ""; saving = true
        if (send("recipes-save", "", payload, {origin: "recipeEditor", editorGeneration: editorGeneration}) < 0) { saving = false; error = t("Sem conexão com o FalaTrace.") }
    }
    function handleResponse(request, message) {
        if (request.editorGeneration !== editorGeneration) return
        saving = false
        if (!message.ok) { error = t(message.error); return }
        const saved = message.result.recipe || ({})
        close()
        settingsDialog.assistantPage.saved(saved)
    }
    function connectionLost() { if (saving) { saving = false; error = t("Não deu para confirmar se a receita foi salva. Recarregue e confira.") } }

    onOpened: recipeCancel.forceActiveFocus(Qt.TabFocusReason)
    onClosed: { editorGeneration += 1; saving = false }

    contentItem: ScrollView {
        id: recipeScroll
        clip: true
        contentWidth: availableWidth
        ColumnLayout {
            width: recipeScroll.availableWidth
            spacing: 10
            Label { text: t("Nome"); color: ink; font.pixelSize: 13 }
            FtTextField { id: nameField; objectName: "recipeName"; Layout.fillWidth: true; maximumLength: 80; placeholderText: t("Ex.: E-mail de follow-up"); Accessible.name: t("Nome da receita"); onTextEdited: recipeEditor.nameEdited = true }
            SettingsHint { text: t("É o que aparece quando você digita / em Perguntar.") }
            Label { text: t("O que faz"); color: ink; font.pixelSize: 13 }
            FtTextField { id: descriptionField; objectName: "recipeDescription"; Layout.fillWidth: true; maximumLength: 300; placeholderText: t("Ex.: Escreve um e-mail curto com as decisões e as ações"); Accessible.name: t("O que a receita faz") }
            Label { text: t("Usar em"); color: ink; font.pixelSize: 13 }
            FtSegmented {
                id: scopeChoice
                objectName: "recipeScope"
                accessibleName: t("Usar em")
                showIcons: false
                currentIndex: recipeEditor.scope === "library" ? 1 : 0
                model: [{value: 0, label: t("Uma reunião")}, {value: 1, label: t("Várias reuniões")}]
                onActivated: function(value) { recipeEditor.scope = value === 1 ? "library" : "meeting" }
            }
            Label { text: t("Pedido"); color: ink; font.pixelSize: 13; Layout.topMargin: 4 }
            ScrollView {
                Layout.fillWidth: true
                Layout.preferredHeight: 180
                clip: true
                TextArea {
                    id: promptArea
                    objectName: "recipePrompt"
                    wrapMode: TextEdit.Wrap; textFormat: TextEdit.PlainText; color: ink
                    placeholderText: t("Ex.: Escreva um e-mail de follow-up para {{meeting.people}} com as decisões e as próximas ações.")
                    placeholderTextColor: muted
                    selectionColor: accent; selectedTextColor: onAccent
                    Accessible.name: t("Pedido da receita")
                    background: Rectangle { radius: 8; color: fieldSurface; border.width: promptArea.activeFocus ? 2 : 1; border.color: promptArea.activeFocus ? accent : divider }
                }
            }
            SettingsHint { text: t("Inserir no pedido:") }
            Flow {
                Layout.fillWidth: true
                spacing: 6
                Repeater {
                    model: recipeEditor.variables
                    FtButton { required property var modelData; compact: true; variant: "outline"; text: "{{" + modelData + "}}"; Accessible.name: tf("Inserir %1", modelData); onClicked: recipeEditor.insertVariable(modelData) }
                }
            }
            Label { visible: !!recipeEditor.error; text: recipeEditor.error; textFormat: Text.PlainText; color: errorColor; font.pixelSize: 13; wrapMode: Text.WordWrap; Layout.fillWidth: true }
        }
    }
    footer: Item {
        implicitHeight: 64
        RowLayout {
            anchors.fill: parent; anchors.leftMargin: 20; anchors.rightMargin: 20
            spacing: 10
            Label { Layout.fillWidth: true; text: recipeEditor.problem; textFormat: Text.PlainText; color: muted; font.pixelSize: 12; elide: Text.ElideRight }
            FtButton { id: recipeCancel; objectName: "recipeCancel"; variant: "outline"; text: t("Cancelar"); enabled: !recipeEditor.saving; onClicked: recipeEditor.close() }
            FtButton { objectName: "recipeSave"; variant: "primary"; text: recipeEditor.saving ? t("Salvando…") : t("Salvar receita"); enabled: backend.available && !recipeEditor.saving && !recipeEditor.problem; onClicked: recipeEditor.save() }
        }
    }
}
