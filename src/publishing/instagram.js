import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { getLocalFile } from "../storage/local-files.js";
import { TokenVault } from "../oauth/token-vault.js";
import {
  PlatformConnectionError,
  PlatformPublishError,
  PlatformPublisher,
} from "./engine.js";

const SIGNED_URL_SECONDS = 24 * 60 * 60;
const MAX_CONTAINER_POLLS = 24;
const CONTAINER_POLL_INTERVAL_MS = 5000;

async function responseJson(response, action) {
  let result;
  try {
    result = await response.json();
  } catch {
    throw new PlatformPublishError(
      `Instagram ${action} returned an invalid response`,
      "instagram",
      response.status,
    );
  }
  if (!response.ok || result.error) {
    const message = result.error?.message || `HTTP ${response.status}`;
    throw new PlatformPublishError(
      `Instagram ${action} failed: ${message}`,
      "instagram",
      response.status,
    );
  }
  return result;
}

export class InstagramPublisher extends PlatformPublisher {
  constructor({ config, storageClient, fetchImpl = fetch, now = () => new Date(), wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), logger = console }) {
    super();
    this.config = config;
    this.storageClient = storageClient;
    this.fetch = fetchImpl;
    this.now = now;
    this.wait = wait;
    this.logger = logger;
    this.vault = new TokenVault(config.tokenEncryptionKey);
  }

  get platformName() {
    return "instagram";
  }

  get requiredScopes() {
    return [
      "instagram_basic",
      "instagram_content_publish",
      "pages_show_list",
      "pages_manage_posts",
    ];
  }

  async validateConnection(connection) {
    if (!connection?.accountId || connection.platform !== "instagram") {
      throw new PlatformConnectionError(
        "A connected Instagram professional account is required",
        "instagram",
      );
    }
    if (!connection.encryptedAccessToken) {
      throw new PlatformConnectionError(
        "The Instagram account has no encrypted access token",
        "instagram",
      );
    }
    try {
      this.vault.decrypt(connection.encryptedAccessToken);
    } catch {
      throw new PlatformConnectionError(
        "The saved Instagram token cannot be decrypted; reconnect the account",
        "instagram",
      );
    }
    return true;
  }

  async resolveCredentials(connection) {
    await this.validateConnection(connection);
    return {
      accessToken: this.vault.decrypt(connection.encryptedAccessToken),
      instagramUserId: connection.accountId,
    };
  }

  async ensurePrivateBucket() {
    if (!this.storageClient) {
      throw new PlatformPublishError(
        "Supabase Storage is required to provide Instagram with a temporary video URL",
        "instagram",
        503,
        false,
      );
    }
    const bucket = this.config.supabaseMediaBucket;
    const listed = await this.storageClient.storage.listBuckets();
    if (listed.error) {
      throw new PlatformPublishError(
        `Could not check Supabase Storage buckets: ${listed.error.message}`,
        "instagram",
        502,
      );
    }
    const existing = listed.data.find((item) => item.name === bucket);
    if (existing) {
      if (existing.public) {
        throw new PlatformPublishError(
          `Supabase bucket "${bucket}" must be private`,
          "instagram",
          500,
          false,
        );
      }
      return bucket;
    }

    const created = await this.storageClient.storage.createBucket(bucket, {
      public: false,
    });
    if (created.error) {
      throw new PlatformPublishError(
        `Could not create private Supabase bucket "${bucket}": ${created.error.message}`,
        "instagram",
        502,
      );
    }
    return bucket;
  }

  async removeTemporaryObject(storage, objectPath, assetId) {
    try {
      const removed = await storage.remove([objectPath]);
      if (removed.error) {
        throw new Error(removed.error.message);
      }
    } catch (error) {
      this.logger.error?.("Could not remove temporary Instagram media from Supabase Storage", {
        assetId,
        error: error.message,
      });
    }
  }

  async uploadMedia(asset) {
    if (asset.kind !== "edited" || asset.status !== "publishing") {
      throw new PlatformPublishError(
        "Only a processed video can be sent to Instagram",
        "instagram",
        409,
        false,
      );
    }
    const file = await getLocalFile(this.config.storageDir, asset.localPath);
    const bucket = await this.ensurePrivateBucket();
    const objectPath = `${asset._id}/${randomUUID()}.mp4`;
    const storage = this.storageClient.storage.from(bucket);
    const uploaded = await storage.upload(
      objectPath,
      createReadStream(file.path),
      {
        contentType: "video/mp4",
        cacheControl: "3600",
        upsert: false,
      },
    );
    if (uploaded.error) {
      throw new PlatformPublishError(
        `Could not upload the processed video to temporary Supabase Storage: ${uploaded.error.message}`,
        "instagram",
        502,
      );
    }

    const signed = await storage.createSignedUrl(objectPath, SIGNED_URL_SECONDS);
    if (signed.error || !signed.data?.signedUrl) {
      await this.removeTemporaryObject(storage, objectPath, asset._id);
      throw new PlatformPublishError(
        `Could not create a temporary Instagram video URL: ${signed.error?.message || "No signed URL returned"}`,
        "instagram",
        502,
      );
    }
    return { bucket, objectPath, videoUrl: signed.data.signedUrl };
  }

  async publishPost(asset, { post, publishedAt, media } = {}) {
    if (!media?.videoUrl) {
      throw new PlatformPublishError(
        "A temporary public video URL is required for Instagram publishing",
        "instagram",
        400,
        false,
      );
    }
    const { accessToken, instagramUserId } = await this.resolveCredentials(
      asset.connection,
    );
    const graphBase = `https://graph.facebook.com/${this.config.metaGraphApiVersion}`;
    const caption = post?.caption ?? asset.caption ?? "";
    const hashtagString = post?.hashtagString ?? (asset.hashtags || []).join(" ");
    const finalCaption = [caption.trim(), hashtagString.trim()]
      .filter(Boolean)
      .join("\n\n");
    const storage = this.storageClient.storage.from(media.bucket);

    try {
      const createUrl = new URL(
        `${graphBase}/${encodeURIComponent(instagramUserId)}/media`,
      );
      const created = await responseJson(
        await this.fetch(createUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            media_type: "REELS",
            video_url: media.videoUrl,
            caption: finalCaption,
            access_token: accessToken,
          }),
        }),
        "Reel container creation",
      );
      if (typeof created.id !== "string" || !created.id) {
        throw new PlatformPublishError(
          "Instagram did not return a Reel container ID",
          "instagram",
        );
      }

      const statusUrl = new URL(`${graphBase}/${encodeURIComponent(created.id)}`);
      statusUrl.search = new URLSearchParams({
        fields: "status_code",
        access_token: accessToken,
      }).toString();
      let containerReady = false;
      for (let attempt = 0; attempt < MAX_CONTAINER_POLLS; attempt += 1) {
        const status = await responseJson(
          await this.fetch(statusUrl),
          "Reel processing check",
        );
        if (status.status_code === "FINISHED") {
          containerReady = true;
          break;
        }
        if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
          throw new PlatformPublishError(
            `Instagram could not process the Reel (status: ${status.status_code})`,
            "instagram",
            502,
            false,
          );
        }
        if (status.status_code !== "IN_PROGRESS") {
          throw new PlatformPublishError(
            `Instagram returned an unexpected Reel status: ${status.status_code || "unknown"}`,
            "instagram",
            502,
            false,
          );
        }
        if (attempt < MAX_CONTAINER_POLLS - 1) {
          await this.wait(CONTAINER_POLL_INTERVAL_MS);
        }
      }
      if (!containerReady) {
        throw new PlatformPublishError(
          "Instagram is still processing the Reel. The video is retained locally; check Instagram before retrying.",
          "instagram",
          504,
          false,
        );
      }

      const publishUrl = new URL(
        `${graphBase}/${encodeURIComponent(instagramUserId)}/media_publish`,
      );
      let publishResponse;
      try {
        publishResponse = await this.fetch(publishUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            creation_id: created.id,
            access_token: accessToken,
          }),
        });
      } catch {
        throw new PlatformPublishError(
          "Instagram did not confirm whether it accepted the Reel. Check Instagram before trying again.",
          "instagram",
          502,
          false,
        );
      }
      const published = await responseJson(
        publishResponse,
        "Reel publishing",
      );
      if (typeof published.id !== "string" || !published.id) {
        throw new PlatformPublishError(
          "Instagram did not confirm the published Reel",
          "instagram",
        );
      }

      let postUrl;
      try {
        const permalinkUrl = new URL(
          `${graphBase}/${encodeURIComponent(published.id)}`,
        );
        permalinkUrl.search = new URLSearchParams({
          fields: "permalink",
          access_token: accessToken,
        }).toString();
        const mediaDetails = await responseJson(
          await this.fetch(permalinkUrl),
          "published Reel lookup",
        );
        if (typeof mediaDetails.permalink === "string") {
          postUrl = mediaDetails.permalink;
        }
      } catch (error) {
        this.logger.warn?.("Instagram confirmed publishing but post URL lookup failed", {
          assetId: asset._id,
          error: error.message,
        });
      }

      return {
        platform: "instagram",
        postId: published.id,
        postUrl,
        status: "published",
        verified: true,
        publishedAt: publishedAt || this.now(),
        caption,
        hashtagString,
      };
    } finally {
      await this.removeTemporaryObject(storage, media.objectPath, asset._id);
    }
  }

  async publishToPlatform(asset, platform, connection) {
    if (platform !== "instagram") {
      throw new PlatformPublishError(
        `Unsupported Instagram publisher platform: ${platform}`,
        "instagram",
        400,
        false,
      );
    }
    await this.validateConnection(connection);
    const publishAsset = { ...asset, status: "publishing", connection };
    const media = await this.uploadMedia(publishAsset);
    return this.publishPost(publishAsset, { media });
  }

  async verifyPublication(asset, result) {
    return {
      verified: result?.platform === "instagram" && Boolean(result?.postId),
      postUrl: result?.postUrl || null,
    };
  }
}
