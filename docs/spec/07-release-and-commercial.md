# 07 · 商业化、部署与持续演进

首发全球个人，团队后置。正式价格、商户实体/国家、首发商店账号、生产区域与域名是T00/T31发布输入；未知时记录UNKNOWN，不猜测、不发布测试priceId。工程可以先完成sandbox与staging可审查交付。

## 1. 账号与原生登录

复用Better Auth及官方OAuth Provider：原生公共客户端Authorization Code+PKCE，使用系统浏览器、预登记精确redirect URI、一次性state/nonce与短时code。Web使用安全会话cookie与CSRF保护；native凭据进入OS vault。callback不得带长期session token或数据key，也不得信任任意redirect。T14先锁官方版本与集成示例并做真实回调/取消/账号切换fixture。[官方OAuth Provider](https://www.better-auth.com/docs/plugins/oauth-provider)。

Better Auth subject映射为内部ClipNest userId；Google/Apple/邮箱登录只是身份入口，不改变内部身份。账号登录不等于设备授权或资料解锁：pending设备没有内容下载权限，03的配对/恢复成功后才颁发独立device credential。

device credential与cloud root/localDB/recovery key分离；server统一撤销session/device access，客户端清理内存密钥按明确退出/锁定操作执行。切账号必须换namespace、退订旧事件、停止旧outbox发送，不自动迁移匿名资料或旧账号资料。

## 2. 套餐与权益

| 产品 | 首发价值 | 可信权益候选 |
|---|---|---|
| Local Free | 本机历史/查找/收藏，离线可用 | 不要求账号；本机预算可调，不附带无限云 |
| Cloud Trial | 验证第二设备复用 | 候选14天、1GiB、3设备、7天云历史；需服务端发放与防滥用 |
| Personal Pro | 加密跨端同步、长期资料、版本/回收 | 候选10GiB、10设备；版本/回收策略与limits共同限制 |
| Team后续 | 明确共享空间、角色、席位 | 与个人space独立；首发feature off |

14天/设备数在T26进入唯一权益配置并验证，不能由UI硬编码。上述不是售价或已开通权益；候选容量不能自动授予所有登录用户。正式价格在成本/转化与商户可用后决定，客户端使用后端返回displayPrice与provider checkout信息。

统一DTO：`Entitlement{version,accountId,status,features,cloudBytes,maxDevices,historyDays,validUntil,graceUntil,sourceChannels}`。feature与限制在服务端API检查，前端只展示。金额以整数minor units+currency；priceId由环境配置映射到内部productCode，不在客户端推导价格或写isPro。

可用状态：trial/active/grace/expired/revoked。权限计算基于已核验的channel contract与事件，而非“最后收到某条webhook”：乱序/重复事件都可查provider当前状态再投影。签名缓存允许离线展示与本地功能，但过期不允许客户端宣称云权限仍有效。

## 3. 支付模块与API

```ts
interface BillingAdapter {
  createCheckout(input: {accountId:string; productCode:string;
    returnUrl:string; idempotencyKey:string}): Promise<{url:string;expiresAt:string}>;
  verifyWebhook(rawBody:Uint8Array,headers:Record<string,string>): VerifiedEvent;
  fetchContract(providerContractId:string): Promise<VerifiedContract>;
  restorePurchase(input:RestoreRequest): Promise<VerifiedContract>;
}
```

复用Stripe Node SDK（Web/桌面）与RevenueCat官方RN SDK（手机商店）；自己的模块负责account映射、事件幂等、权益/容量账本。全球客户不意味着商户所在地支持Stripe开户；T00核验实体资格，不符合则保持adapter并另选已批准渠道，低模型不能私自换支付平台。[Stripe支持地区](https://stripe.com/global)、[RevenueCat Stripe](https://www.revenuecat.com/docs/web/integrations/stripe)、[Entitlements](https://www.revenuecat.com/docs/getting-started/entitlements)。

API：`GET /v1/me/entitlements`；`POST /v1/billing/checkout`；`POST /v1/billing/portal`；`POST /v1/billing/restore`；`POST /v1/webhooks/stripe`；`POST /v1/webhooks/revenuecat`。webhook rawBody用于验签，不能先JSON重排；eventID全局按provider唯一；提交event+projection job在事务，外部fetch在锁外。unknown product/event入隔离审查，不授予权限。

手机购买绑定内部accountId，不把客户端提交的accountId当交易归属证据。恢复购买核验provider app user与原合同绑定，冲突给支持入口。已有其他渠道权益时先显示已有订阅，防误重复；不会自动取消另一渠道合同。

正式商店购买入口/外链/退款/删除账号按目标地区与届时政策核验，不以统一Web按钮覆盖所有平台。[App Store规则](https://developer.apple.com/app-store/review/guidelines/)、[Google Play支付政策](https://support.google.com/googleplay/android-developer/answer/9858738)。T28提交sandbox购买/恢复/退款证据，T31才选择实际发行入口。

降级：阻止正delta新上传与新增受限设备，允许pull、删除、导出、已有本地资料访问；宽限与云到期删除必须事先明确。不得静默删收藏。若合法旧版本/log pin导致版本预算满，明确不能继续生成新云版本，提供处理入口；T25验证体验后才能发布保留承诺。

## 4. 部署拓扑

默认可审查生产候选：AWS单写区域（初始us-east-1，T00/T31按目标用户与要求确认），ECS/Fargate运行API与worker，RDS PostgreSQL17、私有S3、CloudFront静态Web、Secret Manager密钥/环境、监控与告警。region从环境与workspace记录读取；首发不双写。

本地compose：PostgreSQL17+S3兼容测试服务；不能用其通过代替真实AWS条件写/CopyObject gate。staging/prod独立账户或至少隔离role、桶、DB、KMS和回调。IaC在infra，GitHub Actions build/test/sign artifact；发布须有当时授权，不由任务自行创建计费资源。

API/worker分进程、同版本单体代码；数据库pool各10上限，容器数受连接预算，扩容前测最大连接。pg-boss调度幂等任务；业务outbox与账本在PG事务，S3/支付网络不持行锁。HTTP/S3签名/挑战遵循limits，不设置无限并发。

健康：liveness仅进程；readiness检验迁移版本/DB/必要依赖可用；worker lag、pending upload、ledger drift、snapshot fail、RLS拒绝、input failure与sync error按阈值告警。正文/token不进trace。

## 5. 成本与容量

成本模型按活跃账号记录：对象实际GB月、对象/请求数量、下载流量、PG/API/worker、staging/pending、回收站/版本、备份/日志、支付成本与支持。cipher overhead也计额，未完成/待删除对象不能早释放账本。避免“无限终身云”承诺。

限额同时约束bytes、对象数、live实体、retired ID栅栏、版本、operation rate与pending数量；实时账本+pg-boss对账。跨账号不做内容去重或可见hash。下载按成员授权签名，不因难猜key当公开对象。

T26使用可更换内部planCode与权益配置；不得根据客户端套餐名称选择bytes。建立成本报告并模拟图多用户/频繁编辑/大量小对象，确认候选10GiB能够覆盖经营成本后才定价；不把旧Paste iCloud成本模式当自营云依据。

## 6. 数据治理与恢复

首发客户端可移植导出为用户明确选择的明文资料，显示敏感内容提醒；含格式版本、manifest/checksum、附件，流式、有界、取消不会留下误认完成的文件。加密export是后续能力，先冻结成熟封装/密钥交付与互操作gate，低模型不得临时把localDBKey放zip或拿CNREC1代替。server只能导出密文及必要元数据，不能提供“解密后的全部历史”。

删除账号：近期验证 → 停新写/撤销设备会话 → durable删除job → PG/S3账本与对象回收 → 状态可查。provider合同取消、数据删除、法定/财务留存分别说明，不能一句“删除”隐含所有成功。只在确认物理删除后更新占用；备份删除边界与保留周期如实说明。

备份：RDS PITR、对象策略、元数据与实际版本对账；定期隔离恢复演练。灾难恢复推进epoch并让旧设备走snapshot，恢复基线保留已删ID/撤销信息，防已删除内容重新可见。binary回滚不能自动让旧程序写新schema；数据库迁移采用expand/contract兼容窗口。

local-only数据无法仅凭账号恢复；独立localDBKey丢失时保留原库不覆盖，提供已验证备份/云资料恢复。卸载/重装与vault丢失都在T07/T23/T29验收。

## 7. 发布与持续演进

版本通道internal→closed beta→public beta→paid stable。先合成fixtures，再少量自愿试用；按版本feature flag切云、自动粘贴、购买入口。签名Win安装包、mac签名公证、iOS/Android商店包，升级/回滚/数据兼容各验收。分发钥匙在CIsecret，不能写仓库或给普通任务输出。

产品指标：首次找回成功、复用、第二设备完成解锁复用、收藏留存、试用转付费/续费。运行指标：成功分布之外还报告失败/取消/超时、sync lag、上传失败、恢复成功、容量/请求成本。事件只数量/类型/时长/错误码，不上传内容、URL、标题、来源轨迹。

Team仅在T32设计：共享收藏夹发布到新workspace，默认不带私人来源历史；独立keys/roles/ledger，撤销阻止未来访问，旧明文无法收回。组织托管恢复是另一个明确模式，不能让团队管理员获得私人keys。
