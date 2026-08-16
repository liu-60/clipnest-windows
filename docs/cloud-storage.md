# ClipNest 云端存储使用文档

## 交付内容

ClipNest 的云端同步采用“本地加密 + 项目隔离”的方式：

- 剪切板历史在 Windows 客户端本地使用 AES-256-GCM 加密后才上传。
- 云服务器只保存加密快照，不保存明文剪切内容。
- 项目令牌按项目单独生成，服务端只保存令牌哈希。
- 每个项目使用独立目录，例如 `data/clipnest-windows/snapshot.json`，不同项目不会串数据。
- Windows 客户端使用系统安全存储保护已保存的项目令牌。

## 本项目配置

项目标识固定为：

```text
clipnest-windows
```

验收环境只有 IP、没有域名证书时，客户端地址可填写实际服务器地址，例如：

```text
http://<server-ip>
```

正式公网使用时，应改成已经配置 HTTPS 的域名，例如：

```text
https://cloud.example.com
```

HTTP 模式下历史内容仍是密文，但项目令牌会明文经过网络，只适合自有网络和验收；正式环境请使用 HTTPS。

## Windows 客户端配置

1. 安装并启动 ClipNest。
2. 打开右上角设置按钮，进入“云端存储”。
3. 填写云端地址、项目标识和项目令牌。
4. 点击“保存并同步”。
5. 状态显示“已同步”后，复制一段文本，再点击“立即同步”验证上传。
6. 在另一台设备使用相同的云端地址、项目标识和项目令牌，即可合并历史。

项目令牌只需第一次填写。保存后会进入 Windows 安全存储，配置页不会回显完整令牌。

## 服务器部署

把 `server/` 目录上传到 Ubuntu 服务器后执行：

```bash
cd /path/to/server
PROJECT_ID=clipnest-windows sudo -E bash install-ubuntu.sh
```

脚本第一次创建项目时会在终端输出 `PROJECT_TOKEN`。该令牌只显示一次，请立即保存到安全位置，不要提交 Git。

在只有 IP 的验收环境，可以使用服务器上的 Caddy/Nginx 做 HTTP 反向代理。ClipNest 服务本身仍只监听本机 `127.0.0.1:19132`，客户端地址填写实际反向代理地址，然后按 `server/Caddyfile.example` 配置路由。正式环境请绑定域名并启用 HTTPS。只有在没有反向代理的临时环境，才使用 `CLIPNEST_PUBLIC_HTTP=1` 直连 `:19132`。

公开仓库不包含任何真实服务器地址、项目令牌或 SSH 私钥。项目令牌只在部署命令首次执行时输出，请保存到密码管理器或其他安全位置，不要写入源码、截图、日志或提交记录。

## 验收清单

服务器上：

```bash
sudo systemctl is-active clipnest-cloud
curl http://127.0.0.1:19132/healthz
```

客户端上：

- 云端状态显示“已同步”。
- 新复制内容可以在第二台设备出现。
- 在设备 A 删除普通内容并同步后，设备 B 不会重新出现该内容。
- 项目 A 的令牌访问项目 B 时返回 `401`，项目目录仍彼此独立。

## 令牌轮换与备份

令牌遗失或怀疑泄露时轮换：

```bash
sudo -u clipnest env PROJECTS_FILE=/var/lib/clipnest-cloud/projects.json \
  node /opt/clipnest-cloud/create-project.mjs clipnest-windows --rotate
```

然后在所有客户端重新填写新令牌。备份 `/var/lib/clipnest-cloud`；服务端密文必须和对应项目令牌一起保管，否则无法恢复历史。
