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
