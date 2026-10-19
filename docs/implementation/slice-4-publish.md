# 切片 4：发布与 AD CS 助手

## 目标与范围

- 分支 `slice/4-publish`。交付 `publishCrl(deps, bytes)`（入口取一次 `deps.now()`，与 `importCertificate` 同形；plan §5.5）、`POST /api/v1/crls`、`aia publish`、
  每次发布尝试一行日志、history 标记（C8 的解法，步骤 6），以及重写的 `scripts/adcs-crl-uploader.ps1`（plan §9）。
- 覆盖 `§10 #4 #5 #6 #11 #12 #13 #19 #20 #25`；`C1 C2 C3 C4 C5 C8 C10 C11`；`M2 M3 M6 M8–M16 M24`。
- 不在本切片：history / retire 路由与 CLI（见切片 6）；UI 上传卡片与令牌输入（见切片 5b）；
  生产助手替换与令牌文件下发（C10，见切片 7）；CRL 详情投影（见切片 5a）。

## 前置

- 切片 1：`createApp`；`src/http/errors.ts`（HTTPException → 信封：401 保留 `WWW-Authenticate`、畸形
  `Authorization` 400、413、415；`defaultHook`）；请求日志；settings 里的 `AIA_MAX_UPLOAD_BYTES`、
  `AIA_UPLOAD_TOKEN(_FILE)`（Worker 侧为可选 `wrangler secret`）；ObjectStore 三个适配器与一致性套件（D5）；
  夹具生成器 + vitest `globalSetup` + `tests/fixtures/pki.ts`（`manifest`、`NOW`、`fixture()`）；`pnpm run ci:*`。
- 切片 2：`src/core/pki/*`（`parseCRL` 的类型化错误 `PkiParseError`（`der` / `trailing_bytes` / `time` / `structure`）、`getAuthorityKeyIdHex`、
  `getCRLNumber`、`getDeltaBaseCRLNumber`、`isDeltaCRL`、按字节识别的 `toDer`，PEM 规则 M7 见切片 2）；
  `src/core/catalog.ts`（schema、`readState`、`ifMatch` 条件写与注入的 `sleep`）；`importCertificate`、`applyConfig`；
  catalog 规范格式（键 id 小写 hex、时间 `toISOString()`，M4/M21）；`src/core/summary/catalog-summary.ts`（证书部分；CRL 摘要在本切片步骤 2 加）。
- 切片 3：`src/core/resources.ts` 的路径表解析（`downloads` 字段与集成测试的下载核对要用）。
- 夹具规则：摘要、号、时间一律读 `tests/fixtures/pki/manifest.json`，`now = manifest.now`（`2026-01-04T00:00:00Z`）；
  不写字面 sha256 / 大小（ECDSA 与 PSS 签名随机，大小会抖）。下文夹具路径相对 `tests/fixtures/pki/`。

## 步骤

1. **夹具补充**（`tests/fixtures/generate-test-data.sh`，切片 1 的重写版）。
   - 新增 `certs/issuing-ca-1-renamed`：与 `issuing-ca-1` 同钥同 SKI、subject CN 不同，`import:false`，供 C1 用例。
     现有 `issuing-ca-1-renewed` 的 subject 与原证书相同，不能替代。
   - 若 owner 选接受 SHA-1（owner 确认 1）：加 `crls/issuing-ca-1/full-sha1`（`-md sha1`），先在 OpenSSL 3.0 上确认能签。
   - 条目扩展关键性、内外签名算法不一致两类不做夹具（`openssl ca` 产不出）：测试里解析现有 CRL 后改 pkijs 对象再调
     策略函数；策略在验签之前，不需要重签。
   - manifest 的 CRL 条目加 `nextPublish`（`full-adcs`、`delta-adcs` 取脚本里的 `NEXT_PUBLISH`，即 `2026-01-10T12:00:00Z`、`2026-01-04T18:00:00Z`；其余 `null`），
     供摘要测试读取，不写字面量。
   - 注意：脚本内容变即整树重生成；`manifest.json` 同步加条目；`bash tests/fixtures/generate-test-data.sh --check tests/fixtures/pki` 通过。
2. **blob 键与 CRL 摘要**。
   - 时间段：把 `worker-aia-cdp@5b570aa:src/worker/api/v2/builders/primitives.ts`（L209-215）的 `formatGeneralizedTime` 移入
     `src/core/pki/asn1.ts`，格式 `YYYYMMDDHHMMSSZ`（定宽，字典序即时间序）；切片 5a 的 `primitives.ts` 改为从这里导入。
   - 键：`src/core/publish.ts` 的 `crlBlobKey(targetId, summary, sha256)` =
     `blobs/crls/<targetId>/<YYYYMMDDHHMMSSZ>-<crlNumber>-<sha256>.der`（时间段为 `thisUpdate`），无 CRL 号时号段为 `none`。号段让切片 6
     只靠 `list` 列出历史、不逐个读 blob（默认值，可推翻；plan §5.1 同步）。键只由这个函数生成，测试从函数取键名，不写字面量。
   - CRL 摘要：`src/core/summary/catalog-summary.ts` 加 `buildCrlSummary(crl, der)`（源 `worker-aia-cdp@5b570aa:src/worker/r2/summary.ts`，
     只取字段推导）→ `{ crlNumber, baseCrlNumber, thisUpdate, nextUpdate, revokedCount, sha1, nextPublish }`，格式同切片 2 步骤 4；
     `revokedCount` 为非空整数（发布时总能解析，§10 #7 见切片 5a）；`nextPublish` 取 Next CRL Publish（`1.3.6.1.4.1.311.21.4`），缺失为
     `null`，供切片 5b 的状态规则。整份替换，不合并。
   - 切片 2 的 `CatalogSchema` 是严格对象，补全 CRL 摘要字段后，切片 3 的 `tests/helpers/seed-downloads.ts`（手写 CRL `current`）改用
     `buildCrlSummary` 生成摘要；切片 2–3 期间写下的本地 `.data` / `.wrangler/state` 不合新 schema，`pnpm reset:dev` 后重跑 `seed:dev`。
3. **扩展与时钟策略**（新 `src/core/pki/crl-policy.ts`，纯函数 `checkCrlPolicy(crl, now)`）。按序执行，首个命中即返回：
   1. 外层 `crl.signatureAlgorithm` 与 TBS 内 `crl.signature` 的 OID 或参数 DER 不同 → `invalid_crl`，
      `details.reason = "signature_algorithm_mismatch"`（M11，owner 确认 5）。
   2. `thisUpdate − now > 300 000 ms` → `not_yet_valid`（恰好超前 5 分钟接受；时间均为整秒，§10 #12）；
      `nextUpdate < now` 接受并返回 `expired: true` 供日志。两者都按 epoch ms 比较。
   3. CRL 扩展（`crl.crlExtensions`；C2、M14：识别与关键性无关，识别的扩展标了关键也接受）：

      | OID | 非关键 | 关键 |
      | --- | --- | --- |
      | `2.5.29.20` CRL Number、`2.5.29.27` Delta 指示、`2.5.29.35` AKI、`2.5.29.46` Freshest CRL | 接受 | 接受 |
      | `2.5.29.18` IAN、`1.3.6.1.5.5.7.1.1` AIA（plan §6 漏列，PKIjs 现状接受，C2） | 接受 | 接受 |
      | `1.3.6.1.4.1.311.21.1` / `.21.4` / `.21.14`（CA Version、Next CRL Publish、CRL Self CDP） | 接受 | 接受 |
      | `2.5.29.28` IDP | 接受 | `scoped_crl_unsupported`；只含 `distributionPoint` 的见 owner 确认 2 |
      | 其他 | 接受，原字节保留 | `unknown_critical_extension`，`details.oid` |

   4. 条目扩展（每个 `revokedCertificates[i].crlEntryExtensions`，M13，RFC 5280 §5.3）：`2.5.29.21` reasonCode、
      `2.5.29.24` invalidityDate、`2.5.29.23` holdInstructionCode 不论关键性都接受；`2.5.29.29` certificateIssuer
      → `scoped_crl_unsupported`（间接 CRL）；其他关键 → `unknown_critical_extension`，`details` 带 `oid` 与序列号。
4. **验签**（`src/core/pki/verify.ts`，重写 `worker-aia-cdp@5b570aa:src/worker/pki/crls.ts` 的 `verifyCRLWithIssuer`，L5-15）。
   `verifyCrlSignature(crl, issuerSpki)` → `{ ok: true } | { ok: false; reason: "invalid_signature" | "unsupported_algorithm"; detail? }`。
   - 白名单（C4、M10），任何密码学调用之前按 OID 判定，名称取自 `src/core/pki/constants.ts` 的 `SIGNATURE_ALG_NAMES`：
     `1.2.840.113549.1.1.5 / .11 / .12 / .13`（sha1/256/384/512WithRSAEncryption）；`1.2.840.113549.1.1.10` RSASSA-PSS
     （参数里的哈希同样限 SHA-1/256/384/512）；`1.2.840.10045.4.1`、`1.2.840.10045.4.3.2 / .3 / .4`（ECDSA），签发者 SPKI
     曲线限 P-256 / P-384 / P-521。SHA-1 两项取决于 owner 确认 1。其余（`1.3.101.112/113` EdDSA、`1.2.840.113549.1.1.14`、
     `1.2.840.10045.4.3.1`（两种 SHA-224）、DSA、SM2、MD2/MD5）→ `unsupported_algorithm`。
   - 然后 `pkijs.getCrypto(true).verifyWithPublicKey(crl.tbsView, crl.signatureValue, issuerSpki, crl.signatureAlgorithm)`
     （B21；M12：签名对收到的 TBS 字节，不重编码）；`false` 或抛错 → `invalid_signature`，异常文本只进日志 `detail`。
   - 禁用 `crl.verify()`：它比较签发者 DN（C1），并对 PKIjs 自己名单外的关键扩展静默返回 false（C2）。不调 `pkijs.setEngine`。
5. **新鲜度**（`src/core/publish.ts` 导出纯函数 `compareFreshness(current, incoming)`，重写 `worker-aia-cdp@5b570aa:src/worker/pki/crls.ts:17-44` 的 `isNewerCRL`；
   C3、M15）。比较对象是 catalog 里的 `current.summary`，不读当前 DER；号用 `BigInt(decimal)`，时间用 `Date.parse` 的 epoch ms，
   禁止字符串比较（带不带毫秒都要对）：

   | 序 | 条件 | 结果 |
   | --- | --- | --- |
   | 0 | 无 `current` | `created` |
   | 1 | `sha256` 相等 | `unchanged`（§10 #4） |
   | 2 | `crlNumber` 恰有一侧为 `null` | `non_orderable` |
   | 3 | 两侧有号：新 > 旧 → `updated`；新 < 旧 → `stale_crl`；相等 → 第 4 行 | |
   | 4 | 号相等或两侧都无号，比 `thisUpdate`：晚 → `updated`；相等 → `conflict`；早 → `stale_crl` | |

   `nextUpdate` 不参与；full 与 delta 目标各比各的（AD CS 共用号计数，序列有空洞无妨）。同号更晚 `thisUpdate` 记为
   `updated`，与旧实现及 `worker-aia-cdp@5b570aa:tests/worker/crl-upload.test.ts:215-247` 一致（规划默认值，可推翻）。
6. **`publishCrl`**（`src/core/publish.ts`；重写 `worker-aia-cdp@5b570aa:src/worker/api/v2/crls/upload.ts` 的核心部分与
   `worker-aia-cdp@5b570aa:src/worker/r2/certificates.ts` 的签发者查找）。`publishCrl(deps, bytes)` 在入口 `const now = deps.now()` 取一次快照，策略、
   `publishedAt`、日志共用。
   1. `toDer(bytes, "crl")` → DER 与 `sha256`；标签只认 `X509 CRL`，坏 base64 / 缺 END → `invalid_crl`（旧 `invalid_body` 取消，§10 #13）。
   2. `parseCRL`：错误映射为 `invalid_crl` + `details.reason`（`der` / `trailing_bytes` / `time` / `structure`；§10 #11、#25：
      `thisUpdate` 缺失或畸形即拒绝）。读 AKI、CRL Number、Delta 指示，值非法（M2：须 INTEGER tag 2、非空、≥ 0，BigInt
      读取，不加 20 octet 上限）→ `invalid_crl`，`reason = "extension_value"`。kind：带合法 Delta 指示即 `delta`（M6）。
   3. `checkCrlPolicy`（步骤 3）。
   4. `readState`：`config.json`、`catalog.json` 各一次 `get`，记下 catalog ETag。
   5. 解析目标：无 AKI 或 AKI 无 `keyIdentifier` → owner 确认 3（默认 `issuer_not_found`，`details.reason = "missing_aki"`，M3）；
      候选 = catalog 中 `summary.subjectKeyId === aki` 的证书（M4）；无候选 → `issuer_not_found`；config 中 `issuer` 属于候选
      且 `kind` 相同的目标；无 → `target_not_configured`（导入的证书在被目标绑定前不是签发者，M23）；验签用目标配置的签发者
      （owner 确认 4 默认，SKI 相同的续期证书不影响选择，C5）。
   6. 读签发者 DER（catalog 里的 `key`，缺失 → 500 `internal` + 日志），`parseCertificate` 取 SPKI，`verifyCrlSignature`（步骤 4）。
   7. `compareFreshness`；终态（`unchanged` / `stale_crl` / `conflict` / `non_orderable`）立即返回，零写入。409 的
      `details.current` 带当前 `sha256`、`crlNumber`、`thisUpdate`。
   8. `put crlBlobKey(…)`（步骤 2），`ifNoneMatch: "*"`，`precondition-failed` 视为已存在
      （键含摘要，内容必然相同），`contentType: application/pkix-crl`。
   9. 提交循环：若有旧 `current`，先 create-only 写 `history/<targetId>/<YYYYMMDDHHMMSSZ>-<crlNumber>-<sha256>.json`（文件名与被取代版本的 blob 键相同；体为被取代的 `current`
      记录原样 + `supersededAt`；`precondition-failed` 视为已有）；再 `put catalog.json`（`ifMatch`）。失败则按 250 / 500 / 1000 ms
      退避，重读 state，重跑第 5–7 步（目标或签发者变了就重新验签），最多 1 次初试 + 3 次重试，共 4 次 catalog 写，之后
      `concurrent_update`（plan §5.5"最多三次"按 1 + 3 解释，同切片 2 步骤 4）。
   10. 返回 `created`（之前无 current）或 `updated`；`current` 写入 `verifier`（签发者证书 id）、`publishedAt`、`summary`。
   - 零写入与孤儿（M9、C8）：第 1–7 步的任何拒绝与 `unchanged`，store 写日志为空。竞争失败（重读后终态）、
     `concurrent_update` 或第 8 步后崩溃只会留下本次 blob（孤儿）与"真实发布过的旧 current"的 history 标记，catalog 不变。
   - history 的定义改为"`history/<targetId>/` 标记 ∪ catalog 的 `current`"，不再是 `blobs/crls/<id>/` 的目录列表，
     孤儿 blob 永远不出现在历史里；标记体保存被取代的完整 `current` 记录。不放进 catalog 数组：违背 plan §5.3
     "catalog 大小不随发布次数增长"，且每个请求都读 catalog。`history/` 与旧前缀不相交（plan §13）。retire 写标记见切片 6，
     历史导入写标记见切片 7。孤儿清扫：不做（体积可忽略，需要时切片 6 再加）。（规划默认值，可推翻）
   - 日志：经 `deps.log` 恰好一行 `{ level, msg: "publish", targetId, kind, outcome | reason, sha256, crlNumber, thisUpdate,
     expired, attempts, ms, detail? }`（plan §4.3）；不含令牌与请求体。
   - 无伴随写（PEM、alias）、无 `caches.default`，第 9 步 catalog 写成功即完成（§10 #5、#6）。
7. **SKI 冲突规则**：同 kind 的两个目标其签发者 SKI 相同 → `config_invalid`，已由切片 2 步骤 6 的规则 V6 实现（M5，owner 确认 4
   默认）；本切片只在 `publish.test.ts` 补对应用例。默认下上传不产生 `issuer_mismatch`：它从上传路由的状态表删除，`ERROR_CODES` 里
   暂留给切片 7 的临时历史导入路由，切片 7 步骤 11 一并删除（plan §7.3 同步）。
8. **上传路由**（`src/http/routes/crls.ts`、`src/http/schemas.ts`，挂到 `src/http/app.ts`；HTTP 部分重写自 `worker-aia-cdp@5b570aa:src/worker/api/v2/crls/upload.ts:27-31, 184-203`）。
   - `createRoute` 的路由级 `middleware`（排在校验器之前，zod-openapi 源码确认）依次：`AIA_UPLOAD_TOKEN` 设置时 `bearerAuth`（§10 #19）→
     媒体类型闸 → `bodyLimit({ maxSize: AIA_MAX_UPLOAD_BYTES })`（流式无 `Content-Length` 也 413，已验证）。
   - 媒体类型（忽略参数与大小写）只认 `multipart/form-data`、`application/pkix-crl`、`application/x-pem-file`、
     `application/octet-stream`；其余或缺失 → 415 `unsupported_media_type`，`details: { received, accepted }`（M8）。
     原始体三种类型只作闸门，内容一律按字节识别。
   - `body.required: false`；multipart schema `{ crl: z.union([z.file(), z.string()]) }` 加 `.openapi({ type: "string",
     format: "binary" })`。`z.file()` 带注解可生成已验证；union 的生成与 form 校验未验证，开工先在测试里确认，不行就
     schema 只作文档、由处理器校验。
   - 处理器：multipart 读 `c.req.parseBody()`，缺 `crl` 或空串 → 400 `bad_request`；字符串字段按 UTF-8 文本走同一识别
     （UI 粘贴 PEM、`curl -F crl=<file`，M8）；multipart 畸形 → 400。原始体读 `c.req.arrayBuffer()`，0 字节 → 400。
   - 成功体（M16 补 `baseCrlNumber` 与签发者 id）：`{ outcome, target, kind, sha256, crlNumber, baseCrlNumber, thisUpdate,
     nextUpdate, issuer, downloads }`；`thisUpdate` 必填、`nextUpdate` 可空（§10 #25）；`downloads` = 绑定该目标的路径按字典序，
     每条 DER 后接其 `.pem`。`Cache-Control: no-store`。状态表（每个状态一个 schema，code 枚举收窄）：

     | 状态 | 码 |
     | --- | --- |
     | 201 / 200 | `created` / `updated`、`unchanged` |
     | 400 | `bad_request`（缺字段、空体、畸形 multipart、畸形 `Authorization`，B9） |
     | 401 / 413 / 415 | `unauthorized` / `payload_too_large` / `unsupported_media_type` |
     | 409 | `stale_crl`、`conflict`、`non_orderable`、`concurrent_update` |
     | 422 | `invalid_crl`、`not_yet_valid`、`unknown_critical_extension`、`scoped_crl_unsupported`、`unsupported_algorithm`、`issuer_not_found`、`target_not_configured`、`invalid_signature` |
     | 500 | `internal`（不泄漏异常文本） |

9. **CLI**（`src/cli/aia.ts`）：`aia publish <file...>` 读 `AIA_URL`、`AIA_UPLOAD_TOKEN(_FILE)`，按字节选
   `application/pkix-crl` / `application/x-pem-file` 发原始体；逐个文件处理互不影响；三种结果退出 0，其余 1；表格或 `--json`。
   根 CA 的离线 CRL 走这条路（review §2.2-3）。
10. **OpenAPI**：`node scripts/generate-openapi.ts` 重写 `docs/openapi.json`，`--check` 无漂移。
11. **AD CS 助手**（`scripts/adcs-crl-uploader.ps1`，重写 `worker-aia-cdp@5b570aa:scripts/adcs-crl-uploader.ps1`；§10 #20、M24）。
    - 保留：`#Requires -Version 7.0`、`$ErrorActionPreference = 'Stop'`、`Write-Log` 格式 `[yyyy-MM-dd HH:mm:ss.fffK][LEVEL]`
      与"日志永不抛错"、`SourceDir` / `LogPath` 默认值、发现 `*.crl` `*.dcrl` `*.pem`（非递归）、按 `LastWriteTimeUtc` 升序、
      `X` 存在时跳过 `X.pem`、单文件失败不影响其余、无文件 WARN 且退出 0、汇总行。
    - 删除：PS5 分支（`SkipHttpErrorCheck` 探测、`GetResponseStream`）、手搓 multipart、`Test-CrlValid`（`certutil -dump`）、
      按扩展名判格式、`New-Item SourceDir`（缺目录改为退出 1）、`data.id` 判定。
    - 新增参数：`-UploadUri`（默认 `https://aia.example.com/api/v1/crls`）、`-UploadTokenFile`、`-LedgerPath`
      （默认 `C:\ProgramData\PKI\crl-uploader\published.json`）、`-TimeoutSec 60`、`-AllowInsecureHttp`、
      `-UploadIntervalMs 1000`（两次实际上传之间的间隔，压住 catalog 单键每秒一次写，见风险）。
    - 令牌：`(Get-Content -LiteralPath $f -Raw).Trim()`，缺失或空 → 退出 1；带令牌且 URI 为 `http://` 时拒绝，除非
      `-AllowInsecureHttp`；令牌永不进日志与命令行。
    - 每个文件：`FileShare.Read` 打开，`IOException` 重试（事件触发时 CA 可能正在写）；`Get-FileHash -Algorithm SHA256`
      命中账本 → Skipped；首字节 `0x30` → `application/pkix-crl`，含 `-----BEGIN X509 CRL-----` → `application/x-pem-file`，
      否则失败且不上传；`Invoke-RestMethod -Method Post -ContentType <type> -Body <bytes> -SkipHttpErrorCheck
      -StatusCodeVariable status -TimeoutSec`。
    - 判定看 `outcome` / `error.code`，不只看状态：created / updated / unchanged 成功并写账本（临时文件 + `Move-Item -Force`；
      账本损坏或缺失按空处理并 WARN）；`stale_crl` 失败（账本说明该摘要从未被接受，plan §9）；401 失败并提示
      `-UploadTokenFile`；其余码、5xx、网络错误、超时都失败。
    - 汇总 `Created / Updated / Unchanged / Skipped / Failed`；有失败退出 1，否则 0。
    - 事件 68/69/70 与定时补扫在两个仓库里都只有 README 文字，没有任务定义可"保持不变"：本切片把触发器、
      `MultipleInstances IgnoreNew`、运行账户、令牌文件 ACL（`icacls`）、动作命令行写进 `docs/operations.md` 的"AD CS 助手"一节
      （该文件其余部分见切片 6）；不提交任务 XML。Pester / PSScriptAnalyzer 进 CI：不做（`worker-aia-cdp@5b570aa:docs/plan-review-2026-10-17.md` 已否决）。
12. **文档同步**：plan §5.1/§5.3/§5.5（history 标记、含 CRL 号的 blob 键、`nextPublish` 字段、重试次数；§5.5 另记剩余的跨对象竞争窗口——发布中
    目标被删——与"管理操作单人串行"）、§6（验签机制、策略表、白名单、新鲜度语义）、
    §7.1（成功体与状态表）、§7.3（码表）、§9（助手细节）、§11（夹具覆盖，C11）；`docs/operations.md` 记录手动 Windows 验证。

## 测试

- `tests/core/pki/crl-policy.test.ts`：`crls/issuing-ca-1/full-unknown-critical.der` → `unknown_critical_extension`；
  `full-unknown-noncritical.der` 通过；`full-idp-scoped.der` → `scoped_crl_unsupported`；`full-idp-dp-only.der` 按 owner 确认 2；
  `full-future.der` → `not_yet_valid`；`full-01.der` 在 `now = thisUpdate − 5 min` 通过、`− 5 min − 1 s` 拒绝；
  `delta-01.der` 在 `manifest.now` 通过且 `expired: true`；`full-01.der`（keyCompromise + invalidityDate）、
  `issuing-ca-2/full-01.der`（certificateHold + holdInstructionCode）通过；改对象构造：关键 CRL Number 通过（M14）；把
  `full-adcs.der` 的 `.21.1` / `.21.4` / `.21.14` 与（另造的）IAN / AIA 逐个标为关键，`checkCrlPolicy` 都接受（C2、M14；夹具里它们都是非关键，线上旧实现对
  关键的 `.21.x` 报 `invalid_signature`）；关键未知条目扩展、certificateIssuer 条目、内外算法不一致（M11）。
- `tests/core/pki/verify.test.ts`：`issuing-ca-1/full-01.der`（RSA）、`full-pss.der`、`root-ca/full-01.der`（ECDSA P-384）通过；
  `full-broken-sig.der`、`full-forged-aki.der` → `invalid_signature`；`full-01.der` 对 `issuing-ca-1-renamed` 通过（C1）；
  `full-unknown-critical.der` 签名通过（证明绕开了 PKIjs 的闸，C2）；`ed25519-ca/full-01.der`、`ed448-ca/full-01.der` →
  `unsupported_algorithm` 且无异常外泄；OID 表驱动覆盖白名单内外每一项（C4）。
- `tests/core/freshness.test.ts`：纯函数，字面摘要对象（非夹具）覆盖步骤 5 每一行，含两侧无号、`2^100+123` 级大号、
  带 / 不带毫秒的同一时刻。
- `tests/core/publish.test.ts`（MemoryStore 包一层写日志；先 `importCertificate` 所有 `import:true` 证书，`applyConfig` 为
  issuing-ca-1/2 的 full + delta、root-ca、ed25519-ca、ed448-ca 建目标）：
  - `test.each(manifest.crls)` 首次上传结果等于 `expect`（`full-idp-dp-only` 的 manifest `expect` 是 `scoped_crl_unsupported`，与 owner 确认 2 的默认
    "接受"不同，单独断言；`full-no-aki` 的 `expect` 已是 `issuer_not_found`，另断言 `details.reason = "missing_aki"`）；
    `test.each(manifest.scenarios)` 17 条（含 `full-02-conflict`、`root-ca/full-02-resigned` → `conflict`，`full-no-number` 双向
    `non_orderable`，`full-04-older-time` 号优先）；`test.each(manifest.invalid)` → `invalid_crl`；`full-bad-time.der` →
    `reason = "time"`；合成的畸形 CRL Number / Delta / AKI（迁自 `worker-aia-cdp@5b570aa:tests/worker/pki-values.test.ts:159-179`）→ `invalid_crl`。
  - 不变量：上面每个拒绝与 `unchanged` 的写日志为空（迁自 `worker-aia-cdp@5b570aa:tests/worker/crl-upload.test.ts:48-62, 266-276, 291-301, 341-349`）。
  - `full-01.pem`、`full-01.crlf.pem` 在 `full-01.der` 之后 → `unchanged`；blob 键格式、`current.verifier`、`publishedAt = now`；
    `full-02.der` 更新后 history = {full-01 标记, full-02 current}。
  - delta 独立：issuing-ca-1 full 已发布时 `delta-01.der` → delta 目标 `created`，full 不动；`rogue-ca/full-01.der` → `issuer_not_found`。
    另起两个 setup（不用上面的共同配置）：只给 issuing-ca-1 建 full 目标时 `delta-01.der` → `target_not_configured`；导入 issuing-ca-2 但 config 不含它的目标时
    `issuing-ca-2/full-01.der` → `target_not_configured`。
  - 摘要整份替换（切片 2 `summary.test.ts` 用例 2）：`full-01.der` 后发 `full-02.der`（`updated`），`current.summary` 深等于 `buildCrlSummary(full-02)`，无残留键。
  - SKI 冲突：另导入 `issuing-ca-1-renewed`（不绑目标）→ `full-01.der` 仍 `created`，`verifier` = issuing-ca-1。
  - AD CS 形态：`full-adcs.der`、`delta-adcs.der`（合成，D7 不用 `tests/data/adcs.ts`）。
  - 竞争：包装 store 在第一次 catalog 写前插入竞争者发布（更旧 / 相同 / 更新）→ 重试后 `updated` / `unchanged` / `stale_crl`，
    `sleep` 记录 `[250]`，孤儿 blob 存在但不在 history；每次 `ifMatch` 都失败 → `concurrent_update`，`sleep` 记录
    `[250, 500, 1000]`，catalog 写 4 次，catalog 不变。
  - 日志：每次调用恰一行，字段齐全；拒绝时有 `reason`。
- `tests/core/summary.test.ts`（切片 2 文件追加）：`buildCrlSummary` 对 `full-no-next-update` 得 `nextUpdate: null`；`full-01` 得 `nextPublish: null`；
  `full-adcs` 的 `nextPublish` 等于 manifest 的 `nextPublish`（步骤 1）；`revokedCount` 等于 manifest 的 `revoked`。
- `tests/storage/publish-stores.test.ts`：created / updated / unchanged / 竞争四组对 fs 适配器跑；`AIA_TEST_R2=1` 时对 r2
  （`getPlatformProxy`）跑，验证真实条件写语义。
- Worker 冒烟（`scripts/worker-smoke.ts`，续写切片 3 的下载段，`ci:worker` 执行）：该段应用的配置加 root-ca 的 full 目标与 `/crl/root-ca.crl`，
  经 `POST /api/v1/crls` 发布 `crls/root-ca/full-01.der`，再对 `/crl/root-ca.crl` 及其 `.pem` 做 GET、HEAD 与带 ETag 的 304：`application/pkix-crl`、`"<sha256>"` / `"<sha256>-pem"` ETag、夹紧后的 `Cache-Control`（workerd 用真实时钟，
  该 CRL 已过 `nextUpdate` → `max-age=60`）、显式 `Content-Length`，体 sha256 等于夹具。
- `tests/http/crls-upload.test.ts`（`createApp({ store: new MemoryStore(), now, … }).request()`；迁自
  `worker-aia-cdp@5b570aa:tests/web/api-client.test.ts` 第 3 例，重复上传改为 200 `unchanged`）：multipart 文件字段、字符串 PEM 字段、三种原始类型；
  `text/plain` 与缺 `Content-Type` → 415 + `details.received`；缺字段、空体 → 400；超限（带与不带 `Content-Length`）→ 413；
  令牌已设：无 / 错 → 401 + `WWW-Authenticate`，畸形头 → 400，正确 → 201；令牌未设不需鉴权；状态表每行至少一例；
  信封形状、`Cache-Control: no-store`、500 不泄漏文本。
- `tests/integration/node-e2e.test.ts`（本切片部分）：临时目录 fs 存储起真实服务，CLI `import` → `config apply` →
  `aia publish crls/root-ca/full-01.der` created → 再发 unchanged（退出 0）→ `full-02.der` updated → 再发 `full-01.der`
  stale（退出 1）→ `GET` 路径表 DER 的 sha256 与 `full-02.der` 一致。retire 部分见切片 6。

## 出口条件

- `pnpm run ci:check` 通过（worker / node / web 编译与 canary、lint、format、`node scripts/generate-openapi.ts --check`）。
- `pnpm run ci:test` 通过；`pnpm exec vitest run tests/core/publish.test.ts` 的用例数 ≥ `manifest.crls` + `scenarios` + `invalid` 条数。
- `AIA_TEST_R2=1 pnpm exec vitest run --project storage` 通过（含 `publish-stores.test.ts` 的 r2 组）。
- `pnpm run ci:worker` 通过（含 Worker 冒烟的 CRL 下载段）。
- `grep -rnE '\.verify\(|setEngine' src/core src/http` 无结果。
- 本地 `wrangler dev`（`.dev.vars` 含管理令牌）：`AIA_URL=http://127.0.0.1:8787 node src/cli/aia.ts import …` + `config apply`
  后，`aia publish crls/root-ca/full-01.der crls/issuing-ca-1/full-01.der` 均 created，再发均 unchanged（workerd 上 ECDSA + RSA 验签）。
- 手动 Windows 验证（PowerShell 7，服务为本机 Node 或 Docker 镜像，fs 存储，已导入证书并应用配置，`AIA_UPLOAD_TOKEN` 已设；
  夹具 CRL 改扩展名为 `.crl` 放入测试 SourceDir），逐条记录退出码与日志摘录到 `docs/operations.md`：
  1. `full-01` + `delta-01` → Created 2，退出 0，账本 2 条；2. 再跑 → Skipped 2，服务端无上传请求；3. 删账本再跑 → Unchanged 2；
  4. 用 `full-02` 覆盖 full 文件 → Updated；5. 再放入 `full-01` 的副本 → `stale_crl`，其余文件照常处理，Failed 1，退出 1；
  6. `full-01.pem` 单独 → Unchanged；7. 错令牌 → 401 退出 1；令牌文件缺失、`http://` 带令牌、SourceDir 缺失 → 上传前退出 1。
  生产 CA 上的事件触发运行属于切换（见切片 7）。
- `pnpm verify` 通过；分支本地合并进 `main`。

## 风险与对策

- PKIjs 升级改变算法表或 `WELL_KNOWN_EXTENSIONS`：`verify.test.ts` 的 C1/C2/EdDSA 用例即回归探针，锁 `pkijs@3.4.1`。
- P-521 没有夹具，workerd 上未验证：白名单保留（不回退旧行为）；出现 P-521 CA 时先补夹具与 `wrangler dev` 冒烟。
- R2 单键每秒一次写（plan §5.5）：同次运行 full + delta 连发、两台 CA 同时发布都可能撞限；限速异常不是 `precondition-failed`，
  服务端不重试，返回 500 并记日志（无法与其他存储故障区分，Miniflare 也不模拟）。对策：助手 `-UploadIntervalMs 1000`，
  失败由下次触发或定时补扫补上。
- config 与 catalog 分属两个对象：每次尝试都重读两者再解析目标，剩余竞争窗口（发布中目标被删）记入 plan §5.5（步骤 12），跨对象一致性见切片 2。
- `z.union([z.file(), z.string()])` 的 OpenAPI / form 校验未验证：步骤 8 先验证，失败退到处理器校验。
- 测试误写字面字节或大小：ECDSA 大小抖动会让这类测试自己失败；评审时检查只读 `manifest`。
- 事件触发时读到半写文件：`FileShare.Read` + 重试；读到截断内容服务端回 `invalid_crl`，助手记失败，下次补上。
- UI 上传在设置 `AIA_UPLOAD_TOKEN` 后不可用：本切片只在文档写明，处理见切片 5b。

## 开工前需 owner 确认

1. SHA-1 签名的 CRL（`sha1WithRSAEncryption`、`ecdsa-with-SHA1`）：推荐接受（分发服务不是校验器，旧实现也接受）；否则 `unsupported_algorithm`。
2. 只含 `distributionPoint` 的关键 IDP（AD CS 的 CDP 选项 'Include in the IDP extension of issued CRLs'，夹具 `full-idp-dp-only`）：推荐接受
   （仍是该 DP 的完整 CRL，勾选后不至于整站停发）；任何 `onlyContains*`、`onlySomeReasons`、`indirectCRL` 仍 `scoped_crl_unsupported`。
   线上 CRL 目前没有 IDP。
3. 无 AKI 或 AKI 无 `keyIdentifier`（夹具 `full-no-aki`）：推荐 `issuer_not_found` + `details.reason = "missing_aki"`；备选 `invalid_crl`。
4. 多张证书共用 SKI（AD CS 同钥续期，夹具 `issuing-ca-1-renewed`）：推荐按目标配置的签发者验签，`applyConfig` 拒绝同 kind
   且签发者 SKI 相同的两个目标，上传不再产生 `issuer_mismatch`（只留给切片 7 的历史导入）；备选是在上传里保留该码，用于"候选绑定了多个同 kind 目标"。
5. 外层与 TBS 内签名算法不一致：推荐 `invalid_crl`（RFC 5280 §5.1.1.2 要求相同）；备选沿用旧实现不比较。

其余（5 分钟边界取"恰好 5 分钟接受"、1 + 3 次重试、状态码表、同号更晚 `thisUpdate` 为 `updated`、两侧无号比 `thisUpdate`、
history 标记、blob 键带 CRL 号、不设 20 octet 上限）为规划默认值，可推翻，不阻塞开工。
