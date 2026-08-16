import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 19132);
const DATA_DIR = resolve(process.env.DATA_DIR || "/var/lib/clipnest-cloud/data");
const PROJECTS_FILE = resolve(process.env.PROJECTS_FILE || "/var/lib/clipnest-cloud/projects.json");
const MAX_BODY_BYTES = 40 * 1024 * 1024;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function loadProjects() {
  if (!existsSync(PROJECTS_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(PROJECTS_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function isAuthorized(projectId, request) {
  const project = loadProjects()[projectId];
  const header = request.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!project || !token || typeof project.tokenHash !== "string") return false;
  const expected = Buffer.from(project.tokenHash, "hex");
  const actual = Buffer.from(hashToken(token), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function projectDirectory(projectId) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(projectId)) return null;
  const base = resolve(DATA_DIR);
  const target = resolve(join(base, projectId));
  if (target !== base && !target.startsWith(`${base}${sep}`)) return null;
  return target;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("request too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid json"), { statusCode: 400 });
  }
}

function snapshotPath(projectId) {
  const directory = projectDirectory(projectId);
  return directory ? join(directory, "snapshot.json") : null;
}

function readSnapshot(projectId) {
  const path = snapshotPath(projectId);
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeSnapshot(projectId, payload) {
  const path = snapshotPath(projectId);
  if (!path) throw Object.assign(new Error("invalid project"), { statusCode: 400 });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
  renameSync(tempPath, path);
}

function isEncryptedPayload(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    value.version === 1 &&
    typeof value.iv === "string" &&
    typeof value.authTag === "string" &&
    typeof value.ciphertext === "string",
  );
}

const server = createServer(async (request, response) => {
  let requestUrl;
  try {
    requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  } catch {
    json(response, 400, { error: "invalid request url" });
    return;
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
      "Access-Control-Allow-Origin": "*",
    });
    response.end();
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/healthz") {
    json(response, 200, { ok: true, service: "clipnest-cloud", version: 1 });
    return;
  }

  const match = requestUrl.pathname.match(/^\/v1\/projects\/([^/]+)\/snapshot$/);
  if (!match) {
    json(response, 404, { error: "not found" });
    return;
  }

  const projectId = decodeURIComponent(match[1]);
  if (!projectDirectory(projectId)) {
    json(response, 400, { error: "invalid project" });
    return;
  }
  if (!isAuthorized(projectId, request)) {
    json(response, 401, { error: "unauthorized" });
    return;
  }

  if (request.method === "GET") {
    const snapshot = readSnapshot(projectId);
    if (!snapshot) {
      json(response, 404, { found: false });
      return;
    }
    json(response, 200, { found: true, ...snapshot });
    return;
  }

  if (request.method === "PUT") {
    try {
      const body = await readBody(request);
      if (body.version !== 1 || !isEncryptedPayload(body.payload)) {
        json(response, 400, { error: "invalid encrypted snapshot" });
        return;
      }
      writeSnapshot(projectId, {
        version: 1,
        updatedAt: typeof body.updatedAt === "number" ? body.updatedAt : Date.now(),
        payload: body.payload,
      });
      json(response, 200, { ok: true, projectId, updatedAt: Date.now() });
      return;
    } catch (error) {
      json(response, error?.statusCode || 500, { error: error?.statusCode === 413 ? "request too large" : "write failed" });
      return;
    }
  }

  json(response, 405, { error: "method not allowed" });
});

mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
mkdirSync(dirname(PROJECTS_FILE), { recursive: true, mode: 0o700 });
server.listen(PORT, HOST, () => {
  console.log(`clipnest-cloud listening on ${HOST}:${PORT}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
