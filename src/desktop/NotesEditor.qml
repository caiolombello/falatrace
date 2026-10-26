import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// The notepad (DESIGN-STUDIO §2.8): plain text with a time gutter. While a capture runs, each line
// gets the moment it was written (from the saved entries, placed with positionToRectangle so wrapped
// lines line up). It saves 800 ms after typing stops, right away on Enter, on blur and before Parar,
// always with the revision it read (notes-save expectedRev). Replies arrive through handleResponse;
// failures stay here (save state line), never in errorText or notice.
FocusScope {
    id: editor
    objectName: "notesEditor"
    // Capture session id (live) or job id (after the meeting): a UUID.
    property string notesKey: ""
    // Routing name for Main.familyOwner().
    property string origin: "meetingNotes"
    property bool live: false
    // Title saved with the notes (the live view names untitled meetings).
    property bool sendTitle: false
    property string title: ""
    property string placeholder: t("Anote o que importa. O FalaTrace completa o resto.")
    property alias area: area
    property alias flick: flick
    // State.
    property string activeKey: ""
    property int notesGeneration: 0
    property int rev: 0
    property var entries: []
    property string savedText: ""
    property string savedTitle: ""
    property string pendingText: ""
    property string pendingTitle: ""
    property var updatedAt: null
    property bool loaded: false
    property bool loading: false
    property bool saving: false
    property bool saveQueued: false
    property bool conflict: false
    property string saveError: ""
    property string loadError: ""
    // Text typed while a save was on its way when the notepad switched to other notes: it is sent
    // for the previous notes as soon as that save answers (with the revision it returns).
    property var flush: null
    readonly property bool dirty: loaded && (area.text !== savedText || (sendTitle && title !== savedTitle))
    readonly property bool available: feature("notes") && !!notesKey
    signal savedNow()

    function reset() {
        notesGeneration += 1
        saveTimer.stop(); retryTimer.stop()
        loaded = false; loading = false; saving = false; saveQueued = false; conflict = false; saveError = ""; loadError = ""
        rev = 0; entries = []; savedText = ""; savedTitle = ""; pendingText = ""; updatedAt = null
        if (sendTitle) title = ""
        area.text = ""
    }
    function load() {
        reset()
        activeKey = notesKey
        // Read the inputs directly: inside onNotesKeyChanged the `available` binding may not have caught up yet.
        if (!feature("notes") || !notesKey) return
        if (!backend.available) { loadError = t("Sem conexão com o FalaTrace."); return }
        loading = true
        if (send("notes-read", activeKey, ({}), {origin: origin, notesGeneration: notesGeneration}) < 0) { loading = false; loadError = t("Sem conexão com o FalaTrace.") }
    }
    function saveSoon(immediate) {
        if (!loaded) return
        if (immediate) { saveTimer.stop(); Qt.callLater(save) } else saveTimer.restart()
    }
    function saveNow() { saveTimer.stop(); save() }
    function save() {
        if (!loaded || !activeKey || !feature("notes") || conflict) return
        if (saving) { saveQueued = true; return }
        if (!dirty) return
        if (!backend.available) { saveError = t("Sem conexão com o FalaTrace."); retryTimer.restart(); return }
        pendingText = area.text; pendingTitle = title
        const payload = {text: pendingText, expectedRev: rev}
        if (sendTitle) payload.title = pendingTitle
        saving = true; saveQueued = false; saveError = ""
        if (send("notes-save", activeKey, payload, {origin: origin, notesGeneration: notesGeneration}) < 0) { saving = false; saveError = t("Sem conexão com o FalaTrace."); retryTimer.restart() }
    }
    function applyNotes(result) {
        rev = Number(result.rev) || 0
        entries = asList(result.entries)
        updatedAt = result.updatedAt || null
    }
    function handleResponse(request, message) {
        if (request.op === "notes-save" && flush && request.key === flush.key && request.notesGeneration === flush.notesGeneration) {
            const last = flush
            flush = null
            if (message.ok) {
                const payload = {text: last.text, expectedRev: Number(message.result.rev) || 0}
                if (last.sendTitle) payload.title = last.title
                send("notes-save", last.key, payload, {origin: origin, notesGeneration: -1})
            }
            return
        }
        if (request.notesGeneration !== notesGeneration) return
        if (request.op === "notes-read") {
            loading = false
            if (!message.ok) { loadError = t(message.error); return }
            applyNotes(message.result)
            area.text = message.result.text || ""
            savedText = area.text
            if (sendTitle && typeof message.result.title === "string" && !title) title = message.result.title
            savedTitle = sendTitle ? (message.result.title || "") : ""
            loaded = true
            if (sendTitle && title !== savedTitle) saveSoon(false)
            return
        }
        if (request.op !== "notes-save") return
        saving = false
        if (!message.ok) {
            if (message.error === "As notas mudaram em outra janela; recarregue antes de salvar.") conflict = true
            else { saveError = t(message.error); retryTimer.restart() }
            return
        }
        applyNotes(message.result)
        savedText = pendingText; savedTitle = pendingTitle; saveError = ""
        savedNow()
        if (saveQueued || dirty) saveSoon(true)
    }
    function connectionLost() {
        flush = null
        if (loading) { loading = false; loadError = t("Sem conexão com o FalaTrace.") }
        if (saving) { saving = false; saveError = t("Não deu para confirmar se salvou. Recarregue e confira."); retryTimer.restart() }
    }
    function saveStateText() {
        if (!available) return ""
        if (loading) return t("Carregando…")
        if (loadError) return loadError
        if (conflict) return t("Estas notas mudaram em outra janela.")
        if (saving || (dirty && saveTimer.running)) return t("Salvando…")
        if (saveError) return t("Não salvo · tentando de novo")
        if (dirty) return t("Alterações ainda não salvas")
        const at = updatedAt ? new Date(updatedAt) : null
        return at && !isNaN(at.getTime()) ? tf("Salvo às %1", Qt.formatTime(at, "HH:mm")) : (savedText ? t("Salvo") : "")
    }
    // The saved time of each non-empty line, matched in order to the saved entries ("·" = not saved yet).
    function gutterModel() {
        const text = area.text, lines = text.split("\n"), list = entries, rows = []
        let offset = 0, next = 0
        for (let index = 0; index < lines.length; index++) {
            const line = lines[index].replace(/\s+$/, "")
            if (line.trim()) {
                let label = "·"
                for (let candidate = next; candidate < list.length; candidate++) {
                    if (list[candidate].text === line) { label = list[candidate].at || ""; next = candidate + 1; break }
                }
                rows.push({position: offset, label: label})
            }
            offset += lines[index].length + 1
        }
        return rows
    }
    // Toggles a Markdown prefix ("# ", "- ", "[ ] ") on the line under the cursor.
    function togglePrefix(prefix) {
        if (area.readOnly) return
        const text = area.text, position = area.cursorPosition
        const start = text.lastIndexOf("\n", position - 1) + 1
        let end = text.indexOf("\n", position)
        if (end < 0) end = text.length
        const line = text.slice(start, end)
        const existing = line.match(/^(#{1,6} |[-*] |\[[ xX]\] )/)
        const body = existing ? line.slice(existing[1].length) : line
        const next = existing && existing[1].replace("x", " ").replace("X", " ") === prefix ? body : prefix + body
        area.remove(start, end)
        area.insert(start, next)
        area.cursorPosition = start + next.length
        saveSoon(false)
    }
    // Enter starts a new line and saves now (so its time is the moment it was typed); a list or an
    // action line continues on the next line, and an empty item ends the list.
    function newLine() {
        if (area.selectedText) area.remove(area.selectionStart, area.selectionEnd)
        const text = area.text, position = area.cursorPosition
        const start = text.lastIndexOf("\n", position - 1) + 1
        const line = text.slice(start, position)
        const prefix = line.match(/^(\s*)([-*] |\[[ xX]\] )/)
        if (prefix && line.trim() === prefix[2].trim()) { area.remove(start, position); saveSoon(true); return }
        const carry = prefix ? prefix[1] + (prefix[2].charAt(0) === "[" ? "[ ] " : prefix[2]) : ""
        area.insert(position, "\n" + carry)
        saveSoon(true)
    }
    function revealCursor() {
        const rect = area.cursorRectangle
        const top = rect.y, bottom = rect.y + rect.height + 12
        if (top < flick.contentY) flick.contentY = Math.max(0, top - 8)
        else if (bottom > flick.contentY + flick.height) flick.contentY = Math.min(Math.max(0, flick.contentHeight - flick.height), bottom - flick.height)
    }

    onNotesKeyChanged: {
        // Typed text of the previous meeting is saved before the notepad switches; while a save of it
        // is still on its way, the rest follows that save (handleResponse).
        if (dirty && activeKey && activeKey !== notesKey && loaded && !conflict) {
            if (saving) flush = {key: activeKey, text: area.text, title: title, sendTitle: sendTitle, notesGeneration: notesGeneration}
            else save()
        }
        load()
    }
    Component.onCompleted: load()
    onActiveFocusChanged: if (!activeFocus) saveNow()
    Timer { id: saveTimer; interval: 800; onTriggered: editor.save() }
    Timer { id: retryTimer; interval: 5000; onTriggered: editor.save() }

    ColumnLayout {
        anchors.fill: parent
        spacing: 6
        // Toolbar: heading, list, action; then the save state.
        RowLayout {
            Layout.fillWidth: true
            spacing: 2
            FtButton { objectName: "notesHeading"; iconOnly: true; compact: true; variant: "ghost"; iconName: "heading"; text: t("Título (Ctrl+Alt+1)"); Accessible.name: t("Transformar a linha em título"); enabled: editor.loaded && !area.readOnly; focusPolicy: Qt.TabFocus; onClicked: { editor.togglePrefix("# "); area.forceActiveFocus() } }
            FtButton { objectName: "notesBullet"; iconOnly: true; compact: true; variant: "ghost"; iconName: "list"; text: t("Lista (Ctrl+Alt+L)"); Accessible.name: t("Transformar a linha em item de lista"); enabled: editor.loaded && !area.readOnly; focusPolicy: Qt.TabFocus; onClicked: { editor.togglePrefix("- "); area.forceActiveFocus() } }
            FtButton { objectName: "notesAction"; iconOnly: true; compact: true; variant: "ghost"; iconName: "checklist"; text: t("Ação (Ctrl+Alt+A)"); Accessible.name: t("Transformar a linha em ação"); enabled: editor.loaded && !area.readOnly; focusPolicy: Qt.TabFocus; onClicked: { editor.togglePrefix("[ ] "); area.forceActiveFocus() } }
            Item { Layout.fillWidth: true }
            Label {
                id: saveStateLabel
                objectName: "notesSaveState"
                text: editor.saveStateText()
                textFormat: Text.PlainText
                color: editor.conflict || editor.saveError || editor.loadError ? warningColor : muted
                font.pixelSize: 12
                elide: Text.ElideRight
                Layout.maximumWidth: editor.width * 0.6
                Accessible.role: Accessible.StaticText
                Accessible.name: text
            }
            FtButton { objectName: "notesReload"; visible: editor.conflict || !!editor.loadError; compact: true; variant: "outline"; text: t("Recarregar"); onClicked: editor.load() }
        }
        Rectangle { Layout.fillWidth: true; Layout.preferredHeight: 1; color: divider }
        Flickable {
            id: flick
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            contentWidth: width
            contentHeight: Math.max(height, area.implicitHeight + 24)
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar {}
            Item {
                id: gutter
                x: 0; y: 0
                width: 52
                height: area.height
                Repeater {
                    model: editor.gutterModel()
                    delegate: Label {
                        required property var modelData
                        x: 0
                        width: gutter.width - 10
                        y: { area.contentHeight; area.width; area.text; return area.positionToRectangle(modelData.position).y + 2 }
                        text: modelData.label
                        textFormat: Text.PlainText
                        horizontalAlignment: Text.AlignRight
                        color: modelData.label === "·" ? dividerStrong : muted
                        font.pixelSize: 11
                        font.family: "monospace"
                        Accessible.ignored: true
                    }
                }
            }
            TextArea {
                id: area
                objectName: "notesEditorText"
                x: gutter.width
                width: flick.width - gutter.width - 8
                height: Math.max(implicitHeight, flick.height - 8)
                focus: true
                enabled: editor.available
                readOnly: !editor.loaded || editor.conflict
                textFormat: TextEdit.PlainText
                wrapMode: TextEdit.Wrap
                selectByMouse: true
                persistentSelection: true
                font.pixelSize: 15
                color: noteInk
                selectionColor: accent
                selectedTextColor: onAccent
                placeholderText: editor.loaded ? editor.placeholder : ""
                placeholderTextColor: muted
                leftPadding: 4; rightPadding: 4; topPadding: 2; bottomPadding: 8
                Accessible.name: editor.live ? t("Suas notas desta reunião") : t("Minhas notas")
                background: Item {}
                onTextChanged: if (editor.loaded && activeFocus) editor.saveSoon(false)
                onCursorRectangleChanged: if (activeFocus) editor.revealCursor()
                Keys.onReturnPressed: event => { editor.newLine(); event.accepted = true }
                Keys.onEnterPressed: event => { editor.newLine(); event.accepted = true }
                Keys.onEscapePressed: event => { editor.saveNow(); editor.focus = false; window.contentItem.forceActiveFocus(); event.accepted = true }
                // Tab moves on to the next control (Shift+Tab back): it never types a tab character in the notes.
                Keys.onTabPressed: event => { const next = nextItemInFocusChain(true); if (next) next.forceActiveFocus(Qt.TabFocusReason); event.accepted = true }
                Keys.onBacktabPressed: event => { const previous = nextItemInFocusChain(false); if (previous) previous.forceActiveFocus(Qt.BacktabFocusReason); event.accepted = true }
                Keys.onPressed: event => {
                    const control = (event.modifiers & Qt.ControlModifier) !== 0, alt = (event.modifiers & Qt.AltModifier) !== 0
                    if (control && !alt && event.key === Qt.Key_S) { editor.saveNow(); event.accepted = true }
                    else if (control && alt && event.key === Qt.Key_1) { editor.togglePrefix("# "); event.accepted = true }
                    else if (control && alt && event.key === Qt.Key_L) { editor.togglePrefix("- "); event.accepted = true }
                    else if (control && alt && event.key === Qt.Key_A) { editor.togglePrefix("[ ] "); event.accepted = true }
                }
            }
        }
    }
}
