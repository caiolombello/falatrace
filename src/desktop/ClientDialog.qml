import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Clients: add, rename, aliases and delete in the timesheet catalog (client-edit), and the client of
// the open meeting (meeting-client-set: one client, none, or back to automatic). Cancel has the focus
// when it opens; a delete asks first. Failures are said here, never in errorText or notice.
FtDialog {
    id: clientDialog
    objectName: "clientDialog"
    property string mode: "add"
    property var client: null
    property string error: ""
    property int editGeneration: 0
    // Assigning: the catalog and the choice ("" none, "auto" automatic, else a client code).
    property var catalog: []
    property bool catalogLoading: false
    property string choice: "auto"
    property string jobId: ""
    readonly property bool busy: Object.keys(pending).some(function(id){ return ["client-edit", "meeting-client-set"].indexOf(pending[id].op) >= 0 && pending[id].editGeneration === clientDialog.editGeneration })
    title: mode === "add" ? t("Novo cliente") : mode === "rename" ? t("Renomear cliente") : mode === "aliases" ? t("Apelidos do cliente") : mode === "delete" ? t("Excluir cliente") : t("Cliente desta reunião")
    anchors.centerIn: parent
    width: Math.min(520, window.width - 48)
    modal: true
    closePolicy: busy ? Popup.NoAutoClose : Popup.CloseOnEscape

    function openFor(nextMode, value) {
        editGeneration += 1; mode = nextMode; client = value; error = ""
        codeField.text = ""; nameField.text = nextMode === "rename" && value ? value.name || "" : ""; aliasField.text = ""
        open()
    }
    // The client of the open meeting.
    function openAssign() {
        if (!feature("clients") || !detail.jobId) return
        editGeneration += 1; mode = "assign"; client = null; error = ""; jobId = String(detail.jobId).toLowerCase()
        // An empty list is "Nenhum" when the person chose it (clientsManual), else the automatic choice.
        const current = asList(detail.clients)
        choice = current.length ? (current[0].source === "manual" ? current[0].code : "auto") : detail.clientsManual === true ? "" : "auto"
        open()
        catalogLoading = true
        if (send("clients-list", "", ({}), {origin: "clientDialog", editGeneration: editGeneration, catalog: true}) < 0) { catalogLoading = false; error = t("Sem conexão com o FalaTrace.") }
    }
    function edit(payload, op) {
        if (busy || !backend.available) return
        error = ""
        if (send("client-edit", "", payload, {origin: "clientDialog", editGeneration: editGeneration, editOp: op, value: payload.value || ""}) < 0) error = t("Sem conexão com o FalaTrace.")
    }
    function confirm() {
        if (mode === "add") {
            const name = nameField.text.trim(), code = codeField.text.trim()
            if (!name) return
            const payload = {op: "add", name: name}
            payload.code = code
            edit(payload, "add")
        } else if (mode === "rename") { const name = nameField.text.trim(); if (name && client) edit({op: "rename", code: client.code, name: name}, "rename") }
        else if (mode === "delete") { if (client) edit({op: "delete", code: client.code}, "delete") }
        else if (mode === "assign") {
            if (busy || !backend.available || !jobId) return
            error = ""
            const payload = choice === "auto" ? {automatic: true} : {clientCodes: choice ? [choice] : []}
            if (send("meeting-client-set", jobId, payload, {origin: "clientDialog", editGeneration: editGeneration, editOp: "assign"}) < 0) error = t("Sem conexão com o FalaTrace.")
        }
    }
    function handleResponse(request, message) {
        if (request.editGeneration !== editGeneration) return
        if (request.catalog) {
            catalogLoading = false
            if (!message.ok) { error = t("Não deu para carregar os clientes."); return }
            catalog = message.result.catalogError ? [] : asList(message.result.clients)
            if (message.result.catalogError) error = t("O arquivo de clientes tem um erro; corrija-o para editar aqui.")
            return
        }
        if (!message.ok) { error = t(message.error); return }
        if (request.editOp === "assign") {
            const clients = asList(message.result.clients)
            if (selected.key && String(detail.jobId || "").toLowerCase() === String(message.result.jobId || "").toLowerCase()) detail = Object.assign({}, detail, {clients: clients, clientsManual: message.result.manual === true})
            close()
            toast.show(clients.length ? tf("Cliente desta reunião: %1", clients[0].name) : t("Reunião sem cliente."), "", null)
            return
        }
        if (request.editOp === "alias-add" || request.editOp === "alias-remove") {
            aliasField.text = ""
            const aliases = asList(client.aliases).filter(function(alias){ return alias !== request.value })
            if (request.editOp === "alias-add") aliases.push(request.value)
            client = Object.assign({}, client, {aliases: aliases})
            clientsView.reloadSelected()
            return
        }
        close()
        toast.show(request.editOp === "add" ? t("Cliente cadastrado.") : request.editOp === "delete" ? t("Cliente excluído.") : t("Nome salvo."), "", null)
        if (request.editOp === "add" && message.result.code) { clientsView.load(); clientsView.select(message.result.code) }
        else if (request.editOp === "delete") { clientsView.selectedCode = ""; clientsView.client = null; clientsView.showDetail = false; clientsView.load() }
        else clientsView.reloadSelected()
    }
    function connectionLost() { catalogLoading = false; if (visible && busy) error = t("Não deu para confirmar se salvou. Recarregue e confira.") }
    onOpened: clientCancel.forceActiveFocus(Qt.TabFocusReason)
    onClosed: { editGeneration += 1; error = ""; catalog = [] }

    contentItem: ColumnLayout {
        spacing: 10
        // Add / rename
        Label { visible: clientDialog.mode === "add"; text: t("O código aparece nos apontamentos; deixe em branco para o FalaTrace criar um."); textFormat: Text.PlainText; color: muted; font.pixelSize: 13; wrapMode: Text.WordWrap; Layout.fillWidth: true }
        FtTextField { id: codeField; objectName: "clientDialogCode"; visible: clientDialog.mode === "add"; Layout.fillWidth: true; placeholderText: t("Código (opcional)"); maximumLength: 20; Accessible.name: t("Código do cliente") }
        FtTextField { id: nameField; objectName: "clientDialogName"; visible: clientDialog.mode === "add" || clientDialog.mode === "rename"; Layout.fillWidth: true; placeholderText: t("Nome do cliente"); maximumLength: 200; Accessible.name: t("Nome do cliente"); onAccepted: clientDialog.confirm() }
        // Aliases
        Label { visible: clientDialog.mode === "aliases"; text: t("Outros nomes que identificam este cliente no título da agenda e na conversa."); textFormat: Text.PlainText; color: muted; font.pixelSize: 13; wrapMode: Text.WordWrap; Layout.fillWidth: true }
        Flow {
            visible: clientDialog.mode === "aliases"
            Layout.fillWidth: true
            spacing: 6
            Repeater {
                model: clientDialog.client ? asList(clientDialog.client.aliases) : []
                delegate: FtButton { required property var modelData; compact: true; variant: "outline"; iconName: "close"; text: modelData; Accessible.name: tf("Remover o apelido %1", modelData); enabled: !clientDialog.busy; onClicked: clientDialog.edit({op: "alias-remove", code: clientDialog.client.code, value: modelData}, "alias-remove") }
            }
        }
        RowLayout {
            visible: clientDialog.mode === "aliases"
            Layout.fillWidth: true
            spacing: 8
            FtTextField { id: aliasField; objectName: "clientDialogAlias"; Layout.fillWidth: true; placeholderText: t("Novo apelido"); Accessible.name: t("Novo apelido"); onAccepted: { if (text.trim() && clientDialog.client) clientDialog.edit({op: "alias-add", code: clientDialog.client.code, value: text.trim()}, "alias-add") } }
            FtButton { compact: true; variant: "outline"; iconName: "plus"; text: t("Adicionar"); enabled: aliasField.text.trim() !== "" && !clientDialog.busy; onClicked: clientDialog.edit({op: "alias-add", code: clientDialog.client.code, value: aliasField.text.trim()}, "alias-add") }
        }
        // Delete
        Label { visible: clientDialog.mode === "delete"; text: clientDialog.client ? tf("Excluir “%1” do catálogo? As reuniões continuam; elas só deixam de aparecer neste cliente.", clientDialog.client.name) : ""; textFormat: Text.PlainText; color: ink; font.pixelSize: 14; wrapMode: Text.WordWrap; Layout.fillWidth: true }
        // The client of this meeting
        BusyIndicator { visible: clientDialog.mode === "assign" && clientDialog.catalogLoading; running: visible; implicitWidth: 26; implicitHeight: 26 }
        ListView {
            id: assignList
            objectName: "clientAssignList"
            visible: clientDialog.mode === "assign" && !clientDialog.catalogLoading
            Layout.fillWidth: true
            Layout.preferredHeight: Math.min(contentHeight, 300)
            clip: true
            spacing: 2
            keyNavigationEnabled: true
            model: [{code: "auto", name: t("Automático"), hint: t("Pelo título da agenda e pela conversa")}, {code: "", name: t("Nenhum"), hint: t("Esta reunião não é de um cliente")}].concat(clientDialog.catalog.map(function(item){ return {code: item.code, name: item.name, hint: item.code} }))
            ScrollBar.vertical: ScrollBar {}
            delegate: ItemDelegate {
                id: assignRow
                required property var modelData
                readonly property bool chosen: clientDialog.choice === modelData.code
                objectName: "clientAssignOption-" + (modelData.code || "none")
                width: ListView.view.width
                hoverEnabled: true
                leftPadding: 10; rightPadding: 10; topPadding: 6; bottomPadding: 6
                Accessible.role: Accessible.RadioButton
                Accessible.checked: chosen
                Accessible.name: modelData.name
                background: Rectangle { radius: 8; color: assignRow.chosen ? selectedSurface : assignRow.hovered ? hoverSurface : "transparent"; border.width: assignRow.visualFocus ? 2 : 0; border.color: accent }
                contentItem: RowLayout {
                    spacing: 10
                    Rectangle {
                        implicitWidth: 16; implicitHeight: 16; radius: 8
                        color: "transparent"; border.width: 2; border.color: assignRow.chosen ? accent : dividerStrong
                        Rectangle { anchors.centerIn: parent; width: 8; height: 8; radius: 4; color: accent; visible: assignRow.chosen }
                    }
                    Label { text: assignRow.modelData.name; textFormat: Text.PlainText; color: ink; font.pixelSize: 14; elide: Text.ElideRight; Layout.fillWidth: true }
                    Label { text: assignRow.modelData.hint; textFormat: Text.PlainText; color: muted; font.pixelSize: 12; elide: Text.ElideRight; Layout.maximumWidth: 200 }
                }
                onClicked: clientDialog.choice = modelData.code
            }
        }
        Label { objectName: "clientDialogError"; visible: !!clientDialog.error; text: clientDialog.error; textFormat: Text.PlainText; color: errorColor; wrapMode: Text.WordWrap; Layout.fillWidth: true }
    }
    footer: Item {
        implicitHeight: 64
        RowLayout {
            anchors.fill: parent; anchors.leftMargin: 20; anchors.rightMargin: 20
            spacing: 10
            Item { Layout.fillWidth: true }
            FtButton { id: clientCancel; objectName: "clientDialogCancel"; variant: "outline"; text: clientDialog.mode === "aliases" ? t("Fechar") : t("Cancelar"); enabled: !clientDialog.busy; onClicked: clientDialog.close() }
            FtButton {
                objectName: "clientDialogConfirm"
                visible: clientDialog.mode !== "aliases"
                variant: clientDialog.mode === "delete" ? "danger" : "primary"
                text: clientDialog.busy ? t("Salvando…") : clientDialog.mode === "add" ? t("Cadastrar") : clientDialog.mode === "rename" ? t("Salvar nome") : clientDialog.mode === "delete" ? t("Excluir") : t("Usar este cliente")
                enabled: backend.available && !clientDialog.busy && (clientDialog.mode === "add" || clientDialog.mode === "rename" ? nameField.text.trim() !== "" : clientDialog.mode === "assign" ? !clientDialog.catalogLoading : true)
                onClicked: clientDialog.confirm()
            }
        }
    }
}
