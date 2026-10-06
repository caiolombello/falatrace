# Quickstart

From a source checkout to a first processed recording. FalaTrace is an experimental Linux alpha: check the providers and destinations before you record anything real, and record only with the permission of the people involved. [Português](QUICKSTART.pt-BR.md)

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

Open **FalaTrace Studio** from the application menu or run `recording-studio`. With no configuration yet, the Studio opens the setup assistant. Nothing is saved or installed until you click **Finish**, the OpenAI key included. The audio test and model downloads run only from their own buttons.

1. **Welcome.** Pick the language (automatic, Portuguese or English) and confirm you will only record with permission. **Use the recommended defaults** jumps to the review with audio only, local processing and automatic recording off.
2. **Capture.** Choose **Audio only** (recommended) or **Screen and audio**, then the microphone and system audio. **Test audio** records five seconds, shows the level of each track and deletes the file.
3. **Processing.** Choose where transcription and summaries run: everything on this computer, local transcription with an OpenAI summary, or everything through OpenAI. The assistant shows what is missing, offers to download the recommended Whisper model or pull the Ollama model, and takes the OpenAI key when it is needed. Downloads only start from their own buttons.
4. **Automatic recording.** Leave it off, only notify when a call starts, or record detected calls automatically.
5. **Review.** Check the summary and choose which services to start now: the call monitor, background processing and the tray indicator.

Every choice can be changed later in **Settings**. The full list of options is in the [configuration reference](CONFIGURATION.md).

## 3. Record and process

- **Record…** in the header starts a manual recording after a confirmation; **Stop capture** ends it. With automatic recording on, detected calls start and stop on their own.
- New recordings appear in the library. With automatic processing on, they are transcribed and summarized in the background.
- Otherwise open a recording and click **Process…**. The dialog shows where the audio and the transcript will go, marks anything that leaves the computer, and asks for consent before queueing.
- With notifications on, a desktop notification tells you when processing finishes or fails.

## 4. Review and use the results

- **Transcript**, **Summary** and **Speakers** tabs show the results with links back to the source time. Corrections are saved as human revisions; the original is kept.
- **Export** writes JSON, Markdown, SRT or WebVTT files on this computer.
- **AI access…** authorizes a local assistant to read this recording. **Connect my assistant…** then shows the command for Claude Code, Codex or Gemini CLI. You copy and run it yourself; pausing or revoking applies on the next query.

## 5. When something does not work

- **Settings → Services and diagnostics → Check now** checks FFmpeg, Whisper.cpp and its model, Ollama and its model, API keys and the recording backend, without recording or contacting external services. Each problem links to the section that fixes it.
- **Settings → API keys → Test key** asks the provider whether a key is accepted, without sending audio or text.
- From a terminal:

  ```sh
  falatrace record doctor
  falatrace keys status
  journalctl --user -u recording-cli-calls -n 50
  ```

## Uninstall

```sh
make uninstall-studio
make uninstall
```

Both remove only the installed programs. Your configuration, keys, recordings and backups stay where they are.
