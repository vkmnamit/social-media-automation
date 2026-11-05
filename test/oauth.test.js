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
  assert.equal(loadConfig(base).metaGraphApiVersion, "v26.0");
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
