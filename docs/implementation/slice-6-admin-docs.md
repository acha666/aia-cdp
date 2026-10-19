# 切片 6：管理补全与文档

## 目标与范围

- 补齐 plan §7.2 余下的管理路由（历史列表与下载、retire、删除证书）与 CLI（plan §7.4），定下退役、删除的边界语义；
  即 `§10 #23` 的切片 6 部分（import / config 在切片 2）。
- 重写 `README.md`，新写 `docs/api.md`，补全 `docs/operations.md`（含迁移与回滚手册，步骤 11），记录放弃 GitHub Pages 文档站；
  对应 `§10 #26`。
- 不在本切片：`migrate-from-v2.ts`、临时历史导入路由、手册演练（切片 7）；助手脚本本身（切片 4）；状态阈值与 UI（切片 5b）；
  HTTP 管理 UI（plan §1 非目标）。

## 前置

- 切片 2：管理鉴权（`bearerAuth`、503 `admin_disabled`、畸形头 400）、`src/core/admin.ts` 的 `applyConfig`、catalog 条件写重试、
  `src/cli/aia.ts` 骨架与退出码。
- 切片 3：下载路由与 404 表示。
- 切片 4：`publishCrl`、`crlBlobKey`、history 标记、错误码→状态码表、`scripts/adcs-crl-uploader.ps1`。
- 切片 1 / 5a：`scripts/generate-openapi.ts` 与漂移检查、`tests/http/openapi.test.ts`。
- 旧实现没有退役、删除、历史功能，步骤 1–7 无迁移源。

## 步骤

1. **退役状态进 catalog**（`src/core/catalog.ts`）：目标项加可选 `retired: { at, last }`（`last` = 退役时被清空的 `current`
   或 `null`），`version` 仍为 1。退役是终态（owner 确认 1 的默认）：该 UUID 不再接受上传；恢复发布 = config 里删旧目标、
   加新 UUID（同一签发者同一 kind 仍只能有一个目标，plan §5.2）。退役 UUID 重新加回 config 仍是退役状态。
2. **`retireTarget(deps, targetId)`**（`src/core/admin.ts`）：目标既不在 config 也不在 catalog → `not_found`；已退役 → 原样返回、
   不写；否则先 create-only 写被清空 `current` 的 history 标记（格式同切片 4 步骤 6），再用切片 2 的条件写重试把 `current` 置 `null`
   并写 `retired`，返回 `{ targetId, retiredAt, previous }`（`previous` = `{ sha256, crlNumber, thisUpdate }` 或 `null`）。历史 blob
   不动；一行日志（`msg: "retire"`）。catalog 有 `current` 而 config 已无此目标（跨对象竞态的残留）也允许退役，作为清理口。
3. **发布拒绝已退役目标**（改 `src/core/publish.ts`）：解析到目标后若有 `retired` → `target_not_configured`，
   `details: { targetId, retiredAt }`。检查放在切片 4 步骤 6 每次重读 state 后的目标解析里（第 5 小步）、写 blob 之前，保证零写入（M9），
   与 retire 竞态的发布也不会在退役后重建 `current`。否则有两个缺口：退役后下一次助手上传静默 `created`，"退役后删目标"被无限推迟；
   没有 baseline，比退役前更旧的 CRL 也被当作 `created`。
4. **历史**：`listHistory(deps, targetId)` 各 `list` 一次 `history/<targetId>/` 与 `blobs/crls/<targetId>/`；条目 = 有同名标记的 blob
   ∪ catalog 的 `current`（切片 4 步骤 6 的定义）。`thisUpdate`、`crlNumber`、`sha256` 从键名解出（键格式见切片 4 步骤 2），`size` 取自
   blob 的 `list`，`current` = 与 catalog 当前 `sha256` 相等；按 `thisUpdate` 降序、同时间按 CRL 号（BigInt）降序。不逐个读 blob 或标记
   （Workers 的子请求数与 CPU 撑不住）。解析不了的键跳过并记 warn；无标记的孤儿 blob 不列出（C8）；目标未知且两个前缀都为空 →
   `not_found`。`getHistoryBlob(deps, targetId, sha256)` 只对上述条目 `get` 其 blob 并重算摘要，不等 → `internal` 并记日志（存储或恢复后的
   损坏可见）。
   - 历史的定义写进 `docs/api.md`：曾作为 current 发布、后被取代或退役的 CRL + 当前 current + 切片 7 导入的旧版本；发布失败留下的
     孤儿 blob 不算（仍在存储里，不清扫，见切片 4）。`current: true` 表示正在发布。
5. **`deleteCertificate(deps, id)`**：不在 catalog → `not_found`。引用来源五类：`config.certificates[id]`、`config.targets[*].issuer`、
   `config.paths[*].certificate`、catalog 任一目标的 `current.verifier`、`retired.last.verifier`；命中任一 → `referenced`，
   `details.references` 列出来源（验证过已发布 CRL 的证书因此永久保留，owner 确认 2；切片 2 的 V9 保证一个目标的 current 与全部 history
   标记都由同一签发者验证，所以这五类也覆盖历史标记里的 `verifier`）。否则条件写删 catalog 项 → 重读 config 复核，期间出现引用则补偿
   写回并返回 `referenced` → 最后 `store.delete` blob。两步之间崩溃只留下无人引用的证书 blob，重新导入幂等。
6. **路由**（`src/http/routes/admin.ts`、`src/http/schemas.ts`）：全部 `Cache-Control: no-store`（含 DER 下载）；鉴权与 400 / 401 / 503
   见总则 §2.6；参数 schema 复用切片 2 的 targetId 与 sha256 格式；错误码→状态码沿用切片 4 的码表；每条路由带 `operationId` 与 `summary`。

   | 路由 | 成功 | 其余失败 |
   | --- | --- | --- |
   | `GET /api/v1/admin/crls/{targetId}/history` | 200 `{ targetId, retiredAt, current, entries[] }` | 404 |
   | `GET /api/v1/admin/crls/{targetId}/history/{sha256}` | 200 DER，`application/pkix-crl`，`attachment; filename="<sha256>.crl"`，显式 `Content-Length` | 404 |
   | `POST /api/v1/admin/crls/{targetId}/retire` | 200（首次与重复同体） | 404、409 `concurrent_update` |
   | `DELETE /api/v1/admin/certificates/{id}` | 204 | 404、409 `referenced` / `concurrent_update` |

   公开 `/api/v1/crls` 显示退役状态——不做（退役目标是 `current: null`，即"未发布"），原因：按手册退役后随即从 config 删除目标。
7. **CLI**（`src/cli/aia.ts`，子命令结构与退出码沿用切片 2；只走 HTTP）：`history <targetId> [--json]`（列 thisUpdate、CRL 号、
   sha256 前 16 位、size、current）；`history <targetId> <sha256> --out <file>`（写 DER，本地重算摘要）；`retire <targetId> --yes`；
   `delete-certificate <id> --yes`（`referenced` 时打印来源）。缺 `--yes` 按用法错误退出（默认值，可推翻）。
8. **OpenAPI 与文档守卫**：重新生成 `docs/openapi.json`（总则 §1.3）。扩展 `tests/http/openapi.test.ts`（切片 1 建，5a 已用它接替
   `worker-aia-cdp@5b570aa:redocly.yaml` 的 lint）：新路由同样要有 `operationId`、`summary` 与 bearer `security`，另加"4xx / 5xx 引用错误信封"。
   新 `tests/http/docs-consistency.test.ts`：生成文档的每个方法 + 路径出现在 `docs/api.md`；`src/http/schemas.ts` 的 `ERROR_CODES` 每一项
   出现在 api.md 码表；`src/runtime/settings.ts` schema 的每个变量出现在 `docs/operations.md`；CLI 子命令表（本切片从 `src/cli/aia.ts` 导出）
   的每个命令出现在 `README.md`。
9. **`README.md`**（中文重写，来源 `worker-aia-cdp@5b570aa:README.md`）：保留下载前缀与 `.pem` 规则（:72-80）；AD CS 前提
   （:119-121）移入 operations.md；删去 Workers Builds 部署（:28-52）、手工往 R2 `ca/` 放证书（:54-62）、v2 接口表（:82-95）、
   OpenAPI / Redoc / Pages（:97-117）。新内容：两条运行时（Node 24）、快速开始、下载 URL 与明文 HTTP、CLI 一览、部署入口、文档索引。
   "开发"一节取代 `worker-aia-cdp@5b570aa:docs/development.md`，不另设 `docs/development.md`，plan §3 文档列表不变（默认值，可推翻）：
   `.nvmrc`、OpenSSL ≥ 3.0、Docker、`pnpm run ci:*` 与 GitHub CI、`.dev.vars.example`、夹具（入库；改生成器后 `pnpm run fixtures` 并提交）、
   不得以 root 在工作树上跑 pnpm 或容器、分支流程（`slice/<n>-<name>`，本地 `--no-ff` 合并后推送）；丢弃其 act 一节（:99-116）与
   "Recovering a partial CRL publication"（:146-167，单提交点下不存在）。
10. **`docs/api.md`**（参考 `worker-aia-cdp@5b570aa:docs/api-design-v2.md`，不迁移内容）：权威是 `GET /api/v1/openapi.json` 与
    提交的 `docs/openapi.json`，api.md 只写规范表达不了的：鉴权（管理令牌、可选上传令牌、503 / 401 / 400）、信封与错误码→状态码表、
    上传的两种 body 与三种结果、"导入证书不等于授权签发者，须有目标绑定"（M23）、下载语义（引用切片 3 的头与缓存规则）、
    管理流程（import → config apply → publish → retire → 删目标 → delete-certificate）、退役终态与历史定义（步骤 1–5）。
11. **`docs/operations.md`**（补全其余各节，切片 4 的"AD CS 助手"一节与 Windows 验证记录并入下表）：

    | 节 | 要点 |
    | --- | --- |
    | 部署：Workers | `wrangler login`；`wrangler secret put AIA_ADMIN_TOKEN` / `AIA_UPLOAD_TOKEN`（可选，不进 `secrets.required`）；`VITE_SITE_NAME` 取自 shell 或 `.env.production.local`；`pnpm run build:web` 后 `wrangler deploy`（`WRANGLER_SEND_METRICS=false`）；Worker 名 `aia-cdp`，绝不用 `aia-cdp-worker`；首次部署自动置备 R2 桶，交互终端会把 `bucket_name` 写回 `wrangler.jsonc`（共用旧桶与否见切片 7） |
    | 部署：Node / Docker | `docker build --build-arg VITE_SITE_NAME=…`；`docker run -v aia-data:/data -p …:8080 --read-only --cap-drop ALL --security-opt no-new-privileges`；环境变量表与 `settings.ts` 一致；健康 200（含 `degraded`）/ 503；Kubernetes 用 httpGet 探 `/api/v1/health`；一个数据目录只对应一个进程（plan §1） |
    | 明文 HTTP 与 HSTS | `/ca/`、`/crl/`、`/dcrl/` 必须明文 200：Cloudflare 不对其开 Always Use HTTPS 或重定向规则，反向代理不跳转（review §2.2 #2）；应用不发 HSTS（B8）；推荐 PKI 主机名在边缘也不开 HSTS（HSTS 作用于整个主机名，遵守它的客户端会把明文下载升级为 HTTPS）；UI、API、上传走 HTTPS |
    | 反向代理 | 上传与管理路由的限速在代理做（plan §6）；`AIA_TRUST_PROXY` 只在 Node 前面有代理设置或追加 `X-Forwarded-For` 时打开（日志取最右一项）；代理体积上限 ≥ `AIA_MAX_UPLOAD_BYTES` |
    | 令牌 | `openssl rand -hex 32` 生成；Node 用 `AIA_*_TOKEN_FILE`，启动时读，轮换 = 换文件 + 重启；文件属主 uid 1000、`0400`、只读挂载；助手的令牌文件用 `icacls` 限权；CLI 用 `AIA_ADMIN_TOKEN_FILE`；令牌不进命令行与日志 |
    | 数据目录 | 绑定挂载须 `chown 1000:1000` 或 `--user <属主 uid>`（否则 health 503 `EACCES`）；总是显式 `-v …:/data`，避免匿名卷；不以 root 运行 |
    | 备份与恢复 | fs：先复制 `config.json`、`catalog.json`，再复制 `blobs/` 与 `history/`（blob 与标记不可变且先于 catalog 写入，快照引用的对象必在）；恢复 = 停服务 → 替换目录 → chown → 启动 → health。R2：按 owner 确认 3 的默认，操作员保存 `aia config show --json` 输出与 CA 证书文件，恢复 = import → config apply → 助手重跑或 `aia publish`，历史不能经 API 恢复 |
    | AD CS 计划任务（并入切片 4 的初稿） | `certutil -setreg CA\LogLevel 4` 后重启 CertSvc；CA 的本地 CDP 发布项写入助手的 SourceDir；任务 = 事件 68/69/70 触发 + 定时补扫、`MultipleInstances IgnoreNew`（每签发者一个发布者，`worker-aia-cdp@5b570aa:docs/architecture.md:122-124`）、运行账户对 SourceDir 与令牌文件只读、对日志与账本可写；动作 `pwsh.exe -NoProfile -NonInteractive -File …\adcs-crl-uploader.ps1 -UploadUri https://<host>/api/v1/crls -UploadTokenFile …`；参数、顺序与退出码以切片 4 的脚本为准（M24） |
    | 根 CRL | 离线 OpenSSL 签发、约半年有效；在 `nextUpdate` 前重签并 `aia publish`（review §2.2 #3）；到期提示阈值见切片 5b |
    | Worker CPU 与大 CRL | 切片 5a 的 10 000 条吊销详情构建实测；偏大时 `wrangler.jsonc` 设 `limits.cpu_ms`（旧 `limits.cpu_seconds` 是无效键），否则写明可接受的条目数上限 |
    | 退役与删除 | 先停该 CA 的计划任务 → `aia retire` → `aia config apply` 删路径与目标 → 需要时 `aia delete-certificate`；管理操作单人串行 |
    | 迁移与切换 | 前检：访问日志里 `by-keyid` / `archive` URL 是否在用（`worker-aia-cdp@5b570aa:docs/templates/migration-inventory.example.json:49-52`）、桶与历史枚举通道（C9，见切片 7）；步骤按 plan §13，切换时同时替换助手脚本并先放好令牌文件（C10）；预期头变化照切片 3 步骤 6 的表（旧记录见同文件 `:110` 起；C6、C7、M18、§10 #3）；域内机器上 `certutil -URL` 与 `certutil -verify -urlfetch` 冒烟 |
    | 回滚 | 路由指回 `aia-cdp-worker`；换回旧助手脚本与 `/api/v2/crls` 的 `UploadUri`（新助手读不了 v2 响应）；手动跑一次旧助手，补上切换窗口里只发到新服务的 CRL；旧对象从未改动 |

12. **放弃文档站**：不迁移 `worker-aia-cdp@5b570aa:.github/workflows/pages.yml`、`redocly.yaml`、`scripts/generate-docs-index.ts`，
    不装 `@redocly/cli`。原因：redocly 给 lockfile 带进 react 19、redoc、styled-components、mobx、OpenTelemetry；运行时 `openapi.json`
    已够用；lint 由步骤 8 的测试接替。决定记在 plan §3 的文档列表旁（步骤 13），不写进 README 与 `docs/api.md`（出口 grep 查这两个文件里的
    `Redoc`、`GitHub Pages`）。
13. **plan.md 同步**：§3 记录放弃文档站（步骤 12）、§5.3 `retired` 字段与历史的列法、§6 退役规则、§7.2 状态码列、§7.4 CLI 参数；§10 #23、#26 标为完成。

## 测试

- `tests/core/admin-retire.test.ts`（MemoryStore + 写日志 + 注入 `now`，夹具取切片 4 的 full / delta 集）：清空 `current` 并写
  `retired.last`、历史 blob 仍在；重复 retire 零写入；未知目标 `not_found`；从未发布的目标与"catalog 有 current、config 已无目标"
  都能退役；退役后上传更新与更旧的 CRL 都是 `target_not_configured` 且写日志为空（M9）；退役目标的下载路径 404；config 删旧目标、
  加新 UUID 后同一 CRL → `created`；退役 UUID 加回 config 仍被拒；竞态包装器让 retire 落在发布的读与条件写之间 → 发布被拒、`current` 为空。
- `tests/core/admin-history.test.ts`：发布 `full-01`..`full-03` 后的条目、顺序、CRL 号、摘要、size、`current`；退役后无 `current`、
  被清空的版本仍在；直接写进 blob 前缀、无标记的孤儿不列出（C8）；外来键跳过；`getHistoryBlob` 字节相等，未知摘要 `not_found`，
  篡改字节 → `internal`；已从 config 删除的退役目标仍可列。
- `tests/core/admin-delete.test.ts`：未引用 → 删除、blob 消失、重新导入 `created`；五类引用各一例 `referenced` 且带来源；补偿路径
  （包装器在 catalog 写后改 config）→ `referenced` 且 catalog 复原；重试耗尽 → `concurrent_update`。
- `tests/http/admin.test.ts`（扩展切片 2）：四条路由的状态码、信封、`no-store`、DER 下载头；无令牌 503、错令牌 401、畸形头 400；
  带有效令牌的 `GET …/retire` → 405 带 `Allow: POST`（无令牌是 401，见切片 2 同名测试）。`tests/http/openapi.test.ts`、
  `tests/http/docs-consistency.test.ts` 见步骤 8。
- `tests/integration/node-e2e.test.ts`（扩展 plan §11 流程）：… retire → 下载 404 → `aia history` → 删签发者证书 409 → `config apply`
  删目标后仍 409（verifier 保护）→ 删一张无关证书 204 → `history … --out` 的字节摘要与条目一致。

## 出口条件

- `pnpm exec vitest run tests/core/admin-retire.test.ts tests/core/admin-history.test.ts tests/core/admin-delete.test.ts
  tests/http/openapi.test.ts tests/http/docs-consistency.test.ts` 全绿。
- 每个职责只有一个实现：`grep -rn "storage/" src/cli` 无输出（CLI 只走 HTTP）；`grep -rnE "store\.(put|delete)\(" src/http src/runtime src/cli`
  无输出（写入只在 `src/core`）。
- 文档无旧口径：`grep -nE "Node 22|node:22" README.md docs/api.md docs/operations.md` 与
  `grep -nE "api/v2|Workers Builds|Redoc|GitHub Pages" README.md docs/api.md` 无输出（operations.md 的回滚节必须提 `/api/v2/crls`）。
- 在临时目录 `git clone` 本仓库，照 README 快速开始走到 `/api/v1/health` 返回 200。
- 照 operations.md 备份节对 Docker 部署做一次：备份 → 删容器与卷 → 新卷恢复 → health `healthy`，任一下载路径的 `sha256` 与备份前相同。

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| 退役改为终态，与 plan 原文"清空 current 后可继续上传"不同；误退役要改 config | owner 确认 1；`details.retiredAt` 让助手日志与 CLI 直接看出原因；api.md 与手册写恢复步骤 |
| config 与 catalog 分别条件写，retire / 删除证书与 `applyConfig` / 发布交错 | 发布在重试循环里复查退役；删除先删 catalog 项再复核 config、可补偿；残余窗口（`applyConfig` 在复核之后才落盘）靠手册"管理操作单人串行" |
| 历史不分页：delta 约 1.5 天一张，单目标每年约 250 条 | 规模内一次返回；r2 `list` 的 1000 条翻页由切片 1 一致性测试覆盖 |
| 已验过 CRL 的证书被永久锁住，误导入的签发者证书无法清理 | 本版不做 tombstone 清除；owner 确认 2 |
| 文档再次与代码漂移（§10 #26 的成因） | OpenAPI 漂移检查 + docs-consistency 测试 + 出口 grep |
| 计划任务、边缘 HSTS、Always Use HTTPS 都在仓库外，文档可能与现实不符 | owner 确认 4、5；未核对项在 operations.md 标"未核对"；切片 7 的 CryptoAPI 冒烟再验 |
| R2 无对象级备份，wrangler 4.151.1 也不能列对象 | owner 确认 3；手册写明恢复后历史缺失 |

## 开工前需 owner 确认

1. 退役语义。推荐：终态，退役 UUID 的上传一律 `target_not_configured`，恢复发布用新 UUID。备选：保留 baseline（只接受比退役前
   更新的 CRL 并重建 `current`，"退役后删目标"仍会被助手上传打断）；或按 plan 原文清空即重置（更旧的 CRL 也会 `created`）。
2. 证书删除保护。推荐：被任一 `current` 或 `retired.last` 作为 `verifier` 的证书永不可删（本版无 tombstone 清除）。
   备选：`--force` 允许删除，相关历史从此无法复验。
3. R2 备份。推荐：不申请 R2 S3 令牌（保持决策 3 的连带结论），只备份 config 与 CA 证书文件，接受历史丢失。备选：S3 令牌 + rclone 定期镜像。
4. AD CS 计划任务的现实配置：请在两台签发 CA 上用 `Export-ScheduledTask` 导出现有任务（事件 68/69/70 所在日志与来源、补扫间隔、
   运行账户）作为 operations.md 的依据。推荐：拿不到时按模板写并标"未核对"。
5. pki.acha.top 在 Cloudflare 上的 HSTS 与 Always Use HTTPS 现状（review §1 只证实明文 200、无 301）。推荐：该主机名两者都保持关闭。
