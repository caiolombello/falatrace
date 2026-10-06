import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

FtDialog {
    id:exportDialog; objectName:"exportDialog"; title:t("Exportar resultado revisado"); anchors.centerIn:parent; width:Math.min(680,window.width-48); height:Math.min(610,window.height-48); modal:true
    property alias exportFormat: exportFormat
    property alias exportTrack: exportTrack
    closePolicy:hasPending("export-save")?Popup.NoAutoClose:Popup.CloseOnEscape
    onOpened:{exportClose.forceActiveFocus(Qt.TabFocusReason);previewExport()}
    onClosed:{exportGeneration+=1;exportResult=({});exportError="";exportButton.forceActiveFocus(Qt.TabFocusReason)}
    contentItem:ColumnLayout { spacing:10
        Label { text:t("Arquivo privado neste computador; não há envio. O conteúdo pode ser sensível. JSON/Markdown incluem origem e revisão; legendas usam somente intervalos disponíveis, com manifesto de proveniência."); color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
        RowLayout { Layout.fillWidth:true
            FtComboBox { id:exportFormat; objectName:"exportFormat"; textRole:"label"; valueRole:"value"; model:[{label:"JSON",value:"json"},{label:"Markdown",value:"markdown"},{label:"SRT",value:"srt"},{label:"WebVTT",value:"vtt"}]; enabled:!hasPending("export-save"); onActivated:previewExport(); Accessible.name:t("Formato da exportação") }
            FtComboBox { id:exportTrack; objectName:"exportTrack"; textRole:"label"; valueRole:"value"; Layout.fillWidth:true; model:[{label:t("Transcrição canônica revisada"),value:"transcript"},{label:t("Falas do diarizador revisadas"),value:"diarization"}]; enabled:!hasPending("export-save"); onActivated:previewExport(); Accessible.name:t("Fonte da exportação") }
        }
        Label { objectName:"exportError"; visible:!!exportError||!!exportResult.error; text:t(exportError||exportResult.error||""); color:errorColor; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true }
        Label { objectName:"exportWarnings"; text:(exportResult.warnings||[]).join("\n")+(exportResult.displayTruncated?t("\nPrévia parcial; o arquivo local preserva o resultado completo."):""); visible:!!text; textFormat:Text.PlainText; color:warningColor; wrapMode:Text.WordWrap; Layout.fillWidth:true }
        ScrollView { Layout.fillWidth:true; Layout.fillHeight:true; clip:true
            TextArea { id:exportPreviewText; objectName:"exportPreviewText"; padding:10; background:Rectangle { radius:8; color:surfaceAlt; border.width:1; border.color:divider } readOnly:true; selectByMouse:true; textFormat:TextEdit.PlainText; wrapMode:TextEdit.Wrap; color:ink; text:exportResult.display|| (hasPending("export-preview")?t("Preparando prévia local…"):t("Prévia indisponível.")); Accessible.name:t("Prévia do arquivo exportado")
                Keys.priority:Keys.BeforeItem
                Keys.onPressed:event=>{if(event.key===Qt.Key_Tab||event.key===Qt.Key_Backtab){exportClose.forceActiveFocus(event.key===Qt.Key_Backtab||!!(event.modifiers&Qt.ShiftModifier)?Qt.BacktabFocusReason:Qt.TabFocusReason);event.accepted=true}}
            }
        }
        Label { objectName:"exportSavedPath"; visible:!!exportResult.path; text:t("Salvo localmente: ")+(exportResult.path||"")+t("\nManifesto: ")+(exportResult.manifestPath||""); color:accent; textFormat:Text.PlainText; wrapMode:Text.WrapAnywhere; Layout.fillWidth:true }
    }
    footer:DialogButtonBox { alignment:Qt.AlignRight; spacing:8; padding:16
        FtButton { id:exportClose; objectName:"exportClose"; text:t("Fechar"); enabled:!hasPending("export-save"); onClicked:exportDialog.close() }
        FtButton { objectName:"exportReload"; text:t("Atualizar prévia"); enabled:backend.available&&!hasPending("export-save")&&!hasPending("export-preview"); onClicked:previewExport() }
        FtButton { objectName:"exportSave"; variant:"primary"; text:hasPending("export-save")?t("Salvando…"):t("Salvar arquivo local"); enabled:backend.available&&exportResult.available===true&&exportResult.revision!==undefined&&!!exportResult.snapshotSha256&&!hasPending("export-preview")&&!hasPending("export-save"); onClicked:send("export-save",diarizationKey(),{format:exportResult.format,track:exportResult.track,expectedRevision:exportResult.revision,expectedBase:exportResult.base,expectedSnapshotSha256:exportResult.snapshotSha256}) }
    }
}
