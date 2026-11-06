import { PlatformPublisher, PlatformPublishError, PlatformConnectionError } from "./engine.js";
import { createReadStream } from "node:fs";
import { getLocalFile } from "../storage/local-files.js";

/**
 * YouTube Shorts publisher - uploads video file directly via YouTube Data API.
 */
export class YouTubeShortsPublisher extends PlatformPublisher {
  constructor({ config, fetchImpl = fetch, now = () => new Date() }) {
    super();
    this.config = config;
    this.fetch = fetchImpl;
    this.now = now;
  }

  get platformName() {
    return "youtube_shorts";
  }

  get requiredScopes() {
    return [
      "https://www.googleapis.com/auth/youtube.upload",
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
    const { accountId } = await this.resolveCredentials(asset);
    const accessToken = await this.getAccessToken(asset);

    const caption = post?.caption || asset?.caption || "";
    const hashtagString = post?.hashtagString || (asset?.hashtags || []).join(" ");

    const url = new URL("https://www.googleapis.com/upload/youtube/v3/videos");
    url.searchParams.set("part", "snippet,status");
    url.searchParams.set("uploadType", "resumable");
    const file = await getLocalFile(this.config.storageDir, asset.localPath);
    const title = String(post?.title || asset?.title || caption || "AutoReel Short").slice(0, 100);
    const privacyStatus = asset?.privacyStatus || "private";
    const metadata = {
      snippet: {
        title,
        description: `${caption}\n\n${hashtagString}`.trim(),
        tags: asset?.hashtags || [],
        categoryId: "22",
        defaultLanguage: "en",
      },
      status: {
        privacyStatus,
        embeddable: true,
        license: "youtube",
      },
    };

    const initialized = await this.fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "video/mp4",
        "X-Upload-Content-Length": String(file.size),
      },
      body: JSON.stringify(metadata),
    });
    if (!initialized.ok) {
      const errorBody = await initialized.text();
      throw new PlatformPublishError(
        `YouTube Shorts upload initialization failed: ${initialized.status} ${errorBody.slice(0, 200)}`,
        "youtube_shorts",
        initialized.status
      );
    }

    const uploadUrl = initialized.headers.get("location");
    if (!uploadUrl) {
      throw new PlatformPublishError(
        "YouTube Shorts upload did not return a resumable upload URL",
        "youtube_shorts",
        502,
      );
    }
    const response = await this.fetch(uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "video/mp4",
        "Content-Length": String(file.size),
      },
      body: createReadStream(file.path),
      duplex: "half",
    });
    if (!response.ok) {
      const errorBody = await response.text();
      throw new PlatformPublishError(
        `YouTube Shorts media upload failed: ${response.status} ${errorBody.slice(0, 200)}`,
        "youtube_shorts",
        response.status,
      );
    }

    const result = await response.json();
    if (result?.snippet?.channelId && result.snippet.channelId !== accountId) {
      throw new PlatformPublishError(
        "The uploaded video was created on a different YouTube channel",
        "youtube_shorts",
        409,
        false,
      );
    }
    return {
      platform: "youtube_shorts",
      postId: result?.id || post?.postId || undefined,
      postUrl: result?.id ? `https://www.youtube.com/watch?v=${result.id}` : undefined,
      status: "published",
      publishedAt: publishedAt || this.now(),
      caption,
      hashtagString,
      videoId: result?.id || undefined,
    };
  }

  async resolveCredentials(asset) {
    if (asset?.connection) {
      return {
        encryptedAccessToken: asset.connection?.encryptedAccessToken,
        encryptedRefreshToken: asset.connection?.encryptedRefreshToken,
        tokenExpiryDate: asset.connection?.tokenExpiryDate,
        accountId: asset.connection?.accountId,
      };
    }
    throw new PlatformPublishError(
      "No YouTube Shorts connection found on asset",
      "youtube_shorts",
      400
    );
  }

  async getAccessToken(asset) {
    const credentials = await this.resolveCredentials(asset);
    const hasAccessToken = Boolean(credentials.encryptedAccessToken?.ciphertext);
    const expiry = credentials.tokenExpiryDate
      ? new Date(credentials.tokenExpiryDate).getTime()
      : 0;
    const shouldRefresh = !hasAccessToken || !expiry || expiry <= this.now().getTime() + 60_000;
    if (!shouldRefresh) {
      return this.decryptToken(credentials.encryptedAccessToken);
    }
    if (!credentials.encryptedRefreshToken?.ciphertext) {
      if (hasAccessToken) return this.decryptToken(credentials.encryptedAccessToken);
      throw new PlatformConnectionError("YouTube refresh token is missing", "youtube_shorts");
    }
    if (!this.config.googleClientId || !this.config.googleClientSecret) {
      throw new PlatformPublishError("Google OAuth client credentials are unavailable for token refresh", "youtube_shorts", 503);
    }

    const refreshToken = await this.decryptToken(credentials.encryptedRefreshToken);
    const response = await this.fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.googleClientId,
        client_secret: this.config.googleClientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!response.ok) {
      throw new PlatformPublishError(
        `Google access token refresh failed: HTTP ${response.status}`,
        "youtube_shorts",
        response.status,
      );
    }
    const result = await response.json();
    if (typeof result.access_token !== "string" || !result.access_token) {
      throw new PlatformPublishError("Google token refresh returned no access token", "youtube_shorts", 502);
    }
    return result.access_token;
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
