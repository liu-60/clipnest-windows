const $ = (selector) => document.querySelector(selector);
const loginView = $("#login-view");
const appView = $("#app-view");
const loginForm = $("#login-form");
const passwordInput = $("#password");
const loginError = $("#login-error");
const cards = $("#cards");
const searchInput = $("#search");
const itemCount = $("#item-count");
const syncTime = $("#sync-time");
const status = $("#status");
const toast = $("#toast");
let sessionPassword = "";
let allItems = [];
let toastTimer;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2200);
}

function base64UrlBytes(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function decryptSnapshot(payload, password) {
  if (!payload || payload.version !== 1 || payload.algorithm !== "aes-256-gcm" || payload.kdf !== "pbkdf2-sha256") {
    throw new Error("网页快照格式不兼容");
  }
  if (!globalThis.crypto?.subtle) throw new Error("当前浏览器不支持安全解密，请使用 HTTPS 地址");
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: base64UrlBytes(payload.salt), iterations: payload.iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const ciphertext = base64UrlBytes(payload.ciphertext);
  const authTag = base64UrlBytes(payload.authTag);
  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext);
  combined.set(authTag, ciphertext.length);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlBytes(payload.iv), tagLength: 128 },
    key,
    combined,
  );
  const snapshot = JSON.parse(new TextDecoder().decode(plaintext));
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.items)) throw new Error("网页快照内容无效");
  return snapshot;
}

async function api(path, init = {}) {
  const response = await fetch(path, { ...init, credentials: "include", headers: { "Content-Type": "application/json", ...(init.headers || {}) } });
  let payload = {};
  try { payload = await response.json(); } catch { /* empty response */ }
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function typeLabel(type) {
  return type === "image" ? "图片" : type === "link" ? "链接" : "文本";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  if (!document.execCommand("copy")) throw new Error("浏览器拒绝了复制操作");
  textarea.remove();
}

async function copyImage(dataUrl) {
  if (!navigator.clipboard?.write || !globalThis.ClipboardItem) throw new Error("图片复制需要 HTTPS 浏览器权限");
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
}

async function copyItem(item) {
  try {
    if (item.type === "image") await copyImage(item.content);
    else await copyText(item.content);
    showToast("已复制到系统剪切板");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "复制失败");
  }
}

function createCard(item, index) {
  const card = document.createElement("article");
  card.className = `cloud-card type-${item.type}${item.pinned ? " is-favorite" : ""}`;
  const header = document.createElement("header");
  header.className = `card-header type-${item.type}`;
  const title = document.createElement("div");
  title.className = "card-title";
  const label = document.createElement("strong");
  label.textContent = typeLabel(item.type);
  const time = document.createElement("span");
  time.textContent = formatTime(item.updatedAt || item.createdAt);
  title.append(label, time);
  const badge = document.createElement("span");
  badge.className = "type-badge";
  badge.textContent = item.pinned ? "常用" : `#${String(index + 1).padStart(2, "0")}`;
  header.append(title, badge);

  const content = document.createElement("div");
  content.className = "card-content";
  if (item.type === "image" && /^data:image\//i.test(item.content)) {
    const image = document.createElement("img");
    image.src = item.content;
    image.alt = item.preview || "剪切板图片";
    image.loading = "lazy";
    content.append(image);
  } else {
    const text = document.createElement("p");
    text.textContent = item.type === "image" ? item.preview : item.content;
    content.append(text);
  }

  const footer = document.createElement("footer");
  const size = document.createElement("span");
  size.textContent = item.type === "image" ? `${item.width || 0} × ${item.height || 0}` : formatBytes(item.byteSize);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy-button";
  copy.textContent = "复制";
  copy.addEventListener("click", () => void copyItem(item));
  footer.append(size, copy);
  card.append(header, content, footer);
  return card;
}

function renderItems() {
  const query = searchInput.value.trim().toLowerCase();
  const visible = allItems.filter((item) => {
    const text = `${item.content || ""} ${item.preview || ""} ${(item.tags || []).join(" ")}`.toLowerCase();
    return !query || text.includes(query);
  });
  cards.replaceChildren(...visible.map(createCard));
  itemCount.textContent = `${visible.length} 条内容`;
  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = query ? "没有匹配内容" : "还没有可展示的云端剪切板内容";
    cards.append(empty);
  }
}

async function loadSnapshot() {
  status.textContent = "正在读取加密快照…";
  const response = await api("api/web-snapshot");
  if (!response.found) {
    allItems = [];
    status.textContent = "尚未上传网页快照：请在桌面端设置云端地址、令牌和网页登录密码后同步。";
    renderItems();
    return;
  }
  const snapshot = await decryptSnapshot(response.payload, sessionPassword);
  allItems = snapshot.items.filter((item) => item && typeof item.content === "string");
  syncTime.textContent = snapshot.updatedAt ? `同步于 ${formatTime(snapshot.updatedAt)} · 浏览器端解密` : "浏览器端解密";
  status.textContent = "内容只在当前浏览器内解密，服务器保存的是密文。";
  renderItems();
}

function showApp() {
  loginView.hidden = true;
  appView.hidden = false;
}

function showLogin(message = "") {
  appView.hidden = true;
  loginView.hidden = false;
  loginError.textContent = message;
  passwordInput.focus();
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  const password = passwordInput.value;
  try {
    await api("api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
    sessionPassword = password;
    passwordInput.value = "";
    showApp();
    await loadSnapshot();
  } catch (error) {
    sessionPassword = "";
    loginError.textContent = error instanceof Error ? error.message : "登录失败";
  }
});

$("#logout").addEventListener("click", async () => {
  try { await api("api/auth/logout", { method: "POST" }); } catch { /* logout locally even if network is gone */ }
  sessionPassword = "";
  allItems = [];
  showLogin();
});

searchInput.addEventListener("input", renderItems);

async function boot() {
  try {
    const session = await api("api/auth/session");
    if (session.authenticated) {
      // The password is intentionally not persisted, so a reload asks again.
      showLogin("请重新输入网页登录密码");
      return;
    }
    showLogin();
  } catch (error) {
    showLogin(error instanceof Error ? error.message : "网页服务暂不可用");
  }
}

void boot();
