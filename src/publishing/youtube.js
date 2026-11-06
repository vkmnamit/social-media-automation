import { PlatformPublisher, PlatformPublishError, PlatformConnectionError, validateVideoType, validateVideoSize, ExponentialBackoff } from "./engine.js";

const YOUTUBE_UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/youtube/v3/videos";

export class YouTubePublisher extends PlatformPublisher {
  get platformName() {
    return "youtube";
  }

  get requiredScopes() {
    return [
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube",
    ];
  }

  async validateConnection(connection) {
    if (!connection?.accountId) {
      throw new PlatformConnectionError(
        "YouTube channel ID is missing",
        "youtube"
      );
    }
    if (!connection?.encryptedAccessToken?.ciphertext) {
      throw new PlatformConnectionError(
        "Access token is missing or malformed",
        "youtube"
      );
    }
    return true;
  }

  async publishPost(asset, { post, publishedAt }) {
    const { encryptedAccessToken, accountId } = await this.resolveCredentials(asset);
    const accessToken = await this.decryptToken(encryptedAccessToken);

    const caption = post?.caption || asset?.caption || "";
    const hashtagString = post?.hashtagString || (asset?.hashtags || []).join(" ");

    const videoMetadata = {
      snippet: {
        title: post?.title || asset?.originalName || "AutoReel Short",
        description: `${caption}\n\n${hashtagString}`,
        tags: asset?.hashtags || [],
        categoryId: "22",
      },
      status: {
        privacyStatus: "public",
      },
    };

    const response = await fetch(YOUTUBE_UPLOAD_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(videoMetadata),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new PlatformPublishError(
        `YouTube upload failed: ${response.status} ${errorBody.slice(0, 200)}`,
        "youtube",
        response.status
      );
    }

    const result = await response.json();
    return {
      platform: "youtube",
      postId: result?.id || post?.postId || undefined,
      status: "published",
      publishedAt,
      caption,
      hashtagString,
    };
  }

  async resolveCredentials(asset) {
    if (asset?.connection) {
      return {
        encryptedAccessToken: asset.connection?.encryptedAccessToken,
        accountId: asset.connection?.accountId,
      };
    }
    throw new PlatformPublishError(
      "No YouTube connection found on asset",
      "youtube",
      400
    );
  }

  async decryptToken(encrypted) {
    if (!this.config?.tokenEncryptionKey) {
      throw new PlatformPublishError(
        "Token encryption key not configured",
        "youtube",
        500
      );
    }
    const key = Buffer.from(this.config.tokenEncryptionKey, "base64");
    const nonce = Buffer.from(encrypted.nonce, "base64");
    const ciphertext = Buffer.from(encrypted.ciphertext, "base64");
    const tag = Buffer.from(encrypted.tag, "base64");

    const crypto = await import("node:crypto");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      nonce
    );
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  }
}
