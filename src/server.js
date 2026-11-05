import { randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StorageLimitError } from "./storage/manager.js";
import { getAssetFilePath, processVideo } from "./video/processor.js";

const VIDEO_TYPES = new Map([
  ["video/mp4", ".mp4"],
  ["video/quicktime", ".mov"],
  ["video/webm", ".webm"],
  ["video/x-matroska", ".mkv"],
]);

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function getErrorStatus(error) {
  if (error.statusCode) return error.statusCode;
  if (error instanceof StorageLimitError) return 413;
  return 500;
}

function isAuthorized(request, token) {
  const authorization = request.headers.authorization || "";
  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix)) return false;
  const provided = Buffer.from(authorization.slice(prefix.length));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function readJson(request, maxBytes = 32 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("Request body is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.statusCode = 400;
    throw error;
  }
}

function serializeAsset(asset) {
  return {
    id: asset._id,
    kind: asset.kind,
    status: asset.status,
    originalName: asset.originalName,
    caption: asset.caption || "",
    hashtags: asset.hashtags || [],
    posts: asset.posts || [],
    createdAt: asset.createdAt,
    processedAt: asset.processedAt || null,
    durationSeconds: asset.durationSeconds || null,
    failureMessage: asset.failureMessage || null,
  };
}

function validateMetadata({ caption = "", hashtags = [] }) {
  if (typeof caption !== "string" || caption.length > 2200) {
    const error = new Error("Caption must be a string of 2200 characters or fewer");
    error.statusCode = 400;
    throw error;
  }
  if (
    !Array.isArray(hashtags) ||
    hashtags.length > 30 ||
    hashtags.some(
      (tag) =>
        typeof tag !== "string" ||
        tag.length > 100 ||
        !/^[#\p{L}\p{N}_]+$/u.test(tag.replace(/^#/, "")),
    )
  ) {
    const error = new Error("Hashtags must be an array of up to 30 valid tags");
    error.statusCode = 400;
    throw error;
  }
  return {
    caption: caption.trim(),
    hashtags: hashtags.map((tag) => `#${tag.trim().replace(/^#/, "")}`),
  };
}

function fileNameFromHeader(value) {
  if (typeof value !== "string") return "video";
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    decoded = value;
  }
  return path
    .basename(decoded.replace(/[\u0000-\u001f\u007f]/g, ""))
    .slice(0, 180) || "video";
}

export function createApiServer({
  config,
  repository,
  storage,
  oauthService,
  logger = console,
}) {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { status: "ok" });
      }

      if (url.pathname === "/" && request.method === "GET") {
        const page = await readFile(new URL("../public/index.html", import.meta.url));
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        response.end(page);
        return;
      }

      const callbackRoute = url.pathname.match(/^\/oauth\/(meta|google)\/callback$/);
      if (request.method === "GET" && callbackRoute) {
        if (!oauthService) {
          response.writeHead(303, { location: "/?oauth_error=unavailable" });
          response.end();
          return;
        }
        try {
          const connections = await oauthService.handleCallback(
            callbackRoute[1],
            {
              state: url.searchParams.get("state"),
              code: url.searchParams.get("code"),
              error:
                url.searchParams.get("error") ||
                url.searchParams.get("error_reason"),
            },
          );
          const redirect = new URL("/", config.publicBaseUrl);
          redirect.searchParams.set("connected", callbackRoute[1]);
          redirect.searchParams.set("accounts", String(connections.length));
          response.writeHead(303, {
            location: redirect.toString(),
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          });
          response.end();
        } catch (error) {
          logger.error?.("OAuth callback failed", {
            provider: callbackRoute[1],
            errorName: error.name,
          });
          const redirect = new URL("/", config.publicBaseUrl);
          redirect.searchParams.set("oauth_error", "connection_failed");
          response.writeHead(303, {
            location: redirect.toString(),
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          });
          response.end();
        }
        return;
      }

      if (!url.pathname.startsWith("/api/")) {
        return sendJson(response, 404, { error: "Not found" });
      }
      if (!isAuthorized(request, config.adminApiToken)) {
        return sendJson(response, 401, { error: "Authentication required" });
      }

      if (request.method === "GET" && url.pathname === "/api/assets") {
        const assets = await repository.listAssets();
        return sendJson(response, 200, { assets: assets.map(serializeAsset) });
      }

      if (request.method === "GET" && url.pathname === "/api/storage") {
        return sendJson(response, 200, await storage.getStorageStatus());
      }

      if (request.method === "GET" && url.pathname === "/api/analytics") {
        const publishedStats = await analyticsDashboard.getPublishedStats();
        const failureStats = await analyticsDashboard.getFailureStats();
        const storageStats = await analyticsDashboard.getStorageStats();
        const platformStats = await analyticsDashboard.getPlatformStats();
        const recentPosts = await analyticsDashboard.getRecentPosts(20);
        return sendJson(response, 200, {
          published: publishedStats,
          failures: failureStats,
          storage: storageStats,
          platforms: platformStats,
          recentPosts,
        });
      }

      if (request.method === "GET" && url.pathname === "/api/connections") {
        if (!oauthService) {
          return sendJson(response, 503, { error: "OAuth is not configured" });
        }
        return sendJson(response, 200, {
          connections: await oauthService.listConnections(),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/accounts") {
        if (!multiAccountManager) {
          return sendJson(response, 503, { error: "Multi-account manager is not configured" });
        }
        const connections = await multiAccountManager.listConnections();
        return sendJson(response, 200, { connections });
      }

      if (request.method === "GET" && url.pathname === "/api/accounts/health") {
        if (!multiAccountManager) {
          return sendJson(response, 503, { error: "Multi-account manager is not configured" });
        }
        return sendJson(response, 200, {
          schedulerRunning: multiAccountManager.isSchedulerRunning(),
        });
      }

      const oauthStartRoute = url.pathname.match(
        /^\/api\/oauth\/(meta|google)\/start$/,
      );
      if (request.method === "POST" && oauthStartRoute) {
        if (!oauthService) {
          return sendJson(response, 503, { error: "OAuth is not configured" });
        }
        const authorizationUrl = await oauthService.createAuthorizationUrl(
          oauthStartRoute[1],
        );
        return sendJson(response, 200, { authorizationUrl });
      }

      if (request.method === "POST" && url.pathname === "/api/assets") {
        const contentLength = Number(request.headers["content-length"]);
        if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
          return sendJson(response, 411, { error: "A positive Content-Length is required" });
        }
        if (contentLength > config.maxUploadBytes) {
          return sendJson(response, 413, { error: "Video exceeds MAX_UPLOAD_MB" });
        }

        const contentType = (request.headers["content-type"] || "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        const extension = VIDEO_TYPES.get(contentType);
        if (!extension) {
          return sendJson(response, 415, { error: "Unsupported video format" });
        }

        const reservation = await storage.reserveCapacity(contentLength);
        const assetId = randomUUID();
        const directory = path.join(config.storageDir, "original");
        const temporaryPath = path.join(directory, `${assetId}.upload`);
        const relativePath = path.posix.join("original", `${assetId}${extension}`);
        const finalPath = getAssetFilePath(config.storageDir, relativePath);
        let receivedBytes = 0;

        try {
          await mkdir(directory, { recursive: true });
          const limiter = new Transform({
            transform(chunk, encoding, callback) {
              receivedBytes += chunk.length;
              if (receivedBytes > config.maxUploadBytes || receivedBytes > contentLength) {
                const error = new Error("Upload exceeded its declared size");
                error.statusCode = 400;
                callback(error);
                return;
              }
              callback(null, chunk);
            },
            flush(callback) {
              if (receivedBytes !== contentLength) {
                const error = new Error("Upload size did not match Content-Length");
                error.statusCode = 400;
                callback(error);
                return;
              }
              callback();
            },
          });
          await pipeline(
            request,
            limiter,
            createWriteStream(temporaryPath, { flags: "wx" }),
          );
          await rename(temporaryPath, finalPath);
          await repository.addAsset({
            assetId,
            kind: "original",
            localPath: relativePath,
            localPaths: [relativePath],
            originalName: fileNameFromHeader(request.headers["x-video-name"]),
            mimeType: contentType,
            caption: "",
            hashtags: [],
            posts: [],
            status: "uploaded",
            createdAt: new Date(),
          });
        } catch (error) {
          await rm(temporaryPath, { force: true });
          await rm(finalPath, { force: true });
          throw error;
        } finally {
          storage.releaseCapacity(reservation.reservationId);
        }

        const asset = await repository.getAsset(assetId);
        return sendJson(response, 201, { asset: serializeAsset(asset) });
      }

      const assetRoute = url.pathname.match(/^\/api\/assets\/([^/]+)(?:\/(process))?$/);
      if (assetRoute && request.method === "POST" && assetRoute[2] === "process") {
        const assetId = decodeURIComponent(assetRoute[1]);
        const asset = await repository.getAsset(assetId);
        if (!asset) return sendJson(response, 404, { error: "Video not found" });
        const claimed = await repository.claimProcessing(assetId);
        if (!claimed) {
          return sendJson(response, 409, { error: "Video is not ready to process" });
        }

        const outputPath = path.posix.join("edited", `${assetId}.mp4`);
        const absoluteOutputPath = getAssetFilePath(config.storageDir, outputPath);
        const absoluteInputPath = getAssetFilePath(config.storageDir, asset.localPath);
        let reservation;
        try {
          reservation = await storage.reserveCapacity(config.maxTranscodeBytes);
          await mkdir(path.dirname(absoluteOutputPath), { recursive: true });
          const processed = await processVideo({
            ffmpegPath: config.ffmpegPath,
            ffprobePath: config.ffprobePath,
            inputPath: absoluteInputPath,
            outputPath: absoluteOutputPath,
            maxOutputBytes: config.maxTranscodeBytes,
          });
          const completed = await repository.completeProcessing(assetId, {
            sourcePath: asset.localPath,
            outputPath,
            durationSeconds: processed.durationSeconds,
          });
          if (!completed) {
            throw new Error("Could not save processing result");
          }
        } catch (error) {
          await rm(absoluteOutputPath, { force: true });
          await repository.failProcessing(
            assetId,
            `Processing failed: ${String(error.message).slice(0, 400)}`,
          );
          throw error;
        } finally {
          if (reservation) {
            storage.releaseCapacity(reservation.reservationId);
          }
        }

        return sendJson(response, 200, {
          asset: serializeAsset(await repository.getAsset(assetId)),
        });
      }

      if (assetRoute && request.method === "POST" && assetRoute[2] === "publish") {
        const assetId = decodeURIComponent(assetRoute[1]);
        const asset = await repository.getAsset(assetId);
        if (!asset) {
          return sendJson(response, 404, { error: "Video not found" });
        }

        if (asset.status !== "processed") {
          return sendJson(response, 409, {
            error: "Video is not ready to publish. Current status: " + asset.status,
          });
        }

        const connection = await repository.getConnection(assetId);
        if (!connection) {
          return sendJson(response, 400, { error: "No publishing connection found" });
        }

        const publisher = await repository.getPublisher(asset.platform);
        if (!publisher) {
          return sendJson(response, 400, { error: "No publisher for platform" });
        }

        let result;
        try {
          result = await publisher.publishToPlatform(
            asset,
            asset.platform,
            connection
          );
        } catch (error) {
          if (error instanceof PublishingError) {
            await repository.markPublishingFailed(
              assetId,
              error.message,
              error.retryable,
              new Date(),
            );
            return sendJson(response, 502, {
              error: error.message,
              retryable: error.retryable,
            });
          }
          throw error;
        }

        const verification = await publisher.verifyPublication(asset, result);
        if (!verification.verified) {
          return sendJson(response, 502, {
            error: "Publication verification failed",
          });
        }

        await repository.markPublished(assetId, {
          platform: result.platform,
          postId: result.postId,
          caption: result.caption,
          hashtagString: result.hashtagString,
          publishedAt: result.publishedAt,
        }, result.publishedAt);

        await repository.cleanupLocalFiles(assetId);

        return sendJson(response, 200, {
          asset: serializeAsset(await repository.getAsset(assetId)),
          result,
        });
      }

      if (assetRoute && request.method === "POST" && assetRoute[2] === "retry") {
        const assetId = decodeURIComponent(assetRoute[1]);
        const asset = await repository.getAsset(assetId);
        if (!asset) {
          return sendJson(response, 404, { error: "Video not found" });
        }
        if (asset.status !== "upload_failed") {
          return sendJson(response, 409, {
            error: "Video is not in a failed state. Current status: " + asset.status,
          });
        }
        const connection = await repository.getConnection(assetId);
        if (!connection) {
          return sendJson(response, 400, { error: "No connection found" });
        }

        const publisher = await repository.getPublisher(asset.platform);
        if (!publisher) {
          return sendJson(response, 400, { error: "No publisher for platform" });
        }

        try {
          const result = await publisher.publishToPlatform(
            asset,
            asset.platform,
            connection
          );

          await repository.markPublished(assetId, {
            platform: result.platform,
            postId: result.postId,
            caption: result.caption,
            hashtagString: result.hashtagString,
            publishedAt: result.publishedAt,
          }, result.publishedAt);

          await repository.cleanupLocalFiles(assetId);

          return sendJson(response, 200, {
            asset: serializeAsset(await repository.getAsset(assetId)),
            result,
          });
        } catch (error) {
          if (error instanceof PublishingError) {
            await repository.markPublishingFailed(
              assetId,
              error.message,
              error.retryable,
              new Date(),
            );
            return sendJson(response, 502, {
              error: error.message,
              retryable: error.retryable,
            });
          }
          throw error;
        }
      }
    } catch (error) {
      logger.error?.("API request failed", {
        method: request.method,
        path: request.url,
        error,
      });
      if (!response.headersSent) {
        sendJson(response, getErrorStatus(error), {
          error: getErrorStatus(error) === 500 ? "Request failed" : error.message,
        });
      } else {
        response.destroy(error);
      }
    }
  });
}
