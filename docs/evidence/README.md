# 验证记录说明

这里保留阶段检查、回归结果和验收缺口。历史记录中的“工作区未提交”、测试数量和失败尝试表示当时状态；最新提交前复核见 `git-submit-20261004.json`，不能用阶段测试代替完整桌面或性能验收。

为避免发布本机目录信息，部分 JSON 中的绝对路径改为占位符，命令参数、工具版本、产物 SHA-256 和测试结论保留：

- `<repo>`：本仓库目录。
- `<tools>`：本机独立 Rust/MinGW 工具链目录。
- `<spec-workspace>`：独立规格文档工作区，未包含在本仓库。
- `<local-install>`：本机 ClipNest 安装目录。

本机路径版原始记录另存于被 Git 忽略的 `release/git-submit-local-evidence/`。`release/` 下的安装包、日志、probe 和覆盖安装记录，以及 `.test-data/` 下的测试 profile/cache 均为本地产物，不随源码提交。Windows 原生 helper 的本地验收打包使用了本地配置，不代表默认打包命令或 T05 完整发布门已经验收。

`windows-flat-20261004/renderer-flat.png` 使用真实生产 renderer 与只读合成数据；`baseline-caret.png` 仅展示合成文字。截图与原生自建输入框集成不证明最终卡片点击、独立 helper/目标进程或外部应用图片粘贴的完整流程通过。
