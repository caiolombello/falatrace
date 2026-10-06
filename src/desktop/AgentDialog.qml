import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

FtDialog {
    id:agentDialog; objectName:"agentDialog"; title:"Acesso para IA"
    property alias agentConsent: agentConsent
    property alias agentMode: agentMode
    property alias agentScrollView: agentScrollView
    property alias grantPicker: grantPicker
    property alias providerConsent: providerConsent
    property alias providerContext: providerContext
    property alias providerCostLimit: providerCostLimit
    property alias providerImageTokens: providerImageTokens
    property alias providerInputRate: providerInputRate
    property alias providerModel: providerModel
    property alias providerOutputRate: providerOutputRate
    property alias providerPicker: providerPicker
    property alias providerRequests: providerRequests
    property alias providerTariffSource: providerTariffSource
    property alias providerUnknown: providerUnknown
    anchors.centerIn:parent; width:Math.min(window.width-48,720); height:Math.min(window.height-48,740); modal:true
    property bool saving: hasPending("provider-authorize") || hasPending("agent-authorize") || hasPending("agent-revoke") || hasPending("agent-pause") || hasPending("agent-resume")
    property bool detailsOpen:false
    closePolicy:saving ? Popup.NoAutoClose : Popup.CloseOnEscape
    onOpened:{agentLoaded=false;showAgentSetup=false;detailsOpen=false;preferredGrantId="";agentGeneration+=1;agentState=({grants:[],budget:({}),capabilities:({})});agentResult=({});agentError="";agentConsent.checked=false;send("agent-status",selected.key);agentMode.forceActiveFocus(Qt.TabFocusReason)}
    onClosed:{cancelProvider();if(activeGrant.id && hasPending("agent-frames"))send("agent-cancel",selected.key,{grantId:activeGrant.id});agentGeneration+=1;agentConsent.checked=false;agentResult=({});agentAccessButton.forceActiveFocus(Qt.TabFocusReason)}
    contentItem:ScrollView {
      id:agentScrollView; clip:true; contentWidth:availableWidth
      ColumnLayout {
        width:agentScrollView.availableWidth; spacing:12
        Label { text:selected.title||selected.fileName||"Gravação selecionada"; font.pixelSize:20; font.weight:Font.DemiBold; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:ink }
        Label { text:"Escolha quem pode consultar esta gravação. A autorização continua após fechar o Studio; você pode pausar ou revogar a qualquer momento."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
        Label { text:"COMO USAR"; font.pixelSize:11; font.letterSpacing:1; color:accent }
        FtComboBox { id:agentMode; objectName:"agentMode"; enabled:!agentDialog.saving; model:["Meu agente · contexto e imagens locais","Analisar com OpenAI ou Google · API"]; Layout.fillWidth:true; onCurrentIndexChanged:{cancelProvider();providerRequestUUID="";agentGeneration+=1;agentConsent.checked=false;providerConsent.checked=false;agentResult=({});showAgentSetup=visibleGrants.length===0;if(agentDialog.visible)send("agent-status",selected.key)} Accessible.name:"Como usar a gravação com IA" }
        Label { visible:agentMode.currentIndex===0; text:"O agente recebe apenas os dados autorizados. Consultar um frame não executa um modelo de IA. A conexão do seu agente com a CLI é configurada separadamente."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
        Label { visible:agentMode.currentIndex===1; text:agentState.providerAnalysis && agentState.providerAnalysis.available ? "Envio API habilitado. Confira o acesso ao modelo e a tarifa antes de analisar. Assinatura de chat não inclui uso de API." : "Envio API desativado nesta instalação. Você pode preparar a autorização; nenhuma análise será enviada. Acesso ao modelo e tarifas ainda não foram verificados."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:warningColor }
        BusyIndicator { running:hasPending("agent-status")&&!agentLoaded; visible:running; Layout.alignment:Qt.AlignHCenter }

        FtComboBox { id:grantPicker; objectName:"grantPicker"; visible:visibleGrants.length>1; Layout.fillWidth:true; model:visibleGrants.map(function(g){return g.recipient.id+(g.recipient.model?" · "+g.recipient.model:"")+" · "+(g.revoked?"revogado":g.paused?"pausado":"ativo")}); Accessible.name:"Autorizações existentes"; onActivated:changeAgentGrant() }
        Frame { visible:!!activeGrant.id; Layout.fillWidth:true; padding:16
         background:Rectangle { color:surface; radius:10; border.color:divider }
         ColumnLayout { width:parent.width; spacing:10
          Label { text:activeGrant.id ? (activeGrant.revoked?"Acesso revogado":activeGrant.paused?"Acesso pausado":agentMode.currentIndex===1&&(!agentState.providerAnalysis||!agentState.providerAnalysis.available)?"Autorização salva · envio desativado":"Acesso autorizado") : ""; color:activeGrant.paused||activeGrant.revoked||(agentMode.currentIndex===1&&(!agentState.providerAnalysis||!agentState.providerAnalysis.available))?warningColor:accent; font.pixelSize:17; font.weight:Font.DemiBold }
          Label { objectName:"agentGrantLabel"; text:activeGrant.id ? activeGrant.recipient.id+(activeGrant.recipient.model?" · "+activeGrant.recipient.model:"")+"\n"+activeGrant.data.map(function(d){return d==="frames"?"Frames sob pedido":"Transcrição, resumo e busca"}).join(" + ")+"\n"+(activeGrant.scope.includesFuture?"Gravações registradas atuais e futuras · exclusões respeitadas":activeGrant.scope.recordingIds.length===1?"Somente esta gravação":activeGrant.scope.recordingIds.length+" gravações autorizadas")+" · até "+activeGrant.limits.maxFrames+" frames / "+Math.round(activeGrant.limits.maxBytes/1048576)+" MiB por pedido" : ""; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:ink }
          Label { visible:!!activeGrant.scope&&!!activeGrant.scope.includesFuture; text:"Não há filtro garantido de segredos. Exclua gravações sensíveis para cada destinatário antes de consultar frames."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:warningColor }
          Label { visible:!!activeGrant.revoked; text:"Consultas futuras foram bloqueadas. Para autorizar novamente, faça uma nova escolha abaixo. Cópias já entregues não são recolhidas."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
          RowLayout {
           FtButton { objectName:"agentPauseButton"; text:activeGrant.paused?"Retomar acesso":"Pausar acesso"; enabled:!!activeGrant.id&&!activeGrant.revoked&&!agentDialog.saving; onClicked:changeAgentAccess(activeGrant.paused?"agent-resume":"agent-pause") }
           FtButton { objectName:"agentRevokeButton"; text:"Revogar acesso"; enabled:!!activeGrant.id&&!activeGrant.revoked&&!agentDialog.saving; onClicked:changeAgentAccess("agent-revoke") }
          }
         }
        }
        Label { objectName:"agentUsageLabel"; text:agentState.budget.budgetLimits ? "Saldo local: "+agentState.budget.remainingPreviews+" extrações de frame · "+agentState.budget.remainingInferences+" análises. Reiniciar ou criar outra autorização não renova o saldo." : "Lendo limites…"; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
        FtButton { visible:visibleGrants.length>0; text:showAgentSetup?"Ocultar nova autorização":"Autorizar outro destinatário ou outros dados…"; enabled:!agentDialog.saving; onClicked:{showAgentSetup=!showAgentSetup;agentConsent.checked=false;providerConsent.checked=false} }

        ColumnLayout { visible:showAgentSetup && agentMode.currentIndex===0; Layout.fillWidth:true; spacing:10
         Label { text:"1. Destinatário e dados"; font.pixelSize:17; font.weight:Font.DemiBold; color:ink }
         Label { text:"Nome do agente local"; color:muted }
         FtTextField { id:agentRecipient; objectName:"agentRecipient"; text:"local-agent"; placeholderText:"Ex.: meu-assistente"; enabled:!agentDialog.saving; Layout.fillWidth:true; onTextChanged:agentConsent.checked=false; Accessible.name:"Nome do agente local autorizado" }
         WrappedCheck { id:agentContextData; objectName:"agentContextData"; text:"Consultar transcrição, resumo e buscar esta gravação"; checked:true; enabled:!agentDialog.saving; onCheckedChanged:agentConsent.checked=false }
         WrappedCheck { id:agentFrameData; objectName:"agentFrameData"; text:"Pedir frames, inclusive quando não há transcrição"; checked:true; enabled:!agentDialog.saving; onCheckedChanged:agentConsent.checked=false }
         Label { text:"2. Autorizar uma vez"; font.pixelSize:17; font.weight:Font.DemiBold; color:ink }
         Label { text:"Somente esta gravação e sua versão atual. Até 2 frames / 2 MiB por pedido, com cache privado de 5 minutos. Futuras gravações não são incluídas. O agente não precisa pedir nova confirmação a cada frame dentro desses limites."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
         WrappedCheck { id:agentConsent; objectName:"agentConsent"; text:"Autorizo este agente a consultar os dados selecionados"; enabled:!agentDialog.saving }
        }

        ColumnLayout { visible:agentMode.currentIndex===1 && showAgentSetup; enabled:!agentDialog.saving; Layout.fillWidth:true; spacing:10
         Label { text:"1. Destino e modelo"; font.pixelSize:17; font.weight:Font.DemiBold; color:ink }
         FtComboBox { id:providerPicker; objectName:"providerPicker"; model:["OpenAI","Google"]; Layout.fillWidth:true; onCurrentIndexChanged:providerConsent.checked=false }
         Label { text:providerPicker.currentIndex===0?"Destino: https://api.openai.com/v1/responses":"Destino: https://generativelanguage.googleapis.com/v1beta"; textFormat:Text.PlainText; wrapMode:Text.WrapAnywhere; Layout.fillWidth:true; color:muted; font.pixelSize:12 }
         FtTextField { id:providerModel; objectName:"providerModel"; placeholderText:"Nome do modelo com suporte a imagens e JSON"; Layout.fillWidth:true; onTextChanged:providerConsent.checked=false; Accessible.name:"Modelo escolhido para a análise" }
         WrappedCheck { id:providerCapabilities; text:"O modelo escolhido aceita imagens e JSON. O acesso ainda não foi verificado aqui."; onCheckedChanged:providerConsent.checked=false }
         WrappedCheck { id:providerContext; text:"Incluir até 1.000 caracteres da transcrição existente"; onCheckedChanged:providerConsent.checked=false }
         Label { text:"2. Limites e custo"; font.pixelSize:17; font.weight:Font.DemiBold; color:ink }
         RowLayout { Label { text:"Máximo de pedidos"; color:ink } SpinBox { id:providerRequests; objectName:"providerRequests"; from:1; to:24; value:2; onValueModified:providerConsent.checked=false; Accessible.name:"Máximo de pedidos desta autorização" } }
         Label { text:"Até 2 frames / 2 MiB por pedido e 512 tokens de resposta. Esses pedidos também consomem o saldo local da instalação. A estimativa abaixo não é um limite de cobrança na conta do provider."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
         Label { text:"Tarifas opcionais · deixe em branco se desconhecidas"; color:ink; wrapMode:Text.WordWrap; Layout.fillWidth:true }
         Label { text:"Entrada · USD por milhão de tokens"; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
         FtTextField { id:providerInputRate; placeholderText:"Entrada: USD por milhão de tokens"; Layout.fillWidth:true; onTextChanged:providerConsent.checked=false; Accessible.name:placeholderText }
         Label { text:"Saída · USD por milhão de tokens"; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
         FtTextField { id:providerOutputRate; placeholderText:"Saída: USD por milhão de tokens"; Layout.fillWidth:true; onTextChanged:providerConsent.checked=false; Accessible.name:placeholderText }
         Label { text:"Estimativa de tokens por imagem"; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
         FtTextField { id:providerImageTokens; placeholderText:"Estimativa de tokens por imagem"; Layout.fillWidth:true; onTextChanged:providerConsent.checked=false; Accessible.name:placeholderText }
         Label { text:"Fonte e data das tarifas"; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
         FtTextField { id:providerTariffSource; placeholderText:"Fonte e data das tarifas informadas"; Layout.fillWidth:true; onTextChanged:providerConsent.checked=false; Accessible.name:placeholderText }
         Label { text:"Teto estimado acumulado local · USD"; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
         FtTextField { id:providerCostLimit; placeholderText:"Teto estimado acumulado local em USD (opcional)"; Layout.fillWidth:true; onTextChanged:providerConsent.checked=false; Accessible.name:placeholderText }
         WrappedCheck { id:providerUnknown; objectName:"providerUnknown"; text:"Aceito custo desconhecido. Não significa uso gratuito."; onCheckedChanged:providerConsent.checked=false }
         Label { text:"3. Autorizar uma vez"; font.pixelSize:17; font.weight:Font.DemiBold; color:ink }
         WrappedCheck { id:providerConsent; objectName:"providerConsent"; text:"Autorizo o destino, modelo, dados e limites acima para esta gravação" }
        }

        ColumnLayout { id:providerQuestionForm; objectName:"providerQuestionForm"; visible:agentMode.currentIndex===1 && !!activeGrant.id && !!agentState.providerAnalysis && agentState.providerAnalysis.available; Layout.fillWidth:true; spacing:10
         Label { text:"Perguntar sobre um momento"; color:ink; font.pixelSize:17; font.weight:Font.DemiBold }
         Label { text:activeGrant.analysis ? "Até "+activeGrant.analysis.maxRequests+" pedidos nesta autorização · "+activeGrant.analysis.maxContextCharacters+" caracteres de contexto\nCusto desconhecido: "+(activeGrant.analysis.acceptUnknownCost?"aceito explicitamente":"análise bloqueada se não houver tarifa") : ""; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
         FtTextField { id:providerQuestion; objectName:"providerQuestion"; placeholderText:"O que você precisa conferir na imagem?"; Layout.fillWidth:true; onTextChanged:providerRequestUUID=""; Accessible.name:"Pergunta sobre a imagem" }
         RowLayout { Label { text:"Instante (segundos)"; color:muted } FtTextField { id:providerSeconds; text:"0"; Layout.fillWidth:true; onTextChanged:providerRequestUUID=""; Accessible.name:"Instante da imagem em segundos" } }
         FtButton { objectName:"providerAnalyzeButton"; text:hasPending("provider-analyze")?"Analisando…":!agentState.providerAnalysis||!agentState.providerAnalysis.available?"Envio API desativado":"Analisar este momento"; enabled:!!agentState.providerAnalysis&&agentState.providerAnalysis.available&&!activeGrant.paused&&!activeGrant.revoked&&!hasPending("provider-analyze")&&!!providerQuestion.text&&isFinite(Number(providerSeconds.text))&&Number(providerSeconds.text)>=0&&providerResult.status!=="uncertain"; onClicked:{agentError="";if(!providerRequestUUID)providerRequestUUID=newRequestUUID();providerPendingGrant=activeGrant.id;send("provider-analyze",selected.key,{grantId:activeGrant.id,requestId:providerRequestUUID,question:providerQuestion.text,timestamps:[Number(providerSeconds.text)]})} }
         FtButton { visible:hasPending("provider-analyze"); text:"Cancelar pedido"; onClicked:{cancelProvider();agentGeneration+=1;agentError="Pedido cancelado. Se já enviado, confira o estado e a cobrança no provider antes de tentar novamente.";send("agent-status",selected.key)} }
         Label { objectName:"providerResultLabel"; visible:!!providerResult.requestId; text:providerResult.requestId ? (providerResult.status==="uncertain"?"Resultado incerto. Confira o estado e a cobrança no provider antes de fazer outro pedido.":providerResult.overview||providerResult.cost||providerResult.status||"")+"\n"+(providerResult.observations||[]).map(function(o){return o.text+"\nFonte: frame "+(o.frameIndex+1)+" em "+(o.decodedTimestampSeconds===null?"instante não verificado":preciseClock(o.decodedTimestampSeconds))+" · incerteza "+o.uncertainty}).join("\n\n")+"\nObservações parciais. Confira a gravação; o resumo completo não foi alterado." : ""; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:ink }
        }

        ColumnLayout { visible:agentMode.currentIndex===0 && !!activeGrant.id && activeGrant.data.includes("frames"); Layout.fillWidth:true; spacing:10
         Label { text:"Preview opcional"; font.pixelSize:17; font.weight:Font.DemiBold; color:ink }
         Label { text:"Confira um frame local. Seu agente também pode solicitar imagens dentro dos limites autorizados, sem passar por este preview."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
         RowLayout { Label { text:"Instante (segundos)"; color:muted } FtTextField { id:agentTime; objectName:"agentTime"; text:"0"; Layout.fillWidth:true; Accessible.name:"Instante para preview opcional" } }
         FtButton { id:agentPreviewButton; objectName:"agentPreviewButton"; text:hasPending("agent-frames")?"Consultando frame…":"Ver frame local"; enabled:!!activeGrant.id&&!activeGrant.revoked&&!activeGrant.paused&&activeGrant.data.includes("frames")&&!hasPending("agent-frames")&&!agentDialog.saving&&!!agentTime.text&&isFinite(Number(agentTime.text))&&Number(agentTime.text)>=0; onClicked:{agentError="";frameGrantPending=activeGrant.id;send("agent-frames",selected.key,{grantId:activeGrant.id,timestamps:[Number(agentTime.text)]})} }
         FtButton { id:agentCancelPreview; visible:hasPending("agent-frames"); text:"Cancelar consulta"; onClicked:{if(frameGrantPending)send("agent-cancel",selected.key,{grantId:frameGrantPending});agentGeneration+=1;frameGrantPending="";agentResult=({});agentError="Consulta cancelada; autorização preservada.";send("agent-status",selected.key)} }
         Label { id:agentResultLabel; objectName:"agentResultLabel"; text:agentResult.recordingId ? (agentResult.cacheHit?"Cache local reutilizado":"Frame extraído localmente")+"\n"+agentResult.frames.map(function(f){return "Pedido em "+preciseClock(f.requestedTimestampSeconds)+" → "+(f.decodedTimestampSeconds===null?"instante decodificado desconhecido":preciseClock(f.decodedTimestampSeconds))+" · "+(f.precision==="decoded-pts"?"instante verificado do frame":"instante não verificado")}).join("\n") : ""; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:accent }
         Image { objectName:"agentFrameImage"; visible:!!agentResult.frames&&agentResult.frames.length>0; source:visible?"file://"+agentResult.frames[0].file:""; fillMode:Image.PreserveAspectFit; Layout.fillWidth:true; Layout.preferredHeight:190; Accessible.name:"Frame local consultado, com origem temporal exibida" }
        }
        FtButton { text:agentDialog.detailsOpen?"Ocultar detalhes técnicos":"Origem, retenção e detalhes técnicos"; visible:!!activeGrant.id; onClicked:agentDialog.detailsOpen=!agentDialog.detailsOpen }
        Label { visible:agentDialog.detailsOpen; text:activeGrant.id ? "Autorização: "+activeGrant.id+"\nGravação: "+(activeGrant.scope.includesFuture?"Escopo desta instalação, incluindo futuras; destinatário vinculado pelo launcher local, sem autenticação do provedor. Exclua gravações sensíveis; não há detector garantido de segredos.":activeGrant.scope.recordingIds.join(", "))+"\nCache privado: "+(activeGrant.limits.cacheTtlMs/1000)+"s; remoção ao consultar após expirar. Revogar bloqueia consultas futuras, sem recolher cópias já entregues."+(activeGrant.recipient.endpoint?"\nDestino: "+activeGrant.recipient.endpoint:"")+(activeGrant.analysis?"\nTarifas informadas: "+JSON.stringify(activeGrant.analysis.rates)+"\nTeto estimado acumulado: "+(activeGrant.analysis.estimatedBudgetUsd===null?"não configurado":activeGrant.analysis.estimatedBudgetUsd+" USD"):"")+(agentResult.mediaHash?"\nOrigem SHA256: "+agentResult.mediaHash:"")+"\n"+(providerResult.observations||[]).map(function(o){return "Fonte SHA256: "+o.mediaHash+"\nFrame SHA256: "+o.frameSha256+" · precisão "+o.precision}).join("\n")+(agentResult.frames||[]).map(function(f){return "\nFrame SHA256: "+f.sha256+" · precisão "+f.precision}).join("") : ""; textFormat:Text.PlainText; wrapMode:Text.WrapAnywhere; Layout.fillWidth:true; color:muted; font.pixelSize:12 }
        Label { visible:agentMode.currentIndex===1 && agentDialog.detailsOpen; text:agentState.providerAnalysis && agentState.providerAnalysis.usage ? "Registro local: "+agentState.providerAnalysis.usage.attempts+" tentativas · estimado conhecido USD "+agentState.providerAnalysis.usage.knownEstimatedUsd+" · "+agentState.providerAnalysis.usage.unknownCostAttempts+" custos desconhecidos · "+agentState.providerAnalysis.usage.uncertainOutcomes+" resultados incertos. Não é o saldo global da conta do provider." : ""; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
      }
    }
    footer:Item { implicitHeight:agentFooter.implicitHeight+24; ColumnLayout { id:agentFooter; anchors.fill:parent; anchors.margins:12; spacing:8
      Label { id:agentErrorLabel; objectName:"agentErrorLabel"; visible:!!agentError; text:agentError; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:errorColor; Accessible.role:Accessible.AlertMessage }
      RowLayout { Layout.fillWidth:true; spacing:10
      Label { text:agentDialog.saving?"Salvando…":showAgentSetup?"A nova escolha só vale após autorizar.":activeGrant.id?"Fechar mantém a autorização.":"Nenhum acesso autorizado."; color:muted; font.pixelSize:12; Layout.fillWidth:true; wrapMode:Text.WordWrap }
      FtButton { text:"Fechar"; enabled:!agentDialog.saving; onClicked:closeAgentAccess() }
      FtButton { visible:showAgentSetup && agentMode.currentIndex===0; objectName:"agentAuthorizeButton"; highlighted:enabled;  text:agentDialog.saving?"Salvando…":"Autorizar acesso"; enabled:agentConsent.checked && /^[-a-z0-9._]{1,64}$/.test(agentRecipient.text) && (agentContextData.checked||agentFrameData.checked) && !agentDialog.saving; onClicked:send("agent-authorize",selected.key,{recipientId:agentRecipient.text,data:(agentContextData.checked?["context"]:[]).concat(agentFrameData.checked?["frames"]:[]),consent:true}) }
      FtButton { visible:showAgentSetup && agentMode.currentIndex===1; objectName:"providerAuthorizeButton"; highlighted:enabled;  text:hasPending("provider-authorize")?"Salvando…":"Salvar autorização de análise"; enabled:providerConsent.checked&&providerCapabilities.checked&&/^[-a-zA-Z0-9._]{1,160}$/.test(providerModel.text)&&!hasPending("provider-authorize"); onClicked:authorizeProvider() }
    } } }
}
