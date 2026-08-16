# ClipNest Cloud 服务

这是 ClipNest 的轻量云端快照服务。客户端先在本地使用 AES-256-GCM 加密剪切板历史，服务端只保存密文；每个项目使用独立项目令牌，并写入独立的 `data/<projectId>/snapshot.json`，避免不同项目串数据。

## 快速部署

服务器要求 Ubuntu 22.04+、Node.js 20+ 和 systemd。把 `server/` 目录上传到服务器后执行：

```bash
cd /path/to/server
PROJECT_ID=clipnest-windows sudo -E bash install-ubuntu.sh
```

默认模式只监听 `127.0.0.1:19132`，适合由 Caddy/Nginx 反向代理并提供 HTTPS。

当前只有 IP、还没有域名证书时，可以临时使用直连 HTTP：

```bash
cd /path/to/server
PROJECT_ID=clipnest-windows CLIPNEST_PUBLIC_HTTP=1 sudo -E bash install-ubuntu.sh
```

验收环境可通过 Caddy/Nginx 反向代理 `/healthz` 和 `/v1/*`，ClipNest 服务本身只监听 `127.0.0.1:19132`。剪切历史本身仍是密文，但项目令牌会经过 HTTP 明文传输，只建议用于自有网络或验收；正式公网使用请绑定域名并配置 HTTPS。公开仓库不写入真实服务器地址，部署后请在客户端配置页填写实际反向代理地址。

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
    reverse_proxy /healthz 127.0.0.1:19132
    reverse_proxy /v1/* 127.0.0.1:19132
}
```

客户端地址填写 `https://cloud.example.com`，不要再填写 `:19132`。

## API

- `GET /healthz`：服务健康检查，不需要令牌。
- `GET /v1/projects/<projectId>/snapshot`：读取项目密文快照。
- `PUT /v1/projects/<projectId>/snapshot`：原子写入项目密文快照。

项目接口必须带 `Authorization: Bearer <project-token>`。服务端不记录请求体和令牌。项目数据位于 `/var/lib/clipnest-cloud/data/<projectId>/snapshot.json`，权限为服务用户独占；项目注册表位于 `/var/lib/clipnest-cloud/projects.json`，只保存令牌哈希。

## 运维

```bash
sudo systemctl status clipnest-cloud --no-pager
sudo journalctl -u clipnest-cloud -n 100 --no-pager
curl http://127.0.0.1:19132/healthz
```

备份 `/var/lib/clipnest-cloud`。服务端密文不能脱离对应项目令牌解密；不要把项目令牌提交到 Git、脚本仓库或公开日志。
