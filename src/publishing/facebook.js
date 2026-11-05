import { PlatformPublisher, PlatformPublishError, PlatformConnectionError, validateVideoType, validateVideoSize } from "./engine.js";

const FACEBOOK_REELS_ENDPOINT = "https://graph.facebook.com/v19.0/photos";

export class FacebookPublisher extends PlatformPublisher {
  get platformName() {
    return "facebook";
  }

  get requiredScopes() {
    return [
      "pages_show_list",
      "pages_read_engagement",
      "pages_manage_posts",
    ];
  }

  async validateConnection(connection) {
    if (!connection?.pageId) {
      throw new PlatformConnectionError(
        "Facebook Page ID is missing",
        "facebook"
      );
    }
    if (!connection?.accessToken?.version) {
      throw new PlatformConnectionError(
        "Access token is missing or malformed",
        "facebook"
      );
    }
    return true;
  }

  async publishPost(asset, { post, publishedAt }) {
    const { accessToken, pageId } = await this.resolveCredentials(asset);

    const caption = post?.caption || asset?.caption || "";
    const hashtagString = post?.hashtagString || (asset?.hashtags || []).join(" ");

    const formData = new FormData();
    formData.append("caption", caption);
    formData.append("source", asset?.localPath);
    formData.append("access_token", accessToken);
    if (hashtagString) {
      formData.append("hashtag_string", hashtagString);
    }

    const response = await fetch(FACEBOOK_REELS_ENDPOINT, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new PlatformPublishError(
        `Facebook Reels publish failed: ${response.status} ${errorBody.slice(0, 200)}`,
        "facebook",
        response.status
      );
    }

    const result = await response.json();
    return {
      platform: "facebook",
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
        accessToken: asset.connection?.accessToken || asset.connection?.encryptedAccessToken,
        pageId: asset.connection?.pageId,
      };
    }
    throw new PlatformPublishError(
      "No Facebook connection found on asset",
      "facebook",
      400
    );
  }
}
