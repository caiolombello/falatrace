import { spawn } from "node:child_process";
import type { AppConfig } from "../config/defaults";
import { launchRecordingPlayer } from "../player/launcher";

const runAwsCommand = (args: string[]): Promise<string> => {
  return new Promise((resolve, reject) => {
    const aws = spawn("aws", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    aws.stdout?.on("data", (d) => (stdout += d));
    aws.stderr?.on("data", (d) => (stderr += d));
    aws.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr || stdout))));
    aws.on("error", reject);
  });
};

export const listVideos = async (config: AppConfig): Promise<string[]> => {
  const args = ["s3", "ls", `s3://${config.s3.bucket}/${config.s3.prefix}`, "--region", config.s3.region];
  if (config.s3.profile) args.push("--profile", config.s3.profile);
  
  const output = await runAwsCommand(args);
  return output
    .split("\n")
    .map((line) => line.trim().split(/\s+/).slice(3).join(" "))
    .filter((f) => /\.(mp4|mkv|webm|mov|avi)$/i.test(f));
};

export const getPresignedUrl = async (config: AppConfig, key: string): Promise<string> => {
  const s3Uri = `s3://${config.s3.bucket}/${config.s3.prefix}${key}`;
  const args = ["s3", "presign", s3Uri, "--expires-in", "3600", "--region", config.s3.region];
  if (config.s3.profile) args.push("--profile", config.s3.profile);
  
  return (await runAwsCommand(args)).trim();
};

export const playWithPlayer = (url: string): Promise<void> =>
  launchRecordingPlayer(url, { title: "FalaTrace · S3" });
