import { randomUUID } from "node:crypto";
import { PublishingError } from "../publishing/engine.js";
import { ExponentialBackoff, retryWithBackoff } from "../util/retry.js";

export class RetryEngine {
  constructor({ repository, config, fetchImpl = fetch, now = () => new Date() }) {
    this.repository = repository;
    this.config = config;
    this.fetch = fetchImpl;
    this.now = now;

    this.backoff = new ExponentialBackoff({
      initialDelayMs: config?.retryInitialDelayMs ?? 30000,
      maxDelayMs: config?.retryMaxDelayMs ?? 300000,
      maxAttempts: config?.retryMaxAttempts ?? 5,
    });
  }

  async getRetryableAssets(shouldRetry = true) {
    return this.repository.findRetryableAssets(shouldRetry);
  }

  async queueExpiredFailures(cutoff, queuedAt) {
    return this.repository.queueExpiredFailures(cutoff, queuedAt);
  }

  async processAsset(asset) {
    const { _id, platform, retryCount } = asset;

    const publisher = this.getPublisherForPlatform(platform);
    if (!publisher) {
      return { assetId: _id, status: "skipped", reason: "No publisher for platform" };
    }

    try {
      const connection = await this.repository.getConnection(assetId);
      if (!connection) {
        throw new PublishingError(`No connection found for asset ${_id}`, platform, 400);
      }

      const result = await retryWithBackoff(
        () => publisher.publishToPlatform(asset, platform, connection),
        this.backoff,
        { assetId: _id, platform, attempt: retryCount + 1 }
      );

      await this.repository.markPublished(assetId, {
        platform,
        postId: result.postId,
        caption: result.caption,
        hashtagString: result.hashtagString,
        publishedAt: result.publishedAt,
      }, result.publishedAt);

      return {
        assetId: _id,
        platform,
        postId: result.postId,
        status: "published",
      };
    } catch (error) {
      if (error instanceof PublishingError) {
        await this.repository.markPublishingFailed(
          _id,
          error.message,
          error.retryable,
          this.now()
        );
        return {
          assetId: _id,
          platform,
          message: error.message,
          status: "failed",
          retryable: error.retryable,
        };
      }

      await this.repository.markPublishingFailed(
        _id,
        `Unexpected error: ${error.message}`,
        true,
        this.now()
      );
      return {
        assetId: _id,
        platform,
        message: `Unexpected error: ${error.message}`,
        status: "failed",
        retryable: true,
      };
    }
  }

  getPublisherForPlatform(platform) {
    switch (platform) {
      case "instagram":
        return "instagram";
      case "facebook":
        return "facebook";
      case "youtube":
        return "youtube";
      case "youtube_shorts":
        return "youtube_shorts";
      default:
        return null;
    }
  }

  async runRetryLoop() {
    const results = {
      published: [],
      failed: [],
      skipped: [],
    };

    const assets = await this.repository.findRetryableAssets(true);
    for (const asset of assets) {
      const result = await this.processAsset(asset);
      if (result.status === "published") {
        results.published.push(result);
      } else {
        results.failed.push(result);
      }
    }

    return results;
  }

  async retryFailedAssets() {
    const assets = await this.repository.findRetryableAssets(true);
    const results = [];

    for (const asset of assets) {
      try {
        const result = await this.processAsset(asset);
        results.push(result);
        if (result.status === "published") {
          break;
        }
      } catch (error) {
        results.push({
          assetId: asset._id,
          platform: asset.platform,
          message: error.message,
          status: "failed",
          retryable: true,
        });
      }
    }

    return results;
  }
}
