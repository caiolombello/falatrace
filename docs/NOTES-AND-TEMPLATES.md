# Notes and templates

You write short notes during the meeting. After it, the AI turns them into structured notes: your lines stay as you wrote them, and the AI completes them with what was said, citing the moment of the transcript each line comes from.

## The notepad

- In the Studio, the notepad sits next to the capture while you record, and on the meeting page afterwards. It saves shortly after you stop typing and when you press Enter. <!-- studio-check -->
- Each line remembers when you typed it, measured from the start of the recording. Editing a line in place keeps its time; a new line gets the current time. Lines typed more than two minutes after the capture stopped are kept without a time.
- Simple prefixes give a line a kind: `# Heading`, `- item` or `* item`, `[ ] to do` or `- [ ] to do`, `[x] done`. Anything else is plain text.
- Limits: 500 lines, 2,000 characters per line, 64 KiB in total.
- Two windows cannot overwrite each other: a save based on an older version is refused with "As notas mudaram em outra janela; recarregue antes de salvar."
- Notes are private files on this computer (see [privacy](PRIVACY.md)). They are sent only with the summary request (to the summary provider), with a question to the assistant when that meeting is in scope, and in a share that includes them.

From the terminal:

```sh
falatrace notes show <job-id>             # the notes as typed; --json for the stored record
printf '# Riscos\n- prazo apertado\n' | falatrace notes edit <job-id>
falatrace notes path <job-id>
```

`notes edit` replaces the whole notepad with standard input. `--rev N` refuses the save when the notes changed after revision N. An empty input over existing notes is refused unless you add `--clear`. The id can be the job id or the capture session id.

Settings: `notes.enabled` shows the notepad during captures; `summary.useNotes` uses the notes as the skeleton of the summary. Both are on by default.

## How the AI notes are built

When a recording is processed, the summary request contains:

1. the transcript, one line per segment, each with its ID (`s000123`) and time;
2. your notes, each with its ID (`n000001`), its time and the transcript segments around it (from 90 seconds before to 10 seconds after you typed it, since a note usually follows what was said);
3. the template's sections and instructions, and the language to write in.

The model is told that meeting text is untrusted data, never instructions. It must:

- keep every note as an item of yours, lightly cleaned and with the same meaning, under the section it fits best;
- add AI items that complete your notes with what was said, each citing the segments it comes from;
- never attribute AI content to you, invent owners or dates, or fill a section with invented content (an empty section is left out);
- mark an item as uncertain when the transcript does not settle it;
- list decisions and action items, mirroring the decision and action items in the sections.

FalaTrace then checks every note ID and segment ID against what was sent; an unknown ID fails the summary instead of being kept. Notes the model did not place are added at the end under "Notas suas que o modelo não usou" (in the summary's language), with a limitation saying so. Your notes are never dropped.

### Your lines and AI lines

In `summary.md`, your items start with `✎ ` and every item ends with the `[m:ss]` of the first segment it cites. In the Studio, your lines and AI lines look different, each AI line has a citation that jumps to that moment, and a toggle shows only your own notes. <!-- studio-check -->

Long meetings are summarized in parts; each note goes to the part that holds its moment. See [evidence and limits](EVIDENCE-AND-LIMITS.md#long-meetings).

## Templates

A template is the list of sections the notes follow, with instructions for the model. Built-in templates:

| Id | Name (pt-BR / en) | Sections (en) |
| --- | --- | --- |
| `general` | Geral / General | Summary, Discussion points, Decisions, Next steps |
| `one-on-one` | 1:1 / One-on-one | Updates, Blockers, Feedback, Next steps |
| `standup` | Daily (stand-up) / Daily stand-up | Yesterday, Today, Blockers |
| `planning` | Planejamento / Planning | Goals, Scope, Risks, Owners and dates |
| `retrospective` | Retrospectiva / Retrospective | What went well, What to improve, Action items |
| `sales-discovery` | Descoberta comercial / Sales discovery | Customer context, Pain points, Budget and decision (BANT), Objections and competition, Next steps |
| `postmortem` | Postmortem de incidente / Incident postmortem | Impact, Timeline, Root cause, What worked, What did not work, Corrective actions |
| `hiring-interview` | Entrevista de contratação / Hiring interview | Candidate profile, Strengths, Concerns, Assessment, Next steps |
| `user-research` | Pesquisa com usuários / User research | Participant profile, Goals, Pain points and friction, Notable quotes, Opportunities |

Section headings are written in the summary's language (Portuguese, English or Spanish).

### How a template is chosen

For each recording, the first rule that decides wins:

1. **Your choice for this recording**, made in the Studio when you regenerate. <!-- studio-check -->
2. **The default** in `summary.template`, unless it is `auto` (the default value).
3. **The calendar title.** Words such as "1:1", "daily", "retro" or "postmortem" in the event title decide when the match is strong and clearly ahead of the next template. A recurring event adds weight to recurring meeting types.
4. **Keywords in the transcript and your note headings.** They decide only with a clear winner: at least three hits and at least twice the runner-up.
5. **The model**, when `summary.templateDetection` is `ai` (the default): the summary request offers the templates and the model picks one, defaulting to `general`. This adds no extra request.
6. Otherwise, `general`.

The summary records which template was used and why (for example "O título da agenda indica 1:1 (1:1)."), and the Studio shows it. <!-- studio-check -->

```sh
falatrace templates list           # built-in and custom templates (JSON), plus files that were skipped
falatrace templates show postmortem
```

## Custom templates

Create one from an existing template, then edit the file it prints:

```sh
falatrace templates init one-on-one "Comitê de riscos"
# {"id": "custom:comite-de-riscos", "path": "~/.config/recording-cli/templates/comite-de-riscos.json", ...}
falatrace templates delete custom:comite-de-riscos
```

Custom templates live next to the configuration, in `templates/<slug>.json` (at most 100 files of 64 KiB each). The Studio has an editor for them too. <!-- studio-check --> The file format:

```json
{
  "version": 1,
  "updatedAt": "2026-10-26T12:00:00.000Z",
  "template": {
    "id": "custom:comite-de-riscos",
    "version": 1,
    "builtIn": false,
    "name": { "pt-BR": "Comitê de riscos", "en": "Risk committee", "es": "Comité de riesgos" },
    "description": "Monthly risk committee: open risks, new risks and decisions.",
    "titleKeywords": ["comite de riscos", "risk committee"],
    "transcriptKeywords": ["risco", "mitigacao", "apetite"],
    "sections": [
      { "id": "open-risks", "title": { "pt-BR": "Riscos abertos", "en": "Open risks", "es": "Riesgos abiertos" },
        "instruction": "Each open risk discussed, its owner and status, only as stated." },
      { "id": "new-risks", "title": { "pt-BR": "Riscos novos", "en": "New risks", "es": "Riesgos nuevos" },
        "instruction": "Risks raised for the first time in this meeting." },
      { "id": "decisions", "title": { "pt-BR": "Decisões", "en": "Decisions", "es": "Decisiones" },
        "instruction": "Decisions taken, with who decided when it was said." }
    ],
    "guidance": "Use the risk names exactly as spoken."
  }
}
```

Rules, checked strictly (a file that breaks one is skipped and listed under `problems` by `templates list`):

- `id` is `custom:` plus lowercase letters, digits and hyphens, and must match the file name; `builtIn` is `false`; `version` is a positive integer.
- `name` and every section `title` need all three languages, up to 80 characters each.
- `description` is one line, up to 300 characters. It is shown to the model.
- Keywords are lowercase, without accents, unique, up to 60 characters; up to 40 title keywords and 60 transcript keywords. Title keywords match whole words of the calendar title.
- 3 to 8 sections, each with a unique `id` and title, and an `instruction` of up to 600 characters.
- `guidance` holds extra instructions for the model, up to 2,000 characters.
- Unknown fields are refused. Instructions and guidance are written for the model, so English works best; the notes are still written in the summary's language.

A custom template with the same keywords as a built-in one wins the keyword match.

## Summary language

`summary.language` sets the language of new summaries: `auto` (default), `pt-BR`, `en` or `es`. With `auto`, FalaTrace looks at the transcript's common words and writes in the predominant language; when it cannot tell, it uses Portuguese. Headings, the "unused notes" title and limitation phrases follow the same language. Existing summaries keep their language until regenerated.

## Regenerating

- In the Studio you can regenerate a meeting's notes with another template or language. Your notes stay as they are; the AI notes are rewritten. A summary on this computer runs right away; an external destination (OpenAI, or an Ollama on another computer) first shows where the text goes and asks for consent. The choices are saved for that recording. <!-- studio-check -->
- Regeneration uses the reviewed transcript, so your corrections are included.
- From the terminal, `falatrace summary-review plan|run <job-id>` regenerates from the reviewed transcript with the recording's saved choices, after an explicit plan and consent; see `falatrace help summary-review`.
- Recordings whose media was removed by [retention](PRIVACY.md#media-retention) can still be regenerated: only the transcript is needed.
