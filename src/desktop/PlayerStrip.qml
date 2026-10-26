import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Recording 1.0

// The player under the meeting (DESIGN-STUDIO §2.5): play, timeline, time, speed and captions in one
// 44 px strip, with a 112×63 thumbnail that hosts the video. The video item is always in the tree and
// never hidden (mpv initialises the player in onReady); clicking the thumbnail or pressing v moves the
// same frame into the larger pane above the document (`expandedSlot`).
Rectangle {
    id: strip
    objectName: "playerStrip"
    property alias video: video
    property alias videoFrame: videoFrame
    property alias captionOverlay: captionOverlay
    property alias captionViewport: captionViewport
    property alias caption: caption
    property alias captionToggle: captionToggle
    property alias timeline: timeline
    property alias openRecordingButton: openRecordingButton
    property Item expandedSlot: null
    property bool videoExpanded: false
    property real speed: 1
    readonly property bool removed: !!selected.key && mediaGone(selected)
    readonly property bool narrow: width < 620
    implicitHeight: removed ? 40 : 52
    color: surface
    Rectangle { anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; height: 1; color: divider }

    function speedLabel(value) { return (uiLanguage === "en" ? String(value) : String(value).replace(".", ",")) + "×" }
    function setSpeed(value) { speed = value; if (playerInitialized) video.setPropertyAsync("speed", value) }
    function toggleVideo() { if (!removed) videoExpanded = !videoExpanded }
    Connections { target: window; function onSelectedChanged() { if (!selected.key) strip.videoExpanded = false } }

    // Media removed by retention or missing: one line, everything else keeps working.
    RowLayout {
        visible: strip.removed
        anchors.fill: parent
        anchors.leftMargin: 16; anchors.rightMargin: 16
        spacing: 8
        FtIcon { name: selected.location === "missing" ? "alert" : "transcript"; tint: selected.location === "missing" ? warningColor : muted; size: 15 }
        Label {
            objectName: "playerRemovedLine"
            Layout.fillWidth: true
            text: selected.location === "missing" ? t("Arquivo da gravação não encontrado neste computador.") : removedText()
            textFormat: Text.PlainText; color: muted; font.pixelSize: 12; elide: Text.ElideRight
            function removedText() {
                const media = detail.media || ({})
                const at = media.removedAt ? new Date(media.removedAt) : null
                return at && !isNaN(at.getTime()) ? tf("Áudio removido em %1 — notas e transcrição continuam aqui.", Qt.formatDate(at, t("dd/MM"))) : t("Áudio removido — notas e transcrição continuam aqui.")
            }
        }
    }

    RowLayout {
        visible: !strip.removed
        anchors.fill: parent
        anchors.leftMargin: 12; anchors.rightMargin: 12
        spacing: 8

        // Thumbnail: the video while collapsed, a waveform tile for audio-only recordings.
        Item {
            id: thumbSlot
            Layout.preferredWidth: 72; Layout.preferredHeight: 40
            Layout.alignment: Qt.AlignVCenter
            Accessible.role: Accessible.Button
            Accessible.name: strip.videoExpanded ? t("Recolher o vídeo (v)") : t("Mostrar o vídeo (v)")
        }
        FtButton {
            id: openRecordingButton
            visible: !!selected.key && !resolving && !mediaGone(selected) && !mediaReady
            enabled: backend.available && !mediaGone(selected)
            compact: true
            variant: "primary"
            iconName: "play"
            text: t("Ouvir gravação")
            onClicked: openRecording()
        }
        BusyIndicator { visible: resolving; running: resolving; implicitWidth: 26; implicitHeight: 26 }
        Label { visible: resolving; text: t("Preparando a gravação…"); textFormat: Text.PlainText; color: muted; font.pixelSize: 12 }
        FtButton { visible: mediaReady; iconOnly: true; compact: true; variant: "primary"; iconName: paused ? "play" : "pause"; text: paused ? t("Reproduzir") : t("Pausar"); Accessible.name: text; onClicked: togglePlay() }
        FtButton { visible: mediaReady && !strip.narrow; compact: true; variant: "ghost"; text: "−10 s"; Accessible.name: t("Voltar dez segundos"); onClicked: seek(position - 10) }
        FtButton { visible: mediaReady && !strip.narrow; compact: true; variant: "ghost"; text: "+10 s"; Accessible.name: t("Avançar dez segundos"); onClicked: seek(position + 10) }
        Slider {
            id: timeline
            Layout.fillWidth: true
            from: 0; to: window.duration || 1; value: window.position; enabled: mediaReady
            Accessible.name: t("Posição do vídeo")
            onMoved: window.seek(value)
            background: Rectangle {
                x: timeline.leftPadding; y: timeline.topPadding + timeline.availableHeight / 2 - height / 2
                width: timeline.availableWidth; height: 4; radius: 2
                color: divider
                Rectangle { width: timeline.visualPosition * parent.width; height: parent.height; radius: 2; color: accent; visible: timeline.enabled }
            }
            handle: Rectangle {
                x: timeline.leftPadding + timeline.visualPosition * (timeline.availableWidth - width)
                y: timeline.topPadding + timeline.availableHeight / 2 - height / 2
                implicitWidth: 16; implicitHeight: 16; radius: 8
                color: surface
                border.width: 3; border.color: timeline.enabled ? accent : dividerStrong
                Rectangle { anchors.fill: parent; anchors.margins: -4; radius: 12; color: "transparent"; border.width: 2; border.color: accent; visible: timeline.visualFocus }
            }
        }
        Label { text: clock(position) + " / " + clock(duration); color: muted; font.family: "monospace"; font.pixelSize: 12 }
        FtButton {
            id: speedButton
            objectName: "playerSpeed"
            visible: !strip.narrow
            compact: true; variant: "ghost"
            text: strip.speedLabel(strip.speed)
            Accessible.name: tf("Velocidade %1", strip.speedLabel(strip.speed))
            enabled: mediaReady
            onClicked: speedMenu.popup(speedButton, 0, -speedMenu.implicitHeight)
            FtMenu {
                id: speedMenu
                implicitWidth: 120
                Action { text: strip.speedLabel(1); onTriggered: strip.setSpeed(1) }
                Action { text: strip.speedLabel(1.25); onTriggered: strip.setSpeed(1.25) }
                Action { text: strip.speedLabel(1.5); onTriggered: strip.setSpeed(1.5) }
                Action { text: strip.speedLabel(2); onTriggered: strip.setSpeed(2) }
            }
        }
        CheckBox {
            id: captionToggle; objectName: "captionToggle"
            text: "CC"
            Accessible.name: t("Exibir legendas quando houver uma faixa disponível")
            checked: captions; enabled: !!selected.key; onToggled: captions = checked
            spacing: 6
            ToolTip.visible: hovered
            ToolTip.delay: 500
            ToolTip.text: captionStatusText
            indicator: Rectangle {
                implicitWidth: 30; implicitHeight: 18; radius: 9
                x: captionToggle.leftPadding; y: captionToggle.topPadding + (captionToggle.availableHeight - height) / 2
                color: captionToggle.checked ? accent : dividerStrong
                border.width: captionToggle.visualFocus ? 2 : 0; border.color: ink
                opacity: captionToggle.enabled ? 1 : 0.5
                Rectangle { width: 12; height: 12; radius: 6; y: 3; x: captionToggle.checked ? parent.width - width - 3 : 3; color: captionToggle.checked ? onAccent : surface }
            }
            contentItem: Label { text: captionToggle.text; color: captionToggle.enabled ? ink : muted; font.pixelSize: 12; font.weight: Font.DemiBold; leftPadding: captionToggle.indicator.width + captionToggle.spacing; verticalAlignment: Text.AlignVCenter }
        }
        FtButton { objectName: "videoToggle"; iconOnly: true; compact: true; variant: strip.videoExpanded ? "secondary" : "ghost"; iconName: "video"; text: strip.videoExpanded ? t("Recolher o vídeo (v)") : t("Mostrar o vídeo (v)"); Accessible.name: text; onClicked: strip.toggleVideo() }
    }

    // One frame for the video: in the thumbnail while collapsed, in the pane above the document when expanded.
    Rectangle {
        id: videoFrame
        parent: strip.videoExpanded && strip.expandedSlot ? strip.expandedSlot : thumbSlot
        anchors.fill: parent
        color: "#05080D"; radius: strip.videoExpanded ? 12 : 6; clip: true
        RecordingVideo {
            id: video; objectName: "recordingVideo"; anchors.fill: parent
            onReady: { playerInitialized = true; setPropertyAsync("pause", true); setPropertyAsync("hwdec", smokeSoftware ? "no" : "auto-safe"); setPropertyAsync("volume", 70); loadMedia() }
        }
        // Audio-only (no frames) or not open yet: a tile instead of a black frame.
        Rectangle {
            anchors.fill: parent
            visible: !mediaReady || selected.location === "audio-only" || (detail.media && detail.media.state === "audio-only")
            color: "#0F2120"
            ColumnLayout {
                anchors.centerIn: parent
                spacing: 8
                FtIcon { Layout.alignment: Qt.AlignHCenter; name: "wave"; tint: "#57D5B0"; size: strip.videoExpanded ? 34 : 20 }
                Label { visible: strip.videoExpanded; Layout.alignment: Qt.AlignHCenter; text: mediaReady ? t("Só áudio") : resolving ? t("Preparando a gravação…") : t("Gravação pronta para ouvir"); textFormat: Text.PlainText; color: "#F4F1E9"; font.pixelSize: 15; font.weight: Font.DemiBold }
            }
        }
        Rectangle {
            anchors.top: parent.top; anchors.left: parent.left; anchors.margins: 12
            width: Math.min(parent.width - 24, voicesRow.implicitWidth + 20); height: voicesRow.implicitHeight + 12; radius: 8
            color: "#D90B1716"
            visible: strip.videoExpanded && mediaReady && !!activeSpeakerLabels(position)
            RowLayout {
                id: voicesRow
                anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; anchors.leftMargin: 10; anchors.rightMargin: 10
                spacing: 7
                FtIcon { name: "users"; tint: "#57D5B0"; size: 14 }
                Label { id: currentVoices; Layout.fillWidth: true; text: activeSpeakerLabels(position) + (detail.review&&detail.review.revision.humanReviewed?t(" · revisão humana; identidade não confirmada"):t(" · automático")); textFormat: Text.PlainText; color: "#57D5B0"; font.pixelSize: 12; wrapMode: Text.WordWrap; maximumLineCount: 2; elide: Text.ElideRight }
            }
        }
        Rectangle {
            id: captionOverlay; objectName: "captionOverlay"
            anchors.bottom: parent.bottom; anchors.bottomMargin: 20; anchors.horizontalCenter: parent.horizontalCenter
            width: Math.min(parent.width - 36, caption.implicitWidth + 28); height: Math.min(caption.implicitHeight + 16, parent.height * 0.42)
            radius: 10; color: "#E6050B0B"
            visible: strip.videoExpanded && captions && mediaReady && captionAvailable && activeCaptionText.length > 0
            border.width: captionViewport.activeFocus ? 2 : 0; border.color: "#57D5B0"
            Flickable {
                id: captionViewport; objectName: "captionViewport"
                anchors.fill: parent; anchors.margins: 8; clip: true
                contentWidth: width; contentHeight: caption.implicitHeight
                activeFocusOnTab: captionOverlay.visible && contentHeight > height
                Accessible.role: Accessible.Pane
                Accessible.name: t("Legenda completa")
                Accessible.description: t("Quando a legenda for longa, use as setas, Page Up, Page Down ou Espaço para percorrer o texto.")
                ScrollBar.vertical: ScrollBar { policy: captionViewport.contentHeight > captionViewport.height ? ScrollBar.AlwaysOn : ScrollBar.AsNeeded }
                Keys.onPressed: event => {
                    let step = 0
                    if (event.key === Qt.Key_Down) step = 22
                    else if (event.key === Qt.Key_Up) step = -22
                    else if (event.key === Qt.Key_PageDown || event.key === Qt.Key_Space) step = height * 0.8
                    else if (event.key === Qt.Key_PageUp) step = -height * 0.8
                    else return
                    contentY = Math.max(0, Math.min(Math.max(0, contentHeight - height), contentY + step))
                    event.accepted = true
                }
                Label { id: caption; width: captionViewport.width - 12; text: activeCaptionText; textFormat: Text.PlainText; color: "white"; wrapMode: Text.WordWrap; horizontalAlignment: Text.AlignHCenter; font.pixelSize: 16; onTextChanged: captionViewport.contentY = 0 }
            }
        }
        MouseArea {
            anchors.fill: parent
            visible: !strip.videoExpanded
            cursorShape: Qt.PointingHandCursor
            onClicked: strip.toggleVideo()
        }
    }
}
