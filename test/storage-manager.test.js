import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deleteLocalFile, getStorageUsage } from "../src/storage/local-files.js";
import { StorageLimitError, StorageManager } from "../src/storage/manager.js";
import { SupabaseAssetRepository } from "../src/storage/supabase-repository.js";

class MemoryRepository {
  constructor(assets) {
    this.assets = assets;
  }

  async releaseStaleCleanupClaims() {}

  async queueExpiredFailures(cutoff, queuedAt) {
    let count = 0;
    for (const asset of this.assets) {
      if (asset.status === "upload_failed" && asset.failedAt <= cutoff) {
        asset.status = "recovery";
        asset.recoveryQueuedAt = queuedAt;
        count += 1;
      }
    }
    return count;
  }

  async findCleanupCandidates(temporaryCutoff, publishedCutoff) {
    return this.assets.filter(
      (asset) =>
        asset.localPath &&
        ((asset.kind === "temporary" &&
          asset.status === "processed" &&
          asset.processedAt <= temporaryCutoff) ||
          (["original", "edited"].includes(asset.kind) &&
            asset.status === "published" &&
            asset.publishedAt <= publishedCutoff)),
    );
  }

  async claimForCleanup(asset) {
    if (asset.status === "cleaning") {
      return false;
    }
    asset.previousStatus = asset.status;
    asset.status = "cleaning";
    return true;
  }

  async markCleaned(assetId, cleanedAt) {
    const asset = this.assets.find((entry) => entry._id === assetId);
    if (asset?.status !== "cleaning") {
      return false;
    }
    asset.status = "cleaned";
    asset.localPath = null;
    asset.cleanedAt = cleanedAt;
    return true;
  }

  async releaseCleanupClaim(assetId, previousStatus) {
    const asset = this.assets.find((entry) => entry._id === assetId);
    if (asset?.status === "cleaning") {
      asset.status = previousStatus;
    }
  }
}

test("cleanup deletes eligible published and processed files, but preserves failed files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoreel-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = new Date("2026-01-03T00:00:00Z");
  const old = new Date("2026-01-01T00:00:00Z");
  const recent = new Date("2026-01-02T18:00:00Z");

  await writeFile(path.join(root, "published.mp4"), "published");
  await writeFile(path.join(root, "temporary.mp4"), "temporary");
  await writeFile(path.join(root, "failed.mp4"), "failed");
  await writeFile(path.join(root, "recent.mp4"), "recent");

  const repository = new MemoryRepository([
    {
      _id: "published",
      kind: "edited",
      status: "published",
      localPath: "published.mp4",
      publishedAt: old,
    },
    {
      _id: "temporary",
      kind: "temporary",
      status: "processed",
      localPath: "temporary.mp4",
      processedAt: old,
    },
    {
      _id: "failed",
      kind: "edited",
      status: "upload_failed",
      localPath: "failed.mp4",
      failedAt: old,
    },
    {
      _id: "recent",
      kind: "original",
      status: "published",
      localPath: "recent.mp4",
      publishedAt: recent,
    },
  ]);
  const manager = new StorageManager({
    repository,
    storageDir: root,
    maxStorageBytes: 1024,
    retention: {
      temporaryMs: 60 * 60 * 1000,
      publishedMs: 24 * 60 * 60 * 1000,
      failedMs: 48 * 60 * 60 * 1000,
    },
    logger: { info() {}, error() {} },
  });

  const result = await manager.runCleanup(now);

  assert.deepEqual(result, { deleted: 2, movedToRecovery: 1 });
  await assert.rejects(readFile(path.join(root, "published.mp4")), {
    code: "ENOENT",
  });
  await assert.rejects(readFile(path.join(root, "temporary.mp4")), {
    code: "ENOENT",
  });
  assert.equal(await readFile(path.join(root, "failed.mp4"), "utf8"), "failed");
  assert.equal(await readFile(path.join(root, "recent.mp4"), "utf8"), "recent");
  assert.equal(repository.assets.find((asset) => asset._id === "failed").status, "recovery");
});

test("storage usage and concurrent reservations respect the configured capacity", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoreel-capacity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "nested", "clip.mp4"), "12345");

  assert.equal(await getStorageUsage(root), 5);
  const manager = new StorageManager({
    repository: new MemoryRepository([]),
    storageDir: root,
    maxStorageBytes: 8,
    retention: { temporaryMs: 1, publishedMs: 1, failedMs: 1 },
  });
  await assert.rejects(manager.reserveCapacity(4), StorageLimitError);
  const reservations = await Promise.allSettled([
    manager.reserveCapacity(3),
    manager.reserveCapacity(1),
  ]);
  const fulfilled = reservations.filter((result) => result.status === "fulfilled");
  const rejected = reservations.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason instanceof StorageLimitError);
  const reservation = fulfilled[0].value;
  assert.equal(reservation.usedBytes, 5);
  assert.equal(reservation.availableBytes, 0);
  manager.releaseCapacity(reservation.reservationId);
  assert.throws(
    () => manager.releaseCapacity(reservation.reservationId),
    /Unknown storage capacity reservation/,
  );
});

test("local deletion rejects traversal and does not follow directory symlinks", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoreel-paths-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "autoreel-outside-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await writeFile(path.join(outside, "keep.mp4"), "keep");
  await symlink(outside, path.join(root, "external"));

  await assert.rejects(deleteLocalFile(root, "../keep.mp4"), /escapes/);
  await assert.rejects(
    deleteLocalFile(root, "external/keep.mp4"),
    /resolves outside/,
  );
  assert.equal(await readFile(path.join(outside, "keep.mp4"), "utf8"), "keep");
});

test("recovery assets can transition back to publishing for retry", async () => {
  let update;
  const repository = new SupabaseAssetRepository({
    async rpc(name, args) {
      update = { name, args };
      return { data: true, error: null };
    },
  });

  assert.equal(await repository.startPublishing("recovered-asset"), true);
  assert.equal(update.name, "autoreel_patch_asset");
  assert.equal(update.args.p_id, "recovered-asset");
  assert.deepEqual(update.args.p_expected_statuses, [
    "processed",
    "upload_failed",
    "recovery",
  ]);
  assert.equal(update.args.p_patch.recoveryQueuedAt, null);
});
