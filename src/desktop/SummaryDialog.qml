import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

FtDialog {
    id:summaryDialog; objectName:"summaryDialog"; title:t("Regenerar resumo da transcrição atual")
    property alias summaryBudget: summaryBudget
    property alias summaryConsent: summaryConsent
    anchors.centerIn:parent; width:Math.min(680,window.width-48); height:Math.min(540,window.height-48); modal:true; closePolicy:Popup.CloseOnEscape
    onOpened:{summaryGeneration+=1;summaryPlan=({});summaryError="";summaryNeedsReload=false;summaryCompleted=false;summaryRunning=false;summaryRequestId="";summaryJobId=detail.review.revision.base.jobId;summaryConsent.checked=false;summaryBudget.value=1;summaryCancelButton.forceActiveFocus(Qt.TabFocusReason)}
    onClosed:{abandonSummary();summaryRegenerateButton.forceActiveFocus(Qt.TabFocusReason)}
    contentItem:ColumnLayout {
        spacing:10
        RowLayout {
            Layout.fillWidth:true
            Label { text:t("Máximo de chamadas ao modelo"); color:ink; Layout.fillWidth:true }
            SpinBox { id:summaryBudget; objectName:"summaryBudget";Keys.priority:Keys.BeforeItem
                Keys.onTabPressed:function(event){event.accepted=true;(event.modifiers&Qt.ShiftModifier?summaryCancelButton:summaryPlanButton).forceActiveFocus(event.modifiers&Qt.ShiftModifier?Qt.BacktabFocusReason:Qt.TabFocusReason)}
                Keys.onBacktabPressed:function(event){summaryCancelButton.forceActiveFocus(Qt.BacktabFocusReason);event.accepted=true} from:1;to:8;value:1;editable:false;enabled:!summaryBusy()&&!summaryPlan.requestId&&!summaryNeedsReload;Accessible.name:t("Limite explícito de chamadas para este resumo")
                contentItem:TextInput { objectName:"summaryBudgetValue";text:String(summaryBudget.value);font:summaryBudget.font;color:ink;readOnly:true;horizontalAlignment:Text.AlignHCenter;verticalAlignment:Text.AlignVCenter;Keys.priority:Keys.BeforeItem
                    Keys.onTabPressed:function(event){event.accepted=true;(event.modifiers&Qt.ShiftModifier?summaryCancelButton:summaryPlanButton).forceActiveFocus(event.modifiers&Qt.ShiftModifier?Qt.BacktabFocusReason:Qt.TabFocusReason)}
                    Keys.onBacktabPressed:function(event){summaryCancelButton.forceActiveFocus(Qt.BacktabFocusReason);event.accepted=true}
                }
            }
            FtButton { id:summaryPlanButton;objectName:"summaryPlanButton";Keys.priority:Keys.BeforeItem
                Keys.onTabPressed:function(event){event.accepted=true;if(event.modifiers&Qt.ShiftModifier)summaryBudget.forceActiveFocus(Qt.BacktabFocusReason);else (summaryConsent.enabled?summaryConsent:summaryCancelButton).forceActiveFocus(Qt.TabFocusReason)}
                Keys.onBacktabPressed:function(event){summaryBudget.forceActiveFocus(Qt.BacktabFocusReason);event.accepted=true} text:hasPending("summary-plan")?t("Preparando…"):t("Preparar plano");enabled:backend.available&&!summaryBusy()&&!summaryPlan.requestId&&!summaryNeedsReload;onClicked:prepareSummary() }
        }
        ScrollView { id:summaryScroll;Layout.fillWidth:true;Layout.fillHeight:true;clip:true
            ColumnLayout { width:summaryScroll.availableWidth; spacing:10
                Label { objectName:"summaryPlanInfo"; text:summaryPlanText();textFormat:Text.PlainText;wrapMode:Text.WrapAnywhere;color:ink;Layout.fillWidth:true;Accessible.name:t("Modelo, destino, entrada e custo do plano de resumo") }
                Label { text:t("O resumo novo será ligado à revisão e preservará o original. Não grava mídia, não envia frames e não ativa automações ou configurações desligadas. Resultado de IA exige revisão da fonte.");textFormat:Text.PlainText;wrapMode:Text.WordWrap;color:muted;Layout.fillWidth:true }
                Label { objectName:"summaryError";visible:!!summaryError;text:t(summaryError);textFormat:Text.PlainText;wrapMode:Text.WordWrap;color:errorColor;Layout.fillWidth:true }
            }
        }
        CheckBox { id:summaryConsent;objectName:"summaryConsent";KeyNavigation.priority:KeyNavigation.BeforeItem;KeyNavigation.backtab:summaryPlanButton.enabled?summaryPlanButton:summaryCancelButton;KeyNavigation.tab:summaryCancelButton;text:t("Autorizo esta geração com o plano exibido");enabled:!!summaryPlan.requestId&&!summaryBusy()&&!summaryNeedsReload;Layout.fillWidth:true;Accessible.name:t("Consentimento para gerar este resumo com o destino e limite exibidos")
            indicator:Rectangle { objectName:"summaryConsentIndicator";implicitWidth:24;implicitHeight:24;x:summaryConsent.leftPadding;y:(summaryConsent.height-height)/2;radius:3;color:summaryConsent.checked?accent:(lightTheme?"#FFFFFF":surface);border.width:summaryConsent.visualFocus?3:2;border.color:summaryConsent.visualFocus?accent:muted
                Text { anchors.centerIn:parent;text:summaryConsent.checked?"✓":"";font.pixelSize:17;font.bold:true;color:lightTheme?"#FFFFFF":"#0B1716" }
            }
        }
        Label { visible:summaryRunning;text:t(processingWait)||t("Gerando… Cancelar bloqueia respostas pendentes; um resultado já concluído continua salvo. Uma chamada enviada pode continuar no modelo.");textFormat:Text.PlainText;wrapMode:Text.WordWrap;color:warningColor;Layout.fillWidth:true }
    }
    footer:Item { implicitHeight:summaryFooter.implicitHeight+28
      RowLayout { id:summaryFooter; anchors.fill:parent; anchors.leftMargin:20; anchors.rightMargin:20
        spacing:8
        FtButton { id:summaryCancelButton;objectName:"summaryCancelButton";KeyNavigation.priority:KeyNavigation.BeforeItem;KeyNavigation.backtab:summaryConsent.enabled?summaryConsent:(summaryPlanButton.enabled?summaryPlanButton:summaryBudget);KeyNavigation.tab:summaryReloadButton.visible&&summaryReloadButton.enabled?summaryReloadButton:(summaryRunButton.enabled?summaryRunButton:(summaryBudget.enabled?summaryBudget:summaryConsent));text:summaryBusy()?t("Cancelar pedido e fechar"):t("Cancelar");onClicked:summaryDialog.close() }
        Item { Layout.fillWidth:true }
        FtButton { id:summaryReloadButton;objectName:"summaryReloadButton";KeyNavigation.priority:KeyNavigation.BeforeItem;KeyNavigation.backtab:summaryCancelButton;KeyNavigation.tab:summaryRunButton.enabled?summaryRunButton:summaryCancelButton;visible:summaryNeedsReload;text:t("Reler resumo");enabled:backend.available&&!hasPending("detail");onClicked:{summaryDialog.close();detailLoading=true;send("detail",selected.key)} }
        FtButton { id:summaryRunButton;objectName:"summaryRunButton";variant:"primary";KeyNavigation.priority:KeyNavigation.BeforeItem;KeyNavigation.backtab:summaryReloadButton.visible&&summaryReloadButton.enabled?summaryReloadButton:summaryCancelButton;KeyNavigation.tab:summaryBudget.enabled?summaryBudget:summaryConsent;text:summaryRunning?t("Gerando…"):t("Gerar resumo");enabled:backend.available&&!!summaryPlan.requestId&&summaryConsent.checked&&!summaryBusy()&&!summaryNeedsReload;onClicked:generateSummary() }
      }
    }
}
