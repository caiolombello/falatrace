import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Clientes (DESIGN-STUDIO §2.11): the clients of your timesheet catalog with their meetings, open
// actions, decisions and people. "Novo cliente…", rename, aliases and delete edit the catalog through
// ClientDialog. An invalid catalog file is said once at the top and the page shows no clients;
// nothing is edited until it is fixed. Requests fail into this page only.
Rectangle {
    id: clientsView
    objectName: "clientsView"
    anchors.fill: parent
    visible: currentView === "clients"
    color: canvas

    property var clients: []
    property bool editable: false
    property string catalogError: ""
    property bool refreshing: false
    property bool loading: false
    property bool loaded: false
    property string error: ""
    property int listGeneration: 0
    property string selectedCode: ""
    property string selectedName: ""
    property var client: null
    property bool detailLoading: false
    property string detailError: ""
    property int detailGeneration: 0
    property bool showDetail: false
    readonly property string query: clientSearch.text.trim().toLocaleLowerCase()
    readonly property var shown: clients.filter(function(item){ return !query || [item.name, item.code].concat(asList(item.aliases)).join(" ").toLocaleLowerCase().indexOf(query) >= 0 })
        .slice().sort(function(a, b){ return timeValue(b.lastMeetingAt) - timeValue(a.lastMeetingAt) || String(a.name).localeCompare(String(b.name)) })

    function load() {
        if (!feature("clients") || !backend.available) return
        listGeneration += 1; loading = true; error = ""
        if (send("clients-list", "", ({}), {origin: "clients", listGeneration: listGeneration}) < 0) { loading = false; error = t("Sem conexão com o FalaTrace.") }
    }
    function select(code) {
        const item = clients.find(function(entry){ return entry.code === code })
        selectedCode = code; selectedName = item ? item.name : code; showDetail = true
        detailGeneration += 1; detailLoading = true; detailError = ""
        if (send("client-detail", "", {clientCode: code}, {origin: "clients", detailGeneration: detailGeneration}) < 0) { detailLoading = false; detailError = t("Sem conexão com o FalaTrace.") }
    }
    function reloadSelected() { load(); if (selectedCode) select(selectedCode) }
    onVisibleChanged: if (visible) load()
    Timer { interval: 4000; repeat: false; running: clientsView.visible && clientsView.refreshing && !clientsView.loading; onTriggered: clientsView.load() }

    function handleResponse(request, message) {
        if (request.op === "action-set") { clientSections.handleAction(request, message); return }
        if (request.op === "clients-list") {
            if (request.listGeneration !== listGeneration) return
            loading = false
            if (!message.ok) { error = t("Não deu para carregar os clientes."); return }
            const result = message.result
            catalogError = result.catalogError ? t(result.catalogError) : ""
            editable = result.editable === true
            clients = catalogError ? [] : asList(result.clients); loaded = true
            refreshing = result.refreshing === true
            indexRefreshSeen(refreshing)
            if (selectedCode && !clients.some(function(entry){ return entry.code === selectedCode })) { selectedCode = ""; selectedName = ""; client = null; showDetail = false }
            if (!selectedCode && clients.length && !compactLayout) select(shown[0].code)
        } else if (request.op === "client-detail") {
            if (request.detailGeneration !== detailGeneration) return
            detailLoading = false
            if (!message.ok) { detailError = t(message.error); client = null; return }
            client = message.result; selectedName = message.result.name || selectedName
        }
    }
    function connectionLost() { loading = false; detailLoading = false }
    function dayOf(value) { const date = new Date(value); return isNaN(date.getTime()) ? "" : Qt.formatDate(date, t("dd/MM")) }
    function statsText(item) {
        if (!item) return ""
        const count = Number(item.meetingCount || asList(item.meetings).length)
        const parts = [count === 1 ? t("1 reunião") : tf("%1 reuniões", count)]
        if (item.lastMeetingAt) parts.push(tf("última %1", dayOf(item.lastMeetingAt)))
        if (Number(item.openActions) > 0) parts.push(Number(item.openActions) === 1 ? t("1 ação aberta") : tf("%1 ações abertas", item.openActions))
        return parts.join(" · ")
    }

    RowLayout {
        anchors.fill: parent
        spacing: 0
        // ── List ──
        Rectangle {
            objectName: "clientsList"
            visible: !compactLayout || !clientsView.showDetail
            Layout.preferredWidth: compactLayout ? parent.width : 300
            Layout.fillHeight: true
            color: canvas
            Rectangle { visible: !compactLayout; anchors.right: parent.right; anchors.top: parent.top; anchors.bottom: parent.bottom; width: 1; color: divider }
            ColumnLayout {
                anchors.fill: parent
                anchors.margins: compactLayout ? 16 : 20
                spacing: 10
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 6
                    Label { text: t("Clientes"); textFormat: Text.PlainText; color: ink; font.pixelSize: compactLayout ? 22 : 24; font.weight: Font.DemiBold; Layout.fillWidth: true }
                    BusyIndicator { visible: clientsView.loading; running: visible; implicitWidth: 22; implicitHeight: 22 }
                    FtButton { objectName: "clientAdd"; compact: true; variant: "outline"; iconName: "plus"; text: t("Novo cliente…"); visible: clientsView.editable && !clientsView.catalogError; enabled: backend.available; onClicked: clientDialog.openFor("add", null) }
                }
                Rectangle {
                    objectName: "clientCatalogError"
                    visible: !!clientsView.catalogError
                    Layout.fillWidth: true
                    implicitHeight: catalogRow.implicitHeight + 20
                    radius: 10; color: warningSoft
                    RowLayout {
                        id: catalogRow
                        anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; anchors.margins: 10
                        spacing: 8
                        FtIcon { name: "alert"; tint: warningColor; size: 16; Layout.alignment: Qt.AlignTop }
                        Label { Layout.fillWidth: true; text: t("O arquivo de clientes tem um erro; corrija-o para editar aqui."); textFormat: Text.PlainText; color: ink; font.pixelSize: 13; wrapMode: Text.WordWrap }
                    }
                }
                FtTextField { id: clientSearch; objectName: "clientSearch"; visible: clientsView.clients.length > 0; Layout.fillWidth: true; leadingIcon: "search"; placeholderText: t("Buscar clientes…"); Accessible.name: t("Buscar clientes") }
                Label { visible: clientsView.refreshing; text: t("Atualizando — reuniões recentes podem faltar."); textFormat: Text.PlainText; color: muted; font.pixelSize: 11; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                ListView {
                    id: clientList
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true
                    spacing: 2
                    model: clientsView.shown
                    keyNavigationEnabled: true
                    activeFocusOnTab: count > 0
                    boundsBehavior: Flickable.StopAtBounds
                    Accessible.role: Accessible.List
                    Accessible.name: t("Clientes")
                    ScrollBar.vertical: ScrollBar {}
                    Keys.onReturnPressed: { if (currentIndex >= 0) clientsView.select(clientsView.shown[currentIndex].code) }
                    Keys.onEnterPressed: { if (currentIndex >= 0) clientsView.select(clientsView.shown[currentIndex].code) }
                    delegate: ItemDelegate {
                        id: clientRow
                        required property var modelData
                        required property int index
                        objectName: "clientRow-" + modelData.code
                        width: ListView.view.width
                        hoverEnabled: true
                        leftPadding: 8; rightPadding: 8; topPadding: 7; bottomPadding: 7
                        Accessible.name: modelData.name + ", " + clientsView.statsText(modelData)
                        background: Rectangle {
                            radius: 9
                            color: clientsView.selectedCode === clientRow.modelData.code ? selectedSurface : clientRow.hovered ? hoverSurface : "transparent"
                            border.width: clientRow.visualFocus || (clientRow.ListView.isCurrentItem && clientList.activeFocus) ? 2 : 0
                            border.color: accent
                        }
                        contentItem: RowLayout {
                            spacing: 10
                            Rectangle {
                                implicitWidth: Math.min(70, codeLabel.implicitWidth + 12); implicitHeight: 22; radius: 6
                                color: surfaceAlt; border.width: 1; border.color: divider
                                Label { id: codeLabel; anchors.centerIn: parent; width: Math.min(implicitWidth, 58); text: clientRow.modelData.code; textFormat: Text.PlainText; color: muted; font.pixelSize: 11; font.family: "monospace"; elide: Text.ElideRight }
                            }
                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 1
                                Label { text: clientRow.modelData.name; textFormat: Text.PlainText; color: ink; font.pixelSize: 14; font.weight: Font.Medium; elide: Text.ElideRight; Layout.fillWidth: true }
                                Label { text: clientsView.statsText(Object.assign({}, clientRow.modelData, {openActions: 0})); textFormat: Text.PlainText; color: muted; font.pixelSize: 12; elide: Text.ElideRight; Layout.fillWidth: true }
                            }
                            Rectangle {
                                visible: Number(clientRow.modelData.openActions) > 0
                                implicitWidth: Math.max(22, clientBadge.implicitWidth + 12); implicitHeight: 20; radius: 10
                                color: accentSoft
                                Label { id: clientBadge; anchors.centerIn: parent; text: String(clientRow.modelData.openActions); color: accent; font.pixelSize: 11; font.weight: Font.DemiBold }
                            }
                        }
                        onClicked: { clientList.currentIndex = index; clientsView.select(modelData.code) }
                    }
                }
                FtEmptyState {
                    objectName: "clientsEmpty"
                    Layout.fillWidth: true
                    visible: clientsView.loaded && !clientsView.loading && !clientsView.clients.length && !clientsView.error
                    iconName: "building"
                    body: clientsView.catalogError ? t("Nenhum cliente.") : t("Cadastre seus clientes para agrupar reuniões e ações.")
                    primaryText: clientsView.editable && !clientsView.catalogError ? t("Novo cliente…") : ""
                    primaryIcon: "plus"
                    onPrimaryClicked: clientDialog.openFor("add", null)
                }
                FtEmptyState {
                    Layout.fillWidth: true
                    visible: !!clientsView.error && !clientsView.loading
                    iconName: "alert"
                    body: clientsView.error
                    primaryText: t("Tentar de novo")
                    onPrimaryClicked: clientsView.load()
                }
            }
        }

        // ── Client ──
        Flickable {
            id: clientScroll
            objectName: "clientPanel"
            visible: (!compactLayout || clientsView.showDetail) && !!clientsView.selectedCode
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            contentWidth: width
            contentHeight: clientColumn.implicitHeight + 48
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar {}
            ColumnLayout {
                id: clientColumn
                x: compactLayout ? 16 : 32
                y: compactLayout ? 16 : 24
                width: Math.min(760, clientScroll.width - 2 * x)
                spacing: 14
                FtButton { visible: compactLayout; compact: true; variant: "ghost"; iconName: "back"; text: t("Clientes"); onClicked: clientsView.showDetail = false }
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 14
                    Rectangle {
                        implicitWidth: 48; implicitHeight: 48; radius: 12
                        color: accentSoft
                        FtIcon { anchors.centerIn: parent; name: "building"; tint: accent; size: 22 }
                    }
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 4
                        Label { text: clientsView.selectedName; textFormat: Text.PlainText; color: ink; font.pixelSize: 22; font.weight: Font.DemiBold; elide: Text.ElideRight; Layout.fillWidth: true }
                        Label { objectName: "clientStats"; text: clientsView.selectedCode + " · " + clientsView.statsText(clientsView.client); textFormat: Text.PlainText; color: muted; font.pixelSize: 13; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                    }
                    FtButton {
                        id: clientMore
                        objectName: "clientMore"
                        visible: clientsView.editable
                        iconOnly: true; compact: true; variant: "ghost"; iconName: "more"
                        text: t("Editar cliente")
                        enabled: backend.available && !!clientsView.client
                        onClicked: clientMenu.popup(clientMore, clientMore.width - clientMenu.implicitWidth, clientMore.height + 4)
                        FtMenu {
                            id: clientMenu
                            Action { text: t("Renomear…"); onTriggered: clientDialog.openFor("rename", clientsView.client) }
                            Action { text: t("Apelidos…"); onTriggered: clientDialog.openFor("aliases", clientsView.client) }
                            Action { text: t("Excluir…"); onTriggered: clientDialog.openFor("delete", clientsView.client) }
                        }
                    }
                }
                Flow {
                    visible: !!clientsView.client && (asList(clientsView.client.aliases).length > 0 || asList(clientsView.client.people).length > 0)
                    Layout.fillWidth: true
                    spacing: 6
                    Repeater { model: clientsView.client ? asList(clientsView.client.aliases) : []; FtChip { required property var modelData; text: modelData } }
                    Repeater { model: clientsView.client ? asList(clientsView.client.people).slice(0, 8) : []; FtChip { required property var modelData; iconName: "user"; text: modelData.name } }
                }
                Flow {
                    Layout.fillWidth: true
                    spacing: 8
                    visible: feature("assistant")
                    FtButton { compact: true; variant: "outline"; iconName: "chat"; text: tf("Perguntar sobre %1", clientsView.selectedName); onClicked: askPanel.openWith(askPanel.viewScope(), "", null) }
                    FtButton { objectName: "clientRecipe-prep"; visible: feature("recipes"); compact: true; variant: "ghost"; iconName: "slash"; text: t("Preparar a próxima reunião"); onClicked: askPanel.openWith(askPanel.viewScope(), "", {id: "prep-next-meeting", name: t("Preparar a próxima reunião")}) }
                    FtButton { objectName: "clientRecipe-promise"; visible: feature("recipes"); compact: true; variant: "ghost"; iconName: "slash"; text: t("O que prometemos?"); onClicked: askPanel.openWith(askPanel.viewScope(), "", {id: "what-did-i-promise", name: t("O que prometemos?")}) }
                }
                BusyIndicator { visible: clientsView.detailLoading; running: visible; implicitWidth: 28; implicitHeight: 28 }
                Label { visible: !!clientsView.detailError; text: clientsView.detailError; textFormat: Text.PlainText; color: warningColor; font.pixelSize: 13; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                EntitySections { id: clientSections; objectName: "clientSections"; Layout.fillWidth: true; origin: "clients"; entity: clientsView.client; onReload: clientsView.reloadSelected() }
                AskBar { Layout.fillWidth: true; Layout.topMargin: 6; placeholder: tf("Pergunte sobre %1…", clientsView.selectedName) }
            }
        }
        FtEmptyState {
            visible: !compactLayout && !clientsView.selectedCode && clientsView.clients.length > 0
            Layout.fillWidth: true
            Layout.alignment: Qt.AlignVCenter
            iconName: "building"
            body: t("Escolha um cliente para ver as reuniões, as pessoas e o que ficou em aberto.")
        }
        Item { visible: !compactLayout && !clientsView.selectedCode && !clientsView.clients.length; Layout.fillWidth: true }
    }
}
