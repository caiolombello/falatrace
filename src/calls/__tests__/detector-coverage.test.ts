import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { classifyCall, parsePipeWireNode, sanitizePipeWireNodes } from "../classifier";
import { JsonValueStreamParser, PipeWireGraph } from "../pipewire";
import { CallStateMachine } from "../stateMachine";
import type { PipeWireNodeRecord } from "../types";

const apps = DEFAULT_CONFIG.callDetection.apps;
const stream = (
  id: number,
  identity: Record<string, unknown>,
  mediaClass = "Stream/Input/Audio",
  state = "running",
  extra: Record<string, unknown> = {}
): PipeWireNodeRecord => ({
  id,
  type: "PipeWire:Interface:Node",
  info: { state, props: { ...identity, "media.class": mediaClass, "stream.is-live": true, ...extra } }
});
const binary = (value: string) => ({ "application.process.binary": value });

describe("synthetic application attribution coverage", () => {
  for (const app of ["slack", "zen", "helium"] as const) {
    test(`${app}: exact binary, case folding and explicit switch`, () => {
      for (const identity of [binary(app), binary(app.toUpperCase()), { "application.name": app }]) {
        expect(classifyCall([stream(1, identity)], apps).app).toBe(app);
      }
      expect(classifyCall([stream(1, binary(app))], { ...apps, [app]: false }).active).toBe(false);
    });
    test(`${app}: playback and communication role alone do not trigger capture`, () => {
      expect(classifyCall([
        stream(1, binary(app), "Stream/Output/Audio", "running", { "media.role": "Communication" })
      ], apps).active).toBe(false);
      expect(classifyCall([
        stream(2, binary(app), "Audio/Source", "running", { "media.role": "Communication" })
      ], apps).active).toBe(false);
    });
    test(`${app}: attributed camera-only capture remains a heuristic candidate`, () => {
      const result = classifyCall([stream(1, binary(app), "Stream/Input/Video")], apps);
      expect(result.app).toBe(app);
      expect(result.reasons).toEqual(["capture-video-running"]);
    });
  }

  test("existing Zen and Helium app IDs are accepted without process names", () => {
    expect(classifyCall([stream(1, { "application.id": "app.zen_browser.zen" })], apps).app).toBe("zen");
    expect(classifyCall([stream(2, { "application.id": "helium" })], apps).app).toBe("helium");
  });

  for (const [supported, app] of [
    ["firefox", "firefox"],
    ["chromium", "chromium"],
    ["google-chrome", "chrome"],
    ["zoom", "zoom"],
    ["teams-for-linux", "teams"]
  ] as const) {
    test(`${supported}: explicit identity is attributed to ${app}`, () => {
      expect(classifyCall([stream(1, binary(supported))], apps).app).toBe(app);
    });
  }

  test("personal messengers are recognized only after an explicit opt-in", () => {
    expect(classifyCall([stream(1, binary("discord"))], apps).active).toBe(false);
    expect(classifyCall([stream(1, binary("discord"))], { ...apps, discord: true }).app).toBe("discord");
  });

  for (const unsupported of ["teams", "skype", "webex", "chromium-helper", "obs"]) {
    test(`${unsupported}: unsupported binary is ignored rather than guessed`, () => {
      expect(classifyCall([stream(1, binary(unsupported))], apps).active).toBe(false);
    });
  }

  test("unrecognized IDs, PID alone and substring names do not authorize attribution", () => {
    for (const identity of [
      { "application.id": "org.mozilla.thunderbird" },
      { "application.id": "com.slack.Slack" },
      { "application.process.id": 3210 },
      binary("slack-helper"),
      binary("not-zen"),
      { "application.name": "Synthetic Slack document" }
    ]) expect(classifyCall([stream(1, identity)], apps).active).toBe(false);
  });

  test("known app capture needs no communication role, so it does not prove a call", () => {
    // Voice-note or camera-preview capture has the same signal as a meeting.
    const result = classifyCall([stream(1, binary("zen"), "Stream/Input/Audio")], apps);
    expect(result.active).toBe(true);
    expect(result.reasons).not.toContain("media-role-communication");
  });

  test("inactive, suspended, missing-state and explicitly non-live nodes are ignored", () => {
    for (const state of ["idle", "suspended", "error", "unknown", ""]) {
      expect(classifyCall([stream(1, binary("zen"), "Stream/Input/Audio", state)], apps).active).toBe(false);
    }
    expect(classifyCall([stream(1, binary("zen"), "Stream/Input/Audio", "running", {
      "stream.is-live": false
    })], apps).active).toBe(false);
  });

  test("PID values are not identity and different app signals are not merged", () => {
    const result = classifyCall([
      stream(1, binary("slack"), "Stream/Input/Audio", "running", { "application.process.id": "100" }),
      stream(2, binary("zen"), "Stream/Output/Audio", "running", { "application.process.id": "100" })
    ], apps);
    expect(result.app).toBe("slack");
    expect(result.nodeIds).toEqual([1]);
    expect(result.confidence).toBeCloseTo(0.72);
  });

  test("same-app signals are aggregated across PIDs; the classifier does not identify tabs/calls", () => {
    const result = classifyCall([
      stream(1, binary("zen"), "Stream/Input/Audio", "running", { "application.process.id": "100" }),
      stream(2, binary("zen"), "Stream/Output/Audio", "running", { "application.process.id": "200" })
    ], apps);
    expect(result.nodeIds).toEqual([1, 2]);
    expect(result.confidence).toBeCloseTo(0.93);
  });

  test("diagnostic projection excludes titles, process IDs and opaque PipeWire properties", () => {
    const result = sanitizePipeWireNodes([stream(1, binary("zen"), "Stream/Input/Audio", "running", {
      "application.process.id": "100",
      "node.description": "Synthetic private title",
      "media.name": "Synthetic private media",
      "unknown.secret": "Synthetic sentinel"
    })], apps);
    expect(result).toEqual([{ id: 1, app: "zen", state: "running", mediaClass: "Stream/Input/Audio", mediaRole: undefined, live: true }]);
    expect(JSON.stringify(result)).not.toContain("Synthetic");
  });
});

describe("synthetic PipeWire graph delta and state coverage", () => {
  test("properties-only deltas preserve a running node and do not end the call", () => {
    const graph = new PipeWireGraph();
    const machine = new CallStateMachine(1_000, 1_000, 0);
    graph.apply([stream(1, binary("zen"))]);
    expect(machine.update(classifyCall(graph.values(), apps), 0)?.to).toBe("CANDIDATE");
    expect(machine.update(classifyCall(graph.values(), apps), 1_000)?.to).toBe("IN_CALL");
    graph.apply([{ id: 1, type: "PipeWire:Interface:Node", info: { props: { "node.description": "Synthetic updated label" } } }]);
    expect(graph.values()[0]?.info.state).toBe("running");
    expect(classifyCall(graph.values(), apps).active).toBe(true);
    expect(machine.update(classifyCall(graph.values(), apps), 2_000)).toBeNull();
    expect(machine.getSnapshot().state).toBe("IN_CALL");
  });

  test("explicit invalid or unknown state does not inherit running", () => {
    for (const state of [null, "", 123, false, "unknown"]) {
      const graph = new PipeWireGraph();
      graph.apply([stream(1, binary("zen"))]);
      graph.apply([{ id: 1, type: "PipeWire:Interface:Node", info: { state } }]);
      expect(classifyCall(graph.values(), apps).active).toBe(false);
      expect(graph.values()[0]?.info.state).toBe("unknown");
    }
  });

  test("explicit inactive state ends only after the configured timeout", () => {
    const graph = new PipeWireGraph();
    const machine = new CallStateMachine(1_000, 1_000, 0);
    graph.apply([stream(1, binary("slack"))]);
    machine.update(classifyCall(graph.values(), apps), 0);
    machine.update(classifyCall(graph.values(), apps), 1_000);
    graph.apply([{ id: 1, type: "PipeWire:Interface:Node", info: { state: "idle" } }]);
    expect(machine.update(classifyCall(graph.values(), apps), 2_000)?.to).toBe("ENDING");
    expect(machine.update(classifyCall(graph.values(), apps), 2_999)).toBeNull();
    expect(machine.update(classifyCall(graph.values(), apps), 3_000)?.to).toBe("IDLE");
  });

  test("null node removal and ID reuse do not retain previous application attribution", () => {
    for (const removal of [{ id: 1, type: null }, { id: 1, info: null }]) {
      const graph = new PipeWireGraph();
      graph.apply([stream(1, binary("zen"))]);
      expect(graph.apply([removal])).toBe(true);
      expect(graph.values()).toEqual([]);
      graph.apply([stream(1, binary("skype"))]);
      expect(classifyCall(graph.values(), apps).active).toBe(false);
    }
  });

  test("a state-free initial node fails closed instead of becoming running", () => {
    const graph = new PipeWireGraph();
    graph.apply([{ id: 1, type: "PipeWire:Interface:Node", info: { props: { ...binary("zen"), "media.class": "Stream/Input/Audio" } } }]);
    expect(classifyCall(graph.values(), apps).active).toBe(false);
    expect(parsePipeWireNode({ id: -1, type: "PipeWire:Interface:Node", info: {} })).toBeNull();
  });

  test("chunked monitor arrays preserve escaping and remove nodes", () => {
    const parser = new JsonValueStreamParser();
    const graph = new PipeWireGraph();
    const input = JSON.stringify([stream(1, binary("helium"), "Stream/Input/Audio", "running", { "node.description": 'Synthetic [label] "quoted" \\ value' })]);
    for (let offset = 0; offset < input.length; offset += 7) {
      for (const batch of parser.push(input.slice(offset, offset + 7))) graph.apply(batch);
    }
    expect(classifyCall(graph.values(), apps).app).toBe("helium");
    for (const batch of parser.push('\n[{"id":1,"info":null}]')) graph.apply(batch);
    expect(classifyCall(graph.values(), apps).active).toBe(false);
    expect(() => new JsonValueStreamParser().push('{"id":1}')).toThrow("unexpected JSON value");
  });

  test("changing the candidate app resets the entry debounce", () => {
    const machine = new CallStateMachine(1_000, 1_000, 0);
    const observe = (app: string) => classifyCall([stream(1, binary(app))], apps);
    machine.update(observe("slack"), 0);
    expect(machine.update(observe("zen"), 900)?.to).toBe("CANDIDATE");
    expect(machine.getNextDeadline()).toBe(1_900);
    expect(machine.update(observe("zen"), 1_000)).toBeNull();
    expect(machine.update(observe("zen"), 1_900)?.to).toBe("IN_CALL");
  });
});
