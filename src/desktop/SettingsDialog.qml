import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

FtDialog {
    id:settingsDialog; objectName:"settingsDialog"; title:"Configurações"
    property alias settingsTabs: settingsTabs
    anchors.centerIn:parent; width:Math.min(window.width-48,780); height:Math.min(window.height-48,760); modal:true
    closePolicy:hasSettingsPending("settings-save")||hasSettingsPending("settings-service")?Popup.NoAutoClose:Popup.CloseOnEscape
    onOpened:{settingsError="";settingsNotice="";settingsTabs.currentIndex=settingsFirstRun?0:settingsTabs.currentIndex;loadSettings(true);settingsTabs.forceActiveFocus(Qt.TabFocusReason)}
    onClosed:{settingsGeneration+=1;settingsDraft=({});settingsData=({});settingsDiag=({});settingsFirstRun=false;onboardingButton.forceActiveFocus(Qt.TabFocusReason)}
    contentItem:ColumnLayout { spacing:10
     Label { objectName:"settingsFirstRun"; visible:settingsFirstRun; text:"Bem-vindo ao FalaTrace. Escolha quando gravar, o que capturar e onde processar. Nada é gravado ou enviado até você salvar e ativar."; textFormat:Text.PlainText; wrapMode:Text.WordWrap; color:accent; Layout.fillWidth:true }
     Label { objectName:"settingsError"; visible:!!settingsError; text:settingsError; textFormat:Text.PlainText; wrapMode:Text.WordWrap; color:errorColor; Layout.fillWidth:true; Accessible.name:text }
     Label { objectName:"settingsNotice"; visible:!!settingsNotice; text:settingsNotice; textFormat:Text.PlainText; wrapMode:Text.WordWrap; color:accent; Layout.fillWidth:true; Accessible.name:text }
     TabBar {
        id:settingsTabs; objectName:"settingsTabs"; Layout.fillWidth:true; spacing:4; padding:4
        background: Rectangle { radius:10; color:surfaceAlt; border.width:1; border.color:divider }
        Repeater {
            model:["Gravação automática","Captura e áudio","Processamento e IA","Serviços e diagnóstico"]
            TabButton {
                id:settingsTab
                required property var modelData
                required property int index
                text:modelData; implicitHeight:34; hoverEnabled:true; font.pixelSize:13
                contentItem: Label { text:settingsTab.text; font.pixelSize:compactLayout?12:13; font.weight:settingsTab.checked?Font.DemiBold:Font.Normal; color:settingsTab.checked?ink:muted; elide:Text.ElideRight; horizontalAlignment:Text.AlignHCenter; verticalAlignment:Text.AlignVCenter }
                background: Rectangle { radius:7; color:settingsTab.checked?surface:settingsTab.hovered?hoverSurface:"transparent"; border.width:settingsTab.visualFocus?2:settingsTab.checked?1:0; border.color:settingsTab.visualFocus?accent:divider }
                onClicked:if(index===3&&!hasSettingsPending("settings-diagnose"))runSettingsDiagnose()
            }
        }
     }
     Label { visible:!settingsData.revision; text:hasSettingsPending("settings-read")?"Lendo configuração…":"Releia a configuração para editar."; color:muted; Layout.fillWidth:true }
     StackLayout {
        visible:!!settingsData.revision
        currentIndex:settingsTabs.currentIndex; Layout.fillWidth:true; Layout.fillHeight:true
        // 1 · Gravação automática
        ScrollView { id:settingsScrollCalls; clip:true; contentWidth:availableWidth
         ColumnLayout { width:settingsScrollCalls.availableWidth; spacing:10
          SettingsCheck { objectName:"settingsCallsEnabled"; field:"callDetection.enabled"; text:"Ativar a gravação automática de chamadas" }
          SettingsHint { text:"Detecta quando um app usa o microfone ou a câmera. Não identifica o serviço, a aba nem quem participa; ditado ou teste de câmera também contam. Confirme a permissão das pessoas antes de gravar." }
          SettingsChoice { field:"callDetection.mode"; label:"Quando detectar uma chamada"; options:[{label:"Só notificar",value:"notify-only"},{label:"Gravar automaticamente",value:"record"}].concat(settingsData.readOnly&&settingsData.readOnly.obsEnabled?[{label:"Controlar o OBS",value:"obs"}]:[]) }
          SettingsCheck { field:"callDetection.enqueueOnStop"; text:"Processar a gravação quando a chamada terminar" }
          SettingsSection { text:"Navegadores" }
          GridLayout { columns:compactLayout?2:3; Layout.fillWidth:true; columnSpacing:12; rowSpacing:2
           Repeater { model:(settingsData.apps||[]).filter(function(a){return a.kind==="browser"})
            SettingsCheck { required property var modelData; field:"callDetection.apps."+modelData.id; text:modelData.label; Layout.fillWidth:true }
           }
          }
          SettingsSection { text:"Apps de chamada" }
          GridLayout { columns:compactLayout?2:3; Layout.fillWidth:true; columnSpacing:12; rowSpacing:2
           Repeater { model:(settingsData.apps||[]).filter(function(a){return a.kind==="app"})
            SettingsCheck { required property var modelData; field:"callDetection.apps."+modelData.id; text:modelData.label+(modelData.defaultEnabled?"":" · opcional"); Layout.fillWidth:true }
           }
          }
          SettingsHint { text:"Apps marcados como opcionais também levam ligações pessoais e ficam desligados até você ativar. Zoom, Meet e Teams na web são detectados pelo navegador." }
          SettingsSection { text:"Tempos" }
          SettingsNumber { field:"callDetection.entryDebounceSeconds"; label:"Confirmar a chamada após (segundos)"; from:1; to:120 }
          SettingsNumber { field:"callDetection.exitTimeoutSeconds"; label:"Encerrar após o app parar de usar o microfone (segundos)"; from:1; to:300 }
         }
        }
        // 2 · Captura e áudio
        ScrollView { id:settingsScrollCapture; clip:true; contentWidth:availableWidth
         ColumnLayout { width:settingsScrollCapture.availableWidth; spacing:10
          SettingsChoice { objectName:"settingsBackend"; field:"backend"; label:"O que gravar"; options:[{label:"Só áudio (FFmpeg)",value:"audio"},{label:"Tela e áudio (GPU Screen Recorder)",value:"gpu-screen-recorder"},{label:"OBS (cena configurada no OBS)",value:"obs"}] }
          SettingsHint { visible:!!(settingsData.readOnly&&settingsData.readOnly.backendOutsideList); text:"O backend atual ("+(settingsData.readOnly?settingsData.readOnly.backendOutsideList:"")+") foi definido fora desta tela e continua valendo até você escolher outro." }
          SettingsChoice { field:"capture.audioSource"; label:"Fontes de áudio"; options:[{label:"Microfone e áudio do sistema",value:"both"},{label:"Só microfone",value:"microphone"},{label:"Só áudio do sistema",value:"desktop"},{label:"Sem áudio",value:"none"}] }
          SettingsChoice { field:"capture.microphone"; label:"Microfone"; options:settingsDeviceOptions(false) }
          SettingsChoice { field:"capture.desktop"; label:"Áudio do sistema (monitor da saída)"; options:settingsDeviceOptions(true) }
          RowLayout { Layout.fillWidth:true
           SettingsHint { text:settingsDiag.audio?(settingsDiag.audio.devices||[]).length+" dispositivos encontrados.":(hasSettingsPending("settings-diagnose")?"Procurando dispositivos…":"Lista de dispositivos indisponível; “Padrão do sistema” segue o PipeWire.") }
           FtButton { text:"Atualizar dispositivos"; variant:"outline"; compact:true; enabled:backend.available&&!hasSettingsPending("settings-diagnose"); onClicked:runSettingsDiagnose() }
          }
          SettingsChoice { visible:settingsDraft["backend"]==="gpu-screen-recorder"; field:"capture.encoder"; label:"Codificação de vídeo"; options:[{label:"GPU (recomendado)",value:"gpu"},{label:"CPU",value:"cpu"}] }
          SettingsChoice { visible:settingsDraft["backend"]==="gpu-screen-recorder"; field:"capture.profile"; label:"Qualidade do vídeo"; options:[{label:"Padrão",value:"standard"},{label:"Leve para chamadas (menor resolução e fps)",value:"call-light"}] }
          SettingsText { field:"recordingsDir"; label:"Pasta das gravações"; placeholder:"/home/voce/Videos/Recordings" }
          SettingsHint { text:"Use um caminho absoluto. Se o monitor de chamadas estiver instalado, aplique-o de novo na aba Serviços para ele poder gravar na nova pasta." }
         }
        }
        // 3 · Processamento e IA
        ScrollView { id:settingsScrollProcessing; clip:true; contentWidth:availableWidth
         ColumnLayout { width:settingsScrollProcessing.availableWidth; spacing:10
          SettingsSection { text:"Transcrição" }
          SettingsChoice { objectName:"settingsTranscription"; field:"transcription.provider"; label:"Quem transcreve"; options:[{label:"Whisper.cpp neste computador",value:"whisper-cpp"},{label:"OpenAI (serviço externo)",value:"openai"},{label:"Gemini (serviço externo)",value:"gemini"}] }
          SettingsHint { visible:settingsDraft["transcription.provider"]!=="whisper-cpp"; color:warningColor; text:"O áudio das gravações é enviado para "+(settingsDraft["transcription.provider"]==="openai"?"a OpenAI":"o Google")+". Custos dependem da sua conta de API." }
          SettingsText { visible:settingsDraft["transcription.provider"]==="whisper-cpp"; field:"transcription.whisperCpp.command"; label:"Comando do Whisper.cpp"; placeholder:"whisper-cli" }
          SettingsText { visible:settingsDraft["transcription.provider"]==="whisper-cpp"; field:"transcription.whisperCpp.modelPath"; label:"Arquivo do modelo (ggml)"; placeholder:"/home/voce/.local/share/recording-cli/models/ggml-large-v3-turbo-q5_0.bin" }
          SettingsText { visible:settingsDraft["transcription.provider"]==="openai"; field:"transcription.openaiModel"; label:"Modelo de transcrição da OpenAI" }
          SettingsText { visible:settingsDraft["transcription.provider"]==="gemini"; field:"transcription.geminiModel"; label:"Modelo de transcrição do Gemini" }
          SettingsChoice { field:"transcription.language"; label:"Idioma das chamadas"; options:[{label:"Detectar automaticamente",value:"auto"},{label:"Português",value:"pt"},{label:"Inglês",value:"en"},{label:"Espanhol",value:"es"}] }
          SettingsSection { text:"Resumo" }
          SettingsChoice { field:"summary.provider"; label:"Quem resume"; options:[{label:"Ollama",value:"ollama"},{label:"OpenAI (serviço externo)",value:"openai"}] }
          SettingsText { visible:settingsDraft["summary.provider"]==="ollama"; field:"summary.ollamaUrl"; label:"Endereço do Ollama"; placeholder:"http://127.0.0.1:11434" }
          SettingsHint { visible:settingsDraft["summary.provider"]==="ollama"&&!settingsLoopback(settingsDraft["summary.ollamaUrl"]); color:warningColor; text:"Esse endereço não é este computador: a transcrição será enviada para ele." }
          SettingsText { visible:settingsDraft["summary.provider"]==="ollama"; field:"summary.ollamaModel"; label:"Modelo do Ollama"; placeholder:"qwen3.5:9b" }
          SettingsText { visible:settingsDraft["summary.provider"]==="openai"; field:"summary.openaiModel"; label:"Modelo de resumo da OpenAI" }
          SettingsSection { text:"Execução" }
          SettingsChoice { field:"processing.defaultTarget"; label:"Onde processar"; options:[{label:"Neste computador",value:"local"}].concat(settingsData.readOnly&&settingsData.readOnly.remoteConfigured?[{label:"Worker remoto configurado",value:"remote"}]:[]) }
          SettingsCheck { field:"processing.autoEnqueue"; text:"Processar automaticamente cada gravação nova" }
          SettingsSection { text:"Chaves de API" }
          SettingsHint { text:"OPENAI_API_KEY: "+settingsCredentialText(settingsData.credentials?settingsData.credentials.openai:"")+"\nGEMINI_API_KEY: "+settingsCredentialText(settingsData.credentials?settingsData.credentials.gemini:"")+"\nO Studio não lê nem guarda chaves. Defina-as no ambiente da sessão ou em ~/.config/recording-cli/calls.env (uma por linha, NOME=valor, arquivo com permissão 600)." }
          FtButton { text:"Rotas e privacidade…"; iconName:"shield"; variant:"outline"; enabled:backend.available&&!settingsHasChanges(); onClicked:onboardingDialog.open() }
          SettingsHint { text:settingsHasChanges()?"Salve ou descarte as alterações antes de abrir o resumo de rotas e privacidade.":"Mostra para onde vai cada etapa e permite escolher o processamento local com um clique." }
         }
        }
        // 4 · Serviços e diagnóstico
        ScrollView { id:settingsScrollServices; clip:true; contentWidth:availableWidth
         ColumnLayout { width:settingsScrollServices.availableWidth; spacing:12
          RowLayout { Layout.fillWidth:true
           SettingsHint { text:"Verifica dependências e serviços sem gravar, transcrever nem contatar serviços externos." }
           FtButton { objectName:"settingsDiagnose"; text:hasSettingsPending("settings-diagnose")?"Verificando…":"Verificar agora"; variant:"outline"; compact:true; enabled:backend.available&&!hasSettingsPending("settings-diagnose"); onClicked:runSettingsDiagnose() }
          }
          SettingsSection { text:"Processamento" }
          Repeater { model:settingsDiag.checks||[]
           SettingsCheckRow { required property var modelData; label:modelData.label; status:modelData.status; detail:modelData.detail }
          }
          SettingsSection { text:"Gravação" }
          SettingsCheckRow {
            visible:!!settingsDiag.recording
            label:"Backend de gravação"
            status:settingsDiag.recording&&settingsDiag.recording.selectedBackend?((settingsDiag.recording.warnings||[]).length?"warning":"ok"):"missing"
            detail:settingsDiag.recording?(settingsDiag.recording.selectedBackend?"Vai usar: "+settingsDiag.recording.selectedBackend+".":(settingsDiag.recording.blockedReason||"Indisponível."))+((settingsDiag.recording.warnings||[]).length?"\n"+settingsDiag.recording.warnings.join("\n"):""):""
          }
          SettingsSection { text:"Monitor de chamadas" }
          SettingsCheckRow {
            visible:!!settingsDiag.services
            label:"Serviço recording-cli-calls"
            status:settingsServiceStatus("calls")
            detail:settingsServiceText("calls")
          }
          Flow { Layout.fillWidth:true; spacing:8
           FtButton { objectName:"settingsApplyCalls"; text:hasSettingsPending("settings-service")?"Aplicando…":"Aplicar e reiniciar monitor"; highlighted:enabled&&!!settingsDiag.services&&(settingsDiag.services.calls.staleConfig||settingsDiag.services.calls.outdated||!settingsDiag.services.calls.active); enabled:backend.available&&!settingsHasChanges()&&!!settingsData.values&&settingsData.values["callDetection.enabled"]===true&&!hasSettingsPending("settings-service"); onClicked:runSettingsService("calls-apply") }
           FtButton { text:"Desativar monitor"; variant:"outline"; enabled:backend.available&&!!settingsDiag.services&&settingsDiag.services.calls.installed&&!hasSettingsPending("settings-service"); onClicked:runSettingsService("calls-disable") }
          }
          SettingsHint { text:settingsHasChanges()?"Salve as alterações antes de aplicar o monitor.":settingsData.values&&settingsData.values["callDetection.enabled"]!==true?"Ative a gravação automática e salve para poder aplicar o monitor.":"O monitor lê a configuração ao iniciar; aplique depois de salvar mudanças de gravação. Nunca é reiniciado durante uma gravação." }
          SettingsSection { text:"Bandeja" }
          SettingsCheckRow {
            visible:!!settingsDiag.services
            label:"Indicador na bandeja (REC, pausar, parar)"
            status:settingsServiceStatus("tray")
            detail:settingsServiceText("tray")
          }
          FtButton { text:"Instalar ou reiniciar a bandeja"; variant:"outline"; enabled:backend.available&&!hasSettingsPending("settings-service"); onClicked:runSettingsService("tray-apply") }
         }
        }
     }
    }
    footer:Item { implicitHeight:60; RowLayout { anchors.fill:parent; anchors.margins:12; spacing:10
     Label { text:settingsHasChanges()?Object.keys(settingsChanges()).length+" alteração(ões) não salva(s)":""; color:warningColor; Layout.fillWidth:true; elide:Text.ElideRight }
     FtButton { objectName:"settingsCancel"; text:settingsHasChanges()?"Descartar e fechar":"Fechar"; enabled:!hasSettingsPending("settings-save")&&!hasSettingsPending("settings-service"); onClicked:settingsDialog.reject() }
     FtButton { visible:settingsNeedsReload||!!settingsError; text:backend.available?"Reler configuração":"Reconectar"; enabled:!hasSettingsPending("settings-read")&&!hasSettingsPending("settings-save"); onClicked:{if(backend.available)loadSettings(false);else backend.reconnect()} }
     FtButton { objectName:"settingsSave"; highlighted:enabled; text:hasSettingsPending("settings-save")?"Salvando…":"Salvar"; enabled:backend.available&&settingsEditable&&settingsHasChanges(); onClicked:saveSettingsDraft() }
    } }
}
