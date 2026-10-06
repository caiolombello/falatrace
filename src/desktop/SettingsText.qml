import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// A settings text field. `nullable` turns an empty field into null (the key is removed);
// `list` edits a comma-separated list of codes; `picker` adds a file or folder chooser
// when the platform file dialogs are available.
ColumnLayout {
    id:textControl
    property string field: ""
    property string label: ""
    property string placeholder: ""
    property string hint: ""
    property bool nullable: false
    property bool list: false
    property string picker: ""
    property string pickerTitle: label
    Layout.fillWidth:true; spacing:4
    function display(value) {
        if (value === undefined || value === null) return ""
        return textControl.list && Array.isArray(value) ? value.join(", ") : String(value)
    }
    function parse(text) {
        const trimmed = text.trim()
        if (textControl.list) return trimmed ? trimmed.split(",").map(function(item){ return item.trim().toLowerCase() }).filter(function(item){ return item.length > 0 }) : []
        return trimmed === "" && textControl.nullable ? null : trimmed
    }
    Label { text:textControl.label; color:ink; font.pixelSize:13; wrapMode:Text.WordWrap; Layout.fillWidth:true }
    RowLayout {
        Layout.fillWidth:true; spacing:8
        FtTextField {
            id:textInput
            Layout.fillWidth:true; maximumLength:4096
            text:textControl.display(settingsDraft[textControl.field])
            placeholderText:textControl.placeholder
            enabled:settingsEditable
            onTextEdited:setSettingsField(textControl.field, textControl.parse(text))
            Accessible.name:textControl.label
        }
        FtButton {
            visible:!!textControl.picker && settingsDialog.pickerAvailable
            text:"Escolher…"; variant:"outline"; compact:true
            enabled:settingsEditable
            onClicked:settingsDialog.choosePath(textControl.picker, textControl.pickerTitle, textInput.text, function(path){ setSettingsField(textControl.field, path) })
        }
    }
    SettingsHint { visible:!!textControl.hint; text:textControl.hint }
}
