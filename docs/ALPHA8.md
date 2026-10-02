# FalaTrace 0.2.0-alpha.8

Experimental Linux source release: a focused caption preference and presentation fix.

## Caption behavior

The Studio caption checkbox stays usable when a recording is selected, including while details refresh or no timed track exists. With keyboard focus, Space toggles the checkbox rather than the global playback shortcut. The preference continues to apply across returning to the library and reopening within the same process; this release adds no preference persistence across process restarts.

Existing usable segment captions take priority. If none are available and a validated stored diarization result exists, the Studio may present its own timed utterance text as captions. Speaker labels and timestamps come from that result. The UI identifies automatic output for review and discloses partial coverage. The canonical transcript remains separate and unchanged; approximate block text is never mapped onto diarizer timings.

Without a usable track, enabling the preference does not invent captions: the status explains the absence while the transcript remains readable. No automatic retry, provider dispatch, diarization or remote generation is introduced.

## Verification

The release gate uses the complete offline regression suite, project/desktop typechecks, cached frozen-lock bootstrap, compiled CLI/native shell metadata and immutable source/build manifests. Results for the exact public commit are available in CI; release artifacts include source and skill SHA-256 checksums.

Meaningful fixtures cover caption precedence, canonical/sidecar preservation, invalid or missing timed text, partial output and approximate-block rejection. Actual Qt mouse/Space events exercise the production QML with synthetic recordings: on/off, loading refresh, slider seek dispatch, overlapping cue boundaries, same-position source change, missing tracks, back and reopen. Light and dark rendering were inspected. Input hooks and injected playhead belong only to QA and are not shipped in the application.

## Limits

Synthetic playhead checks do not establish decoder playback or acoustic timing accuracy. Native capture, general desktop compatibility, actual model quality and redistributed native binaries remain unvalidated. This fix does not repair operational subtitle-worker failures. Automatic speaker text and labels must be reviewed; no person's identity is inferred.

The existing installation/provider/recording consent rules remain in effect. Source distribution is Linux-only. Do not assume chat subscriptions cover API calls. No private media or transcripts are included in release artifacts.

## Rollback

The alpha.7 tag/release remains intact. A deliberate installation keeps the previous release and skill backup, changes the release pointer only during freshly verified IDLE, and preserves configurations, recordings, jobs, grants, consumption and catalogs. Never roll back state or configuration from stale backups.
