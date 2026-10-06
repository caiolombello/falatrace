import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    id:textControl
    property string field: ""
    property string label: ""
    property string placeholder: ""
    Layout.fillWidth:true; spacing:4
    Label { text:textControl.label; color:ink; font.pixelSize:13; wrapMode:Text.WordWrap; Layout.fillWidth:true }
    FtTextField {
        Layout.fillWidth:true; maximumLength:4096
        text:settingsDraft[textControl.field]===undefined||settingsDraft[textControl.field]===null ? "" : String(settingsDraft[textControl.field])
        placeholderText:textControl.placeholder
        enabled:settingsEditable
        onTextEdited:setSettingsField(textControl.field, text.trim())
        Accessible.name:textControl.label
    }
}
