import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Recording 1.0

// Meeting page: header, player and the tabs (moved verbatim from Main.qml).
ColumnLayout {
    id: detailView
    objectName: "detailView"
    property alias tabs: tabs
    property alias video: video
    property alias videoFrame: videoFrame
    property alias captionOverlay: captionOverlay
    property alias captionViewport: captionViewport
    property alias caption: caption
    property alias captionToggle: captionToggle
    property alias timeline: timeline
    property alias revisionSegmentsList: revisionSegmentsList
    property alias revisionSpeakersList: revisionSpeakersList
    property alias revisionTurnsList: revisionTurnsList
    property alias contextExcerpts: contextExcerpts
    property alias contextArea: contextArea
    property alias compactContext: compactContext
    property alias processButton: processButton
    property alias agentAccessButton: agentAccessButton
    property alias visualSummaryButton: visualSummaryButton
    property alias summaryRegenerateButton: summaryRegenerateButton
    property alias exportButton: exportButton
    property alias openRecordingButton: openRecordingButton
    property alias reviewNoteButton: reviewNoteButton
    property alias speakerSuggestButton: speakerSuggestButton
    anchors.fill: parent
    anchors.margins: compactLayout ? 14 : 20
    spacing: compactLayout ? 10 : 14
    visible: !!selected.key
    RowLayout {
        Layout.fillWidth: true
        spacing: 10
        FtButton { objectName: "backButton"; iconOnly: true; variant: "ghost"; iconName: "back"; text: t("Voltar à biblioteca (Esc)"); Accessible.name: t("Voltar à biblioteca"); Layout.alignment: Qt.AlignTop; enabled: !revisionPending() && !hasPending("export-save"); onClicked: backToLibrary() }
        ColumnLayout {
            Layout.fillWidth: true
            spacing: 6
            Label { text: recordingTitle(selected) || selected.fileName || ""; textFormat: Text.PlainText; color: ink; font.pixelSize: compactLayout ? 19 : 22; font.weight: Font.DemiBold; wrapMode: Text.Wrap; maximumLineCount: 2; elide: Text.ElideRight; Layout.fillWidth: true }
            Flow {
                Layout.fillWidth: true
                spacing: 6
                FtChip { visible: !!longDate(selected.modifiedAt); iconName: "clock"; text: longDate(selected.modifiedAt) }
                FtChip { kind: selected.location === "missing" ? "warning" : mediaReady && location ? "accent" : "neutral"; iconName: mediaReady && location ? "play" : ""; text: mediaReady && location ? t("Reproduzindo · ") + origin(location) : origin(selected.location) }
                FtChip { visible: !!selected.status; kind: statusKind(selected.status); text: statusText(selected.status) || "" }
                Repeater {
                    model: artifactParts(selected.artifactStatus)
                    FtChip { required property string modelData; kind: modelData.indexOf("pront") >= 0 ? "accent" : "neutral"; iconName: modelData.indexOf("pront") >= 0 ? "check" : ""; text: modelData }
                }
                FtChip { visible: !!selected.backup && selected.backup !== "none"; text: t("Cópias: ") + String(selected.backup || "").replace("+", " + ").toUpperCase() }
            }
        }
        FtButton { id:processButton; objectName:"processButton"; compact:true; iconName:"spark"; iconOnly:compactLayout; text:t("Processar…"); Layout.alignment:Qt.AlignTop; visible:!!selected.key && ["completed","processing","transferring"].indexOf(detail.status || selected.status) < 0; enabled:backend.available && !detailLoading; Accessible.name:t("Ver para onde vão o áudio e o texto e processar esta gravação"); onClicked:processDialog.open() }
        FtButton { id:agentAccessButton; objectName:"agentAccessButton"; compact:true; iconName:"key"; iconOnly:compactLayout; text:t("Acesso para IA…"); Layout.alignment:Qt.AlignTop; enabled:backend.available && !!selected.recordingId; onClicked:openAgentAccess() }
        FtButton { objectName:"framesButton"; compact:true; iconName:"frames"; iconOnly:compactLayout; text: mockFramesEnabled ? t("Frames · mock local…") : t("Análise visual local…"); Layout.alignment:Qt.AlignTop; enabled: backend.available && (mockFramesEnabled || realFramesEnabled) && !!selected.key; onClicked: { cancelFramePreview(); framesDialog.open() } ToolTip.visible: hovered; ToolTip.text: mockFramesEnabled ? t("Ensaio sintético explícito, sem provider real.") : t("Preview local; análise e novo resumo somente após consentimento explícito.") }
    }

    RowLayout {
        Layout.fillWidth: true
        Layout.fillHeight: true
        spacing: compactLayout ? 12 : 16

        ColumnLayout {
            id: playerColumn
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 10
            Rectangle {
                id: videoFrame
                Layout.fillWidth: true; Layout.fillHeight: true; Layout.minimumHeight: 200
                color: "#05080D"; radius: 12; clip: true
                RecordingVideo {
                    id: video; objectName: "recordingVideo"; anchors.fill: parent
                    onReady: { playerInitialized = true; setPropertyAsync("pause", true); setPropertyAsync("hwdec", smokeSoftware ? "no" : "auto-safe"); setPropertyAsync("volume", 70); loadMedia() }
                }
                ColumnLayout {
                    anchors.centerIn: parent; width: Math.min(parent.width - 48, 420); visible: !mediaReady
                    spacing: 12
                    BusyIndicator { Layout.alignment: Qt.AlignHCenter; running: resolving; visible: resolving }
                    Rectangle {
                        visible: !resolving
                        Layout.alignment: Qt.AlignHCenter
                        implicitWidth: 56; implicitHeight: 56; radius: 28
                        color: "#17322F"
                        FtIcon { anchors.centerIn: parent; size: 26; name: selected.location === "missing" ? "alert" : selected.location === "transcript-only" ? "transcript" : "play"; tint: selected.location === "missing" ? "#FFB377" : selected.location === "transcript-only" ? "#AAC0B8" : "#57D5B0" }
                    }
                    Label { Layout.fillWidth: true; text: resolving ? t("Preparando a gravação…") : selected.key ? (mediaGone(selected) ? t("Mídia indisponível") : t("Gravação pronta para abrir")) : t("Escolha uma gravação"); color: "#F4F1E9"; font.pixelSize: 18; font.weight: Font.DemiBold; horizontalAlignment: Text.AlignHCenter; wrapMode: Text.WordWrap }
                    Label { Layout.fillWidth: true; visible: !resolving && !!selected.key; text: mediaGone(selected) ? t("O arquivo original não está neste computador nem em um destino configurado.") : t("A mídia é verificada antes de reproduzir; nada é baixado sem a sua ação."); color: "#AAC0B8"; font.pixelSize: 13; horizontalAlignment: Text.AlignHCenter; wrapMode: Text.WordWrap }
                    FtButton { id: openRecordingButton; Layout.alignment: Qt.AlignHCenter; visible: !!selected.key && !resolving && !mediaGone(selected); enabled: backend.available && !mediaGone(selected); variant: "primary"; iconName: "play"; text: t("Abrir gravação"); onClicked: openRecording() }
                }
                Rectangle {
                    anchors.top: parent.top; anchors.left: parent.left; anchors.margins: 12
                    width: Math.min(parent.width - 24, voicesRow.implicitWidth + 20); height: voicesRow.implicitHeight + 12; radius: 8
                    color: "#D90B1716"
                    visible: mediaReady && !!activeSpeakerLabels(position)
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
                    visible: captions && mediaReady && captionAvailable && activeCaptionText.length > 0
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
            }
            RowLayout {
            Layout.fillWidth: true
            spacing: 10
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
                    implicitWidth: 18; implicitHeight: 18; radius: 9
                    color: surface
                    border.width: 3; border.color: timeline.enabled ? accent : dividerStrong
                    Rectangle { anchors.fill: parent; anchors.margins: -4; radius: 13; color: "transparent"; border.width: 2; border.color: accent; visible: timeline.visualFocus }
                }
            }
            Label { text: clock(position) + " / " + clock(duration); color: muted; font.family: "monospace"; font.pixelSize: 12 }
            }
            RowLayout {
                Layout.fillWidth: true
                spacing: 8
                FtButton { iconOnly: true; variant: "primary"; implicitHeight: 40; iconName: paused ? "play" : "pause"; text: paused ? t("Reproduzir") : t("Pausar"); Accessible.name: paused ? t("Reproduzir") : t("Pausar"); enabled: mediaReady; onClicked: togglePlay() }
                FtButton { compact: true; variant: "ghost"; text: "−10 s"; Accessible.name: t("Voltar dez segundos"); enabled: mediaReady; onClicked: seek(position - 10) }
                FtButton { visible: playerColumn.width >= 420; compact: true; variant: "ghost"; text: "+10 s"; Accessible.name: t("Avançar dez segundos"); enabled: mediaReady; onClicked: seek(position + 10) }
                Item { Layout.fillWidth: true }
                CheckBox {
                    id: captionToggle; objectName: "captionToggle"
                    text: window.width < 1100 ? "CC" : t("Legendas")
                    Accessible.name: t("Exibir legendas quando houver uma faixa disponível")
                    checked: captions; enabled: !!selected.key; onToggled: captions = checked
                    spacing: 8
                    indicator: Rectangle {
                        implicitWidth: 34; implicitHeight: 20; radius: 10
                        x: captionToggle.leftPadding; y: captionToggle.topPadding + (captionToggle.availableHeight - height) / 2
                        color: captionToggle.checked ? accent : dividerStrong
                        border.width: captionToggle.visualFocus ? 2 : 0; border.color: ink
                        opacity: captionToggle.enabled ? 1 : 0.5
                        Rectangle { width: 14; height: 14; radius: 7; y: 3; x: captionToggle.checked ? parent.width - width - 3 : 3; color: captionToggle.checked ? onAccent : surface }
                    }
                    contentItem: Label { text: captionToggle.text; color: captionToggle.enabled ? ink : muted; font.pixelSize: 13; leftPadding: captionToggle.indicator.width + captionToggle.spacing; verticalAlignment: Text.AlignVCenter }
                }
            }
            Label { objectName: "captionStatus"; visible: !!selected.key; text: captionStatusText; textFormat: Text.PlainText; color: captionAvailable ? muted : warningColor; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
        }

        FtCard {
            id: sidePanel
            Layout.preferredWidth: Math.max(compactLayout ? 320 : 340, Math.min(520, detailView.width * 0.42))
            Layout.fillHeight: true
            ColumnLayout {
                anchors.fill: parent
                anchors.margins: 12
                spacing: 10
                TabBar {
                    id: tabs
                    Layout.fillWidth: true
                    spacing: 4
                    padding: 4
                    background: Rectangle { radius: 10; color: surfaceAlt; border.width: 1; border.color: divider }
                    Repeater {
                        model: [{label: t("Transcrição"), icon: "transcript"}, {label: t("Resumo"), icon: "spark"}, {label: t("Falantes"), icon: "users"}, {label: sidePanel.width < 400 ? t("Contexto") : t("Contexto IA"), icon: "context"}]
                        TabButton {
                            id: tabButton
                            required property var modelData
                            text: modelData.label
                            implicitHeight: 34
                            hoverEnabled: true
                            font.pixelSize: 13
                            contentItem: Row {
                                spacing: 6
                                FtIcon { visible: sidePanel.width >= 460; name: tabButton.modelData.icon; tint: tabButton.checked ? accent : muted; size: 15; anchors.verticalCenter: parent.verticalCenter }
                                Label { text: tabButton.text; font.pixelSize: sidePanel.width < 400 ? 12 : 13; font.weight: tabButton.checked ? Font.DemiBold : Font.Normal; color: tabButton.checked ? ink : muted; elide: Text.ElideRight; anchors.verticalCenter: parent.verticalCenter }
                            }
                            background: Rectangle {
                                radius: 7
                                color: tabButton.checked ? surface : tabButton.hovered ? hoverSurface : "transparent"
                                border.width: tabButton.visualFocus ? 2 : tabButton.checked ? 1 : 0
                                border.color: tabButton.visualFocus ? accent : divider
                                Rectangle { visible: tabButton.checked; anchors.bottom: parent.bottom; anchors.horizontalCenter: parent.horizontalCenter; anchors.bottomMargin: 3; width: Math.min(parent.width - 16, 28); height: 2; radius: 1; color: accent }
                            }
                        }
                    }
                }

                ColumnLayout {
                    visible: !!detail.review && (tabs.currentIndex === 0 || tabs.currentIndex === 2)
                    Layout.fillWidth: true
                    spacing: 6
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 6
                        Rectangle {
                            implicitHeight: 26
                            implicitWidth: revisionStateLabel.implicitWidth + 20
                            Layout.maximumWidth: sidePanel.width - 150
                            radius: 13
                            color: detail.review && detail.review.derivedStale ? warningSoft : accentSoft
                            Label {
                                id: revisionStateLabel; objectName: "revisionState"
                                anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; anchors.leftMargin: 10; anchors.rightMargin: 10
                                text: detail.review ? t("Revisão ")+detail.review.revision.revision+(detail.review.derivedStale?t(" · derivados anteriores desatualizados"):t(" · original preservado")) : ""
                                color: detail.review && detail.review.derivedStale ? warningColor : accent
                                font.pixelSize: 12; font.weight: Font.Medium; elide: Text.ElideRight
                            }
                        }
                        Item { Layout.fillWidth: true }
                        FtButton { id:reviewNoteButton; objectName:"reviewNoteButton"; compact:true; variant:"ghost"; iconName:"note"; iconOnly:sidePanel.width < 430; text:t("Nota"); Accessible.name:t("Adicionar nota humana sem tempo"); enabled:backend.available&&!revisionPending(); onClicked:openReview("note",({})) }
                        FtButton { objectName:"revisionUndo"; compact:true; variant:"ghost"; iconName:"undo"; iconOnly:sidePanel.width < 430; text:t("Desfazer"); Accessible.name:t("Desfazer última revisão humana"); enabled:backend.available&&!!detail.review&&detail.review.canUndo===true&&!revisionPending(); onClicked:undoRevision() }
                        FtButton { id:exportButton; objectName:"exportButton"; compact:true; variant:"ghost"; iconName:"export"; iconOnly:sidePanel.width < 430; text:t("Exportar"); enabled:backend.available&&!revisionPending(); onClicked:exportDialog.open() }
                    }
                    Label { visible:!!detail.review&&(detail.review.notes||[]).length>0; text:detail.review&&(detail.review.notes||[]).length>0 ? t("Notas humanas sem tempo: ")+detail.review.notes.length+t(". Última prévia: ")+detail.review.notes[detail.review.notes.length-1].slice(0,180)+(detail.review.notes[detail.review.notes.length-1].length>180?"…":"")+t(" · conteúdo completo no JSON/Markdown exportado.") : ""; textFormat:Text.PlainText; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true; font.pixelSize:12; maximumLineCount: 3; elide: Text.ElideRight }
                    Label { visible:tabs.currentIndex===0&&!!detail.review&&detail.review.segmentEditUnavailable; text:t("Trechos sem correspondência literal no texto original aceitam somente uma nota sem tempo."); color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true; font.pixelSize:12 }
                }
                Label { visible: tabs.currentIndex === 0 && detail.transcript.timing === "block"; text: t("Tempos aproximados por bloco; a revisão não cria alinhamento por palavra."); textFormat: Text.PlainText; color: warningColor; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 12 }

                ListView {
                    id:revisionSegmentsList; objectName:"revisionSegmentsList"
                    visible: tabs.currentIndex === 0 && (detail.transcript.segments || []).length > 0
                    Layout.fillWidth: true; Layout.fillHeight: true; model: detail.transcript.segments || []; clip: true; spacing: 2
                    ScrollBar.vertical: ScrollBar {}
                    delegate: ItemDelegate {
                        id: segmentItem
                        required property var modelData; required property int index
                        readonly property bool activeLine: activeSegment === index
                        width: ListView.view.width
                        hoverEnabled: true
                        leftPadding: 12; rightPadding: 8; topPadding: 8; bottomPadding: 10
                        Accessible.name: (modelData.speaker ? modelData.speaker + ", " : "") + clock(modelData.start) + ". " + modelData.text
                        background: Rectangle {
                            radius: 8
                            color: segmentItem.activeLine ? selectedSurface : segmentItem.hovered ? hoverSurface : "transparent"
                            border.width: segmentItem.visualFocus ? 2 : 0; border.color: accent
                            Rectangle { visible: segmentItem.activeLine; width: 3; radius: 1.5; color: accent; anchors.left: parent.left; anchors.top: parent.top; anchors.bottom: parent.bottom; anchors.topMargin: 8; anchors.bottomMargin: 8 }
                        }
                        contentItem: ColumnLayout {
                            id: segmentContent
                            spacing: 3
                            RowLayout {
                                Layout.fillWidth: true
                                spacing: 8
                                Label { text: clock(segmentItem.modelData.start); color: accent; font.pixelSize: 12; font.family: "monospace"; font.weight: Font.DemiBold }
                                Label { visible: !!segmentItem.modelData.speaker; text: segmentItem.modelData.speaker || ""; textFormat: Text.PlainText; color: ink; font.pixelSize: 12; font.weight: Font.DemiBold; elide: Text.ElideRight; Layout.fillWidth: true }
                                Item { visible: !segmentItem.modelData.speaker; Layout.fillWidth: true }
                                FtChip { visible: segmentItem.modelData.humanEdited === true; text: t("Revisado"); kind: "accent"; implicitHeight: 20 }
                                FtButton { objectName:"segmentReview-"+(segmentItem.modelData.id||segmentItem.index); text:t("Revisar"); Accessible.name: t("Revisar trecho ") + clock(segmentItem.modelData.start); iconName: "edit"; iconOnly: true; compact: true; variant: "ghost"; implicitHeight: 28; visible:!!segmentItem.modelData.id; enabled:backend.available&&!revisionPending()&&!!segmentItem.modelData.textRange; onClicked:openReview("segment-text",segmentItem.modelData) }
                            }
                            Label { text: segmentItem.modelData.text; textFormat: Text.PlainText; color: ink; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 14; lineHeight: 1.12 }
                        }
                        onClicked: seek(modelData.start)
                    }
                }

                ColumnLayout {
                    visible: tabs.currentIndex === 1
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    spacing: 8
                    Flow {
                        Layout.fillWidth: true
                        spacing: 6
                        FtButton { id:summaryRegenerateButton;objectName:"summaryRegenerateButton"; compact:true; iconName:"spark"; text:t("Regenerar resumo…");enabled:backend.available&&!!detail.review&&!revisionPending()&&!detailLoading&&!summaryBusy();onClicked:openSummary();Accessible.name:t("Preparar plano e consentimento para regenerar o resumo") }
                        FtButton { id: visualSummaryButton; objectName: "visualSummaryButton"; compact: true; variant: "outline"; iconName: "frames"; visible: !!detail.visualReview && !!detail.visualReview.summaryMarkdown; text: showVisualSummary ? t("Voltar ao resumo da transcrição") : (detail.visualReview && detail.visualReview.scope ? t("Ver resumo parcial do intervalo visual") : t("Ver resumo visual solicitado")); onClicked: showVisualSummary=!showVisualSummary }
                    }
                    Label { visible: showVisualSummary && !!detail.visualReview; text: detail.visualReview && detail.visualReview.scope ? t("PARCIAL · ") + preciseClock(detail.visualReview.scope.startSeconds) + "–" + preciseClock(detail.visualReview.scope.endSeconds) + t(" · restante omitido; revisar origem") : t("Resumo visual solicitado · revisar origem"); textFormat: Text.PlainText; color: warningColor; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 12 }
                    Rectangle {
                        Layout.fillWidth: true
                        implicitHeight: provenanceColumn.implicitHeight + 20
                        radius: 10
                        color: detail.review && detail.review.derivedStale || !detail.summary ? warningSoft : surfaceAlt
                        border.width: 1; border.color: divider
                        RowLayout {
                            anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 10
                            spacing: 8
                            FtIcon { Layout.alignment: Qt.AlignTop; name: detail.review && detail.review.derivedStale || !detail.summary ? "alert" : "info"; tint: detail.review && detail.review.derivedStale || !detail.summary ? warningColor : accent; size: 16 }
                            ColumnLayout {
                                id: provenanceColumn
                                Layout.fillWidth: true
                                spacing: 4
                                Label { visible: !!detail.artifactMessage; text: t(detail.artifactMessage || ""); textFormat: Text.PlainText; color: ink; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 12 }
                                Label { text: detail.summaryInfo ? t("Resumo: ") + t(detail.summaryInfo) + t(" · Resumo de IA: confira a fonte e os avisos de revisão.") : t("Resumo de IA: confira a fonte e os avisos de revisão."); textFormat: Text.PlainText; color: muted; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 11 }
                            }
                        }
                    }
                    ListView {
                        id: summaryView
                        objectName: "summaryView"
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        clip: true
                        spacing: 6
                        model: summaryBlocks((showVisualSummary && detail.visualReview ? detail.visualReview.summaryMarkdown : detail.summary) || "")
                        ScrollBar.vertical: ScrollBar {}
                        delegate: Item {
                            id: summaryBlock
                            required property var modelData
                            width: ListView.view.width - 8
                            height: blockRow.implicitHeight + (modelData.kind === "heading" ? 10 : 0)
                            RowLayout {
                                id: blockRow
                                width: parent.width
                                y: summaryBlock.modelData.kind === "heading" ? 10 : 0
                                spacing: 8
                                Label { visible: summaryBlock.modelData.kind === "bullet"; text: "•"; color: accent; font.pixelSize: 15; Layout.alignment: Qt.AlignTop }
                                Label {
                                    Layout.fillWidth: true
                                    text: summaryBlock.modelData.text
                                    textFormat: Text.PlainText
                                    wrapMode: Text.Wrap
                                    color: summaryBlock.modelData.kind === "heading" ? accent : ink
                                    font.pixelSize: summaryBlock.modelData.kind === "title" ? 17 : summaryBlock.modelData.kind === "heading" ? 12 : 14
                                    font.weight: summaryBlock.modelData.kind === "title" || summaryBlock.modelData.kind === "heading" ? Font.DemiBold : Font.Normal
                                    font.letterSpacing: summaryBlock.modelData.kind === "heading" ? 0.8 : 0
                                    font.capitalization: summaryBlock.modelData.kind === "heading" ? Font.AllUppercase : Font.MixedCase
                                    lineHeight: summaryBlock.modelData.kind === "paragraph" || summaryBlock.modelData.kind === "bullet" ? 1.15 : 1
                                }
                                FtButton { visible: summaryBlock.modelData.seconds >= 0; compact: true; variant: "ghost"; implicitHeight: 26; iconName: "play"; text: clock(summaryBlock.modelData.seconds); Accessible.name: t("Ir à origem ") + clock(summaryBlock.modelData.seconds); enabled: mediaReady; Layout.alignment: Qt.AlignTop; onClicked: seek(summaryBlock.modelData.seconds) }
                            }
                        }
                        Label { anchors.centerIn: parent; width: parent.width - 32; visible: summaryView.count === 0; text: detailLoading ? t("Carregando…") : t("Resumo ainda não disponível."); color: muted; horizontalAlignment: Text.AlignHCenter; wrapMode: Text.WordWrap }
                    }
                }

                ColumnLayout {
                    visible: tabs.currentIndex === 2
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    spacing: 8
                    Label { textFormat: Text.PlainText; text: t(detail.diarization.message || "") || t("Identifique os falantes para revisar suas participações nesta gravação."); color: detail.diarization.state === "failed" ? errorColor : muted; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                    Label { visible: (detail.diarization.turns || []).length > 0; text: t("Transcrição mostra a vista revisada; o original é preservado. Os horários das falas pertencem ao diarizador."); color: muted; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                    FtOverline { text: t("Nomes dos falantes"); visible: speakerRows.length > 0 }
                    RowLayout {
                        Layout.fillWidth: true; spacing: 8; visible: speakerRows.length > 0
                        Item { Layout.fillWidth: true }
                        FtButton { id: speakerApplyButton; objectName: "speakerApplySuggestions"; visible: applicableSuggestions().length > 0; text: t("Aplicar sugestões"); compact: true; variant: "secondary"; iconName: "check"; implicitHeight: 30
                            Accessible.name: t("Aplicar as sugestões aos falantes ainda sem nome, como revisão humana")
                            enabled: backend.available && !revisionPending() && !!detail.review; onClicked: applySpeakerSuggestions() }
                        FtButton { id: speakerSuggestButton; objectName: "speakerSuggestButton"; text: speakersQueued ? t("Procurando nomes…") : t("Sugerir nomes…"); compact: true; variant: "outline"; iconName: "spark"; implicitHeight: 30
                            Accessible.name: t("Sugerir nomes dos falantes pelo microfone e, se você autorizar, pela conversa")
                            enabled: backend.available && !speakersQueued && !revisionPending() && !!detail.review && speakerSuggestions.state !== "unavailable"; onClicked: speakerSuggestDialog.open() }
                    }
                    Label { objectName: "speakerSuggestionStatus"; visible: speakerRows.length > 0 && !!speakerSuggestionStatus(); text: speakerSuggestionStatus(); textFormat: Text.PlainText; color: speakerSuggestions.state === "failed" ? errorColor : muted; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                    ListView {
                        id:revisionSpeakersList; objectName:"revisionSpeakersList"
                        visible: speakerRows.length > 0
                        Layout.fillWidth: true; Layout.preferredHeight: Math.min(236, speakerRows.reduce(function(total, row){return total + 44 + suggestionsFor(row.speakerId).length * 30}, 0)); model: speakerRows; clip: true; spacing: 2
                        ScrollBar.vertical: ScrollBar {}
                        delegate: ItemDelegate {
                            id: speakerItem
                            required property var modelData
                            property var suggestions: suggestionsFor(modelData.speakerId)
                            width: ListView.view.width; height: 42 + suggestions.length * 30
                            enabled: backend.available && !!selected.key
                            leftPadding: 8; rightPadding: 4
                            Accessible.name: (modelData.label || t("Falante incerto")) + (suggestions.length ? t(", com sugestão de nome") : "")
                            background: Rectangle { radius: 8; color: speakerItem.hovered ? hoverSurface : "transparent"; border.width: speakerItem.visualFocus ? 2 : 0; border.color: accent }
                            contentItem: ColumnLayout {
                                spacing: 0
                                RowLayout {
                                    spacing: 8; Layout.fillWidth: true; Layout.preferredHeight: 34
                                    FtChip { text: speakerItem.modelData.speakerId; kind: "accent"; maximumWidth: 90 }
                                    Label { text:speakerItem.modelData.label||t("Falante incerto"); textFormat:Text.PlainText; color:speakerItem.modelData.label ? ink : muted; Layout.fillWidth:true; elide:Text.ElideRight }
                                    FtButton { objectName:"speakerReview-"+speakerItem.modelData.speakerId; text:t("Revisar"); compact:true; variant:"ghost"; iconName:"edit"; implicitHeight: 30; Accessible.name:t("Revisar nome do falante ")+speakerItem.modelData.speakerId; enabled:backend.available&&!revisionPending()&&!!detail.review; onClicked:openReview("speaker-label",speakerItem.modelData) }
                                }
                                Repeater {
                                    model: speakerItem.suggestions
                                    delegate: RowLayout {
                                        id: suggestionRow
                                        required property var modelData
                                        Layout.fillWidth: true; Layout.preferredHeight: 30; spacing: 8
                                        Label { id: suggestionLabel; objectName: "speakerSuggestion-" + speakerItem.modelData.speakerId + "-" + suggestionRow.modelData.source; text: t("Sugestão: ") + suggestionName(suggestionRow.modelData) + " · " + suggestionDetail(suggestionRow.modelData); textFormat: Text.PlainText; color: muted; font.pixelSize: 12; Layout.fillWidth: true; elide: Text.ElideRight; leftPadding: 4
                                            HoverHandler { id: suggestionHover }
                                            ToolTip.visible: suggestionHover.hovered && suggestionLabel.truncated; ToolTip.text: suggestionLabel.text; ToolTip.delay: 400 }
                                        FtButton { objectName: "speakerUseSuggestion-" + speakerItem.modelData.speakerId + "-" + suggestionRow.modelData.source; text: t("Usar"); compact: true; variant: "ghost"; iconName: "edit"; implicitHeight: 26
                                            Accessible.name: tf("Revisar o nome sugerido %1 para o falante %2", suggestionName(suggestionRow.modelData), speakerItem.modelData.speakerId)
                                            enabled: backend.available && !revisionPending() && !!detail.review
                                            onClicked: openReview("speaker-label", {speakerId: speakerItem.modelData.speakerId, label: suggestionName(suggestionRow.modelData)}) }
                                    }
                                }
                            }
                        }
                    }
                    FtOverline { text: t("Falas do diarizador · texto automático, revisar"); Layout.fillWidth: true; wrapMode: Text.WordWrap }
                    Label { visible: !!detail.diarization.textCoverage && detail.diarization.textCoverage.shownTurns < detail.diarization.textCoverage.totalTurns; text: detail.diarization.textCoverage ? t("Texto parcial na interface: ") + detail.diarization.textCoverage.shownTurns + "/" + detail.diarization.textCoverage.totalTurns + t(" falas. Os horários e nomes continuam disponíveis; o resultado local completo foi preservado.") : ""; textFormat: Text.PlainText; color: warningColor; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 12 }
                    ListView {
                        id:revisionTurnsList; objectName:"revisionTurnsList"
                        Layout.fillWidth: true; Layout.fillHeight: true; model: detail.diarization.turns || []; clip: true; spacing: 2
                        ScrollBar.vertical: ScrollBar {}
                        delegate: ItemDelegate {
                            id: turnItem
                            required property var modelData
                            width: ListView.view.width; enabled: true
                            hoverEnabled: true
                            leftPadding: 10; rightPadding: 8; topPadding: 8; bottomPadding: 10
                            Accessible.name: (modelData.label || modelData.speaker || t("Falante incerto")) + ", " + preciseClock(modelData.start) + " a " + preciseClock(modelData.end) + ". " + (modelData.text !== undefined ? modelData.text : t("Texto não disponível nesta prévia."))
                            background: Rectangle { radius: 8; color: turnItem.hovered ? hoverSurface : "transparent"; border.width: turnItem.visualFocus ? 2 : 0; border.color: accent }
                            contentItem: ColumnLayout {
                                id: turnContent; spacing: 4
                                RowLayout {
                                    spacing: 8
                                    Label { text: preciseClock(turnItem.modelData.start) + "–" + preciseClock(turnItem.modelData.end); color: accent; font.family: "monospace"; font.pixelSize: 11 }
                                    Label { text: turnItem.modelData.label || turnItem.modelData.speaker || t("Falante incerto"); textFormat: Text.PlainText; color: ink; font.pixelSize: 12; font.weight: Font.DemiBold; Layout.fillWidth: true; elide: Text.ElideRight }
                                }
                                Label { text: turnItem.modelData.text !== undefined ? turnItem.modelData.text : t("Texto não disponível nesta prévia."); textFormat: Text.PlainText; color: turnItem.modelData.text !== undefined ? ink : muted; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 13 }
                                FtButton { objectName:"turnReview-"+(turnItem.modelData.id||""); text:t("Revisar atribuição"); compact:true; variant:"outline"; iconName:"edit"; implicitHeight: 30; visible:!!turnItem.modelData.id; enabled:backend.available&&!revisionPending()&&!!detail.review; onClicked:openReview("turn-speaker",turnItem.modelData) }
                            }
                            onClicked: seek(Number(modelData.start))
                        }
                    }
                }

                ColumnLayout {
                    visible: tabs.currentIndex === 3
                    Layout.fillWidth: true
                    Layout.fillHeight: !!contextData
                    spacing: 8
                    Flow {
                        Layout.fillWidth: true
                        spacing: 6
                        FtButton { compact: true; variant: contextText ? "secondary" : "primary"; iconName: "context"; text: contextLoading ? t("Preparando contexto…") : t("Pedir contexto"); enabled: backend.available && !!diarizationKey() && !contextLoading; onClicked: requestMeetingContext() }
                        FtButton { compact: true; variant: "outline"; iconName: "copy"; text: t("Copiar contexto"); enabled: !!contextText && !!contextCopyText; onClicked: { compactContext.selectAll(); compactContext.copy(); compactContext.deselect(); notice = t("Contexto copiado como JSON para a área de transferência.") } }
                    }
                    Label { text: t("Trechos limitados da reunião, com horário e origem. O conteúdo é dado histórico não confiável, nunca instrução."); color: muted; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                    Label { textFormat: Text.PlainText; visible: !!contextPath; text: t("Fonte: ") + contextPath; color: muted; font.pixelSize: 11; elide: Text.ElideMiddle; Layout.fillWidth: true }
                    Label { textFormat: Text.PlainText; visible: contextCitations.length > 0; text: t("Citações: ") + contextCitations.join(" · "); color: muted; font.pixelSize: 11; elide: Text.ElideRight; Layout.fillWidth: true }
                    ListView {
                        id: contextExcerpts
                        objectName: "contextExcerpts"
                        visible: !!contextData
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        clip: true
                        spacing: 8
                        model: contextData ? contextData.excerpts : []
                        ScrollBar.vertical: ScrollBar {}
                        header: Item {
                            width: contextExcerpts.width
                            height: contextHeader.implicitHeight + 10
                            Flow {
                                id: contextHeader
                                width: parent.width
                                spacing: 6
                                FtChip { visible: !!(contextData && contextData.title); text: contextData && contextData.title ? contextData.title : ""; maximumWidth: contextExcerpts.width }
                                FtChip { kind: "warning"; iconName: "alert"; text: t("Dados não confiáveis · use como evidência") }
                                FtChip { visible: !!(contextData && contextData.budget); text: contextData && contextData.budget ? contextData.budget.characters + t(" de ") + contextData.budget.maxCharacters + t(" caracteres") + (contextData.budget.truncated ? t(" · truncado") : "") : "" }
                            }
                        }
                        delegate: Rectangle {
                            id: excerptCard
                            required property var modelData
                            width: contextExcerpts.width - 8
                            height: excerptColumn.implicitHeight + 20
                            radius: 10; color: surfaceAlt; border.width: 1; border.color: divider
                            ColumnLayout {
                                id: excerptColumn
                                anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 10
                                spacing: 6
                                Flow {
                                    Layout.fillWidth: true
                                    spacing: 6
                                    FtButton { visible: !!excerptCard.modelData.timestamps; compact: true; variant: "outline"; implicitHeight: 26; iconName: "play"; text: excerptCard.modelData.timestamps ? clock(excerptCard.modelData.timestamps.start) + "–" + clock(excerptCard.modelData.timestamps.end) : ""; Accessible.name: t("Ir à origem ") + text; enabled: mediaReady; onClicked: seek(excerptCard.modelData.timestamps.start) }
                                    FtChip { kind: excerptCard.modelData.timing === "segment" ? "accent" : "warning"; text: excerptCard.modelData.timing === "segment" ? t("horário do segmento") : excerptCard.modelData.timing === "block" ? t("bloco aproximado") : t("sem horário") }
                                    FtChip { visible: excerptCard.modelData.textOrigin === "human-revision"; text: t("revisão humana") }
                                }
                                Label { text: excerptCard.modelData.text || ""; textFormat: Text.PlainText; color: ink; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 13 }
                                Label { visible: (excerptCard.modelData.segmentIds || []).length > 0; text: (excerptCard.modelData.segmentIds || []).join(", "); color: muted; font.pixelSize: 11; font.family: "monospace"; elide: Text.ElideRight; Layout.fillWidth: true }
                            }
                        }
                    }
                }
                TextEdit { id: compactContext; visible: false; text: contextCopyText; textFormat: TextEdit.PlainText }

                ScrollView {
                    visible: (tabs.currentIndex === 0 && !(detail.transcript.segments || []).length) || (tabs.currentIndex === 3 && !contextData)
                    Layout.fillWidth: true; Layout.fillHeight: true; clip: true
                    TextArea { id: contextArea; readOnly: true; selectByMouse: true; wrapMode: TextEdit.Wrap; textFormat: TextEdit.PlainText; color: ink; font.pixelSize: 14; text: tabs.currentIndex === 0 ? detail.transcript.text || (detailLoading ? t("Carregando…") : t("Transcrição ainda não disponível.")) : tabs.currentIndex === 1 ? (showVisualSummary && detail.visualReview ? detail.visualReview.summaryMarkdown : detail.summary) || t("Resumo ainda não disponível.") : tabs.currentIndex === 3 ? (contextText || (contextLoading ? t("Preparando contexto sob demanda…") : t("Peça o contexto para esta gravação quando precisar."))) : detail.timesheet || t("Nenhum apontamento vinculado a esta gravação.")
                        background: Item {} }
                }
                FtButton { visible: tabs.currentIndex === 0 && !!detail.subtitleId; Layout.fillWidth: true; variant: "outline"; iconName: "transcript"; text: subtitleQueued ? t("Legendas em preparação…") : t("Gerar legendas no worker configurado"); enabled: backend.available && !subtitleQueued && detail.subtitleState !== "ready"; onClicked: { subtitleQueued = true; if (send("subtitles", detail.subtitleId) < 0) subtitleQueued = false } }
                FtButton { visible: (tabs.currentIndex === 0 || tabs.currentIndex === 2) && !!detail.diarizationId && !(tabs.currentIndex === 2 && detail.diarization.state === "review"); Layout.fillWidth: true; variant: "outline"; iconName: "users"; text: diarizationQueued ? t("Identificação em preparação…") : detail.diarization.state === "review" ? t("Ver falantes") : t("Identificar falantes"); enabled: backend.available && !diarizationQueued; onClicked: { if (detail.diarization.state === "review") tabs.currentIndex = 2; else { diarizationQueued = true; if (send("diarization", detail.diarizationId) < 0) diarizationQueued = false } } }
            }
        }
    }
}
