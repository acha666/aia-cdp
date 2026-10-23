# 切片 7：迁移

## 目标与范围

把 pki.acha.top 从旧 Worker `aia-cdp-worker`（线上跑旧仓库 `main` = `worker-aia-cdp@0ea3130`，下文称 Gen B）切到新服务：下载 URL 返回的 DER 不变（决策 7），旧对象不删，随时可回滚。交付物：

- `scripts/migrate-from-v2.ts`（入口，`parseArgs` 子命令 `inventory` / `plan` / `apply` / `verify`）与 `scripts/migrate-v2/*.ts`（纯逻辑，可单测）；复用 `src/core/pki` 解析验签与 `src/cli` 的 HTTP 客户端函数。
- 仅迁移期存在的 `POST /api/v1/admin/crls/{targetId}/history`（切换后删除）。
- 非生产演练记录、生产切换（含 AD CS 助手替换与令牌）、`docs/operations.md` 迁移与回滚章的实测版（骨架见切片 6）。

前提（C9）：历史迁移是**尽力而为**——线上归档是 Gen A/B，无摘要、同名覆盖，Gen C 从未部署；迁移脚本是 HTTP 客户端 + 本地解析验签，盘点通道见 owner 确认 1。

不做：按任何一代派生规则重算 URL（线上 `/dcrl/AchaIssuingCA02.crl` 不符合任何规则，URL → 签发者只能来自盘点）；Gen C 归档解析；旧对象清理（owner 在稳定期后手工做，见步骤 12）。

## 前置

- 切片 2：`src/core/pki` 严格解析（M1）、路径规则（M17）、管理路由 import / config、`src/cli/aia.ts` 的 HTTP 客户端函数。
- 切片 3：下载路由（步骤 7 逐条比对）。
- 切片 4：`checkCrlPolicy`、`src/core/pki/verify.ts`（`verifyWithPublicKey`，B21）、`crlBlobKey`（步骤 2）、history 标记（步骤 6，C8）、`POST /api/v1/crls`、改写的 `scripts/adcs-crl-uploader.ps1`（含 `-UploadTokenFile`）。
- 切片 5a：扩展解析器（读 AIA、CDP、Freshest CRL、CRL Self CDP `.21.14` 里的 URL）与证书 / CRL 详情路由。
- 切片 6：history 列表路由、`docs/operations.md` 迁移与回滚章骨架。
- 旧桶实名：用 `wrangler r2 bucket list` 查到并记录（按 wrangler 自动置备的命名规则推测为 `aia-cdp-worker-store`，未核实）。
- 一台入域 Windows 机器（CryptoAPI 冒烟）；CA 主机 Task Scheduler 的操作权限。

## 步骤

旧桶键布局速查（全在 `ca/`、`crl/`、`dcrl/` 下，与新布局不相交，plan §12）。键名与 custom metadata 只用于探测和取证，**不参与归属**：

| 代 | 时期 | canonical 键 | 归档键 | 陷阱 |
| --- | --- | --- | --- | --- |
| A | `4ec9be5`（2025-09-16）… `40c0366` 之前（2026-04-12） | 硬编码：CN 含 `Issuing` 一律 `<folder>/AchaIssuingCA01.crl`（CA02 亦然），否则 `AchaRootCA.crl` | `<folder>/archive/<CN 去掉 [^\w.-]>-<crlNumber>.crl`，如 `AchaIssuingCA02RSA-…`、`AchaRootCAECC-…` | 名字里的 CA 未必是字节的签发者；同名覆盖 |
| B（线上） | `40c0366` … `0ea3130`（`main`） | 根级 metadata 扫描保留已有键，否则 `<folder>/<证书键去 ca/ 与扩展名>.crl` | `<folder>/archive/<同上，如 AchaIssuingCA01_RSA-4096>-<crlNumber>.crl`（`worker-aia-cdp@0ea3130:src/worker/pki/crls/issuers.ts:249`） | 无摘要，同名覆盖；归档的 metadata 描述的是**新上传**的那份 |
| C | `3e58fba` 起，只在分支 `parsing-2026-10-18`（含 `5b570aa`），从未部署 | — | `<folder>/archive/<logicalBase>-<crlNumber>-<sha256>.crl` | 线上不存在 |

另有 `crl|dcrl/by-keyid/<AKI 小写 hex>.crl`（每次上传无条件写的当前副本）与伴随 PEM `*.crl.pem`、`ca/*.crt.pem`（Gen B 存上传原文，字节可与派生 PEM 不同）。没有 CRL 号时，归档名的号段换成 `<sha256 前 16 位>`。

1. **盘点（只读）**：`node scripts/migrate-from-v2.ts inventory --source https://pki.acha.top --channel http|r2 --out .migration/<date>/inventory.json`。每个对象记录键、字节数、sha256（r2 通道另记 etag、uploaded），字节存为 `.migration/<date>/objects/<sha256>`。`.migration/` 进 `.gitignore`（D7：线上工件不入库），由 owner 留存作迁移证据。
   - `http` 通道（推荐）：`GET /api/v2/certificates?limit=100` 与 `/api/v2/crls?limit=100` 拿根级键。列表项的 `id` 就是对象键（`worker-aia-cdp@0ea3130:src/worker/api/v2/crls/list.ts:73`）；不按 `hasMore` 翻页（线上 `hasMore: true` 但 `nextCursor: null`）。然后：每个 canonical 键探 `<key>.pem`；每个当前 CRL 按 AKI 探 `by-keyid`；归档名逐号探测，名字集由盘点到的证书键（Gen B）与证书 CN（Gen A）生成，线上应为 `AchaIssuingCA01_RSA-4096`、`AchaIssuingCA02_RSA-4096`、`AchaRootCA_ECC-P384`、`AchaIssuingCA01RSA`、`AchaIssuingCA02RSA`、`AchaRootCAECC`，号段取 1 到当前最大 CRL 号：2026-10-18 的线上工件里 CA01 是 255、CA02 是 237（AD CS 的 full 与 delta 共用一个号段），根是 4097。签发 CA 的 4 个名字在 `crl/`、`dcrl/` 两个目录都探 1–255（Gen A 可能把一个 CA 的字节放在另一个 CA 的名下，所以不按 CA 分号段）；根的 2 个名字只探 `crl/` 的 1–4097，owner 若知道根 CRL 号的起点可以缩短。先 HEAD，命中再 GET。旧下载路由对前缀下任意键都返回对象（`worker-aia-cdp@0ea3130:src/worker/worker.ts:46-61`），所以归档能经 HTTP 取到。请求串行，每秒不超过 10 次，总量约 1 万次 HEAD，约 17 分钟。
   - 对账：结果与 `GET /api/v2/stats` 比。Gen B 把 `crl/`、`dcrl/` 下所有 `.crl` / `.crl.pem`（canonical、PEM、by-keyid、归档）都计为 CRL，`storage.byPrefix` 是各前缀的字节和（`worker-aia-cdp@0ea3130:src/worker/api/v2/stats.ts:40-71`）。数量和字节都对上即盘点完整；有差额写进报告，再用 `r2` 通道补一次完整列表。
   - `r2` 通道：独立配置 `scripts/migrate-from-v2.wrangler.jsonc`（`r2_buckets: [{ binding: "LEGACY", bucket_name: "<旧桶实名>", remote: true }]`）+ `getPlatformProxy({ configPath, remoteBindings: true })`，需要 `wrangler login`。wrangler 4.151.1 的 schema 接受 `remote`、`getPlatformProxy` 有 `remoteBindings`（默认 `true`）——只查过类型，未对真实账号实测，开工先跑一次 `list`。绑定包成只暴露 `list` / `get` / `head` 的对象，脚本里没有写路径。
   - 注意：线上 `GET /api/v2/certificates` 会顺手 create-only 写 `ca/*.pem`（`worker-aia-cdp@0ea3130:src/worker/api/v2/certificates/list.ts:56-58`），盘点因此不是严格零写，但不改动已有对象，记入报告。
2. **归属（只按字节）**：`plan --inventory … --out .migration/<date>/plan.json`，纯函数、无网络。`worker-aia-cdp@5b570aa:src/worker/r2/crls.ts` 只作旧语义参考（reference-only），不复用它的派生规则。对每个对象：
   - 按内容识别 PEM / DER（M7），PEM 解码后按 DER sha256 去重；证书走切片 2 的严格解析，CRL 走切片 4 的解析与策略检查。
   - 按 AKI 找 SKI 相等的候选证书（可能不止一张，M5），逐个 `verifyCrlSignature`，验过的就是签发者；多张都验过（同钥续期）时取证书 id 字典序最小者，
     `--reuse` 时优先 plan 里已是该目标签发者的那张，保证同一 AKI 的 current 与历史归到同一目标。
   - kind 由 delta 指示决定；与所在目录（`crl/` / `dcrl/`）不符的记为发现项。
   - 分类：`current`（根级 canonical）、`alias`、`archive`、`pem`、`unattributed`（没有签发者能验过）、`invalid`（严格解析拒绝，如畸形时间或缺 AKI，M1 / M3）。
3. **生成配置**（同一个 `plan.json`）：
   - 证书：每个旧 DER 键 `/ca/<path>` 一条路径，`.pem` 键变为自动派生变体；只有 PEM 的证书补一条 DER 路径，并在报告里标出。
   - 目标：每个有根级 canonical CRL 的（签发者 sha256, kind）分配一个 UUID。没有 canonical CRL 的签发者不配目标（M23）。
   - 路径：每个 canonical 键一条，同一目标的多个旧名都指向它；label 取签发者 CN。
   - 所有路径必须通过切片 2 的路径规则（字符集，M17），不通过就停下。
   - **URL 交叉核对**：从全部证书的 AIA / CDP、全部 CRL 的 Freshest CRL 与 CRL Self CDP 里抽出 `http://pki.acha.top/` URL。每条都必须命中路径表，且命中目标的签发者必须等于含这条 URL 的证书或 CRL 所属的 CA。不一致（如 Gen A 把 CA02 的字节写进 CA01 名下）就停下，交 owner 判断。
   - UUID 写进 `plan.json` 后就固定：重跑 `plan --reuse` 读回已有 UUID，否则配置会漂移。
   - `by-keyid` 与 `archive` URL 默认不进路径表，步骤 8 查完访问日志再定。
   - owner 在 `apply` 之前审阅 `plan.json` 与报告。
4. **历史集与报告**：每个目标的历史集取归属到它的 `archive`、`alias`、`pem` 与旧 canonical 对象，按 sha256 去重、去掉 current，再按（CRL 号 BigInt, `thisUpdate` 时刻）排序（M15）；号相同而字节不同的两份都保留并标出。报告 `.migration/<date>/report.md` 写明每个目标找到、将导入、重复、`unattributed`、`invalid` 的数量，每个签发者号段里缺失的号（full 与 delta 合并看），并说明 Gen A/B 同名覆盖掉的版本已不可恢复。预期导入数少于 stats 的对象数。
5. **临时历史导入路由**：新文件 `src/http/routes/admin-history-import.ts`（`createApp` 里一行挂载）+ `src/core/admin.ts` 的 `importHistory(deps, targetId, bytes)`。语义：
   - 需要管理令牌；body 是原始 `application/pkix-crl`；复用 publish 的解析、策略检查与验签。
   - 签发者判定同切片 4 步骤 6 的第 5 小步：候选 = catalog 中 `subjectKeyId` 等于 AKI 的证书；无候选 → `issuer_not_found`；该目标配置的签发者不在候选中 →
     `issuer_mismatch`（plan §6 的含义，C5）；否则用配置的签发者验签。同钥续期时几张证书共用 SKI，"AKI 解析到哪张"没有唯一答案，所以只问"配置的签发者在不在候选里"。
     kind 也必须一致。
   - 按切片 4 步骤 5 的新鲜度不早于 current 的 → 409 `conflict`（`details.reason: "not_older_than_current"`），这种 CRL 应走正常发布。
   - blob 键与 publish 相同（`crlBlobKey`，切片 4 步骤 2），`put` 带 `ifNoneMatch: "*"`，再 create-only 写同名 history 标记（体为切片 4 标记的
     形状，即 `current` 记录的字段，另加 `importedAt`）：两者都已存在返回 200 `unchanged`，否则 201 `created`。**不读写 catalog 的 current**，
     除上一条外不做新鲜度判断。
   - 路由进 OpenAPI，漂移检查照常。不加额外开关，暴露窗口靠步骤 11 删除收口。
   - 导入的版本从来不是 current，靠标记出现在 history 列表里（切片 6 步骤 4）；没有标记的孤儿 blob 仍不出现。
6. **应用**：`apply --plan plan.json --target <新服务 URL>`，令牌读 `AIA_ADMIN_TOKEN(_FILE)` 与 `AIA_UPLOAD_TOKEN(_FILE)`。
   - 前置检查：新服务 `GET /api/v1/health` 的 `checks.configuration` 为 `missing`，或现有 config 与 plan 一致（重跑）。
   - 顺序：逐张 `POST /api/v1/admin/certificates` → `PUT /api/v1/admin/config`（首次带 `If-None-Match: *`，重跑带 `If-Match`）→ 每个 current 一次 `POST /api/v1/crls`（首次期望 `created`，重跑为 `unchanged` 或 `updated`）→ 按步骤 4 的顺序逐条 `POST …/history`。
   - 写 catalog 的调用之间至少间隔 1.1 s（R2 单键每秒一次写，超限是 500 而不是 precondition-failed，plan §5.5、切片 2 风险）。
   - 整个过程幂等，可反复跑。
7. **校验**：`verify --plan plan.json --old <URL> | --snapshot <inventory.json> --new <URL>`。
   - 路径表里每条 DER 路径两边各 GET 一次，比较 sha256。CRL 路径上，新服务的 CRL 若同一签发者签发且按切片 4 步骤 5 更新，记为 `advanced`，也算通过。
   - `.pem` 变体只比较解码后的 DER（Gen B 的 PEM 字节不同不算失败）。
   - 每个目标 `GET /api/v1/admin/crls/{id}/history` 返回的 sha256 集合必须等于 plan 的历史集加 current。
   - 扩展解码核对（D7 后真实 AD CS 字节的唯一回归）：对每张导入的证书与每个 current CRL 调 `GET /api/v1/certificates/{id}`、`/api/v1/crls/{id}`，
     断言没有扩展带解析错误或只回落为 ASN.1 dump，且 CA Version、证书模板名、Next CRL Publish、CRL Self CDP 都已解码；结果写进 `report.md`。
   - 重跑 URL 交叉核对。退出码 0 / 1。
8. **演练（非生产，按顺序）**：
   - 演练 A（Node + fs）：`AIA_DATA_DIR=$(mktemp -d)`，`node --enable-source-maps dist/server/runtime/node.js`，对线上源站只读地跑步骤 1–7。清空目录再跑一次；在已导入的目录上第二次 `apply`，结果全部 `unchanged`。
   - 演练 B（Workers）：`wrangler.jsonc` 加 `env.rehearsal`（Worker `aia-cdp-rehearsal`；`r2_buckets` 不继承，要在 env 里重写，自动置备新桶），`wrangler deploy --env rehearsal`，经 workers.dev 地址跑步骤 6–7。再对 `GET /api/v1/crls` 与一条下载路径各计时 20 次取中位数（切片 5a 留下的 R2 真实延迟），
     据此定 plan §5.6 的备忘开不开，结果写进 operations.md 迁移章。结束后 `wrangler delete --env rehearsal`；演练桶在 dashboard 清空后删除，或留给下一次演练。
   - 演练 C（CryptoAPI）：在内网主机用 Docker 镜像起服务（`-p 80:8080`，数据来自演练 A）。测试用入域 Windows 机在 hosts 里把 `pki.acha.top` 指过去，跑步骤 10 的冒烟；再用改写后的助手把 CertEnroll 里的当前文件传给这台主机，期望 `unchanged`；助手的账本按 `-UploadUri` 记、看不出 hosts 把同一主机名指到了演练主机，所以演练用单独的 `-LedgerPath`，或演练后删除该账本，否则正式切换时这些文件会被 Skipped（切片 4）。最后把 hosts 改回，用 `certutil` 再验一次旧站——这就是回滚演练。
   - 日志核对（`by-keyid` / `archive` URL 是否保留）：在旧 Worker 的 Workers Logs（旧配置已开 `observability.logs.enabled`）里查近 30 天的 `/crl/by-keyid/`、`/dcrl/by-keyid/` 与 `/archive/` 请求。有真实客户端在用，就给对应 URL 加路径条目（§5.2 允许）；否则这些 URL 切换后返回 404。
   - 演练结果（时间、命令、输出摘要）写进 `docs/operations.md` 的迁移章。
9. **生产切换**（按 owner 确认 2、3 的推荐写）：
   1. 记录回滚基线：`wrangler deployments list --name aia-cdp-worker` 的输出，以及 dashboard 里 pki.acha.top 当前的绑定方式（自定义域还是路由）。旧 `wrangler.jsonc` 没有 `routes`，绑定在仓库外配置；新 `wrangler.jsonc` 也不写 `routes`，免得 `wrangler deploy` 抢走域名。Worker 名 `aia-cdp`，绝不用 `aia-cdp-worker`（B6）。
   2. `openssl rand -hex 32` 生成两枚令牌，`wrangler secret put AIA_ADMIN_TOKEN` 与 `AIA_UPLOAD_TOKEN`；`wrangler deploy`；经 workers.dev 地址跑 `apply` 和 `verify --old https://pki.acha.top`。
   3. 准备 CA 主机：新助手放进旁路目录；令牌文件用 `icacls` 设成只有任务账户能读；保留旧脚本和旧任务动作的副本供回滚。CertEnroll 里应只有当前文件，否则助手首跑可能遇到 `stale_crl` 而退出 1（plan §9）。
   4. 冻结：禁用 AD CS 上传计划任务，重跑 `apply` 和 `verify`，追平冻结前新发布的 CRL。
   5. 切域：在 dashboard 把 pki.acha.top 从 `aia-cdp-worker` 移到 `aia-cdp`。期间每秒跑一次 `curl -s -o /dev/null -w '%{http_code}' http://pki.acha.top/crl/AchaRootCA.crl`，记下不可用时长。
   6. 替换助手（C10）：旧脚本只把含 `$resp.data.id` 的响应当成功（`worker-aia-cdp@5b570aa:scripts/adcs-crl-uploader.ps1:240-249`），v1 的每次上传都会被记成失败，所以只改 `UploadUri` 不够，必须换脚本（改写在切片 4；这里只安装）。任务动作改为 `-UploadUri https://pki.acha.top/api/v1/crls -UploadTokenFile <file>`。首跑前确认默认 `-LedgerPath` 上没有演练或旧部署留下的 `published.json`（同一 URI 的账本会把文件全部 Skipped），再手动跑一次，期望 `unchanged` 或 `updated`、退出码 0（按 LastWriteTimeUtc 从旧到新，M24），再启用任务。安装照 `docs/operations.md` 的"AD CS 助手"一节，同时核对其中标"未核对"的项（事件号与日志、CDP 文件位置、运行账户与 ACL、代理、计划任务注册），核对后改掉标记。核对触发器时，除旧部署的 Application 日志事件 68/69/70（含义与所在日志都未核对）外，一并查 Security 日志的 AD CS 审核事件 4872（"Certificate Services published the certificate revocation list (CRL)"；需在 CA 属性的"审核"页勾选"吊销证书和发布 CRL"，并在审核策略里开启"审核证书服务"的成功事件）：手动 `certutil -CRL` 发布一次 full 与 delta，看哪个事件每次都出现，任务的事件触发器用它。
   7. 跑步骤 10 的冒烟；在 UI 打开总览和 5 个 CRL 目标的详情。
   8. 观察：下一次 AD CS 定时发布后，助手日志应出现 `updated`，`GET /api/v1/crls` 里的 CRL 号前进。根 CRL 的 `nextUpdate` 是 2026-11-07 00:00 UTC，换发后用 `aia publish` 发到新服务。
10. **CryptoAPI 冒烟**：证明 C6、C7、C13、M18 带来的头部变化不影响真实客户端。
    - 在入域机上先 `certutil -urlcache * delete`，再对两张签发 CA 证书和一张由它们签发的终端证书各跑 `certutil -verify -urlfetch <file>.cer`。AIA 证书、CDP 的 full CRL、Freshest CRL 的 delta，每条都应为 `Verified`。
    - `certutil -URL http://pki.acha.top/crl/AchaRootCA.crl`（URL Retrieval Tool）核对检索状态。
    - `curl -sI http://…` 检查：200、没有 `Location`、没有 `Strict-Transport-Security`（B8；Cloudflare 的 "Always Use HTTPS" 不得覆盖下载前缀）、ETag 带引号、有 `Content-Length`、CRL 的 `max-age` ≤ 3600；带 `If-None-Match` 请求返回 304。
    - 所有输出存档。
11. **删除临时路由**：切换稳定、`verify` 通过后，在分支 `slice/7-cleanup` 删除 `admin-history-import.ts`、它的挂载行、`importHistory` 及其测试，以及 `ERROR_CODES` 中只剩它在用的 `issuer_mismatch`
    （切片 4 步骤 7），重新生成 `docs/openapi.json`，再部署。
12. **回滚手册**（写进 `docs/operations.md`，演练 C 验证过）：
    - 操作：dashboard 把域名移回 `aia-cdp-worker` → 任务动作和脚本换回旧副本 → 手动跑一次旧助手（旧服务对相同字节返回 409，是已知旧行为，无害）→ 切换窗口内只发到新服务的根 CRL，经旧 UI 重传。
    - 推荐方案下新服务用独立的桶，旧对象从没被写过，回滚不需要修数据。
    - 回滚后若再切回新服务（同一 `-UploadUri`），先删除新助手的 `published.json`；新服务从备份恢复过也一样（切片 4，`docs/operations.md`）。
    - 保留期：旧 Worker 和旧桶保留到两张签发 CA 各走完一个 full CRL 周期（约 8 天），且根 CRL 已在新服务换发。之后由 owner 手工删除：独立桶方案删旧 Worker 和整个桶；共享桶方案只删 `ca/`、`crl/`、`dcrl/` 三个前缀。

## 测试

- `tests/integration/migrate-classify.test.ts`（归 `integration` 项目，B15 不新增项目）：用夹具脚本生成的合成 CRL（D7，不用线上工件）拼一个假旧桶，覆盖：Gen A 名下放的是另一个 CA 的字节；Gen B 同名覆盖；字节不同的 `.crl.pem`；与 current 相同的 `by-keyid`；没有签发者能验过的 CRL；畸形时间的 CRL；没有 AKI 的 CRL；同一 SKI 的两张证书只有一张验得过；放在 `crl/` 下的 delta。断言分类、归属、历史集排序、URL 交叉核对的失败路径，以及 `--reuse` 下 UUID 稳定。
- 探测名生成：给定证书键和 CN，产出上表的名字集（Gen A 去字符；Gen B 去掉 `ca/` 前缀和扩展名）。
- `tests/http/admin-history-import.test.ts`：无令牌 401、未配置令牌 503；签发者不对 `issuer_mismatch`、坏签名 `invalid_signature`、不早于 current 409；
  另导入 `issuing-ca-1-renewed`（与目标签发者 `issuing-ca-1` 共用 SKI）后，`issuing-ca-1` 签发的旧 CRL 仍 `created`，不是 `issuer_mismatch`；重复导入 200 `unchanged`；成功后 `catalog.json` 的 store ETag 不变，history 列表多一条。
- `tests/integration/migrate.test.ts`：测试里起一个只读的假 v2 源（列表项按 `worker-aia-cdp@0ea3130` 的形状返回 `id`，下载前缀返回任意键），新服务用临时目录 fs。依次跑 `inventory --channel http` → `plan` → `apply` → `verify`，再跑一次 `apply`，结果全部 `unchanged`。

## 出口条件

- `slice/7-migration` 与 `slice/7-cleanup` 各自满足总则 §1.3。
- 切换后，`node scripts/migrate-from-v2.ts verify --plan … --snapshot .migration/<date>/inventory.json --new https://pki.acha.top` 退出 0：每条 URL 返回与旧 URL 相同的 DER sha256，或标为 `advanced`。
- `report.md` 已经 owner 审阅，包括每个目标的导入数、`unattributed` / `invalid` 清单和不可恢复说明。
- 旧对象未删：`inventory --compare <切换前 inventory.json> --source <旧 Worker 的 workers.dev 地址>` 退出 0（旧 Worker 没开 workers.dev 时改用 `--channel r2`）。
- 回滚：演练 C 的记录已写进 `docs/operations.md`；`wrangler deployments list --name aia-cdp-worker` 与步骤 9.1 的基线一致。
- CryptoAPI 冒烟输出已存档，全部 `Verified`，`curl -sI` 的各项检查都通过。
- 助手：切换后第一次定时运行的日志为 `updated` 或 `unchanged`、退出码 0，Task Scheduler 历史里没有失败。
- 扩展解码核对（步骤 7）在演练 A 与生产切换后都通过，结果在 `report.md`（D7）。
- 临时路由已删除：`curl -s -o /dev/null -D - -H "Authorization: Bearer $(cat <管理令牌文件>)" -X POST https://pki.acha.top/api/v1/admin/crls/<id>/history`
  返回 405 且带 `Allow: GET, HEAD`（GET 路由仍在，B7；不带令牌时 `bearerAuth` 先回 401，看不出路由是否已删）；`node -e 'process.exit(require("./docs/openapi.json").paths["/api/v1/admin/crls/{targetId}/history"].post ? 1 : 0)'` 退出 0；`grep -rn importHistory src tests` 没有输出。

## 风险与对策

- 根 CRL 2026-11-07 00:00 UTC 过期：切换避开换发日。11-07 前切不了，就先在旧站换发，迁移时自然带过来。
- 归属与 URL 名不一致（Gen A 遗留）：步骤 3 停下，不自动映射。
- 历史本来就不完整：报告写明，不做补救。
- 严格解析拒绝旧对象：只进报告。被拒的若是 current，切换阻断，交 owner；可能是切片 4 的策略过严。
- `getPlatformProxy` 的 `remoteBindings` 默认 `true`：主 `wrangler.jsonc` 永远不写 `remote: true`，否则一致性测试（B14）会直接写生产桶。r2 通道只用独立的配置文件。
- `aia-cdp` 若在切片 1–6 期间部署过，自动置备的 `aia-cdp-store` 里可能留有测试数据：`apply` 的前置检查要求 `configuration: missing`，不满足就先清桶。
- 令牌：只走 `wrangler secret` 和 `_FILE`，不进命令行和日志（plan §9）。
- 客户端缓存：CryptoAPI 缓存 CRL 到 `nextUpdate`，问题可能几天后才暴露。冒烟前先清 URL 缓存；切换后一周内每天看一次 Workers Logs 的 4xx/5xx。
- 切域时可能短暂不可用：放在 delta 刚发布之后做（delta 约 1.5 天有效，余量充足），记下不可用时长。
- 探测给旧站的负载：约 1 万次 HEAD，串行限速，可忽略。

## 开工前需 owner 确认

| # | 问题 | 选项 | 推荐 |
| --- | --- | --- | --- |
| 1 | 历史枚举通道（C9） | (a) 新 Worker 加临时路由，经共享的 `STORE` 列旧前缀（要求共享桶，读旧布局的代码进生产 Worker）；(b) R2 S3 API 令牌一次性列表（另需 S3 客户端与令牌管理）；(c) `getPlatformProxy` 远程 R2 绑定（需 `wrangler login`，未实测）；(d) dashboard 手工导出；(e) 只用 HTTP 探测可预测的 Gen A/B 归档名，再与 stats 对账 | (e) 为主，对账不平时用 (c) 补差：保住 §12 的 "不碰 R2"，且不需要凭据 |
| 2 | 是否共享旧 R2 桶（`bucket_name`） | (a) `aia-cdp` 设 `bucket_name` 为旧桶实名；(b) 不设，自动置备 `aia-cdp-store`（B6 默认）；(c) 复用旧 Worker 名 `aia-cdp-worker` | (b)：迁移走 HTTP，不需要共享；旧桶零写入，回滚没有数据风险，日后删整个桶即完成清理。(c) 不做：B6 规定不用旧名，否则会覆盖线上 Worker，回滚也变成 `wrangler rollback`。只有第 1 项选 (a) 时才必须共享 |
| 3 | AD CS 助手切换方式与上传令牌 | (a) 在冻结窗口内替换脚本（步骤 9）；(b) 切换前加第二个计划任务，并行发往新 Worker 的 workers.dev 地址，切域后停用旧任务。令牌：启用或不启用 `AIA_UPLOAD_TOKEN` | (a)：规模小、窗口短，CRL 文件在 CertEnroll 里等着就行。启用令牌，UI 上传用切片 5b 步骤 7 的令牌框 |
