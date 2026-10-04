# 01 · 产品与页面交互规格

本文件冻结首发交互，低模型只实现指定页面和状态。借鉴Paste的快速找回、时间线与长期收藏原则，使用ClipNest自身视觉与跨平台能力；不是像素复刻。全局技术/容量见00与limits，云数据语义见03。

## 1. 产品对象与范围

| 对象 | 用户意图 | 生命周期 |
|---|---|---|
| 最近历史 | 找回曾复制内容 | 本机默认30天，受500MiB总预算；不可编辑原快照 |
| 资料库SavedItem | 长期重复使用 | 用户主动保存；可编辑、归档；不按历史TTL自动删除，计入预算 |
| 收藏夹Collection | 组织长期资料 | 命名、颜色、排序；删夹默认只删关系，不删内容 |
| 近期云历史 | 主动选择跨设备找回 | 云开关默认关闭；启用后默认7天，账号策略到期才产生全局删除 |
| 本机附件缓存 | 提高加载/离线速度 | LRU可淘汰；缓存淘汰不删除资料、不生成同步操作 |

保存历史为收藏创建新SavedItem身份，保留原历史。清空历史不影响资料库。私人历史不因团队成员身份共享。首发类型：纯文本、识别为链接的纯文本、静态图片；HTML/RTF/文件/PDF、OCR、模板、Paste Stack、团队、键盘扩展、云AI/MCP后置。

## 2. 桌面双窗口

### 2.1 快捷面板P01

固定层级：PanelRoot → SearchRow → AreaAndFilterRow → VirtualCardStrip → StatusBar。可独立展开PreviewOverlay；账号、订阅和复杂设置放管理窗口，不占卡片区。

- 面板贴近当前工作屏底部，限制在workArea。建议高度400 logical px，最小宽640；极窄屏改纵向单列，不裁切搜索/执行入口。
- SearchRow：搜索框、清除、暂停采集状态、打开管理窗口。placeholder“搜索历史与收藏”，显示当前搜索范围。
- Area：最近/资料库；资料库可以选收藏夹。类型、来源、日期、设备过滤以可见chips组合；ClearFilters独立于ClearQuery。
- 卡片：类型、160字符以内预览或缩略图、来源/时间/设备、local/sync/conflict状态、选中边框。正文/原图按需读取；图片不使用全量DataURL列表。
- StatusBar：结果数量/索引范围、当前离线或权限说明、Enter使用/Space预览/Esc退出提示。容量警告不遮挡当前内容。

冻结操作：鼠标单击只选中；双击执行一次。焦点在结果卡片/结果区时Enter执行、↑↓/←→按布局导航、Home/End到已加载结果首末、Space预览、Esc先关闭预览再退出面板；不做未定义的全库seek-end。搜索框中Space/左右键保留正常输入与光标，Down进入首结果，非IME Enter使用当前选择；普通输入更新查询。按钮遵循自身键盘操作，textarea不走全局paste。IME确认Enter/取消Esc不执行、不开关预览或退出面板；event.repeat不重复提交。

打开面板：查询/过滤按上次设置保留，选择重置到当前结果首条并滚到首条；无结果清除selectedId。用户输入新查询后同样重置选择；迟到的旧query generation不覆盖新结果。面板不等待云同步。

执行状态：idle → preparing（仅内容未就绪时可见）→ clipboard_written → restoring_target → input_submitted或copied_only/error。输入提交不宣称目标完成粘贴。失败不覆写用户期间复制的新内容；可提示“已复制，请在目标应用粘贴”或明确重新选择原因。

### 2.2 管理窗口P02

Sidebar：最近/资料库/收藏夹；BottomNav：账号与设备/设置/帮助。Main：标题与范围 → 搜索/筛选 → 结果列表/网格 → 详情抽屉。

支持：保存为收藏、编辑收藏正文与标签、创建/重命名/删除收藏夹、加入/移出收藏夹、复制、导出、删除。批量操作明确作用于已选IDs，不能“全选”只覆盖当前页却显示全库已选。

首发排序仅最近更新/名称；收藏夹关系按资料更新时间与ID稳定排列，不做拖拽手动排序。批量导出入口只在T29通过时开启，早期本地测试版明确功能尚未开放，不假成功。

编辑：加载baseRevision，保留未提交draft；保存过程中禁用重复保存。冲突显示“本地修改”和“云端版本”，提供另存副本或重新编辑；不能静默覆盖。删除收藏夹默认保留内容，不预选“同时删除资料”。历史不能原地编辑，入口为“保存副本后编辑”。

### 2.3 设置P03

分组：采集（暂停、排除应用、格式）/快捷键与行为/容量（本机、缓存、云分别显示）/同步与隐私/账号设备/外观/关于更新。

- 排除应用：仅在平台支持来源识别时可配置；未知来源有说明，不承诺绝对识别密码。
- 容量：已用/上限/受保护/可清理字节；清理缓存、本机历史、云历史三个按钮不得合并。降低预算预览影响，保护收藏/待同步数据。
- 云开关：默认off；说明上传范围；先登录、保存恢复凭证并验证解锁，再启用。关闭同步停止传输，已经云端的资料按说明保留；“删除云资料”另做明确操作。
- 自动粘贴缺权限：可用复制；按钮跳到系统授权说明，不能假装权限已授予。

## 3. 手机页面

底部导航：最近/资料库/收集/设置。内容为竖向列表，触控区域>=44 logical px；无hover依赖。长按显示动作菜单，单击打开详情，不自动输入其他App。

P04最近/资料库：搜索、类型/收藏夹chips、列表、同步时间；选择打开详情。P05详情：正文/图片、来源时间、收藏/编辑/复制；底部明确复制按钮。复制成功仅指系统剪贴板写入。

P06收集：系统粘贴按钮、分享入口说明、图片选择；先展示preview与scope，再保存。Android前台读取按用户操作；iOS使用系统授权/粘贴入口，不绕过提示。分享扩展只收集当前主动分享的内容，不读取历史。

分享队列：native share container保存有界pending项，主App下次前台事务导入。扩展阶段内容受本地保护，失败不丢弃；队列满显示重新打开App处理。禁止在扩展内长时间云同步或搭建另一套账号/数据库。

P07编辑收藏：类型决定控件，文本多行编辑、标签chip；IME不触发保存；navigation离开时提示未保存draft。网络离线可本地提交+outbox，outbox满则明确阻断同步范围修改。

## 4. Web页面

P08资料库：desktop宽>=1024使用sidebar+list+detail；768—1023 sidebar折叠；<768列表/详情分路由返回。正文保持可选中，键盘焦点可见。

P09解锁：账号登录与云资料解锁独立。登录后云资料锁定页显示“批准此设备/恢复凭证”，不展示personal_cloud正文/预览/缩略图/搜索结果；释放UI明文引用并终止云索引worker。桌面/手机local_only由OS vault决定，Web local_only仅当前会话内存、没有OS vault或持久云解锁。设备配对按照03双QR/验证流程。会话过期不清除未同步draft；账号切换建立新namespace。

P10主动导入：浏览器允许时使用用户点击的Paste/Upload，拒绝权限显示可手动粘贴textarea。复制需用户操作与HTTPS；失败显示可选正文，不宣称后台系统采集。

匿名Web和Web的local_only导入仅保存在当前会话内存，32MiB上限；不将敏感明文写IndexedDB。刷新/关闭会失去这些内容，保存前明确提示并提供显式明文导出。已解锁云范围资料可作为加密draft持久化，锁定后仍不展示正文。首发不增加浏览器本地密码/恢复协议。

P11账号与设备：当前设备、授权时间、最后成功同步、撤销、恢复设置、导出/删除账号。撤销会话/设备权限不承诺已下载明文可以收回。浏览器额度/隐私模式导致缓存不可持久时提示，并允许在线使用。

## 5. 所有页面必须覆盖的状态

| 状态 | 显示与可操作项 | 禁止 |
|---|---|---|
| 首次空历史 | 简短说明+复制示例或导入入口 | 用付费弹窗挡住本地体验 |
| 无搜索结果 | 查询/过滤可见、清除入口 | 显示首次空库文案 |
| 初次加载 | 保留骨架/可取消，不显示错误“0条” | 白屏、阻塞全部窗口 |
| 分页加载 | 保留已有项，局部spinner和失败重试 | 替换整页导致选中跳动 |
| 离线且已解锁 | 本机资料可读，标最后同步时间 | 无限spinner、删除本机数据 |
| 已登录但cloud locked | 遮蔽personal_cloud正文/预览/缩图/搜索并释放明文；桌面/手机匿名库由OS vault，Web由会话内存管理 | 与“没有资料”混淆或强制匿名本机登录 |
| 索引未完整 | 已索引数量/范围、继续索引 | 号称云库全量搜索 |
| 权限拒绝 | 按能力降级、说明/设置入口 | 伪造自动粘贴成功 |
| 超容量/outbox满 | 容量来源、清理/导出/调整入口 | 默默删收藏或丢操作 |
| 内容冲突 | 保存draft，云版本/本地版本可比较 | 仅靠设备时间覆盖 |
| 订阅过期/退款 | 本地访问导出继续，新增云写按权益限制 | 静默删除云资料 |
| 账号切换 | 清理旧内存密钥/订阅，切namespace | 把旧账号数据上传到新账号 |
| 删除失败/未知结果 | 明确pending，幂等重试 | 先显示永久删除成功 |
| helper不可用 | 复制可用，自动粘贴暂不可用 | 再起同步PS冷助手 |

## 6. 视觉变量与组件接口

tokens存`packages/ui-web/src/tokens.json`，mobile只导入数值/颜色，不导入DOM组件。采用系统字体栈、浅/深两套语义颜色，遵守系统减少动画设置。

起始变量：spacing 4/8/12/16/24/32；radius card12/panel16/control8；desktop font body14/metadata12/title20；mobile body16/metadata13/title22；focusRing 2px；motion fast120ms/normal160ms（不能成为粘贴必等延时）。颜色：light background#F6F7FB/surface#FFFFFF/text#182032/muted#647084/accent#347CF3；dark background#111722/surface#1B2432/text#F1F5FA/muted#A6B2C4/accent#74A7FF。实现时验证文字/焦点对比度，不用单一颜色表达状态。

共享组件：SearchBar(value,onChange,onNavigate,onExecute,isComposing)、FilterChips、ClipCard(summary,selected,onSelect,onExecute)、ResultList(page,onLoadMore)、ItemPreview(detail)、SyncBadge、QuotaMeter、EmptyState、PermissionNotice、ConflictDialog。ClipCard不调用hostAPI，执行由上层一次性调度；可见卡片memo与稳定key，详情取消请求与generation绑定。

## 7. 初始引导与成功标准

桌面匿名首次：复制两段合成示例 → 热键唤醒 → 找回第一段 → 保存到“常用”。云介绍放在体验后；手机先完成主动分享保存；Web先完成受控粘贴保存。不得把用户真实剪贴板当教学示例上传。

UI验收：搜索框聚焦时Down/Enter工作；IME无误触；一次doubleclick只一job；新query不被旧响应覆盖；Esc层级正确；空/错误/锁定/离线/容量完整；收藏保留语义正确；小屏可完成查找与复制；减少动画模式无位移动画；键盘可达所有操作；禁止正文/URL/标题进入analytics。

参考：[Paste Mac](https://pasteapp.io/help/paste-on-mac)、[Pinboards](https://pasteapp.io/help/organize-with-pinboards)、[Paste iPhone](https://pasteapp.io/help/paste-on-iphone)、[Android剪贴板限制](https://developer.android.com/about/versions/10/privacy/changes#clipboard-data)、[Expo Clipboard](https://docs.expo.dev/versions/latest/sdk/clipboard/)。这些是平台/产品参考，以上ClipNest行为仍待实现与验收。
