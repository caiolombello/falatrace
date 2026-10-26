# Reminders and live transcript

## Reminders

A desktop notification shortly before a calendar meeting, with a button to record it or skip it. It needs a calendar: Google Calendar (`google.calendar`, after connecting your account) or the GNOME calendar (`calendar.enabled`). See [configuration](CONFIGURATION.md#integrations).

### Modes

`reminders.mode`:

| Value | Reminders are on when |
| --- | --- |
| `auto` (default) | Recordings are not automatic: call detection is off, in `notify-only` mode, or in dry run. |
| `on` | Always. |
| `off` | Never. |

The notification comes `reminders.leadMinutes` before the start (1 to 15 minutes, default 2). Its title is the meeting name, such as "Revisão semanal em 2 min", "… começa agora" or "… já começou".

### Buttons

They depend on how recordings start:

| Recording mode | Buttons |
| --- | --- |
| Call detection off, `notify-only`, or automatic recording paused | **Gravar** and **Agora não** |
| `record` or `obs` | **Pular esta gravação** and **OK** |

**Ver resumo anterior** is added when a brief exists (below). Buttons need a `notify-send` that supports actions; otherwise you get a plain notification.

- **Gravar** saves a "record" decision for that meeting. The call monitor then records it when the call starts, even in `notify-only` mode or while automatic recording is paused (a pause set after the decision wins). The decision covers one call: the first one it records; another call later in its window, or a call that only starts after the meeting's scheduled end, follows the configured mode. With call detection off, it starts a manual capture named after the meeting instead and opens it in the Studio.
- **Pular esta gravação** saves a "skip" decision: the call monitor will not record that meeting.
- A decision applies from 10 minutes before the start to 15 minutes after the end. It only starts or blocks new recordings, with one exception: withdrawing a "record" decision (**Desfazer**, or switching to **Pular**) stops the recording that decision started when the configured mode would not have recorded the call; the media captured so far is kept.

Decisions are kept in `~/.local/state/recording-cli/meeting-overrides.json` and pruned when they expire. The Studio's Home lists upcoming meetings with the same record and skip choices. <!-- studio-check -->

### The service

Reminders run as a user service, installed only when you ask:

```sh
falatrace reminders status              # effective mode, calendars and service state (JSON)
falatrace reminders test                # what the next 3 hours would notify; shows and sends nothing
falatrace reminders install-service     # installs and starts recording-cli-reminders.service
falatrace reminders uninstall-service
```

The Studio can apply and disable it too, in Settings › Calendar and reminders or in the services section. The service checks the calendar every 5 minutes for the next 3 hours. It reads the configuration when it starts, so apply it again after changing reminder or calendar settings. It runs sandboxed: your home is read-only to it except FalaTrace's state folder. Calendar event ids are stored only as hashes with a salt unique to this installation (`~/.local/state/recording-cli/calendar-salt`); sent reminders are recorded in `reminders-sent.json` next to it.

### The brief

With `reminders.brief` on (the default), the notification can carry up to three short lines about earlier meetings: when you last met, the open actions (with the first one) and the last decision. FalaTrace looks for earlier meetings of the same recurring series, then meetings with at least one of the same guests (other than you), then meetings of a client named in the title, then meetings with exactly the same title. It shows nothing rather than filler when nothing relevant is found.

The brief is built only from local data: the library index, your action states and the client catalog. Nothing is sent anywhere to build it.

## Live transcript

An optional preview of the transcript while you record. The final transcript is still made after the meeting by your transcription settings, and the notes are built from that one.

- `live.enabled` is off by default. **When it is on, every capture starts the live transcript**: with a provider outside this computer (Groq, OpenAI), the audio of every capture goes to it while you record, and the setting is that consent. While a capture runs, the Studio can turn the live transcript off and on again; turning it back on with a provider outside this computer asks for consent first, for that provider. <!-- studio-check -->
- A separate FFmpeg process listens to the same microphone and system audio as the capture, in chunks of `live.chunkSeconds` (5 to 60 seconds, default 15). Silent chunks are skipped.
- Each chunk is transcribed and appended as a line to `~/.local/state/recording-cli/live/<session>/live.jsonl`. Chunk audio files are deleted once transcribed. The transcript lines stay for 30 days after the capture stops (each new capture removes older ones) or until the recording is deleted, whichever comes first.
- It runs as a temporary user unit (`recording-cli-live-<session>.service`) at low priority (Nice 10, CPU weight 20, at most 1 GiB of memory), so the capture comes first. Its status says when it falls behind.

```sh
falatrace live show <session-id>            # lines so far, as [mm:ss] text
falatrace live show <session-id> --follow   # until the capture stops
```

### Providers and cost

| `live.provider` | Where the audio goes | Approximate cost per hour of meeting |
| --- | --- | --- |
| `whisper-cpp` (default) | Nowhere: this computer's CPU, with the light model in `live.whisperModelPath` (default `ggml-base.bin`, `live.whisperThreads` threads) | Free |
| `openai` | OpenAI, in chunks, with `live.openaiModel` (default `gpt-transcribe`) and `OPENAI_API_KEY` | About US$0.27 |
| `groq` | Groq, in chunks of at least 10 seconds, with `live.groqModel` (default `whisper-large-v3-turbo`) and `GROQ_API_KEY` | About US$0.04 |

Prices come from the vendors' pricing pages, checked on 2026-10-25, and can change. They add to the cost of the final transcript when that also uses a paid provider.

Trade-offs: shorter chunks show text sooner but cost more CPU or requests. A local model that is too large for the CPU falls behind; a small model keeps up in real time on most CPUs. Live text has chunk-level timing and is not used for citations.
