import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Asks for name suggestions. The microphone comparison is local; reading the
// conversation sends the turns to the configured summary model, so that part is
// opt-in here and bound to the destination shown.
FtDialog {
    id:speakerSuggestDialog; objectName:"speakerSuggestDialog"; title:t("Sugerir nomes dos falantes")
    property alias conversationConsent: speakerConversationConsent
    anchors.centerIn:parent; width:Math.min(620,window.width-48); modal:true; closePolicy:Popup.CloseOnEscape
    onOpened:{speakerConversationConsent.checked=false;speakerSuggestCancel.forceActiveFocus(Qt.TabFocusReason)}
    onClosed:{if(speakerSuggestButton.visible)speakerSuggestButton.forceActiveFocus(Qt.TabFocusReason)}
    contentItem:ColumnLayout {
        spacing:10
        Label { objectName:"speakerSuggestMicrophone"; text:t("Microfone: compara, neste computador, a faixa do microfone com a do áudio do computador para indicar quem gravou. Nada sai daqui.");textFormat:Text.PlainText;wrapMode:Text.WordWrap;color:ink;Layout.fillWidth:true }
        CheckBox { id:speakerConversationConsent;objectName:"speakerConversationConsent";KeyNavigation.priority:KeyNavigation.BeforeItem;KeyNavigation.backtab:speakerSuggestCancel;KeyNavigation.tab:speakerSuggestCancel
            text:speakerConversationText();enabled:!!(speakerSuggestions.destination&&speakerSuggestions.destination.consentKey);Layout.fillWidth:true
            Accessible.name:t("Consentimento para enviar as falas ao modelo exibido e procurar nomes citados na conversa")
            indicator:Rectangle { implicitWidth:24;implicitHeight:24;x:speakerConversationConsent.leftPadding;y:(speakerConversationConsent.height-height)/2;radius:3;color:speakerConversationConsent.checked?accent:(lightTheme?"#FFFFFF":surface);border.width:speakerConversationConsent.visualFocus?3:2;border.color:speakerConversationConsent.visualFocus?accent:muted
                Text { anchors.centerIn:parent;text:speakerConversationConsent.checked?"✓":"";font.pixelSize:17;font.bold:true;color:lightTheme?"#FFFFFF":"#0B1716" }
            }
            contentItem:Label { text:speakerConversationConsent.text;textFormat:Text.PlainText;wrapMode:Text.WordWrap;color:ink;leftPadding:speakerConversationConsent.indicator.width+speakerConversationConsent.spacing;verticalAlignment:Text.AlignVCenter }
        }
        Label { text:t("Procura apresentações e nomes ditos na conversa. Envia o texto das falas do diarizador, os rótulos S01, S02… e o seu nome, quando o microfone já o indicou. Uma chamada por pedido, sem nova tentativa automática.");textFormat:Text.PlainText;wrapMode:Text.WordWrap;color:muted;Layout.fillWidth:true }
        Label { text:t("As sugestões não mudam nada até você aplicá-las ou salvar um nome. Confira antes: um nome citado na conversa pode ser de outra pessoa.");textFormat:Text.PlainText;wrapMode:Text.WordWrap;color:muted;Layout.fillWidth:true }
    }
    footer:Item { implicitHeight:speakerSuggestFooter.implicitHeight+28
      RowLayout { id:speakerSuggestFooter; anchors.fill:parent; anchors.leftMargin:20; anchors.rightMargin:20
        spacing:8
        FtButton { id:speakerSuggestCancel;objectName:"speakerSuggestCancel";KeyNavigation.priority:KeyNavigation.BeforeItem;KeyNavigation.backtab:speakerSuggestRun;KeyNavigation.tab:speakerConversationConsent.enabled?speakerConversationConsent:speakerSuggestRun;text:t("Cancelar");onClicked:speakerSuggestDialog.close() }
        Item { Layout.fillWidth:true }
        FtButton { id:speakerSuggestRun;objectName:"speakerSuggestRun";variant:"primary";iconName:"spark";KeyNavigation.priority:KeyNavigation.BeforeItem;KeyNavigation.backtab:speakerConversationConsent.enabled?speakerConversationConsent:speakerSuggestCancel;KeyNavigation.tab:speakerSuggestCancel
            text:speakerConversationConsent.checked?t("Analisar microfone e conversa"):t("Analisar microfone");enabled:backend.available&&!speakersQueued&&!!diarizationKey()
            onClicked:{requestSpeakerSuggestions(speakerConversationConsent.checked);speakerSuggestDialog.close()} }
      }
    }
}
