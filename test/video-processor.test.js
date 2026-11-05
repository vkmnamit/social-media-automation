import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { processVideo } from "../src/video/processor.js";

test("video processor creates a vertical H.264 output", async (t) => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
  } catch {
    t.skip("FFmpeg and FFprobe are required for this integration test");
    return;
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "autoreel-video-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputPath = path.join(root, "input.mp4");
  const outputPath = path.join(root, "edited", "output.mp4");
  await mkdir(path.dirname(outputPath));
  execFileSync("ffmpeg", [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x240:r=10",
    "-t",
    "1",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    inputPath,
  ]);

  const details = await processVideo({
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    inputPath,
    outputPath,
    maxOutputBytes: 16 * 1024 * 1024,
  });

  assert.equal(details.width, 1080);
  assert.equal(details.height, 1920);
  assert.ok(details.durationSeconds > 0);
  assert.ok((await lstat(outputPath)).size > 0);
});
