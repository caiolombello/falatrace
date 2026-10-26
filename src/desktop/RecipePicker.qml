import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Recipes (saved prompts) offered while typing "/" at the start of the Ask input: filtered by what
// follows the slash and by scope (meeting recipes only inside a meeting; library recipes anywhere).
// It never takes focus: the input keeps it and moves the selection with the arrows; Enter runs.
Rectangle {
    id: recipePicker
    objectName: "recipePicker"
    property var recipes: []
    property string filter: ""
    property bool meetingScope: false
    property int currentIndex: 0
    signal chosen(var recipe)
    readonly property var matches: {
        const query = filter.trim().toLocaleLowerCase()
        return recipes.filter(function(recipe){
            if (recipe.scope === "meeting" && !meetingScope) return false
            return !query || String(recipe.name || "").toLocaleLowerCase().indexOf(query) >= 0 || String(recipe.id || "").indexOf(query) >= 0
        })
    }
    function move(step) { if (matches.length) currentIndex = (currentIndex + step + matches.length) % matches.length }
    function choose() { if (currentIndex >= 0 && currentIndex < matches.length) chosen(matches[currentIndex]) }
    onMatchesChanged: currentIndex = 0
    implicitHeight: Math.min(recipeColumn.implicitHeight + 12, 240)
    radius: 10
    color: surface
    border.width: 1
    border.color: dividerStrong
    Accessible.role: Accessible.List
    Accessible.name: t("Receitas")
    Flickable {
        anchors.fill: parent
        anchors.margins: 6
        contentHeight: recipeColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        ColumnLayout {
            id: recipeColumn
            width: parent.width
            spacing: 2
            Label { visible: !recipePicker.matches.length; text: t("Nenhuma receita com esse nome."); textFormat: Text.PlainText; color: muted; font.pixelSize: 12; leftPadding: 8; topPadding: 6; bottomPadding: 6 }
            Repeater {
                model: recipePicker.matches
                delegate: ItemDelegate {
                    id: recipeRow
                    required property var modelData
                    required property int index
                    objectName: "recipeItem-" + modelData.id
                    Layout.fillWidth: true
                    hoverEnabled: true
                    focusPolicy: Qt.NoFocus
                    leftPadding: 8; rightPadding: 8; topPadding: 6; bottomPadding: 6
                    Accessible.name: "/" + modelData.name + ". " + (modelData.description || "")
                    background: Rectangle { radius: 7; color: recipeRow.index === recipePicker.currentIndex ? selectedSurface : recipeRow.hovered ? hoverSurface : "transparent" }
                    contentItem: RowLayout {
                        spacing: 8
                        FtIcon { name: "slash"; tint: accent; size: 14; Layout.alignment: Qt.AlignTop; Layout.topMargin: 2 }
                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 1
                            Label { text: recipeRow.modelData.name; textFormat: Text.PlainText; color: ink; font.pixelSize: 13; font.weight: Font.Medium; elide: Text.ElideRight; Layout.fillWidth: true }
                            Label { visible: text !== ""; text: recipeRow.modelData.scope === "library" ? t("Várias reuniões") : t("Esta reunião"); textFormat: Text.PlainText; color: muted; font.pixelSize: 11 }
                        }
                    }
                    onClicked: recipePicker.chosen(modelData)
                }
            }
        }
    }
}
