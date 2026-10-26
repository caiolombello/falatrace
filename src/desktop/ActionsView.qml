import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Ações (DESIGN-STUDIO §2.11, power-user table): every to-do from your meetings, grouped by meeting
// (or client, or person), with filters. Space or x ticks the focused action, d dismisses it, Enter
// opens its meeting at the moment it was said. Actions that no longer appear in the current notes
// keep their state in a collapsed group at the end. Requests fail into this page only.
Rectangle {
    id: actionsView
    objectName: "actionsView"
    anchors.fill: parent
    visible: currentView === "actions"
    color: canvas

    property var actions: []
    property var counts: ({})
    property bool refreshing: false
    property bool truncated: false
    property bool loading: false
    property bool loaded: false
    property string error: ""
    property int listGeneration: 0
    property string statusFilter: "open"
    property string personFilter: ""
    property string clientFilter: ""
    property string groupBy: "meeting"
    property bool orphansOpen: false
    property var people: []
    property var clients: []
    property bool lookupsRequested: false
    // Optimistic state per action and the newest revision per recording (one save per recording at a time).
    property var actionState: ({})
    property var fileRevs: ({})
    readonly property string selfId: { for (const person of people) if (person.self === true) return person.id; return "" }
    readonly property bool mineOnly: selfId !== "" && personFilter === selfId
    readonly property string query: filterField.text.trim().toLocaleLowerCase()
    readonly property var shown: actions.filter(function(action){
        return !query || [action.text, action.owner, action.title].join(" ").toLocaleLowerCase().indexOf(query) >= 0
    })
    readonly property var rows: buildRows(shown, groupBy, orphansOpen)
    readonly property bool wide: width >= 980

    function load() {
        if (!feature("actions") || !backend.available) return
        listGeneration += 1; loading = true; error = ""
        const payload = {status: statusFilter}
        if (personFilter) payload.personId = personFilter
        if (clientFilter) payload.clientCode = clientFilter
        if (send("actions-list", "", payload, {origin: "actions", listGeneration: listGeneration}) < 0) { loading = false; error = t("Sem conexão com o FalaTrace.") }
        if (!lookupsRequested) {
            lookupsRequested = true
            if (feature("people")) send("people-list", "", ({}), {origin: "actions", lookup: true})
            if (feature("clients")) send("clients-list", "", ({}), {origin: "actions", lookup: true})
        }
    }
    onVisibleChanged: if (visible) { load(); Qt.callLater(function(){ actionList.forceActiveFocus(Qt.OtherFocusReason) }) }
    Timer { interval: 4000; repeat: false; running: actionsView.visible && actionsView.refreshing && !actionsView.loading; onTriggered: actionsView.load() }

    function handleResponse(request, message) {
        if (request.lookup) {
            if (!message.ok) return
            if (request.op === "people-list") people = asList(message.result.people)
            else if (request.op === "clients-list") clients = asList(message.result.clients)
            return
        }
        if (request.op === "action-set") { answered(request, message); return }
        if (request.listGeneration !== listGeneration) return
        loading = false
        if (!message.ok) { error = t("Não deu para carregar as ações."); return }
        const result = message.result
        actions = asList(result.items); counts = result.counts || ({}); truncated = result.truncated === true; loaded = true
        refreshing = result.refreshing === true
        indexRefreshSeen(refreshing)
        actionState = ({})
    }
    function connectionLost() {
        loading = false
        const next = Object.assign({}, actionState)
        for (const id in next) if (next[id].pending) next[id] = Object.assign({}, next[id], {pending: false})
        actionState = next
    }

    function clientName(code) { for (const client of clients) if (client.code === code) return client.name; return code }
    function personName(id) { for (const person of people) if (person.id === id) return person.name; return "" }
    function dayOf(value) { const date = new Date(value); return isNaN(date.getTime()) ? "" : Qt.formatDate(date, t("dd/MM")) }
    function buildRows(list, grouping, openOrphans) {
        const current = list.filter(function(action){ return action.matchState !== "orphaned" })
        const orphans = list.filter(function(action){ return action.matchState === "orphaned" })
        const groups = [], byKey = ({})
        for (const action of current) {
            let key, label, jobId = ""
            if (grouping === "client") { key = asList(action.clientCodes)[0] || ""; label = key ? clientName(key) : t("Sem cliente") }
            else if (grouping === "person") { key = action.owner || ""; label = key || t("Sem responsável") }
            else { key = action.jobId; label = (action.title || t("Reunião")) + (action.date ? " · " + dayOf(action.date) : ""); jobId = action.jobId }
            if (!byKey[key]) { byKey[key] = {key: key, label: label, jobId: jobId, at: timeValue(action.date), items: []}; groups.push(byKey[key]) }
            byKey[key].items.push(action)
        }
        if (grouping === "meeting") groups.sort(function(a, b){ return b.at - a.at })
        else groups.sort(function(a, b){ return a.key === "" ? 1 : b.key === "" ? -1 : a.label.localeCompare(b.label) })
        const result = []
        for (const group of groups) {
            result.push({kind: "group", key: group.key, label: group.label, jobId: group.jobId, count: group.items.length})
            for (const action of group.items) result.push({kind: "action", action: action})
        }
        if (orphans.length) {
            result.push({kind: "orphans", count: orphans.length})
            if (openOrphans) for (const action of orphans) result.push({kind: "action", action: action, orphan: true})
        }
        return result
    }

    function statusOf(action) { const state = actionState[action.actionId]; return state ? state.status : action.status }
    function filePending(sha) { for (const id in actionState) if (actionState[id].pending && actionState[id].sha === sha) return true; return false }
    function editable(action) { return !!action && backend.available && !filePending(action.mediaSha256) }
    function setStatus(action, status) {
        if (!editable(action) || statusOf(action) === status) return
        const previous = statusOf(action)
        const rev = Math.max(Number(action.rev) || 0, Number(fileRevs[action.mediaSha256]) || 0)
        const next = Object.assign({}, actionState); next[action.actionId] = {status: status, pending: true, sha: action.mediaSha256}; actionState = next
        const meta = {origin: "actions", actionId: action.actionId, sha: action.mediaSha256, previousStatus: previous, requestedStatus: status}
        if (send("action-set", "", {mediaSha256: action.mediaSha256, actionId: action.actionId, status: status, expectedRev: rev}, meta) < 0) answered(meta, {ok: false, error: t("Sem conexão com o FalaTrace.")})
    }
    function toggle(action) { setStatus(action, statusOf(action) === "done" ? "open" : "done") }
    function answered(request, message) {
        const next = Object.assign({}, actionState)
        if (!message.ok) {
            next[request.actionId] = {status: request.previousStatus, pending: false, sha: request.sha}; actionState = next
            const changed = message.error === "As ações mudaram em outra janela; recarregue e tente de novo."
            toast.show(changed ? t("Essa ação mudou em outra janela; atualizei.") : t(message.error), "", null, {kind: "warning"})
            if (changed) load()
            return
        }
        next[request.actionId] = {status: request.requestedStatus, pending: false, sha: request.sha}; actionState = next
        const revs = Object.assign({}, fileRevs); revs[request.sha] = Number(message.result.rev) || 0; fileRevs = revs
        const action = actions.find(function(item){ return item.actionId === request.actionId })
        if (!action || request.undo) return
        if (request.requestedStatus === "done") toast.show(t("Ação concluída"), t("Desfazer"), function() { actionsView.undo(action, request.previousStatus) })
        else if (request.requestedStatus === "dismissed") toast.show(t("Ação descartada"), t("Desfazer"), function() { actionsView.undo(action, request.previousStatus) })
    }
    function undo(action, status) {
        if (!editable(action)) return
        const previous = statusOf(action)
        const rev = Math.max(Number(action.rev) || 0, Number(fileRevs[action.mediaSha256]) || 0)
        const next = Object.assign({}, actionState); next[action.actionId] = {status: status, pending: true, sha: action.mediaSha256}; actionState = next
        send("action-set", "", {mediaSha256: action.mediaSha256, actionId: action.actionId, status: status, expectedRev: rev},
             {origin: "actions", actionId: action.actionId, sha: action.mediaSha256, previousStatus: previous, requestedStatus: status, undo: true})
    }
    function openAt(action) { openMeetingAt(action.jobId, asList(action.segmentIds)[0] || "", typeof action.start === "number" ? action.start : -1) }
    function rowAction(index) { const row = rows[index]; return row && row.kind === "action" ? row.action : null }

    ColumnLayout {
        anchors.fill: parent
        anchors.leftMargin: compactLayout ? 16 : 28; anchors.rightMargin: compactLayout ? 16 : 28
        anchors.topMargin: compactLayout ? 16 : 24; anchors.bottomMargin: 12
        spacing: 12

        RowLayout {
            Layout.fillWidth: true
            spacing: 12
            Label { text: t("Ações"); textFormat: Text.PlainText; color: ink; font.pixelSize: compactLayout ? 22 : 26; font.weight: Font.DemiBold }
            FtSegmented {
                id: statusSegments
                objectName: "actionsFilter"
                compact: true
                showIcons: false
                accessibleName: t("Quais ações mostrar")
                currentIndex: actionsView.statusFilter === "done" ? 1 : actionsView.statusFilter === "all" ? 2 : 0
                model: [{value: 0, label: actionsView.counts.open !== undefined ? tf("Abertas (%1)", actionsView.counts.open) : t("Abertas")}, {value: 1, label: t("Feitas")}, {value: 2, label: t("Todas")}]
                onActivated: value => { actionsView.statusFilter = value === 1 ? "done" : value === 2 ? "all" : "open"; actionsView.load() }
            }
            Item { Layout.fillWidth: true }
            BusyIndicator { visible: actionsView.loading; running: visible; implicitWidth: 22; implicitHeight: 22 }
        }
        // Filters: mine, person, client, grouping and text.
        Flow {
            Layout.fillWidth: true
            spacing: 8
            FtButton {
                objectName: "actionsMine"
                compact: true
                variant: actionsView.mineOnly ? "secondary" : "outline"
                iconName: "user"
                text: t("Só minhas")
                visible: actionsView.selfId !== ""
                Accessible.name: text + (actionsView.mineOnly ? t(", ligado") : t(", desligado"))
                onClicked: { actionsView.personFilter = actionsView.mineOnly ? "" : actionsView.selfId; actionsView.load() }
            }
            FtComboBox {
                objectName: "actionsPersonFilter"
                visible: actionsView.people.length > 0
                implicitWidth: 180; implicitHeight: 32
                textRole: "label"; valueRole: "value"
                model: [{label: t("Todas as pessoas"), value: ""}].concat(actionsView.people.map(function(person){ return {label: person.name, value: person.id} }))
                currentIndex: Math.max(0, model.findIndex(function(entry){ return entry.value === actionsView.personFilter }))
                Accessible.name: t("Pessoa")
                onActivated: index => { actionsView.personFilter = model[index].value; actionsView.load() }
            }
            FtComboBox {
                objectName: "actionsClientFilter"
                visible: actionsView.clients.length > 0
                implicitWidth: 180; implicitHeight: 32
                textRole: "label"; valueRole: "value"
                model: [{label: t("Todos os clientes"), value: ""}].concat(actionsView.clients.map(function(client){ return {label: client.name, value: client.code} }))
                currentIndex: Math.max(0, model.findIndex(function(entry){ return entry.value === actionsView.clientFilter }))
                Accessible.name: t("Cliente")
                onActivated: index => { actionsView.clientFilter = model[index].value; actionsView.load() }
            }
            FtComboBox {
                objectName: "actionsGroupBy"
                implicitWidth: 190; implicitHeight: 32
                textRole: "label"; valueRole: "value"
                model: [{label: t("Agrupar por reunião"), value: "meeting"}, {label: t("Agrupar por cliente"), value: "client"}, {label: t("Agrupar por responsável"), value: "person"}]
                currentIndex: Math.max(0, model.findIndex(function(entry){ return entry.value === actionsView.groupBy }))
                Accessible.name: t("Agrupar")
                onActivated: index => actionsView.groupBy = model[index].value
            }
            FtTextField { id: filterField; objectName: "actionsTextFilter"; implicitWidth: 200; implicitHeight: 32; leadingIcon: "filter"; placeholderText: t("Filtrar…"); Accessible.name: t("Filtrar ações") }
        }
        Label { visible: actionsView.refreshing; text: t("Atualizando — reuniões recentes podem faltar."); textFormat: Text.PlainText; color: muted; font.pixelSize: 12 }
        Label { visible: actionsView.truncated; text: t("Mostrando as primeiras 500 ações; use os filtros para ver as outras."); textFormat: Text.PlainText; color: muted; font.pixelSize: 12 }

        // Header row of the table.
        RowLayout {
            visible: actionsView.rows.length > 0
            Layout.fillWidth: true
            Layout.leftMargin: 8; Layout.rightMargin: 8
            spacing: 10
            Item { Layout.preferredWidth: 26 }
            FtOverline { text: t("Ação"); Layout.fillWidth: true }
            FtOverline { text: t("Responsável"); Layout.preferredWidth: 130 }
            FtOverline { text: t("Prazo"); Layout.preferredWidth: 90 }
            FtOverline { visible: actionsView.wide; text: t("Cliente"); Layout.preferredWidth: 110 }
            FtOverline { text: t("Reunião"); Layout.preferredWidth: compactLayout ? 120 : 170 }
            FtOverline { visible: actionsView.wide; text: t("Origem"); Layout.preferredWidth: 56 }
        }
        Rectangle { visible: actionsView.rows.length > 0; Layout.fillWidth: true; Layout.preferredHeight: 1; color: divider }

        ListView {
            id: actionList
            objectName: "actionsList"
            visible: actionsView.rows.length > 0
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            model: actionsView.rows
            keyNavigationEnabled: true
            activeFocusOnTab: true
            boundsBehavior: Flickable.StopAtBounds
            Accessible.role: Accessible.List
            Accessible.name: t("Ações")
            ScrollBar.vertical: ScrollBar {}
            onActiveFocusChanged: if (activeFocus && currentIndex < 0 && count > 0) currentIndex = Math.min(1, count - 1)
            Keys.onPressed: event => {
                const action = actionsView.rowAction(currentIndex)
                const row = actionsView.rows[currentIndex]
                if ((event.key === Qt.Key_Space || event.key === Qt.Key_X) && action) { actionsView.toggle(action); event.accepted = true }
                else if (event.key === Qt.Key_D && action) { actionsView.setStatus(action, "dismissed"); event.accepted = true }
                else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                    if (action) actionsView.openAt(action)
                    else if (row && row.kind === "orphans") actionsView.orphansOpen = !actionsView.orphansOpen
                    else if (row && row.jobId) openMeetingAt(row.jobId, "", -1)
                    event.accepted = true
                }
            }
            delegate: Item {
                id: rowItem
                required property var modelData
                required property int index
                readonly property bool isAction: modelData.kind === "action"
                readonly property var action: isAction ? modelData.action : null
                readonly property string status: isAction ? actionsView.statusOf(action) : ""
                readonly property bool current: ListView.isCurrentItem && actionList.activeFocus
                objectName: isAction ? "actionRow-" + action.actionId : modelData.kind === "orphans" ? "actionsOrphans" : "actionGroup-" + index
                width: ListView.view.width
                height: isAction ? Math.max(38, actionLine.implicitHeight + 12) : groupLine.implicitHeight + (index === 0 ? 6 : 16)
                Accessible.role: isAction ? Accessible.ListItem : Accessible.Heading
                Accessible.name: isAction ? (action.origin === "note" ? t("Sua nota: ") : t("Completado pela IA: ")) + action.text + (status === "done" ? t(", concluída") : status === "dismissed" ? t(", descartada") : "") : groupLabel.text
                Rectangle {
                    anchors.fill: parent
                    anchors.topMargin: rowItem.isAction ? 0 : (rowItem.index === 0 ? 0 : 8)
                    radius: 8
                    color: rowItem.isAction && rowMouse.containsMouse ? hoverSurface : "transparent"
                    border.width: rowItem.current ? 2 : 0
                    border.color: accent
                }
                MouseArea { id: rowMouse; anchors.fill: parent; hoverEnabled: true; acceptedButtons: Qt.LeftButton; onClicked: { actionList.currentIndex = rowItem.index; actionList.forceActiveFocus(Qt.MouseFocusReason) } }
                // Group header: the meeting (opens it), the client or the person.
                RowLayout {
                    id: groupLine
                    visible: !rowItem.isAction
                    anchors.left: parent.left; anchors.right: parent.right; anchors.bottom: parent.bottom
                    anchors.leftMargin: 8; anchors.rightMargin: 8; anchors.bottomMargin: 2
                    spacing: 8
                    FtIcon { name: rowItem.modelData.kind === "orphans" ? (actionsView.orphansOpen ? "chevron-down" : "chevron-right") : actionsView.groupBy === "client" ? "building" : actionsView.groupBy === "person" ? "user" : "note"; tint: muted; size: 14 }
                    Label {
                        id: groupLabel
                        text: rowItem.modelData.kind === "orphans" ? tf("Não aparecem mais nas notas atuais (%1)", rowItem.modelData.count) : (rowItem.modelData.label || "")
                        textFormat: Text.PlainText; color: rowItem.modelData.kind === "orphans" ? muted : ink; font.pixelSize: 13; font.weight: Font.DemiBold; elide: Text.ElideRight
                        Layout.fillWidth: !rowItem.modelData.jobId
                    }
                    FtButton {
                        visible: !!rowItem.modelData.jobId
                        compact: true; variant: "ghost"; implicitHeight: 26; iconName: "chevron-right"
                        text: t("Abrir")
                        Accessible.name: tf("Abrir a reunião %1", rowItem.modelData.label || "")
                        enabled: !!findMeeting(rowItem.modelData.jobId)
                        onClicked: openMeetingAt(rowItem.modelData.jobId, "", -1)
                    }
                    Item { visible: !!rowItem.modelData.jobId; Layout.fillWidth: true }
                    FtButton { visible: rowItem.modelData.kind === "orphans"; compact: true; variant: "ghost"; implicitHeight: 26; text: actionsView.orphansOpen ? t("Esconder") : t("Mostrar"); onClicked: actionsView.orphansOpen = !actionsView.orphansOpen }
                }
                // Action row: ☐ · text · owner · due · client · meeting · origin.
                RowLayout {
                    id: actionLine
                    visible: rowItem.isAction
                    anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                    anchors.leftMargin: 8; anchors.rightMargin: 8
                    spacing: 10
                    opacity: rowItem.modelData.orphan ? 0.7 : 1
                    FtCheck {
                        objectName: rowItem.isAction ? "actionCheck-" + rowItem.action.actionId : ""
                        Layout.preferredWidth: 26
                        checked: rowItem.status === "done"
                        enabled: rowItem.isAction && actionsView.editable(rowItem.action)
                        focusPolicy: Qt.NoFocus
                        text: rowItem.isAction ? (checked ? t("Reabrir a ação: ") : t("Concluir a ação: ")) + rowItem.action.text : ""
                        onToggled: actionsView.toggle(rowItem.action)
                    }
                    Label {
                        Layout.fillWidth: true
                        text: rowItem.isAction ? rowItem.action.text : ""
                        textFormat: Text.PlainText
                        wrapMode: rowItem.current ? Text.Wrap : Text.NoWrap
                        maximumLineCount: rowItem.current ? 3 : 1
                        elide: Text.ElideRight
                        font.pixelSize: 14
                        font.weight: rowItem.isAction && rowItem.action.origin === "note" ? Font.Medium : Font.Normal
                        font.strikeout: rowItem.status === "done" || rowItem.status === "dismissed"
                        color: rowItem.status === "done" || rowItem.status === "dismissed" ? muted : rowItem.isAction && rowItem.action.origin === "note" ? noteInk : aiInk
                    }
                    Label { Layout.preferredWidth: 130; text: rowItem.isAction ? rowItem.action.owner || "—" : ""; textFormat: Text.PlainText; color: ink; font.pixelSize: 13; elide: Text.ElideRight }
                    Label { Layout.preferredWidth: 90; text: rowItem.isAction ? rowItem.action.dueDate || "—" : ""; textFormat: Text.PlainText; color: muted; font.pixelSize: 13; elide: Text.ElideRight }
                    Label { visible: actionsView.wide; Layout.preferredWidth: 110; text: rowItem.isAction && asList(rowItem.action.clientCodes).length ? actionsView.clientName(asList(rowItem.action.clientCodes)[0]) : "—"; textFormat: Text.PlainText; color: muted; font.pixelSize: 13; elide: Text.ElideRight }
                    FtButton {
                        Layout.preferredWidth: compactLayout ? 120 : 170
                        compact: true; variant: "ghost"; implicitHeight: 28
                        iconName: rowItem.isAction && typeof rowItem.action.start === "number" ? "play" : "note"
                        text: rowItem.isAction ? (rowItem.action.title || "") + (rowItem.action.date ? " " + actionsView.dayOf(rowItem.action.date) : "") : ""
                        Accessible.name: rowItem.isAction ? tf("Abrir a reunião %1 neste momento", rowItem.action.title || "") : ""
                        enabled: rowItem.isAction && !!findMeeting(rowItem.action.jobId)
                        focusPolicy: Qt.NoFocus
                        onClicked: actionsView.openAt(rowItem.action)
                    }
                    Item {
                        visible: actionsView.wide
                        Layout.preferredWidth: 56; Layout.preferredHeight: 20
                        FtIcon { anchors.verticalCenter: parent.verticalCenter; name: rowItem.isAction && rowItem.action.origin === "note" ? "edit" : "spark"; tint: rowItem.isAction && rowItem.action.origin === "note" ? noteInk : aiInk; size: 14 }
                        HoverHandler { id: originHover }
                        ToolTip.visible: originHover.hovered
                        ToolTip.text: rowItem.isAction && rowItem.action.origin === "note" ? t("Das suas notas") : t("Completado pela IA")
                    }
                    FtButton {
                        objectName: rowItem.isAction ? "actionDismiss-" + rowItem.action.actionId : ""
                        iconOnly: true; compact: true; variant: "ghost"; implicitHeight: 28
                        iconName: "close"
                        text: t("Descartar (d)")
                        visible: rowItem.isAction && rowItem.status === "open" && (rowMouse.containsMouse || rowItem.current)
                        enabled: rowItem.isAction && actionsView.editable(rowItem.action)
                        focusPolicy: Qt.NoFocus
                        onClicked: actionsView.setStatus(rowItem.action, "dismissed")
                    }
                }
            }
        }

        FtEmptyState {
            objectName: "actionsEmpty"
            Layout.fillWidth: true
            Layout.topMargin: 40
            visible: actionsView.loaded && !actionsView.loading && actionsView.rows.length === 0 && !actionsView.error
            iconName: "list-check"
            title: actionsView.statusFilter === "open" ? t("Nenhuma ação aberta.") : t("Nenhuma ação por aqui.")
            body: t("Elas aparecem quando as notas de uma reunião ficam prontas. Escreva “[ ] ” nas suas notas para criar uma.")
        }
        FtEmptyState {
            objectName: "actionsError"
            Layout.fillWidth: true
            Layout.topMargin: 40
            visible: !!actionsView.error && !actionsView.loading
            iconName: "alert"
            title: actionsView.error
            primaryText: t("Tentar de novo")
            primaryEnabled: backend.available
            onPrimaryClicked: actionsView.load()
        }
        Label { visible: actionsView.rows.length > 0; text: t("Espaço ou x: concluir · d: descartar · Enter: abrir a reunião"); textFormat: Text.PlainText; color: muted; font.pixelSize: 11 }
        Item { Layout.fillHeight: true; visible: actionsView.rows.length === 0 }
    }
}
