# 04 · 桌面提速与原生状态机

实施顺序：L0修当前Electron1.1.4 → v2 Rust核心 → Windows Tauri PoC → macOS能力。L0源码路径`D:\ClipNest-work\electron-l0`，v2路径`D:\ClipNest-work\v2`。安装目录与真实历史不能作为开发输出或测试profile。

## 1. 基线与立即目标

2026-10-02独立组件：foreground spawnSync中位1628.295ms、paste class编译到READY1304.160ms、正常fixed waits280ms；选择后约3.2s只是预算，未测端到端。详见latency-diagnosis.md。

L0保持Electron/React/JSON历史/旧云协议。只改：常驻原生调用、粘贴状态与防重、键盘输入行为、点击重复编码。不要在此阶段同时换数据库、登录或同步协议。

## 2. 文件分解

L0：`src/main/native/helper-client.ts`（启动/协议/监督）、`src/main/native/content-provider.ts`（NativeContentProvider）、`src/main/paste/paste-controller.ts`（会话/复制流程）、`src/main/window/panel-controller.ts`、`src/shared/native-contracts.ts`；原main.ts改为调用模块。原生实现放`native/Cargo.toml`与`native/src/{main,control,paste,win32}.rs`；宿主授权薄桥放`native/bridge/Cargo.toml`与`native/bridge/src/lib.rs`，使用Node-API与windows-rs，仅暴露必要授权接口。v2沿用相同语义，迁入`crates/native-helper`、`crates/platform-windows`与`crates/core/src/paste`；Tauri Rust host直接执行宿主授权，不直接复制L0依赖main.ts。

helper为预编译Rust/windows-rs，可用stdin/stdout JSON-lines；stdout只协议，stderr有界元数据日志。随应用启动一次，窗口隐藏不退出；startup READY前完成无副作用查询预热。发布打包资源、x64/arm64、校验版本与hash；不在用户机运行Cargo或Add-Type。

## 3. 最小协议

```ts
type Target = { hwnd: string; pid: number; processCreatedAt: string }; // hwnd/Windows FILETIME创建值为Decimal字符串
type TriggerKey = 'Enter' | 'V';
type Envelope = { v:1; requestId:string; generation:string; helperInstanceId:string };
type Request = Envelope & (
 | { kind:'capture' }
 | { kind:'register_content'; jobId:string; objectToken:string;
     itemRef:string; expectedItemVersion:string; contentType:'text'|'image';
     totalBytes:number; totalHash:string; inlineBase64?:string }
 | { kind:'content_chunk'; jobId:string; objectToken:string;
     index:number; offset:number; base64:string; chunkHash:string }
 | { kind:'finish_content'; jobId:string; objectToken:string; totalHash:string }
 | { kind:'prepare'; jobId:string; objectToken:string; expectedItemVersion:string }
 | { kind:'commit_write'; jobId:string; prepareToken:string;
     baselineClipboardSequence:string; triggerKeys:TriggerKey[] }
 | { kind:'paste'; jobId:string; prepareToken:string; target:Target;
     expectedClipboardSequence:string; triggerKeys:TriggerKey[] }
 | { kind:'cancel'; jobId?:string }
);
type Result = { v:1; requestId:string; generation:string;
  helperInstanceId:string;
  objectToken?:string; prepareToken?:string;
  clipboardSequence?:string; target?:Target; insertedInputs?:number;
  durationMs:number; reasonCode?:string } & (
 | { status:'cancelled'|'too_late'; jobId?:string; workerQuiescent:boolean }
 | { status:'job_finished'; jobId:string; workerQuiescent:true }
 | { status:'ready'|'captured'|'content_registered'|'chunk_accepted'|'prepared'|
    'clipboard_written'|'input_submitted'|'busy'|'payload_invalid'|'key_held'|
    'copied_only'|'target_invalid'|'focus_denied'|
    'modifier_held'|'clipboard_changed'|'input_rejected'|'helper_unavailable';
    jobId?:string; workerQuiescent?:boolean }
);
```

renderer只提交itemRef，不传正文或文件路径。L0 NativeContentProvider从当前内存record取不可变快照，为该item/version注册临时objectToken；在途编辑必须使旧版本失效，不能只用可能重复的updatedAt充当版本。v2由native core从SQLCipher BLOB对象仓储读取，helper仅接授权对象引用与同一传输协议。两种host均不得重复传整个history。

小内容可inline；较大选中内容按有界chunk流发送：每个序列化frame含Base64与字段总共<=64KiB，raw chunk<=32KiB，总文本<=2MiB、单图原件<=20MiB，均以统一limits为准。先注册totalBytes/totalHash，再校验连续index、offset、每chunk hash与最终hash；每个chunk收到ACK后才发下一块，控制读循环不等待内容worker。cancel优先于下一chunk，不把取消塞在整幅图片后面。越限、缺块、重复乱序或hash错误立即失效，不进入写入。objectToken/prepareToken绑定profile、item/version、jobId、generation、helperInstance；只保留当前job的授权对象，结束、取消或重启即释放。

prepare只准备内容并返回prepareToken，不写剪贴板。commit_write必须执行原生条件写事务：先准备好数据，OpenClipboard取得独占权，核对选择时baselineSequence，未变化才EmptyClipboard/SetClipboardData；在独占权内记录该次写入的最终sequence，再CloseClipboard。不得在关闭后重读并把外部写入的sequence当自己的。baseline不匹配返回clipboard_changed且零写入。L0不能用Electron writeText/writeImage前后两次查询冒充该事务；无法实现条件写时禁止旧job的延迟写与自动输入，只保留用户另行主动触发的复制入口。任何失败都不恢复旧剪贴板，不自动重试写入。

stdio子进程由父应用独占，输入逐行校验长度/schema/generation；不暴露无鉴权localhost HTTP server。管道/Named Pipe替代时必须同用户ACL。helper重启产生新的instanceId/PID/创建时间，旧pending request全部失败，旧前台授权不复用。

## 4. 并发与状态机

控制读循环独立于Win32工作线程，持续处理cancel和shutdown；不等待焦点API、worker、stdout写入或长锁。active paste=1、pending paste=0；新意图先取消旧job，确认结束后才创建新job，不能积压点击。同requestId重放返回已有结果；同jobId的commit_write/paste最多执行一次，重复执行返回原结果或busy，正常register/chunk/prepare属于该job的不同阶段。capture在途最多1，主应用合并连续show意图；内容chunk在途最多1。收发缓冲各<=256KiB，单frame<=64KiB，超过上限关闭协议并使pending失败；响应写循环独立，背压不能停住取消读循环。

有效cancel ACK（包括too_late）必须包含`workerQuiescent:boolean`：accepted只保证提交门前不再输入，不证明阻塞worker已退出。job_finished必须包含jobId且workerQuiescent=true；它是独立终止事件，requestId引用该job首次register_content请求，不作为迟到普通ACK处理。宿主只接受与当前helperInstanceId/generation/jobId匹配的cancel ACK或终止事件；cancel指定jobId时响应必须回显，旧/未知job事件不能释放当前job。未指定jobId的cancel仅在宿主确认没有active job时允许接收无jobId且quiescent=true的空闲响应。有active job时，只有匹配的quiescent=true/后续job_finished才允许下一job；否则监督重启并等新READY。不能凭cancelled状态就复用仍被旧worker占用的资源。contracts用严格判别分支及关联字段验证这些要求，缺字段视协议失败。

冻结初始deadline：capture100ms；cancel ACK50ms；READY5000ms（仅启动/重启阶段）；内容准备3000ms；触发主键与修饰键释放共用从selection起的绝对500ms截止点；focus阶段250ms。正常成功立即推进。超时后打开/保留可复制面板，自动粘贴不可用；helper不确认取消或工作线程挂起时，在监督流程终止并重启helper，不能从热路径新启PS兜底。重新READY前不提交自动粘贴。deadline与队列参数进入统一limits配置，不在多处重新计时。

```text
IDLE -> REGISTERING -> PREPARING -> PREPARED -> CHECKING_KEYS
     -> CLIPBOARD_COMMITTING -> CLIPBOARD_READY -> WAITING_FOREGROUND
     -> WAITING_MODIFIERS -> INPUT_COMMITTING -> COMPLETED
任一提交前状态 -> CANCELLED/FAILED
INPUT_COMMITTING之后cancel -> TOO_LATE（不能承诺撤回）
```

最终校验先在控制锁外执行：HWND+PID+创建时间仍有效，foreground等于固定target，clipboard sequence等于自身写入序列，triggerKeys与所有修饰键已释放。随后进入同一个短提交门，只核对内存中的cancel/generation/job状态并转换INPUT_COMMITTING，立即解锁，再调用一次SendInput。cancel也通过该门确定accepted或too_late；协议cancel响应的cancelled表示accepted。门内不调用Win32、不等待管道或worker。accepted必须禁止后续输入，不能只忽略旧ACK；INPUT_COMMITTING后不得承诺撤销。

在CLIPBOARD_COMMITTING前取消应零写入；已开始的原生条件写不可回滚，取消仍禁止后续输入，结果明确可能已复制。已发出的异步焦点恢复同样不能撤销。等待阶段实时更新取消状态，并在每次后续恢复/API调用前检查；阻塞工作线程不能阻止控制线程确认取消。input_submitted只表示SendInput返回4，不表示目标实际完成粘贴。

目标和sequence核对与SendInput不是Windows提供的跨系统原子事务，用户在极短间隙切换仍有残余竞态。必须如实表达best-effort、尽量缩短提交间隙，不声称绝对不会投错窗口。SendInput成功只表示插入事件。

## 5. 唤醒和执行顺序

1. show请求先取消旧generation，等待取消结果或明确too_late；50ms内未确认则监督helper并禁用新自动粘贴，面板仍可打开。已发出的异步焦点恢复不能撤销；取消后不再发新的恢复/输入调用。新面板opening guard最多100ms，到首次本面板focus即结束；仅处理旧恢复在途造成的暂态，不吞掉用户真实Alt-Tab或其他新外部激活，未知blur按正常失焦处理。
2. 面板显示前捕获target身份，排除本应用/无效窗口；一次setBounds后show，发送panel:shown。capture异步不阻塞主事件循环；helper未ready可打开复制面板但不虚构target。
3. L0单击执行保留当前习惯时，删除额外dblclick执行；v2遵循01的单击选中、双击/Enter执行。pasteBusy/event.repeat/IME防重。
4. selection时记录baselineSequence与triggerKeys，创建job并开始内容准备；面板仍在前台。图片cache miss在worker准备并显示preparing，不阻塞主线程decode/PNG/hash。准备完成后验证item/version及面板仍为前台，再检查Enter/V和Ctrl/Shift/Alt/Win释放；即使准备前检查过，也必须重查。以selection起的500ms绝对截止点判断，图片准备跨过截止点且按键仍按住则终止，不能追加新500ms。超时/版本失效/用户切换保持已存在面板状态并结束自动输入；超预算不降采样覆盖原件。
5. 主键和修饰键释放后commit_write执行baseline条件写，返回该次sequence；关闭面板前再次检查面板前台身份、triggerKeys与修饰键。如果用户在准备/写入期间复制新内容或按下执行键，取消自动输入，不带着physical repeat隐藏。授权由当前前台宿主完成：L0薄Node-API桥调用AllowSetForegroundWindow(当前helperPID)，helper不能自授权；v2由Rust host调用。检查helperInstance/PID/创建时间一致，授权失败保留复制结果并结束。成功后才hide。
6. target已为前台直接继续；最小化才SW_RESTORE；用SetForegroundWindow与有deadline的GetForegroundWindow确认，不照搬AttachThreadInput+SwitchToThisWindow强制组合。恢复前后若发现目标/本应用之外的新前台应用或明确用户切换证据，取消，不能仍把固定target强拉回来。NULL/暂态只在250ms focus deadline内等待，已完成立即推进，无无条件sleep。只恢复保存的target，不以100ms后任意新前台替换它。
7. 最终再次用GetAsyncKeyState高位检查triggerKeys与左右Ctrl/Shift/Alt/Win；仍使用selection起的同一个500ms截止点，不重置。截止点已过但所有键均释放可立即继续；有键按住则结束，不能主动松开用户物理键来伪造状态。
8. 最终提交门检查全部条件；SendInput一次提交CtrlDown/VDown/VUp/CtrlUp并检查返回4。输入失败/未知结果不盲重试。外部clipboard变更不恢复旧内容，提示重新选择。
9. 通过ACK结束job，UI区分已复制/输入已提交/权限阻断/已取消。ipc invoke必须等对应任务Promise，不能安排timer就当粘贴完成。

## 6. 图片、采集与后台任务

监听AddClipboardFormatListener/WM_CLIPBOARDUPDATE，先GetClipboardSequenceNumber再处理变化；L0可先保留450ms轮询但用sequence短路，v2切事件。合并同sequence、延迟渲染读失败有界重试、过期采集取消。

原件与thumbnail分别存；decoded cache32MiB、图片worker1、单图20MiB/16MP、worker峰值预算256MiB。配置来自limits。缓存不够时保留原件文件，解码在worker，图片非命中场景单独统计。不得为防自身采集在点击后重复toPNG/base64/hash，JPEG历史hash不能冒充新PNG剪贴板hash。

此处L0保留旧格式；v2的本机原件/thumb按02/03存SQLCipher BLOB对象表，只有云传输staging为独立密文文件，禁止写独立明文缓存。控制帧/缓冲/原始chunk/各deadline分别引用limits.transport的helper*字段，不另写常量。

保存、云KDF、网络、全库查询不进主事件循环。UI只接收分页摘要与变更ID。全局hotkey不等待同步/磁盘。动画一次最终bounds+内容transform/opacity；减少动画设置禁用位移动画。

## 7. Windows和macOS能力

Windows必须验证：Notepad/Chrome/VSCode常规输入、最小化/最大化、不响应目标、窗口关闭、PID/句柄复用、持续按键、管理员目标、快速重开和外部剪贴板变化。高权限目标受UIPI限制，不能用错误码保证识别原因；支持复制降级。

macOS：pasteboard.changeCount驱动变化检查；用公开系统能力捕获目标/应用身份，自动粘贴需辅助功能授权。授权拒绝时复制/查找仍工作。读取/输入均按主线程与原生API要求隔离，完成签名/公证/多屏/菜单栏验收。WindowsHWND不能套用mac语义，统一的是接口和结果码。

## 8. fixture、指标与Tauri gate

P01 target已前台无等待；P02需要恢复；P03最小化；P04最大化不改尺寸；P05窗口失效；P06held Shift；P07cancel before提交；P08cancel during等待；P09cancel after提交too_late；P10helper崩溃未知结果不重发；P11外部sequence变更不覆写；P12双击/重复Enter；P13新面板不接受旧ACK；P14更高权限复制降级；P15同图不变零编码；P16cache miss；P17queue/内存上限；P18用户切换应用停止旧注入。P01–P18按本节对应状态设置前置条件，使用记录调用次数的FakePlatform验证每个动作和零注入失败路径，不能只登记fixture名称。

| fixture | 前置条件与动作 | 必须断言 |
|---|---|---|
| P19 内容准备期间外部复制 | baseline=41；prepare未结束时外部写入使seq=42；随后commit_write | clipboard_changed；EmptyClipboard/SetClipboardData/SendInput调用均为0；外部内容保留 |
| P20 自身写入后外部复制 | 条件写得到ownSeq=42；输入门前外部seq=43 | 零SendInput，绝不恢复旧内容，ownSeq不改成43 |
| P21 准备期间重新按Enter/V | 图片miss；准备前主键已释放，完成时Enter或V重新按住 | 面板不hide；截止点前释放才继续，否则key_held且零SendInput；最终门再查 |
| P22 阻塞工作线程时取消 | FakePlatform的焦点调用挂起；控制通道发cancel | <=50ms确认取消或监督进入unavailable；读循环不等worker；worker释放后不调用后续恢复/SendInput |
| P23 取消与提交竞争 | 在最终内存提交门的前/后分别发cancel | 门前accepted对应零SendInput；门后too_late；SendInput最多1次；不得重发 |
| P24 token授权与版本失效 | 完成prepare后改item/version、换profile、helper重启，分别重放旧token | payload_invalid/helper_unavailable；零剪贴板写和零SendInput；不解析任意路径 |
| P25 chunk越限或不完整 | 超64KiB frame、超总限、乱序、缺块、错误hash分别注册 | 立即失败并释放objectToken；不prepare、不写剪贴板；正常流每次仅1个未ACK chunk |
| P26 前台授权失败/实例变化 | 宿主不在前台、AllowSetForegroundWindow失败或helperPID/创建时间变化 | 不hide进行自动恢复；保留已复制结果；旧授权不可用于新实例 |
| P27 新外部前台激活 | hide后focus准备过程中激活另一应用 | cancelled；不调用新的SetForegroundWindow，不注入，不用opening guard掩盖用户切换 |
| P28 快速连续意图/背压 | active job进行中重复Enter、双击、show；限制stdout消费 | active<=1、pending paste=0；重复意图不重复写入；取消读循环可运行；缓冲越限进入unavailable |

计时分开hotkey/capture/show/firstFrame/actionable，以及selection/write/hide/focus/modifier/inputSubmitted。requestId对齐，各进程单调时钟报告自身耗时；不能直接相减不同进程未校准时钟。每个正常场景>=100次，失败/取消/超时另报。

T11完成最小真实链路：托盘、hotkey、hide/show、多屏、纯文本/图片复制、focus降级、增量摘要、Rust仓储后台运行。验收预热wake P95<100ms、普通小文本inputSubmitted P95<150ms；完整应用所有子进程内存/闲置CPU与L0相同场景比较，不能仅报Rust进程。Tauri若能力/稳定性不达门槛，停止迁移并保留Electron host，核心继续独立。不会以更小安装包代替操作体验验收。

本轮只做设计，不自动向用户目标应用注入按键。真实输入验收在专用测试窗口、合成文本与明确的测试操作范围中进行。

来源：[SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)、[SetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)、[AllowSetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-allowsetforegroundwindow)、[clipboard listener](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-addclipboardformatlistener)、[windows-rs](https://github.com/microsoft/windows-rs)。
