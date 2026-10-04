# ClipNest 视觉 QA

## 对比目标

- source visual truth: `docs/assets/clipnest-history-reference.svg`
- implementation: Windows 打包目录中的 `ClipNest.exe`
- layout: 底部抽屉、单行卡片平铺、卡片不叠放，默认宽度占满视图

## 检查项

- 顶部搜索、历史统计、常用内容和设置入口保持同一横向工具栏对齐。
- 文本、链接、图片卡片使用清晰的类型色头部、白色内容区、圆角和轻阴影。
- 历史列表采用虚拟滚动；底部复制/选择提示固定，不随内容滚动。
- 常用内容标签有明确的保护状态；重复复制只前置，不创建重复记录。
- 托盘和窗口使用蓝色 `P.` 图标；配置页可管理开机自启、存储目录、最大保存数、云端和升级。
- 键盘流程覆盖 `Ctrl + Shift + V` 呼出、方向键选择、Enter 复制、Escape 关闭。

## 验收证据

- 主进程和渲染层 TypeScript 检查通过。
- Vite 构建、Windows 目录包和 NSIS 安装包构建通过。
- 发布包隐私扫描通过；本文件不记录本机绝对路径或服务凭据。

## 结果

通过

## 2026-10-04 Windows 扁平界面复核

本节记录本次调整，以上为历史验收记录。当前视觉参考为用户提供的 1440 × 315 Windows 剪贴板面板截图。

- 测试对象：`dist/index.html` 及其真实生产 JavaScript/CSS，Electron 40.10.2 的 1440 × 315 离屏 BrowserWindow；未替换界面组件或样式。
- 测试输入：`.test-data/windows-flat-20261004/profile/ClipNest/history.json` 的六张卡片，其中 PNG、JPEG 各一张。`clipnest` API 只提供读取 fixture 的 stub，剪贴板、输入和修改操作均不可用。
- 截图证据：[renderer-flat.png](docs/evidence/windows-flat-20261004/renderer-flat.png)；尺寸、颜色、图片加载与布局断言见 [renderer-flat.json](docs/evidence/windows-flat-20261004/renderer-flat.json)。已实际查看截图。

| 复核项 | 当前结果 | 依据与参考图差异 |
| --- | --- | --- |
| 布局 | 通过（renderer 范围） | 52 px 单行工具栏，六张 220 × 232 px 卡片、16 px 间距；同一水平线，无卡片重叠或阴影。保留类型过滤和设置，窗口控制使用 Windows 式关闭按钮。 |
| 文字 | 通过（renderer 范围） | 中文、英文预览清晰，内容字号 14 px，现有系统字体栈正常；彩色标题区使用深色文字，提高相对参考图白字的对比度。 |
| 颜色 | 通过（renderer 范围） | 淡紫灰底 `#e4e2eb`，文本/链接青色 `#4bc1e9`，图片橙色 `#f4ab39`，内容区 `#f7f4fb`；小圆角细边框，无渐变。 |
| 图片 | 通过（renderer 范围） | PNG/JPEG 均加载完成，原尺寸 320 × 180，使用 `object-fit: contain` 完整保留比例。使用测试图，未声称复制参考图中的文档内容。 |
| 内容 | 通过（renderer 范围） | 英文文本、中文多行文本、URL 与两张图片显示在对应类型卡片，底部尺寸/字节量及序号保留，无替代占位界面。 |

本次生产 renderer 视觉复核通过，控制台无错误。以上截图来自禁用硬件加速的离屏 renderer，不能证明原生窗体点击或外部粘贴行为。

**原生验收状态：** 主验证流程曾在重启应用后恢复真实 1440 × 315 窗口截图。早期真实点击暴露了 clipboard_sequence_changed 和 focus_not_confirmed 两个故障，已分别修复剪贴板提交序列采样及异步激活确认。最终安装版本为 `1.1.4-local.20261004.3`；普通原生回归、真实剪贴板序列检查、ASAR worker 与安装文件核对通过。最终真实卡片点击复测被 Windows Computer Use 的 `codex app-server exited before returning response 1` 阻断；恢复工具后仍失败，完整流程保留待人工验收。离屏测试没有实际剪贴板或外部输入；不得将 API stub、截图、模块测试通过记为最终卡片点击流程通过。最新验证范围见 `release/windows-flat-20261004/verification.json`。

**最终补充验证：** 1 项受控原生产品集成通过：真实 `Win32Platform/run_paste` 使用 SendInput Ctrl+V，在本测试进程自建 EDIT 窗口的真实 caret 处准确插入一次，目标原文与 host 内容均保留，自建窗口已清理（`docs/evidence/windows-flat-20261004/native-caret-integration.json`）。该测试同进程/同输入线程，不覆盖 renderer 卡片点击、独立辅助进程授权和外部编辑器整链。安装版只读窗口状态检查确认可见、聚焦、不透明且加载完成，1440 × 315；临时调试端口已移除，最终按正常模式启动，辅助进程持续在线。仍不将此记为最终卡片点击整链通过。
