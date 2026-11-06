import { randomBytes, randomUUID } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { TokenVault } from "./token-vault.js";

const STATE_TTL_MS = 10 * 60 * 1000;
const META_INSTAGRAM_PERMISSIONS = ["instagram_basic", "instagram_content_publish"];
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

async function safeResponse(response, context) {
  const result = await response.json();
  if (!response.ok || result.error) {
    const providerError = result.error;
    const details = [
      providerError?.message,
      providerError?.type && `type ${providerError.type}`,
      providerError?.code !== undefined && `code ${providerError.code}`,
    ].filter(Boolean).join("; ");
    throw new Error(
      `${context} failed with status ${response.status}${details ? `: ${details}` : ""}`,
    );
  }
  return result;
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
    if (provider === "meta" && this.config.metaRedirectUri) {
      return this.config.metaRedirectUri;
    }
    if (provider === "google" && this.config.googleRedirectUri) {
      return this.config.googleRedirectUri;
    }
    return new URL(`/oauth/${provider}/callback`, this.config.publicBaseUrl).toString();
  }

  isConfigured(provider) {
    assertProvider(provider);
    if (provider === "meta") {
      return Boolean(
        this.config.metaAppId &&
          this.config.metaAppSecret &&
          this.config.metaGraphApiVersion &&
          (this.config.metaOAuthMode !== "facebook_login_business" ||
            (this.config.metaLoginConfigId && this.callbackUrl("meta"))),
      );
    }
    return Boolean(
      this.config.googleClientId &&
        this.config.googleClientSecret &&
        this.callbackUrl("google"),
    );
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
      authorizeUrl.searchParams.set("client_id", this.config.metaAppId);
      authorizeUrl.searchParams.set("config_id", this.config.metaLoginConfigId);
      authorizeUrl.searchParams.set("redirect_uri", this.callbackUrl(provider));
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("display", "popup");
      authorizeUrl.searchParams.set("override_default_response_type", "true");
      authorizeUrl.searchParams.set("prompt", "login");
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
    return this.finishFacebookLoginBusinessAuthorization(code);
  }

  async finishFacebookLoginBusinessAuthorization(code) {
    const tokenUrl = new URL(
      `https://graph.facebook.com/${this.config.metaGraphApiVersion}/oauth/access_token`,
    );
    tokenUrl.search = new URLSearchParams({
      client_id: this.config.metaAppId,
      client_secret: this.config.metaAppSecret,
      redirect_uri: this.callbackUrl("meta"),
      code,
    }).toString();
    const token = await safeResponse(
      await this.fetch(tokenUrl),
      "Facebook Login for Business code exchange",
    );
    if (typeof token.access_token !== "string" || !token.access_token) {
      throw new Error("Meta did not return an access token");
    }

    const accountsUrl = new URL(
      `https://graph.facebook.com/${this.config.metaGraphApiVersion}/me/assigned_instagram_accounts`,
    );
    accountsUrl.search = new URLSearchParams({
      fields: "id,username",
      access_token: token.access_token,
    }).toString();
    const accountResult = await safeResponse(
      await this.fetch(accountsUrl),
      "Authorized Instagram account lookup",
    );
    const accounts = (accountResult.data || []).filter(
      (account) => typeof account.id === "string" && account.id.length > 0,
    );
    if (accounts.length === 0) {
      throw new Error(
        "Meta authorization completed, but the selected Login for Business configuration returned no assigned Instagram accounts",
      );
    }

    const encryptedAccessToken = this.vault.encrypt(token.access_token);
    const connections = accounts.map((account) => ({
      connectionId: randomUUID(),
      provider: "meta",
      platform: "instagram",
      accountId: account.id,
      displayName: account.username || account.id,
      scopes: META_INSTAGRAM_PERMISSIONS,
      tokenType: "system_user",
      loginConfigId: this.config.metaLoginConfigId,
      encryptedAccessToken,
      tokenExpiresAt:
        Number.isFinite(token.expires_in) && token.expires_in > 0
          ? new Date(this.now().getTime() + token.expires_in * 1000)
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
