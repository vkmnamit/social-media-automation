import scheduleJob from "cron";
import { PublishingEngine } from "../publishing/engine.js";
import { RetryEngine } from "../retry/engine.js";

export class CronScheduler {
  constructor({
    repository,
    storage,
    config,
    engine,
    retryEngine,
    fetchImpl = fetch,
    now = () => new Date(),
  }) {
    this.repository = repository;
    this.storage = storage;
    this.config = config;
    this.engine = engine;
    this.retryEngine = retryEngine;
    this.fetch = fetchImpl;
    this.now = now;

    this.cronJob = null;
    this.running = false;
  }

  get scheduleExpression() {
    const interval = this.config?.cronSchedule || "0 * * * *";
    return interval;
  }

  start() {
    if (this.running) {
      return { started: false, reason: "Already running" };
    }

    const interval = this.scheduleExpression;
    this.cronJob = scheduleJob(interval, async () => {
      await this.runScheduledPublishing();
    });

    this.running = true;
    return { started: true, schedule: interval };
  }

  stop() {
    if (!this.running) {
      return { stopped: false, reason: "Not running" };
    }

    this.cronJob.stop();
    this.cronJob = null;
    this.running = false;

    return { stopped: true };
  }

  async runScheduledPublishing() {
    const results = {
      published: [],
      failed: [],
      skipped: [],
    };

    try {
      const queuedAssets = await this.repository.findQueuedAssets();
      results.skipped = queuedAssets.map((a) => ({
        assetId: a._id,
        reason: "Not processed yet",
      }));

      const processedAssets = queuedAssets.filter((a) => a.status === "processed");
      for (const asset of processedAssets) {
        try {
          const connection = await this.repository.getConnection(asset._id);
          if (!connection) {
            throw new Error("No connection found");
          }

          const platform = asset.platform || "youtube_shorts";
          const result = await this.engine.publishToPlatform(
            asset,
            platform,
            connection
          );

          const verification = await this.engine.verifyPublication(asset, result);
          const success = verification.verified || result.status === "published";

          if (success) {
            await this.engine.recordPublishResult(asset._id, result, true);
            await this.engine.cleanupLocalFiles(asset);

            results.published.push({
              assetId: asset._id,
              platform: result.platform,
              postId: result.postId,
              postUrl: verification.postUrl,
            });
          } else {
            throw new Error("Publication verification failed");
          }
        } catch (error) {
          results.failed.push({
            assetId: asset._id,
            platform: asset.platform,
            message: error.message,
            error: error.name,
            retryable: error.retryable ?? true,
          });

          await this.repository.markPublishingFailed(
            asset._id,
            error.message,
            error.retryable ?? true,
            this.now()
          );
        }
      }

      if (results.published.length > 0) {
        this.logStorageUsage();
      }
    } catch (error) {
      console.error("Scheduled publishing failed:", error);
    }

    return results;
  }

  async runRetryLoop() {
    try {
      const results = await this.retryEngine.runRetryLoop();
      if (results.published.length > 0) {
        this.logStorageUsage();
      }
      return results;
    } catch (error) {
      console.error("Retry loop failed:", error);
      return { published: [], failed: [], skipped: [] };
    }
  }

  async runCleanup() {
    try {
      return await this.repository.runCleanup(this.now());
    } catch (error) {
      console.error("Cleanup failed:", error);
      return { error: error.message };
    }
  }

  logStorageUsage() {
    if (!this.storage) return;
    this.storage.getStorageStatus()
      .then((status) => {
        if (status.overLimit) {
          console.warn("Storage limit exceeded:", status);
        } else {
          console.info("Storage usage:", status);
        }
      })
      .catch(() => {});
  }

  isRunning() {
    return this.running;
  }
}
