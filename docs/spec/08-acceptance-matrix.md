# 08 · 验收矩阵与上线门槛

验收使用合成数据与隔离profile。当前规划尚未实现，下列PASS必须由真实证据填写；默认全部NOT_RUN。结果保存在代码仓库docs/evidence/Txx，不把用户正文/图片/token写入日志。

## 1. Gate

| Gate | 条件 | 失败处理 |
|---|---|---|
| G0 L0提速 | P01—P28、无交互spawnSync/新helper进程、取消/未知结果不重发、受控文本P95 | 关闭自动粘贴，复制保留；不发行补丁 |
| G1 本地v2 | T11真实PoC、SQLCipher钥匙/迁移、搜索/容量/收藏保护、Win/mac能力 | Tauri失败保留Electron host；受影响平台不上线 |
| G2 个人云/Web工程 | S01—S23/S26桌面/Web+独立Hermes；S24配额/存储故障及T19的S25核心恢复；真实PG/S3 | 保持外部云开关off；内部隔离测试仅在核心通过后接入 |
| G3 手机 | Hermes/SQLCipher/分享、iOS/Android真机、第二设备与离线 | 不宣称对应平台支持；本地功能独立交付 |
| G4 公开云/付费 | 权益验签幂等对账；T26—T28关闭S24 provider退款，T29/T30关闭S25运营/S27导出；导出/删除/灰度 | 试用或本地版继续；不开正式购买 |

G2/G3是阶段工程验收，不等同公开云发布。T25复跑已实施核心与手机部分；后续provider退款、可移植导出和生产等价恢复必须记录DEFERRED_TO_T26—T30。T31汇总所有S01—S27适用子场景/G0—G4，未关闭项不得对外发布云或购买。单任务accepted由其前置和本卡fixture决定，不要求本阶段尚未实现的后续任务先过阶段gate。

## 2. 功能矩阵

| 场景 | Windows | macOS | iOS/Android | Web |
|---|---|---|---|---|
| 采集 | 系统事件/变化seq | changeCount | 前台主动导入/分享 | 用户粘贴/上传 |
| 使用 | 复制+有条件自动输入 | 复制+授权后自动输入 | 主动复制 | 有权限/用户动作复制 |
| 搜索 | 全本地已索引范围 | 同语义 | 同语义 | 显示已缓存索引范围 |
| 无账号 | 本机可用 | 本机可用 | 本机可用 | 当前会话内存，刷新失去，提供显式导出 |
| 离线 | 已解锁资料/队列 | 同左 | 前台恢复同步 | 已缓存资料，额度异常明确 |
| 同步恢复 | seq/epoch/outbox | 同左 | 挂起前后不中断持久状态 | Worker/页面关闭可恢复 |
| 权限拒绝 | 复制降级/UIPI | 辅助功能降级 | 系统粘贴/照片/分享提示 | 权限/焦点/HTTPS提示 |

覆盖产品P01—P11全部loading/empty/no-results/error/offline/locked/quota/conflict/permission状态；键盘+IME+触控+小屏+减少动画都可完成核心任务。

### UX fixture：前置 → 动作 → 可观察结果

| 编号 | 前置/动作 | 断言 |
|---|---|---|
| U01 | 搜索框focus，输入含空格，左右/Home/End | 正常输入/光标；不预览/执行；Down进入结果，非IME Enter恰好1job |
| U02 | 输入法composing，Enter确认或Esc取消 | 无paste/退出；提交后的非composing动作才按规则处理 |
| U03 | card双击，或持续按Enter | 单击只选中；dblclick恰好1job；repeat不额外提交 |
| U04 | 慢查询A后发B，A迟到 | 只渲染B generation；selection/reset与B一致 |
| U05 | 已加载两页，End；下一页加载失败 | End定位已加载末条；保留旧结果/选中，局部重试不重置全页 |
| U06 | 预览打开，Esc两次 | 第一次只关预览，第二次关面板；textarea/button无额外全局输入 |
| U07 | 云已显示内容，执行lock；匿名local-only已存在 | 云正文/preview/thumb/search不可见，worker终止；本机资料按平台vault/会话可用 |
| U08 | Web匿名内容达到32MiB，再导入；随后刷新 | 拒绝新增并保留旧项；有导出与刷新失去提示；无IDB敏感明文持久化 |
| U09 | clipboard/autoPaste权限拒绝 | 可用能力仍工作；明确降级与说明；无假成功 |
| U10 | local/outbox/版本预算满，尝试新保存 | 对应错误和处理入口；受保护内容/未提交draft不丢；无隐式cloud范围切换 |
| U11 | A账号有pending操作，切B | A worker/订阅/内存keys终止，B namespace；A wire从不发向B |
| U12 | 离线有已解锁缓存；初次空库/无结果/部分索引 | 本机可用；分别显示正确状态与coverage，不伪称全量云检索 |

## 3. 数据与安全

- 迁移：52条当前抽样量只用于规模参考；测试另生成0/100/2000条、全部pinned、重复ID、恶意DataURL、损坏JSON、满盘、进程中断。原件不可恢复的旧降采样应准确标记，不伪造原图。
- localDBKey：与cloud/recovery key独立，匿名本机可解锁；vault缺失/权限拒绝不创建空库覆盖旧库；卸载/重装/备份恢复边界验收。
- 03的S01—S27按§1明确的阶段/子场景归属验收，完整证据由T31汇总；跨设备冲突、delete不复活、outbox精确幂等、bigint>2^53、epoch旧队列、snapshot中断、乱序response必须覆盖。
- PG：应用/worker不owner、不BYPASSRLS；每连接事务LOCAL；无scope/伪user/跨workspace引用均失败；EXPLAIN验证复合索引与keyset，网络不持事务锁。
- S3：真实provider条件写、不可变最终对象、签名到期、旧URL重放、复制200携带错误、并发finalize、孤儿/删除确认占用、配额和对象数一致。
- 加密：Rust/C/Web/Hermes固定向量、篡改AAD/nonce/kid/version失败；配对/恢复挑战一次性；服务端不接收root/local/recovery secret；设备撤销边界如实表达。
- 日志：正文、URL、标题、来源、图片、密钥、token、未脱敏SQL参数均不可进入telemetry/crash。使用合成canary检验日志与错误包。

## 4. 性能测量

固定测试机/OS、显示器、电源模式、构建模式、数据集seed、缓存与网络条件；各正常场景>=100次，报告p50/p95/max/失败数。小样本组件benchmark不能代替整体指标。

| 指标 | 待验证目标 | 边界 |
|---|---|---|
| 预热wake到list_actionable | P95<100ms | 包含capture/show/首帧，不能只算JS handler |
| 普通小文本选择到inputSubmitted | P95<150ms | modifier已释放、合法目标；目标实际显示另测 |
| 1万条合成文本搜索首屏 | P95<100ms | 中文1/2/3字、子串、组合过滤、第一页之外结果 |
| 未变图片编码 | 0次 | 开启采集后跨多个通知/旧轮询周期 |
| queue/decoded/本机预算 | <=limits | 峰值/错误/重试也计入，不只稳定态 |
| 全应用内存/闲置CPU | 记录L0/v2同场景对照 | 所有WebView/helper子进程；不以RSS求和当独占物理内存 |

选择图片cache hit/miss、helper首启动/预热、focus restore/held keys、权限/取消失败分别统计，不把难场景排除后宣称全部达标。端到端应用真正出现文本在受控编辑器观察，不能用IPC完成顶替。

## 5. 付费与运营

B01签名非法拒绝；B02重复/乱序event；B03购买后权益生效；B04退款/撤销；B05到期/宽限；B06恢复购买到正确account；B07已有跨渠道权益避免重复提示；B08前端伪造Pro无效；B09offline entitlement过期；B10超额冻结新增但可读/导出；B11merchant/商店购买入口验证；B12Provider状态丢事件定时对账修复。

备份演练：恢复PG+对象，检查seq/epoch推进防旧设备误上传；恢复已删除记录不能重新公开；恢复只验证count/head/checksum不输出用户内容。发布：签名/更新回滚/兼容版本窗口/错误开关逐步灰度；数据格式迁移不得依赖二进制回滚自动逆迁移。

## 6. 证据格式

```json
{"task":"Txx","gate":"Gx","fixture":"S01",
 "result":"PASS|FAIL|NOT_RUN|DEFERRED","deferredTo":null,"environment":"isolated-staging",
 "buildCommit":"<sha>","profileSeed":"fixed",
 "command":"<actual command>","artifact":"relative/report.json",
 "limitations":["target application insertion not measured"]}
```

负责人确认事实后accepted，独立审查不得只复述执行模型结论。一个平台未跑真机测试就是未验收，不能由另一个平台或Web截图代替。
