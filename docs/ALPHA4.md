# Alpha.4 — shareable FalaTrace skill

Adds the MIT [FalaTrace skill](../skills/falatrace/SKILL.md), [installation instructions](../skills/README.md), exact CLI/output references and synthetic scenarios. The alpha.3 code and limitations remain; no new capture/model/provider capability is introduced. Version/help match the package release.

The skill handles selection and bounded retrieval of existing recordings, transcript/summary provenance, and guides actual Studio preview/consent for scoped local frames. It grants no permission to capture, upload, run paid inference, bypass budgets or delete data. No public visual CLI command is claimed.

Frontmatter/references and actual read-only CLI examples are validated offline with synthetic artifacts. No model/trigger benchmark, private-media inference or native capture test was performed. Existing provider/config choices and legacy CLI aliases stay compatible. Migration of an old skill requires locating/backing up its actual discovery entry; absence in checked roots is not proof it does not exist elsewhere.

Final offline command fixture checks assert text versus JSON, selected recording identity, bounded character budget, supplied segment timestamp, and preservation of config/job/summary/transcript. Unknown model timing remains a limitation in the underlying retrieval contract; timestamps are never invented by the skill.

Local final suite: 418 pass, 0 fail, 3,432 assertions across 72 files (89.36s); typecheck/desktop check/build/standalone version check passed. The unchanged Qt/C++/bridge/Studio flow uses the same validated alpha.3 native build and 24 synthetic screens/56 checks, not a new native capture claim.
