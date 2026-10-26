import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Recording 1.0

// The player under the meeting (DESIGN-STUDIO §2.5): play, timeline, time, speed and captions in one
// strip, with a thumbnail that hosts the video. The video item is always in the tree and never hidden
// (mpv initialises the player in onReady); the same frame moves into the larger pane above the document
// (`expandedSlot`, v or a click), takes most of the page in cinema mode, or the whole window in full
// screen (`fullScreenSlot`, F or a double click; Esc leaves it first). Captions and the speaker overlay
// live in the frame, so they follow it at every size.
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
    property Item fullScreenSlot: null
    property bool videoExpanded: false
    property bool cinema: false
    property bool fullScreen: false
    property real speed: 1
    // The person's last choices this session: a video opens expanded (the first time too) and in cinema
    // mode when they last left it so; audio-only recordings stay a tile in the strip.
    property bool preferExpanded: true
    property bool preferCinema: false
    property string appliedFor: ""
    readonly property bool removed: !!selected.key && mediaGone(selected)
    readonly property bool narrow: width < 620
    // Whether there is something to watch: retention or the bridge say audio-only, mpv says once this
    // meeting's media is open (never the previous meeting's file, still loaded for a moment after a switch),
    // and before that the file type does (an audio capture is a .mka).
    readonly property bool hasVideo: {
        if (!selected.key || removed) return false
        const media = detail.media || ({})
        if (media.state === "audio-only" || selected.media === "audio-only" || selected.location === "audio-only") return false
        if (media.features && media.features.frames === false) return false
        if (mediaReady && mediaProbed && mediaLoadGeneration === generation) return mediaHasVideo
        const name = String(selected.fileName || selected.key || "").toLowerCase()
        const extension = name.indexOf(".") >= 0 ? name.slice(name.lastIndexOf(".") + 1) : ""
        return ["mka", "m4a", "mp3", "wav", "ogg", "oga", "opus", "flac", "aac", "weba"].indexOf(extension) < 0
    }
    implicitHeight: removed ? 40 : 52
    color: surface
    Rectangle { anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; height: 1; color: divider }

    function speedLabel(value) { return (uiLanguage === "en" ? String(value) : String(value).replace(".", ",")) + "×" }
    function setSpeed(value) { speed = value; if (playerInitialized) video.setPropertyAsync("speed", value) }
    // v: full screen first goes back to the page; otherwise the pane opens or closes (and is remembered).
    function toggleVideo() {
        if (removed) return
        if (fullScreen) { setFullScreen(false); return }
        videoExpanded = !videoExpanded
        if (hasVideo) preferExpanded = videoExpanded
    }
    function setCinema(on) {
        if (removed || !hasVideo) return
        if (on) videoExpanded = true
        cinema = on; preferCinema = on
        if (on) preferExpanded = true
    }
    // Full screen covers the whole window with the video (and the window fills the screen where there is one).
    // Leaving it gives the keyboard focus back to where it was (the button or key that asked for it).
    property int restoreVisibility: Window.Windowed
    property Item focusBeforeFullScreen: null
    function setFullScreen(on) {
        if (on === fullScreen || (on && (removed || !hasVideo || !fullScreenSlot))) return
        if (on) {
            focusBeforeFullScreen = window.activeFocusItem
            videoExpanded = true
            fullScreen = true
            if (Qt.platform.pluginName !== "offscreen" && window.visibility !== Window.FullScreen) { restoreVisibility = window.visibility; window.visibility = Window.FullScreen }
            Qt.callLater(function(){ if (strip.fullScreenSlot) strip.fullScreenSlot.forceActiveFocus(Qt.OtherFocusReason) })
        } else {
            fullScreen = false
            if (window.visibility === Window.FullScreen) window.visibility = restoreVisibility === Window.FullScreen ? Window.Windowed : restoreVisibility
            const back = focusBeforeFullScreen
            focusBeforeFullScreen = null
            // The item may be gone (another meeting) or hidden (the video collapsed): then the focus stays put.
            if (back && back.visible && back.enabled !== false && !!selected.key) Qt.callLater(function(){ if (back.visible) back.forceActiveFocus(Qt.OtherFocusReason) })
        }
    }
    // A meeting opens with the video as last left this session (expanded the first time); leaving one
    // always leaves full screen.
    function applyPreference() {
        if (appliedFor === (selected.key || "")) return
        appliedFor = selected.key || ""
        if (fullScreen) setFullScreen(false)
        videoExpanded = !!selected.key && hasVideo && preferExpanded
        cinema = videoExpanded && preferCinema
    }
    Connections {
        target: window
        function onSelectedChanged() { if (!selected.key) { strip.setFullScreen(false); strip.videoExpanded = false; strip.cinema = false; strip.appliedFor = "" } else strip.applyPreference() }
    }
    // The detail (or mpv) can reveal that a recording has no video after it opened: it goes back to the tile.
    onHasVideoChanged: if (!hasVideo) { setFullScreen(false); cinema = false; if (videoExpanded && appliedFor === (selected.key || "")) videoExpanded = false }

    // Buttons drawn over the video: light icons on a dark disc, the usual focus ring.
    component VideoButton: AbstractButton {
        id: videoButton
        property string iconName: ""
        implicitWidth: 34; implicitHeight: 34
        hoverEnabled: true
        focusPolicy: Qt.StrongFocus
        Accessible.role: Accessible.Button
        Accessible.name: text
        ToolTip.visible: hovered && text !== ""
        ToolTip.text: text
        ToolTip.delay: 400
        contentItem: Item { FtIcon { anchors.centerIn: parent; name: videoButton.iconName; tint: "#F4F1E9"; size: 18 } }
        background: Rectangle {
            radius: 17; color: videoButton.down ? "#E6050B0B" : videoButton.hovered ? "#D9172F2D" : "#B3050B0B"
            Rectangle { anchors.fill: parent; anchors.margins: -3; radius: 20; color: "transparent"; border.width: 2; border.color: "#57D5B0"; visible: videoButton.visualFocus }
        }
    }

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

        // Thumbnail: the video while collapsed; a waveform tile for audio-only recordings.
        Item {
            id: thumbSlot
            objectName: "playerThumbnail"
            // Empty while the frame is in the pane above: no blank slot in the strip.
            visible: !strip.videoExpanded
            Layout.preferredWidth: 72; Layout.preferredHeight: 40
            Layout.alignment: Qt.AlignVCenter
            Accessible.role: Accessible.Button
            Accessible.name: strip.hasVideo ? (strip.videoExpanded ? t("Recolher o vídeo (v)") : t("Mostrar o vídeo (v)")) : t("Gravação só de áudio")
        }
        FtButton {
            id: openRecordingButton
            objectName: "openRecordingButton"
            // The expanded video carries its own big button; the strip keeps this one otherwise.
            visible: !!selected.key && !resolving && !mediaGone(selected) && !mediaReady && !strip.videoExpanded
            enabled: backend.available && !mediaGone(selected)
            compact: true
            variant: "primary"
            iconName: "play"
            text: strip.hasVideo ? t("Assistir gravação") : t("Ouvir gravação")
            onClicked: { if (strip.hasVideo && !strip.videoExpanded) { strip.videoExpanded = true; strip.preferExpanded = true } openRecording() }
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
        FtButton { objectName: "videoToggle"; iconOnly: true; compact: true; variant: strip.videoExpanded ? "secondary" : "ghost"; iconName: strip.hasVideo ? "video" : "wave"; text: strip.hasVideo ? (strip.videoExpanded ? t("Recolher o vídeo (v)") : t("Mostrar o vídeo (v)")) : (strip.videoExpanded ? t("Recolher (v)") : t("Mostrar legendas e falantes (v)")); Accessible.name: text; onClicked: strip.toggleVideo() }
        FtButton { objectName: "fullScreenButton"; visible: strip.hasVideo && !strip.narrow; iconOnly: true; compact: true; variant: "ghost"; iconName: "fullscreen"; text: t("Tela cheia (F)"); Accessible.name: text; onClicked: strip.setFullScreen(true) }
    }

    // One frame for the video: in the thumbnail while collapsed, in the pane above the document when
    // expanded (cinema just makes that pane bigger), over the whole window in full screen.
    Rectangle {
        id: videoFrame
        parent: strip.fullScreen && strip.fullScreenSlot ? strip.fullScreenSlot : strip.videoExpanded && strip.expandedSlot ? strip.expandedSlot : thumbSlot
        anchors.fill: parent
        color: "#05080D"; radius: strip.fullScreen ? 0 : strip.videoExpanded ? 12 : 6; clip: true
        readonly property bool large: strip.videoExpanded || strip.fullScreen
        RecordingVideo {
            id: video; objectName: "recordingVideo"; anchors.fill: parent
            onReady: { playerInitialized = true; setPropertyAsync("pause", true); setPropertyAsync("hwdec", smokeSoftware ? "no" : "auto-safe"); setPropertyAsync("volume", 70); loadMedia() }
        }
        // Not open yet, or audio only: a tile instead of a black frame (a film tile for video, a waveform for audio).
        Rectangle {
            objectName: "videoTile"
            readonly property bool watch: strip.hasVideo
            anchors.fill: parent
            visible: !mediaReady || !strip.hasVideo
            color: watch ? "#0B1716" : "#0F2120"
            ColumnLayout {
                anchors.centerIn: parent
                width: Math.min(parent.width - 24, 360)
                spacing: 10
                FtIcon { Layout.alignment: Qt.AlignHCenter; name: parent.parent.watch ? "video" : "wave"; tint: "#57D5B0"; size: videoFrame.large ? 40 : 20 }
                Label {
                    visible: videoFrame.large
                    Layout.alignment: Qt.AlignHCenter; Layout.fillWidth: true; horizontalAlignment: Text.AlignHCenter
                    text: resolving ? t("Preparando a gravação…") : !parent.parent.watch ? (mediaReady ? t("Só áudio") : t("Gravação pronta para ouvir")) : t("Gravação pronta para assistir")
                    textFormat: Text.PlainText; color: "#F4F1E9"; font.pixelSize: 15; font.weight: Font.DemiBold; wrapMode: Text.WordWrap
                }
                FtButton {
                    objectName: "videoPanePlay"
                    visible: videoFrame.large && !mediaReady && !resolving && !mediaGone(selected)
                    Layout.alignment: Qt.AlignHCenter
                    variant: "primary"; iconName: "play"
                    text: parent.parent.watch ? t("Assistir gravação") : t("Ouvir gravação")
                    enabled: backend.available
                    onClicked: openRecording()
                }
            }
        }
        Rectangle {
            anchors.top: parent.top; anchors.left: parent.left; anchors.margins: 12
            width: Math.min(parent.width - 24, voicesRow.implicitWidth + 20); height: voicesRow.implicitHeight + 12; radius: 8
            color: "#D90B1716"
            visible: videoFrame.large && mediaReady && !!activeSpeakerLabels(position)
            RowLayout {
                id: voicesRow
                anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; anchors.leftMargin: 10; anchors.rightMargin: 10
                spacing: 7
                FtIcon { name: "users"; tint: "#57D5B0"; size: 14 }
                Label { id: currentVoices; Layout.fillWidth: true; text: activeSpeakerLabels(position); textFormat: Text.PlainText; color: "#57D5B0"; font.pixelSize: strip.fullScreen ? 15 : 12; wrapMode: Text.WordWrap; maximumLineCount: 2; elide: Text.ElideRight }
            }
        }
        Rectangle {
            id: captionOverlay; objectName: "captionOverlay"
            anchors.bottom: parent.bottom; anchors.bottomMargin: strip.fullScreen ? 84 : 20; anchors.horizontalCenter: parent.horizontalCenter
            width: Math.min(parent.width - 36, caption.implicitWidth + 28); height: Math.min(caption.implicitHeight + 16, parent.height * 0.42)
            radius: 10; color: "#E6050B0B"
            visible: videoFrame.large && captions && mediaReady && captionAvailable && activeCaptionText.length > 0
            border.width: captionViewport.activeFocus ? 2 : 0; border.color: "#57D5B0"
            Flickable {
                id: captionViewport; objectName: "captionViewport"
                anchors.fill: parent; anchors.margins: 8; clip: true
                contentWidth: width; contentHeight: caption.implicitHeight
                activeFocusOnTab: captionOverlay.visible && contentHeight > height
                Accessible.role: Accessible.Pane
                Accessible.name: t("Legenda completa")
                Accessible.description: t("Quando a legenda for longa, use as setas, Page Up, Page Down ou Espaço para percorrer o texto.")
                ScrollBar.vertical: ScrollBar { policy: captionViewport.contentHeight > captionViewport.height + 1 ? ScrollBar.AlwaysOn : ScrollBar.AlwaysOff }
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
                // Bigger with the picture: readable in cinema mode and in full screen.
                Label { id: caption; width: captionViewport.width - 12; text: activeCaptionText; textFormat: Text.PlainText; color: "white"; wrapMode: Text.WordWrap; horizontalAlignment: Text.AlignHCenter; font.pixelSize: Math.round(Math.max(16, Math.min(30, videoFrame.height / 24))); onTextChanged: captionViewport.contentY = 0 }
            }
        }
        // Collapsed: a click opens the pane. Expanded or full screen: a double click toggles full screen.
        MouseArea {
            anchors.fill: parent
            z: -1
            enabled: !strip.removed
            cursorShape: strip.videoExpanded ? Qt.ArrowCursor : Qt.PointingHandCursor
            onClicked: { if (!strip.videoExpanded) strip.toggleVideo() }
            onDoubleClicked: { if (strip.videoExpanded && strip.hasVideo) strip.setFullScreen(!strip.fullScreen) }
        }
        // Watching controls on the picture: cinema, full screen, collapse.
        Row {
            objectName: "videoControls"
            anchors.top: parent.top; anchors.right: parent.right; anchors.margins: 10
            spacing: 8
            visible: strip.videoExpanded && !strip.fullScreen
            VideoButton { objectName: "cinemaToggle"; visible: strip.hasVideo; iconName: "cinema"; text: strip.cinema ? t("Sair do modo cinema") : t("Modo cinema: vídeo grande, notas ao lado"); Accessible.checkable: true; Accessible.checked: strip.cinema; onClicked: strip.setCinema(!strip.cinema) }
            VideoButton { objectName: "fullScreenToggle"; visible: strip.hasVideo; iconName: "fullscreen"; text: t("Tela cheia (F)"); onClicked: strip.setFullScreen(true) }
            VideoButton { objectName: "videoCollapse"; iconName: "chevron-down"; text: t("Recolher o vídeo (v)"); onClicked: strip.toggleVideo() }
        }
        // Full screen: the essentials over the picture (Space, arrows and Esc work too).
        Rectangle {
            objectName: "fullScreenBar"
            visible: strip.fullScreen
            anchors.bottom: parent.bottom; anchors.horizontalCenter: parent.horizontalCenter; anchors.bottomMargin: 20
            width: fullScreenRow.implicitWidth + 24; height: fullScreenRow.implicitHeight + 16; radius: 12
            color: "#CC050B0B"
            Row {
                id: fullScreenRow
                anchors.centerIn: parent
                spacing: 10
                VideoButton { iconName: paused ? "play" : "pause"; text: paused ? t("Reproduzir") : t("Pausar"); enabled: mediaReady; opacity: enabled ? 1 : 0.5; onClicked: togglePlay() }
                VideoButton { iconName: "undo"; text: t("Voltar dez segundos"); enabled: mediaReady; opacity: enabled ? 1 : 0.5; onClicked: seek(position - 10) }
                Label { anchors.verticalCenter: parent.verticalCenter; text: clock(position) + " / " + clock(duration); color: "#F4F1E9"; font.family: "monospace"; font.pixelSize: 14 }
                VideoButton { objectName: "fullScreenExit"; iconName: "fullscreen-exit"; text: t("Sair da tela cheia (Esc)"); onClicked: strip.setFullScreen(false) }
            }
        }
    }
}
