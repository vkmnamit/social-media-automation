import assert from "node:assert/strict";
import test from "node:test";
import { SupabaseAssetRepository } from "../src/storage/supabase-repository.js";

test("asset lifecycle changes use the atomic Supabase transition function", async () => {
  const calls = [];
  const repository = new SupabaseAssetRepository({
    async rpc(name, args) {
      calls.push({ name, args });
      return { data: true, error: null };
    },
  });
  const processedAt = new Date("2026-11-06T00:00:00.000Z");

  assert.equal(
    await repository.markProcessingComplete("asset-1", processedAt),
    true,
  );
  assert.equal(calls[0].name, "autoreel_patch_asset");
  assert.deepEqual(calls[0].args.p_expected_statuses, ["processing"]);
  assert.equal(calls[0].args.p_columns.status, "processed");
  assert.equal(
    calls[0].args.p_columns.processed_at,
    processedAt.toISOString(),
  );
});

test("OAuth upsert stores provider credentials in private row data", async () => {
  let upsert;
  const query = {
    async upsert(rows, options) {
      upsert = { rows, options };
      return { error: null };
    },
  };
  const repository = new SupabaseAssetRepository({
    from(table) {
      assert.equal(table, "oauth_connections");
      return query;
    },
  });

  await repository.saveOAuthConnections([
    {
      connectionId: "connection-1",
      provider: "google",
      platform: "youtube",
      accountId: "channel-1",
      displayName: "My channel",
      encryptedRefreshToken: { ciphertext: "encrypted" },
      connectedAt: new Date("2026-11-06T00:00:00Z"),
    },
  ]);

  assert.equal(upsert.options.onConflict, "platform,account_id");
  assert.equal(upsert.rows[0].id, "youtube:channel-1");
  assert.equal(
    upsert.rows[0].data.encryptedRefreshToken.ciphertext,
    "encrypted",
  );
});

test("repository reports Supabase schema errors with migration guidance", async () => {
  const repository = new SupabaseAssetRepository({
    from() {
      return {
        select() {
          return {
            limit: async () => ({
              error: { message: "relation assets does not exist" },
            }),
          };
        },
      };
    },
  });

  await assert.rejects(
    repository.initialize(),
    /Apply supabase\/schema\.sql/,
  );
});
