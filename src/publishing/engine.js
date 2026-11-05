import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";


export { ExponentialBackoff } from "../util/retry.js";

export class PlatformPublishError extends Error {
  constructor(message, platform, statusCode = 500, retryable = true) {
    super(message);
    this.name = "PlatformPublishError";
    this.platform = platform;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

export class PlatformConnectionError extends PlatformPublishError {
  constructor(message, platform) {
    super(message, platform, 400, false);
    this.name = "PlatformConnectionError";
  }
}

export class PlatformPublisher {
  get platformName() {
    return "base";
  }

  get requiredScopes() {
    return [];
  }

  async validateConnection(connection) {
    return true;
  }

  async uploadMedia(asset) {
    return { assetId: asset?._id, localPath: asset?.localPath || "" };
  }

  async resolveCredentials(asset) {
    throw new PlatformPublishError("No credentials available", "base", 400);
  }

  async publishPost(asset, { post, publishedAt } = {}) {
    throw new PlatformPublishError("publishPost is not implemented", this.platformName, 501);
  }
}

export function validateVideoType(type) {
  if (typeof type !== "string") return false;
  const normalized = type.trim().toLowerCase();
  return ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"].includes(normalized);
}

export function validateVideoSize(size, maxBytes) {
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return false;
  if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes) || maxBytes <= 0) return false;
  return size <= maxBytes;
}

export const PUBLISH_FLOW_STAGES = ["queued", "verifying", "publishing", "published", "failed"];

export class PublishingError extends Error {
  constructor(message, platform, statusCode, retryable = false) {
    super(message);
    this.name = "PublishingError";
    this.platform = platform;
    this.statusCode = statusCode ?? null;
    this.retryable = retryable;
  }
}

export class PublishingEngine {
  constructor({ repository, storage, config, fetchImpl = fetch, now = () => new Date() }) {
    this.repository = repository;
    this.storage = storage;
    this.config = config;
    this.fetch = fetchImpl;
    this.now = now;

    this.publishers = null;
  }

  async ensurePublishers() {
    if (this.publishers) {
      return this.publishers;
    }
    const [instagram, facebook, youtube, shorts] = await Promise.all([
      import("./instagram.js"),
      import("./facebook.js"),
      import("./youtube.js"),
      import("./youtube-shorts.js"),
    ]);
    this.publishers = {
      instagram: new instagram.InstagramPublisher({
        config: this.config,
        storageClient: this.repository.client,
        fetchImpl: this.fetch,
        now: this.now,
      }),
      facebook: new facebook.FacebookPublisher({ config: this.config, fetchImpl: this.fetch, now: this.now }),
      youtube: new youtube.YouTubePublisher({ config: this.config, fetchImpl: this.fetch, now: this.now }),
      youtube_shorts: new shorts.YouTubeShortsPublisher({ config: this.config, fetchImpl: this.fetch, now: this.now }),
    };
    return this.publishers;
  }

  async getConnection(asset) {
    if (asset?.connection) {
      return asset.connection;
    }
    return null;
  }

  async validatePublisher(publisher, connection) {
    if (connection) {
      await publisher.validateConnection(connection);
    }
  }

  async publishToPlatform(asset, platform, connection, options = {}) {
    const publisher = (await this.ensurePublishers())[platform];
    if (!publisher) {
      throw new PublishingError(
        `Unsupported platform: ${platform}`,
        platform,
        400
      );
    }

    await this.validatePublisher(publisher, connection);

    const result = await this.performPublish(
      publisher,
      { ...asset, status: "publishing", connection },
      {
        post: options.post,
        publishedAt: options.publishedAt,
      },
    );

    return result;
  }

  async verifyPublication(asset, result) {
    const publisher =
      (await this.ensurePublishers())[result?.platform || asset?.platform];
    if (!publisher?.verifyPublication) {
      return { verified: Boolean(result?.postId), postUrl: result?.postUrl || null };
    }
    return publisher.verifyPublication(asset, result);
  }

  async performPublish(publisher, asset, { post, publishedAt }) {
    const startTime = this.now();

    try {
      const media = await publisher.uploadMedia(asset);
      const publishResult = await publisher.publishPost(asset, {
        post,
        publishedAt: publishedAt || new Date(),
        media,
      });

      const durationMs = this.now().getTime() - startTime.getTime();

      return {
        ...publishResult,
        assetId: asset._id,
        durationMs,
        platform: publisher.platformName,
      };
    } catch (error) {
      if (error instanceof PublishingError) {
        throw error;
      }
      throw new PublishingError(
        `Publishing failed: ${error.message}`,
        publisher.platformName,
        null,
        error.retryable ?? true
      );
    }
  }

  async cleanupLocalFiles(asset) {
    if (asset?.localPaths?.length) {
      for (const localPath of asset.localPaths) {
        try {
          await fs.unlink(path.resolve(this.config.storageDir, localPath));
        } catch (error) {
          if (error.code !== "ENOENT") {
            throw error;
          }
        }
      }
      await this.repository.updateAssetLocalPaths(
        asset._id,
        { localPath: null, localPaths: [] }
      );
    }
  }

  async recordPublishResult(assetId, result, success) {
    await this.repository.markPublished(assetId, {
      platform: result.platform,
      postId: result.postId,
      caption: result.caption,
      hashtagString: result.hashtagString,
      publishedAt: result.publishedAt,
    }, result.publishedAt);
  }

  async determinePlatform(asset) {
    switch (asset.platform) {
      case "instagram":
        return "instagram";
      case "facebook":
        return "facebook";
      case "youtube":
        return "youtube";
      case "youtube_shorts":
        return "youtube_shorts";
      default:
        return "youtube_shorts";
    }
  }

  async retryPublish(assetId) {
    const asset = await this.repository.getAsset(assetId);
    if (!asset) {
      throw new PublishingError(`Asset not found: ${assetId}`, "unknown", 404);
    }

    const connection = await this.getConnection(asset);
    if (!connection) {
      throw new PublishingError(`No connection found for asset ${assetId}`, "unknown", 400);
    }

    const platform = this.determinePlatform(asset);
    if (!platform) {
      throw new PublishingError(`No publishing platform determined for asset ${assetId}`, "unknown", 400);
    }

    const publisher = this.publishers[platform];
    if (!publisher) {
      throw new PublishingError(`No publisher for platform ${platform}`, platform, 500);
    }

    return await this.publishToPlatform(asset, platform, connection);
  }
}
