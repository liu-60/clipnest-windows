# ClipNest

> 一款面向 Windows 的键盘优先剪切板历史工具，交互参考 macOS Paste。

[下载 Windows 版](https://github.com/liu-60/clipnest-windows/releases/latest/download/ClipNest-1.0.0-windows.zip) · [软件介绍与下载主页](https://liu-60.github.io/clipnest-windows/)

## 界面设计

ClipNest 采用 Paste 风格的浅灰工作台、顶部搜索和横向卡片流：文本、链接、图片按时间倒排显示，当前选择用蓝色描边突出。

![ClipNest 剪切板历史界面设计](docs/assets/clipnest-history-reference.jpg)

![Paste 风格视觉参考](docs/assets/clipnest-promo-reference.jpg)

## 普通用户操作

1. 下载并解压 Windows ZIP，双击 **ClipNest.exe** 启动。应用会常驻系统托盘。
2. 在任意应用中连续按 **Ctrl + C**，复制多条文本、链接或图片。
3. 按 **Ctrl + Shift + V** 打开剪切面板，历史内容会按时间从新到旧排列。
4. 点击想使用的卡片，或用 **↑ / ↓** 选中后按 **Enter**。该条内容会被激活为当前系统剪切板。
5. 回到目标应用按 **Ctrl + V**，即可粘贴刚刚选中的文本、链接或图片。

常用快捷键：

| 操作 | 快捷键 |
| --- | --- |
| 打开 / 关闭剪切面板 | **Ctrl + Shift + V** |
| 聚焦搜索 | **Ctrl + K** |
| 移动选择 | **↑** / **↓** |
| 激活当前内容 | **Enter** |
| 关闭面板 | **Esc** |

面板中还支持搜索、文本/链接/图片筛选、固定、删除以及清除未固定历史。

## 本地开发与打包

环境要求：Windows、Node.js、pnpm。

~~~powershell
pnpm install
pnpm dev
pnpm lint
pnpm build
pnpm package:windows
~~~

开发窗口会同时启动 Vite 和 Electron。Windows 目录包位于 **release/win-unpacked**，运行其中的 **ClipNest.exe** 即可，无需安装。

## 数据与隐私

- 剪切板历史只保存在本机，不上传云端。
- 数据默认位于 **%APPDATA%/ClipNest/history.json**。
- 最多保存 100 条历史、总大小约 25 MB；固定项不会被自动清理。
- 图片会以本地 PNG 文件保存在 **%APPDATA%/ClipNest/images**。

## 说明

如果 Windows SmartScreen 首次拦截未签名程序，请点击“更多信息”后选择“仍要运行”。这是免安装 ZIP 版本，不会写入系统安装器。

## License

MIT
