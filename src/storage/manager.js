import { randomUUID } from "node:crypto";
import { deleteLocalFile, getStorageUsage } from "./local-files.js";

export class StorageLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "StorageLimitError";
  }
}

export class StorageManager {
  constructor({ repository, storageDir, maxStorageBytes, retention, logger = console }) {
    this.repository = repository;
    this.storageDir = storageDir;
    this.maxStorageBytes = maxStorageBytes;
    this.retention = retention;
    this.logger = logger;
    this.cleanupRunning = false;
    this.reservedBytes = 0;
    this.capacityReservations = new Map();
    this.capacityQueue = Promise.resolve();
  }

  async registerAsset({
    relativePath,
    kind,
    originalName,
    caption = "",
    hashtags = [],
  }) {
    if (!["original", "edited", "temporary"].includes(kind)) {
      throw new Error(`Unsupported asset kind: ${kind}`);
    }
    if (!relativePath) {
      throw new Error("relativePath is required");
    }

    const asset = {
      assetId: randomUUID(),
      kind,
      localPath: relativePath,
      originalName,
      caption,
      hashtags,
      posts: [],
      status: "processing",
      createdAt: new Date(),
    };
    await this.repository.addAsset(asset);
    return asset.assetId;
  }

  async reserveCapacity(incomingBytes) {
    if (!Number.isSafeInteger(incomingBytes) || incomingBytes < 0) {
      throw new Error("incomingBytes must be a non-negative safe integer");
    }

    let unlock;
    const previousReservation = this.capacityQueue;
    this.capacityQueue = new Promise((resolve) => {
      unlock = resolve;
    });
    await previousReservation;

    try {
      const usedBytes = await getStorageUsage(this.storageDir);
      if (usedBytes + this.reservedBytes + incomingBytes > this.maxStorageBytes) {
        throw new StorageLimitError(
          `Storage limit reached: ${usedBytes} bytes used, ${this.reservedBytes} bytes reserved, ${incomingBytes} bytes requested, ${this.maxStorageBytes} bytes allowed`,
        );
      }

      const reservationId = randomUUID();
      this.reservedBytes += incomingBytes;
      this.capacityReservations.set(reservationId, incomingBytes);
      return {
        reservationId,
        usedBytes,
        availableBytes: this.maxStorageBytes - usedBytes - this.reservedBytes,
      };
    } finally {
      unlock();
    }
  }

  releaseCapacity(reservationId) {
    const reservedBytes = this.capacityReservations.get(reservationId);
    if (reservedBytes === undefined) {
      throw new Error(`Unknown storage capacity reservation: ${reservationId}`);
    }

    this.capacityReservations.delete(reservationId);
    this.reservedBytes -= reservedBytes;
  }

  async getStorageStatus() {
    const usedBytes = await getStorageUsage(this.storageDir);
    return {
      usedBytes,
      limitBytes: this.maxStorageBytes,
      availableBytes: Math.max(0, this.maxStorageBytes - usedBytes),
      overLimit: usedBytes > this.maxStorageBytes,
    };
  }

  async markProcessingComplete(assetId, processedAt) {
    return this.repository.markProcessingComplete(assetId, processedAt);
  }

  async startPublishing(assetId) {
    return this.repository.startPublishing(assetId);
  }

  async markPublished(assetId, post, publishedAt) {
    if (!post?.platform || !post?.postId) {
      throw new Error("A confirmed platform and postId are required");
    }
    return this.repository.markPublished(assetId, post, publishedAt);
  }

  async markUploadFailed(assetId, message, failedAt) {
    if (!message) {
      throw new Error("A failure message is required");
    }
    return this.repository.markUploadFailed(assetId, message, failedAt);
  }

  async runCleanup(now = new Date()) {
    if (this.cleanupRunning) {
      return { skipped: true, reason: "Cleanup is already running" };
    }
    this.cleanupRunning = true;

    try {
      const temporaryCutoff = new Date(
        now.getTime() - this.retention.temporaryMs,
      );
      const publishedCutoff = new Date(
        now.getTime() - this.retention.publishedMs,
      );
      const failedCutoff = new Date(now.getTime() - this.retention.failedMs);

      await this.repository.releaseStaleCleanupClaims(temporaryCutoff);
      const recoveryCount = await this.repository.queueExpiredFailures(
        failedCutoff,
        now,
      );
      const assets = await this.repository.findCleanupCandidates(
        temporaryCutoff,
        publishedCutoff,
      );
      const errors = [];
      let deleted = 0;

      for (const asset of assets) {
        const claimed = await this.repository.claimForCleanup(asset);
        if (!claimed) {
          continue;
        }

        try {
          const localPaths = asset.localPaths?.length
            ? asset.localPaths
            : [asset.localPath];
          for (const localPath of localPaths) {
            await deleteLocalFile(this.storageDir, localPath);
          }
          const marked = await this.repository.markCleaned(asset._id, now);
          if (!marked) {
            throw new Error(`Could not record cleanup for asset ${asset._id}`);
          }
          deleted += 1;
          this.logger.info?.("Deleted expired local video", {
            assetId: asset._id,
            kind: asset.kind,
          });
        } catch (error) {
          await this.repository.releaseCleanupClaim(asset._id, asset.status);
          errors.push(error);
          this.logger.error?.("Failed to clean up local video", {
            assetId: asset._id,
            error,
          });
        }
      }

      if (errors.length > 0) {
        throw new AggregateError(errors, "One or more video files could not be cleaned up");
      }
      return { deleted, movedToRecovery: recoveryCount };
    } finally {
      this.cleanupRunning = false;
    }
  }
}
