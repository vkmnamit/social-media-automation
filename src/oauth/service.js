import { randomBytes, randomUUID } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { TokenVault } from "./token-vault.js";

const STATE_TTL_MS = 10 * 60 * 1000;
const META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
];
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.upload",
];
const PROVIDERS = new Set(["meta", "google"]);

function assertProvider(provider) {
  if (!PROVIDERS.has(provider)) {
    const error = new Error("Unsupported OAuth provider");
    error.statusCode = 404;
    throw error;
  }
}

function safeResponse(response, context) {
  if (!response.ok) {
    throw new Error(`${context} failed with status ${response.status}`);
  }
  return response.json();
}

function assertScopes(granted, required) {
  const missing = required.filter((scope) => !granted.includes(scope));
  if (missing.length) {
    throw new Error(
      `The connected app has not granted all required permissions (${missing.join(", ")}). Check platform app review and consent settings.`,
    );
  }
}

export class OAuthService {
  constructor({ config, repository, fetchImpl = fetch, now = () => new Date() }) {
    this.config = config;
    this.repository = repository;
    this.fetch = fetchImpl;
    this.now = now;
    this.vault = new TokenVault(config.tokenEncryptionKey);
  }

  callbackUrl(provider) {
    assertProvider(provider);
    return new URL(`/oauth/${provider}/callback`, this.config.publicBaseUrl).toString();
  }

  isConfigured(provider) {
    assertProvider(provider);
    if (provider === "meta") {
      return Boolean(
        this.config.metaAppId &&
          this.config.metaAppSecret &&
          this.config.metaGraphApiVersion,
      );
    }
    return Boolean(this.config.googleClientId && this.config.googleClientSecret);
  }

  async createAuthorizationUrl(provider) {
    assertProvider(provider);
    if (!this.isConfigured(provider)) {
      const error = new Error(`${provider} OAuth credentials are not configured`);
      error.statusCode = 503;
      throw error;
    }

    const state = randomBytes(32).toString("base64url");
    await this.repository.createOAuthState({
      state,
      provider,
      expiresAt: new Date(this.now().getTime() + STATE_TTL_MS),
    });

    if (provider === "meta") {
      const authorizeUrl = new URL(
        `https://www.facebook.com/${this.config.metaGraphApiVersion}/dialog/oauth`,
      );
      authorizeUrl.search = new URLSearchParams({
        client_id: this.config.metaAppId,
        redirect_uri: this.callbackUrl(provider),
        response_type: "code",
        state,
        scope: META_SCOPES.join(","),
      }).toString();
      return authorizeUrl.toString();
    }

    const client = this.createGoogleClient();
    return client.generateAuthUrl({
      access_type: "offline",
      include_granted_scopes: true,
      prompt: "consent",
      scope: GOOGLE_SCOPES,
      state,
    });
  }

  createGoogleClient() {
    return new OAuth2Client(
      this.config.googleClientId,
      this.config.googleClientSecret,
      this.callbackUrl("google"),
    );
  }

  async handleCallback(provider, { state, code, error: providerError }) {
    assertProvider(provider);
    if (typeof state !== "string" || state.length < 32) {
      throw new Error("OAuth state is invalid or has expired");
    }
    const savedState = await this.repository.consumeOAuthState(state);
    if (
      !savedState ||
      savedState.provider !== provider ||
      savedState.expiresAt <= this.now()
    ) {
      throw new Error("OAuth state is invalid or has expired");
    }
    if (providerError) {
      throw new Error("Authorization was declined or could not be completed");
    }
    if (typeof code !== "string" || !code) {
      throw new Error("OAuth authorization code is missing");
    }

    if (provider === "meta") {
      return this.finishMetaAuthorization(code);
    }
    return this.finishGoogleAuthorization(code);
  }

  async finishMetaAuthorization(code) {
    const base = `https://graph.facebook.com/${this.config.metaGraphApiVersion}`;
    const redirectUri = this.callbackUrl("meta");
    const shortTokenUrl = new URL(`${base}/oauth/access_token`);
    shortTokenUrl.search = new URLSearchParams({
      client_id: this.config.metaAppId,
      client_secret: this.config.metaAppSecret,
      redirect_uri: redirectUri,
      code,
    }).toString();
    const shortToken = await safeResponse(
      await this.fetch(shortTokenUrl),
      "Meta code exchange",
    );

    const longTokenUrl = new URL(`${base}/oauth/access_token`);
    longTokenUrl.search = new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: this.config.metaAppId,
      client_secret: this.config.metaAppSecret,
      fb_exchange_token: shortToken.access_token,
    }).toString();
    const longToken = await safeResponse(
      await this.fetch(longTokenUrl),
      "Meta token exchange",
    );

    const permissionUrl = new URL(`${base}/me/permissions`);
    permissionUrl.searchParams.set("access_token", longToken.access_token);
    const permissions = await safeResponse(
      await this.fetch(permissionUrl),
      "Meta permission check",
    );
    const granted = (permissions.data || [])
      .filter((permission) => permission.status === "granted")
      .map((permission) => permission.permission);
    assertScopes(granted, META_SCOPES);

    const pagesUrl = new URL(`${base}/me/accounts`);
    pagesUrl.search = new URLSearchParams({
      fields: "id,name,access_token,instagram_business_account{id,username}",
      access_token: longToken.access_token,
    }).toString();
    const pages = await safeResponse(await this.fetch(pagesUrl), "Meta Page lookup");
    const connections = [];
    for (const page of pages.data || []) {
      if (!page.id || !page.name || !page.access_token) continue;
      const pageToken = this.vault.encrypt(page.access_token);
      connections.push({
        connectionId: randomUUID(),
        provider: "meta",
        platform: "facebook",
        accountId: page.id,
        displayName: page.name,
        scopes: granted,
        encryptedAccessToken: pageToken,
        connectedAt: this.now(),
      });

      const instagram = page.instagram_business_account;
      if (instagram?.id) {
        connections.push({
          connectionId: randomUUID(),
          provider: "meta",
          platform: "instagram",
          accountId: instagram.id,
          displayName: instagram.username || page.name,
          pageId: page.id,
          scopes: granted,
          encryptedAccessToken: pageToken,
          connectedAt: this.now(),
        });
      }
    }
    if (connections.length === 0) {
      throw new Error(
        "No Facebook Pages are available to this account. Add a Page and connect an eligible Instagram professional account if needed.",
      );
    }
    await this.repository.saveOAuthConnections(connections);
    return connections.map(({ platform, accountId, displayName }) => ({
      platform,
      accountId,
      displayName,
    }));
  }

  async finishGoogleAuthorization(code) {
    const client = this.createGoogleClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.access_token) {
      throw new Error("Google did not return an access token");
    }
    const grantedScopes = new Set((tokens.scope || "").split(/\s+/));
    const missingScopes = GOOGLE_SCOPES.filter(
      (scope) => scope.startsWith("https://") && !grantedScopes.has(scope),
    );
    if (missingScopes.length) {
      throw new Error(
        `Google did not grant the required YouTube permissions (${missingScopes.join(", ")})`,
      );
    }
    if (!tokens.refresh_token) {
      throw new Error(
        "Google did not return offline access. Remove the app's existing Google grant and reconnect.",
      );
    }

    const userResponse = await this.fetch(
      "https://openidconnect.googleapis.com/v1/userinfo",
      { headers: { authorization: `Bearer ${tokens.access_token}` } },
    );
    const user = await safeResponse(userResponse, "Google profile lookup");
    const channelsUrl = new URL("https://youtube.googleapis.com/youtube/v3/channels");
    channelsUrl.search = new URLSearchParams({
      part: "snippet",
      mine: "true",
    }).toString();
    const channelsResponse = await this.fetch(channelsUrl, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    const channels = await safeResponse(channelsResponse, "YouTube channel lookup");
    if (!channels.items?.length) {
      throw new Error("No YouTube channel was found for this Google account");
    }

    const connections = channels.items.map((channel) => ({
      connectionId: randomUUID(),
      provider: "google",
      platform: "youtube",
      accountId: channel.id,
      displayName: channel.snippet?.title || user.email || "YouTube channel",
      email: user.email,
      scopes: GOOGLE_SCOPES,
      encryptedAccessToken: this.vault.encrypt(tokens.access_token),
      encryptedRefreshToken: this.vault.encrypt(tokens.refresh_token),
      tokenExpiryDate: tokens.expiry_date
        ? new Date(tokens.expiry_date)
        : null,
      connectedAt: this.now(),
    }));
    await this.repository.saveOAuthConnections(connections);
    return connections.map(({ platform, accountId, displayName }) => ({
      platform,
      accountId,
      displayName,
    }));
  }

  async listConnections() {
    return this.repository.listOAuthConnections();
  }
}
