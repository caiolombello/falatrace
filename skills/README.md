# FalaTrace skill

The installable folder is `falatrace/`, containing `SKILL.md`, relative references and synthetic evaluation scenarios. MIT, no provider keys or private recordings. It documents existing CLI commands and the Studio/programmatic visual flow; no invented visual CLI.

From a reviewed checkout, install to your agent's supported skill directory. For a shared standard `~/.agents/skills` setup:

```sh
mkdir -p "$HOME/.agents/skills"
# Refuse overwriting any existing skill. Back it up/review it separately first.
test ! -e "$HOME/.agents/skills/falatrace" && test ! -L "$HOME/.agents/skills/falatrace" && \
  cp -R skills/falatrace "$HOME/.agents/skills/falatrace"
```

If Claude's skills directory is already linked to that shared directory, do not install a second copy. Otherwise choose the single supported root for the agent (for example `~/.claude/skills`); do not create duplicate competing discovery entries. Refresh/restart the agent session if its catalogue was loaded before installation.

Use the FalaTrace skill name for new explicit invocations. Its description also covers ordinary requests mentioning `recording-cli`; the legacy **CLI executable alias** can still be used. This does not guarantee old explicit skill-name invocations are aliased by every agent engine.

Before replacing an installed `recording-cli` skill, back it up outside all discovery roots and inspect personal amendments. Retire its active SKILL.md discovery entry only after checking the replacement; preserve private notes locally, never in a public repository. Leave a plain README/reference pointing to FalaTrace if needed, not a second active conflicting skill. This package does not remove or modify existing skills automatically.

Validation: frontmatter via the existing local skill-creator validator; relative references and actual CLI read-only contracts exercised with synthetic fixtures. `evals/evals.json` describes expected responses; no LLM performance/trigger benchmark or live privacy/consent behavior certification is claimed. Read current validation and model/retention/native limits in [alpha.11 notes](../docs/ALPHA11.md).
