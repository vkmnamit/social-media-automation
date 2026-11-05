import { PlatformPublisher, PlatformPublishError, PlatformConnectionError } from "./engine.js";

/**
 * YouTube Shorts publisher - uploads video file directly via YouTube Data API.
 */
export class YouTubeShortsPublisher extends PlatformPublisher {
  get platformName() {
    return "youtube_shorts";
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
        "youtube_shorts"
      );
    }
    if (!connection?.encryptedAccessToken?.ciphertext) {
      throw new PlatformConnectionError(
        "Access token is missing or malformed",
        "youtube_shorts"
      );
    }
    return true;
  }

  async publishPost(asset, { post, publishedAt }) {
    const { encryptedAccessToken, accountId } = await this.resolveCredentials(asset);
    const accessToken = await this.decryptToken(encryptedAccessToken);

    const caption = post?.caption || asset?.caption || "";
    const hashtagString = post?.hashtagString || (asset?.hashtags || []).join(" ");

    const blob = await fetch(asset?.localPath).then((r) => r.blob());

    const formData = new FormData();
    formData.append("video", blob, `short-${Date.now()}.mp4`);
    formData.append(
      "request",
      new Blob(
        [
          JSON.stringify({
            snippet: {
              title: post?.title || asset?.originalName || "AutoReel Short",
              description: `${caption}\n\n${hashtagString}`,
              tags: asset?.hashtags || [],
              categoryId: "22",
              defaultLanguage: "en",
            },
            status: {
              privacyStatus: "public",
              embeddable: true,
              license: "youtube",
            },
          }),
        ],
        { type: "application/json" }
      ),
      "request"
    );

    const url = new URL("https://www.googleapis.com/upload/youtube/v3/videos");
    url.searchParams.set("part", "snippet,status");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new PlatformPublishError(
        `YouTube Shorts publish failed: ${response.status} ${errorBody.slice(0, 200)}`,
        "youtube_shorts",
        response.status
      );
    }

    const result = await response.json();
    return {
      platform: "youtube_shorts",
      postId: result?.id || post?.postId || undefined,
      status: "published",
      publishedAt,
      caption,
      hashtagString,
      videoId: result?.id || undefined,
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
      "No YouTube Shorts connection found on asset",
      "youtube_shorts",
      400
    );
  }

  async decryptToken(encrypted) {
    if (!this.config?.tokenEncryptionKey) {
      throw new PlatformPublishError(
        "Token encryption key not configured",
        "youtube_shorts",
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
