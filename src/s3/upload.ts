import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { basename, extname } from "node:path";
import type { AppConfig } from "../config/defaults";

export type UploadResult = {
  success: boolean;
  message?: string;
};

const runAwsCommand = async (args: string[]): Promise<{ success: boolean; error?: string }> => {
  return new Promise((resolve) => {
    const aws = spawn("aws", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    
    aws.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    
    aws.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    aws.on("close", (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({ success: false, error: stderr || stdout });
      }
    });

    aws.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });
  });
};

export const uploadToS3 = async (
  config: AppConfig,
  localPath: string
): Promise<UploadResult> => {
  if (!config.s3.enabled) {
    return { success: false, message: "S3 upload is disabled" };
  }

  if (!config.s3.bucket) {
    return { success: false, message: "S3 bucket not configured" };
  }

  try {
    const stat = await fs.stat(localPath);
    const isDir = stat.isDirectory();
    const name = basename(localPath);
    const ext = extname(name);
    const folderName = isDir ? name : name.replace(ext, "");
    const s3Key = isDir 
      ? `${config.s3.prefix}${name}`
      : `${config.s3.prefix}${folderName}/video${ext}`;
    const s3Uri = `s3://${config.s3.bucket}/${s3Key}`;
    
    console.log(`Uploading ${name} to S3: ${s3Uri}`);

    const args = isDir
      ? ["s3", "sync", localPath, s3Uri, "--region", config.s3.region]
      : ["s3", "cp", localPath, s3Uri, "--region", config.s3.region];
    
    if (config.s3.profile) {
      args.push("--profile", config.s3.profile);
    }

    const result = await runAwsCommand(args);

    if (result.success) {
      if (isDir) {
        await fs.rm(localPath, { recursive: true });
      } else {
        await fs.unlink(localPath);
      }
      console.log(`✅ Upload completed and local ${isDir ? "folder" : "file"} deleted: ${name}`);
      console.log(`📍 S3 location: ${s3Uri}`);
      return { success: true };
    } else {
      return { success: false, message: result.error };
    }
  } catch (err) {
    return { 
      success: false, 
      message: err instanceof Error ? err.message : String(err) 
    };
  }
};
