# Quickstart

From a source checkout to your first meeting notes. FalaTrace is an experimental Linux alpha: check the providers and destinations before you record anything real, and record only with the permission of the people involved. [Português](QUICKSTART.pt-BR.md)

## 1. Install

You need Bun 1.4, FFmpeg and Git. The Studio also needs Qt 6.10 with MpvQt; the tested system is Ubuntu 26.04. Local processing needs [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (`whisper-cli`) and [Ollama](https://ollama.com); both are installed separately.

```sh
git clone https://github.com/caiolombello/falatrace.git && cd falatrace
bun install --frozen-lockfile --ignore-scripts
make install-cli
```

To install the Studio with a menu entry, install the Qt headers from your distribution and run `make install-studio`:

```sh
sudo apt install qt6-base-dev qt6-base-dev-tools qt6-declarative-dev libmpvqt-dev
make install-studio
```

`make install-studio` builds the Studio, installs it under `~/.local/share/falatrace/studio` and adds the `recording-studio` command, a menu entry and the icon. It does not run sudo or download anything. Without the Qt packages, `bun run desktop:setup` fetches the headers into a user cache instead.

## 2. First use

Open **FalaTrace Studio** from the application menu or run `recording-studio`. With no configuration yet, the Studio opens the setup assistant. Nothing is saved or installed until you finish it, the OpenAI key included. The audio test and model downloads run only from their own buttons.

1. **Welcome.** Pick the language (automatic, Portuguese or English) and confirm you will only record with permission. **Quick start (recommended)** jumps to the review with audio only, local processing, notes processed as soon as a recording stops, and automatic recording off.
2. **Capture.** Choose **Audio only** (recommended) or **Screen and audio**, then the microphone and system audio. **Test audio** records five seconds, shows the level of each track and deletes the file.
3. **Processing.** Choose where transcription and notes run: everything on this computer, local transcription with an OpenAI summary, or everything through OpenAI. The assistant shows what is missing, offers to download the recommended Whisper model and pull the Ollama model (**Download what is missing** starts both, with their size and an estimated time), and takes the OpenAI key when it is needed. Downloads only start from their own buttons and keep running while you go through the other steps.
4. **Automatic recording.** Leave it off, only notify when a call starts, or record detected calls automatically.
5. **Review.** Check the summary and choose which services to start now: the call monitor, background processing and the tray indicator. Then finish. While a model is still downloading, finishing waits for it; **Finish by itself when the download ends** saves the setup as soon as it is done.
6. **Ready.** See what was set up and anything still missing. Then **Record a 1-minute test**: after you confirm, type a few notes while it records. It stops by itself after a minute and opens the meeting; with the quick start, your first notes appear there a few minutes later, processed on this computer.

Every choice can be changed later in **Settings**. The full list of options is in the [configuration reference](CONFIGURATION.md).

## 3. Record and take notes

- Start a manual recording from the Studio after a confirmation, and stop it when the meeting ends. With automatic recording on, detected calls start and stop on their own.
- While it records, type short notes in the notepad: a decision, a name, a to-do (`[ ] send the proposal`). Each line keeps the moment you typed it. <!-- studio-check -->
- When it stops, the recording is processed:
  - right away, when processing is local and `processing.fastPath` is on (the quick start turns it on);
  - in the background, when automatic processing is on;
  - otherwise when you open it and choose **Generate notes…**, which shows where the audio and the transcript go, marks anything that leaves the computer and asks for consent before queueing.
- A desktop notification says when the notes are ready; clicking it opens the meeting in the Studio.

Stopping ends the current capture; pausing new recordings affects only future automatic captures. Closing the Studio window keeps the configured background services running. No install or init command starts a capture.

From the terminal: `falatrace record start`, `falatrace record stop` (ends the current capture), `falatrace calls pause` (suspends future automatic recordings), `falatrace calls status`, and `printf '%s\n' "- my note" | falatrace notes edit <job-id>`.

## 4. Read and use the notes

- The meeting opens on its notes: your lines as you wrote them, completed by the AI with what was said. Each AI line cites the moment it came from; follow it to hear that moment. Uncertain lines are marked. <!-- studio-check -->
- The template (1:1, stand-up, postmortem…) was picked for this meeting; with Ollama on this computer, you can regenerate the notes with another template or language without losing yours. See [notes and templates](NOTES-AND-TEMPLATES.md).
- The **Transcript** and **Speakers** tabs show the source. Corrections are saved as human revisions; the original is kept.
- **Ask** about this meeting, a person, a client or the whole library; answers cite their sources. Local Ollama is the default; any other provider shows where your question goes and asks first. See [assistant](ASSISTANT.md).
- **Share** the notes to Obsidian, Notion, Slack or an AI app after a preview; see [sharing](SHARING.md). **Export** writes JSON, Markdown, SRT or WebVTT files on this computer.
- **Agent access…**, on the **Agents** tab, authorizes a local agent (Claude Code, Codex or Gemini CLI) to read this recording, and shows the command to connect it. You copy and run it yourself; pausing or revoking applies on the next query.

## 5. Keep track over time

- **People, Clients and Actions** collect who you met, which client each meeting belongs to, and every action item, which you can tick off. See [people, clients and actions](PEOPLE-CLIENTS-ACTIONS.md). <!-- studio-check -->
- **Reminders** notify you shortly before a calendar meeting, with what is still open from earlier meetings and a button to record or skip it: `falatrace reminders install-service`. See [reminders and live transcript](REMINDERS-AND-LIVE.md).
- **Privacy and retention** settings decide how long media is kept. See [privacy and data](PRIVACY.md).

## 6. When something does not work

- **Settings → Services and diagnostics → Check now** checks FFmpeg, Whisper.cpp and its model, Ollama and its model, API keys and the recording backend, without recording or contacting external services. Each problem links to the section that fixes it.
- **Settings → API keys → Test key** asks the provider whether a key is accepted, without sending audio or text.
- From a terminal:

  ```sh
  falatrace record doctor
  falatrace keys status
  falatrace assistant status
  journalctl --user -u recording-cli-calls -n 50
  ```

## Uninstall

```sh
make uninstall-studio
make uninstall
```

Both remove only the installed programs. Your configuration, keys, recordings, notes and backups stay where they are.
