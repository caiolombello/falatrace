import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../config/defaults";
import { writeJsonAtomic } from "../jobs/store";
import { inspectCallEnvironment } from "./inspect";
import { readCallStatus } from "./status";

export type ValidationScenario = "app-open" | "in-call" | "ended";

export type ValidationSnapshot = {
  version: 1;
  session: string;
  scenario: ValidationScenario;
  capturedAt: string;
  environment: Record<string, unknown>;
  monitorStatus: unknown;
};

const scenarios: ValidationScenario[] = ["app-open", "in-call", "ended"];

const validateSession = (session: string): string => {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(session)) {
    throw new Error("Validation session must contain only letters, numbers, underscores, and dashes");
  }
  return session;
};

export const validateScenario = (value: string): ValidationScenario => {
  if (!scenarios.includes(value as ValidationScenario)) {
    throw new Error(`Validation scenario must be one of: ${scenarios.join(", ")}`);
  }
  return value as ValidationScenario;
};

const defaultValidationRoot = (): string =>
  join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
    "recording-cli",
    "validation"
  );

export const writeValidationSnapshot = async (
  snapshot: ValidationSnapshot,
  root = defaultValidationRoot()
): Promise<string> => {
  validateSession(snapshot.session);
  validateScenario(snapshot.scenario);
  const directory = join(root, snapshot.session);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${snapshot.scenario}.json`);
  await writeJsonAtomic(path, snapshot);
  return path;
};

export const captureValidationSnapshot = async (
  config: AppConfig,
  session: string,
  scenario: ValidationScenario
): Promise<string> =>
  writeValidationSnapshot({
    version: 1,
    session: validateSession(session),
    scenario,
    capturedAt: new Date().toISOString(),
    environment: await inspectCallEnvironment(config),
    monitorStatus: await readCallStatus()
  });

const observedActive = (snapshot: ValidationSnapshot): boolean | null => {
  const pipewire = snapshot.environment.pipewire;
  if (typeof pipewire !== "object" || pipewire === null) return null;
  const observation = (pipewire as Record<string, unknown>).observation;
  if (typeof observation !== "object" || observation === null) return null;
  const active = (observation as Record<string, unknown>).active;
  return typeof active === "boolean" ? active : null;
};

export const buildValidationReport = (snapshots: ValidationSnapshot[]): Record<string, unknown> => {
  const byScenario = new Map(snapshots.map((snapshot) => [snapshot.scenario, snapshot]));
  const checks = scenarios.map((scenario) => {
    const snapshot = byScenario.get(scenario);
    const observed = snapshot ? observedActive(snapshot) : null;
    const expected = scenario === "in-call";
    return {
      scenario,
      captured: Boolean(snapshot),
      expectedActive: expected,
      observedActive: observed,
      passed: observed === null ? null : observed === expected
    };
  });
  return {
    session: snapshots[0]?.session,
    complete: checks.every((check) => check.captured),
    passed: checks.every((check) => check.passed === true),
    checks
  };
};

export const readValidationSession = async (
  session: string,
  root = defaultValidationRoot()
): Promise<ValidationSnapshot[]> => {
  validateSession(session);
  const snapshots: ValidationSnapshot[] = [];
  for (const scenario of scenarios) {
    try {
      const value = JSON.parse(
        await fs.readFile(join(root, session, `${scenario}.json`), "utf-8")
      ) as ValidationSnapshot;
      if (
        value.version !== 1 ||
        value.session !== session ||
        value.scenario !== scenario ||
        typeof value.environment !== "object" ||
        value.environment === null
      ) {
        throw new Error(`Invalid validation snapshot: ${scenario}`);
      }
      snapshots.push(value);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return snapshots;
};
