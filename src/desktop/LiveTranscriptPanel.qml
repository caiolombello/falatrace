import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Live transcript beside the notepad (DESIGN-STUDIO §2.8): hidden until asked for. It reads the lines
// of the running capture (live-read, every 2 s while shown) and can turn the live text on or off for
// this recording (live-set). A cloud provider needs consent before audio leaves the computer. These
// lines are provisional (aiInk); the final transcript is made after the meeting. Failures stay here.
Rectangle {
    id: panel
    objectName: "liveTranscriptPanel"
    property string sessionId: ""
    property bool shown: false
    property int liveGeneration: 0
    property int lastSeq: 0
    property var lines: []
    property string status: ""
    property bool stale: false
    property string provider: ""
    property string error: ""
    property bool reading: false
    property bool switching: false
    property bool followEnd: true
    readonly property string currentProvider: provider || String(studioSettings["live.provider"] || "")
    // Fail closed, like the bridge: a provider not known here (settings not read yet) counts as one
    // outside this computer, so the consent is asked instead of a switch the bridge would refuse.
    readonly property bool external: currentProvider !== "whisper-cpp"
    readonly property bool running: status === "running" || status === "behind"
    signal addToNotes(string text)
    color: surfaceAlt
    Rectangle { anchors.left: parent.left; anchors.top: parent.top; anchors.bottom: parent.bottom; width: 1; color: divider }
    // A consent names one provider: another provider needs it again.
    onCurrentProviderChanged: consent.checked = false

    function providerName(value) { return ({"whisper-cpp": t("Neste computador (Whisper)"), groq: "Groq", openai: "OpenAI", "": t("o provedor configurado")})[value] || value }
    function reset() {
        liveGeneration += 1
        lastSeq = 0; lines = []; status = ""; stale = false; provider = ""; error = ""; reading = false; switching = false; followEnd = true
        consent.checked = false
    }
    function read() {
        if (!feature("live") || !sessionId || reading || !backend.available) return
        reading = true
        if (send("live-read", sessionId, {sinceSeq: lastSeq}, {origin: "live", liveGeneration: liveGeneration}) < 0) reading = false
    }
    function setEnabled(enabled) {
        if (!feature("live") || !sessionId || switching || !backend.available) return
        if (enabled && external && !consent.checked) return
        error = ""; switching = true
        const payload = enabled && external ? {enabled: true, consent: true} : {enabled: enabled}
        if (send("live-set", sessionId, payload, {origin: "live", liveGeneration: liveGeneration}) < 0) { switching = false; error = t("Sem conexão com o FalaTrace.") }
    }
    function handleResponse(request, message) {
        if (request.liveGeneration !== liveGeneration) return
        if (request.op === "live-read") {
            reading = false
            if (!message.ok) { error = t(message.error); return }
            const result = message.result
            const fresh = asList(result.lines)
            if (fresh.length) {
                const merged = lines.concat(fresh.filter(function(line){ return line.seq > panel.lastSeq }))
                lines = merged.length > 500 ? merged.slice(merged.length - 500) : merged
            }
            lastSeq = Math.max(lastSeq, Number(result.lastSeq) || 0)
            status = result.status || ""
            stale = result.stale === true
            if (result.provider) provider = result.provider
            error = result.error ? t(result.error) : ""
            if (result.hasMore) Qt.callLater(read)
            return
        }
        if (request.op === "live-set") {
            switching = false
            if (!message.ok) { error = t(message.error); return }
            status = message.result.status || ""
            if (message.result.provider) provider = message.result.provider
            if (message.result.enabled) Qt.callLater(read)
        }
    }
    function connectionLost() { reading = false; if (switching) { switching = false; error = t("Não deu para confirmar a mudança. Tente de novo.") } }
    function statusText() {
        if (status === "behind" || (running && stale)) return t("Atrasada — a transcrição final é feita no fim.")
        if (status === "failed") return t("A transcrição ao vivo parou. A gravação continua.")
        if (running) return providerName(currentProvider) + " · " + (currentProvider === "groq" ? t("≈ 16 s de atraso") : currentProvider === "openai" ? t("20–35 s de atraso") : t("≈ 20 s de atraso"))
        if (status === "stopped") return t("Transcrição ao vivo desligada.")
        return ""
    }
    onSessionIdChanged: reset()
    onShownChanged: if (shown) read()
    Timer { interval: 2000; repeat: true; running: panel.shown && panel.visible && !!panel.sessionId && feature("live") && backend.available && (captureStatus.active || panel.running); onTriggered: panel.read() }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 14
        spacing: 10
        RowLayout {
            Layout.fillWidth: true
            FtOverline { text: t("Ao vivo"); Layout.fillWidth: true }
            FtButton { objectName: "liveTranscriptOff"; visible: panel.running; compact: true; variant: "ghost"; text: t("Desligar"); enabled: !panel.switching; onClicked: panel.setEnabled(false) }
        }
        Label {
            objectName: "liveStatus"
            visible: text !== ""
            Layout.fillWidth: true
            text: panel.statusText()
            textFormat: Text.PlainText
            color: panel.status === "failed" || panel.status === "behind" || panel.stale ? warningColor : muted
            font.pixelSize: 12
            wrapMode: Text.WordWrap
        }
        Label { visible: panel.error !== ""; Layout.fillWidth: true; text: panel.error; textFormat: Text.PlainText; color: warningColor; font.pixelSize: 12; wrapMode: Text.WordWrap }

        // Off: what each option costs and where the audio goes, then the switch (with consent for a cloud provider).
        ColumnLayout {
            visible: !panel.running
            Layout.fillWidth: true
            spacing: 8
            Label { Layout.fillWidth: true; text: t("Veja a conversa enquanto ela acontece. A transcrição final é feita depois, com mais qualidade."); textFormat: Text.PlainText; color: ink; font.pixelSize: 13; wrapMode: Text.WordWrap }
            GridLayout {
                Layout.fillWidth: true
                columns: 3
                columnSpacing: 10
                rowSpacing: 4
                Repeater {
                    model: [
                        {id: "whisper-cpp", name: t("Neste computador"), cost: t("grátis · usa CPU"), delay: t("≈ 20 s"), where: t("não sai")},
                        {id: "groq", name: "Groq", cost: t("US$ 0,04/h"), delay: t("≈ 16 s"), where: "Groq"},
                        {id: "openai", name: "OpenAI", cost: t("US$ 0,27/h"), delay: t("20–35 s"), where: "OpenAI"}
                    ]
                    delegate: Label {
                        required property var modelData
                        Layout.columnSpan: 3
                        Layout.fillWidth: true
                        text: modelData.name + " · " + modelData.cost + " · " + modelData.delay + " · " + tf("áudio: %1", modelData.where)
                        textFormat: Text.PlainText
                        wrapMode: Text.WordWrap
                        font.pixelSize: 12
                        font.weight: modelData.id === panel.currentProvider ? Font.DemiBold : Font.Normal
                        color: modelData.id === panel.currentProvider ? ink : muted
                    }
                }
            }
            Label { Layout.fillWidth: true; text: t("Preços conferidos em 25/10/2026."); textFormat: Text.PlainText; color: muted; font.pixelSize: 11 }
            RowLayout {
                objectName: "liveConsent"
                visible: panel.external
                Layout.fillWidth: true
                spacing: 6
                FtCheck { id: consent; objectName: "liveConsentCheck"; text: liveConsentLabel.text }
                Label {
                    id: liveConsentLabel
                    Layout.fillWidth: true
                    text: tf("Enviar o áudio desta reunião para %1 enquanto ela acontece (fora deste computador).", panel.providerName(panel.currentProvider))
                    textFormat: Text.PlainText; color: ink; font.pixelSize: 12; wrapMode: Text.WordWrap
                    MouseArea { anchors.fill: parent; onClicked: consent.toggle() }
                }
            }
            FtButton {
                objectName: "liveEnable"
                Layout.alignment: Qt.AlignLeft
                // Never wider than the panel (a long provider name elides instead of pushing the panel out).
                Layout.maximumWidth: parent.width
                compact: true
                variant: "primary"
                iconName: panel.external ? "cloud" : "wave"
                text: !panel.external ? t("Ligar") : panel.currentProvider ? tf("Ligar e enviar para %1", panel.providerName(panel.currentProvider)) : t("Ligar e enviar")
                Accessible.name: panel.external ? tf("Ligar e enviar para %1", panel.providerName(panel.currentProvider)) : t("Ligar")
                enabled: feature("live") && !!panel.sessionId && captureStatus.active && !panel.switching && (!panel.external || consent.checked)
                onClicked: panel.setEnabled(true)
            }
        }

        // On: the lines, newest at the bottom; "+ notas" copies one into your notepad.
        ListView {
            id: lineList
            objectName: "liveLines"
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: panel.lines.length > 0
            clip: true
            spacing: 6
            model: panel.lines
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar {}
            onCountChanged: if (panel.followEnd) Qt.callLater(positionViewAtEnd)
            onMovementEnded: panel.followEnd = atYEnd
            delegate: Item {
                id: lineItem
                required property var modelData
                objectName: "liveLine-" + modelData.seq
                width: ListView.view.width
                implicitHeight: lineRow.implicitHeight + 6
                HoverHandler { id: lineHover }
                RowLayout {
                    id: lineRow
                    width: parent.width
                    spacing: 8
                    Label { text: clock(lineItem.modelData.start); textFormat: Text.PlainText; color: muted; font.pixelSize: 11; font.family: "monospace"; Layout.alignment: Qt.AlignTop; topPadding: 2 }
                    Label { text: lineItem.modelData.text || ""; textFormat: Text.PlainText; color: aiInk; font.pixelSize: 13; wrapMode: Text.Wrap; Layout.fillWidth: true; lineHeight: 1.2 }
                    FtButton {
                        objectName: "liveAddNote-" + lineItem.modelData.seq
                        Layout.alignment: Qt.AlignTop
                        opacity: lineHover.hovered || activeFocus ? 1 : 0.35
                        iconOnly: true; compact: true; variant: "ghost"; iconName: "plus"
                        text: t("Copiar para as suas notas")
                        Accessible.name: text
                        onClicked: panel.addToNotes(lineItem.modelData.text || "")
                    }
                }
            }
        }
        FtButton { visible: lineList.visible && !panel.followEnd; Layout.alignment: Qt.AlignHCenter; compact: true; variant: "outline"; text: t("Ir para o fim"); onClicked: { panel.followEnd = true; lineList.positionViewAtEnd() } }
        Item { visible: !lineList.visible; Layout.fillHeight: true }
        Label { visible: panel.running && !panel.lines.length; Layout.fillWidth: true; text: t("As primeiras falas aparecem em alguns segundos."); textFormat: Text.PlainText; color: muted; font.pixelSize: 12; wrapMode: Text.WordWrap }
    }
}
