import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Pessoas (DESIGN-STUDIO §2.11): the people of your meetings (confirmed speaker names and calendar
// attendees), "Você" first. Selecting one shows the stats line, recipe shortcuts, their open
// actions, recent decisions (each opens the meeting at that moment) and meetings. Rename, aliases,
// merge and hide go through PersonDialog. In the compact layout the list and the person are two
// steps. Requests fail into this page only.
Rectangle {
    id: peopleView
    objectName: "peopleView"
    anchors.fill: parent
    visible: currentView === "people"
    color: canvas

    property var people: []
    property bool refreshing: false
    property bool loading: false
    property bool loaded: false
    property string error: ""
    property int listGeneration: 0
    property string selectedId: ""
    property string selectedName: ""
    property var person: null
    property bool detailLoading: false
    property string detailError: ""
    property int detailGeneration: 0
    property string sortMode: "recent"
    // Compact layout: the list, or the selected person.
    property bool showDetail: false
    readonly property string query: peopleSearch.text.trim().toLocaleLowerCase()
    readonly property var shown: {
        const list = people.filter(function(item){ return !query || [item.name].concat(asList(item.aliases)).join(" ").toLocaleLowerCase().indexOf(query) >= 0 })
        return list.slice().sort(function(a, b){
            if (a.self !== b.self) return a.self ? -1 : 1
            if (sortMode === "name") return String(a.name).localeCompare(String(b.name))
            return timeValue(b.lastMeetingAt) - timeValue(a.lastMeetingAt)
        })
    }

    function load() {
        if (!feature("people") || !backend.available) return
        listGeneration += 1; loading = true; error = ""
        if (send("people-list", "", ({}), {origin: "people", listGeneration: listGeneration}) < 0) { loading = false; error = t("Sem conexão com o FalaTrace.") }
    }
    function select(id) {
        const item = people.find(function(entry){ return entry.id === id })
        selectedId = id; selectedName = item ? item.name : ""; showDetail = true
        detailGeneration += 1; detailLoading = true; detailError = ""
        if (send("person-detail", "", {personId: id}, {origin: "people", detailGeneration: detailGeneration}) < 0) { detailLoading = false; detailError = t("Sem conexão com o FalaTrace.") }
    }
    function reloadSelected() { load(); if (selectedId) select(selectedId) }
    onVisibleChanged: if (visible) load()
    Timer { interval: 4000; repeat: false; running: peopleView.visible && peopleView.refreshing && !peopleView.loading; onTriggered: peopleView.load() }

    function handleResponse(request, message) {
        if (request.op === "action-set") { personSections.handleAction(request, message); return }
        if (request.op === "people-list") {
            if (request.listGeneration !== listGeneration) return
            loading = false
            if (!message.ok) { error = t("Não deu para carregar as pessoas."); return }
            people = asList(message.result.people); loaded = true
            refreshing = message.result.refreshing === true
            indexRefreshSeen(refreshing)
            // The person shown may have been merged or hidden elsewhere.
            if (selectedId && !people.some(function(entry){ return entry.id === selectedId })) { selectedId = ""; selectedName = ""; person = null; showDetail = false }
            if (!selectedId && people.length && !compactLayout) select(shown[0].id)
        } else if (request.op === "person-detail") {
            if (request.detailGeneration !== detailGeneration) return
            detailLoading = false
            if (!message.ok) { detailError = t(message.error); person = null; return }
            person = message.result; selectedName = message.result.name || selectedName
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
    function recipe(id, name) { return {id: id, name: name} }

    RowLayout {
        anchors.fill: parent
        spacing: 0
        // ── List ──
        Rectangle {
            objectName: "peopleList"
            visible: !compactLayout || !peopleView.showDetail
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
                    Label { text: t("Pessoas"); textFormat: Text.PlainText; color: ink; font.pixelSize: compactLayout ? 22 : 24; font.weight: Font.DemiBold; Layout.fillWidth: true }
                    BusyIndicator { visible: peopleView.loading; running: visible; implicitWidth: 22; implicitHeight: 22 }
                }
                FtTextField { id: peopleSearch; objectName: "peopleSearch"; Layout.fillWidth: true; leadingIcon: "search"; placeholderText: t("Buscar pessoas…"); Accessible.name: t("Buscar pessoas") }
                FtSegmented {
                    objectName: "peopleSort"
                    compact: true; showIcons: false
                    accessibleName: t("Ordem")
                    currentIndex: peopleView.sortMode === "name" ? 1 : 0
                    model: [{value: 0, label: t("Recentes")}, {value: 1, label: t("A–Z")}]
                    onActivated: value => peopleView.sortMode = value === 1 ? "name" : "recent"
                }
                Label { visible: peopleView.refreshing; text: t("Atualizando — reuniões recentes podem faltar."); textFormat: Text.PlainText; color: muted; font.pixelSize: 11; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                ListView {
                    id: peopleList
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true
                    spacing: 2
                    model: peopleView.shown
                    keyNavigationEnabled: true
                    activeFocusOnTab: count > 0
                    boundsBehavior: Flickable.StopAtBounds
                    Accessible.role: Accessible.List
                    Accessible.name: t("Pessoas")
                    ScrollBar.vertical: ScrollBar {}
                    Keys.onReturnPressed: { if (currentIndex >= 0) peopleView.select(peopleView.shown[currentIndex].id) }
                    Keys.onEnterPressed: { if (currentIndex >= 0) peopleView.select(peopleView.shown[currentIndex].id) }
                    delegate: ItemDelegate {
                        id: personRow
                        required property var modelData
                        required property int index
                        objectName: "personRow-" + modelData.id
                        width: ListView.view.width
                        hoverEnabled: true
                        leftPadding: 8; rightPadding: 8; topPadding: 7; bottomPadding: 7
                        Accessible.name: modelData.name + ", " + peopleView.statsText(modelData)
                        background: Rectangle {
                            radius: 9
                            color: peopleView.selectedId === personRow.modelData.id ? selectedSurface : personRow.hovered ? hoverSurface : "transparent"
                            border.width: personRow.visualFocus || (personRow.ListView.isCurrentItem && peopleList.activeFocus) ? 2 : 0
                            border.color: accent
                        }
                        contentItem: RowLayout {
                            spacing: 10
                            FtAvatar { name: personRow.modelData.name; size: 32 }
                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 1
                                RowLayout {
                                    spacing: 6
                                    Label { text: personRow.modelData.name; textFormat: Text.PlainText; color: ink; font.pixelSize: 14; font.weight: Font.Medium; elide: Text.ElideRight; Layout.fillWidth: true }
                                    FtChip { visible: personRow.modelData.self === true; text: t("Você"); kind: "accent"; implicitHeight: 20 }
                                }
                                Label { text: peopleView.statsText(Object.assign({}, personRow.modelData, {openActions: 0})); textFormat: Text.PlainText; color: muted; font.pixelSize: 12; elide: Text.ElideRight; Layout.fillWidth: true }
                            }
                            Rectangle {
                                visible: Number(personRow.modelData.openActions) > 0
                                implicitWidth: Math.max(22, badge.implicitWidth + 12); implicitHeight: 20; radius: 10
                                color: accentSoft
                                Label { id: badge; anchors.centerIn: parent; text: String(personRow.modelData.openActions); color: accent; font.pixelSize: 11; font.weight: Font.DemiBold }
                                HoverHandler { id: badgeHover }
                                ToolTip.visible: badgeHover.hovered
                                ToolTip.text: t("Ações abertas")
                            }
                        }
                        onClicked: { peopleList.currentIndex = index; peopleView.select(modelData.id) }
                    }
                }
                FtEmptyState {
                    objectName: "peopleEmpty"
                    Layout.fillWidth: true
                    visible: peopleView.loaded && !peopleView.loading && !peopleView.people.length && !peopleView.error
                    iconName: "user"
                    body: t("As pessoas aparecem quando você confirma nomes de falantes ou conecta uma agenda.")
                    secondaryText: t("Conectar agenda")
                    onSecondaryClicked: { settingsDialog.open(); settingsDialog.goToSection(5) }
                }
                FtEmptyState {
                    Layout.fillWidth: true
                    visible: !!peopleView.error && !peopleView.loading
                    iconName: "alert"
                    body: peopleView.error
                    primaryText: t("Tentar de novo")
                    onPrimaryClicked: peopleView.load()
                }
            }
        }

        // ── Person ──
        Flickable {
            id: personScroll
            objectName: "personPanel"
            visible: (!compactLayout || peopleView.showDetail) && !!peopleView.selectedId
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            contentWidth: width
            contentHeight: personColumn.implicitHeight + 48
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar {}
            ColumnLayout {
                id: personColumn
                x: compactLayout ? 16 : 32
                y: compactLayout ? 16 : 24
                width: Math.min(760, personScroll.width - 2 * x)
                spacing: 14
                FtButton { visible: compactLayout; compact: true; variant: "ghost"; iconName: "back"; text: t("Pessoas"); onClicked: peopleView.showDetail = false }
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 14
                    FtAvatar { name: peopleView.selectedName; size: 48 }
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 4
                        Label { text: peopleView.selectedName; textFormat: Text.PlainText; color: ink; font.pixelSize: 22; font.weight: Font.DemiBold; elide: Text.ElideRight; Layout.fillWidth: true }
                        Label { objectName: "personStats"; text: peopleView.statsText(peopleView.person); textFormat: Text.PlainText; color: muted; font.pixelSize: 13; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                    }
                    FtButton {
                        id: personMore
                        objectName: "personMore"
                        iconOnly: true; compact: true; variant: "ghost"; iconName: "more"
                        text: t("Editar pessoa")
                        enabled: backend.available && !!peopleView.person
                        onClicked: personMenu.popup(personMore, personMore.width - personMenu.implicitWidth, personMore.height + 4)
                        FtMenu {
                            id: personMenu
                            Action { objectName: "personRename"; text: t("Renomear…"); onTriggered: personDialog.openFor("rename", peopleView.person) }
                            Action { text: t("Apelidos…"); onTriggered: personDialog.openFor("aliases", peopleView.person) }
                            Action { objectName: "personMerge"; text: t("Mesclar com…"); enabled: peopleView.people.length > 1; onTriggered: personDialog.openFor("merge", peopleView.person) }
                            Action { objectName: "personHide"; text: t("Ocultar…"); onTriggered: personDialog.openFor("hide", peopleView.person) }
                        }
                    }
                }
                Flow {
                    visible: !!peopleView.person && asList(peopleView.person.aliases).length > 0
                    Layout.fillWidth: true
                    spacing: 6
                    Repeater { model: peopleView.person ? asList(peopleView.person.aliases) : []; FtChip { required property var modelData; text: modelData } }
                }
                Flow {
                    Layout.fillWidth: true
                    spacing: 8
                    visible: feature("assistant")
                    FtButton { compact: true; variant: "outline"; iconName: "chat"; text: tf("Perguntar sobre %1", peopleView.selectedName); onClicked: askPanel.openWith(askPanel.viewScope(), "", null) }
                    FtButton { objectName: "personRecipe-promise"; visible: feature("recipes"); compact: true; variant: "ghost"; iconName: "slash"; text: t("O que eu prometi?"); onClicked: askPanel.openWith(askPanel.viewScope(), "", peopleView.recipe("what-did-i-promise", t("O que eu prometi?"))) }
                    FtButton { objectName: "personRecipe-prep"; visible: feature("recipes"); compact: true; variant: "ghost"; iconName: "slash"; text: t("Preparar a próxima reunião"); onClicked: askPanel.openWith(askPanel.viewScope(), "", peopleView.recipe("prep-next-meeting", t("Preparar a próxima reunião"))) }
                }
                BusyIndicator { visible: peopleView.detailLoading; running: visible; implicitWidth: 28; implicitHeight: 28 }
                Label { visible: !!peopleView.detailError; text: peopleView.detailError; textFormat: Text.PlainText; color: warningColor; font.pixelSize: 13; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                EntitySections { id: personSections; objectName: "personSections"; Layout.fillWidth: true; origin: "people"; entity: peopleView.person; onReload: peopleView.reloadSelected() }
                AskBar { Layout.fillWidth: true; Layout.topMargin: 6; placeholder: tf("Pergunte sobre %1…", peopleView.selectedName) }
            }
        }
        FtEmptyState {
            visible: !compactLayout && !peopleView.selectedId && peopleView.people.length > 0
            Layout.fillWidth: true
            Layout.alignment: Qt.AlignVCenter
            iconName: "user"
            body: t("Escolha uma pessoa para ver as reuniões, as decisões e o que ficou em aberto.")
        }
    }
}
