import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { OAuthService } from "../src/oauth/service.js";
import { TokenVault } from "../src/oauth/token-vault.js";
import { loadConfig } from "../src/config.js";

function createConfig(overrides = {}) {
  return {
    publicBaseUrl: "https://reel.example.test",
    tokenEncryptionKey: randomBytes(32),
    metaAppId: "meta-app-id",
    metaAppSecret: "meta-app-secret",
    metaLoginConfigId: "login-config-id",
    metaRedirectUri: "https://reel.example.test/oauth/meta/callback",
    metaOAuthMode: "facebook_login_business",
    metaGraphApiVersion: "v99.0",
    googleClientId: "google-client-id",
    googleClientSecret: "google-client-secret",
    ...overrides,
  };
}

class OAuthMemoryRepository {
  constructor() {
    this.states = new Map();
    this.connections = [];
  }

  async createOAuthState(record) {
    this.states.set(record.state, record);
  }

  async consumeOAuthState(state) {
    const record = this.states.get(state);
    this.states.delete(state);
    return record;
  }

  async saveOAuthConnections(connections) {
    this.connections.push(...connections);
  }

  async listOAuthConnections() {
    return this.connections.map(
      ({ platform, accountId, displayName, email, connectedAt }) => ({
        platform,
        accountId,
        displayName,
        email,
        connectedAt,
      }),
    );
  }
}

test("OAuth authorization URLs use configured redirect URIs and one-time state", async () => {
  const repository = new OAuthMemoryRepository();
  const service = new OAuthService({
    config: createConfig(),
    repository,
    now: () => new Date("2026-11-04T00:00:00Z"),
  });

  const metaUrl = new URL(await service.createAuthorizationUrl("meta"));
  const metaState = metaUrl.searchParams.get("state");
  assert.equal(metaUrl.hostname, "www.facebook.com");
  assert.equal(
    metaUrl.searchParams.get("redirect_uri"),
    "https://reel.example.test/oauth/meta/callback",
  );
  assert.equal(metaUrl.searchParams.get("config_id"), "login-config-id");
  assert.equal(metaUrl.searchParams.has("scope"), false);
  assert.equal(repository.states.get(metaState).provider, "meta");

  const googleUrl = new URL(await service.createAuthorizationUrl("google"));
  assert.equal(googleUrl.hostname, "accounts.google.com");
  assert.equal(
    googleUrl.searchParams.get("redirect_uri"),
    "https://reel.example.test/oauth/google/callback",
  );
  assert.equal(googleUrl.searchParams.get("access_type"), "offline");
  assert.equal(googleUrl.searchParams.get("prompt"), "consent");
  assert.equal(repository.states.get(googleUrl.searchParams.get("state")).provider, "google");
});

test("Login for Business authorization uses its config ID and no scope parameter", async () => {
  const repository = new OAuthMemoryRepository();
  const service = new OAuthService({
    config: createConfig(),
    repository,
  });

  const url = new URL(await service.createAuthorizationUrl("meta"));
  assert.equal(url.origin, "https://www.facebook.com");
  assert.equal(url.pathname, "/v99.0/dialog/oauth");
  assert.equal(url.searchParams.get("client_id"), "meta-app-id");
  assert.equal(url.searchParams.get("config_id"), "login-config-id");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://reel.example.test/oauth/meta/callback",
  );
  assert.equal(url.searchParams.has("scope"), false);
  assert.equal(repository.states.get(url.searchParams.get("state")).provider, "meta");
});

test("OAuth callback consumes matching state exactly once", async () => {
  const repository = new OAuthMemoryRepository();
  const service = new OAuthService({ config: createConfig(), repository });
  const state = "s".repeat(43);
  await repository.createOAuthState({
    state,
    provider: "google",
    expiresAt: new Date(Date.now() + 60_000),
  });

  await assert.rejects(
    service.handleCallback("meta", { state, code: "authorization-code" }),
    /invalid or has expired/,
  );
  await assert.rejects(
    service.handleCallback("google", { state, code: "authorization-code" }),
    /invalid or has expired/,
  );
});

test("Login for Business callback exchanges a SUAT and saves only assigned Instagram accounts", async () => {
  const repository = new OAuthMemoryRepository();
  const config = createConfig();
  const calls = [];
  const responses = [
    { access_token: "system-user-access-token", expires_in: 3600 },
    {
      data: [
        { id: "instagram-1", username: "creator" },
      ],
    },
  ];
  const service = new OAuthService({
    config,
    repository,
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const state = "m".repeat(43);
  await repository.createOAuthState({
    state,
    provider: "meta",
    expiresAt: new Date(Date.now() + 60_000),
  });

  const result = await service.handleCallback("meta", {
    state,
    code: "authorization-code",
  });

  assert.deepEqual(result, [
    { platform: "instagram", accountId: "instagram-1", displayName: "creator" },
  ]);
  assert.equal(repository.connections.length, 1);
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].url.pathname,
    "/v99.0/oauth/access_token",
  );
  assert.equal(calls[0].url.searchParams.get("client_id"), config.metaAppId);
  assert.equal(calls[0].url.searchParams.get("client_secret"), config.metaAppSecret);
  assert.equal(calls[0].url.searchParams.get("code"), "authorization-code");
  assert.equal(
    calls[0].url.searchParams.get("redirect_uri"),
    service.callbackUrl("meta"),
  );
  assert.equal(
    calls[1].url.pathname,
    "/v99.0/me/assigned_instagram_accounts",
  );
  assert.equal(calls[1].url.searchParams.get("fields"), "id,username");
  assert.equal(
    new TokenVault(config.tokenEncryptionKey).decrypt(
      repository.connections[0].encryptedAccessToken,
    ),
    "system-user-access-token",
  );
  assert.equal(repository.connections[0].tokenType, "system_user");
  assert.equal(repository.connections[0].loginConfigId, "login-config-id");
  assert.deepEqual(repository.connections[0].scopes, [
    "instagram_basic",
    "instagram_content_publish",
  ]);
  assert.ok(
    calls.every(({ url }) => url.origin === "https://graph.facebook.com"),
  );
  const listed = await service.listConnections();
  assert.deepEqual(listed.map((item) => item.platform), ["instagram"]);
  assert.equal(JSON.stringify(listed).includes("system-user-access-token"), false);
});

test("Login for Business callback does not save a token when no Instagram account is assigned", async () => {
  const repository = new OAuthMemoryRepository();
  const service = new OAuthService({
    config: createConfig(),
    repository,
    fetchImpl: async (url) => {
      const requestUrl = new URL(url);
      if (requestUrl.pathname.endsWith("/oauth/access_token")) {
        return Response.json({ access_token: "system-user-access-token" });
      }
      return Response.json({ data: [] });
    },
  });
  const state = "n".repeat(43);
  await repository.createOAuthState({
    state,
    provider: "meta",
    expiresAt: new Date(Date.now() + 60_000),
  });

  await assert.rejects(
    service.handleCallback("meta", { state, code: "authorization-code" }),
    /no assigned Instagram accounts/,
  );
  assert.equal(repository.connections.length, 0);
});

test("token vault encrypts tokens and detects tampering", () => {
  const vault = new TokenVault(randomBytes(32));
  const encrypted = vault.encrypt("provider-access-token");
  assert.notEqual(encrypted.ciphertext, "provider-access-token");
  assert.equal(vault.decrypt(encrypted), "provider-access-token");
  assert.throws(
    () => vault.decrypt({ ...encrypted, ciphertext: randomBytes(32).toString("base64") }),
  );
});

test("OAuth refuses to start without configured provider credentials", async () => {
  const service = new OAuthService({
    config: createConfig({ googleClientId: "", googleClientSecret: "" }),
    repository: new OAuthMemoryRepository(),
  });
  await assert.rejects(
    service.createAuthorizationUrl("google"),
    /credentials are not configured/,
  );
});

test("configuration requires strong admin and encryption keys and a valid public URL", () => {
  const base = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    ADMIN_API_TOKEN: "a-secure-test-token-with-at-least-32-characters",
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    PUBLIC_BASE_URL: "https://reel.example.test",
    META_LOGIN_CONFIG_ID: "login-config-id",
    META_REDIRECT_URI: "https://reel.example.test/oauth/meta/callback",
  };
  assert.equal(loadConfig(base).publicBaseUrl, "https://reel.example.test");
  assert.equal(
    loadConfig({ ...base, META_GRAPH_API_VERSION: "v19.0" }).metaGraphApiVersion,
    "v19.0",
  );
  assert.equal(
    loadConfig({ ...base, META_GRAPH_API_VERSION: "v26.0" }).metaGraphApiVersion,
    "v26.0",
  );
  assert.equal(
    loadConfig({
      ...base,
      NODE_ENV: "production",
      PUBLIC_BASE_URL: "http://localhost:3000",
      RAILWAY_PUBLIC_DOMAIN: "reel-production.up.railway.app",
    }).publicBaseUrl,
    "https://reel-production.up.railway.app",
  );
  assert.equal(loadConfig(base).metaGraphApiVersion, "v26.0");
  assert.equal(loadConfig(base).metaOAuthMode, "facebook_login_business");
  assert.equal(loadConfig(base).metaLoginConfigId, "login-config-id");
  assert.equal(
    loadConfig(base).metaRedirectUri,
    "https://reel.example.test/oauth/meta/callback",
  );
  assert.throws(
    () => loadConfig({ ...base, META_OAUTH_MODE: "instagram_login" }),
    /META_OAUTH_MODE/,
  );
  assert.throws(
    () => loadConfig({ ...base, META_LOGIN_CONFIG_ID: "" }),
    /META_LOGIN_CONFIG_ID is required/,
  );
  assert.equal(loadConfig(base).supabaseMediaBucket, "autoreel-publishing");
  assert.equal(
    loadConfig({
      ...base,
      SUPABASE_URL: undefined,
      SUPABASE_SERVICE_ROLE_KEY: undefined,
      supabase_url: base.SUPABASE_URL,
      supabase_service_role_key: base.SUPABASE_SERVICE_ROLE_KEY,
    }).supabaseUrl,
    base.SUPABASE_URL,
  );
  assert.throws(
    () => loadConfig({ ...base, TOKEN_ENCRYPTION_KEY: "not-a-32-byte-key" }),
    /base64-encoded 32-byte key/,
  );
  assert.throws(
    () => loadConfig({ ...base, PUBLIC_BASE_URL: "http://reel.example.test" }),
    /must use HTTPS/,
  );
  assert.throws(
    () => loadConfig({ ...base, PUBLIC_BASE_URL: "https://reel.example.test/path" }),
    /must use HTTPS/,
  );
});
