import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFile = promisify(execFileCallback);
const PROCESS_TIMEOUT_MS = 15 * 60 * 1000;

function formatProcessError(error) {
  const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
  if (stderr) return stderr;
  if (error.signal) return `process was terminated by ${error.signal}`;
  if (error.code !== undefined) return `process exited with code ${error.code}`;
  return error.message;
}

async function probeVideo(ffprobePath, filePath) {
  const { stdout } = await execFile(
    ffprobePath,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,width,height",
      "-of",
      "json",
      filePath,
    ],
    { timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  const metadata = JSON.parse(stdout);
  const video = metadata.streams?.find((stream) => stream.codec_type === "video");
  const durationSeconds = Number(metadata.format?.duration);

  if (!video || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("The uploaded file does not contain a valid video stream");
  }

  return { durationSeconds, width: video.width, height: video.height };
}

export async function processVideo({
  ffmpegPath,
  ffprobePath,
  inputPath,
  outputPath,
  maxOutputBytes,
}) {
  const input = await probeVideo(ffprobePath, inputPath);
  try {
    await execFile(
      ffmpegPath,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-filter_threads",
        "1",
        "-y",
        "-i",
        inputPath,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-vf",
        "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
        "-c:v",
        "libx264",
        "-threads:v",
        "2",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        "-fs",
        String(maxOutputBytes),
        outputPath,
      ],
      { timeout: PROCESS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );
  } catch (error) {
    throw new Error(`FFmpeg transcoding failed: ${formatProcessError(error)}`, {
      cause: error,
    });
  }

  const output = await probeVideo(ffprobePath, outputPath);
  if (output.durationSeconds < input.durationSeconds - 1) {
    throw new Error(
      "The processed video exceeded the configured output-size limit; increase MAX_TRANSCODE_MB and retry",
    );
  }

  return {
    durationSeconds: output.durationSeconds,
    width: output.width,
    height: output.height,
  };
}

export function getAssetFilePath(storageDir, relativePath) {
  const root = path.resolve(storageDir);
  const filePath = path.resolve(root, relativePath);
  const relative = path.relative(root, filePath);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Asset path escapes the configured storage directory");
  }
  return filePath;
}
