# Local time entries

Time entries are an optional local module, disabled by default. There is no corporate submission adapter: the `synced` status is a stored state, not proof of delivery. FalaTrace does not submit time entries to an employer or issue tracker.

New catalogs start empty. Configure your own clients and task types in the local catalog selected by `timesheet.contextPath`. Task type IDs are user-supplied positive integers; existing IDs, names, entries and catalogs are not renumbered or rewritten. Client codes accept 1–20 ASCII letters/digits with `.`, `_`, `:`, or `-` after the first character. Optional task references accept up to 100 ASCII letters/digits and `._:#/-`; legacy `DEV-123` references retain uppercase normalization. These are bounded identifiers, not executable destinations or URLs.

```json
{"version":1,"colleagues":[],"clients":[{"code":"project:blue","name":"Example project","aliases":[],"responsibleNames":[]}],"taskTypes":[{"id":42,"name":"Research","slug":"research"}]}
```

Automatic entries and external AI classification require explicit opt-in. Turning on the module alone does not opt into either, including existing configurations: omitted `timesheet.aiClassification` and `timesheet.automaticFromCalls` flags default to `false`. Explicit `true` and `false` values remain unchanged, and loading never rewrites configuration files.

Client selection first matches the exact client code, preserving punctuation and case. Name, alias and normalized code lookup remains available when it identifies one client; ambiguous matches return no selection. For example, catalog codes `A.B` and `a-b` resolve separately by their exact codes, while `a b` is ambiguous.

When explicitly enabled and configured with an OpenAI key, classification sends the supplied client catalog (including names, aliases and responsible people), colleague names, summary and bounded transcript to OpenAI. A configured key is not evidence of free/included API usage. Local rule suggestions and manual edits remain available without this call. No model is invoked by catalog initialization or version inspection.

Legacy `CL###` derived memory filenames stay unchanged. Other client codes use an SHA-256-derived filename in the managed client-memory directory, so punctuation never becomes a path. Cleanup covers both managed schemes only when a regular file carries the existing generation marker. Unmarked files, symlinks and unrelated filenames are preserved.

Remaining product choices are explicit: UI/prompt language is Portuguese; entry readiness requires client, type, description and 0.1–24 hours; split recommendations retain the existing 15-minute/20% heuristic and hundredth-hour allocation. This is a bounded work-log model, not a configurable schema engine. Custom fields, billing policies, locale settings and submission/export adapters are not implemented by this change.
