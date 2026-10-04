# ADR-0000 · v2 工作区与隔离边界

状态：实施基线；2026-10-03。

## 决策

- 当前运行中的 D:\ClipNest 是安装目录，绝不作为源码/测试目录。
- 在源码仓库固定提交 91cafd765b9480e011647c9d8cd2976269f12aef 上建立两个独立本地 clone：D:\ClipNest-work\electron-l0 分支 codex/m0-latency；D:\ClipNest-work\v2 分支 codex/v2-clipboard。两者只共享公开源码来源与基线，不共享构建输出、profile或未提交修改。
- v2不推送远端、不创建GitHub仓库；origin保留为已有上游，用户请求的分支是本地隔离实施分支。
- v2测试profile仅位于.test-data/profile，预置快捷键为Ctrl+Alt+Shift+V、云关闭，夹具只含合成文本/链接/图像。
- 当前 %APPDATA%\ClipNest 不作为构建、测试、迁移输入或哈希对象。本地review期间曾枚举其顶层元数据，已单独如实记录；未打开、哈希或写入其文件。未来迁移只允许T08显式用户触发与隔离副本。
- 基于该隐私边界，调整T00原“用户数据hash未变”的检查：不做全量用户profile哈希，也不在T00启动旧应用。记录EXE/app.asar的安装基线hash；T01先增加强制CLIPNEST_DATA_DIR的安全启动入口；涉及旧用户资料的完整性核对放在T08用户显式选择的隔离副本中。
- 尚未安装的候选依赖不在T00下载或引入；T06首次安装前必须记录确切版本、兼容性与许可证，未核验的候选项不冻结进锁文件。

## 工具链基线

Node与pnpm可用。当前未检测到Cargo/Rust和Windows C++ Build Tools，Tauri/native二进制无法在本机完成构建验收；在未安装这些工具前，原生任务保持review/blocked，不能标PASS。签名、商户和生产区域未知时，商业任务不得模拟真实能力。

iOS原生构建须使用Apple工具链，本机为Windows；本项目不运行XcodeBuild。无对应真机/签名证据时，iOS任务保持未验收。
