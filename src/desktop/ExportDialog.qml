import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

FtDialog {
    id:exportDialog; objectName:"exportDialog"; title:"Exportar resultado revisado"; anchors.centerIn:parent; width:Math.min(680,window.width-48); height:Math.min(610,window.height-48); modal:true
    property alias exportFormat: exportFormat
    property alias exportTrack: exportTrack
    closePolicy:hasPending("export-save")?Popup.NoAutoClose:Popup.CloseOnEscape
    onOpened:{exportClose.forceActiveFocus(Qt.TabFocusReason);previewExport()}
    onClosed:{exportGeneration+=1;exportResult=({});exportError="";exportButton.forceActiveFocus(Qt.TabFocusReason)}
    contentItem:ColumnLayout { spacing:10
        Label { text:"Arquivo privado neste computador; não há envio. O conteúdo pode ser sensível. JSON/Markdown incluem origem e revisão; legendas usam somente intervalos disponíveis, com manifesto de proveniência."; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
        RowLayout { Layout.fillWidth:true
            FtComboBox { id:exportFormat; objectName:"exportFormat"; textRole:"label"; valueRole:"value"; model:[{label:"JSON",value:"json"},{label:"Markdown",value:"markdown"},{label:"SRT",value:"srt"},{label:"WebVTT",value:"vtt"}]; enabled:!hasPending("export-save"); onActivated:previewExport(); Accessible.name:"Formato da exportação" }
            FtComboBox { id:exportTrack; objectName:"exportTrack"; textRole:"label"; valueRole:"value"; Layout.fillWidth:true; model:[{label:"Transcrição canônica revisada",value:"transcript"},{label:"Falas do diarizador revisadas",value:"diarization"}]; enabled:!hasPending("export-save"); onActivated:previewExport(); Accessible.name:"Fonte da exportação" }
        }
        Label { objectName:"exportError"; visible:!!exportError||!!exportResult.error; text:exportError||exportResult.error||""; color:errorColor; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true }
        Label { objectName:"exportWarnings"; text:(exportResult.warnings||[]).join("\n")+(exportResult.displayTruncated?"\nPrévia parcial; o arquivo local preserva o resultado completo.":""); visible:!!text; textFormat:Text.PlainText; color:warningColor; wrapMode:Text.WordWrap; Layout.fillWidth:true }
        ScrollView { Layout.fillWidth:true; Layout.fillHeight:true; clip:true
            TextArea { id:exportPreviewText; objectName:"exportPreviewText"; padding:10; background:Rectangle { radius:8; color:surfaceAlt; border.width:1; border.color:divider } readOnly:true; selectByMouse:true; textFormat:TextEdit.PlainText; wrapMode:TextEdit.Wrap; color:ink; text:exportResult.display|| (hasPending("export-preview")?"Preparando prévia local…":"Prévia indisponível."); Accessible.name:"Prévia do arquivo exportado"
                Keys.priority:Keys.BeforeItem
                Keys.onPressed:event=>{if(event.key===Qt.Key_Tab||event.key===Qt.Key_Backtab){exportClose.forceActiveFocus(event.key===Qt.Key_Backtab||!!(event.modifiers&Qt.ShiftModifier)?Qt.BacktabFocusReason:Qt.TabFocusReason);event.accepted=true}}
            }
        }
        Label { objectName:"exportSavedPath"; visible:!!exportResult.path; text:"Salvo localmente: "+(exportResult.path||"")+"\nManifesto: "+(exportResult.manifestPath||""); color:accent; textFormat:Text.PlainText; wrapMode:Text.WrapAnywhere; Layout.fillWidth:true }
    }
    footer:DialogButtonBox { alignment:Qt.AlignRight; spacing:8; padding:16
        FtButton { id:exportClose; objectName:"exportClose"; text:"Fechar"; enabled:!hasPending("export-save"); onClicked:exportDialog.close() }
        FtButton { objectName:"exportReload"; text:"Atualizar prévia"; enabled:backend.available&&!hasPending("export-save")&&!hasPending("export-preview"); onClicked:previewExport() }
        FtButton { objectName:"exportSave"; variant:"primary"; text:hasPending("export-save")?"Salvando…":"Salvar arquivo local"; enabled:backend.available&&exportResult.available===true&&exportResult.revision!==undefined&&!!exportResult.snapshotSha256&&!hasPending("export-preview")&&!hasPending("export-save"); onClicked:send("export-save",diarizationKey(),{format:exportResult.format,track:exportResult.track,expectedRevision:exportResult.revision,expectedBase:exportResult.base,expectedSnapshotSha256:exportResult.snapshotSha256}) }
    }
}
