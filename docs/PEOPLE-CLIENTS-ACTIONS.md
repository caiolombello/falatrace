# People, clients and actions

FalaTrace gathers who you meet, which client each meeting belongs to, and what was agreed, from recordings you already processed. Everything here is built from local data and stored on this computer. The Studio has a page for each, with the meetings, decisions and open actions behind every entry. <!-- studio-check -->

The pages read the local library index (see [assistant](ASSISTANT.md#what-is-sent)). The CLI listing commands bring it up to date first; on a large library the first run can take a while.

## People

A person appears when a name shows up in at least one of these:

- a **confirmed speaker name**: a name you gave a speaker in the review (the automatic "Falante 1" labels do not count);
- a **calendar guest** of the event linked to the recording (Google Calendar; names only, never e-mail addresses);
- a **known voice**, when voice recognition is on (`speakers.voices`).

Names are grouped when they match after ignoring case, accents and extra spaces. Each person lists their meetings (as a speaker or a guest), the last meeting and the open actions they own. The detail adds their recent decisions. You are recognized as yourself only through the calendar, where the event marks your own attendance.

```sh
falatrace people list [--all]          # JSON, most recent first; --all includes hidden people
falatrace people show <id>
falatrace people rename <id> "Ana Souza"      # the old name becomes an alias
falatrace people alias <id> add "Aninha"
falatrace people merge <from-id> <to-id>
falatrace people hide <id>                    # unhide brings them back
```

Ids are stored UUIDs, or `name:<key>` for a person you never edited. Edits are kept in `~/.local/share/recording-cli/people/people.json`; they never change a recording, a transcript or a speaker name in a review.

Good to know:

- Two different people with the same name are one person until you rename one of them.
- Renaming someone to a name another unedited person already uses joins them.
- Merges are flattened: separating a person later does not bring back what was merged into them earlier.

## Clients

Clients come from your client catalog, the timesheet context file at `timesheet.contextPath` (default `~/.config/recording-cli/timesheet-context.json`; create it with `falatrace time init-context`). A missing file means no clients.

A meeting's clients are, in order:

1. the ones you chose for that recording;
2. otherwise the clients of its time entries, when an entry's client is locked or its confidence reaches `timesheet.readyConfidence`;
3. otherwise exactly one client named in the summary, then in the transcript.

The same rule feeds the Clients page, `context search --client`, the per-client AI context and the library index.

```sh
falatrace clients list                         # catalog clients with meeting and open-action counts (JSON)
falatrace clients show <code>                  # meetings, decisions, actions and people
falatrace clients add "Acme Ltda" --code ACME --alias Acme
falatrace clients rename ACME "Acme S.A."
falatrace clients delete ACME
falatrace clients assign <job-id> ACME BETA    # or --auto to go back to the automatic rule
```

Catalog edits keep every other field of the file, write a private backup next to it (the 10 most recent are kept) and replace the file atomically. An invalid catalog is never edited: "O catálogo de clientes é inválido; corrija o arquivo antes de editar." Per-recording choices are kept in `~/.local/share/recording-cli/client-overrides.json`.

## Actions

An action is an item to do from a meeting:

- the summary's action items, with the owner and due date only when they were said;
- the unchecked to-do lines of your notes (`[ ] …` or `- [ ] …`).

Each action has a status: open, done or dismissed. The status is kept per recording media in `~/.local/share/recording-cli/actions/<media-sha256>.json`, so it survives regenerating the notes: an action is matched to its new wording by fingerprint, then by similar text citing overlapping moments. An action that no longer appears in the current summary keeps its status and is shown as "fora do resumo atual".

```sh
falatrace actions list                                   # open actions; each line ends with <media>:<id>
falatrace actions list --status all --person <id> --json
falatrace actions list --client ACME --meeting <job-id>
falatrace actions done <media>:<id>
falatrace actions reopen <media>:<id>
falatrace actions dismiss <media>:<id>
```

Listing never writes a status. Dismissed actions stay out of shared notes. In the Studio, the Actions page groups and filters them, and ticking one can be undone. <!-- studio-check -->

## Before your next meeting

When reminders are on, the [reminder](REMINDERS-AND-LIVE.md#the-brief) of a calendar meeting can carry a short brief from these pages: what earlier meetings with the same people, series or client left open.
