# 03 · 数据、同步与安全执行规格

状态：待实现；本文是确定性协议规格，不是已完成的安全认证。首发只实现个人空间。团队表结构占位，所有创建/邀请/分享接口返回 `FEATURE_NOT_ENABLED`。

上位决策：[产品与云方案](00-README.md)。代码只写入 `D:\ClipNest-work\v2`，不在安装目录或本文目录生成服务代码。包管理使用 pnpm；Rust 使用 Cargo。任务编号以主 README 的 T00～T32 为准。

## 1. 不得改变的边界

1. 桌面 Tauri 2 + Rust，手机 RN + Expo development build，Web React + Dexie，服务器 TS + Fastify + PostgreSQL + S3 私有桶；服务器保持模块化单体。
2. `packages/contracts` 保存 DTO、错误码、协议编码、测试向量和容量配置；`packages/domain` 保存纯 TS 状态机。桌面仓储/加密适配在 `crates/core`，手机仓储/加密使用平台适配。TS 规则不能代替服务器鉴权、配额、CAS 校验。
3. 个人内容在客户端加密；云服务器不获得正文、标题、OCR、预览、来源应用、工作空间数据密钥或恢复凭证。服务器可以看见账号、设备、空间、对象类型、大小、版本、时间、引用关系等必要元数据。隐私文案必须写明此边界。
4. 账号登录、设备授权、内容解锁是三个不同状态。账号密码重置不能恢复内容密钥；登录 token 不是数据密钥。
5. 本机 LRU/历史缓存淘汰仅删除本机副本，不能生成云删除操作。账号历史保留到期、用户删除才生成全局墓碑。收藏不按历史 TTL 淘汰。
6. 正文/附件不经完整 Base64 JSON 传输。只有小型密文 manifest 可以使用 Base64URL。全文检索在解锁后的客户端进行；服务器不做正文索引。未完成本地索引时必须显示检索覆盖范围。
7. 不自研密码算法、CRDT、任务调度器、账号/支付系统。后台任务复用 pg-boss；业务 outbox、配额账本是本产品事务数据，不是另造任务调度器。
8. 本文所有容量从 [limits.v1.json](limits.v1.json) 读取；实施时复制至 `packages/contracts/src/limits.v1.json`。不得在 SQL/TS/Rust/移动端另写同值常量。JSON 当前是实验默认值，不能用作正式报价或生产性能承诺。

## 2. 协议数值、身份与内容语义

### 2.1 标量

```ts
type Uuid = string;        // UUID v4，小写标准格式；服务器严格验证
type Decimal = string;     // /^(0|[1-9][0-9]*)$/；解析为 PG bigint / Rust u64 / JS bigint
type Base64Url = string;   // RFC 4648 URL alphabet，无 padding；解码后再校验长度
type EntityKind = 'history' | 'saved' | 'collection' | 'collection_entry';
type BlobPurpose = 'text_body' | 'image_original' | 'image_thumb' | 'ocr_body';
type SyncScope = 'local_only' | 'personal_cloud';
```

`revision/seq/epoch/keyVersion/recoveryVersion` 不允许 JSON number。PG 实际使用非负 `bigint`，上界为 PG signed bigint；计数器达到上界拒绝写入 `COUNTER_EXHAUSTED`，不能绕回 0。浏览器不能用 `parseInt/Number` 排序这些字段。`bytes` 也是十进制字符串，显示值最后一步才转为有界 number。

### 2.2 ID 生命周期

| ID | 创建方与生命周期 | 禁止事项 |
| --- | --- | --- |
| `userId/workspaceId` | 服务器创建；个人空间唯一归属于同一 user；区域首发单写 | 不能用邮箱、商店 transactionId、OAuth subject 直接替代内部 UUID |
| `deviceId/entityId/versionId/attachmentId/opId` | 客户端 CSPRNG UUID v4；创建后永久固定 | 不能用 Date.now、自增本机整数、内容 hash 或标题作身份 |
| `uploadId/snapshotId/pairId/challengeId` | 服务器随机 UUID；有状态、有过期时间 | 不能用对象 key 作为授权凭据 |
| `kid` | 客户端随机 UUID；定位指定 workspace 的指定随机 key | 不能把 kid 当 secret，不能只改 kid 却继续使用被泄露的旧 key |

一个采集快照生成一个 `history` ID；“保存为收藏”创建新的 `saved` ID，可引用同空间同附件，不能把原历史原地改成收藏。收藏编辑产生版本；历史正文不可修改，只有创建与删除。收藏夹、收藏关系分别是独立实体：pin/unpin 修改 `collection_entry`，不能改 saved 的正文 revision。正文不含 pin 字段。

删除后保留 `entities` 的最小 ID 栅栏（ID、kind、最终 revision、删除/退休标记），重正文/旧版本可回收。任何 create/update 不能再次使用该 ID。恢复回收站内容或建立冲突副本创建新 ID、新 versionId 并重新加密；不得由服务器复制旧 ciphertext 后冒充新 ID。ID 栅栏受实体数量预算限制，不承诺无限元数据。

create时同时预留该ID将来删除后的栅栏名额：`liveEntities+retiredIds+1 <= maxRetiredIdsPerWorkspace`，并满足maxLiveEntitiesPerWorkspace；delete只把已预留名额转为retired，不因栅栏满而拒绝用户删除。达到终身ID预算阻止新create并给导出/显式新空间迁移入口；不能后台删栅栏以腾空间，或让清空历史自动重置身份。

`capturedAt/lastCopiedAt/lastUsedAt/updatedAt` 在客户端密文内分别记录。服务器时间只用于配额、租约、保留期和日志，不用客户端时钟决定写入优先级。

## 3. PostgreSQL 表、约束与隔离

### 3.1 角色与请求事务

迁移 owner、鉴权组件角色、业务 API 角色、worker 角色分开。业务 API 和 worker 均 `NOSUPERUSER NOBYPASSRLS`，不能是业务表 owner。所有业务表 `ENABLE ROW LEVEL SECURITY` 与 `FORCE ROW LEVEL SECURITY`；RLS 不是对数据库 superuser 的防护。

鉴权组件维护独立 `auth` schema。由可信适配把 Better Auth subject 映射为内部 `userId`，不要让请求参数决定 userId。业务个人空间仍以 owner 为唯一权限来源；Membership 只是为团队预留，首期不能授予第二个用户。

每次业务请求先验证账号会话与设备 credential，再进入以下事务。禁止在连接池 checkout 时设置永久上下文；所有作用域都是当前事务 LOCAL。

```sql
BEGIN;
SELECT set_config('cn.user_id', :verified_user_uuid, true);
SELECT set_config('cn.workspace_id', :authorized_workspace_uuid, true);
SELECT set_config('statement_timeout', :limits_statement_timeout_text, true);
SELECT set_config('lock_timeout', :limits_lock_timeout_text, true);
-- text values are generated from validated limits milliseconds, never client input
COMMIT; -- error path must ROLLBACK before returning the connection
```

`server.statementTimeoutMs/lockTimeoutMs` 已纳入唯一配置，读取JSON后生成set_config参数，不能照抄另一个文件里的 SQL 字面量作为第二配置源。业务入口不可在设置 scope 前查询正文、签名下载 URL 或更新账本。服务器连接池上限来自 concurrency.serverDatabasePoolPerProcess；snapshot worker独立有界连接池，不因为前端并发数自动扩大。

```sql
CREATE FUNCTION cn_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('cn.user_id', true), '')::uuid
$$;
CREATE FUNCTION cn_workspace_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('cn.workspace_id', true), '')::uuid
$$;

-- workspaces 表策略，INSERT 同样验证 owner：
CREATE POLICY workspace_owner ON workspaces
  USING (workspace_id = cn_workspace_id() AND owner_user_id = cn_user_id())
  WITH CHECK (workspace_id = cn_workspace_id() AND owner_user_id = cn_user_id());

-- 每张 workspace 业务表套用此模式；EXISTS 的 workspaces 也有上述 RLS：
CREATE POLICY tenant_owner ON entity_versions
  USING (workspace_id = cn_workspace_id() AND EXISTS (
    SELECT 1 FROM workspaces w
    WHERE w.workspace_id = entity_versions.workspace_id
      AND w.owner_user_id = cn_user_id()))
  WITH CHECK (workspace_id = cn_workspace_id() AND EXISTS (
    SELECT 1 FROM workspaces w
    WHERE w.workspace_id = entity_versions.workspace_id
      AND w.owner_user_id = cn_user_id()));
```

对业务 role 未授权的对象统一 404；不能通过 403/404 差异、签名 URL 或全局 hash 查询泄露其他空间对象是否存在。UUID 难猜不能代替权限检查。jobs 只保存 workspace/operation ID，不保存明文；worker 每个 workspace 重新建立受限事务，不能给它任意 `BYPASSRLS`。

### 3.2 表定义清单

以下是迁移必须实现的列与约束；`wid/eid/vid/aid` 只是表格缩写，实际列名必须使用全名。`timestamptz` 时间由服务器生成。`bytea` 使用真实二进制，不在 PG 内储存 Base64。

| 表 | 关键列、主键、约束 |
| --- | --- |
| `workspaces` | `workspace_id uuid PK, owner_user_id uuid NOT NULL, kind text CHECK IN ('personal','team'), region text, epoch bigint CHECK >0, last_seq bigint CHECK >=0, min_retained_seq bigint CHECK >=0 AND <=last_seq, recovery_version bigint CHECK >=0, suspended bool, created_at`；个人空间 `UNIQUE(owner_user_id) WHERE kind='personal'` |
| `memberships` | PK `(wid,user_id)`；`role CHECK IN ('owner','editor','viewer')`；FK wid→workspaces；首期 API 只允许 personal owner 本人 |
| `devices` | PK `(user_id,device_id)`；`public_key bytea CHECK octet_length=32, credential_hash bytea CHECK length=32 NULLABLE, status CHECK IN ('pending','active','revoked'), created_at, last_seen_at`；user-scoped RLS `user_id=cn_user_id()`；禁止通过更新 public_key 偷换已激活设备，换密钥创建新 deviceId |
| `workspace_devices` | PK `(wid,device_id)`；`user_id, status, sync_state CHECK IN ('snapshot_required','active','revoked'), epoch, applied_seq bigint, lease_expires_at, bootstrap_snapshot_id NULLABLE`；FK `(user_id,device_id)`→devices，`(wid,user_id)`→memberships；`applied_seq` 只能单调推进同 epoch；新设备/过期租约必须snapshot_required |
| `key_versions` | PK `(wid,key_version)`；`kid uuid, suite text CHECK='CN-XCHACHA20POLY1305-1', status CHECK IN ('active','read_only')`；`UNIQUE(wid,kid)`；没有明文 key 列 |
| `recovery_packages` | PK `(wid,recovery_version)`；`package_id uuid, nonce bytea CHECK length=24, ciphertext bytea, recovery_public_key bytea CHECK length=32, created_at`；密文长度≤inlineEncryptedPayloadBytes；每次更换恢复凭证产生新版本；不能仅凭登录会话覆盖 |
| `pair_requests` | PK `(wid,pair_id)`；`device_id, pair_nonce bytea CHECK length=32, status CHECK IN ('pending','approved','consumed','expired'), grant_ciphertext bytea, grant_hash bytea CHECK length=32, expires_at`；FK `(wid,device_id)`→workspace_devices；批量/大小受 keyProtocol 配置限制 |
| `key_challenges` | PK `(wid,challenge_id)`；`device_id, purpose CHECK IN ('recovery_activate','recovery_replace'), nonce bytea CHECK length=32, expires_at, consumed_at`；FK `(wid,device_id)`→workspace_devices |
| `entities` | PK `(wid,eid)`；`kind CHECK IN EntityKind, revision bigint CHECK >0, head_version_id uuid, trash_head_version_id uuid, trash_expires_at, head_seq bigint CHECK >0, deleted_at, retired_at, expires_at, created_at`；`retired_at IS NOT NULL => deleted_at IS NOT NULL`；删除时head转trash_head，记录deleted_at+trashDays；删除后 eid 禁止重用 |
| `entity_versions` | PK `(wid,eid,revision)`；`version_id uuid, kid uuid, key_version bigint, nonce bytea CHECK length=24, ciphertext bytea, created_seq bigint, created_at`；`UNIQUE(wid,version_id)`；FK `(wid,eid)`→entities，`(wid,kid)`→key_versions；ciphertext≤inlineEncryptedPayloadBytes；每个版本不可变 |
| `collection_entries` | 仅当前活跃关系的投影，PK `(wid,entity_id)`；`collection_id,target_item_id`；FK `(wid,entity_id)/(wid,collection_id)/(wid,target_item_id)`→entities；`UNIQUE(wid,collection_id,target_item_id)`；关系实体delete同时删本投影、保留entities墓碑，从而允许新ID repin；端点不可修改；应用验证类型分别为 collection_entry/collection/saved |
| `attachments` | PK `(wid,aid)`；`purpose, kid, key_version, nonce bytea CHECK length=24, final_object_key text, final_object_version text, cipher_sha256 bytea CHECK length=32, cipher_bytes bigint CHECK >0, state CHECK IN ('ready','deleting','deleted'), created_at`；FK `(wid,kid)`；`UNIQUE(final_object_key)`；仅 ready 能新建引用；无跨空间内容 hash 索引 |
| `version_attachments` | PK `(wid,version_id,attachment_id,purpose)`；FK `(wid,version_id)`→entity_versions，`(wid,attachment_id)`→attachments；实际允许的 purpose 与 manifest 必须一致 |
| `uploads` | PK `(wid,upload_id)`；`attachment_id uuid, reserve_op_id uuid, purpose,kid,key_version,nonce,expected_cipher_bytes bigint, cipher_sha256 bytea, staging_object_key, staging_object_version, final_candidate_key, final_candidate_version, state, signed_until,reservation_expires_at, failure_code, created_at`；状态见第 8 节；`UNIQUE(wid,reserve_op_id)`、`UNIQUE(wid,attachment_id)`；最终 attachment 的身份在 reserve 时冻结 |
| `usage_ledgers` | PK wid；`logical_bytes, reserved_bytes, staging_bytes, pending_final_bytes, live_object_count, staging_object_count, pending_final_object_count, reserved_object_count, ledger_version bigint`，全部非负；logical/live对象包含当前/历史版本、回收站、已 ready 的孤立附件；同一附件只计一次；实际暂存/复制占用不能凭 reservation 过期归零 |
| `usage_events` | PK `(wid,event_id)`；`source_type,source_id,phase, logical_delta,reserved_delta,staging_delta,pending_final_delta,live_object_delta,staging_object_delta,pending_final_object_delta,reserved_object_delta, created_at`；`UNIQUE(wid,source_type,source_id,phase)`；补偿/重放不能重复计账 |
| `change_log` | PK `(wid,seq)`；`epoch,eid,revision,version_id NULLABLE, action CHECK IN ('upsert','delete'),op_id,committed_at`；索引按 seq keyset；记录不内联大正文；upsert 的版本在日志有效期内不可回收 |
| `operation_receipts` | PK `(wid,op_id)`；`device_id,request_sha256 bytea CHECK length=32,terminal_status,response jsonb, committed_seq NULLABLE,created_at`；只持久化成功和终止性 CAS/删除冲突结果；重试必须匹配 request hash |
| `snapshots` | PK `(wid,snapshot_id)`；`epoch,high_water_seq,status CHECK IN ('building','ready','expired'),row_count,created_at,expires_at`；`UNIQUE(wid) WHERE status IN ('building','ready')`，同空间复用尚有效ready快照，最多一个有效/构建中快照；无跨请求 DB transaction handle |
| `snapshot_rows` | PK `(wid,snapshot_id,entity_id)`；`kind, dto bytea`（严格序列化的小 manifest DTO）；FK snapshot→snapshots；只含物化时活跃当前版本；行不可变 |
| `snapshot_attachment_refs` | PK `(wid,snapshot_id,attachment_id)`；FK snapshot→snapshots、attachment→attachments；快照有效期间是 GC pin；否则分页快照可能引用已删对象 |
| `business_outbox` | PK `(wid,event_id)`；`type,source_id,payload jsonb,dispatched_at`；不含正文；同事务写入，dispatcher 向 pg-boss 发 jobId=eventId，重复派发幂等 |

约束补充：`entity_versions` 通过 `(wid,key_version,kid)` 的三列唯一键/FK 确保 kid 与 keyVersion 匹配；附件、uploads 同样执行。不能分别引用两个存在但不属于同一版本的列。`entities.head_version_id/trash_head_version_id` 使用 `DEFERRABLE INITIALLY DEFERRED` 的复合 FK 指向 `(wid,eid,version_id)`，版本表补此唯一约束；delete的正常head为NULL，但trash_head直到trash_expires_at仍受保护。退休后两指针才可清空。只给 `snapshot_rows`→snapshots 和快照 pin 等派生表使用明确 `ON DELETE CASCADE`，不得对 workspace→版本/账本/附件随意级联绕过物理回收。

所有wid列都另外FK→workspaces；主键列和身份/算法/计数列NOT NULL。只有状态明确尚未知/不适用的列可NULL：pending device credential、尚无bootstrap的snapshot ID、entities删除/退休/expiry与两个head指针、upload尚未产生的object version/candidate/failure、receipt未成功的seq、delete change的version、outbox未派发的时间。实体CHECK：活跃时head非NULL且trash_head为NULL；deleted时head为NULL；trash_head非NULL则trash_expires_at必须非NULL。upload的各阶段CHECK在T18迁移中按第8节状态建立，不能让ready缺final对象/大小/hash。

同一版本每个BlobPurpose最多一个attachment，最多四种purpose；关系实体不能有附件。`version_attachments`补UNIQUE `(wid,version_id,purpose)`。duplicate purpose/ref拒绝INVALID_ENVELOPE；不能把refs变成无界数组。集合或saved目标deleted时不显示关系；并发创建相同活跃集合关系碰UNIQUE，转换为409 COLLECTION_ENTRY_EXISTS并返回本人空间已有relation ID，不能变成数据库500。

最低索引清单（PK/UNIQUE 已覆盖的不要重复建）：

```sql
CREATE INDEX memberships_user_idx ON memberships(user_id, workspace_id);
CREATE INDEX workspace_devices_user_idx ON workspace_devices(user_id, device_id);
CREATE INDEX workspace_devices_lease_idx ON workspace_devices(workspace_id, lease_expires_at);
CREATE INDEX entities_live_idx ON entities(workspace_id, kind, head_seq, entity_id)
  WHERE deleted_at IS NULL;
CREATE INDEX entities_expiry_idx ON entities(workspace_id, expires_at, entity_id)
  WHERE deleted_at IS NULL AND expires_at IS NOT NULL;
CREATE INDEX versions_retention_idx ON entity_versions(workspace_id, created_at, entity_id, revision);
CREATE INDEX versions_key_idx ON entity_versions(workspace_id, key_version, kid);
CREATE INDEX entries_collection_idx ON collection_entries(workspace_id, collection_id, entity_id);
CREATE INDEX entries_target_idx ON collection_entries(workspace_id, target_item_id, entity_id);
CREATE INDEX refs_attachment_idx ON version_attachments(workspace_id, attachment_id, version_id);
CREATE INDEX uploads_gc_idx ON uploads(workspace_id, state, reservation_expires_at, upload_id);
CREATE INDEX uploads_key_idx ON uploads(workspace_id, key_version, kid);
CREATE INDEX attachments_gc_idx ON attachments(workspace_id, state, created_at, attachment_id);
CREATE INDEX attachments_key_idx ON attachments(workspace_id, key_version, kid);
CREATE INDEX receipts_retention_idx ON operation_receipts(workspace_id, created_at, op_id);
CREATE INDEX snapshot_refs_attachment_idx ON snapshot_attachment_refs(workspace_id, attachment_id, snapshot_id);
CREATE INDEX business_outbox_pending_idx ON business_outbox(workspace_id, event_id)
  WHERE dispatched_at IS NULL;
```

另为每一个未被前缀覆盖的复合 FK 建对应索引：pair/challenge 的 `(wid,device_id)`、workspace_devices 的 `(wid,user_id)`、snapshot_rows/ref 的 `(wid,snapshot_id)`。所有查询必须先按 workspace 过滤；不使用 OFFSET。现有安装目录无生产数据库，T16 必须创建实际迁移并在临时 PG 上验证，而不是把本文表格当作已执行 SQL。

## 4. 密文格式与成熟库路线（T15）

### 4.1 冻结依赖

统一使用官方 libsodium：C 核心 1.0.22，Web `libsodium-wrappers` 0.8.4及其官方`libsodium`WASM依赖0.8.4，用pnpm override+lock固定传递版本；Rust 使用 rust-bindgen 生成薄 FFI 后只暴露本节固定函数，RN Expo native module 同样链接官方 C 核心。不用已归档的 sodiumoxide；不用不满足用户门槛的小型第三方 RN crypto 包。原生薄接口不是新密码算法。

2026-10-02 GitHub API 核验：libsodium 13,971 stars、最近推送 2026-09-28；libsodium.js 1,157 stars、2026-09-25；rust-bindgen 5,300 stars、2026-09-27；pg-boss 4,015 stars、2026-10-02。均通过“≥1000 stars、半年内更新”初筛；具体依赖 lockfile/许可证/安全公告仍由 T15/T16 验证。[libsodium](https://github.com/jedisct1/libsodium)、[libsodium.js](https://github.com/jedisct1/libsodium.js)、[rust-bindgen](https://github.com/rust-lang/rust-bindgen)、[pg-boss](https://github.com/timgit/pg-boss)

如果选定 C/WASM 包的实际稳定版本互不兼容，停止云发布并上报，不让低能力模型自动换算法/库。`pnpm-lock.yaml/Cargo.lock` 固定版本；禁止 remote CDN 动态加载 crypto。Expo Go 不含本原生模块，使用 development build。

crypto版本快照补充（供T00/T06合并到versions.snapshot.json，本文不修改该JSON）：

```json
{
  "checkedDate": "2026-10-02",
  "status": "candidates-not-yet-installed-or-compatibility-tested",
  "cryptoCandidates": {
    "libsodiumC": "1.0.22",
    "libsodium-wrappers": "0.8.4",
    "libsodiumWasmTransitive": "0.8.4",
    "rustBinding": "bindgen-generated FFI to pinned official libsodium C",
    "mobileBinding": "Expo native module to pinned official libsodium C"
  },
  "repositoryChecks": [
    { "repo": "jedisct1/libsodium", "stars": 13971, "pushedDate": "2026-09-28" },
    { "repo": "jedisct1/libsodium.js", "stars": 1157, "pushedDate": "2026-09-25" },
    { "repo": "rust-lang/rust-bindgen", "stars": 5300, "pushedDate": "2026-09-27" }
  ],
  "freezeGate": "T15 verifies exact C/WASM/Hermes interop, dependency artifacts, toolchain and full pairing/recovery protocol before cloud enablement"
}
```

rust-bindgen具体crate版本、C源码校验值和Web WASM产物校验值由T06/T15安装冻结时记录；上面生成FFI路线不能被误读为“Rust已经有测试通过的移动/Web统一binding”。npm官方registry当日确认wrappers0.8.4，其传递依赖仍声明`libsodium:^0.8.0`，因此必须显式override与lock到0.8.4，不能仅锁wrappers。[npm官方metadata](https://registry.npmjs.org/libsodium-wrappers)、[libsodium源码](https://github.com/jedisct1/libsodium)、[libsodium.js源码](https://github.com/jedisct1/libsodium.js)

### 4.2 算法与 AAD

数据/恢复包 AEAD：`crypto_aead_xchacha20poly1305_ietf_encrypt/decrypt`，随机 32-byte key、每次 CSPRNG 新 24-byte nonce、16-byte tag。nonce 重试时复用原封装字节，修改正文/目标 ID/revision 必须重新加密并新 nonce。官方构造适合随机大 nonce，但这不是允许应用复用 nonce 的理由。[XChaCha20-Poly1305](https://doc.libsodium.org/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction)

```ts
interface EncryptedManifestV1 {
  envelopeVersion: 1;
  suite: 'CN-XCHACHA20POLY1305-1';
  workspaceId: Uuid;
  entityKind: EntityKind;
  entityId: Uuid;
  versionId: Uuid;
  revision: Decimal;          // proposed revision = baseRevision+1；CAS 成功不能改它
  kid: Uuid;
  keyVersion: Decimal;
  routing: { collectionId?: Uuid; targetItemId?: Uuid; attachmentIds: Uuid[] };
  nonce: Base64Url;           // 解码固定 24 bytes
  ciphertext: Base64Url;      // 包含 AEAD tag；decode length≤inlineEncryptedPayloadBytes
}
```

AAD 不用随意对象 `JSON.stringify`。冻结如下 **ASCII 数组**紧凑 UTF-8 编码，没有空白：

```text
["CN:manifest:1","CN-XCHACHA20POLY1305-1",workspaceId,entityKind,entityId,
 versionId,revision,kid,keyVersion,collectionIdOrEmpty,targetItemIdOrEmpty,
 sortedUniqueAttachmentIds]
```

所有 UUID 小写标准化，数字为 canonical decimal 字符串，attachments 按 ASCII 排序且不可重复。此 canonical 编码函数和测试向量在 contracts 中；Rust 必须对照同一字节向量实现。nonce 是 AEAD 参数，不能被服务器修改；服务端的 seq/epoch/接收时间不进入 AAD，因为它们不是创建密文时已知的内容身份。反复同步同一版本不能重新加密。

解密后验证 plaintext 内的 `entityId/versionId/revision` 与头一致、attachment 描述的 ID/purpose/hash 与 authenticated routing 相符。正文、图片信息、来源、标题、标签、预览、OCR、客户端时间都在 plaintext manifest；服务端不将这些字段抽出来做 summary。manifest 超过 inline 限值时将正文/OCR作为附件，再加密小 manifest；单 text UTF-8 上限仍是 maxTextUtf8Bytes，不通过拆成 N 个 blob 绕过限制。

附件二进制封装：上传 body 只有 `ciphertext || tag`，nonce/kid/purpose 固定在 reserve 元数据。附件 AAD 为：

```text
["CN:blob:1","CN-XCHACHA20POLY1305-1",workspaceId,attachmentId,purpose,kid,keyVersion]
```

同附件可被同空间多个版本引用；AAD 不绑定某个 saved/history ID。服务端校验密文字节上限；它无法证明客户端声明的明文字数或图片像素是真的。每个客户端解密/导入后重新校验 text/image/decoded pixel 限值，再进入图片 worker；不能直接解码任意云图片。图像原件不能被降采样覆盖，缩略图另建 image_thumb 附件。

Rust/native-helper传输遵守transport.helperFrameBytes，最大2MiBtext与图片只传受控临时file/object ref（路径限制、所有者、长度/hash、一次性token），不塞进64KiB控制帧。图片worker并发、decoded cache与峰值预算读取concurrency.imageWorkers/imageWorkerPeakBytes与local.decodedImageCacheBytes；加密不能成为一次无界复制所有附件到JS/Rust内存的理由。

密钥派生只使用 libsodium `crypto_kdf_derive_from_key`，context 固定 8 个 ASCII bytes。workspace root 是随机 32 bytes；context `CNDataV1`、subkey_id=1 派生正文/附件 AEAD key。恢复 secret 是另一随机 32 bytes，context `CNRecov1`、subkey_id=1 派生恢复包 key，subkey_id=2 派生 Ed25519 signing seed；这两者不能互用。[官方 KDF](https://doc.libsodium.org/key_derivation)

kid/keyVersion 标识 workspace root，key ring 保存 root。首发新 workspace keyVersion=1。增量格式预留多 key；数据泄露后的完整 key 轮换、重新包裹历史、恢复凭证轮换必须单独通过 T15 安全 gate，不能宣称“删除设备已经消除了旧数据 key”。撤销接口权限立即生效；已解密副本无法撤回。

### 4.3 T15 阻断性 gate

云默认关闭，只有以下检查全通过才允许改变运行时 feature flag；不是只跑 unit test 就宣布端到端安全：Rust/Chromium Web WASM/iOS Hermes/Android Hermes 同向与交叉加解密；CSPRNG 可用；AAD 全字段篡改失败；二进制/header长度校验；key ring 与跨端包裹向量；崩溃后无 key 日志；依赖安全检查；完整设备配对/恢复协议独立安全评审。

T15先交付`packages/crypto-native`中的可复用RN native crypto module与key-vault适配，以及该包`harness/`中的独立Expo development-build测试App；它使用独立测试bundle ID/合成向量，不等待T22/T23移动业务App scaffold完成。iOS/Android Hermes在此harness中验证同一生产module。T23只把已验证module集成到mobile repository/share业务，不再首次实现密码适配。原生harness依赖改变后才重建，向量/协议测试尽量复用同一development build，减少重复XcodeBuild；缺少真机/对应构建工具只能标未验收，不能用Node测试冒充Hermes验收。

威胁范围：服务器存储密文、一般网络攻击、设备访问撤销。客户端系统被攻陷、Web 服务交付恶意 JS 时无法保证内容保密；本文不实现防恶意服务器遗漏/回滚的透明日志或共识。已同步客户端记录见过的最高 revision/highWater，发现倒退报 `REMOTE_ROLLBACK_DETECTED`，但不能给首次恢复设备承诺完整的恶意服务器回滚防护。

## 5. 设备配对、恢复和密钥保存（T14/T15）

### 5.1 首次启用个人云

1. 明确选择需要同步的本机内容，不自动上传全部匿名历史。
2. 登录账号，服务器创建个人 workspace 和 pending device；客户端生成独立 crypto_box keypair、本地 workspace root、恢复 secret、随机 device credential（32 bytes）。credential 只用于 API 设备鉴权，与 root/恢复 secret 不同；server只存 SHA-256 hash。
3. 本机生成恢复包 `{workspaceId,recoveryVersion,keyRing}`，按恢复包 AAD `["CN:recovery:1",workspaceId,packageId,recoveryVersion]` AEAD 包裹。服务器只保存密文、nonce、公开 recovery Ed25519 public key；auth token/password 不参与 key 派生。
4. 首次初始化须有单独 `workspace_not_initialized` 原子条件，一次成功后不可凭普通账号会话替换恢复包/公钥或给新设备授权。客户端完成保存恢复凭证的校验流程后才进入 `unlocked+active`，随后可发送同步 mutation。

### 5.2 已授权设备批准新设备

1. 新设备登录同一账号，建立 pending device，使用 libsodium crypto_box keypair；QR 含协议、workspaceId、pairId、deviceId、recipientPublicKey、随机 pairNonce、expiresAt。QR 只含公开数据。
2. 已解锁设备扫描新设备 QR，展示账号与设备，调用批准接口；它**直接使用 QR 中 recipient key**，不能用服务器替换后的 key。使用官方 `crypto_box_seal` 封装 `{workspaceId,pairId,pairNonce,recipientDeviceId,keyRing,newDeviceCredential}`；授权请求提交 grant ciphertext、SHA-256 hash、新 credential hash。
3. 已授权设备显示第二个 QR，含 pairId、workspaceId、recipientDeviceId 与完整 grant SHA-256；新设备扫描该 QR，核对自己下载到的 grant hash 后，才执行 `crypto_box_seal_open` 并验证包内所有身份/nonce，提交新 credential 激活。服务器消费 pairId 仅一次。
4. **sealed box 不认证发送者**；第二个通过可信设备屏幕获得的完整 hash 是冻结协议的一部分，不能删掉或改成服务器下发短码。UI 可显示短码帮助人识别，但不能只比较短码作为安全检查。[官方 sealed boxes](https://doc.libsodium.org/public-key_cryptography/sealed_boxes)

pairing 接口只允许当前账号本人及同空间 active device，active role不能由client JSON传入。超过挑战有效期、keyProtocol pending数量上限或账号切换即取消；未激活 grant不能成为正常下载凭据。网络重试不重新生成 grant，使用原 pairId/ciphertext。

### 5.3 无已授权设备时恢复

恢复凭证格式固定为 `CNREC1.` + random32-byte Base64URL（43 chars）；不从账号密码派生，不把恢复凭证发送服务器。不自行发明助记词/口令低熵恢复算法。用户在本机输入凭证，从已登录账号获取 recovery package，AEAD 验证后恢复 key ring。

为证明新设备持有恢复凭证而不把秘密交给服务器：恢复 secret 按第 4 节派生 Ed25519 seed，用官方 `crypto_sign_seed_keypair` 建立 signing key。服务器发单次 random32-byte challenge，签名消息冻结为：

```text
["CN:recovery-activate:1",workspaceId,recoveryVersion,challengeId,
 base64urlChallenge,newDeviceId,newDevicePublicKey,newCredentialHash,expiresAt]
```

客户端用 `crypto_sign_detached` 签名，服务器用已登记公钥 `crypto_sign_verify_detached` 验证，并在同一事务检查账号、challenge 未消费/未过期、所有字段匹配后消费 challenge、登记 credential hash、激活 pending device。客户端按封装恢复 key，完成本地持久化之后才能确认激活。恢复包不能由此次新设备登录会话任意替换。[官方签名 API](https://doc.libsodium.org/public-key_cryptography/public-key_signatures)

更换恢复凭证需要现有 unlocked active device、近期账号验证和明确用户操作，建立 recoveryVersion+1，新 random secret 包裹同一 key ring并更新公钥；服务端拒绝重用已消费 challenge。新凭证验证成功后再撤销旧恢复记录。若既无解锁设备也无恢复凭证，提供“保留加密数据/删除并新建空间”流程，不能假装能找回正文。所有上述组合协议仍受 T15 gate，不能以官方算法成熟度替代协议评审。

### 5.4 SQLCipher、本地 key vault 与退出

桌面和手机SQLCipher是正式首发目标：T07实现桌面加密仓储，T22配置手机SQLCipher原生构建，T23集成仓储/vault。SQLCipher的数据库静态加密与个人云E2EE是不同保护层；不能把SQLite沙箱称为加密，也不能把本地静态加密宣传为远程设备可擦除。[SQLCipher官方API](https://www.zetetic.net/sqlcipher/sqlcipher-api/)、[Expo SQLite/SQLCipher](https://docs.expo.dev/versions/latest/sdk/sqlite/)

每个本机profile/database生成独立CSPRNG random32-byte `localDBKey`及随机`localDbId`；匿名profile与各账号profile分开。它不从登录密码、auth token、device credential、workspace root、CNREC1恢复secret派生，也不加入云key ring/recovery package。T07可先用Windows BCryptGenRandom/macOS SecRandomCopyBytes，手机用官方Expo Crypto原生CSPRNG；不以T15云协议完成作为本机随机密钥生成前置，不使用Math.random或硬编码密码。

vault entry名`CN-LDB1.<profileId>.<localDbId>`，只存小型key与版本信息，不能将完整key ring大JSON塞SecureStore。key生成后先写vault并读回核验，再创建SQLCipher库/首次schema事务；SQLCipher库存在但vault key缺失时不得生成新key覆盖同一路径、重建空库或回退普通SQLite。返回`LOCAL_KEY_MISSING/LOCAL_KEY_UNAVAILABLE`，保留原库、WAL/SHM与附件作为待恢复证据。已有key却无法打开返回`LOCAL_DB_UNLOCK_FAILED`，先隔离/诊断，不能当作正常空库。

| 平台 | localDBKey的冻结保存方式与边界 |
| --- | --- |
| Windows | 用户范围DPAPI包+当前用户私有目录ACL；禁止CRYPTPROTECT_LOCAL_MACHINE。换机器/丢用户profile/凭据变化后的解包不能保证成功，DPAPI包不是可移植恢复凭证。[Microsoft DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata) |
| macOS | Keychain非同步本机条目，按profile/localDbId定位；不依赖账号登录或iCloud自动传递localDBKey；Keychain不可用时暂停库打开 |
| iOS | Expo SecureStore/Keychain，默认WHEN_UNLOCKED_THIS_DEVICE_ONLY，小型key值，requireAuthentication=false；锁屏不可读时等待前台解锁。生物识别作为后续显式选项不能成为本地资料唯一恢复副本 |
| Android | Expo SecureStore由Android Keystore保护；使用异步API，不把key放AsyncStorage。SecureStore备份排除规则必须配置并验收；卸载会丢失其key保护材料 |

localVault可用与cloud unlocked分别判断：无账号的local_only资料可由OS vault打开本机库，不能要求先登录/输入CNREC1；personal_cloud正文即使已有本机解密缓存也必须通过云解锁状态的backend读取边界，不能仅在React隐藏。账号退出默认结束该账号会话/云授权，不销毁匿名local-only库的localDBKey；只有用户明确“删除本机资料”才关闭DB、删除对应文件与vault条目。更换localDBKey、SQLCipher格式/参数升级须经备份与原子迁移gate，不能顺手rekey覆盖原库。

Web不使用SQLCipher或OS vault。匿名与Web local_only内容仅保存在有界会话内存（local.anonymousWebSessionBytes），刷新/关闭失去，保存前明确提示并提供用户选择的明文导出，不新增浏览器本地密码协议。首发不保存持久化云解锁能力，刷新/锁定后从批准设备或恢复凭证解锁；账号cookie可保留但不等于资料已解锁。IndexedDB只存云密文与加密drafts；明文索引在内存worker，锁定终止worker并释放引用。不能声称JS GC提供可验证安全擦除。

所有key禁止放`.env`、日志、analytics、崩溃正文、AsyncStorage、localStorage；SQLCipher设置key的语句/调用不得进入SQL trace。首发本地原件/正文/缩略图由SQLCipher受控BLOB对象表保存，不另存明文外置附件；worker按对象引用读取。云staging文件仅保存规定的云密文。只有验证SQLCipher原生库确实链接、wrong-key无法读、主库与WAL/临时文件无fixture明文之后，才可以启用已验证范围的静态加密文案。未来独立加密文件适配须另行冻结封装和迁移gate，不能自行退为明文。退出账户与撤销设备分别操作；撤销新API立即生效，旧signeddownload在TTL内可能有效，已下载内容无法撤回。

每次创建/打开库先验证SQLCipher `cipher_version`非空，设置key后再读schema；缺少加密native库返回SQLCIPHER_UNAVAILABLE且零写入，不以普通SQLite忽略未知PRAGMA后继续。T22使用expo-sqlite的useSQLCipher原生配置并重建development build，Expo Go不能提供该验收。云locked/localVault unavailable的错误要区分，不通过登录刷新解决本机key缺失。

### 5.5 丢钥、卸载与备份恢复gate

CNREC1只恢复个人云key ring，不能解锁丢localDBKey的旧本机数据库。账号或本机vault丢失时，可重新建profile并经批准/恢复凭证拉回**已经云提交成功**的内容；未开启同步的历史/收藏、未提交outbox/draft不会因此回来。匿名local-only要跨机器恢复必须预先完成T29可移植导出；仅复制SQLCipher文件或DPAPI/Keystore包不构成可移植备份。

T29首发可移植路径为用户明确选择的资料导出（明文有可见提醒），导入时生成新localDBKey并写新SQLCipher库。以后若增加加密导出包，须先冻结成熟库封装、备份密钥交付与互操作gate；低模型不得临时把localDBKey写进导出zip、当作CNREC1替代品或声称普通OS备份可恢复。原库完整备份要使用数据库支持的一致性backup/export或先关闭并处理WAL，不可只拷贝仍在写入的主文件；恢复以独立目录/profile演练，验证成功前不覆盖原库。

| 情况 | 必须行为 |
| --- | --- |
| OS vault暂时不可用/屏幕锁定 | 暂停打开或恢复新请求，显示等待解锁；不认为数据丢失，不删库 |
| 原SQLCipher库存在但key失效/缺失 | 保留全部证据，提示恢复vault/可移植导出；需要新库时另建localDbId/目录，不能盖掉旧库 |
| Android卸载或OS自动备份恢复 | SecureStore不能被当作恢复依据；配置排除SecureStore及未具备可移植恢复链路的敏感库/文件，真实备份恢复测试不得假报恢复local-only资料 |
| iOS重装相同bundle ID | Keychain可能保留但不保证；不能承诺卸载已经擦除所有key，也不能将留存旧credential用于绕过账号登录/新设备授权 |
| 只有CNREC1/批准设备，无localDBKey | 在新库恢复已cloud committed数据；明确local-only/pending队列不可由云恢复 |
| 只有匿名local-only，无key/无可移植导出 | 明确无法解密原库；提供保留证据和新库入口，不能“密码重置”伪恢复 |
| 同机原库备份+可用vault / T29可移植导出 | 在隔离profile验证schema、记录、附件、outbox范围；导入资料不自动开启上传或继承已撤销devicecredential |

Expo官方说明Android卸载丢SecureStore，iOS重装留存Keychain不能作为保证，生物识别变更可使requireAuthentication保护条目失效；T22/T23必须真实设备验收这些差异。[SecureStore官方文档](https://docs.expo.dev/versions/latest/sdk/securestore/)

## 6. 客户端事务与同步 outbox（T17/T20/T24）

本地每条记录包含 `scope,accountId,workspaceId,localDraftId,confirmedRevision,localRevision,syncState,lastError`。anonymous、本账号cloud、其他账号缓存物理 namespace隔离；切换账号不能复用前一个账号的 outbox或key。

outbox 最小列：`op_id PK,workspace_id,device_id,entity_id,epoch,base_revision,wire_bytes,wire_sha256,wire_size,dependency_op_id,state,attempt_count,next_attempt_at,last_error,created_at`。状态只有 `WAIT_DEPENDENCY/READY/SENDING/ACKED/CONFLICT/BLOCKED`；崩溃后SENDING→READY，wire_bytes保持原样。ACKED仅在本地事务已记录服务端receipt、confirmed revision/seq后清除；附件未上传的草稿先WAIT_DEPENDENCY，不伪造ready附件引用。

```text
prepare mutation outside DB transaction:
  validate privacy/scope/content limits; prepare encryption/new UUIDs
  prepare owned plaintext body/original/thumb bytes for SQLCipher BLOB insertion
  prepare immutable cloud ciphertext bytes when cloud scope is unlocked
  calculate exact additional durable bytes (wire + newly-owned pending blob bytes)
local SQLite BEGIN IMMEDIATE / Dexie transaction:
  verify current scope/account + current local revision
  reject if protected saved/local budget full
  reject if personal_cloud pendingBytes + addedBytes > outboxHardLimitBytes
  write SQLCipher objects/object_refs, draft/materialized view and outbox together
  update local ownership/refcounts and pendingBytes counter in the same transaction
COMMIT
emit UI success only after COMMIT
```

待同步bytes包括大正文、原图待上传副本，不能只算小JSON绕过outbox硬限；已经cloudready且可重新下载的共享blob不重复算待上传bytes。pending draft进outbox前已经占本地totalBytes，两套预算独立检查。超过softWarn时显示待处理原因；达到hardLimit阻止**新的云范围mutation**，保留所有已提交操作、允许其重试/删除/导出/恢复同步。本地-only采集可继续但受本地总预算限制；不能悄悄把同步收藏编辑改为local_only、丢操作或覆盖旧草稿。UI显示scope、待处理字节、失败原因与用户可执行的清理/导出操作。

同一entity只允许一个已经发出的wire op。后续离线编辑保存为持久化draft链，等待前一op确认后用真实revision建立新wire op。wire一旦可能送达服务器就不可修改（包括nonce/baseRevision/opId）。对从未发送的draft可合并，不能合并已发送op；冲突时保留draft，执行第7节冲突处理。

桌面/手机的本地正文、原件和缩略图统一SQLCipher BLOB对象表：对象、引用、记录与outbox同一数据库事务提交；失败回滚不留下已确认但缺对象的记录。Web云密文对象/加密draft与outbox同一Dexie多表事务提交；匿名local-only只会话内存。prepare阶段的编码/密码计算在事务外完成。

云传输的密文staging文件只是可重建缓存：从已提交SQLCipher/Dexie字节生成，temp→fsync→atomic rename后可供传输；文件丢失从同库对象重建，不能成为正文/outbox唯一权威副本。未提交temp/无引用缓存由启动GC删除，pending源BLOB不得被本机淘汰。独立明文附件文件禁止落盘。Dexie事务内禁止await fetch/crypto/filesystem等外部工作，准备好字节后再进事务；多表必须同一个Dexie transaction。[Dexie transaction](https://dexie.org/docs/Dexie/Dexie.transaction())、[SQLite transaction](https://www.sqlite.org/lang_transaction.html)

客户端重试：网络/5xx/429/TIMEOUT带随机jitter、指数退避，最大syncRetryMaxSeconds；以Retry-After为下界。401先恢复登录、DEVICE_REVOKED停止云、KEY_LOCKED等待解锁、QUOTA_EXCEEDED等待释放/权益变化；不能无限立即重试。Web后台不保证持续运行，手机后台不保证全局采集；进前台恢复持久化outbox即可，不靠“持续后台在线”保证正确性。

## 7. Revision CAS、seq、epoch与增量恢复（T16/T17/T19）

### 7.1 push DTO

```ts
interface PushRequestV1 {
  protocol: 1; workspaceId: Uuid; deviceId: Uuid;
  epoch: Decimal; seenSeq: Decimal;
  operations: Array<{
    opId: Uuid; action: 'create'|'update'|'delete';
    entityId: Uuid; entityKind: EntityKind; baseRevision: Decimal;
    manifest?: EncryptedManifestV1; // delete 没有 manifest
  }>;
}
interface OpResultV1 {
  opId: Uuid; status: 'committed'|'rejected';
  revision?: Decimal; seq?: Decimal;
  error?: ApiErrorV1;
}
interface PushResponseV1 {
  protocol: 1; epoch: Decimal; highWaterSeq: Decimal;
  results: OpResultV1[]; // 与请求顺序一致；每个op独立事务
}
```

request含字段数与精确UTF-8bytes双限制：syncBatchOperations/syncBatchBytes。JSON超限请求413、零写入。每个operation独立提交；batch不是跨entity原子操作，不能在UI承诺批量全成功。单operation必须可放入batch，小manifest+bodyattachmentrefs用于大正文。partial成功以每项receipt确认，不重新生成整个batch中的成功op。

```text
push one op:
  verify trusted session, credential, personal workspace, entitlement
  canonicalRequestHash = SHA256(contracts canonical op bytes incl epoch + action/base/header)
  BEGIN + transaction-local RLS scope
  lock workspace row FOR UPDATE
  if epoch != current.epoch: EPOCH_MISMATCH (no new write)
  if matching receipt exists: require request hash equal; return saved result
  if same opId different hash: IDEMPOTENCY_MISMATCH
  require sync_state=active AND lease active AND minRetainedSeq <= seenSeq <= lastSeq
  lock usage_ledger FOR UPDATE
  lock entity (if exists) FOR UPDATE
  create: baseRevision=0, ID never existed; otherwise ENTITY_EXISTS/ITEM_DELETED
  update/delete: entity exists + not deleted + revision==baseRevision
  update history body: IMMUTABLE_HISTORY
  validate manifest revision==baseRevision+1, all workspace/FK/kid/purpose refs
  lock referenced attachments in ascending UUID order; require ready
  validate cloud entitlement/byte/object budget for positive usage delta
  newRevision = baseRevision+1; newSeq = workspace.lastSeq+1
  write immutable version/current projection OR delete tombstone
  write attachment refs, usage event, change_log, receipt, business_outbox
  update workspace.lastSeq = newSeq
  COMMIT; only then return committed
```

全局锁顺序固定：workspace → ledger → entity按UUID → upload/attachment按UUID。删除/GC/finalize/restore也遵守；禁止某接口先锁upload再锁workspace。网络、S3、支付调用在PG行锁之外。workspace序列在同一事务锁内分配，禁止用nextval代替它：nextval顺序不保证提交顺序，可能让游标跳过晚提交的低seq。

CAS失败返回终止性409 `{code:'REVISION_CONFLICT',currentRevision,currentHeadVersionId,currentSeq}`并保存receipt，不替用户覆盖远端。客户端先拉新head，原本机draft保留；建立新的saved“冲突副本”，新UUID+新封装，密文内标注conflictOf原entity，用户可以合并。collection/关系冲突显示待确认操作，不把每个pin冲突伪装成正文副本。远端已删除返回ITEM_DELETED，用户明确“另存”才能新建；旧delete在远端编辑后CAS失败，需要用户重新确认删除，不能自动升级到新revision继续删。

首次create、update与receipt在一个事务成功，响应丢失时同opId精确重试返回原seq，不产生第二版本。receipt保留窗口至少覆盖有效设备租约（配置gate见第11节）；离线超过租约/receipt窗口先快照，旧outbox不能自动重放。核对entity/version/op状态后将未确认内容保持draft，必要时新ID显式另存；不能因为receipt不存在就认定原操作未成功。

### 7.2 pull DTO 与游标

```ts
interface PullRequestV1 {
  workspaceId: Uuid; epoch: Decimal; afterSeq: Decimal;
  upperSeq?: Decimal; // 首页服务器冻结，后续必须复用
}
interface ChangeV1 {
  seq: Decimal; entityId: Uuid; entityKind: EntityKind;
  revision: Decimal; action: 'upsert'|'delete';
  manifest?: EncryptedManifestV1;
}
interface PullResponseV1 {
  epoch: Decimal; fromSeq: Decimal; toSeq: Decimal; upperSeq: Decimal;
  changes: ChangeV1[]; hasMore: boolean;
}
```

每次pull在一个短`REPEATABLE READ READ ONLY`事务读取workspace与对应不可变版本。首个upperSeq=事务看到的lastSeq；后续`seq>afterSeq AND seq<=upperSeq ORDER BY seq` keyset读取，按summaryPageItems与精确responsebytes≤summaryPageBytes截断。toSeq是实际最后一条输出seq；未输出的change绝不能被toSeq跳过。只有查询确认没有剩余条目时才能toSeq=upperSeq。返回的单change包含小manifest，不能内联2MiB正文。[PG isolation](https://www.postgresql.org/docs/current/transaction-iso.html)

客户端在单本地事务应用整页、更新本机cursor，再请求下一页；进程崩溃重拉同页按entity/revision/seq幂等。正常历史日志可能包含低于本机已确认revision的旧change（例如本机push刚成功而pull游标尚早）；它们推进已处理seq但不覆盖新head，不能误报rollback。同versionId却不同ciphertext或当前服务端整体highWater低于本请求发出前冻结的已见高水位时报协议/rollback异常。复用的合法旧H快照可以比本机已确认revision旧，不能在基线阶段报rollback；保留priorSeenHighWater和已确认版本标记，先catchup到至少该高水位后再检查已有实体版本倒退。不存在实体可能是合法删除，不能把缺失本身当作可证明的恶意服务器回滚。`applied_seq` ACK只来自已提交本机事务的游标，不能来自收到HTTP响应的时间。

水位比较要考虑网络乱序：每个请求固定发送前已见水位，旧的在途响应/显式旧upperSeq分页可以低于**响应到达时**最新本机水位，不能误报rollback；本机最高已见值始终取max，不回退。若一个新发起的当前状态探测仍低于该请求发出前已知水位，才隔离并报REMOTE_ROLLBACK_DETECTED。测试覆盖push/pull响应乱序以及成功seq100响应先于seq99旧响应到达。

日志GC推进min_retained_seq（定义为已删除日志前缀的最后seq）。安全GC前缀上界=`min(所有有效active lease的appliedSeq, 所有未过期ready snapshot的highWaterSeq)`；空集合视为lastSeq。**快照不仅pin附件，也pin全部seq>H的catchup日志与相应版本**，直到snapshot过期；不能仅按老设备ACK把日志删到H之上。过期设备退出阻止GC的集合。`afterSeq < min_retained_seq`返回CURSOR_EXPIRED。epoch只在灾难恢复/空间重建/不兼容协议重置时增加，不因每日GC增加。lease过期设备sync_state=snapshot_required，不能只改seenSeq数字绕过恢复。授权仍有效时可以下载snapshot，完成所有页和catchup后提交带snapshotId的bootstrap ACK，服务器验证snapshot归属/epoch/H、ACK不低于H，再将sync_state转active并建立新lease。普通ACK不能激活snapshot_required设备。新设备按同一路径。

### 7.3 固定一致快照

```text
POST snapshot request -> jobId/snapshotId building
pg-boss job, dedicated bounded READ COMMITTED transaction:
  set transaction-local scope; lock workspace FOR UPDATE first
  read epoch,lastSeq H after acquiring lock
  INSERT snapshot_rows SELECT live entity + exact current immutable manifest DTO
  INSERT snapshot_attachment_refs from selected current version refs
  persist epoch,H,rowCount; status=ready
  COMMIT (not an open transaction stored in memory)
GET snapshot page -> keyset entityId, fixed snapshotId/epoch/H
client writes into fresh recovery namespace; validate all pages, do not swap yet
retain unsent drafts separately; never overwrite drafts with snapshot
pull after H -> apply catchup into recovery namespace until >= priorSeenHighWater
validate recovery; atomic namespace swap + published cursor; then bootstrap ACK
```

所有实体写入、版本GC、附件GC都先取同一workspace锁，因此上面的物化事务在锁内有固定状态；rows与pins同事务提交，避免旧head在pin提交前被回收。使用READ COMMITTED是在取锁后读取H，避免RR在等锁前已经取得过旧MVCC snapshot。该锁只存在于有界物化事务，不跨分页请求；没有S3或其他网络调用。若实测行数上限内仍无法满足snapshotStatementTimeoutMs，停止该空间新云写入/优化物化，不让低能力模型改成无锁实时分页。

物化事务必须在独立配置的timeout与行数上限内完成；先count并拒绝超过snapshotMaxRows的空间（产品写入上限与其一致），不能无界`SELECT`到JS内存；失败不发布半快照。分页会话不持DB锁/连接。ready之前不允许下载；snapshot过期/epoch变化返回SNAPSHOT_EXPIRED/EPOCH_MISMATCH，重新开始。snapshot的有效引用参与附件GC；分页读取不能掉到实时head，否则会丢并发编辑/删除。

顺序：完整物化快照H → 新recovery namespace逐页事务写入 → pull(H,固定upper)并catchup至不低于priorSeenHighWater → 本地原子切换与游标发布 → ACK。priorSeenHighWater来自本机此前已确认的同epoch水位；新设备为0。此前UI继续使用原namespace，可继续保存受预算保护的draft；不能先覆盖成本机更旧资料再做catchup。进程中断可恢复recovery namespace进度，过期时只丢该未发布基线，不丢outbox。recovery namespace也计local预算，空间不足返回LOCAL_BUDGET_FULL，不能突破容量或静默淘汰收藏/待同步文件。快照创建期间的新提交seq>H，必在catchup出现。新设备不能“当前表OFFSET分页+最后读maxseq”拼出假一致快照。

## 8. 云附件、上传配额与GC（T18/T19）

### 8.1 reserve / finalize / download DTO

```ts
interface ReserveUploadV1 {
  reserveOpId: Uuid; attachmentId: Uuid; purpose: BlobPurpose;
  kid: Uuid; keyVersion: Decimal; nonce: Base64Url;
  cipherBytes: Decimal; cipherSha256: Base64Url;
}
interface UploadLeaseV1 {
  uploadId: Uuid; attachmentId: Uuid; url: string;
  requiredHeaders: Record<string,string>; expiresAt: string;
  reservationExpiresAt: string;
}
interface FinalizeUploadV1 { uploadId: Uuid; }
interface ReadyAttachmentV1 {
  attachmentId: Uuid; purpose: BlobPurpose;
  cipherBytes: Decimal; cipherSha256: Base64Url; state:'ready';
}
interface DownloadLeaseV1 {
  attachmentId: Uuid; url: string; expiresAt: string;
  cipherBytes: Decimal; cipherSha256: Base64Url;
}
```

上传首期只支持一个有界PUT对象，maxImageBytes足够，不提供无限multipart/file API。允许blob的cipherBytes上限为对应明文上限+AEAD固定16-byte tag；image_thumb仍不得突破maxImageBytes，客户端另外约束512边长。支持分片属于未来协议变更，不能悄悄引入未计账multipart。

对象存储选型gate：私有桶；staging PUT强制经签名的`If-None-Match:*`，且bucket policy拒绝没有条件头的客户端staging写入；可以返回不可变staging VersionId或等价不可变upload完成对象；有真实大小/checksum核验；最终路径只允许服务器写；支持条件写/版本拷贝及删除确认。条件头不能被客户移除、换值或绕过，否则一个旧URL可PUT N次制造N份计费版本，单reservation不再是硬预算。若兼容S3服务缺任一项，T18停止该provider上线，不能拿“兼容S3”当完整语义承诺。[S3预签名链接](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)、[S3条件写](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)

### 8.2 状态机与账本

`reserved → staged → copying → ready → cleanup_pending → cleaned`；异常可进入`expired/failed`，最终仍需cleanup。ready表示final附件可被引用，暂存清理可以仍pending。upload state不是唯一物理占用依据：保留对象/复制状态/versionId及各计账phase。

| 场景 | logical/reserved/staging/pending_final 处理 |
| --- | --- |
| reserve | 原子增加reserved=expectedbytes与reservedObjectCount；检查logical+reserved≤有效cloudBytes，暂存独立预算与pending uploads个数；仅创建授权上传路径 |
| PUT完成/被观察 | 将实际staging大小记账；reserved仍保留直到ready或失效；未观察的授权写入也必须以reservation涵盖临时最大占用 |
| 开始copy | 原子锁状态copying；为final candidate记pending_final预计bytes，提交后才调用S3；staging+candidate“双份”物理占用纳入暂存预算 |
| ready | 核验final真实bytes/hash/version后事务创建attachment；logical+=final实际bytes，reserved-=expected，pending_final转为logical；staging保留直到删完；同对象重复finalize零delta |
| reserve过期 | 只关闭finalize/新签名；未确认删除的staging/candidate继续计占用，不能直接把所有计数减零 |
| ready无任何引用 | 仍计logical；等待固定GC规则，不能将免费孤立blob无限堆积 |
| delete确认 | 对对应物理对象/版本确认删除后才减staging/pending_final/logical；补偿event唯一键使重复worker零delta |

暂存硬预算独立于logical余额，初始可以采用“当前workspace有效cloudBytes”作为staging预算（不是给用户额外长期容量）；copy瞬时双份必须预约，不能借临时空间无限上传。业务权益由server取可信entitlement，客户端提交cloudBytes/planName无效。旧版本、回收站、未引用ready附件继续计云占用；logical bytes也包括DB保存的密文manifest，并由唯一usage event防重复计费。

对象数硬预算检查`live_object_count+staging_object_count+pending_final_object_count+reserved_object_count <= maxStoredObjectsPerWorkspace`。reserve预留两个物理对象名额（staging与final candidate）；观察staging后一个reserved转staging，观察candidate后另一个reserved转pending_final，ready时pending_final转live，清理暂存确认后减staging。重试不新增名额；未知copy结果保留该reserved/pending名额。DB创建每个immutable manifest版本也占一个live名额，合法GC后才释放；retired ID另受ID预算控制。这样finalize不会在对象数刚满时偷偷创建第二份物理对象。

reserve锁workspace→ledger，再插upload，提交后生成短期URL。签名携带所选provider实际支持的长度/checksum和不可移除`If-None-Match:*`等要求，expectedbytes≤容量、url有效期uploadUrlSeconds；首次有效PUT后重复PUT返回条件失败，不生成新的计费版本。staging对象在signed_until前不可删除（删掉会让旧URL再次通过If-None-Match重建）。所有密文hash是ciphertext hash，不是明文hash。hash不用于跨用户去重或公有查询。

```text
finalize(uploadId):
  A. authenticate + short txn lock workspace -> ledger -> upload
     require same owner/device, not expired; if ready return same attachment
     if another finalizer owns copying return UPLOAD_IN_PROGRESS
     reserve copy candidate bytes and unique final key; persist copying; COMMIT
  B. OUTSIDE PG locks:
     HEAD completed staging version; verify actual size/checksum == frozen request
     COPY exact immutable staging VersionId to unique private final candidate
     client has never received PUT URL for final key; verify final size/hash/version
  C. short txn lock workspace -> ledger -> upload:
     verify same copying candidate and workspace still writable
     create immutable ready attachment; atomic usage event; enqueue staging cleanup
     COMMIT; only now return ready
```

网络失败/crash不能把copy结果当不存在：candidate key预先写入uploads，worker HEAD该key重试/补偿。copy成功但C未提交时pending_final计账保留；不能不记孤儿。staging强制单次创建语义，finalize另外读取已冻结的不可变VersionId，或真正等价的受验证immutable source；不许仅HEAD再COPY同可变key。copy重试必须复用同candidate且条件写，不反复生成新final版本；已有candidate核验正确则直接继续C。finalkey从不下发客户端PUT，旧URL不能改已引用最终对象。

服务端使用所选SDK真实支持的CopyObject destination `If-None-Match:*`，不是仅source条件。读取整个copy响应并再次HEAD核验，不能把HTTP 200直接当完成（S3 copy可能在200响应中携带错误）。所选provider/SDK必须通过此gate。[CopyObject官方API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html)

ready不是“已提交某个正文引用”：上传与entity mutation分开；只有push同事务建立version_attachments后才有业务引用。两步中间crash是受预算约束的孤立ready附件，GC之后客户端收到ATTACHMENT_NOT_READY需重新reserve新attachmentId。reserveOpId重复同body返回同upload，字段不同返回IDEMPOTENCY_MISMATCH；过期的同reserveOpId不能自动创建新url，客户端明确生成新ID。

### 8.3 回收

统一引用集合=当前版本+仍被有效change_log引用的版本+保留旧版本+回收站+有效snapshot pins。当前head无论created_at多老都不能被版本TTL回收。删除时将最后head转为trash_head_version_id，trash_expires_at=deleted_at+trashDays；即使该版本早于versionHistoryDays，仍保留到回收站到期。只有所有引用/保留条件都解除才删version并减少对应manifest字节。收藏引用的同blob不会随history到期释放。清收藏夹先移除关系，不能隐式删除saved目标；关系/目标任一deleted时客户端不显示关系，repin创建新关系ID。

GC先事务锁workspace→ledger→attachment，确认零引用，状态ready→deleting并写业务outbox；新引用deleting对象返回ATTACHMENT_NOT_READY，禁止复活原blob。S3删除所有需要删除的版本/暂存对象在锁外；确认后事务减占用、state=deleted。只收到delete marker不等于版本对象已消失，provider测试必须包含VersionId删除。上传URL到期之前不做最终释放；到期后再次HEAD/删除确认，防旧URL重新创建staging。使用S3生命周期兜底但不替代账本对账。[S3未完成上传计费](https://docs.aws.amazon.com/AmazonS3/latest/userguide/abort-mpu.html)

定期pg-boss对账实际对象版本、uploads、attachments、ledger；发现未登记对象只进入受限隔离清理列表，不返回给客户、不立即释放已计用量。server不可依据cipher hash从其他空间找blob。失败/退款/配额下降只阻止正delta上传，允许删除/拉取/导出；不静默删除个人本地资料。

## 9. HTTP 接口与错误冻结

所有JSON `protocol:1`。账号session鉴权由T14适配；设备相关操作另验证独立device credential（Header只传credential，不能靠deviceId自证授权）；敏感headers不记access log。路径wid必须与body wid相同；未知字段拒绝，避免低模型“兼容”放宽安全参数。

| Endpoint | 行为 |
| --- | --- |
| `POST /v1/workspaces/personal` | 幂等取/建本人个人workspace；不会自动启用云 |
| `POST /v1/workspaces/:wid/initialize` | 第5.1节唯一初始key/恢复/设备提交；仅未初始化状态可执行 |
| `POST /v1/workspaces/:wid/devices/pending` | 登录会话创建pending公钥与device；无正常资料下载权限 |
| `POST /v1/workspaces/:wid/pairs`、`/:pairId/approve`、`/:pairId/consume` | 双QR封装/哈希核验/单次消费；approve必须active device |
| `GET /v1/workspaces/:wid/recovery-package` | 账号登录读取密文恢复包；不返回secret；速率限制 |
| `POST /v1/workspaces/:wid/recovery-challenges`、`/:id/activate` | 冻结签名challenge与原子消费；不是密码重置捷径 |
| `POST /v1/workspaces/:wid/sync/push` | 第7节batch；受exactbytes与op数约束 |
| `GET /v1/workspaces/:wid/sync/pull` | 第7节epoch/after/upper游标；响应受摘要预算 |
| `POST /v1/workspaces/:wid/sync/ack` | `{epoch,appliedSeq,snapshotId?}`；同epoch单调，不超过serverlastSeq；snapshot_required必须验证bootstrap snapshot后才能转active/续devicelease |
| `GET /v1/workspaces/:wid/operations/:opId` | 当前authorized device查receipt；无receipt返回OPERATION_UNKNOWN，不能等同未成功 |
| `POST /v1/workspaces/:wid/snapshots`、`/:id/pages` | 物化snapshot status/page；分页keyset，不读取实时head |
| `POST /v1/workspaces/:wid/uploads/reserve`、`/:id/finalize` | 第8节；signedurl只给staging |
| `POST /v1/workspaces/:wid/attachments/:id/download-lease` | ready状态+空间鉴权，GET签名有效downloadUrlSeconds；返回cipher大小/hash |
| `GET /v1/workspaces/:wid/usage` | logical/reserved/staging/pendingFinal/对象数与可信权益，bytes都是Decimal |
| `POST /v1/workspaces/:wid/devices/:id/revoke` | 本人近期账号验证；停止API/grant，清currentdevice本地按用户选择；不宣称远程擦除 |
| `POST /v1/workspaces/:wid/restore` | T29：客户端新ID重新加密恢复，走常规create；不是复制旧ciphertext改ID |

```ts
interface ApiErrorV1 {
  code: string; requestId: Uuid; retryable: boolean;
  details?: {
    currentRevision?: Decimal; currentHeadVersionId?: Uuid; currentSeq?: Decimal;
    expectedEpoch?: Decimal; minRetainedSeq?: Decimal;
    limitKey?: string; limitBytes?: Decimal; requiredBytes?: Decimal;
  };
}
```

| HTTP/code | 客户端确定性动作 |
| --- | --- |
| 400 INVALID_DTO / INVALID_ENVELOPE / INVALID_DECIMAL | 停止该op，保留draft，上报协议错误；不得改数字重试 |
| 401 AUTH_REQUIRED | 更新登录会话，保留outbox |
| 403 DEVICE_PENDING / DEVICE_REVOKED / FEATURE_NOT_ENABLED | 不发正常sync/下载；pending走解锁，revoked停云 |
| 404 RESOURCE_NOT_FOUND | 不泄露其他workspace存在性；确认scope再处理 |
| 409 REVISION_CONFLICT / ITEM_DELETED / ENTITY_EXISTS / COLLECTION_ENTRY_EXISTS | 拉head并保留draft，按第7节冲突处理；重复关系由用户/领域层确认已有关系 |
| 409 IDEMPOTENCY_MISMATCH | 停止op，协议bug；绝不能自动换opId继续同请求 |
| 409 EPOCH_MISMATCH / CURSOR_EXPIRED / DEVICE_LEASE_EXPIRED | 快照恢复；保留draft并先核对旧outbox，不直接重放 |
| 409 ATTACHMENT_NOT_READY / UPLOAD_IN_PROGRESS | 前者核对/重上传新ID；后者退避查询同upload |
| 410 UPLOAD_EXPIRED / SNAPSHOT_EXPIRED / CHALLENGE_EXPIRED | 显式新lease/snapshot/challenge；不改原已发送op |
| 413 REQUEST_TOO_LARGE / CONTENT_TOO_LARGE | 显示limitKey；不得拆无限附件绕过正文限额 |
| 422 CIPHER_INTEGRITY_FAILED | 客户端解密/hash失败：隔离副本、停止使用，不自动贴入剪贴板 |
| 429 RATE_LIMITED | Retry-After+退避；不丢outbox |
| 507 QUOTA_EXCEEDED / TEMP_STORAGE_FULL / OBJECT_LIMIT_EXCEEDED | 阻止新正delta，允许删除/导出/读取，解释账本占用 |
| 503 STORAGE_UNAVAILABLE / DB_BUSY | 原opId与字节重试；server不得假报committed |
| local OUTBOX_FULL / LOCAL_BUDGET_FULL / KEY_LOCKED | 保留已提交资料，阻止对应scope新mutation/等待解锁 |
| local LOCAL_KEY_MISSING / LOCAL_KEY_UNAVAILABLE / LOCAL_DB_UNLOCK_FAILED / SQLCIPHER_UNAVAILABLE | 依第5.4/5.5节保留原库/队列，隔离解锁或native配置失败；禁止空库覆盖或普通SQLite fallback |

DELETE重复同op receipt返回原成功；用户提出第二次delete不是同一个op时，deleted实体返回ITEM_DELETED。只有网络/临时存储/限流错误retryable=true；CAS/DTO/revoked是false。

## 10. 测试 fixture 与分阶段验收（T16—T31）

Fixture固定两账号A/B、个人空间WA/WB、同账号设备D1/D2，已知随机种子只用于测试vectors。实际runtime禁止固定随机种子。测试使用真实临时PostgreSQL与所选S3provider等价语义沙箱，至少一轮真实对象版本/旧URL测试；mock不能证明provider不可变语义。

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| S01 | A的session+WA credential访问WB/附件；替换bodywid | API404，RLS读0行/写0行，无签名URL；连接池下一请求scope不串 |
| S02 | 表owner、业务role、worker权限差异 | 业务/worker非owner NOBYPASSRLS；缺scope访问0行，未授权insert被WITH CHECK拒绝 |
| S03 | op成功commit后人为断HTTP响应，原字节重试 | 一个version/change/usageevent，seq相同；重复op不同hash报IDEMPOTENCY_MISMATCH |
| S04 | D1/D2同baseRevision并发编辑saved | 恰一成功、一409；两端draft不丢；冲突另存新ID，不能服务器改AAD拷贝cipher |
| S05 | 离线update遇远端delete，旧delete遇远端update | ITEM_DELETED/REVISION_CONFLICT；不复活旧ID、不自动删新revision |
| S06 | pin关系与saved正文并行修改，unpin后repin | 各自revision独立，互不冲突；repin新ID不会撞活跃关系UNIQUE；history正文update被拒绝 |
| S07 | 两事务分配seq，第一事务故意延迟/回滚 | seq按workspace提交顺序；无nextval导致漏读；pull不能跳未输出条目 |
| S08 | pull返回超50条/128KiB，网络中断重拉同页 | 双限制有效，toSeq只到输出末尾；本地cursor与内容同事务，无重复/缺口 |
| S09 | 创建snapshot同时更新、删除、添加内容，分页期间老设备ACK新seq并触发日志GC | 每页同H；snapshot pin附件及seq>H日志/版本；minRetainedSeq不得越过H；catchup无CURSOR_EXPIRED，无实时OFFSET拼接 |
| S10 | cursor截断/lease90天过期/epoch提升后旧outbox，本机已确认新版本但复用旧H快照 | 恢复namespace先catchup到priorSeenHighWater再切换，不误报rollback；旧op不自动重放，草稿留存，退休ID不能复活 |
| S11 | SQLCipher对象/引用/记录/outbox事务各点crash；云密文staging生成/rename前后crash或丢文件 | commit前整体回滚、后整体可读；无“成功UI但无outbox/对象”；staging可从同库字节重建，孤立缓存能GC且pending源BLOB保留 |
| S12 | outboxsoft/hard和localtotal恰好边界，巨大原图draft | pendingblob计入outbox；hard阻云mutation但不丢队列，本地only受独立预算；收藏不静默转换scope |
| S13 | 两并发reserve各自可用但合计超quota | 一个成功一个507，ledger非负；重复reserve同body零delta，不同body409 |
| S14 | 上传未完成/超尺寸/错checksum/过期finalize | final不可用；实际staging仍占用直到确认删除；不能expiry直接归零 |
| S15 | 同URL同size/hash重复PUT N次，尝试移除条件头、在finalize前后覆盖/删除后重建staging | 首次最多生成一个物理staging版本，其余412/签名失败；signed_until前不清staging；最终已引用对象不变，旧URL无final写权限 |
| S16 | copy完成后、DBfinalize前crash，两个并发finalizer | pendingcandidate可定位并计费；只有一个readyattachment，usageevent一次；网络期间PG锁已释放 |
| S17 | GC与新引用并发；S3只返回delete marker/删除失败 | 只有ready允许新增引用；deleting不得复活；未物理删版本不得释放字节 |
| S18 | history到期但saved/旧版本/trash/snapshot引用同blob，删除100天老head | blob保留计费；老head仍保留trashDays；清历史不删除saved，集合删除不删除目标saved |
| S19 | Rust/Web/iOS/Android同向交叉crypto vectors | key/nonce/AAD/ciphertext一致；每个身份字段、kid、ref、nonce、tag篡改均失败；2MiBtext外置blob路径成功 |
| S20 | 恶意relay替换pair publickey/grant，重放第二QR/consume | QR key/hash不匹配拒绝；sealedbox不能单独代表trusted sender；grant单次消费、devicecredential与数据key分离 |
| S21 | 恢复key错误、账号重置、新challenge重放、recoveryVersion旧包 | 本机无法解密错误包；账号重置不能覆盖恢复key；challenge绑定设备/一次性/expiry，旧凭证撤销行为明确 |
| S22 | revoke后API/旧signeddownload/已解密内容 | 新API拒绝；旧链接最多配置TTL仍可能有效，不能承诺擦除已下载内容 |
| S23 | Web lock/刷新/账号切换；IndexedDB与崩溃日志检索 | 无plaintext/key持久化泄漏；indexworker终止；另一账号不接管outbox；未索引全量不宣称全库搜索 |
| S24 | 退款/云额度下降/对象存储失败 | 只冻结正delta上传，读取/删除/导出可用；客户端伪造权益无效，无静默删本地收藏 |
| S25 | PG备份+对象恢复与已删除内容恢复风险 | epoch提高，旧设备重新快照；删除栅栏/删除外部水位不回退，必要时恢复后重新应用删除；账本与物理对象对账 |
| S26 | numeric超过2^53、maxbigint、批量partial成功 | 全端Decimal无精度丢失，超界拒绝；partial结果逐op确认、成功项不生成第二op |
| S27（本地gate） | 匿名库/vault故障、wrong-key、SQLCipher未链接、creation crash、卸载/系统备份/T29恢复 | localDBKey独立；库/WAL无canary明文；原库不能被新key/空库覆盖；CNREC1仅恢复已cloudcommitted；匿名local-only/pending丢key无导出则不可恢复；iOS/Android真机边界与导入零自动上传 |

阶段归属：G2是M2内部工程gate，必须完成S01—S23、S26的桌面/Web与独立Hermes密码向量，以及S24配额下降/存储失败子场景、S25由T19负责的合成隔离恢复核心断言。T25在M3复跑这些跨端场景并完成S27桌面/真机本地部分；S24真实退款/provider权益在T26—T28关闭，S25生产等价运营恢复与S27可移植导入/导出在T29/T30关闭，由T31汇总G4。T25不能因后续付费/运营尚未实施而伪报完整S01—S27通过；这些子场景记DEFERRED_TO_Txx。G2/G3单独通过仅允许隔离测试，公开云服务还需T29/T30的数据管理与恢复证据。

S25 需要明确运营恢复runbook：PG备份和对象备份不是自动一致；云发布前证明恢复水位、删除保留与计账。不把“备份存在”视为“已验证可恢复”。恢复流程先隔离空间的正常写/下载、对账PG与对象版本、核对覆盖恢复点之后的持久化删除证据，再提高epoch开放客户端bootstrap。无法证明删除证据完整时保留隔离并报告，不能直接开放可能复活删除内容的旧备份。此门槛不得被“备份有30天保留”替代。

epoch变化时客户端保存旧namespace中的未同步draft，并为恢复后缺失的此前confirmed内容保留受local预算约束的只读恢复副本；不能自动上传这些旧资料绕过删除栅栏。用户通过T29检查后明确另存/导出。预算不足时阻止恢复切换并提示清理可淘汰缓存/导出，不静默删除这些恢复证据。

## 11. 任务依赖、容量预算与修改禁区

| 任务 | 前置与交付边界 |
| --- | --- |
| T07 | T06后桌面SQLCipher+独立localDBKey/OSvault，使用OS CSPRNG不等待T15云协议；S27桌面部分及一致备份/迁移gate |
| T14 | contracts DTO+auth subject映射冻结后：账号/个人workspace/pending device/凭据哈希；不做团队权限 |
| T15 | 先交生产可复用nativecrypto/key-vault模块和独立Expo Hermes harness，再正式跨端向量、双QR/恢复安全gate；不依赖T23业务App，未通过云feature保持关闭 |
| T16 | T14+T15封装后：真实迁移/RLS/CAS/receipt/seq/pull；通过S01～S08，不得只mock数据库 |
| T17 | 本地repo与T16 DTO：Rust outbox原子性、draft依赖、cursor；不先写HTTP再补事务 |
| T18 | T16+provider能力gate：附件状态/账本/真实旧URL测试；无ready附件不开放引用 |
| T19 | T16+T18：pg-boss、物化snapshot、租约/日志/版本/对象GC；S25合成隔离PG/对象恢复核心fixture与runbook初稿，生产等价运维演练归T29/T30 |
| T20 | Dexie本地namespace/加密draft/outbox；T15 gate前只做local数据与mocktransport |
| T21 | T20+T15+T16+T18/T19：Web解锁/分页索引/同步；不承诺后台常驻 |
| T22 | T06版本兼容后手机业务scaffold、expo-sqlite SQLCipher/secure-store原生与备份配置；不作为T15独立harness前置；S27原生库/重装行为gate |
| T23 | T15+mobile本地repo：集成复用T15已验证的RN nativecrypto/key vault，完成分享输入/业务容量；不再次自研crypto，不在Expo Go伪验证 |
| T24 | T23+T16+T18/T19：mobile同步与前台恢复，后台仅尽力触发 |
| T25 | 按第10节分阶段归属复跑S01～S23/S26及S24/S25核心子场景、S27已实施本地部分；覆盖真实PG/S3与Hermes；后续付费/导出/运营子场景显式延期T26～T30 |
| T29 | T19+T25：有界导出/删除/恢复；恢复新ID+重新加密；导出明文需用户明确选择 |

以下运维预算已经写入唯一limits文件，配置不是缺项。下表仅解释用途，代码依旧读取JSON；这些是待T16/T19负载验证的实验预算，不是已经达到的生产性能。

| limits键 | 冻结实验值 | 验收/边界 |
| --- | --- | --- |
| server.statementTimeoutMs / lockTimeoutMs / snapshotStatementTimeoutMs | 2000 / 250 / 2000 ms | T16验证普通请求与锁竞争超时的回滚；T19验证最大合法快照能在预算内完成；禁止为过测试擅自延长 |
| cloud.snapshotTtlSeconds | 1800 s | 全分页+catchup+bootstrap在TTL内完成；有效期间pin日志/版本/附件 |
| cloud.snapshotMaxRows / maxLiveEntitiesPerWorkspace | 50000 / 50000 | snapshot只计live实体（history/saved/collection/collection_entry），不把retired墓碑或旧version算作快照row；两上限必须相等 |
| cloud.maxRetiredIdsPerWorkspace | 1000000 | live+retired预留名额，总ID栅栏预算；删除不能因名额满失败 |
| cloud.maxVersionsPerEntity | 20 | 不每按键保存版本；先回收已无日志/trash/snapshot/当前head保护且满足保留策略的旧版本，仍满则拒绝新版本，不静默删保护版本 |
| cloud.maxPendingUploadsPerWorkspace / maxStoredObjectsPerWorkspace | 4 / 200000 | reserve与ready/retained物理对象/版本计数在同事务检查；过期未清理对象仍占预算 |
| cloud.maxOperationsPerWorkspacePerMinute | 600 | workspace级可信server限流，不能靠deviceId切换绕过；精确成功op重试可返回已有receipt，不再消耗写入名额 |
| cloud.operationReceiptRetentionDays | 90 days | 不短于offlineDeviceLeaseDays；过期租约旧outbox按恢复协议核对，不能猜测receipt缺失等于未成功 |
| cloud.keyProtocolChallengeSeconds / keyProtocolMaxPendingPerAccount | 300 s / 5 | 单次challenge及pending配对数量有界；过期/消费后重放拒绝 |

T16负载fixture至少覆盖同空间并发CAS+reserve+精确retry与连接池scope复用；T19至少覆盖50000个live实体（包含关系与集合）、近上限16KiBmanifest、250ms锁竞争、有效snapshot阻GC及1800s恢复完成。失败先记录硬件/PG计划/实际耗时与容量，提交最小调整给负责人更新同一JSON，再重跑gate；不能绕开行数/timeout/一致性保护。版本上限20与30天保留同时可能阻止频繁保存，UI必须显示原因与可清理范围，T16/T19验证不丢旧版本；产品调整须先更新规格而不是实现暗删。

history/trash/version/lease配置按同一JSON执行。计费层未来可以缩小有效额度，所有硬保护仍以统一limits与可信entitlement共同判定。不能把proCandidateBytes自动当用户已购买容量。

低能力模型禁止修改：AEAD suite、AAD编码、key派生context/subkey ID、随机数来源、私钥存储、pair/recovery协议、RLS关闭/角色提升、复合workspaceFK、锁顺序、seq分配、epoch重置、outbox幂等字节、finalkey写权限、账本删除时机。遇冲突先保留测试失败与草稿，交给负责人裁决；不得为了过测试删gate/加fallback明文上传/使用service-role全表访问。

执行中禁止引入Supabase托管产品、自研jobs调度器、可搜索明文服务器字段、跨用户收敛加密、无限附件/历史配额，以及未被用户授权的数据上传。团队方案只保留workspace kind/membership/keyVersion接口空间，不实现团队协作、组织托管恢复或正文审计。

## 12. 官方依据

主要事实依据已就近引用；额外实现资料：[libsodium.js官方封装](https://github.com/jedisct1/libsodium.js)、[PostgreSQL RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)、[PostgreSQL isolation](https://www.postgresql.org/docs/current/transaction-iso.html)、[S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)、[pg-boss](https://github.com/timgit/pg-boss)。这些资料证明底层能力/限制，不证明本项目已通过安全、性能或恢复验收。
