# ADR-0001 · T01性能埋点入口范围

状态：已采纳；2026-10-03。

## 背景

原T01只允许新增 `src/main/metrics/**`，但请求从Electron主进程的快捷键开始，经过preload IPC与React确认列表可操作；选中操作也由renderer经过preload到main。只新增模块无法给唤醒和选择路径生成并回传同一个requestId，也无法区分主进程ACK与renderer实际可操作。

## 决策

- T01仅增加 `src/main/main.ts`、`src/preload/preload.ts`、`src/shared/types.ts` 与 `src/renderer/App.tsx` 的最小注册/确认点，以及 `src/main/metrics/**` 的脱敏计时模块。
- 埋点只允许输出requestId、阶段名、单调时钟耗时、结果码和队列长度；不得输出剪贴板正文、窗口标题、路径、密钥或账户信息。
- 计时默认关闭；基准启动必须强制指向合成profile并默认 `--no-input`。真实编辑器内容可见时间与IPC/SendInput ACK分开记录。
- 不在T01修复helper冷启动或自动粘贴行为；性能路径修复留在T02/T03，避免基线和修复混在同一测量中。
