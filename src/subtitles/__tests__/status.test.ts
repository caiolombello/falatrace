import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { subtitleUnitStatus } from "../status";

describe("subtitle operation uncertainty", () => {
  test("a collected unit never proves generation completion", () => {
    const result = subtitleUnitStatus("LoadState=not-found\nActiveState=inactive\nResult=success\n");
    expect(result.state).toBe("unknown");
    expect(result.message).toContain("estado da solicitação está indisponível");
    expect(result.message).not.toContain("terminou");
  });

  test("failed inspection is uncertainty, not a worker failure", () => {
    expect(subtitleUnitStatus(undefined).state).toBe("unknown");
    expect(subtitleUnitStatus("").state).toBe("unknown");
    expect(subtitleUnitStatus("ActiveState=inactive\n").state).toBe("unknown");
  });

  test("known running and failed states remain distinct", () => {
    for (const active of ["active", "activating", "reloading"]) {
      expect(subtitleUnitStatus(`ActiveState=${active}\n`).state).toBe("running");
    }
    expect(subtitleUnitStatus("ActiveState=failed\n").state).toBe("failed");
  });

  test("Qt response releases its pending flag for an uncertain completed request", () => {
    const qml = readFileSync(new URL("../../desktop/Main.qml", import.meta.url), "utf8");
    const line = qml.split("\n").find(value => value.includes('subtitleQueued && ["idle", "failed", "unknown"]'))!;
    expect(line).toBeDefined();
    const context = { subtitleQueued: true, notice: "aguardando", errorText: "", result: { subtitleState: "unknown", subtitleMessage: subtitleUnitStatus().message } };
    const execute = new Function("context", `with(context) { if ${line.trim().slice("else if ".length)} }`);
    execute(context);
    expect(context.subtitleQueued).toBe(false);
    expect(context.notice).toBe("");
    expect(context.errorText).toBe(subtitleUnitStatus().message!);
  });
});
