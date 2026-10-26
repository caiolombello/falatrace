#!/usr/bin/env python3
"""Watching a meeting's video in the actual Studio QML against a synthetic bridge.

Offline and disposable. A video recording says "Assistir gravação", shows a film tile and opens
with the video expanded (the first time; the last choice is kept for the session); an audio-only
recording (an audio capture, .mka, or one whose video retention removed) says "Ouvir gravação" and
keeps a waveform tile. Cinema mode makes the video take most of the page with the notes beside it
(a wide window) or below it (compact); full screen covers the window, keeps captions and the
speaker overlay, and Esc leaves it before anything else. Citations seek and keep the size. The
PySide6 runner's player is inert, so a step sets the duration and codec it reports to stand in for
an open video. Every step waits (bounded) for the state the previous reply produces.
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


# The runner's player is inert: these are what mpv reports once a video is open.
PLAY = 'video.setPropertyAsync("duration", 120); video.setPropertyAsync("video-codec", "h264")'

PLANS = {
    'video': ('1320x820', True, [pick('daily.mkv'),
        ('video meeting open', opened('daily.mkv'), '''
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
        ('video meeting open', opened('daily.mkv'), 'check("expanded first", %(s)s.videoExpanded); uxFind(detailView, "cinemaToggle").clicked(); %(play)s' % {'s': STRIP, 'play': PLAY}),
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
        ('video meeting open', opened('daily.mkv'), PLAY),
        ('video playing', 'mediaReady && mediaProbed', 'fullScreenKey()'),
        ('full screen', STRIP + '.fullScreen', '''
    const layer = uxFind(window.contentItem, "videoFullScreen")
    check("F puts the video over the whole window", layer.visible && videoFrame.parent === layer && videoFrame.width === window.width && videoFrame.height === window.height)
    check("captions and the speaker keep working in full screen", captionOverlay.visible && activeSpeakerLabels(position) === "Ana")
    check("the full-screen bar can leave it", uxFind(layer, "fullScreenBar").visible && uxFind(layer, "fullScreenExit").visible)''')]),
    'video-escape': ('1320x820', True, [pick('daily.mkv'),
        ('video meeting open', opened('daily.mkv'), STRIP + '.setFullScreen(true)'),
        ('full screen', STRIP + '.fullScreen', 'escapeKey(); check("Esc leaves full screen first and keeps the meeting", !%(s)s.fullScreen && %(s)s.videoExpanded && !!selected.key && videoFrame.parent === uxFind(detailView, "videoPane"))' % {'s': STRIP}),
        ('back in the page', '!' + STRIP + '.fullScreen', 'videoKey(); check("v collapses the video into the strip", !%(s)s.videoExpanded && videoFrame.parent === uxFind(detailView, "playerThumbnail"))' % {'s': STRIP})]),
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
