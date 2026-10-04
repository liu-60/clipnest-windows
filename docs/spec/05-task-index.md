# 05 · 实施任务索引

33张父任务卡，每张按a/b/c拆小交付。任务状态均为not_started；文档完成不等于功能实现。依赖accepted和对应gate通过才可接入真实能力。

先读取00与06，再点当前卡；不用给低模型整个项目的自由重构指令。

| ID | 阶段 | 任务 | 前置 | 风险 |
|---|---|---|---|---|
| [T00](tasks/T00.md) | M0 | 冻结基线与建立隔离仓库 | 无 | high |
| [T01](tasks/T01.md) | M0 | L0埋点与受控基准 | T00 | normal |
| [T02](tasks/T02.md) | M0 | 常驻原生helper与提交状态机 | T01 | critical |
| [T03](tasks/T03.md) | M0 | Electron接入新helper与原生授权 | T02 | critical |
| [T04](tasks/T04.md) | M0 | L0键盘防重与图片热路径 | T03 | normal |
| [T05](tasks/T05.md) | M0 | L0验收与可审查发布包 | T03, T04 | critical |
| [T06](tasks/T06.md) | M1 | v2工作区契约与CI骨架 | T00 | high |
| [T07](tasks/T07.md) | M1 | SQLCipher本地仓储与对象预算 | T06 | critical |
| [T08](tasks/T08.md) | M1 | 旧数据可恢复导入 | T07 | critical |
| [T09](tasks/T09.md) | M1 | 采集隐私与容量管线 | T07 | high |
| [T10](tasks/T10.md) | M1 | 查询检索与分页API | T07, T09 | normal |
| [T11](tasks/T11.md) | M1 | Windows Tauri全链路PoC | T05, T06, T07, T10 | critical |
| [T12](tasks/T12.md) | M1 | 桌面正式交互与本机资料库 | T08, T10, T11 | normal |
| [T13](tasks/T13.md) | M1 | macOS能力与分发验证 | T11, T12 | high |
| [T14](tasks/T14.md) | M2 | 账号设备与个人空间服务 | T06 | critical |
| [T15](tasks/T15.md) | M2 | 密码封装与密钥恢复互操作 | T06, T14 | critical |
| [T16](tasks/T16.md) | M2 | 云CAS操作日志与租户隔离 | T14, T15 | critical |
| [T17](tasks/T17.md) | M2 | 桌面原子outbox与增量客户端 | T07, T15, T16 | critical |
| [T18](tasks/T18.md) | M2 | 云附件条件写与配额账本 | T16 | critical |
| [T19](tasks/T19.md) | M2 | 快照epoch与回收worker | T16, T18 | critical |
| [T20](tasks/T20.md) | M2 | Web本地缓存与Worker检索 | T06, T15 | high |
| [T21](tasks/T21.md) | M2 | Web完整资料库与TS同步引擎 | T14, T17, T19, T20 | high |
| [T22](tasks/T22.md) | M3 | Expo工程与手机本地仓储 | T06, T07 | high |
| [T23](tasks/T23.md) | M3 | 手机主动导入分享与密钥集成 | T15, T22 | critical |
| [T24](tasks/T24.md) | M3 | 手机同步与离线复用闭环 | T21, T23 | critical |
| [T25](tasks/T25.md) | M3 | 跨端对抗与性能发布gate | T13, T19, T21, T24 | critical |
| [T26](tasks/T26.md) | M4 | 统一试用权益与账本投影 | T14, T18, T19 | critical |
| [T27](tasks/T27.md) | M4 | Stripe sandbox订阅与可信通知 | T26 | critical |
| [T28](tasks/T28.md) | M4 | 商店购买恢复与RevenueCat | T23, T26 | critical |
| [T29](tasks/T29.md) | M4 | 导出删除与灾难恢复 | T08, T19, T25 | critical |
| [T30](tasks/T30.md) | M4 | CI签名灰度与运维支持 | T25, T27, T28, T29 | critical |
| [T31](tasks/T31.md) | M4 | 个人商业版上线验收 | T25, T27, T28, T29, T30 | critical |
| [T32](tasks/T32.md) | M5 | 团队版设计预研 | T31 | high |

## 首轮可派发顺序

T00 → T01 → T02a → T02b → T02c → T03a/b/c → T04 → T05（G0）。T06可在T00完成后于独立v2仓库并行；接着T07/T08/T09/T10，T11通过才继续迁移UI。云端T14/T15先固定账号与密码向量，再T16—T19；T20可先实现离线fixture，T21才开真实云闭环。

移动T22可与Web并行做本地，T23接入已验收nativecrypto，T24复用TS同步；T25确认跨端与平台。支付T26—T28可在云账本稳定后并行，T31不得早于全部G4证据。T32只做团队设计。

## 可并行与禁止

可并行不同仓库L0/v2、UI fixture/数据库、Web cache/mobile scaffold、Stripe/商店adapter。禁止并行写canonical contracts、同一migration、crypto向量、usage账本、同一用户库。负责人先合并模块接口，再派发调用方。

## 任务状态记录

T00将[task-manifest.json](task-manifest.json)复制到docs/spec，将独立progress放docs/progress.json。保留每子卡状态/commit/证据；没有实际验收就保持review或not_started。输入必须指定任务ID/仓库/章节，结果按06格式。非计划新增工作先改ADR、依赖与fixture，不把它塞进现有卡。

