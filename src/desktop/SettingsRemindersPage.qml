import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Settings 12 · Agenda e lembretes: when to be reminded before a calendar meeting, with what, and
// the reminders service (settings-service reminders-apply / reminders-disable, as in Serviços).
SettingsPage {
    id: remindersPage
    objectName: "settingsReminders"
    readonly property var service: settingsDiag.services && settingsDiag.services.reminders ? settingsDiag.services.reminders : null
    readonly property bool calendarConnected: !!settingsDialog.googleStatus.connected && settingsDraft["google.calendar"] === true
    readonly property bool kdeCalendar: settingsDraft["calendar.kde"] === true

    SettingsChoice {
        objectName: "settingsReminderMode"
        field: "reminders.mode"; label: t("Avisar antes das reuniões da agenda")
        options: [{label: t("Automático: quando a gravação não for automática"), value: "auto"}, {label: t("Sempre"), value: "on"}, {label: t("Nunca"), value: "off"}]
    }
    SettingsNumber { field: "reminders.leadMinutes"; label: t("Minutos antes"); from: 1; to: 15 }
    SettingsCheck { field: "reminders.brief"; text: t("Incluir o que ficou da última reunião") }
    SettingsHint { text: t("O aviso mostra as decisões e as ações abertas da última reunião com as mesmas pessoas. Tudo é lido neste computador.") }

    SettingsSection { text: t("Agenda") }
    RowLayout {
        Layout.fillWidth: true
        spacing: 8
        FtIcon { name: "calendar"; tint: remindersPage.calendarConnected || remindersPage.kdeCalendar ? accent : muted; size: 16 }
        Label {
            objectName: "remindersCalendarStatus"
            Layout.fillWidth: true
            text: remindersPage.calendarConnected ? (settingsDialog.googleStatus.email ? tf("Agenda do Google conectada como %1.", settingsDialog.googleStatus.email) : t("Agenda do Google conectada."))
                : remindersPage.kdeCalendar ? t("Usando a agenda do KOrganizer.")
                : hasSettingsPending("settings-google-status") ? t("Conferindo a agenda…") : t("Conecte a Agenda do Google ou use a do KOrganizer para receber lembretes.")
            textFormat: Text.PlainText; wrapMode: Text.WordWrap; font.pixelSize: 13
            color: remindersPage.calendarConnected || remindersPage.kdeCalendar ? ink : muted
        }
        FtButton { visible: !remindersPage.calendarConnected && !remindersPage.kdeCalendar; compact: true; variant: "outline"; text: t("Conectar agenda"); onClicked: settingsDialog.goToSection(5) }
    }
    SettingsCheck { objectName: "remindersKdeCalendar"; field: "calendar.kde"; text: t("Usar a agenda do KOrganizer (KDE)") }
    SettingsHint { text: t("Lê as agendas marcadas no KOrganizer direto do banco do Akonadi, só para leitura. Nada sai deste computador.") }

    SettingsSection { text: t("Serviço de lembretes") }
    SettingsCheckRow {
        visible: !!settingsDiag.services
        label: t("Lembretes de reunião")
        status: !remindersPage.service ? "skipped" : !remindersPage.service.installed ? "missing" : remindersPage.service.active && !remindersPage.service.staleConfig && !remindersPage.service.outdated ? "ok" : "warning"
        detail: !remindersPage.service ? t("Estado indisponível.") : settingsServiceText("reminders")
    }
    Flow {
        Layout.fillWidth: true
        spacing: 8
        FtButton { objectName: "remindersApply"; text: hasSettingsPending("settings-service") ? t("Aplicando…") : t("Aplicar os lembretes"); compact: true; variant: "outline"; enabled: backend.available && !settingsHasChanges() && !hasSettingsPending("settings-service"); onClicked: runSettingsService("reminders-apply") }
        FtButton { text: t("Desativar"); compact: true; variant: "outline"; enabled: backend.available && !!remindersPage.service && remindersPage.service.installed === true && !hasSettingsPending("settings-service"); onClicked: runSettingsService("reminders-disable") }
    }
    SettingsHint { text: settingsHasChanges() ? t("Salve antes de aplicar.") : t("O serviço lê a configuração ao iniciar: aplique de novo depois de mudar lembretes ou agenda.") }
}
