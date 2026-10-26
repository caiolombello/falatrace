import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Left column: navigation, then the meetings grouped by day ("Agora" while recording, Hoje, Ontem,
// weekdays, dates). The search filters by title, file name, people and client; with library search
// available it can also look inside the transcripts and list the passages found.
Rectangle {
    id: sidebar
    property alias search: search
    property alias libraryView: libraryView
    property alias onboardingButton: onboardingButton
    property alias aboutButton: aboutButton
    property alias recordingControlsButton: recordingControlsButton
    // Library search (library-search): its own state; a failure never touches errorText or notice.
    property int searchGeneration: 0
    property string searchQuery: ""
    property var searchHits: []
    property bool searchBusy: false
    property string searchError: ""
    readonly property string query: search.text.trim()
    color: chrome
    Rectangle { anchors.top: parent.top; anchors.bottom: parent.bottom; anchors.right: parent.right; width: 1; color: divider }

    function runLibrarySearch() {
        if (!feature("librarySearch") || query.length < 2 || !backend.available) return
        searchGeneration += 1; searchQuery = query; searchHits = []; searchError = ""; searchBusy = true
        if (send("library-search", "", {query: query, limit: 20}, {origin: "librarySearch", searchGeneration: searchGeneration}) < 0) { searchBusy = false; searchError = t("Sem conexão com o FalaTrace.") }
    }
    function clearLibrarySearch() { searchGeneration += 1; searchQuery = ""; searchHits = []; searchError = ""; searchBusy = false }
    function handleResponse(request, message) {
        if (request.searchGeneration !== searchGeneration) return
        searchBusy = false
        if (!message.ok) { searchError = t("Não deu para buscar nas transcrições agora."); return }
        searchHits = asList(message.result.hits)
    }
    function connectionLost() { if (searchBusy) { searchBusy = false; searchError = t("Sem conexão com o FalaTrace.") } }
    function openHit(hit) {
        const item = items.find(function(entry){ return entry.key === hit.key })
        if (!item || !backend.available) return
        selectRecording(item)
        // The meeting may stay closed (a local save still unconfirmed): never seek the one that is open.
        if (selected.key !== item.key) return
        if (typeof hit.start === "number") openCitation(hit.segmentId || "", hit.start, false)
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 12
        anchors.rightMargin: 13
        spacing: 8

        // Navigation: one entry per place you come back to; later packages fill in the other views.
        ColumnLayout {
            Layout.fillWidth: true
            spacing: 2
            FtNavButton { id: navHome; objectName: "navHome"; iconName: "home"; text: t("Início"); current: currentView === "home"; badge: compactLayout ? "" : "Ctrl+1"; onClicked: { if (navigate("home")) navHome.forceActiveFocus() } }
            FtNavButton { objectName: "navActions"; visible: viewAvailable("actions"); iconName: "list-check"; text: t("Ações"); current: currentView === "actions"; badge: compactLayout ? "" : "Ctrl+2"; onClicked: navigate("actions") }
            FtNavButton { objectName: "navPeople"; visible: viewAvailable("people"); iconName: "user"; text: t("Pessoas"); current: currentView === "people"; badge: compactLayout ? "" : "Ctrl+3"; onClicked: navigate("people") }
            FtNavButton { objectName: "navClients"; visible: viewAvailable("clients"); iconName: "building"; text: t("Clientes"); current: currentView === "clients"; badge: compactLayout ? "" : "Ctrl+4"; onClicked: navigate("clients") }
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.topMargin: 6
            FtOverline { text: t("Reuniões"); Layout.fillWidth: true }
            Label { visible: !loading; text: String(items.length) + (libraryRefreshing ? t(" · atualizando…") : ""); textFormat: Text.PlainText; color: muted; font.pixelSize: 12 }
        }
        FtTextField {
            id: search
            Layout.fillWidth: true
            leadingIcon: "search"
            placeholderText: t("Buscar reuniões…") + (compactLayout ? "" : "  Ctrl+K")
            Accessible.name: t("Buscar reuniões")
            onTextChanged: sidebar.clearLibrarySearch()
            Keys.onReturnPressed: { if (filtered.length) selectRecording(filtered[0]); else sidebar.runLibrarySearch() }
            Keys.onEnterPressed: { if (filtered.length) selectRecording(filtered[0]); else sidebar.runLibrarySearch() }
            Keys.onDownPressed: { if (libraryView.count) { libraryView.forceActiveFocus(Qt.TabFocusReason); libraryView.currentIndex = 0 } }
            Keys.onEscapePressed: event => { if (text) { text = ""; event.accepted = true } else event.accepted = false }
        }

        // The capture in progress, above the list: one click back to its notes.
        ItemDelegate {
            id: liveRow
            objectName: "sidebarLiveRow"
            visible: liveAvailable()
            Layout.fillWidth: true
            hoverEnabled: true
            leftPadding: 12; rightPadding: 10; topPadding: 8; bottomPadding: 8
            Accessible.name: t("Gravando agora") + ", " + captureClock()
            background: Rectangle {
                radius: 9
                color: currentView === "live" ? recordingSoft : liveRow.hovered ? hoverSurface : "transparent"
                border.width: liveRow.visualFocus ? 2 : currentView === "live" ? 1 : 0
                border.color: liveRow.visualFocus ? accent : recordingColor
            }
            contentItem: ColumnLayout {
                spacing: 2
                FtOverline { text: t("Agora"); color: recordingColor }
                RowLayout {
                    spacing: 8
                    Rectangle { implicitWidth: 9; implicitHeight: 9; radius: 2; color: recordingColor }
                    Label { text: t("Gravando agora"); textFormat: Text.PlainText; color: ink; font.pixelSize: 14; font.weight: Font.Medium; Layout.fillWidth: true; elide: Text.ElideRight }
                    Label { text: captureClock(); textFormat: Text.PlainText; color: recordingColor; font.pixelSize: 12; font.family: "monospace" }
                }
            }
            onClicked: openLive()
        }

        BusyIndicator { Layout.alignment: Qt.AlignHCenter; running: loading && backend.available; visible: running }
        Label { visible: !loading && !filtered.length; text: items.length ? t("Nenhuma reunião corresponde à busca.") : t("Nenhuma reunião ainda."); textFormat: Text.PlainText; color: muted; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 13 }
        ListView {
            id: libraryView
            function followSelection() { currentIndex = Qt.binding(() => filtered.findIndex(item => item.key === selected.key)) }
            function openCurrent() { const item = filtered[currentIndex]; if (item && backend.available) selectRecording(item); followSelection() }
            currentIndex: filtered.findIndex(item => item.key === selected.key)
            Layout.fillWidth: true; Layout.fillHeight: true; clip: true; spacing: 1; model: filtered
            // Keyboard: Tab enters the list, arrows move, Enter or Space opens the meeting.
            activeFocusOnTab: count > 0
            keyNavigationEnabled: true
            boundsBehavior: Flickable.StopAtBounds
            Accessible.role: Accessible.List
            Accessible.name: t("Reuniões")
            Keys.onReturnPressed: openCurrent()
            Keys.onEnterPressed: openCurrent()
            Keys.onSpacePressed: openCurrent()
            Keys.onUpPressed: event => { if (currentIndex <= 0) { search.forceActiveFocus(Qt.TabFocusReason); event.accepted = true } else event.accepted = false }
            onActiveFocusChanged: { if (activeFocus && currentIndex < 0 && count > 0) currentIndex = 0; else if (!activeFocus) followSelection() }
            ScrollBar.vertical: ScrollBar {}
            delegate: Column {
                id: libraryEntry
                required property var modelData
                required property int index
                readonly property string group: dayGroup(modelData.modifiedAt)
                readonly property bool firstOfGroup: index === 0 || dayGroup(filtered[index - 1].modifiedAt) !== group
                width: ListView.view.width
                spacing: 0
                FtOverline { visible: libraryEntry.firstOfGroup; text: libraryEntry.group; leftPadding: 12; topPadding: libraryEntry.index === 0 ? 2 : 12; bottomPadding: 4 }
                MeetingRow {
                    id: libraryItem
                    item: libraryEntry.modelData
                    width: parent.width
                    enabled: backend.available
                    current: selected.key === libraryEntry.modelData.key
                    keyboardCurrent: libraryEntry.ListView.isCurrentItem && libraryView.activeFocus
                    onClicked: selectRecording(libraryEntry.modelData)
                }
            }
            footer: ColumnLayout {
                width: libraryView.width
                spacing: 4
                visible: sidebar.query.length >= 2 && (feature("librarySearch") || feature("assistant"))
                Item { implicitHeight: 6 }
                // Ask the whole library what was typed (Ask opens with the question in its input).
                ItemDelegate {
                    id: askFromSearch
                    objectName: "askFromSearch"
                    visible: feature("assistant")
                    Layout.fillWidth: true
                    hoverEnabled: true
                    enabled: backend.available
                    leftPadding: 12; rightPadding: 10; topPadding: 8; bottomPadding: 8
                    Accessible.name: tf("Perguntar à biblioteca: “%1”", sidebar.query)
                    background: Rectangle { radius: 9; color: askFromSearch.hovered ? hoverSurface : "transparent"; border.width: askFromSearch.visualFocus ? 2 : 1; border.color: askFromSearch.visualFocus ? accent : divider }
                    contentItem: RowLayout {
                        spacing: 8
                        FtIcon { name: "spark"; tint: accent; size: 15 }
                        Label { text: tf("Perguntar à biblioteca: “%1”", sidebar.query); textFormat: Text.PlainText; color: ink; font.pixelSize: 13; wrapMode: Text.Wrap; maximumLineCount: 2; elide: Text.ElideRight; Layout.fillWidth: true }
                    }
                    onClicked: askPanel.openWith({scope: {kind: "library"}, label: ""}, sidebar.query, null)
                }
                ItemDelegate {
                    id: searchTranscripts
                    objectName: "librarySearchButton"
                    visible: feature("librarySearch")
                    Layout.fillWidth: true
                    hoverEnabled: true
                    enabled: backend.available && !sidebar.searchBusy
                    leftPadding: 12; rightPadding: 10; topPadding: 8; bottomPadding: 8
                    Accessible.name: tf("Buscar “%1” nas transcrições", sidebar.query)
                    background: Rectangle { radius: 9; color: searchTranscripts.hovered ? hoverSurface : "transparent"; border.width: searchTranscripts.visualFocus ? 2 : 1; border.color: searchTranscripts.visualFocus ? accent : divider }
                    contentItem: RowLayout {
                        spacing: 8
                        FtIcon { name: "transcript"; tint: accent; size: 15 }
                        Label { text: tf("Buscar “%1” nas transcrições", sidebar.query); textFormat: Text.PlainText; color: ink; font.pixelSize: 13; wrapMode: Text.Wrap; maximumLineCount: 2; elide: Text.ElideRight; Layout.fillWidth: true }
                    }
                    onClicked: sidebar.runLibrarySearch()
                }
                BusyIndicator { Layout.alignment: Qt.AlignHCenter; visible: sidebar.searchBusy; running: visible; implicitWidth: 28; implicitHeight: 28 }
                Label { visible: !!sidebar.searchError; text: sidebar.searchError; textFormat: Text.PlainText; color: muted; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true; leftPadding: 12 }
                Label { visible: !sidebar.searchBusy && !sidebar.searchError && sidebar.searchQuery !== "" && sidebar.searchQuery === sidebar.query && !sidebar.searchHits.length; text: t("Nenhum trecho encontrado."); textFormat: Text.PlainText; color: muted; font.pixelSize: 12; leftPadding: 12 }
                FtOverline { visible: sidebar.searchHits.length > 0; text: sidebar.searchHits.length === 1 ? t("1 trecho") : tf("%1 trechos", sidebar.searchHits.length); leftPadding: 12; topPadding: 4 }
                Repeater {
                    model: sidebar.searchHits
                    delegate: ItemDelegate {
                        id: hitRow
                        required property var modelData
                        required property int index
                        objectName: "searchHit-" + index
                        Layout.fillWidth: true
                        hoverEnabled: true
                        leftPadding: 12; rightPadding: 10; topPadding: 6; bottomPadding: 8
                        Accessible.name: (hitRow.modelData.title || "") + ", " + (hitRow.modelData.snippet || "")
                        background: Rectangle { radius: 9; color: hitRow.hovered ? hoverSurface : "transparent"; border.width: hitRow.visualFocus ? 2 : 0; border.color: accent }
                        contentItem: ColumnLayout {
                            spacing: 2
                            RowLayout {
                                spacing: 6
                                Label { text: hitRow.modelData.title || ""; textFormat: Text.PlainText; color: ink; font.pixelSize: 13; font.weight: Font.Medium; elide: Text.ElideRight; Layout.fillWidth: true }
                                Label { visible: typeof hitRow.modelData.start === "number"; text: clock(hitRow.modelData.start || 0); textFormat: Text.PlainText; color: accent; font.pixelSize: 11; font.family: "monospace" }
                            }
                            Label { text: hitRow.modelData.snippet || ""; textFormat: Text.PlainText; color: muted; font.pixelSize: 12; wrapMode: Text.WordWrap; maximumLineCount: 2; elide: Text.ElideRight; Layout.fillWidth: true }
                        }
                        onClicked: sidebar.openHit(hitRow.modelData)
                    }
                }
            }
        }

        Rectangle { Layout.fillWidth: true; Layout.preferredHeight: 1; color: divider }
        RowLayout {
            Layout.fillWidth: true
            spacing: 2
            FtNavButton { id: onboardingButton; objectName: "onboardingButton"; iconName: "settings"; text: t("Configurações…"); enabled: backend.available; onClicked: settingsDialog.open() }
            FtButton { id: recordingControlsButton; objectName: "recordingControlsButton"; iconOnly: true; variant: "ghost"; iconName: "tools"; text: t("Gravação e tarefas…"); Accessible.name: text; onClicked: recordingTools.open() }
            FtButton { id: aboutButton; objectName: "aboutButton"; iconOnly: true; variant: "ghost"; iconName: "info"; text: t("Sobre o FalaTrace"); Accessible.name: text; onClicked: aboutDialog.open() }
        }
    }
}
