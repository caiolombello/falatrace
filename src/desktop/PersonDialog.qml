import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Edit a person (person-edit): rename (old names keep being recognised), aliases, merge into another
// person (with a preview of who stays) or hide. Cancel has the focus when it opens; failures are
// said here and never in errorText or notice.
FtDialog {
    id: personDialog
    objectName: "personDialog"
    property string mode: "rename"
    property var person: null
    property string error: ""
    property int editGeneration: 0
    property string targetId: ""
    readonly property bool busy: Object.keys(pending).some(function(id){ return pending[id].op === "person-edit" && pending[id].editGeneration === personDialog.editGeneration })
    readonly property var targets: peopleView.people.filter(function(item){ return person && item.id !== person.id })
    readonly property var target: { for (const item of targets) if (item.id === targetId) return item; return null }
    title: mode === "rename" ? t("Renomear pessoa") : mode === "aliases" ? t("Apelidos") : mode === "merge" ? t("Mesclar pessoas") : t("Ocultar pessoa")
    anchors.centerIn: parent
    width: Math.min(520, window.width - 48)
    modal: true
    closePolicy: busy ? Popup.NoAutoClose : Popup.CloseOnEscape

    function openFor(nextMode, value) {
        if (!value) return
        editGeneration += 1; mode = nextMode; person = value; error = ""; targetId = ""
        nameField.text = mode === "rename" ? (value.name || "") : ""
        aliasField.text = ""
        open()
    }
    function edit(op, extra) {
        if (!person || busy || !backend.available) return
        error = ""
        const payload = Object.assign({personId: person.id, op: op}, extra || ({}))
        if (send("person-edit", "", payload, {origin: "personDialog", editGeneration: editGeneration, editOp: op, targetId: payload.targetId || "", value: payload.value || ""}) < 0) error = t("Sem conexão com o FalaTrace.")
    }
    function confirm() {
        if (mode === "rename") { const name = nameField.text.trim(); if (name && name !== person.name) edit("rename", {value: name}) }
        else if (mode === "merge") { if (targetId) edit("merge", {targetId: targetId}) }
        else if (mode === "hide") edit("hide")
    }
    function handleResponse(request, message) {
        if (request.editGeneration !== editGeneration) return
        if (!message.ok) { error = t(message.error); return }
        if (request.editOp === "alias-add" || request.editOp === "alias-remove") {
            aliasField.text = ""
            const aliases = asList(person.aliases).filter(function(alias){ return alias !== request.value })
            if (request.editOp === "alias-add") aliases.push(request.value)
            person = Object.assign({}, person, {aliases: aliases})
            peopleView.reloadSelected()
            return
        }
        const merged = request.editOp === "merge"
        close()
        toast.show(merged ? t("Pessoas mescladas.") : request.editOp === "hide" ? t("Pessoa ocultada.") : t("Nome salvo."), "", null)
        if (merged && request.targetId) { peopleView.load(); peopleView.select(request.targetId) } else peopleView.reloadSelected()
    }
    function connectionLost() { if (visible && busy) error = t("Não deu para confirmar se salvou. Recarregue e confira.") }
    onOpened: personCancel.forceActiveFocus(Qt.TabFocusReason)
    onClosed: { editGeneration += 1; error = "" }

    contentItem: ColumnLayout {
        spacing: 10
        // Rename
        Label { visible: personDialog.mode === "rename"; text: t("Os nomes antigos continuam reconhecidos nas reuniões."); textFormat: Text.PlainText; color: muted; font.pixelSize: 13; wrapMode: Text.WordWrap; Layout.fillWidth: true }
        FtTextField { id: nameField; objectName: "personDialogName"; visible: personDialog.mode === "rename"; Layout.fillWidth: true; placeholderText: t("Nome"); Accessible.name: t("Nome"); onAccepted: personDialog.confirm() }
        // Aliases
        Label { visible: personDialog.mode === "aliases"; text: t("Outros nomes pelos quais esta pessoa aparece nas reuniões."); textFormat: Text.PlainText; color: muted; font.pixelSize: 13; wrapMode: Text.WordWrap; Layout.fillWidth: true }
        Flow {
            visible: personDialog.mode === "aliases"
            Layout.fillWidth: true
            spacing: 6
            Repeater {
                model: personDialog.person ? asList(personDialog.person.aliases) : []
                delegate: FtButton { required property var modelData; compact: true; variant: "outline"; iconName: "close"; text: modelData; Accessible.name: tf("Remover o apelido %1", modelData); enabled: !personDialog.busy; onClicked: personDialog.edit("alias-remove", {value: modelData}) }
            }
        }
        RowLayout {
            visible: personDialog.mode === "aliases"
            Layout.fillWidth: true
            spacing: 8
            FtTextField { id: aliasField; objectName: "personDialogAlias"; Layout.fillWidth: true; placeholderText: t("Novo apelido"); Accessible.name: t("Novo apelido"); onAccepted: { if (text.trim()) personDialog.edit("alias-add", {value: text.trim()}) } }
            FtButton { compact: true; variant: "outline"; iconName: "plus"; text: t("Adicionar"); enabled: aliasField.text.trim() !== "" && !personDialog.busy; onClicked: personDialog.edit("alias-add", {value: aliasField.text.trim()}) }
        }
        // Merge
        Label { visible: personDialog.mode === "merge"; text: personDialog.person ? tf("Juntar “%1” com outra pessoa. As reuniões das duas passam a aparecer juntas.", personDialog.person.name) : ""; textFormat: Text.PlainText; color: ink; font.pixelSize: 13; wrapMode: Text.WordWrap; Layout.fillWidth: true }
        FtComboBox {
            id: mergeTarget
            objectName: "personMergeTarget"
            visible: personDialog.mode === "merge"
            Layout.fillWidth: true
            textRole: "label"; valueRole: "value"
            model: [{label: t("Escolha a pessoa que fica…"), value: ""}].concat(personDialog.targets.map(function(item){ return {label: item.name, value: item.id} }))
            currentIndex: Math.max(0, model.findIndex(function(entry){ return entry.value === personDialog.targetId }))
            Accessible.name: t("Pessoa que fica")
            onActivated: index => personDialog.targetId = model[index].value
        }
        Label {
            objectName: "personMergePreview"
            visible: personDialog.mode === "merge" && !!personDialog.target
            text: personDialog.target && personDialog.person ? tf("%1 (%2) entra em %3 (%4).", personDialog.person.name, Number(personDialog.person.meetingCount || 0) === 1 ? t("1 reunião") : tf("%1 reuniões", Number(personDialog.person.meetingCount || 0)), personDialog.target.name, Number(personDialog.target.meetingCount || 0) === 1 ? t("1 reunião") : tf("%1 reuniões", Number(personDialog.target.meetingCount || 0))) : ""
            textFormat: Text.PlainText; color: accent; font.pixelSize: 13; font.weight: Font.Medium; wrapMode: Text.WordWrap; Layout.fillWidth: true
        }
        // Hide
        Label { visible: personDialog.mode === "hide"; text: personDialog.person ? tf("Ocultar “%1”? A pessoa some das listas; as reuniões e as notas continuam.", personDialog.person.name) : ""; textFormat: Text.PlainText; color: ink; font.pixelSize: 14; wrapMode: Text.WordWrap; Layout.fillWidth: true }
        Label { objectName: "personDialogError"; visible: !!personDialog.error; text: personDialog.error; textFormat: Text.PlainText; color: errorColor; wrapMode: Text.WordWrap; Layout.fillWidth: true }
    }
    footer: Item {
        implicitHeight: 64
        RowLayout {
            anchors.fill: parent; anchors.leftMargin: 20; anchors.rightMargin: 20
            spacing: 10
            Item { Layout.fillWidth: true }
            FtButton { id: personCancel; objectName: "personDialogCancel"; variant: "outline"; text: personDialog.mode === "aliases" ? t("Fechar") : t("Cancelar"); enabled: !personDialog.busy; onClicked: personDialog.close() }
            FtButton {
                objectName: "personDialogConfirm"
                visible: personDialog.mode !== "aliases"
                variant: personDialog.mode === "hide" ? "danger" : "primary"
                text: personDialog.busy ? t("Salvando…") : personDialog.mode === "rename" ? t("Salvar nome") : personDialog.mode === "merge" ? t("Mesclar") : t("Ocultar")
                enabled: backend.available && !personDialog.busy && (personDialog.mode === "rename" ? nameField.text.trim() !== "" && !!personDialog.person && nameField.text.trim() !== personDialog.person.name : personDialog.mode === "merge" ? !!personDialog.targetId : true)
                onClicked: personDialog.confirm()
            }
        }
    }
}
