import QtQuick
import QtQuick.Dialogs

// Loaded on demand by the settings dialog. If the platform lacks QtQuick.Dialogs the
// Loader fails and the "Escolher…" buttons stay hidden; typing a path still works.
Item {
    id: picker
    property var callback: null
    function toPath(url) { return decodeURIComponent(String(url).replace(/^file:\/\//, "")) }
    function toUrl(path) { return path ? "file://" + encodeURI(path) : "" }
    function open(mode, title, start, done) {
        picker.callback = done
        const folder = start ? toUrl(start.replace(/\/[^\/]*$/, "") || "/") : ""
        if (mode === "folder") {
            folderDialog.title = title
            if (start) folderDialog.currentFolder = toUrl(start)
            folderDialog.open()
        } else {
            fileDialog.title = title
            fileDialog.fileMode = mode === "save" ? FileDialog.SaveFile : FileDialog.OpenFile
            fileDialog.nameFilters = mode === "save" || mode === "json" ? [t("Configuração JSON (*.json)")] : [t("Todos os arquivos (*)")]
            if (folder) fileDialog.currentFolder = folder
            fileDialog.open()
        }
    }
    FileDialog {
        id: fileDialog
        onAccepted: if (picker.callback) picker.callback(picker.toPath(selectedFile))
    }
    FolderDialog {
        id: folderDialog
        onAccepted: if (picker.callback) picker.callback(picker.toPath(selectedFolder))
    }
}
