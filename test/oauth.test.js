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
  assert.ok(metaUrl.searchParams.get("scope").includes("instagram_content_publish"));
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

test("Instagram Login authorization uses the Meta App ID and Instagram publishing scopes", async () => {
  const repository = new OAuthMemoryRepository();
  const service = new OAuthService({
    config: createConfig({ metaOAuthMode: "instagram_login" }),
    repository,
  });

  const url = new URL(await service.createAuthorizationUrl("meta"));
  assert.equal(url.origin, "https://www.instagram.com");
  assert.equal(url.pathname, "/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "meta-app-id");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://reel.example.test/oauth/meta/callback",
  );
  assert.deepEqual(url.searchParams.get("scope").split(","), [
    "instagram_business_basic",
    "instagram_business_content_publish",
  ]);
  assert.equal(url.searchParams.get("enable_fb_login"), "false");
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

test("Meta OAuth stores encrypted Page tokens and returns account metadata only", async () => {
  const repository = new OAuthMemoryRepository();
  const config = createConfig();
  const calls = [];
  const responses = [
    { access_token: "short-lived-user-token" },
    { access_token: "long-lived-user-token" },
    {
      data: [
        { permission: "pages_show_list", status: "granted" },
        { permission: "pages_read_engagement", status: "granted" },
        { permission: "pages_manage_posts", status: "granted" },
        { permission: "instagram_basic", status: "granted" },
        { permission: "instagram_content_publish", status: "granted" },
      ],
    },
    {
      data: [
        {
          id: "page-1",
          name: "Creator Page",
          access_token: "page-access-token",
          instagram_business_account: {
            id: "instagram-1",
            username: "creator",
          },
        },
      ],
    },
  ];
  const service = new OAuthService({
    config,
    repository,
    fetchImpl: async (url) => {
      calls.push(new URL(url));
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
    { platform: "facebook", accountId: "page-1", displayName: "Creator Page" },
    { platform: "instagram", accountId: "instagram-1", displayName: "creator" },
  ]);
  assert.equal(repository.connections.length, 2);
  assert.notEqual(repository.connections[0].encryptedAccessToken.ciphertext, "page-access-token");
  assert.equal(
    new TokenVault(config.tokenEncryptionKey).decrypt(
      repository.connections[1].encryptedAccessToken,
    ),
    "page-access-token",
  );
  assert.ok(calls.every((url) => url.origin === "https://graph.facebook.com"));
  const listed = await service.listConnections();
  assert.deepEqual(listed.map((item) => item.platform), ["facebook", "instagram"]);
  assert.equal(JSON.stringify(listed).includes("page-access-token"), false);
});

test("Instagram Login exchanges and encrypts a long-lived Instagram user token", async () => {
  const repository = new OAuthMemoryRepository();
  const config = createConfig({ metaOAuthMode: "instagram_login" });
  const calls = [];
  const responses = [
    { access_token: "short-lived-instagram-token", user_id: "instagram-1" },
    { access_token: "long-lived-instagram-token", expires_in: 5_184_000 },
    { user_id: "instagram-1", username: "creator" },
  ];
  const service = new OAuthService({
    config,
    repository,
    now: () => new Date("2026-11-04T00:00:00Z"),
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: new URL(url), options });
      return Response.json(responses.shift());
    },
  });
  const state = "i".repeat(43);
  await repository.createOAuthState({
    state,
    provider: "meta",
    expiresAt: new Date("2026-11-04T00:10:00Z"),
  });

  const result = await service.handleCallback("meta", {
    state,
    code: "authorization-code",
  });

  assert.deepEqual(result, [
    { platform: "instagram", accountId: "instagram-1", displayName: "creator" },
  ]);
  assert.equal(calls[0].url.origin, "https://api.instagram.com");
  assert.equal(calls[0].url.pathname, "/oauth/access_token");
  const exchangeBody = new URLSearchParams(calls[0].options.body);
  assert.equal(exchangeBody.get("client_id"), config.metaAppId);
  assert.equal(exchangeBody.get("redirect_uri"), service.callbackUrl("meta"));
  assert.equal(exchangeBody.get("grant_type"), "authorization_code");
  assert.equal(calls[1].url.origin, "https://graph.instagram.com");
  assert.equal(calls[1].url.pathname, "/access_token");
  assert.equal(calls[1].url.searchParams.get("grant_type"), "ig_exchange_token");
  assert.equal(calls[2].url.pathname, "/v99.0/me");
  assert.equal(calls[2].url.searchParams.get("fields"), "user_id,username");
  assert.equal(repository.connections.length, 1);
  assert.equal(repository.connections[0].platform, "instagram");
  assert.equal(
    new TokenVault(config.tokenEncryptionKey).decrypt(
      repository.connections[0].encryptedAccessToken,
    ),
    "long-lived-instagram-token",
  );
  assert.deepEqual(repository.connections[0].scopes, [
    "instagram_business_basic",
    "instagram_business_content_publish",
  ]);
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
  };
  assert.equal(loadConfig(base).publicBaseUrl, "https://reel.example.test");
  assert.equal(
    loadConfig({ ...base, META_GRAPH_API_VERSION: "v19.0" }).metaGraphApiVersion,
    "v27.0",
  );
  assert.equal(
    loadConfig({ ...base, META_GRAPH_API_VERSION: "v27.0" }).metaGraphApiVersion,
    "v27.0",
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
  assert.equal(loadConfig(base).metaGraphApiVersion, "v27.0");
  assert.equal(loadConfig(base).metaOAuthMode, "facebook_login");
  assert.equal(
    loadConfig({ ...base, META_OAUTH_MODE: "facebook_login" }).metaOAuthMode,
    "facebook_login",
  );
  assert.throws(
    () => loadConfig({ ...base, META_OAUTH_MODE: "unified" }),
    /META_OAUTH_MODE/,
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
