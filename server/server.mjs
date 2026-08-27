import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 19132);
const DATA_DIR = resolve(process.env.DATA_DIR || "/var/lib/clipnest-cloud/data");
const PROJECTS_FILE = resolve(process.env.PROJECTS_FILE || "/var/lib/clipnest-cloud/projects.json");
const MAX_BODY_BYTES = 40 * 1024 * 1024;
const WEB_ROOT = resolve(process.env.WEB_ROOT || join(dirname(fileURLToPath(import.meta.url)), "web"));
const WEB_PROJECT_ID = process.env.WEB_PROJECT_ID || "clipnest-windows";
const WEB_PASSWORD_HASH = (process.env.WEB_PASSWORD_HASH || "").trim().toLowerCase();
const WEB_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const WEB_SNAPSHOT_FILE = "web-snapshot.json";
const sessions = new Map();
const loginFailures = new Map();

const STATIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/app.js", "app.js"],
  ["/styles.css", "styles.css"],
]);

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

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

function secretsMatch(value, expectedHash) {
  if (!value || !/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(hashToken(value), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function webPasswordConfigured() {
  return /^[a-f0-9]{64}$/.test(WEB_PASSWORD_HASH);
}

function clientAddress(request) {
  return request.headers["x-forwarded-for"]?.split(",", 1)[0]?.trim() || request.socket.remoteAddress || "unknown";
}

function webCookieSecure(request) {
  return request.headers["x-forwarded-proto"] === "https" || process.env.COOKIE_SECURE === "1";
}

function readCookie(request, name) {
  const cookies = String(request.headers.cookie || "").split(";");
  const prefix = `${name}=`;
  const value = cookies.find((cookie) => cookie.trim().startsWith(prefix));
  return value ? decodeURIComponent(value.trim().slice(prefix.length)) : "";
}

function setSessionCookie(response, request, token, maxAge = Math.floor(WEB_SESSION_TTL_MS / 1000)) {
  const secure = webCookieSecure(request) ? "; Secure" : "";
  response.setHeader("Set-Cookie", `clipnest_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`);
}

function authenticatedWebSession(request) {
  const token = readCookie(request, "clipnest_session");
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  sessions.set(token, Date.now() + WEB_SESSION_TTL_MS);
  return true;
}

function webProjectConfigured() {
  return Boolean(projectDirectory(WEB_PROJECT_ID));
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

function projectFilePath(projectId, fileName) {
  const directory = projectDirectory(projectId);
  return directory ? join(directory, fileName) : null;
}

function readProjectFile(projectId, fileName) {
  const path = projectFilePath(projectId, fileName);
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeProjectFile(projectId, fileName, payload) {
  const path = projectFilePath(projectId, fileName);
  if (!path) throw Object.assign(new Error("invalid project"), { statusCode: 400 });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
  renameSync(tempPath, path);
}

function readSnapshot(projectId) {
  return readProjectFile(projectId, "snapshot.json");
}

function writeSnapshot(projectId, payload) {
  writeProjectFile(projectId, "snapshot.json", payload);
}

function readWebSnapshot(projectId) {
  return readProjectFile(projectId, WEB_SNAPSHOT_FILE);
}

function writeWebSnapshot(projectId, payload) {
  writeProjectFile(projectId, WEB_SNAPSHOT_FILE, payload);
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

function isWebEncryptedPayload(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    value.version === 1 &&
    value.algorithm === "aes-256-gcm" &&
    value.kdf === "pbkdf2-sha256" &&
    Number.isInteger(value.iterations) &&
    value.iterations >= 100_000 &&
    value.iterations <= 300_000 &&
    typeof value.salt === "string" &&
    typeof value.iv === "string" &&
    typeof value.authTag === "string" &&
    typeof value.ciphertext === "string",
  );
}

function serveStatic(requestUrl, response) {
  const relativeName = STATIC_FILES.get(requestUrl.pathname);
  if (!relativeName) return false;
  const path = resolve(WEB_ROOT, relativeName);
  if (!path.startsWith(`${WEB_ROOT}${sep}`) && path !== WEB_ROOT) return false;
  if (!existsSync(path)) return false;
  const body = readFileSync(path);
  const extension = relativeName.slice(relativeName.lastIndexOf("."));
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Length": body.byteLength,
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "Content-Type": CONTENT_TYPES[extension] || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
  return true;
}

async function handleWebApi(request, response, requestUrl) {
  if (request.method === "POST" && requestUrl.pathname === "/api/auth/login") {
    if (!webPasswordConfigured() || !webProjectConfigured()) {
      json(response, 503, { error: "网页服务尚未配置" });
      return true;
    }
    const address = clientAddress(request);
    const attempt = loginFailures.get(address);
    if (attempt && attempt.resetAt <= Date.now()) loginFailures.delete(address);
    const currentAttempt = loginFailures.get(address);
    if (currentAttempt && currentAttempt.count >= 8) {
      json(response, 429, { error: "登录尝试过多，请稍后再试" });
      return true;
    }
    try {
      const body = await readBody(request);
      const password = typeof body.password === "string" ? body.password : "";
      if (!secretsMatch(password, WEB_PASSWORD_HASH)) {
        const next = currentAttempt && currentAttempt.resetAt > Date.now()
          ? { count: currentAttempt.count + 1, resetAt: currentAttempt.resetAt }
          : { count: 1, resetAt: Date.now() + 10 * 60 * 1000 };
        loginFailures.set(address, next);
        json(response, 401, { error: "密码错误" });
        return true;
      }
      loginFailures.delete(address);
      const session = randomBytes(32).toString("base64url");
      sessions.set(session, Date.now() + WEB_SESSION_TTL_MS);
      setSessionCookie(response, request, session);
      json(response, 200, { authenticated: true, projectId: WEB_PROJECT_ID });
      return true;
    } catch (error) {
      json(response, error?.statusCode || 400, { error: "登录请求无效" });
      return true;
    }
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/auth/session") {
    json(response, 200, {
      authenticated: authenticatedWebSession(request),
      projectId: WEB_PROJECT_ID,
    });
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/auth/logout") {
    const session = readCookie(request, "clipnest_session");
    if (session) sessions.delete(session);
    setSessionCookie(response, request, "", 0);
    json(response, 200, { authenticated: false });
    return true;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/web-snapshot") {
    if (!authenticatedWebSession(request)) {
      json(response, 401, { error: "unauthorized" });
      return true;
    }
    const snapshot = readWebSnapshot(WEB_PROJECT_ID);
    if (!snapshot) {
      json(response, 200, { found: false, projectId: WEB_PROJECT_ID });
      return true;
    }
    json(response, 200, { found: true, projectId: WEB_PROJECT_ID, ...snapshot });
    return true;
  }

  return false;
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
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Origin": "*",
    });
    response.end();
    return;
  }

  if (await handleWebApi(request, response, requestUrl)) return;

  if (request.method === "GET" && requestUrl.pathname === "/healthz") {
    json(response, 200, { ok: true, service: "clipnest-cloud", version: 1 });
    return;
  }

  if (request.method === "GET" && serveStatic(requestUrl, response)) return;

  const match = requestUrl.pathname.match(/^\/v1\/projects\/([^/]+)\/(snapshot|web-snapshot)$/);
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
    const snapshot = match[2] === "web-snapshot"
      ? readWebSnapshot(projectId)
      : readSnapshot(projectId);
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
      const isWebSnapshot = match[2] === "web-snapshot";
      const validPayload = isWebSnapshot
        ? isWebEncryptedPayload(body.payload)
        : isEncryptedPayload(body.payload);
      if (body.version !== 1 || !validPayload) {
        json(response, 400, { error: isWebSnapshot ? "invalid encrypted web snapshot" : "invalid encrypted snapshot" });
        return;
      }
      const payload = {
        version: 1,
        updatedAt: typeof body.updatedAt === "number" ? body.updatedAt : Date.now(),
        payload: body.payload,
      };
      if (isWebSnapshot) writeWebSnapshot(projectId, payload);
      else writeSnapshot(projectId, payload);
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
