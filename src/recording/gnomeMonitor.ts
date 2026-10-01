import { spawn } from "node:child_process";

export const monitorGnomeErrors = (): void => {
  const args = [
    "monitor",
    "--session",
    "--dest",
    "org.gnome.Shell.Screencast",
    "--object-path",
    "/org/gnome/Shell/Screencast"
  ];

  const child = spawn("gdbus", args, { stdio: "inherit" });
  child.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("gdbus not found. Install libglib2.0-bin.");
    } else {
      console.error("Failed to start gdbus monitor:", err.message);
    }
  });
};
