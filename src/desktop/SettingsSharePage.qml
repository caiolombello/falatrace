import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Settings 14 · Compartilhar: where "Enviar" can put your notes. Each destination says in one line
// whether it stays on this computer; the Notion and Slack keys go through the usual key flow.
SettingsPage {
    id: sharePage
    objectName: "settingsShare"

    SettingsHint { text: t("Antes de enviar, o Studio mostra a prévia exata. Destinos fora deste computador pedem sua confirmação a cada envio.") }

    SettingsSection { text: "Obsidian" }
    SettingsHint { text: t("Fica neste computador: cada envio vira um arquivo .md no seu cofre.") }
    SettingsText { objectName: "settingsObsidianVault"; field: "destinations.obsidianVault"; label: t("Cofre do Obsidian"); placeholder: "/home/voce/Obsidian/Trabalho"; picker: "folder" }
    SettingsText { field: "destinations.obsidianFolder"; label: t("Pasta dentro do cofre"); placeholder: "FalaTrace" }

    SettingsSection { text: "Notion" }
    SettingsHint { text: t("Vai para o Notion, fora deste computador: uma página nova por envio, sem custo além do seu plano.") }
    SecretField { name: "NOTION_TOKEN"; label: t("Token da integração do Notion"); purpose: t("Crie uma integração interna no Notion e compartilhe com ela a página que recebe as notas.") }
    SettingsText { field: "destinations.notionParentId"; label: t("Página que recebe as notas (ID)"); placeholder: "0123456789abcdef0123456789abcdef"; hint: t("Os 32 caracteres no fim do endereço da página.") }

    SettingsSection { text: "Slack" }
    SettingsHint { text: t("Vai para o canal do Slack do webhook, fora deste computador.") }
    SecretField { name: "SLACK_WEBHOOK_URL"; label: t("Webhook do Slack"); purpose: t("Um webhook de entrada do app do Slack, ligado a um canal.") }

    SettingsSection { text: t("Meu app de IA") }
    SettingsHint { text: t("Abre o app escolhido com as notas copiadas; você cola e envia. As ferramentas de terminal recebem o texto e o enviam ao provedor delas.") }
    SettingsChoice {
        field: "destinations.aiApp"; label: t("App")
        options: [{label: t("ChatGPT (navegador)"), value: "chatgpt-web"}, {label: t("Claude (navegador)"), value: "claude-web"}, {label: "Claude Desktop", value: "claude-desktop"}, {label: t("Gemini (navegador)"), value: "gemini-web"},
                  {label: t("Claude Code (terminal)"), value: "claude-cli"}, {label: t("Codex (terminal)"), value: "codex-cli"}, {label: t("Gemini CLI (terminal)"), value: "gemini-cli"}, {label: t("OpenCode (terminal)"), value: "opencode-cli"}]
    }
}
