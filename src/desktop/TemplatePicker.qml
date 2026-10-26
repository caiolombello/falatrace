import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Template picker (DESIGN-STUDIO §2.6–2.7): opened from the template chip of the notes. Lists
// "Automático", the built-in templates and your own (templates-list), with the current one marked.
// Choosing saves the choice for this meeting (summary-prefs-save) and, when the meeting has notes,
// shows the regenerate bar ("Gerar de novo com “Postmortem”?"). Arrows move, Enter applies, Esc closes.
// Its requests fail into its own state; errorText and notice are never touched.
Popup {
    id: picker
    objectName: "templatePicker"
    property var templates: []
    property string defaultTemplate: ""
    property bool loading: false
    property string error: ""
    property int pickerGeneration: 0
    // The meeting's saved choice (summary-prefs-read) and the job it belongs to.
    property var prefs: ({})
    property string prefsKey: ""
    property string chosen: "auto"
    property string currentId: ""
    readonly property var options: [{id: "auto", name: t("Automático"), description: t("O FalaTrace escolhe pelo título da agenda ou pela conversa."), sectionTitles: []}].concat(templates)
    width: Math.min(440, window.width - 32)
    padding: 12
    modal: false
    focus: true
    closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside
    background: Rectangle { radius: 12; color: surface; border.width: 1; border.color: dividerStrong }

    function openFor(anchorItem) {
        pickerGeneration += 1; error = ""; prefs = ({})
        prefsKey = detail.jobId || ""
        const doc = detail.notesDoc && detail.notesDoc.version === 2 ? detail.notesDoc : null
        currentId = doc && doc.template ? (doc.template.id || "") : ""
        chosen = currentId || "auto"
        const point = anchorItem.mapToItem(picker.parent, 0, anchorItem.height + 6)
        x = Math.max(8, Math.min(point.x, picker.parent.width - width - 8))
        y = point.y
        open()
        if (!templates.length) {
            loading = true
            if (send("templates-list", "", ({}), {origin: "templates", pickerGeneration: pickerGeneration}) < 0) { loading = false; error = t("Sem conexão com o FalaTrace.") }
        }
        if (prefsKey) send("summary-prefs-read", prefsKey, ({}), {origin: "templates", pickerGeneration: pickerGeneration})
    }
    function optionFor(id) {
        for (const option of options) if (option.id === id) return option
        return null
    }
    // A meeting with notes asks first (the regenerate bar) and keeps the choice only once the notes
    // are made with it (Main's generateSummary calls saveChoice); Cancelar there changes nothing. A
    // meeting without notes yet keeps the choice for its first notes at once.
    readonly property bool canApply: !!optionFor(chosen) && (detail.review ? canRegenerate() : !!prefsKey && typeof prefs.rev === "number")
    function apply() {
        const option = optionFor(chosen)
        if (!option || !backend.available || !canApply) return
        const name = chosen === "auto" ? "" : option.name
        close()
        if (detail.review) requestRegenerate(chosen, name, "")
        else saveChoice(chosen, option.name, true)
    }
    // The template chosen for this meeting (summary-prefs-save, with the revision read when the picker opened).
    function saveChoice(templateId, name, announce) {
        if (!prefsKey || typeof prefs.rev !== "number" || String(detail.jobId || "").toLowerCase() !== String(prefsKey).toLowerCase() || !backend.available) {
            if (announce) toast.show(t("Não deu para guardar o modelo escolhido para esta reunião."), "", null, {kind: "warning"})
            return
        }
        const label = templateId === "auto" ? t("Automático") : (name || (optionFor(templateId) || {}).name || templateId)
        if (send("summary-prefs-save", prefsKey, {expectedRev: prefs.rev, templateId: templateId}, {origin: "templates", pickerGeneration: pickerGeneration, savedName: label, announce: announce === true}) < 0 && announce)
            toast.show(t("Não deu para guardar o modelo escolhido para esta reunião."), "", null, {kind: "warning"})
    }
    function handleResponse(request, message) {
        if (request.op === "summary-prefs-save") {
            // A choice saved for the meeting stays saved even if the picker moved on; a refusal is said.
            if (message.ok) {
                if (request.key === prefsKey) prefs = message.result
                if (request.announce) toast.show(tf("As próximas notas desta reunião usarão “%1”.", request.savedName), "", null)
            } else toast.show(t("Não deu para guardar o modelo escolhido para esta reunião."), "", null, {kind: "warning"})
            return
        }
        if (request.pickerGeneration !== pickerGeneration) return
        if (request.op === "templates-list") {
            loading = false
            if (!message.ok) { error = t("Não deu para carregar os modelos agora."); return }
            // A new model resets the list's index; that is not a choice.
            syncing = true
            templates = asList(message.result.templates).map(function(template){ return {id: template.id, name: template.name, description: template.description || "", sectionTitles: asList(template.sectionTitles), builtIn: template.builtIn === true} })
            defaultTemplate = message.result.default || ""
            syncing = false
            syncIndex()
        } else if (request.op === "summary-prefs-read") {
            if (!message.ok) return
            prefs = message.result
            if (!currentId && prefs.templateId) { chosen = prefs.templateId; syncIndex() }
        }
    }
    function connectionLost() { loading = false; pickerGeneration += 1 }
    function reasonText() {
        if (prefs.templateId) return t("Você escolheu o modelo desta reunião.")
        const doc = detail.notesDoc && detail.notesDoc.version === 2 ? detail.notesDoc : null
        if (!doc || !doc.template) return t("Escolha como organizar as notas desta reunião.")
        const template = doc.template
        return ({calendar: t("Escolhido pelo título da agenda."), keywords: t("Escolhido pelas palavras da conversa."), ai: t("Escolhido pela IA."), user: t("Você escolheu."), "default": t("O modelo padrão."), fallback: t("O modelo padrão.")})[template.source] || ""
    }
    // The list follows the choice; moving in the list changes the choice. Templates that arrive after
    // the picker opened move the list to the current template instead of resetting the choice.
    property bool syncing: false
    function syncIndex() {
        syncing = true
        optionList.currentIndex = Math.max(0, options.findIndex(function(option){ return option.id === picker.chosen }))
        syncing = false
    }
    onOpened: Qt.callLater(function(){ optionList.forceActiveFocus(Qt.PopupFocusReason); picker.syncIndex() })
    onClosed: { if (templateChipItem && templateChipItem.visible) templateChipItem.forceActiveFocus(Qt.TabFocusReason) }
    property Item templateChipItem: null

    contentItem: ColumnLayout {
        spacing: 8
        Label { text: t("Modelo das notas"); textFormat: Text.PlainText; color: ink; font.pixelSize: 15; font.weight: Font.DemiBold }
        Label { text: picker.reasonText(); textFormat: Text.PlainText; color: muted; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
        BusyIndicator { visible: picker.loading; running: visible; implicitWidth: 28; implicitHeight: 28; Layout.alignment: Qt.AlignHCenter }
        Label { visible: !!picker.error; text: picker.error; textFormat: Text.PlainText; color: warningColor; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
        ListView {
            id: optionList
            objectName: "templateOptions"
            Layout.fillWidth: true
            Layout.preferredHeight: Math.min(contentHeight, Math.max(160, window.height - 320))
            clip: true
            spacing: 2
            model: picker.options
            keyNavigationEnabled: true
            boundsBehavior: Flickable.StopAtBounds
            Accessible.role: Accessible.List
            Accessible.name: t("Modelos")
            ScrollBar.vertical: ScrollBar {}
            onCurrentIndexChanged: { if (!picker.syncing && currentIndex >= 0 && currentIndex < picker.options.length) picker.chosen = picker.options[currentIndex].id }
            Keys.onReturnPressed: picker.apply()
            Keys.onEnterPressed: picker.apply()
            delegate: ItemDelegate {
                id: optionRow
                required property var modelData
                required property int index
                readonly property bool chosenRow: picker.chosen === modelData.id
                objectName: "templateOption-" + modelData.id
                width: ListView.view.width
                hoverEnabled: true
                leftPadding: 10; rightPadding: 10; topPadding: 8; bottomPadding: 8
                Accessible.role: Accessible.RadioButton
                Accessible.checked: chosenRow
                Accessible.name: modelData.name + (modelData.id === picker.currentId ? t(", atual") : "") + ". " + modelData.description
                background: Rectangle {
                    radius: 8
                    color: optionRow.chosenRow ? selectedSurface : optionRow.hovered ? hoverSurface : "transparent"
                    border.width: optionRow.ListView.isCurrentItem && optionList.activeFocus ? 2 : 0
                    border.color: accent
                }
                contentItem: RowLayout {
                    spacing: 10
                    Rectangle {
                        Layout.alignment: Qt.AlignTop; Layout.topMargin: 2
                        implicitWidth: 16; implicitHeight: 16; radius: 8
                        color: "transparent"; border.width: 2; border.color: optionRow.chosenRow ? accent : dividerStrong
                        Rectangle { anchors.centerIn: parent; width: 8; height: 8; radius: 4; color: accent; visible: optionRow.chosenRow }
                    }
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 2
                        RowLayout {
                            spacing: 6
                            Label { text: optionRow.modelData.name; textFormat: Text.PlainText; color: ink; font.pixelSize: 14; font.weight: Font.Medium; elide: Text.ElideRight; Layout.fillWidth: true }
                            FtChip { visible: optionRow.modelData.id === picker.currentId; text: t("atual"); kind: "accent"; implicitHeight: 20 }
                        }
                        Label { visible: text !== ""; text: optionRow.modelData.description; textFormat: Text.PlainText; color: muted; font.pixelSize: 12; wrapMode: Text.WordWrap; maximumLineCount: 2; elide: Text.ElideRight; Layout.fillWidth: true }
                        Label { visible: optionRow.modelData.sectionTitles.length > 0; text: optionRow.modelData.sectionTitles.join(" · "); textFormat: Text.PlainText; color: aiInk; font.pixelSize: 11; elide: Text.ElideRight; Layout.fillWidth: true }
                    }
                }
                onClicked: { optionList.currentIndex = index; picker.chosen = modelData.id }
                onDoubleClicked: { picker.chosen = modelData.id; picker.apply() }
            }
        }
        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            FtButton { compact: true; variant: "ghost"; iconName: "settings"; text: t("Gerenciar modelos…"); enabled: backend.available; onClicked: { picker.close(); settingsDialog.open() } }
            Item { Layout.fillWidth: true }
            FtButton {
                objectName: "templateApply"
                compact: true; variant: "primary"
                text: detail.review ? t("Gerar de novo com este modelo") : t("Usar nas próximas notas")
                enabled: backend.available && picker.canApply
                onClicked: picker.apply()
            }
        }
    }
}
