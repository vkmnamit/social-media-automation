import path from "node:path";

const HOUR_IN_MS = 60 * 60 * 1000;

function positiveNumber(env, name, fallback) {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  const supabaseUrl = env.SUPABASE_URL || env.supabase_url;
  const supabaseServiceRoleKey =
    env.SUPABASE_SERVICE_ROLE_KEY || env.supabase_service_role_key;
  if (!supabaseUrl) {
    throw new Error("SUPABASE_URL is required");
  }
  if (!supabaseServiceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
  }
  let parsedSupabaseUrl;
  try {
    parsedSupabaseUrl = new URL(supabaseUrl);
  } catch {
    throw new Error("SUPABASE_URL must be a valid absolute URL");
  }
  if (
    !["https:", "http:"].includes(parsedSupabaseUrl.protocol) ||
    (parsedSupabaseUrl.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(parsedSupabaseUrl.hostname))
  ) {
    throw new Error("SUPABASE_URL must use HTTPS except for localhost");
  }
  if (
    !env.ADMIN_API_TOKEN ||
    env.ADMIN_API_TOKEN.length < 32 ||
    env.ADMIN_API_TOKEN.startsWith("replace-with-")
  ) {
    throw new Error("ADMIN_API_TOKEN must contain at least 32 characters");
  }
  const encryptionKey = Buffer.from(env.TOKEN_ENCRYPTION_KEY || "", "base64");
  if (
    encryptionKey.length !== 32 ||
    encryptionKey.toString("base64").replace(/=+$/, "") !==
      (env.TOKEN_ENCRYPTION_KEY || "").replace(/=+$/, "")
  ) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  const railwayDomain = env.RAILWAY_PUBLIC_DOMAIN?.trim();
  let publicBaseUrlValue = env.PUBLIC_BASE_URL;
  if (env.NODE_ENV === "production" && railwayDomain) {
    let isLocalUrl = false;
    try {
      isLocalUrl = ["localhost", "127.0.0.1", "[::1]"].includes(
        new URL(publicBaseUrlValue).hostname,
      );
    } catch {
      isLocalUrl = false;
    }
    if (!publicBaseUrlValue || isLocalUrl) {
      publicBaseUrlValue = `https://${railwayDomain.replace(/^https?:\/\//, "")}`;
    }
  }

  let publicBaseUrl;
  try {
    publicBaseUrl = new URL(publicBaseUrlValue || "http://localhost:3000");
  } catch {
    throw new Error("PUBLIC_BASE_URL must be a valid absolute URL");
  }
  if (
    !["http:", "https:"].includes(publicBaseUrl.protocol) ||
    (publicBaseUrl.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(publicBaseUrl.hostname)) ||
    publicBaseUrl.pathname !== "/" ||
    publicBaseUrl.username ||
    publicBaseUrl.password ||
    publicBaseUrl.search ||
    publicBaseUrl.hash
  ) {
    throw new Error("PUBLIC_BASE_URL must use HTTPS except for localhost");
  }
  // The configured Meta Login for Business flow is authoritative. Ignore a
  // stale legacy META_OAUTH_MODE variable so it cannot crash production boot.
  const configuredMetaOAuthMode = "facebook_login_business";
  const configuredMetaGraphApiVersion = env.META_GRAPH_API_VERSION || "v26.0";
  const graphVersionMatch = configuredMetaGraphApiVersion.match(/^v\d+\.\d+$/);
  if (!graphVersionMatch) {
    throw new Error("META_GRAPH_API_VERSION must look like vNN.N");
  }
  const metaGraphApiVersion = configuredMetaGraphApiVersion;
  const metaLoginConfigId = env.META_LOGIN_CONFIG_ID || "";
  if (
    configuredMetaOAuthMode === "facebook_login_business" &&
    !metaLoginConfigId
  ) {
    throw new Error(
      "META_LOGIN_CONFIG_ID is required for facebook_login_business mode",
    );
  }
  const metaRedirectUri = env.META_REDIRECT_URI || "";
  if (metaRedirectUri) {
    let parsedMetaRedirectUri;
    try {
      parsedMetaRedirectUri = new URL(metaRedirectUri);
    } catch {
      throw new Error("META_REDIRECT_URI must be a valid absolute URL");
    }
    if (
      !["https:", "http:"].includes(parsedMetaRedirectUri.protocol) ||
      (parsedMetaRedirectUri.protocol === "http:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(parsedMetaRedirectUri.hostname)) ||
      parsedMetaRedirectUri.pathname !== "/oauth/meta/callback" ||
      parsedMetaRedirectUri.username ||
      parsedMetaRedirectUri.password ||
      parsedMetaRedirectUri.search ||
      parsedMetaRedirectUri.hash
    ) {
      throw new Error("META_REDIRECT_URI must be the HTTPS Meta callback URL");
    }
  }

  const maxStorageGb = positiveNumber(env, "MAX_STORAGE_GB", 10);
  const maxSafeBytes = Number.MAX_SAFE_INTEGER;
  if (maxStorageGb > maxSafeBytes / 1024 ** 3) {
    throw new Error("MAX_STORAGE_GB exceeds the supported size");
  }

  const maxStorageBytes = Math.floor(maxStorageGb * 1024 ** 3);
  const maxUploadBytes = Math.floor(
    positiveNumber(env, "MAX_UPLOAD_MB", 500) * 1024 ** 2,
  );
  const maxTranscodeBytes = Math.floor(
    positiveNumber(env, "MAX_TRANSCODE_MB", 500) * 1024 ** 2,
  );
  const port = positiveNumber(env, "PORT", 3000);
  if (!Number.isSafeInteger(port) || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  if (maxUploadBytes > maxStorageBytes || maxTranscodeBytes > maxStorageBytes) {
    throw new Error("Upload and transcode limits cannot exceed MAX_STORAGE_GB");
  }

  return Object.freeze({
    supabaseUrl: parsedSupabaseUrl.origin,
    supabaseServiceRoleKey,
    supabaseMediaBucket: env.SUPABASE_MEDIA_BUCKET || "autoreel-publishing",
    adminApiToken: env.ADMIN_API_TOKEN,
    tokenEncryptionKey: encryptionKey,
    publicBaseUrl: publicBaseUrl.origin,
    metaAppId: env.META_APP_ID || "",
    metaAppSecret: env.META_APP_SECRET || "",
    metaLoginConfigId,
    metaRedirectUri,
    metaOAuthMode: configuredMetaOAuthMode,
    metaGraphApiVersion,
    googleClientId: env.youtube_client_id || env.GOOGLE_CLIENT_ID || "",
    googleClientSecret: env.youtube_client_secret || env.GOOGLE_CLIENT_SECRET || "",
    googleRedirectUri: env.youtube_redirect_uri || "",
    port,
    storageDir: path.resolve(env.STORAGE_DIR || "./storage"),
    maxStorageBytes,
    maxUploadBytes,
    maxTranscodeBytes,
    ffmpegPath: env.FFMPEG_PATH || "ffmpeg",
    ffprobePath: env.FFPROBE_PATH || "ffprobe",
    temporaryRetentionMs:
      positiveNumber(env, "TEMP_RETENTION_HOURS", 2) * HOUR_IN_MS,
    publishedRetentionMs:
      positiveNumber(env, "PUBLISHED_RETENTION_HOURS", 24) * HOUR_IN_MS,
    failedRetentionMs:
      positiveNumber(env, "FAILED_RETENTION_HOURS", 48) * HOUR_IN_MS,
    cleanupIntervalMs:
      positiveNumber(env, "CLEANUP_INTERVAL_MINUTES", 15) * 60 * 1000,
  });
}
