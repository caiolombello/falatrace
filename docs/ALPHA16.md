# FalaTrace 0.2.0-alpha.16

Experimental Linux source release that fixes one alpha.15 defect: the Studio did not open on Qt 6.10. Everything else is alpha.15, described in [ALPHA15.md](ALPHA15.md).

## Changes

**Studio on Qt 6.10.** Alpha.15's Ask panel (`src/desktop/AskPanel.qml`) named a variable `short`. The Qt 6.10 QML engine, the system Qt of Ubuntu 26.04 (`libQt6Qml` 6.10.2), refuses that word as an identifier with "Unexpected token `reserved word'", so `Main.qml` reported "Type AskPanel unavailable" and the Studio failed to load; the tray's **Abrir biblioteca** and the menu entry opened nothing. The variable is now `shortTitle`. A new test (`src/desktop/__tests__/qml-reserved-identifiers.test.ts`) refuses declarations and parameters in the Studio's QML and JavaScript named with any word Qt 6.10 reserves; each word in its list was confirmed to be refused by libQt6Qml 6.10.2, and a control name was confirmed to load. The Studio journeys in CI run on PySide6 6.11, which accepts some of these words, so they could not catch this.

## Verification

The new test fails on alpha.15 (`AskPanel.qml: short`) and passes with the fix. Type, desktop type, Biome lint (0 errors) and the CLI build pass. The offline suite ran locally with 2,583 passing and 2 failing tests across 244 files: both failures are in `src/speakers/__tests__/voices.test.ts`, fail the same way on the published alpha.15 source on the same machine, and depend on the local FFmpeg (8.0.1); they are not caused by this change (see Limits). The patched Studio was loaded offscreen with the system Qt 6.10.2 and stayed up without QML errors; before the fix it exited at load.

## Limits

Only the reserved words listed in the test are checked, and only in declarations and parameters; other differences between Qt 6.10 and the PySide6 6.11 used by the journeys are not covered. With FFmpeg 8.0.1, two known-voice tests cut speaker audio to the wrong length (`voices.test.ts`), so voice signatures may be computed on the wrong audio with that FFmpeg; known voices are off by default. This is not fixed here. Everything listed in [ALPHA15.md](ALPHA15.md#limits) still applies.

## Installation and rollback

Same as alpha.15: update only when no capture or processing is active, and reconnect existing MCP sessions to use the new executable. Configurations, data and services from alpha.15 are unchanged. Alpha.15 remains available for rollback, but its Studio does not open on Qt 6.10. This document describes the release, not an installed-state receipt.
