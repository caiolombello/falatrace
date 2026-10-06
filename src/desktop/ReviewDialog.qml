import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

FtDialog {
    id:reviewDialog; objectName:"reviewDialog"; title:reviewTarget.kind==="turn-speaker" ? "Revisar atribuição da fala" : reviewTarget.kind==="speaker-label" ? "Revisar nome do falante" : reviewTarget.kind==="note" ? "Adicionar nota sem tempo" : "Revisar trecho"
    property alias revisionSpeaker: revisionSpeaker
    property alias revisionText: revisionText
    anchors.centerIn:parent; width:Math.min(620,window.width-48); height:Math.min(570,window.height-48); modal:true
    closePolicy:revisionPending()?Popup.NoAutoClose:Popup.CloseOnEscape
    onOpened:revisionCancel.forceActiveFocus(Qt.TabFocusReason)
    onClosed:{reviewTarget=({});reviewError="";reviewNeedsReload=false;revisionSpeakerExplicit=false;reviewNoteButton.forceActiveFocus(Qt.TabFocusReason)}
    contentItem:ColumnLayout { spacing:10
        Label { text:"Revisão humana local. O artefato original e seus horários são preservados. Nomes e atribuições não confirmam a identidade de uma pessoa."; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
        Label { objectName:"revisionOrigin"; text:reviewTarget.id ? "Origem: "+reviewTarget.id+" · "+preciseClock(reviewTarget.start)+"–"+preciseClock(reviewTarget.end)+" · intervalo herdado, sem novo alinhamento" : "Sem timestamp atribuído"; color:accent; wrapMode:Text.WordWrap; Layout.fillWidth:true }
        Label { visible:reviewTarget.kind==="segment-text"; text:"Original: "+(reviewTarget.originalText||reviewTarget.text||""); textFormat:Text.PlainText; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true; maximumLineCount:5; elide:Text.ElideRight }
        Label { objectName:"revisionError"; visible:!!reviewError; text:reviewError; textFormat:Text.PlainText; color:errorColor; wrapMode:Text.WordWrap; Layout.fillWidth:true }
        ScrollView { Layout.fillWidth:true; Layout.fillHeight:true; visible:reviewTarget.kind!=="turn-speaker"; clip:true
            TextArea { id:revisionText; objectName:"revisionText"; padding:10; background:Rectangle { radius:8; color:fieldSurface; border.width:revisionText.activeFocus?2:1; border.color:revisionText.activeFocus?accent:divider } readOnly:revisionPending()||reviewNeedsReload; textFormat:TextEdit.PlainText; wrapMode:TextEdit.Wrap; selectByMouse:true; color:ink; Accessible.name:reviewTarget.kind==="speaker-label"?"Nome informado pelo revisor":"Texto da revisão humana"
                Keys.priority:Keys.BeforeItem
                Keys.onPressed:event=>{if(event.key===Qt.Key_Tab||event.key===Qt.Key_Backtab){const backwards=event.key===Qt.Key_Backtab||!!(event.modifiers&Qt.ShiftModifier);(backwards?revisionCancel:revisionSpeaker.visible?revisionSpeaker:revisionCancel).forceActiveFocus(backwards?Qt.BacktabFocusReason:Qt.TabFocusReason);event.accepted=true}}
            }
        }
        FtComboBox { id:revisionSpeaker; objectName:"revisionSpeaker"; visible:reviewTarget.kind==="turn-speaker"||(reviewTarget.kind==="segment-text"&&speakerRows.length>0); Layout.fillWidth:true; textRole:"label"; enabled:!revisionPending()&&!reviewNeedsReload; model:[{speakerId:"",label:"Atribuição incerta"}].concat(speakerRows); Accessible.name:"Selecione para atribuir um falante da fonte acústica"; onActivated:revisionSpeakerExplicit=true }
        Label { visible:reviewTarget.kind==="segment-text"&&revisionSpeaker.visible; text:revisionSpeakerExplicit?"Atribuição selecionada por você; será registrada ao salvar.":"Selecione um falante para vincular as fontes. Códigos iguais não comprovam a mesma voz."; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
        Label { text:revisionPending()?"Salvando revisão; aguarde a confirmação…":"Salvar invalida os derivados antigos. Não chama um modelo nem regenera o resumo."; color:warningColor; wrapMode:Text.WordWrap; Layout.fillWidth:true }
    }
    footer:DialogButtonBox { alignment:Qt.AlignRight; spacing:8; padding:16
        FtButton { id:revisionCancel; objectName:"revisionCancel"; text:"Cancelar"; enabled:!revisionPending(); onClicked:reviewDialog.close() }
        FtButton { objectName:"revisionReload"; text:"Reler e descartar rascunho"; visible:reviewNeedsReload; enabled:backend.available&&!revisionPending()&&!hasPending("detail"); onClicked:{reviewDialog.close();detailLoading=true;send("detail",selected.key)} }
        FtButton { objectName:"revisionSave"; variant:"primary"; text:revisionPending()?"Salvando…":"Salvar revisão"; enabled:backend.available&&!!detail.review&&!revisionPending()&&!reviewNeedsReload&&(reviewTarget.kind==="turn-speaker"||!!revisionText.text.trim()); onClicked:submitRevision() }
    }
}
