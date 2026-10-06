import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { acquireSingleton } from "../runtime/singleton";
import { runCommand } from "./command";
import { JobStore } from "./store";
import {
  type JobRecord,
  validateJobId,
  validateJobRecord
} from "./types";
import { getServiceLaunchCommand } from "../runtime/launcher";
import { transientCommand, transientUnitEnvironment } from "../runtime/systemd-units";

export type QueueSelectedJobResult = {
  id: string;
  status: "queued" | "completed" | "active";
  unit?: string;
  warning?: string;
};

export type QueueSelectedJobDependencies = {
  store?: Pick<JobStore, "get" | "update">;
  unitActive?: (id: string) => Promise<boolean>;
  run?: typeof runCommand;
};

const unitName = (id: string): string =>
  `recording-cli-job-${validateJobId(id)}.service`;

const launchCommand = (): string[] => getServiceLaunchCommand();

const defaultUnitActive = async (
  id: string,
  run: typeof runCommand
): Promise<boolean> => {
  const result = await run(
    "systemctl",
    ["--user", "show", unitName(id), "--property=ActiveState"],
    { timeoutMs: 5_000 }
  ).catch(() => ({ stdout: "", stderr: "" }));
  return /^ActiveState=(active|activating)$/m.test(result.stdout);
};

const readValidatedJob = async (
  store: Pick<JobStore, "get">,
  id: string
): Promise<JobRecord> => {
  try {
    return validateJobRecord(await store.get(id));
  } catch (error) {
    throw new Error("O job selecionado é inválido ou não está mais disponível.", {
      cause: error
    });
  }
};

export const queueSelectedJob = async (
  id: string,
  options: { retry?: boolean } = {},
  dependencies: QueueSelectedJobDependencies = {}
): Promise<QueueSelectedJobResult> => {
  try {
    validateJobId(id);
  } catch (error) {
    throw new Error("O identificador do job selecionado é inválido.", { cause: error });
  }
  const unit = unitName(id);
  const leaseName = `job-queue-${id}`;
  const lease = await acquireSingleton(leaseName).catch((error) => {
    if (error instanceof Error && error.message === `${leaseName} is already running`) {
      return null;
    }
    throw error;
  });
  if (!lease) return { id, status: "active", unit };

  try {
    const store = dependencies.store || new JobStore();
    const run = dependencies.run || runCommand;
    const job = await readValidatedJob(store, id);
    if (job.state === "completed") return { id, status: "completed" };
    if (await (dependencies.unitActive || ((jobId) => defaultUnitActive(jobId, run)))(id)) {
      return { id, status: "active", unit };
    }
    if (job.state === "processing") {
      return {
        id,
        status: "active",
        warning: "O job está marcado como em processamento, mas a execução em segundo plano não pôde ser confirmada. O estado foi preservado."
      };
    }
    if (job.state === "failed" && !options.retry) {
      throw new Error("O job falhou. Use a ação de tentar novamente para colocá-lo na fila.");
    }

    let retried = false;
    if (job.state === "failed") {
      await store.update(id, "pending");
      retried = true;
    }

    try {
      await run(
        "systemd-run",
        [
          "--user",
          `--unit=${unit}`,
          "--collect",
          "--property=Type=exec",
          "--property=Nice=10",
          "--property=RuntimeMaxSec=5400",
          "--property=TimeoutStopSec=30",
          "--property=UMask=0077",
          "--property=MemoryMax=2G",
          `--property=EnvironmentFile=-${join(homedir(), ".config/recording-cli/worker.env")}`,
          ...transientUnitEnvironment(),
          "--description=Process selected recording job",
          "--",
          ...transientCommand([...launchCommand(), "jobs", "process", id])
        ],
        { timeoutMs: 15_000 }
      );
    } catch (error) {
      if (retried) {
        await store.update(id, "failed", { error: job.error });
      }
      throw new Error("Não foi possível colocar o job selecionado na fila.", {
        cause: error
      });
    }
    return { id, status: "queued", unit };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("O ")) throw error;
    throw new Error("Não foi possível colocar o job selecionado na fila.", {
      cause: error
    });
  } finally {
    await lease.release();
  }
};
