# ClipNest Cloud 服务

这是 ClipNest 的轻量云端快照服务。客户端先在本地使用 AES-256-GCM 加密剪切板历史，服务端只保存密文；每个项目使用独立项目令牌，并写入独立的 `data/<projectId>/snapshot.json`，避免不同项目串数据。

服务同时提供一个密码保护的 PC/移动端网页。网页快照使用配置页的“网页登录密码”在桌面端加密，浏览器登录后才在本地解密；服务端不会拿到剪切板明文或项目令牌。

## 快速部署

服务器要求 Ubuntu 22.04+、Node.js 20+ 和 systemd。把 `server/` 目录上传到服务器后执行：

```bash
cd /path/to/server
PROJECT_ID=clipnest-windows sudo -E bash install-ubuntu.sh
```

首次部署网页时，把网页登录密码通过环境变量传给安装脚本（密码不会写入仓库）：

```bash
WEB_PASSWORD='请替换为你的网页密码' PROJECT_ID=clipnest-windows sudo -E bash install-ubuntu.sh
```

安装脚本会把密码保存为 `/etc/clipnest-cloud/web.env` 中的 SHA-256 哈希，权限为 `600`。后续升级代码时不再传 `WEB_PASSWORD`，已有密码会保留。

默认模式只监听 `127.0.0.1:19132`，适合由 Caddy/Nginx 反向代理并提供 HTTPS。

当前只有 IP、还没有域名证书时，可以临时使用直连 HTTP：

```bash
cd /path/to/server
PROJECT_ID=clipnest-windows CLIPNEST_PUBLIC_HTTP=1 sudo -E bash install-ubuntu.sh
```

验收环境可通过 Caddy/Nginx 反向代理 `/clipnest/*`、`/healthz` 和 `/v1/*`，ClipNest 服务本身只监听 `127.0.0.1:19132`。正式公网使用请绑定域名并配置 HTTPS；网页复制能力和移动端浏览器的剪贴板权限也依赖 HTTPS。

安装脚本首次创建项目时会在终端输出一次：

```text
PROJECT_ID=clipnest-windows
PROJECT_TOKEN=只显示一次的令牌
```

令牌只保存哈希，无法从服务器反查。遗失令牌时执行以下命令轮换，并把新令牌重新填入客户端：

```bash
sudo -u clipnest env PROJECTS_FILE=/var/lib/clipnest-cloud/projects.json \
  node /opt/clipnest-cloud/create-project.mjs clipnest-windows --rotate
```

## HTTPS 反向代理

复制 `Caddyfile.example` 的站点配置，把 `cloud.example.com` 换成自己的域名。Caddy 会自动申请证书：

```caddyfile
cloud.example.com {
    redir /clipnest /clipnest/ permanent
    handle_path /clipnest/* {
        reverse_proxy 127.0.0.1:19132
    }
}
```

网页地址为 `https://cloud.example.com/clipnest/`；桌面端云端地址填写 `https://cloud.example.com/clipnest`，不要再填写 `:19132`。

桌面端配置页还需要填写与 `WEB_PASSWORD` 相同的“网页登录密码”。启用云端后，普通云端快照用于多设备同步；网页快照用于登录后展示。编辑带“常用”标签的内容会同步其新文本、常用状态和旧内容删除标记，因此其他设备也会看到修改后的常用内容。

## API

- `GET /healthz`：服务健康检查，不需要令牌。
- `GET /v1/projects/<projectId>/snapshot`：读取项目密文快照。
- `PUT /v1/projects/<projectId>/snapshot`：原子写入项目密文快照。
- `GET /v1/projects/<projectId>/web-snapshot`：读取网页密文快照（项目令牌）。
- `PUT /v1/projects/<projectId>/web-snapshot`：原子写入网页密文快照（项目令牌）。
- `POST /api/auth/login`、`GET /api/auth/session`、`POST /api/auth/logout`：网页会话。
- `GET /api/web-snapshot`：登录后读取固定 `WEB_PROJECT_ID` 的网页密文快照。

项目接口必须带 `Authorization: Bearer <project-token>`。服务端不记录请求体和令牌。项目数据位于 `/var/lib/clipnest-cloud/data/<projectId>/snapshot.json` 和 `web-snapshot.json`，权限为服务用户独占；项目注册表位于 `/var/lib/clipnest-cloud/projects.json`，只保存令牌哈希。网页项目固定由 `WEB_PROJECT_ID` 指定，不接受浏览器传入项目 ID，避免跨项目读取。

## 运维

```bash
sudo systemctl status clipnest-cloud --no-pager
sudo journalctl -u clipnest-cloud -n 100 --no-pager
curl http://127.0.0.1:19132/healthz
```

备份 `/var/lib/clipnest-cloud`。服务端密文不能脱离对应项目令牌解密；不要把项目令牌提交到 Git、脚本仓库或公开日志。
