import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Settings 11 · Perguntar e receitas: who answers questions about your meetings — this computer, a
// subscription the person already pays for (ChatGPT or a command-line tool), or an API key, each saying
// what leaves this computer and what it costs; an ACP agent and the context size under "Mais opções" —
// and your recipes. Detection (assistant-detect), the ChatGPT sign-in and the recipe list are sent
// only with features.assistant / features.recipes and fail into this page's own state.
SettingsPage {
    id: assistantPage
    objectName: "settingsAssistant"
    property var detected: null
    property bool detecting: false
    property var chatgpt: ({})
    property var recipes: []
    property bool recipesLoading: false
    property bool recipesLoaded: false
    property string error: ""
    property string notice: ""
    property string confirmDelete: ""
    property int pageGeneration: 0
    readonly property var presetKeys: ({openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY", gemini: "GEMINI_API_KEY", xai: "XAI_API_KEY", groq: "GROQ_API_KEY", mistral: "MISTRAL_API_KEY", deepseek: "DEEPSEEK_API_KEY", together: "TOGETHER_API_KEY", anthropic: "ANTHROPIC_API_KEY", custom: "CUSTOM_API_KEY"})
    readonly property var presetOptions: [
        {label: "OpenRouter", value: "openrouter"}, {label: "OpenAI", value: "openai"}, {label: "Google Gemini", value: "gemini"}, {label: "xAI (Grok)", value: "xai"},
        {label: "Groq", value: "groq"}, {label: "Mistral", value: "mistral"}, {label: "DeepSeek", value: "deepseek"}, {label: "Together AI", value: "together"},
        {label: "Anthropic (Claude)", value: "anthropic"}, {label: t("Outra API compatível"), value: "custom"}
    ]
    readonly property var acpAgents: [
        {value: "claude", label: "Claude Agent"}, {value: "codex", label: "Codex"}, {value: "gemini", label: "Gemini CLI"}, {value: "opencode", label: "OpenCode"},
        {value: "kiro", label: "Kiro CLI"}, {value: "copilot", label: "GitHub Copilot CLI"}, {value: "cursor", label: "Cursor Agent"}, {value: "goose", label: "goose"},
        {value: "qwen", label: "Qwen Code"}, {value: "grok", label: "Grok Build"}, {value: "custom", label: t("Outro agente (comando)")}
    ]
    readonly property var cliTools: [{value: "claude", label: "Claude Code"}, {value: "codex", label: "Codex"}, {value: "gemini", label: "Gemini CLI"}, {value: "opencode", label: "OpenCode"}]
    // Agents whose own tools FalaTrace cannot switch off (ASSISTANT_TOOL_AGENTS in src/config/defaults.ts):
    // each answers only once the user accepted that, agent by agent, in assistant.agentToolsAccepted.
    readonly property var toolAgents: ["acp:claude", "acp:codex", "acp:gemini", "acp:opencode", "acp:kiro", "acp:copilot", "acp:cursor", "acp:qwen", "acp:grok", "acp:custom", "cli:codex", "cli:gemini", "cli:opencode"]

    function reset() { pageGeneration += 1; detected = null; detecting = false; chatgpt = ({}); recipes = []; recipesLoading = false; recipesLoaded = false; error = ""; notice = ""; confirmDelete = "" }
    function request(op, payload, meta) { return send(op, "", payload || ({}), Object.assign({origin: "settingsAssistant", pageGeneration: pageGeneration}, meta || ({}))) }
    function load() {
        if (!backend.available) return
        if (feature("assistant") && !detected && !detecting) detect()
        if (feature("recipes") && !recipesLoaded && !recipesLoading) loadRecipes()
    }
    function detect() {
        if (!feature("assistant") || detecting) return
        detecting = true
        if (request("assistant-detect") < 0) { detecting = false; error = t("Sem conexão com o FalaTrace.") }
    }
    function loadRecipes() {
        recipesLoading = true
        if (request("recipes-list") < 0) { recipesLoading = false; error = t("Sem conexão com o FalaTrace.") }
    }
    function signIn() { error = ""; if (request("assistant-chatgpt-login") < 0) error = t("Sem conexão com o FalaTrace.") }
    function signOut() { error = ""; if (request("assistant-chatgpt-logout") < 0) error = t("Sem conexão com o FalaTrace.") }
    function removeRecipe(recipe) {
        error = ""; notice = ""
        if (request("recipes-delete", {id: recipe.id, expectedVersion: recipe.version}, {recipeName: recipe.name}) < 0) error = t("Sem conexão com o FalaTrace.")
    }
    // A recipe saved or deleted here also reaches the Ask drawer when it is open ("/" and the suggestions).
    function saved(recipe) { notice = tf("Receita “%1” salva.", recipe.name || ""); recipesLoading = false; loadRecipes(); askPanel.reloadRecipes() }
    function found(list, field, value) { const entry = asList(list).find(function(item){ return item[field] === value }); return entry || null }
    function toolsAgent(kind) { return kind + ":" + (kind === "acp" ? settingsDraft["assistant.acpAgent"] : settingsDraft["assistant.cliTool"]) }
    function needsToolsOk(kind) { return toolAgents.indexOf(toolsAgent(kind)) >= 0 }
    function toolsAccepted(kind) { return asList(settingsDraft["assistant.agentToolsAccepted"]).indexOf(toolsAgent(kind)) >= 0 }
    function setToolsAccepted(kind, accepted) {
        const agent = toolsAgent(kind)
        const next = asList(settingsDraft["assistant.agentToolsAccepted"]).filter(function(item){ return item !== agent })
        if (accepted) next.push(agent)
        setSettingsField("assistant.agentToolsAccepted", next)
    }
    function agentLabel(option) {
        if (!detected || option.value === "custom") return option.label
        const entry = found(detected.acp, "agent", option.value)
        if (!entry) return option.label
        if (entry.found) return option.label + t(" · encontrado")
        if (entry.cliFound) return option.label + tf(" · falta o adaptador %1", entry.command)
        // agy, which replaced the Gemini CLI, has no ACP mode: it answers through the command line.
        const cli = option.value === "gemini" ? found(detected.cli, "tool", "gemini") : null
        if (cli && cli.found && cli.command === "agy") return option.label + t(" · o agy só responde pela linha de comando")
        return option.label + t(" · não instalado")
    }
    // signedIn is null for a tool without a status command: installed, sign-in unknown.
    function toolLabel(option) {
        if (!detected) return option.label
        const entry = found(detected.cli, "tool", option.value)
        if (!entry) return option.label
        // The "gemini" choice runs agy (the Antigravity CLI) when it is installed.
        const label = option.label + (entry.found && entry.command !== option.value ? " (" + entry.command + ")" : "")
        return label + (!entry.found ? t(" · não instalado") : entry.signedIn === true ? t(" · conectado") : entry.signedIn === false ? t(" · sem login") : t(" · encontrado"))
    }
    function handleResponse(request, message) {
        if (request.pageGeneration !== pageGeneration) return
        const result = message.result
        if (request.op === "assistant-detect") {
            detecting = false
            if (!message.ok) { error = t("Não deu para procurar os agentes instalados agora."); return }
            detected = result
            if (result.chatgpt) chatgpt = {state: result.chatgpt.signedIn ? "signed-in" : "idle", email: result.chatgpt.email || ""}
        } else if (request.op === "assistant-chatgpt-login") {
            if (!message.ok) { chatgpt = {state: "failed", error: message.error}; return }
            chatgpt = {state: "waiting"}
            if (result.authUrl) Qt.openUrlExternally(result.authUrl)
        } else if (request.op === "assistant-chatgpt-status" || request.op === "assistant-chatgpt-logout") {
            if (!message.ok) { chatgpt = {state: "failed", error: message.error}; return }
            chatgpt = result
        } else if (request.op === "recipes-list") {
            recipesLoading = false
            if (!message.ok) { error = t("Não deu para carregar as receitas agora."); return }
            recipesLoaded = true
            recipes = asList(result.recipes)
        } else if (request.op === "recipes-delete") {
            confirmDelete = ""
            if (!message.ok) { error = t(message.error); return }
            notice = tf("Receita “%1” excluída.", request.recipeName || "")
            loadRecipes(); askPanel.reloadRecipes()
        }
    }
    function connectionLost() {
        if (detecting || recipesLoading) error = t("Sem conexão com o FalaTrace.")
        detecting = false; recipesLoading = false; confirmDelete = ""; pageGeneration += 1
        if (chatgpt.state === "waiting") chatgpt = ({})
    }
    // A sign-in finishes in the browser: read its state until it settles.
    Timer {
        interval: 2000; repeat: true
        running: settingsDialog.visible && assistantPage.chatgpt.state === "waiting" && backend.available
        onTriggered: { if (!hasPending("assistant-chatgpt-status")) assistantPage.request("assistant-chatgpt-status") }
    }

    // Subscriptions the person already pays for: the ChatGPT sign-in and the four command-line tools,
    // in one list (installed and connected first) instead of two cards that both named Claude and Codex.
    readonly property var subscriptionOptions: [
        {key: "chatgpt", provider: "chatgpt", tool: "", label: "ChatGPT", detail: t("Pela sua conta Plus ou Pro, com login no navegador. Sem cobrança por uso.")},
        {key: "claude", provider: "cli", tool: "claude", label: "Claude Code", detail: t("Pelo comando claude, com a conta em que ele entrou (assinatura do Claude ou chave da Anthropic).")},
        {key: "codex", provider: "cli", tool: "codex", label: "Codex", detail: t("Pelo comando codex, com a conta em que ele entrou (plano do ChatGPT ou chave da OpenAI, cobrada por uso).")},
        {key: "gemini", provider: "cli", tool: "gemini", label: "Gemini", detail: t("Pelo agy (ou o Gemini CLI), com a sua conta do Google.")},
        {key: "opencode", provider: "cli", tool: "opencode", label: "OpenCode", detail: t("Pelo comando opencode; o custo segue o provedor configurado nele.")}
    ]
    readonly property string subscriptionKey: settingsDraft["assistant.provider"] === "chatgpt" ? "chatgpt" : settingsDraft["assistant.provider"] === "cli" ? (settingsDraft["assistant.cliTool"] || "claude") : ""
    // 0 connected · 1 installed, sign-in unknown · 2 installed without sign-in · 3 not installed · 4 not checked yet.
    function subscriptionRank(option) {
        if (option.provider === "chatgpt") return chatgpt.state === "signed-in" ? 0 : 1
        const entry = detected ? found(detected.cli, "tool", option.tool) : null
        if (!entry) return 4
        return !entry.found ? 3 : entry.signedIn === true ? 0 : entry.signedIn === false ? 2 : 1
    }
    function subscriptionStatus(option) {
        if (option.provider === "chatgpt") return chatgpt.state === "signed-in" ? {text: t("Conectado"), kind: "accent"} : chatgpt.state === "waiting" ? {text: t("Aguardando o navegador…"), kind: "neutral"} : {text: t("Sem conta conectada"), kind: "neutral"}
        const entry = detected ? found(detected.cli, "tool", option.tool) : null
        if (!entry) return {text: "", kind: "neutral"}
        if (!entry.found) return {text: t("Não instalado"), kind: "neutral"}
        const via = entry.command && entry.command !== option.tool ? " · " + entry.command : ""
        return entry.signedIn === true ? {text: t("Conectado") + via, kind: "accent"} : entry.signedIn === false ? {text: t("Sem login") + via, kind: "warning"} : {text: t("Instalado") + via, kind: "neutral"}
    }
    readonly property var sortedSubscriptions: subscriptionOptions.slice().sort(function(a, b){ return subscriptionRank(a) - subscriptionRank(b) })
    function chooseSubscription(option) {
        if (!settingsEditable) return
        setSettingsField("assistant.provider", option.provider)
        if (option.tool) setSettingsField("assistant.cliTool", option.tool)
    }
    // Choosing the card picks what is ready: a connected tool, else the ChatGPT account if connected, else Claude Code.
    readonly property var defaultSubscription: sortedSubscriptions.length ? sortedSubscriptions[0] : subscriptionOptions[1]
    property bool showAdvanced: settingsDraft["assistant.provider"] === "acp"

    readonly property string provider: settingsDraft["assistant.provider"] || "local"
    readonly property string choiceHeading: provider === "local" ? t("Neste computador") : provider === "api" ? t("Uma chave de API") : provider === "acp" ? t("Um agente ACP") : t("Sua conta ou ferramenta")

    SettingsHint { text: t("Quem responde quando você pergunta sobre suas reuniões. O que sai deste computador pede confirmação antes do primeiro envio de cada conversa.") }
    // The choices stay short and all in view; the chosen one's settings go in one panel below them.
    SettingsRadioCard {
        objectName: "assistantLocal"; field: "assistant.provider"; value: "local"; iconName: "lock"
        heading: t("Neste computador")
        detail: t("O Ollama deste computador responde. Nada sai daqui. Grátis.")
    }
    SettingsRadioCard {
        objectName: "assistantSubscription"; field: "assistant.provider"; values: ["cli", "chatgpt"]; iconName: "external"
        value: assistantPage.defaultSubscription.provider
        heading: t("Sua conta ou ferramenta")
        detail: t("Uma conta ou ferramenta que você já usa (ChatGPT, Claude Code, Codex…). Os trechos vão para o serviço dela; o custo segue o seu plano ou a configuração da ferramenta.")
    }
    SettingsRadioCard {
        objectName: "assistantApi"; field: "assistant.provider"; value: "api"; iconName: "cloud"
        heading: t("Uma chave de API")
        detail: t("Os trechos das reuniões vão para o provedor escolhido. Cobrado por uso na sua conta da API.")
    }

    Rectangle {
        objectName: "assistantChoicePanel"
        Layout.fillWidth: true
        implicitHeight: choicePanel.implicitHeight + 24
        radius: 10; color: surfaceAlt; border.width: 1; border.color: divider
        ColumnLayout {
            id: choicePanel
            anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top
            anchors.margins: 12
            spacing: 8
            FtOverline { text: assistantPage.choiceHeading; Layout.fillWidth: true }

            // Neste computador
            ColumnLayout {
                visible: assistantPage.provider === "local"
                Layout.fillWidth: true
                spacing: 8
                SettingsText { field: "assistant.localModel"; label: t("Modelo do Ollama"); placeholder: "qwen3.5:9b" }
                SettingsHint { objectName: "assistantCloudModel"; visible: ollamaCloudModel(settingsDraft["assistant.localModel"]); color: warningColor; text: t("Esse é um modelo na nuvem do Ollama: os trechos saem deste computador, com confirmação antes do primeiro envio de cada conversa.") }
            }

            // Sua assinatura: the ChatGPT sign-in and the command-line tools, installed and connected first
            ColumnLayout {
                visible: assistantPage.provider === "cli" || assistantPage.provider === "chatgpt"
                Layout.fillWidth: true
                spacing: 4
                Repeater {
                    model: assistantPage.sortedSubscriptions
                    delegate: AbstractButton {
                        id: subscriptionRow
                        required property var modelData
                        readonly property bool chosen: assistantPage.subscriptionKey === modelData.key
                        readonly property var status: assistantPage.subscriptionStatus(modelData)
                        objectName: "assistantSubscription-" + modelData.key
                        Layout.fillWidth: true
                        implicitHeight: subscriptionRowLayout.implicitHeight + 12
                        hoverEnabled: true
                        enabled: settingsEditable
                        Accessible.role: Accessible.RadioButton
                        Accessible.name: modelData.label + (status.text ? ", " + status.text : "")
                        Accessible.description: modelData.detail
                        Accessible.checked: chosen
                        onClicked: assistantPage.chooseSubscription(modelData)
                        Keys.onSpacePressed: clicked()
                        contentItem: Item {}
                        background: Rectangle {
                            radius: 8
                            color: subscriptionRow.chosen ? selectedSurface : subscriptionRow.hovered ? hoverSurface : "transparent"
                            border.width: subscriptionRow.visualFocus ? 2 : 0
                            border.color: accent
                        }
                        RowLayout {
                            id: subscriptionRowLayout
                            anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                            anchors.leftMargin: 10; anchors.rightMargin: 10
                            spacing: 10
                            Rectangle {
                                Layout.alignment: Qt.AlignTop; Layout.topMargin: 2
                                implicitWidth: 14; implicitHeight: 14; radius: 7
                                color: "transparent"; border.width: 2; border.color: subscriptionRow.chosen ? accent : dividerStrong
                                Rectangle { anchors.centerIn: parent; width: 6; height: 6; radius: 3; color: accent; visible: subscriptionRow.chosen }
                            }
                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 1
                                Label { text: subscriptionRow.modelData.label; textFormat: Text.PlainText; color: assistantPage.subscriptionRank(subscriptionRow.modelData) === 3 ? muted : ink; font.weight: Font.DemiBold; Layout.fillWidth: true; elide: Text.ElideRight }
                                Label { text: subscriptionRow.modelData.detail; textFormat: Text.PlainText; color: muted; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                            }
                            FtChip { visible: subscriptionRow.status.text !== ""; text: subscriptionRow.status.text; kind: subscriptionRow.status.kind; Layout.alignment: Qt.AlignTop; maximumWidth: 180 }
                        }
                    }
                }
                ColumnLayout {
                    objectName: "assistantChatgpt"
                    visible: assistantPage.provider === "chatgpt"
                    Layout.fillWidth: true
                    Layout.topMargin: 6
                    spacing: 8
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 8
                        Label {
                            Layout.fillWidth: true
                            text: assistantPage.chatgpt.state === "signed-in" ? (assistantPage.chatgpt.email ? tf("Conectado como %1.", assistantPage.chatgpt.email) : t("Conta do ChatGPT conectada."))
                                : assistantPage.chatgpt.state === "waiting" ? t("Aguardando a autorização no navegador…")
                                : assistantPage.chatgpt.state === "failed" ? (t(assistantPage.chatgpt.error || "") || t("O login do ChatGPT não foi concluído."))
                                : t("Sem conta conectada.")
                            textFormat: Text.PlainText; wrapMode: Text.WordWrap; font.pixelSize: 13
                            color: assistantPage.chatgpt.state === "signed-in" ? accent : assistantPage.chatgpt.state === "failed" ? warningColor : muted
                        }
                        FtButton {
                            objectName: "chatgptSignIn"
                            visible: feature("assistant")
                            compact: true; variant: assistantPage.chatgpt.state === "signed-in" ? "outline" : "primary"
                            text: assistantPage.chatgpt.state === "signed-in" ? t("Sair") : assistantPage.chatgpt.state === "waiting" ? t("Aguardando o navegador…") : t("Entrar com o ChatGPT")
                            enabled: backend.available && assistantPage.chatgpt.state !== "waiting" && !hasPending("assistant-chatgpt-login") && !hasPending("assistant-chatgpt-logout")
                            onClicked: assistantPage.chatgpt.state === "signed-in" ? assistantPage.signOut() : assistantPage.signIn()
                        }
                    }
                    SettingsText { field: "assistant.chatgptModel"; label: t("Modelo (opcional)"); placeholder: t("o padrão do plano") }
                }
                ColumnLayout {
                    objectName: "assistantCli"
                    visible: assistantPage.provider === "cli"
                    Layout.fillWidth: true
                    Layout.topMargin: 6
                    spacing: 8
                    SettingsText { field: "assistant.cliModel"; label: t("Modelo (opcional)"); placeholder: t("o padrão da ferramenta") }
                    SettingsHint { text: t("O FalaTrace não instala essas ferramentas: instale e entre na conta pelo terminal.") }
                    AgentToolsOk { kind: "cli"; objectName: "assistantCliTools" }
                }
            }

            // Uma chave de API
            ColumnLayout {
                visible: assistantPage.provider === "api"
                Layout.fillWidth: true
                spacing: 8
                SettingsChoice { field: "assistant.apiPreset"; label: t("Provedor"); options: assistantPage.presetOptions }
                SettingsText { visible: settingsDraft["assistant.apiPreset"] === "custom"; field: "assistant.apiBaseUrl"; label: t("Endereço da API"); placeholder: "https://api.exemplo.com/v1"; hint: t("HTTPS, ou HTTP só neste computador.") }
                SettingsText { field: "assistant.apiModel"; label: t("Modelo (opcional)"); placeholder: t("o padrão do provedor") }
                SecretField {
                    name: assistantPage.presetKeys[settingsDraft["assistant.apiPreset"]] || "OPENROUTER_API_KEY"
                    label: tf("Chave %1", assistantPage.presetKeys[settingsDraft["assistant.apiPreset"]] || "OPENROUTER_API_KEY")
                    testService: settingsDraft["assistant.apiPreset"] || "openrouter"
                }
            }

            // Um agente ACP (chosen under "Mais opções")
            ColumnLayout {
                visible: assistantPage.provider === "acp"
                Layout.fillWidth: true
                spacing: 8
                SettingsChoice { field: "assistant.acpAgent"; label: t("Agente"); options: assistantPage.acpAgents.map(function(option){ return {label: assistantPage.agentLabel(option), value: option.value} }) }
                SettingsText { visible: settingsDraft["assistant.acpAgent"] === "custom"; field: "assistant.acpCommand"; label: t("Comando do agente"); placeholder: "meu-agente --acp" }
                SettingsHint { text: t("O FalaTrace não instala agentes. Instale e entre na conta pelo terminal.") }
                AgentToolsOk { kind: "acp"; objectName: "assistantAcpTools" }
            }

            RowLayout {
                visible: feature("assistant") && ["cli", "chatgpt", "acp"].indexOf(assistantPage.provider) >= 0
                Layout.fillWidth: true
                Layout.topMargin: 4
                spacing: 8
                SettingsHint { text: assistantPage.detecting ? t("Procurando agentes e ferramentas neste computador…") : assistantPage.detected ? t("Agentes e ferramentas conferidos neste computador.") : t("Confere quais agentes e ferramentas estão instalados.") }
                FtButton { objectName: "assistantDetect"; compact: true; variant: "outline"; iconName: "refresh"; text: t("Procurar de novo"); enabled: backend.available && !assistantPage.detecting; onClicked: assistantPage.detect() }
            }
            Label { visible: !!assistantPage.error; text: assistantPage.error; textFormat: Text.PlainText; color: warningColor; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
        }
    }

    // Less common: an ACP agent (adapters, custom commands) and how much each question sends.
    FtButton {
        objectName: "assistantAdvancedToggle"
        compact: true; variant: "ghost"
        iconName: assistantPage.showAdvanced ? "chevron-down" : "chevron-right"
        text: assistantPage.showAdvanced ? t("Menos opções") : t("Mais opções: agente ACP e contexto")
        Accessible.name: text
        onClicked: assistantPage.showAdvanced = !assistantPage.showAdvanced
    }
    ColumnLayout {
        objectName: "assistantAdvanced"
        visible: assistantPage.showAdvanced
        Layout.fillWidth: true
        spacing: 10
        SettingsRadioCard {
            objectName: "assistantAcp"; field: "assistant.provider"; value: "acp"; iconName: "tools"
            heading: t("Um agente ACP")
            detail: t("Um agente deste computador (Claude Agent, Codex…) pelo protocolo ACP, com a conta dele. Para quem já usa um adaptador ACP.")
        }
        SettingsSection { text: t("Contexto") }
        SettingsNumber { field: "assistant.maxContextCharacters"; label: t("Tamanho máximo do que é enviado por pergunta (caracteres)"); from: 8000; to: 400000 }
        SettingsText { field: "assistant.embeddingModel"; label: t("Busca por significado (opcional)"); placeholder: "nomic-embed-text"; hint: t("Um modelo de embeddings no Ollama deste computador. Vazio: busca por palavras.") }
    }

    SettingsSection { visible: feature("recipes"); text: t("Receitas") }
    RowLayout {
        visible: feature("recipes")
        Layout.fillWidth: true
        spacing: 8
        SettingsHint { text: t("Uma receita é uma pergunta pronta. Digite / em Perguntar para usar. As embutidas não mudam; duplique uma para ajustar.") }
        FtButton { objectName: "recipeNew"; compact: true; variant: "outline"; iconName: "plus"; text: t("Nova receita…"); enabled: backend.available && assistantPage.recipesLoaded; onClicked: recipeEditor.openNew() }
    }
    BusyIndicator { visible: assistantPage.recipesLoading; running: visible; implicitWidth: 28; implicitHeight: 28 }
    Label { objectName: "recipesNotice"; visible: !!assistantPage.notice; text: assistantPage.notice; textFormat: Text.PlainText; color: accent; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
    Repeater {
        model: feature("recipes") ? assistantPage.recipes : []
        delegate: Rectangle {
            id: recipeRow
            required property var modelData
            objectName: "recipeRow-" + modelData.id
            Layout.fillWidth: true
            implicitHeight: recipeColumn.implicitHeight + 16
            radius: 10; color: surfaceAlt; border.width: 1; border.color: divider
            ColumnLayout {
                id: recipeColumn
                anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                anchors.leftMargin: 12; anchors.rightMargin: 8
                spacing: 4
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8
                    FtIcon { name: "slash"; tint: recipeRow.modelData.builtIn ? muted : accent; size: 16 }
                    Label { text: recipeRow.modelData.name; textFormat: Text.PlainText; color: ink; font.weight: Font.DemiBold; elide: Text.ElideRight; Layout.fillWidth: true }
                    FtChip { text: recipeRow.modelData.scope === "meeting" ? t("Uma reunião") : t("Várias reuniões") }
                    FtChip { visible: recipeRow.modelData.builtIn === true; text: t("Embutida") }
                    FtButton { compact: true; variant: "ghost"; iconName: "copy"; iconOnly: compactLayout; text: t("Duplicar"); Accessible.name: tf("Duplicar a receita %1", recipeRow.modelData.name); enabled: backend.available; onClicked: recipeEditor.openCopy(recipeRow.modelData) }
                    FtButton { visible: recipeRow.modelData.builtIn !== true; compact: true; variant: "ghost"; iconName: "edit"; iconOnly: compactLayout; text: t("Editar"); Accessible.name: tf("Editar a receita %1", recipeRow.modelData.name); enabled: backend.available; onClicked: recipeEditor.openEdit(recipeRow.modelData) }
                    FtButton { visible: recipeRow.modelData.builtIn !== true; compact: true; variant: "ghost"; iconName: "trash"; iconOnly: true; text: t("Excluir"); Accessible.name: tf("Excluir a receita %1", recipeRow.modelData.name); enabled: backend.available; onClicked: assistantPage.confirmDelete = recipeRow.modelData.id }
                }
                Label { visible: text !== ""; text: recipeRow.modelData.description || ""; textFormat: Text.PlainText; color: muted; font.pixelSize: 12; elide: Text.ElideRight; Layout.fillWidth: true }
                RowLayout {
                    visible: assistantPage.confirmDelete === recipeRow.modelData.id
                    Layout.fillWidth: true
                    spacing: 8
                    SettingsHint { color: warningColor; text: tf("Excluir “%1”? Não dá para desfazer.", recipeRow.modelData.name) }
                    FtButton { compact: true; variant: "outline"; text: t("Cancelar"); onClicked: assistantPage.confirmDelete = "" }
                    FtButton { compact: true; variant: "danger"; text: t("Excluir"); enabled: backend.available && !hasPending("recipes-delete"); onClicked: assistantPage.removeRecipe(recipeRow.modelData) }
                }
            }
        }
    }

    // An agent that can still run tools on this computer says so and asks for an explicit OK.
    component AgentToolsOk: ColumnLayout {
        id: toolsOk
        property string kind: "acp"
        visible: assistantPage.needsToolsOk(kind)
        Layout.fillWidth: true
        spacing: 4
        SettingsHint { color: warningColor; text: t("Este agente pode rodar ferramentas no seu computador (ler arquivos, executar comandos), e o FalaTrace não consegue desligá-las: um texto de reunião pode tentar usá-las. Ele só recebe perguntas depois que você confirmar.") }
        WrappedCheck {
            objectName: toolsOk.objectName + "Ok"
            text: t("Entendo: este agente pode rodar ferramentas no meu computador")
            checked: assistantPage.toolsAccepted(toolsOk.kind)
            enabled: settingsEditable
            Accessible.name: text
            // The box follows the chosen agent: the binding is put back after each click.
            onToggled: { assistantPage.setToolsAccepted(toolsOk.kind, checked); checked = Qt.binding(function(){ return assistantPage.toolsAccepted(toolsOk.kind) }) }
        }
    }
}
