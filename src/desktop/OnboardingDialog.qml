import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

FtDialog {
    id:onboardingDialog; objectName:"onboardingDialog"; title:t("Configuração e privacidade")
    property alias localChoice: localChoice
    property alias onboardingScroll: onboardingScroll
    anchors.centerIn:parent; width:Math.min(window.width-48,580); height:Math.min(window.height-64,600); modal:true
    closePolicy:hasOnboardingPending("onboarding-save-local")?Popup.NoAutoClose:Popup.CloseOnEscape
    onOpened:{onboardingError="";onboardingNeedsReload=false;onboardingSaveUncertain=false;loadOnboarding();onboardingCancel.forceActiveFocus(Qt.TabFocusReason)}
    onClosed:{onboardingGeneration+=1;onboardingDraft=({});localChoice.checked=false;(settingsDialog.visible?settingsTabs:onboardingButton).forceActiveFocus(Qt.TabFocusReason)}
    contentItem:ColumnLayout { spacing:12
     Label { objectName:"onboardingError"; visible:!!onboardingError; text:t(onboardingError); textFormat:Text.PlainText; wrapMode:Text.WordWrap; color:errorColor; Layout.fillWidth:true; Accessible.name:text }
     ScrollView { id:onboardingScroll; objectName:"onboardingScroll"; clip:true; contentWidth:availableWidth; Layout.fillWidth:true; Layout.fillHeight:true
     ColumnLayout { width:onboardingScroll.availableWidth; spacing:16
      Label { text:onboardingDraft.revision?(onboardingDraft.exists?t("Suas escolhas atuais"):t("Comece neste computador")):(hasOnboardingPending("onboarding-read")?t("Lendo configuração…"):t("Releia a configuração")); color:ink; font.pixelSize:22; font.weight:Font.DemiBold; wrapMode:Text.WordWrap; Layout.fillWidth:true }
      Label { text:onboardingDraft.exists?t("Você só altera a configuração ao salvar. Cancelar mantém tudo como está."):t("Escolha o processamento local para a primeira configuração. Esta tela não instala modelos nem inicia uma gravação."); color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
      Frame { visible:!!onboardingDraft.revision; Layout.fillWidth:true; padding:14
       background:Rectangle { color:surface; radius:8; border.color:divider }
       ColumnLayout { width:parent.width; spacing:8
        Label { text:t("ROTAS ATUAIS DE PROCESSAMENTO"); font.pixelSize:11; font.letterSpacing:1; color:accent }
        Label { text:onboardingDraft.revision?t("Transcrição: ")+onboardingDraft.transcriptionDestination:""; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:onboardingDraft.transcriptionLocal?ink:warningColor }
        Label { text:onboardingDraft.revision ? t("Resumo: ")+onboardingDraft.summaryProvider+" · "+onboardingDraft.destination : ""; textFormat:Text.PlainText; wrapMode:Text.WrapAnywhere; Layout.fillWidth:true; color:onboardingDraft.local?ink:warningColor }
        Label { text:onboardingDraft.revision?t("Execução: ")+onboardingDraft.processingDestination:""; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:onboardingDraft.processingTarget==="local"?ink:warningColor }
        Label { text:t("Processamento automático após gravação: ")+(onboardingDraft.automaticEnqueue?"ativado":t("desativado")); wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
        Label { text:t("Arquivamento: ")+(onboardingDraft.archiveEnabled?(onboardingDraft.archiveDestinations||[]).join(", "):t("desativado"))+". S3: "+(onboardingDraft.s3Enabled?"ativado":t("desativado"))+t(". Integração Proton: ")+(onboardingDraft.protonEnabled?"ativada":t("desativada"))+"."; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
        Label { visible:!!onboardingDraft.timesheetAIExternal; text:t("Classificação de atividades com IA externa está ativada."); wrapMode:Text.WordWrap; Layout.fillWidth:true; color:warningColor }
        Label { text:(!onboardingDraft.local||!onboardingDraft.transcriptionLocal||onboardingDraft.processingTarget!=="local"||onboardingDraft.archiveExternal||onboardingDraft.s3Enabled||onboardingDraft.protonEnabled||onboardingDraft.timesheetAIExternal)?t("Há rotas externas configuradas. Confira antes de processar ou arquivar conteúdo."):t("Rotas de transcrição e resumo configuradas para este computador. Modelos ainda não validados."); color:warningColor; wrapMode:Text.WordWrap; Layout.fillWidth:true }
       }
      }
      WrappedCheck { id:localChoice; objectName:"localChoice"; text:t("Usar Whisper.cpp para transcrição e Ollama neste computador para resumos"); enabled:backend.available&&!!onboardingDraft.revision&&!hasOnboardingPending("onboarding-read")&&!hasOnboardingPending("onboarding-save-local"); Accessible.name:text
      }
      Label { text:t("Ao salvar esta escolha"); font.pixelSize:17; font.weight:Font.DemiBold; color:ink }
      Label { text:t("• A transcrição, os resumos e a execução ficam configurados para este computador. O processamento automático após gravação fica desativado.\n• As demais opções, incluindo arquivamento, S3, Proton, classificação de atividades e regras de gravação, são preservadas.\n• Se já há configuração, é criada uma cópia privada de segurança. Serviços existentes podem usar a nova escolha nas próximas execuções."); wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
      Label { text:t("Whisper.cpp, Ollama e os modelos precisam estar instalados separadamente. Esta tela não instala modelos, não verifica o comportamento de comandos personalizados nem valida a qualidade dos resultados. Uma assinatura de chat não inclui uso de API."); wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted; font.pixelSize:12 }
      Label { visible:!!onboardingDraft.retention; text:onboardingDraft.retention?t("Retenção configurada (dias; 0 desativa o prazo): dados de trabalho locais concluídos ")+onboardingDraft.retention.localCompletedWorkDays+t("; worker — entradas parciais ")+onboardingDraft.retention.remoteIncomingDays+t(", resultados ")+onboardingDraft.retention.remoteResultsDays+t(", falhas ")+onboardingDraft.retention.remoteFailuresDays+".":""; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted; font.pixelSize:12 }
      Label { text:t("A limpeza local atua em dados de trabalho de jobs concluídos elegíveis. Ela não é uma exclusão completa da gravação: cópias remotas, exports e outros derivados podem permanecer. Revise o alcance sem apagar arquivos: falatrace jobs cleanup --dry-run."); textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted; font.pixelSize:12 }
     }
     }
    }
    footer:Item { implicitHeight:60; RowLayout { anchors.fill:parent; anchors.margins:12; spacing:10
     Item { Layout.fillWidth:true }
     FtButton { id:onboardingCancel; objectName:"onboardingCancel"; text:t("Cancelar"); enabled:!hasOnboardingPending("onboarding-save-local"); onClicked:onboardingDialog.reject() }
     FtButton { id:onboardingReload; objectName:"onboardingReload"; visible:onboardingNeedsReload||!!onboardingError; text:backend.available?t("Reler configuração"):t("Reconectar"); enabled:!hasOnboardingPending("onboarding-read")&&!hasOnboardingPending("onboarding-save-local"); onClicked:{if(backend.available)loadOnboarding();else backend.reconnect()} }
     FtButton { id:onboardingSaveButton; objectName:"onboardingSaveButton"; highlighted:enabled;  text:hasOnboardingPending("onboarding-save-local")?t("Salvando…"):t("Salvar escolha local"); enabled:backend.available&&localChoice.checked&&!!onboardingDraft.revision&&!hasOnboardingPending("onboarding-read")&&!hasOnboardingPending("onboarding-save-local"); onClicked:{if(enabled)send("onboarding-save-local","",{revision:onboardingDraft.revision})} }
    } }
}
