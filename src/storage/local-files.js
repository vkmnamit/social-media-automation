import { lstat, mkdir, readdir, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";

function isWithin(parent, candidate) {
  return candidate.startsWith(`${parent}${path.sep}`);
}

async function getRoot(storageDir) {
  await mkdir(storageDir, { recursive: true });
  return realpath(storageDir);
}

async function resolveManagedFile(storageDir, relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\0")
  ) {
    throw new Error("Asset path must be a non-empty relative path");
  }

  const root = await getRoot(storageDir);
  const target = path.resolve(root, relativePath);
  if (!isWithin(root, target)) {
    throw new Error("Asset path escapes the configured storage directory");
  }

  try {
    const parent = await realpath(path.dirname(target));
    if (parent !== root && !isWithin(root, parent)) {
      throw new Error("Asset path resolves outside the configured storage directory");
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  return target;
}

export async function deleteLocalFile(storageDir, relativePath) {
  const target = await resolveManagedFile(storageDir, relativePath);

  try {
    const details = await lstat(target);
    if (details.isDirectory()) {
      throw new Error("Refusing to delete a directory as a video asset");
    }
    await unlink(target);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

export async function getLocalFile(storageDir, relativePath) {
  const target = await resolveManagedFile(storageDir, relativePath);
  const root = await getRoot(storageDir);
  const details = await lstat(target);
  if (!details.isFile()) {
    throw new Error("Asset is not a regular local video file");
  }
  const parent = await realpath(path.dirname(target));
  if (parent !== root && !isWithin(root, parent)) {
    throw new Error("Asset path resolves outside the configured storage directory");
  }
  return { path: target, size: (await stat(target)).size };
}

export async function getStorageUsage(storageDir) {
  const root = await getRoot(storageDir);

  async function totalBytes(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    let total = 0;

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        total += await totalBytes(fullPath);
      } else if (entry.isFile()) {
        total += (await lstat(fullPath)).size;
      }
    }

    return total;
  }

  return totalBytes(root);
}
