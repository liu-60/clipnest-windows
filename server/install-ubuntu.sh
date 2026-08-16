#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  exec sudo -E bash "$0" "$@"
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-/opt/clipnest-cloud}"
DATA_DIR="${DATA_DIR:-/var/lib/clipnest-cloud}"
PROJECT_ID="${PROJECT_ID:-clipnest-windows}"
PUBLIC_HTTP="${CLIPNEST_PUBLIC_HTTP:-0}"

if ! command -v node >/dev/null 2>&1; then
  echo "需要先安装 Node.js 20+" >&2
  exit 1
fi

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if (( node_major < 20 )); then
  echo "Node.js 版本过低：${node_major}，需要 20+" >&2
  exit 1
fi

if ! id clipnest >/dev/null 2>&1; then
  useradd --system --home-dir "${APP_DIR}" --shell /usr/sbin/nologin clipnest
fi

install -d -o clipnest -g clipnest -m 700 "${APP_DIR}" "${DATA_DIR}" "${DATA_DIR}/data"
install -o clipnest -g clipnest -m 600 "${SCRIPT_DIR}/server.mjs" "${SCRIPT_DIR}/create-project.mjs" "${APP_DIR}/"

if [[ "${PUBLIC_HTTP}" == "1" ]]; then
  install -o root -g root -m 644 "${SCRIPT_DIR}/clipnest-cloud-direct.service" \
    /etc/systemd/system/clipnest-cloud.service
else
  install -o root -g root -m 644 "${SCRIPT_DIR}/clipnest-cloud.service" \
    /etc/systemd/system/clipnest-cloud.service
fi

project_file="${DATA_DIR}/projects.json"
if node -e 'const fs=require("fs"); const p=process.argv[1], id=process.argv[2]; if(!fs.existsSync(p)) process.exit(1); const v=JSON.parse(fs.readFileSync(p,"utf8")); process.exit(v[id] ? 0 : 1)' "${project_file}" "${PROJECT_ID}"; then
  echo "PROJECT_EXISTS=${PROJECT_ID}"
else
  echo "正在创建项目 ${PROJECT_ID}，请保存下面的令牌："
  sudo -u clipnest env PROJECTS_FILE="${project_file}" node "${APP_DIR}/create-project.mjs" "${PROJECT_ID}"
fi

chown -R clipnest:clipnest "${DATA_DIR}"
chmod 700 "${DATA_DIR}"
chmod 600 "${project_file}" 2>/dev/null || true
systemctl daemon-reload
systemctl enable --now clipnest-cloud
systemctl --no-pager --full status clipnest-cloud | sed -n '1,12p'
curl --fail --silent --show-error http://127.0.0.1:19132/healthz
echo
echo "ClipNest Cloud 服务已启动。"
