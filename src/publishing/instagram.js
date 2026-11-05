import { PlatformPublisher, PlatformPublishError, PlatformConnectionError, validateVideoType, validateVideoSize } from "./engine.js";

const INSTAGRAM_REELS_ENDPOINT = "https://graph.facebook.com/v19.0/instagram_reels_media";

export class InstagramPublisher extends PlatformPublisher {
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
    if (!connection?.instagramBusinessAccountId) {
      throw new PlatformConnectionError(
        "Instagram business account ID is missing",
        "instagram"
      );
    }
    if (!connection?.accessToken?.version) {
      throw new PlatformConnectionError(
        "Access token is missing or malformed",
        "instagram"
      );
    }
    return true;
  }

  async publishPost(asset, { post, publishedAt }) {
    const { accessToken, instagramBusinessAccountId } = await this.resolveCredentials(asset);

    const caption = post?.caption || asset?.caption || "";
    const hashtagString = post?.hashtagString || (asset?.hashtags || []).join(" ");

    const response = await fetch(INSTAGRAM_REELS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        caption,
        media_type: "REELS",
        media_url: asset?.localPath,
        thumbnail_url: asset?.localPath,
        access_token: accessToken,
        caption_text: caption,
        hashtag_string: hashtagString,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new PlatformPublishError(
        `Instagram Reels publish failed: ${response.status} ${errorBody.slice(0, 200)}`,
        "instagram",
        response.status
      );
    }

    const result = await response.json();
    return {
      platform: "instagram",
      postId: result?.id || post?.postId || undefined,
      mediaId: result?.id || undefined,
      status: "published",
      publishedAt,
      caption,
      hashtagString,
    };
  }

  async resolveCredentials(asset) {
    if (asset?.connection) {
      return {
        accessToken: asset.connection?.accessToken || asset.connection?.encryptedAccessToken,
        instagramBusinessAccountId: asset.connection?.instagramBusinessAccountId,
      };
    }
    throw new PlatformPublishError(
      "No Instagram connection found on asset",
      "instagram",
      400
    );
  }
}
