#!/usr/bin/env python3
"""Watching a meeting's video in the actual Studio QML against a synthetic bridge.

Offline and disposable. A video recording says "Assistir gravação", shows a film tile and opens
with the video expanded (the first time; the last choice is kept for the session); an audio-only
recording (an audio capture, .mka, or one whose video retention removed) says "Ouvir gravação" and
keeps a waveform tile. Cinema mode makes the video take most of the page with the notes beside it
(a wide window) or below it (compact); full screen covers the window, keeps captions and the
speaker overlay, and Esc leaves it before anything else, giving the focus back. Citations seek and
keep the size. Going from a meeting whose audio was playing to a video meeting decides from the new
meeting, never from what the player still reports about the previous file. The PySide6 runner's
player is inert, so a step sets the duration and codec it reports to stand in for an open video once
the meeting's file was loaded. While it plays, real key presses (the runner's qaKeys) show that the
playback keys leave the focused control its own keys: Right moves the meeting tabs, Space clicks a
button reached with the keyboard and opens the meeting focused in the list, Space plays and pauses
after a mouse click, and Esc in the sidebar search clears it before it leaves the meeting. Every step waits (bounded) for the state the previous reply produces.
Exit 77 means no Studio runtime is available.
"""
from pathlib import Path
import sys, tempfile

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / 'scripts'))
from studio_fixture import finish_journey, require_studio_command, run_journey_modes  # noqa: E402
command = require_studio_command()
out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(tempfile.mkdtemp(dir='/tmp', prefix='falatrace-video-ux-'))
out.mkdir(parents=True, exist_ok=True)

STUB = r'''#!/usr/bin/python3
import sys, json, os
mode = os.environ['FALATRACE_TEST_MODE']; log = open(os.environ['FALATRACE_REQUEST_LOG'], 'a')
english = mode == 'preference'
names = ['notes', 'live', 'assistant', 'recipes', 'share', 'actions', 'people', 'clients', 'upcoming', 'openInbox', 'mediaRemoval', 'templates', 'librarySearch']
base = {'hasMeetingTitle': True, 'status': 'completed', 'backup': 'none', 'sourceExists': True, 'location': 'local', 'media': 'present'}
items = [
    dict(base, key='/synthetic/Recordings/daily.mkv', fileName='daily.mkv', title='Daily do time', jobId='11111111-1111-4111-8111-111111111111', modifiedAt=1792000000000),
    dict(base, key='/synthetic/Recordings/review.mp4', fileName='review.mp4', title='Revisão do design', jobId='22222222-2222-4222-8222-222222222222', modifiedAt=1791990000000),
    dict(base, key='/synthetic/Recordings/2026-10-20_10-00/recording.mka', fileName='recording.mka', title='Ligação com a Ana', jobId='33333333-3333-4333-8333-333333333333', modifiedAt=1791980000000),
    dict(base, key='/synthetic/Recordings/retained.mkv', fileName='retained.mkv', title='Planejamento antigo', jobId='44444444-4444-4444-8444-444444444444', modifiedAt=1791970000000, location='audio-only', media='audio-only')]
on = {'playback': True, 'frames': True, 'diarize': True, 'speakersMic': True, 'voices': True, 'subtitles': True, 'reprocess': True}
segments = [{'id': 's1', 'start': 0, 'end': 9, 'text': 'Bom dia, vamos começar pela demo.', 'speaker': 'Ana'}, {'id': 's2', 'start': 42, 'end': 50, 'text': 'O lançamento fica no dia 30.', 'speaker': 'Bruno'}]
turns = [{'id': 't1', 'start': 0, 'end': 9, 'speaker': 'S1', 'label': 'Ana'}, {'id': 't2', 'start': 42, 'end': 50, 'speaker': 'S2', 'label': 'Bruno'}]
def doc():
    return {'version': 2, 'generatedAt': '2026-10-21T15:02:00Z', 'model': {'label': 'ollama · qwen3.5:9b', 'local': True}, 'template': {'id': 'standup', 'name': 'Daily', 'source': 'calendar', 'reason': '', 'confidence': 1},
            'language': 'pt-BR', 'stale': None, 'notesDigest': 'd' * 64,
            'overview': {'text': 'A equipe viu a demo e manteve o lançamento no dia 30.', 'citations': [{'segmentId': 's1', 'start': 0}]},
            'sections': [{'heading': 'Decisões', 'items': [{'kind': 'decision', 'origin': 'ai', 'text': 'Lançamento no dia 30.', 'uncertain': False, 'citations': [{'segmentId': 's2', 'start': 42}], 'noteIds': []}]}],
            'unusedNotes': [], 'orphanActions': [], 'limitations': []}
def refuse(r, message): print(json.dumps({'id': r['id'], 'ok': False, 'error': message}), flush=True)
for line in sys.stdin:
    r = json.loads(line); op = r['op']; p = r.get('payload', {}); log.write(line.strip() + '\n'); log.flush()
    if op in ('list', 'list-cached'): v = {'items': items}
    elif op == 'capture-status': v = {'active': False, 'session': None, 'paused': False, 'audio': {'configured': False}}
    elif op == 'jobs-list': v = {'items': []}
    elif op == 'processing-status': v = {'waiting': []}
    elif op == 'ux-capabilities': v = {'mockFrames': False, 'realFrames': False, 'features': {name: True for name in names}, 'firstRun': {}}
    elif op == 'settings-read': v = {'revision': 'a' * 64, 'exists': True, 'values': {'studio.language': 'en' if english else 'pt-BR'}, 'apps': [], 'nullable': [], 'readOnly': {}, 'credentials': {'details': []}}
    elif op == 'home-read': v = {'upcoming': [], 'openActions': [], 'openActionsTotal': 0, 'processing': [], 'calendarConnected': True, 'reminderMode': 'auto', 'refreshing': False}
    elif op == 'detail':
        item = next(entry for entry in items if entry['key'] == r['key'])
        retained = item['media'] == 'audio-only'
        media = {'state': 'audio-only', 'removedAt': '2026-10-12T09:00:00Z', 'reason': 'policy', 'features': dict(on, frames=False, reprocess=False)} if retained else {'state': 'present', 'features': on}
        v = {'transcript': {'segments': segments, 'text': ' '.join(s['text'] for s in segments), 'timing': 'segment'}, 'diarization': {'state': 'review', 'turns': turns}, 'summary': '# Daily\n\n- ok',
             'notesDoc': doc(), 'status': 'completed', 'backup': 'none', 'jobId': item['jobId'], 'diarizationId': item['jobId'], 'media': media,
             'review': {'revision': {'revision': 0, 'base': {'jobId': item['jobId']}}, 'canUndo': False, 'notes': [], 'derivedStale': False}}
    elif op == 'resolve': v = {'state': 'completed', 'location': 'local', 'path': os.environ['FALATRACE_SYNTHETIC_MEDIA']}
    else:
        refuse(r, 'Operação recusada no fixture.'); continue
    print(json.dumps({'id': r['id'], 'ok': True, 'result': v}), flush=True)
'''

STRIP = 'detailView.playerStrip'


def pick(file_name):
    return ('library', 'items.length === 4 && !hasPending("list") && newBridge', 'selectRecording(items.find(function(item){ return item.fileName === "%s" }))' % file_name)


def opened(file_name):
    return '!!selected.key && selected.fileName === "%s" && !detailLoading && !!detail.jobId && !!detail.notesDoc' % file_name


def loaded(file_name):
    # The meeting's file went to the player (resolve answered, loadfile sent): playback can be faked now.
    return opened(file_name) + ' && !resolving && mediaLoadGeneration === generation'


# The runner's player is inert: these are what mpv reports once a video is open.
PLAY = 'video.setPropertyAsync("duration", 120); video.setPropertyAsync("video-codec", "h264")'
# An audio file playing: a duration and no video codec.
LISTEN = 'video.setPropertyAsync("duration", 90)'

PLANS = {
    'video': ('1320x820', True, [pick('daily.mkv'),
        ('video meeting open', loaded('daily.mkv'), '''
    check("a video recording offers to watch it", openRecordingButton.text === "Assistir gravação" && %(s)s.hasVideo)
    check("it opens with the video expanded the first time", %(s)s.videoExpanded && uxFind(detailView, "videoPane").visible && uxFind(detailView, "videoPane").height > 250)
    check("before it plays, a film tile with the same button", uxFind(detailView, "videoTile").watch === true && uxFind(detailView, "videoPanePlay").visible && uxFind(detailView, "videoPanePlay").text === "Assistir gravação")
    check("cinema and full screen are offered on the video", uxFind(detailView, "cinemaToggle").visible && uxFind(detailView, "fullScreenToggle").visible)
    %(play)s''' % {'s': STRIP, 'play': PLAY}),
        ('video playing', 'mediaReady && mediaProbed', '''
    check("mpv confirms the picture: the tile gives way to the video", %(s)s.hasVideo && !uxFind(detailView, "videoTile").visible)
    check("captions and the speaker show on the expanded video", captionOverlay.visible && caption.text.indexOf("demo") >= 0 && activeSpeakerLabels(position) === "Ana")
    uxFind(detailView, "citation-s2").clicked()
    check("a citation seeks and keeps the size", %(s)s.videoExpanded && !%(s)s.cinema && !%(s)s.fullScreen && tabs.currentIndex === 1)''' % {'s': STRIP})]),
    'video-cinema': ('1320x820', False, [pick('daily.mkv'),
        ('video meeting open', loaded('daily.mkv'), 'check("expanded first", %(s)s.videoExpanded); uxFind(detailView, "cinemaToggle").clicked(); %(play)s' % {'s': STRIP, 'play': PLAY}),
        ('cinema on', STRIP + '.cinema && mediaReady', '''
    const stage = uxFind(detailView, "meetingStage"), pane = uxFind(detailView, "videoPane"), pages = uxFind(detailView, "meetingPages")
    check("cinema puts the notes in a column beside the video", stage.columns === 2 && pages.width >= 360 && pages.width <= 460 && pages.visible)
    check("the video takes most of the page", pane.width > stage.width * 0.55 && pane.height > stage.height * 0.8)
    check("captions grow with the picture", captionOverlay.visible && caption.font.pixelSize > 16)
    uxFind(detailView, "citation-s2").clicked()
    check("a citation in the side notes keeps cinema", %(s)s.cinema && %(s)s.videoExpanded && !%(s)s.fullScreen)''' % {'s': STRIP})]),
    'video-cinema-compact': ('900x640', True, [pick('daily.mkv'),
        ('video meeting open', opened('daily.mkv'), '''
    check("compact still opens the video, smaller", %(s)s.videoExpanded && uxFind(detailView, "videoPane").height <= detailView.height * 0.37)
    %(s)s.setCinema(true)''' % {'s': STRIP}),
        ('cinema on', STRIP + '.cinema', '''
    const stage = uxFind(detailView, "meetingStage"), pane = uxFind(detailView, "videoPane"), pages = uxFind(detailView, "meetingPages")
    check("compact cinema puts the notes below the video", stage.columns === 1 && pages.y > pane.y && pages.height > 80 && pages.width > 600)
    check("the video takes most of the page", pane.height >= stage.height * 0.55)''' % {'s': STRIP})]),
    'video-fullscreen': ('1320x820', False, [pick('daily.mkv'),
        ('video meeting open', loaded('daily.mkv'), PLAY),
        ('video playing', 'mediaReady && mediaProbed', 'fullScreenKey()'),
        ('full screen', STRIP + '.fullScreen', '''
    const layer = uxFind(window.contentItem, "videoFullScreen")
    check("F puts the video over the whole window", layer.visible && videoFrame.parent === layer && videoFrame.width === window.width && videoFrame.height === window.height)
    check("captions and the speaker keep working in full screen", captionOverlay.visible && activeSpeakerLabels(position) === "Ana")
    check("the full-screen bar can leave it", uxFind(layer, "fullScreenBar").visible && uxFind(layer, "fullScreenExit").visible)''')]),
    'video-escape': ('1320x820', True, [pick('daily.mkv'),
        ('video meeting open', opened('daily.mkv'), 'uxFind(detailView, "fullScreenButton").forceActiveFocus(); ' + STRIP + '.setFullScreen(true)'),
        ('full screen', STRIP + '.fullScreen', 'check("full screen takes the keyboard focus", uxFind(window.contentItem, "videoFullScreen").activeFocus); escapeKey(); check("Esc leaves full screen first and keeps the meeting", !%(s)s.fullScreen && %(s)s.videoExpanded && !!selected.key && videoFrame.parent === uxFind(detailView, "videoPane"))' % {'s': STRIP}),
        ('back in the page', '!' + STRIP + '.fullScreen && !!window.activeFocusItem && window.activeFocusItem.objectName === "fullScreenButton"', 'check("leaving full screen gives the focus back to the button that asked for it", uxFind(detailView, "fullScreenButton").activeFocus); videoKey(); check("v collapses the video into the strip", !%(s)s.videoExpanded && videoFrame.parent === uxFind(detailView, "playerThumbnail"))' % {'s': STRIP})]),
    # Audio playing, then a video meeting: the player still reports the audio file for a moment, which must
    # not decide the new meeting (it opens expanded, as a video); and back to an audio meeting, a tile again.
    'switch': ('1320x820', False, [pick('recording.mka'),
        ('audio meeting loaded', loaded('recording.mka'), LISTEN),
        ('audio playing', 'mediaReady && mediaProbed', '''
    check("mpv says the audio file has no picture", !mediaHasVideo && !%(s)s.hasVideo && !%(s)s.videoExpanded)
    selectRecording(items.find(function(item){ return item.fileName === "daily.mkv" }))
    check("the video meeting is decided from its own data, not the audio still loaded", %(s)s.hasVideo && %(s)s.videoExpanded && uxFind(detailView, "videoTile").watch === true)''' % {'s': STRIP}),
        ('video meeting loaded', loaded('daily.mkv'), '''
    check("the video stays open while its own file loads", %(s)s.videoExpanded && %(s)s.hasVideo && uxFind(detailView, "videoPanePlay").text === "Assistir gravação")
    %(play)s''' % {'s': STRIP, 'play': PLAY}),
        ('video playing', 'mediaReady && mediaProbed && mediaHasVideo', '''
    check("the video plays", %(s)s.hasVideo && !uxFind(detailView, "videoTile").visible)
    check("expanded", %(s)s.videoExpanded)
    selectRecording(items.find(function(item){ return item.fileName === "recording.mka" }))
    check("back to an audio meeting: a waveform tile, not the video pane", !%(s)s.hasVideo && !%(s)s.videoExpanded && uxFind(detailView, "videoTile").watch === false)''' % {'s': STRIP})]),
    'audio-only': ('900x640', True, [pick('recording.mka'),
        ('audio meeting open', opened('recording.mka'), '''
    check("an audio capture offers to listen", openRecordingButton.text === "Ouvir gravação" && !%(s)s.hasVideo)
    check("it stays a waveform tile in the strip", !%(s)s.videoExpanded && uxFind(detailView, "videoTile").watch === false)
    fullScreenKey(); %(s)s.setCinema(true)
    check("no full screen or cinema without a picture", !%(s)s.fullScreen && !%(s)s.cinema && !uxFind(detailView, "fullScreenButton").visible)
    check("the key hint offers no video keys", keyboardHint().indexOf("F:") < 0 && keyboardHint().indexOf("V:") < 0)
    selectRecording(items.find(function(item){ return item.fileName === "retained.mkv" }))''' % {'s': STRIP}),
        ('retained meeting open', opened('retained.mkv'), '''
    check("a recording whose video retention removed is audio only", openRecordingButton.text === "Ouvir gravação" && !%(s)s.hasVideo && !%(s)s.videoExpanded)''' % {'s': STRIP})]),
    'keys': ('1320x820', False, [pick('daily.mkv'),
        ('video meeting open', loaded('daily.mkv'), PLAY),
        ('video playing', 'mediaReady && mediaProbed', '''
    tabs.forceActiveFocus(Qt.TabFocusReason)
    check("the meeting tabs have the keyboard focus on Notas", tabs.activeFocus && tabs.currentIndex === 1 && paused)
    qaKeys = [Qt.Key_Right]'''),
        ('tab moved', 'tabs.currentIndex === 0', '''
    check("Right on the tab list moves to the next tab instead of seeking", tabs.activeFocus && tabs.currentIndex === 0)
    uxFind(detailView, "videoToggle").forceActiveFocus(Qt.TabFocusReason)
    qaKeys = [Qt.Key_Space]'''),
        ('button clicked', '!%(s)s.videoExpanded' % {'s': STRIP}, '''
    check("Space on a button reached with the keyboard clicks it (the video collapses) and does not play", !%(s)s.videoExpanded && paused)
    tabs.forceActiveFocus(Qt.TabFocusReason); uxFind(detailView, "videoToggle").forceActiveFocus(Qt.MouseFocusReason)
    check("a click gives the button the focus without the keyboard ring", uxFind(detailView, "videoToggle").activeFocus && !uxFind(detailView, "videoToggle").visualFocus)
    qaKeys = [Qt.Key_Space]''' % {'s': STRIP}),
        ('played', '!paused', '''
    check("after a mouse click Space still plays and pauses", !paused && !%(s)s.videoExpanded)
    libraryView.forceActiveFocus(Qt.TabFocusReason); libraryView.currentIndex = 1
    qaKeys = [Qt.Key_Space]''' % {'s': STRIP}),
        ('opened from the list', 'selected.fileName === "review.mp4"', '''
    check("Space on the meeting list opens the focused meeting, even while media plays", selected.fileName === "review.mp4")
    search.forceActiveFocus(Qt.TabFocusReason); search.text = "design"
    qaKeys = [Qt.Key_Escape]'''),
        ('search cleared', 'search.text === ""', '''
    check("Esc in the search clears the words and keeps the meeting open", !!selected.key && selected.fileName === "review.mp4" && search.activeFocus)
    qaKeys = [Qt.Key_Escape]'''),
        ('meeting left', '!selected.key', '''
    check("Esc in the empty search leaves the meeting", !selected.key && currentView !== "meeting")''')]),
    'preference': ('1320x820', False, [pick('daily.mkv'),
        ('first video open', opened('daily.mkv'), '''
    check("in English the button says watch", openRecordingButton.text === "Watch the recording")
    check("expanded the first time", %(s)s.videoExpanded)
    videoKey()
    check("v collapses it and that is remembered", !%(s)s.videoExpanded && !%(s)s.preferExpanded)
    selectRecording(items.find(function(item){ return item.fileName === "review.mp4" }))''' % {'s': STRIP}),
        ('second video open', opened('review.mp4'), '''
    check("the next video opens as last left: collapsed", !%(s)s.videoExpanded && %(s)s.hasVideo)
    %(s)s.setCinema(true)
    selectRecording(items.find(function(item){ return item.fileName === "daily.mkv" }))''' % {'s': STRIP}),
        ('first video again', opened('daily.mkv'), '''
    check("cinema chosen on one video is how the next one opens", %(s)s.videoExpanded && %(s)s.cinema && uxFind(detailView, "meetingStage").columns === 2)''' % {'s': STRIP})]),
}


def env_for(mode):
    return {}


checks, screens, requests = run_journey_modes(command, 'video', out, STUB, PLANS, env_for)
checks.append({'name': 'video: opening the video resolves its media once', 'pass': [q['key'] for q in requests['video'] if q['op'] == 'resolve'] == ['/synthetic/Recordings/daily.mkv']})
checks.append({'name': 'audio-only: nothing outside the meeting is sent', 'pass': not any(q['op'] in ('media-plan', 'media-remove', 'recording-process') for q in requests['audio-only'])})
finish_journey(command, 'video', out, checks, screens)
