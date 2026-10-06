import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

RowLayout {
    id:checkRow
    property string label: ""
    property string status: ""
    property string detail: ""
    Layout.fillWidth:true; spacing:10
    FtChip { Layout.alignment:Qt.AlignTop; text:checkRow.status==="ok"?"OK":checkRow.status==="warning"?t("Atenção"):checkRow.status==="missing"?t("Falta"):t("Não verificado"); kind:checkRow.status==="ok"?"accent":checkRow.status==="skipped"?"neutral":"warning"; iconName:checkRow.status==="ok"?"check":"" }
    ColumnLayout { Layout.fillWidth:true; spacing:2
        Label { text:t(checkRow.label); color:ink; font.weight:Font.DemiBold; wrapMode:Text.WordWrap; Layout.fillWidth:true }
        SettingsHint { text:t(checkRow.detail) }
    }
}
