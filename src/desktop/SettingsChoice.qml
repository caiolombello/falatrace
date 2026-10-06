import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    id:choiceControl
    property string field: ""
    property string label: ""
    property var options: []
    property alias combo: choiceCombo
    Layout.fillWidth:true; spacing:4
    Label { text:choiceControl.label; color:ink; font.pixelSize:13; wrapMode:Text.WordWrap; Layout.fillWidth:true }
    FtComboBox {
        id:choiceCombo
        Layout.fillWidth:true
        textRole:"label"; valueRole:"value"
        model:choiceControl.options
        enabled:settingsEditable
        currentIndex:choiceControl.options.findIndex(function(o){return o.value===settingsDraft[choiceControl.field]})
        displayText:currentIndex<0 ? (settingsDraft[choiceControl.field]===undefined||settingsDraft[choiceControl.field]===null ? "—" : String(settingsDraft[choiceControl.field])+t(" (atual)")) : currentText
        onActivated:function(index){ setSettingsField(choiceControl.field, choiceControl.options[index].value) }
        Accessible.name:choiceControl.label
    }
}
