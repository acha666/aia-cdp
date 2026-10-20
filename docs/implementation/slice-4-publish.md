# 切片 4：发布与 AD CS 助手

## 目标与范围

- 分支 `slice/4-publish`。交付 `publishCrl(deps, bytes)`（plan §5.5）、`POST /api/v1/crls`、`aia publish`、每次发布尝试一行日志、
  history 标记（C8，步骤 6），以及重写的 `scripts/adcs-crl-uploader.ps1`（plan §9）。
- 覆盖 `§10 #4 #5 #6 #11 #12 #13 #19 #20 #25`；`C1 C2 C3 C4 C5 C8 C10 C11`；`M2 M3 M6 M8–M16 M24`。
- 不在本切片：history / retire 路由与 CLI（切片 6）；UI 上传卡片与令牌输入（切片 5b）；生产助手替换与令牌文件下发（C10，切片 7）；
  CRL 详情投影（切片 5a）。

## 前置

- 切片 1：`createApp`；`src/http/errors.ts`（HTTPException → 信封：401 / 400 / 413 / 415，`defaultHook`）；settings 的
  `AIA_MAX_UPLOAD_BYTES`、`AIA_UPLOAD_TOKEN(_FILE)`（Worker 侧为可选 `wrangler secret`）；memory / fs / r2 适配器与一致性套件；
  `tests/fixtures/generate-test-data.sh`、`tests/fixtures/pki.ts`（`manifest`、`NOW`、`fixture()`）。
- 切片 2：`src/core/pki/*`（`parseCRL` 与 `PkiParseError`、`getAuthorityKeyIdHex`、`getCRLNumber`、`getDeltaBaseCRLNumber`、
  `isDeltaCRL`、按字节识别的 `toDer`，PEM 规则 M7）；`src/core/catalog.ts`（`CatalogSchema`、`readState`、`ifMatch` 条件写与注入的
  `sleep`）；`importCertificate`、`applyConfig`；`src/core/summary/catalog-summary.ts`（证书部分）；catalog 格式（key id 小写 hex、
  时间 `toISOString()`，M4/M21）。
- 切片 3：`src/core/resources.ts` 的路径表解析（`downloads` 与集成测试的下载核对）。
- 夹具规则见总则 §2.5；下文夹具路径相对 `tests/fixtures/pki/`。

## 步骤

1. **夹具补充**（`tests/fixtures/generate-test-data.sh`）。
   - 新增 `certs/issuing-ca-1-renamed`：与 `issuing-ca-1` 同钥同 SKI、subject CN 不同，`import:false`，供 C1 用例；
     `issuing-ca-1-renewed` 的 subject 与原证书相同，不能替代。
   - owner 确认 1 选了接受 SHA-1：加 `crls/issuing-ca-1/full-sha1`（`-md sha1`），先确认 OpenSSL 3.0 能签。已确认：OpenSSL 3.5.5
     直接签（安全级别只约束 TLS，无需本地覆盖）；生成器再用 `openssl crl -text` 核对签名算法，签不出或不是 SHA-1 即失败。
   - owner 确认 2 接受只含 `distributionPoint` 的关键 IDP：`full-idp-dp-only` 的 `expect` 改为 `created`。
   - 条目扩展关键性、内外签名算法不一致两类不做夹具（`openssl ca` 产不出）：测试解析现有 CRL 后改 pkijs 对象（条目扩展）或
     `parseCRL` 暴露的收到字节（算法，见步骤 3）再调策略函数；策略在验签之前，不需要重签。夹具放不下的形态（几千个吊销条目、
     号长到上限）由测试内生成的 CA 现签（`tests/helpers/generated-ca.ts`：WebCrypto P-256 密钥 + PKIjs 自签证书，经 `importCertificate`
     导入），不提交大夹具。
   - manifest 的 CRL 条目加 `nextPublish`（`full-adcs`、`delta-adcs` 取脚本的 `NEXT_PUBLISH`，即 `2026-01-10T12:00:00Z`、
     `2026-01-04T18:00:00Z`；其余 `null`），供摘要测试读取，不写字面量。
   - 改完生成器 `pnpm run fixtures` 重生成整树并提交（每次换新密钥，签名、摘要、key id 全变，测试照旧只从 manifest 与文件取值）；
     `manifest.json` 同步加条目；`bash tests/fixtures/generate-test-data.sh --check tests/fixtures/pki` 通过。
2. **blob 键与 CRL 摘要**。
   - 时间段：把 `worker-aia-cdp@5b570aa:src/worker/api/v2/builders/primitives.ts`（L209-215）的 `formatGeneralizedTime` 移入
     `src/core/pki/asn1.ts`，格式 `YYYYMMDDHHMMSSZ`（定宽，字典序即时间序）；切片 5a 的 `primitives.ts` 改为从这里导入。
   - 键：`src/core/publish.ts` 的 `crlBlobKey(targetId, summary, sha256)` =
     `blobs/crls/<targetId>/<YYYYMMDDHHMMSSZ>-<crlNumber>-<sha256>.der`（时间段为 `thisUpdate`，无 CRL 号时号段为 `none`；plan §5.1）。
     号段让切片 6 只靠 `list` 列出历史、不逐个读 blob（默认值，可推翻）。测试从该函数取键名，不写字面量。
   - CRL 摘要：`src/core/summary/catalog-summary.ts` 加 `buildCrlSummary(crl, der)`（源 `worker-aia-cdp@5b570aa:src/worker/r2/summary.ts`，
     只取字段推导）→ `{ crlNumber, baseCrlNumber, thisUpdate, nextUpdate, revokedCount, sha1, nextPublish }`，格式同切片 2 步骤 4 与
     plan §5.3：`revokedCount` 非空整数（§10 #7 见切片 5a）；`nextPublish` 取 Next CRL Publish（`1.3.6.1.4.1.311.21.4`），缺失为 `null`，
     供切片 5b 的状态规则。整份替换，不合并。CRL Number、Delta 指示、Next CRL Publish 存在但畸形 → 抛 `PkiParseError`（`invalid_crl`，
     `reason = "extension_value"`）：三者（与 AKI）的 extnValue 都须恰好是一个值，多余字节即畸形（与严格 DER 一致，评审 C3）；Next CRL
     Publish 须是 RFC 5280 形式的 UTCTime / GeneralizedTime，别的类型也算畸形，不当作 `null` 静默存下（5b 的状态规则依赖它）；值内时间
     格式错误在 `parseCRL` 已按 `reason = "time"` 拒绝。同一 OID 的 CRL 扩展出现两次 → 同样 `extension_value`（X.509 每个扩展至多一次，
     读取都取第一个；证书摘要同样拒绝重复扩展）。
   - 号的长度上限（评审 C5）：号段进 blob 与 history 标记的文件名，文件系统单个名字 255 字节，fs 适配器还经 `.<名字>.<uuid>.tmp`
     临时文件写入（多 42 字节）。CRL Number 与 Delta 指示的 INTEGER 内容至多 48 octet（`MAX_CRL_NUMBER_OCTETS`，即至多 2^383 − 1、
     116 位十进制），更长 → `extension_value`。最长名字 = 15（时间）+ 1 + 116 + 1 + 64（sha256）+ 5（`.json`）= 202 字节，临时文件 244 字节，
     R2 键 247 字节（上限 1024）。这只给规划默认值"不设 20 octet 上限"加了一个上界：RFC 5280 的 20 octet 仍不强制，48 远高于它；
     原先过长的号在 fs 上是 `ENAMETOOLONG` 的 500，Workers 上却是 201，两条运行时不一致。
     `crlVersionName(summary, sha256)`（`<时间>-<号>-<sha256>`）同时给 blob 键与第 6 步的 history 标记命名。`formatGeneralizedTime`
     对无效日期或 0000–9999 以外的年份抛 `RangeError`（定宽格式放不下）。
   - 切片 2 的 `CatalogSchema` 是严格对象：补全 CRL 摘要字段后，切片 3 的 `tests/helpers/seed-downloads.ts`（手写 CRL `current`）改用
     `buildCrlSummary`；切片 2–3 期间写下的本地 `.data` / `.wrangler/state` 不合新 schema，`pnpm reset:dev` 后重跑 `seed:dev`。
3. **扩展与时钟策略**（新 `src/core/pki/crl-policy.ts`，纯函数 `checkCrlPolicy(crl, now)`）。按序执行，首个命中即返回：
   1. 外层 `signatureAlgorithm` 与 TBS 内 `signature` 收到的字节不同（OID 或参数）→ `invalid_crl`，
      `details.reason = "signature_algorithm_mismatch"`（M11，owner 确认 5）。比较收到的字节（`parseCRL` 返回的 `ReceivedCrl` 带
      `signatureAlgorithmView` / `signatureView`，即 asn1js 的 `valueBeforeDecodeView`），不比较重编码：外层不在签名之内，asn1js 会把
      0x80 填充的 OID 子标识符、带内容的 NULL 解码后按 DER 重编码，比较重编码就把这类改写当成相同（评审 C2）。
   2. `thisUpdate − now > 300 000 ms` → `not_yet_valid`（恰好超前 5 分钟接受；时间均为整秒，§10 #12）；
      `nextUpdate < now` 接受并返回 `expired: true` 供日志。两者都按 epoch ms 比较。
   3. CRL 扩展（`crl.crlExtensions`；C2、M14：识别与关键性无关，识别的扩展标了关键也接受）：

      | OID | 非关键 | 关键 |
      | --- | --- | --- |
      | `2.5.29.20` CRL Number、`2.5.29.27` Delta 指示、`2.5.29.35` AKI、`2.5.29.46` Freshest CRL | 接受 | 接受 |
      | `2.5.29.18` IAN、`1.3.6.1.5.5.7.1.1` AIA（PKIjs 现状接受，C2） | 接受 | 接受 |
      | `1.3.6.1.4.1.311.21.1` / `.21.4` / `.21.14`（CA Version、Next CRL Publish、CRL Self CDP） | 接受 | 接受 |
      | `2.5.29.28` IDP，只含 `distributionPoint` | 接受 | 接受（owner 确认 2） |
      | `2.5.29.28` IDP，空 SEQUENCE（RFC 5280 §5.2.5：合规签发者不得写） | `invalid_crl`，`extension_value` | `invalid_crl`，`extension_value` |
      | `2.5.29.28` IDP，含 `onlyContains*`、`onlySomeReasons`、`indirectCRL` 任一 | `scoped_crl_unsupported` | `scoped_crl_unsupported` |
      | 其他 | 接受，原字节保留 | `unknown_critical_extension`，`details.oid` |

      IDP 不论关键性都按原字节读（SEQUENCE，字段为 `[0]`–`[5]` 上下文标签、升序不重复，`[0]` 为构造型）；畸形 → `invalid_crl`，
      `reason = "extension_value"`。非关键的作用域 IDP 也拒绝（偏离原表"非关键接受"，实现时定）：RFC 5280 要求 IDP 关键，
      非关键只会来自不合规的 CA；本服务每个签发者只有一个 full 与一个 delta 目标，分区 CRL 当作完整 CRL 发布后，忽略非关键 IDP
      的客户端会把它当完整列表，漏掉其他分区的吊销。

   4. 条目扩展（每个 `revokedCertificates[i].crlEntryExtensions`，M13，RFC 5280 §5.3）：`2.5.29.21` reasonCode、
      `2.5.29.24` invalidityDate、`2.5.29.23` holdInstructionCode 不论关键性都接受；`2.5.29.29` certificateIssuer
      → `scoped_crl_unsupported`（间接 CRL，不论关键性）；其他关键 → `unknown_critical_extension`，`details` 带 `oid` 与序列号。
   - 返回 `{ ok: true; expired } | { ok: false; error; details; detail }`：`error` 即 §2.6 的码，`details` 原样进信封
     （`invalid_crl` → `{ reason }`；`not_yet_valid` → `{ thisUpdate }`；另两种 → `{ oid, serialNumber? }`，序列号为大写 hex，同 catalog），
     `detail` 是给日志的英文说明。
4. **验签**（`src/core/pki/verify.ts`，重写 `worker-aia-cdp@5b570aa:src/worker/pki/crls.ts` 的 `verifyCRLWithIssuer`，L5-15）。
   `verifyCrlSignature(crl, issuerSpki)` → `{ ok: true } | { ok: false; reason: "invalid_signature" | "unsupported_algorithm"; detail? }`。
   - 白名单（C4、M10），任何密码学调用之前按 OID 判定，名称取自 `src/core/pki/constants.ts` 的 `SIGNATURE_ALG_NAMES`：
     `1.2.840.113549.1.1.5 / .11 / .12 / .13`（sha1/256/384/512WithRSAEncryption）；`1.2.840.113549.1.1.10` RSASSA-PSS
     （参数里的哈希同样限 SHA-1/256/384/512）；`1.2.840.10045.4.1`、`1.2.840.10045.4.3.2 / .3 / .4`（ECDSA），签发者 SPKI
     曲线限 P-256 / P-384 / P-521。SHA-1 两项取决于 owner 确认 1。其余（`1.3.101.112/113` EdDSA、`1.2.840.113549.1.1.14`、
     `1.2.840.10045.4.3.1`（两种 SHA-224）、DSA、SM2、MD2/MD5）→ `unsupported_algorithm`。
   - 参数与密钥（同样在密码学调用之前，实现时补全）：PKCS#1 v1.5 与 ECDSA 的参数须缺省或 NULL，否则 `unsupported_algorithm`；
     RSASSA-PSS 须带 RSASSA-PSS-params，哈希限上述四种、MGF 须为 MGF1 且其哈希与签名哈希相同、`trailerField = 1`、salt 为非负整数，
     否则 `unsupported_algorithm`——PKIjs 3.4.1 忽略 MGF1 的哈希参数（WebCrypto 只有"MGF1 用同一哈希"），不拦会把标成 MGF1-SHA1
     的 SHA-256 签名验成通过（已用夹具验证），salt 长度 PKIjs 会照用。签名族与签发者密钥不符（RSA 签名配非 `rsaEncryption` 密钥、
     ECDSA 签名配非 `id-ecPublicKey` 密钥）→ `invalid_signature`（该密钥不可能签出它）；`id-RSASSA-PSS` 受限 RSA 密钥（WebCrypto
     不能导入）、白名单外曲线或显式曲线参数 → `unsupported_algorithm`。
   - 签名值：BIT STRING 有未用位 → `invalid_signature`；ECDSA-Sig-Value 须是严格 DER（恰好一个 `SEQUENCE { r INTEGER, s INTEGER }`、
     无尾随字节、INTEGER 最短且为正、不长于曲线阶）→ 否则 `invalid_signature`。PKIjs 把签名转成 WebCrypto 的 r‖s 时忽略尾随字节、
     把负数或多余前导 00 的 INTEGER 当无符号字节（已验证），同一签名会有多种字节形式都验过；OpenSSL 同样拒绝非 DER 的 ECDSA 签名。
     DER 的 r、s 按曲线长度（32 / 48 / 66）补齐的转换本身正确。
   - 然后 `pkijs.getCrypto(true).verifyWithPublicKey(crl.tbsView, crl.signatureValue, issuerSpki, crl.signatureAlgorithm)`
     （B21；M12：签名对收到的 TBS 字节，不重编码——pkijs 3.4.1 的 `tbsView` 是 asn1js 3.1.0 `valueBeforeDecodeView`，即 `fromBER`
     对输入的副本的子视图，原样字节）；`false` 或抛错 → `invalid_signature`，异常文本只进日志 `detail`。引擎缺失（`getCrypto(true)`
     抛错）不归为验签失败，按服务端故障抛出。失败结果另带 `algorithm`（`SIGNATURE_ALG_NAMES` 的名称，未知时为 OID），供日志与
     `details`。
   - 禁用 PKIjs 的 CRL `verify` 方法（比较签发者 DN，C1；对 PKIjs 名单外的关键扩展静默返回 false，C2）；不替换 PKIjs 的引擎。
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
   `worker-aia-cdp@5b570aa:src/worker/r2/certificates.ts` 的签发者查找）。入口 `const now = deps.now()` 取一次快照，策略、
   `publishedAt`、日志共用。
   1. `toDer(bytes, "crl")` → DER 与 `sha256`；标签只认 `X509 CRL`，坏 base64 / 缺 END → `invalid_crl`（旧 `invalid_body` 取消，§10 #13）。
   2. `parseCRL`：错误映射为 `invalid_crl` + `details.reason`（`der` / `trailing_bytes` / `time` / `structure`；§10 #11、#25：
      `thisUpdate` 缺失或畸形即拒绝）。严格 DER（M1）另含 X.690 对 X.509 所用通用类原始类型的内容规则（评审 C2）：INTEGER /
      ENUMERATED 最短（§8.3.2，空 INTEGER 本就拒绝）、OID 子标识符不以 0x80 开头（§8.19.2）、NULL 无内容（§8.8.2）、BOOLEAN 恰好
      一个 octet 且为 00 / FF（§11.1）→ `der`；规则在共用的解码里，证书同样适用（线上 3 张 CA 证书与 5 份 CRL 已逐一核对仍可解析、
      发布）。asn1js 的 `fromBER` 限额按输入设（节点数与内容长度上限都取输入字节数，评审 C1）：asn1js 3.1.0 默认 10 000 个节点，
      一个带 reasonCode 的条目占 8 个，约 1 250 个吊销条目的合法 CRL 曾被拒为 `der`；现在唯一的上界是 `AIA_MAX_UPLOAD_BYTES`
      （内存代价见风险）。读 AKI、CRL Number、Delta 指示，值非法（M2：须恰好一个 INTEGER，tag 2、非空、≥ 0、至多 48 octet，BigInt
      读取；不加 RFC 5280 的 20 octet 上限，见步骤 2）→ `invalid_crl`，`reason = "extension_value"`；AKI 存在而 `keyIdentifier` 为空、
      CRL 扩展重复同样是 `extension_value`（同证书摘要：空 key id 不标识任何密钥），摘要不合 catalog 格式为 `structure`。kind：带合法
      Delta 指示即 `delta`（M6）。
   3. `checkCrlPolicy`（步骤 3）。
   4. `readState`：`config.json`、`catalog.json` 各一次 `get`，记下 catalog ETag。
   5. 解析目标：无 AKI 或 AKI 无 `keyIdentifier` → `issuer_not_found`，`details: { reason: "missing_aki" }`（owner 确认 3，M3）；
      候选 = catalog 中 `summary.subjectKeyId === aki` 的证书（M4），无候选 → `issuer_not_found`，`details: { authorityKeyId }`；目标 =
      config 中 `issuer` 属于候选且 `kind` 相同的目标，无 → `target_not_configured`，`details: { kind, certificates }`（候选证书 id；
      导入的证书在被目标绑定前不是签发者，M23）；多于一个（只有绕过 V6 手写的 `config.json` 才会出现）→ 抛错，500 `internal`。
      验签用目标配置的签发者（owner 确认 4，SKI 相同的续期证书不影响选择，C5）。
   6. 读签发者 DER（catalog 里的 `key`，缺失 → 500 `internal` + 日志），`parseCertificate` 取 SPKI，`verifyCrlSignature`（步骤 4）；
      失败 → `invalid_signature` / `unsupported_algorithm`，`details: { algorithm }`。验签结果按签发者在重试间复用（重试解析到别的签发者才重验）。
   7. `compareFreshness`；终态（`unchanged` / `stale_crl` / `conflict` / `non_orderable`）立即返回，零写入。409 的
      `details.current` 带当前 `sha256`、`crlNumber`、`thisUpdate`。
   8. `put crlBlobKey(…)`（步骤 2），`ifNoneMatch: "*"`，`precondition-failed` 视为已存在（键含摘要，内容必然相同），
      `contentType: application/pkix-crl`。
   9. 提交循环：若有旧 `current`，先 create-only 写 `history/<targetId>/<YYYYMMDDHHMMSSZ>-<crlNumber>-<sha256>.json`（与被取代版本的
      blob 同名；体为被取代的 `current` 记录原样，不带时间；`precondition-failed` 视为已有）；再 `put catalog.json`（`ifMatch`）。
      标记不记取代时间（评审 C6）：最终 `concurrent_update` 的调用也可能先写了标记，而被标记的版本仍是 current，之后真正取代它的发布
      遇到已有标记不会改写，标记里的时间就永远是错的。取代时间 = 取代它的那一版的 `publishedAt`，切片 6 列历史时推出。
      失败则按 250 / 500 / 1000 ms 退避，重读 state，重跑第 5–7 步（目标或签发者变了就重新验签），1 次初试 + 3 次重试，共 4 次
      catalog 写，之后 `concurrent_update`（同切片 2 步骤 4）。循环是切片 2 `updateCatalog` 的推广 `updateState`（`src/core/catalog.ts`）：
      每次尝试先 `readState`，mutation 可以是 async，可在返回 `next` 前做 create-only 写；blob 与标记每次调用至多 `put` 一次。
   10. 返回 `created`（之前无 current）或 `updated`；`current` 写入 `verifier`（签发者证书 id）、`publishedAt`、`summary`。
   - 零写入与孤儿（M9、C8）：第 1–7 步的任何拒绝与 `unchanged`，store 写日志为空。竞争失败（重读后终态）、`concurrent_update`
     或第 8 步后崩溃只留下本次 blob（孤儿）与"真实发布过的旧 current"的 history 标记，catalog 不变。此时被标记的版本仍是 current：
     标记与 current 同名并存，切片 6 的历史列表按版本名合并（切片 6 步骤 4）。
   - 历史 = `history/<targetId>/` 标记 ∪ catalog 的 `current`（plan §5.3），不是 `blobs/crls/<id>/` 的目录列表。不放进 catalog 数组：
     违背 plan §5.3"catalog 大小不随发布次数增长"，且每个请求都读 catalog。`history/` 与旧前缀不相交（plan §13）。retire 写标记见切片 6，历史导入写标记见切片 7。孤儿清扫：不做（体积可忽略，需要时切片 6 再加）。（规划默认值，可推翻）
   - 日志：经 `deps.log` 恰好一行 `{ level, msg: "publish", targetId, kind, outcome | reason, sha256, crlNumber, thisUpdate,
     expired, attempts, ms, detail? }`（plan §4.3、总则 §2.6）。结束时还不知道的字段省略（解析失败无 `kind`，解析目标前无 `targetId`；
     每次尝试先清掉上一次的 `targetId` 与 `detail`，重试解析不到目标时不带前一次的目标，评审 C7），
     `null` 表示已知不存在（无 CRL 号）；`attempts` = 读 state 并解析目标的次数（1 + 重试，`readState` 之前的拒绝为 0）；成功 `info`、
     拒绝 `warn`。抛错时也恰好一行（`error`、`reason: "internal"`、`detail` 为异常文本），再抛给路由的 500：HTTP 侧依次是
     `publish`（`internal`）→ `unhandled_error` → `request`。
   - 无伴随写（PEM、alias）、无 `caches.default`，第 9 步 catalog 写成功即完成（§10 #5、#6）。
7. **SKI 冲突规则**：同 kind 的两个目标其签发者 SKI 相同 → `config_invalid`，已由切片 2 步骤 6 的规则 V6 实现（M5，owner 确认 4
   默认）；本切片只在 `publish.test.ts` 补用例。默认下上传不产生 `issuer_mismatch`：从上传路由的状态表删除，`ERROR_CODES` 里
   暂留给切片 7 的临时历史导入路由，切片 7 步骤 11 删除（plan §7.3）。
8. **上传路由**（`src/http/routes/crls.ts`、`src/http/schemas.ts`，挂到 `src/http/app.ts`；HTTP 部分重写自 `worker-aia-cdp@5b570aa:src/worker/api/v2/crls/upload.ts:27-31, 184-203`）。
   - `createRoute` 的路由级 `middleware`（排在校验器之前，zod-openapi 源码确认）依次：`AIA_UPLOAD_TOKEN` 设置时 `bearerAuth`（§10 #19）→
     媒体类型闸 → `bodyLimit({ maxSize: AIA_MAX_UPLOAD_BYTES })`（流式无 `Content-Length` 也 413，已验证）。
   - 媒体类型（忽略参数与大小写）只认 `multipart/form-data`、`application/pkix-crl`、`application/x-pem-file`、
     `application/octet-stream`；其余或缺失 → 415 `unsupported_media_type`，`details: { received, accepted }`（M8）。
     三种原始体类型只作闸门，内容一律按字节识别。`details.received` 是小写、不带参数的媒体类型，缺失或空头为 `null`。multipart 的
     `Content-Type` 除一个 `boundary` 外带任何参数 → 400 `bad_request`（hono 的表单解析只认这种形式，否则 zod-openapi 的闸会答无 details 的 415）。
   - `body.required: false`（否则原始体也会过表单校验器）；multipart schema `{ crl: z.union([z.file(), z.string()]) }` 加
     `.openapi({ type: "string", format: "binary" })`。已验证：union 生成为一个 binary string，表单校验器确实校验它（字段缺失或重复 →
     400，`details.target = "form"`），schema 不只是文档；处理器经 `parseBody` 取该字段。
   - 处理器：multipart 读 `c.req.parseBody()`，缺 `crl` 或空串 → 400 `bad_request`；字符串字段按 UTF-8 文本走同一识别
     （UI 粘贴 PEM、`curl -F crl=<file`，M8）；multipart 畸形 → 400。原始体读 `c.req.arrayBuffer()`，0 字节 → 400。
   - 成功体（plan §7.1，M16）：`{ outcome, target, kind, sha256, crlNumber, baseCrlNumber, thisUpdate, nextUpdate, issuer, downloads }`；
     `thisUpdate` 必填、`nextUpdate` 可空（§10 #25）；`downloads` = 绑定该目标的路径按字典序，每条 DER 后接其 `.pem`；200 与 201 共用
     一个 `PublishedCrl` schema。状态表：

     | 状态 | 码 |
     | --- | --- |
     | 201 / 200 | `created` / `updated`、`unchanged` |
     | 400 | `bad_request`（字段缺失、重复或为空，空体，畸形 multipart 或其 `Content-Type` 参数，畸形 `Authorization`，B9） |
     | 401 / 413 / 415 | `unauthorized`（带 `WWW-Authenticate`）/ `payload_too_large` / `unsupported_media_type`（`{ received, accepted }`） |
     | 409 | `stale_crl`、`conflict`、`non_orderable`（`details.current = { sha256, crlNumber, thisUpdate }`）、`concurrent_update`（无 details） |
     | 422 | `invalid_crl`、`not_yet_valid`、`unknown_critical_extension`、`scoped_crl_unsupported`、`unsupported_algorithm`、`issuer_not_found`、`target_not_configured`、`invalid_signature`（details 见步骤 3、4、6） |
     | 500 | `internal`（不泄漏异常文本；OpenAPI 里只有这条路由声明 500） |

   - OpenAPI `security: [{}, { uploadBearer: [] }]`（令牌可选）。该数组须显式标成 `Record<string, string[]>[]`：推断出的混合元素类型
     会让 `createRoute` 退回约束类型、丢掉路由的字面量类型。路由并入 `AppType` 链（切片 5b 的上传卡片）；`mediaType` 移到
     `src/http/media.ts`，两条上传路由共用。

9. **CLI**（`src/cli/aia.ts`）：`aia publish <file...>` 读 `AIA_URL`；上传令牌按 `--token-file` → `AIA_UPLOAD_TOKEN_FILE` →
   `AIA_UPLOAD_TOKEN` → 无（路由只在设了令牌时要求）。`--token-file` 是当前命令的令牌：import / config 为管理令牌，publish 为上传令牌；
   两个变量同时设、空令牌或非 bearer 字符 → 用法错误（两种令牌共用 `bearerToken` 的规则与文案）。按字节选类型发原始体：单个 DER
   SEQUENCE 为 `application/pkix-crl`，含 PEM 边界的文本为 `application/x-pem-file`（原样发送，bundle 由服务端报 `pem_blocks`），
   其余按 `application/pkix-crl` 交服务端报错。逐个文件处理互不影响：每文件一行（结果、目标、kind、CRL 号、文件；失败行带 HTTP 状态、
   码、`details.reason` 与其余 details，如 `stale_crl` 的当前 CRL 号与 thisUpdate）加汇总行，或 `--json` 的
   `{ results, created, updated, unchanged, failed }`。created / updated / unchanged 之外（含读不了文件、连不上服务、体不是上传结果）都算
   该文件失败；有失败退出 1，用法错误 2。根 CA 的离线 CRL 走这条路（review §2.2-3）。
10. **OpenAPI**：`node scripts/generate-openapi.ts` 重写 `docs/openapi.json`，`--check` 无漂移。
11. **AD CS 助手**（`scripts/adcs-crl-uploader.ps1`，重写 `worker-aia-cdp@5b570aa:scripts/adcs-crl-uploader.ps1`；§10 #20、M24）。
    - 保留：`#Requires -Version 7.0`、`$ErrorActionPreference = 'Stop'`、`Write-Log` 格式 `[yyyy-MM-dd HH:mm:ss.fffK][LEVEL]`
      与"日志永不抛错"、`SourceDir` / `LogPath` 默认值、发现 `*.crl` `*.dcrl` `*.pem`（非递归）、按 `LastWriteTimeUtc` 升序、
      `X` 存在时跳过 `X.pem`、单文件失败不影响其余、无文件 WARN 且退出 0、汇总行。
    - 删除：PS5 分支（`SkipHttpErrorCheck` 探测、`GetResponseStream`）、手搓 multipart、`Test-CrlValid`（`certutil -dump`）、
      按扩展名判格式、`New-Item SourceDir`（缺目录改为退出 1）、`data.id` 判定。
    - 新增参数：`-UploadUri`（默认 `https://aia.example.com/api/v1/crls`）、`-UploadTokenFile`、`-LedgerPath`
      （默认 `C:\ProgramData\PKI\crl-uploader\published.json`）、`-TimeoutSec 60`、`-AllowInsecureHttp`、
      `-UploadIntervalMs 1000`（两次实际上传之间的间隔，压住 catalog 单键每秒一次写，见风险）。`-TimeoutSec` 限 1–3600、
      `-UploadIntervalMs` 限 0–600000（参数校验失败 `pwsh -File` 退出 1）；`-UploadUri` 须是绝对 `http://` / `https://` URI，否则退出 1。
    - 令牌：`(Get-Content -LiteralPath $f -Raw).Trim()`，缺失或空 → 退出 1；另须是 RFC 6750 b64token（与 settings 对 `AIA_UPLOAD_TOKEN`
      的要求相同；非法头值会被请求异常的文本原样引用），否则退出 1；带令牌且 URI 为 `http://` 时拒绝，除非 `-AllowInsecureHttp`；
      令牌永不进日志与命令行。不给 `-UploadTokenFile` 就不发 `Authorization`。发送用 `-Authentication Bearer -Token <SecureString>`，
      `http://` 且 `-AllowInsecureHttp` 时加 `-AllowUnencryptedAuthentication`（PowerShell 自己也拒绝明文发令牌）。
    - 每个文件：`FileShare.Read` 打开，`IOException` 重试（共 5 次、间隔 1 s；事件触发时 CA 可能正在写）；对读到的字节
      `Get-FileHash -InputStream … -Algorithm SHA256`（不再开一次文件，摘要与上传的字节必然一致）；账本是"文件完整路径（不分大小写）→
      被接受字节的 SHA-256"，该路径的值相等 → Skipped，跳过的 `X.pem` 也记 Skipped。账本按路径而不是摘要集合：同一字节换个文件名
      （误放的旧副本）仍上传并得到 `stale_crl`（出口条件第 5 条）。首字节 `0x30` → `application/pkix-crl`，含 `-----BEGIN X509 CRL-----`
      → `application/x-pem-file`，否则失败且不上传；`Invoke-RestMethod -Method Post -ContentType <type> -Body <bytes> -SkipHttpErrorCheck
      -StatusCodeVariable status -TimeoutSec`。
    - 判定看 `outcome` / `error.code`，不只看状态：200 / 201 且 created / updated / unchanged 成功并写账本（临时文件 + `Move-Item -Force`；
      账本损坏或缺失按空处理并 WARN；写不进去则该文件记失败，下次重发得 unchanged）；`stale_crl` 失败（账本说明该摘要从未被接受，
      plan §9）；401 失败并提示 `-UploadTokenFile`（带了令牌说令牌错，没带说需要令牌）；其余码（日志带 `message` 与 `details`）、5xx、
      非上传结果的体、网络错误、超时都失败。`Invoke-RestMethod` 把 ISO 时间解析成 `DateTime`，日志按 ISO UTC 重新格式化。
    - 汇总 `Created / Updated / Unchanged / Skipped / Failed`；有失败退出 1，否则 0。手动 Windows 验证（出口条件）的环境、顺序、各条
      退出码与日志摘录记在 `docs/operations.md`。
    - 事件 68/69/70 与定时补扫在两个仓库里都只有 README 文字、没有任务定义：本切片把触发器、`MultipleInstances IgnoreNew`、
      运行账户、令牌文件 ACL（`icacls`）、动作命令行写进 `docs/operations.md` 的"AD CS 助手"一节（该文件其余部分见切片 6），
      不提交任务 XML；没在真实 AD CS 上验证的项标"未核对"，由切片 7 的生产切换核对。Pester / PSScriptAnalyzer 进 CI：不做（`worker-aia-cdp@5b570aa:docs/plan-review-2026-10-17.md` 已否决）。
12. **文档同步**：plan §5.1/§5.3/§5.5（history 标记、含 CRL 号的 blob 键、`nextPublish` 字段、重试次数；§5.5 另记剩余的跨对象竞争
    窗口——发布中目标被删——与"管理操作单人串行"）、§6（验签机制、策略表、白名单、新鲜度语义）、§7.1（成功体与状态表）、
    §7.3（码表）、§9（助手细节）、§11（夹具覆盖，C11）；`docs/operations.md` 记录手动 Windows 验证。

## 测试

- `tests/core/pki/crl-policy.test.ts`：`crls/issuing-ca-1/full-unknown-critical.der` → `unknown_critical_extension`；
  `full-unknown-noncritical.der` 通过；`full-idp-scoped.der` → `scoped_crl_unsupported`；`full-idp-dp-only.der` 按 owner 确认 2，空 IDP 不论
  关键性 `invalid_crl`；
  `full-future.der` → `not_yet_valid`；`full-01.der` 在 `now = thisUpdate − 5 min` 通过、`− 5 min − 1 s` 拒绝；
  `delta-01.der` 在 `manifest.now` 通过且 `expired: true`；`full-01.der`（keyCompromise + invalidityDate）、
  `issuing-ca-2/full-01.der`（certificateHold + holdInstructionCode）通过。改对象构造：关键 CRL Number 通过（M14）；
  `full-adcs.der` 的 `.21.1` / `.21.4` / `.21.14` 与另造的 IAN / AIA 逐个标为关键都接受（C2、M14；夹具里它们都非关键，线上旧实现
  对关键的 `.21.x` 报 `invalid_signature`）；关键未知条目扩展、certificateIssuer 条目、内外算法不一致（M11，改收到的字节；0x80 填充的 OID
  解码重编码后相同，仍判不一致）。
- `tests/core/pki/verify.test.ts`：`issuing-ca-1/full-01.der`（RSA）、`full-pss.der`、`root-ca/full-01.der`（ECDSA P-384）通过；
  `full-broken-sig.der`、`full-forged-aki.der` → `invalid_signature`；`full-01.der` 对 `issuing-ca-1-renamed` 通过（C1）；
  `full-unknown-critical.der` 签名通过（证明绕开了 PKIjs 的闸，C2）；`ed25519-ca/full-01.der`、`ed448-ca/full-01.der` →
  `unsupported_algorithm` 且无异常外泄；OID 表驱动覆盖白名单内外每一项（C4）。
- `tests/core/freshness.test.ts`：纯函数，字面摘要对象（非夹具）覆盖步骤 5 每一行，含两侧无号、`2^100+123` 级大号、
  带 / 不带毫秒的同一时刻。
- `tests/core/publish.test.ts`（MemoryStore 包一层写日志；先 `importCertificate` 所有 `import:true` 证书，`applyConfig` 为
  issuing-ca-1/2 的 full + delta、root-ca、ed25519-ca、ed448-ca 建目标）：
  - `test.each(manifest.crls)` 首次上传结果等于 `expect`（`full-idp-dp-only` 的 `expect` 已随步骤 1 改为 `created`（owner 确认 2），
    不再单独断言；`full-no-aki` 的 `expect` 已是 `issuer_not_found`，另断言 `details.reason = "missing_aki"`）；
    `test.each(manifest.scenarios)` 17 条（含 `full-02-conflict`、`root-ca/full-02-resigned` → `conflict`，`full-no-number` 双向
    `non_orderable`，`full-04-older-time` 号优先）；`test.each(manifest.invalid)` → `invalid_crl`；`full-bad-time.der` →
    `reason = "time"`；合成的畸形 CRL Number / Delta / AKI（迁自 `worker-aia-cdp@5b570aa:tests/worker/pki-values.test.ts:159-179`；另有尾随字节、
    重复扩展、超过 48 octet 的号）→ `invalid_crl`。改写外层算法（OID 加 0x80 填充、NULL 带内容）的 `full-01` 与 `root-ca/full-01` →
    `invalid_crl` / `der` 且零写入，之后原文件仍 `created`。签名先于新鲜度：先发 `full-pss`，再发更旧的 `full-broken-sig` → `invalid_signature`
    而不是 `stale_crl`（HTTP 层同一行）。生成的 CA：3000 个带 reasonCode 的条目 `created`；48 octet 的号 `created`、49 octet `invalid_crl`。
  - 不变量：上面每个拒绝与 `unchanged` 的写日志为空（迁自 `worker-aia-cdp@5b570aa:tests/worker/crl-upload.test.ts:48-62, 266-276, 291-301, 341-349`）。
  - `full-01.pem`、`full-01.crlf.pem` 在 `full-01.der` 之后 → `unchanged`；blob 键格式、`current.verifier`、`publishedAt = now`；
    `full-02.der` 更新后 history = {full-01 标记, full-02 current}。
  - delta 独立：issuing-ca-1 full 已发布时 `delta-01.der` → delta 目标 `created`，full 不动；`rogue-ca/full-01.der` → `issuer_not_found`。
    另起两个 setup（不用共同配置）：只给 issuing-ca-1 建 full 目标时 `delta-01.der` → `target_not_configured`；导入 issuing-ca-2 但
    config 无它的目标时 `issuing-ca-2/full-01.der` → `target_not_configured`。
  - 摘要整份替换（切片 2 `summary.test.ts` 用例 2）：`full-01.der` 后发 `full-02.der`（`updated`），`current.summary` 深等于
    `buildCrlSummary(full-02)`，无残留键。
  - SKI 冲突：另导入 `issuing-ca-1-renewed`（不绑目标）→ `full-01.der` 仍 `created`，`verifier` = issuing-ca-1。
  - AD CS 形态：`full-adcs.der`、`delta-adcs.der`（合成，D7）。
  - 竞争：包装 store 在第一次 catalog 写前插入竞争者发布（更旧 / 相同 / 更新）→ 重试后 `updated` / `unchanged` / `stale_crl`，
    `sleep` 记录 `[250]`，孤儿 blob 存在但不在 history，本次调用只验签一次（对 `verifyWithPublicKey` 计数）；重试解析到另一签发者 →
    验签两次；每次 `ifMatch` 都失败 → `concurrent_update`，`sleep` 记录 `[250, 500, 1000]`，catalog 写 4 次，catalog 不变，留下的标记是
    full-01 的记录原样。
  - 日志：每次调用恰一行，字段齐全；拒绝时有 `reason`。
- `tests/core/summary.test.ts`（切片 2 文件追加）：`buildCrlSummary` 对 `full-no-next-update` 得 `nextUpdate: null`；`full-01` 得
  `nextPublish: null`；`full-adcs` 的 `nextPublish` 等于 manifest 的 `nextPublish`（步骤 1）；`revokedCount` 等于 manifest 的 `revoked`。
- `tests/storage/publish-stores.test.ts`：created / updated / unchanged / 竞争四组对 fs 适配器跑；`AIA_TEST_R2=1` 时对 r2
  （`getPlatformProxy`）跑，验证真实条件写语义。fs 上另发 48 octet 号的 CRL 并被同号更晚的取代：blob、标记与临时文件名都放得下。
- Worker 冒烟（`scripts/worker-smoke.ts`，续写切片 3 的下载段，`ci:worker` 执行）：该段配置加 root-ca 与 issuing-ca-1 的 full 目标与
  `/crl/root-ca.crl`、`/crl/issuing-ca-1.crl`，上传令牌作为 harness secret；经 `POST /api/v1/crls` 发布，验签跑在 workerd 的 WebCrypto 上：ECDSA P-384
  （`crls/root-ca/full-01.der`）、RSA PKCS#1 v1.5、RSASSA-PSS 与 SHA-1 接受，`full-broken-sig` 为 422 `invalid_signature`，原始体与
  multipart（文件与字符串字段）都解析，无令牌 401。再对 `/crl/root-ca.crl` 及其 `.pem` 做 GET、HEAD、带 ETag 的 304 与 405：
  `application/pkix-crl`、`"<sha256>"` / `"<sha256>-pem"` ETag、夹紧后的 `Cache-Control`（workerd 用真实时钟，该 CRL 已过
  `nextUpdate` → `max-age=60`）、显式 `Content-Length`，体 sha256 等于夹具。
- `tests/http/crls-upload.test.ts`（迁自 `worker-aia-cdp@5b570aa:tests/web/api-client.test.ts` 第 3 例，重复上传改为 200 `unchanged`）：
  multipart 文件字段、字符串 PEM 字段、三种原始类型；`text/plain` 与缺 `Content-Type` → 415 + `details.received`；缺字段、空体 → 400；超限（带与不带 `Content-Length`）→ 413；
  令牌已设：无 / 错 → 401 + `WWW-Authenticate`，畸形头 → 400，正确 → 201；令牌未设不需鉴权；状态表每行至少一例；
  信封形状、`Cache-Control: no-store`、500 不泄漏文本。
- `tests/integration/node-e2e.test.ts`（本切片部分）：临时目录 fs 存储起真实服务，两侧都用上传令牌文件，CLI `import` → `config apply` →
  `aia publish crls/root-ca/full-01.der` created → 再发 unchanged（退出 0）→ `full-02.der` updated → 再发 `full-01.der`
  stale（退出 1）→ `GET` 路径表 DER 的 ETag、长度、sha256 与 `full-02.der` 一致；不带令牌 401；重启后该 CRL 仍是 current。retire 部分见切片 6。
- `tests/integration/cli.test.ts`（`publish`）：按字节选类型、未设令牌不发头；逐文件 updated / unchanged / 失败与退出 1；失败行的 details；
  `--json`；令牌来自 `AIA_UPLOAD_TOKEN`、`_FILE` 或 `--token-file`；缺令牌时每个文件 401；两个变量同设、空或畸形令牌在发送前拒绝；
  连不上服务时继续下一个文件。
- `tests/core/store-keys.test.ts`：`crlBlobKey` / `crlVersionName` 的格式（时间段、号段、`none`）都过 `assertStoreKey`；
  `tests/http/client.test.ts`：`hc<AppType>` 以 multipart 字段 `crl` 上传，201 与 422 的体按状态收窄（切片 5b 的上传卡片）。

## 出口条件

- `pnpm exec vitest run tests/core/publish.test.ts` 的用例数 ≥ `manifest.crls` + `scenarios` + `invalid` 条数。
- `AIA_TEST_R2=1 pnpm exec vitest run --project storage` 通过（含 `publish-stores.test.ts` 的 r2 组）。
- `pnpm run ci:worker` 含 Worker 冒烟的 CRL 发布与下载段。
- `grep -rnE '\.verify\(|setEngine' src/core src/http` 无结果。
- 本地 `wrangler dev`（`.dev.vars` 含管理令牌；`.dev.vars.example` 只有管理令牌，上传不需令牌，`.dev.vars` 加 `AIA_UPLOAD_TOKEN` 后才要求）：`AIA_URL=http://127.0.0.1:8787 node src/cli/aia.ts import …` + `config apply`
  后，`aia publish crls/root-ca/full-01.der crls/issuing-ca-1/full-01.der` 均 created，再发均 unchanged（workerd 上 ECDSA + RSA 验签）。
- 手动 Windows 验证（PowerShell 7，服务为本机 Node 或 Docker 镜像，fs 存储，已导入证书并应用配置，`AIA_UPLOAD_TOKEN` 已设；
  夹具 CRL 改扩展名为 `.crl` 放入测试 SourceDir），逐条记录退出码与日志摘录到 `docs/operations.md`：
  1. `full-01` + `delta-01` → Created 2，退出 0，账本 2 条；2. 再跑 → Skipped 2，服务端无上传请求；3. 删账本再跑 → Unchanged 2；
  4. 用 `full-02` 覆盖 full 文件 → Updated；5. 再放入 `full-01` 的副本 → `stale_crl`，其余文件照常处理，Failed 1，退出 1；
  6. `full-01.pem` 单独 → Unchanged；7. 错令牌 → 401 退出 1；令牌文件缺失、`http://` 带令牌、SourceDir 缺失 → 上传前退出 1。
  生产 CA 上的事件触发运行属于切换（见切片 7）。2026-10-20 已做：Windows 11 上的 PowerShell 7.6.6 对 WSL2 里的 Node 运行时，全部按预期，
  记录见 `docs/operations.md`。第 6 条要求 `full-01` 仍是当前 full CRL，所以单独用一个 SourceDir 与账本、在第 3 条之后跑（顺序 1、2、3、6、4、5、7）；
  第 5 条让副本最先处理并同时换上 `delta-02`，"其余文件照常处理"因此含一次真实上传。

## 风险与对策

- PKIjs 升级改变算法表或 `WELL_KNOWN_EXTENSIONS`：`verify.test.ts` 的 C1/C2/EdDSA 用例即回归探针，锁 `pkijs@3.4.1`。
- P-521 没有夹具，workerd 上未验证：白名单保留（不回退旧行为）；出现 P-521 CA 时先补夹具与 `wrangler dev` 冒烟。
- R2 单键每秒一次写（plan §5.5：超限不是 `precondition-failed`，服务端不重试，500 + 日志）：同次运行 full + delta 连发、两台 CA
  同时发布都可能撞限；无法与其他存储故障区分，Miniflare 也不模拟。对策：助手 `-UploadIntervalMs 1000`，失败由下次触发或定时补扫补上。
- config 与 catalog 分属两个对象：每次尝试都重读两者再解析目标，剩余竞争窗口（发布中目标被删）记入 plan §5.5（步骤 12），跨对象
  一致性见切片 2。
- `z.union([z.file(), z.string()])` 的 OpenAPI / form 校验：已在步骤 8 验证（生成为 binary string，表单校验器校验它，缺失或重复字段 400）。
- 测试误写字面字节或大小：重生成夹具（步骤 1）后这类测试会失败；评审时检查只读 `manifest`。
- 事件触发时读到半写文件：`FileShare.Read` + 重试；读到截断内容服务端回 `invalid_crl`，助手记失败，下次补上。
- UI 上传在设置 `AIA_UPLOAD_TOKEN` 后不可用：本切片只在文档写明，处理见切片 5b。
- 大 CRL 的内存与时间（评审 C1，2026-10-20 实测，生成的 P-256 CA，每条目 9 octet 序列号 + reasonCode，约 42 字节）。线上 CRL 目前 0 个条目。

  | 条目数 | DER | Node 发布耗时 | Node 峰值 RSS（基线约 105 MB） | Node 最小可行 `--max-old-space-size` | workerd 单次上传 RSS 增量 |
  | --- | --- | --- | --- | --- | --- |
  | 1 000 | 41 KB | 73 ms | 137 MB | 32 MB | +30 MB |
  | 5 000 | 205 KB | 281 ms | 274 MB | 64 MB | +107 MB |
  | 10 000 | 410 KB | 510 ms | 315 MB | 96–128 MB | +138 MB |
  | 25 000 | 1.0 MB | 1.2 s | 446 MB | 256 MB | +216 MB |
  | 50 000 | 2.0 MB | 2.4 s | 653 MB | 512 MB | +342 MB |
  | 100 000 | 4.0 MB | 4.7 s | 1 060 MB | 1 024 MB | +589 MB |
  | 249 000 | 10.0 MB | 12.8 s | 2 261 MB | 3 072 MB | +732 MB（与前几次共用一个进程） |

  约每 10 000 条目 100 MB 堆（asn1js 节点树 + PKIjs 对象）。本地 workerd 不执行 128 MB 隔离区上限，以上尺寸全部 201；按 Node 的堆需求与
  workerd 的 RSS 增量估计，Workers 上可支持约 5 000 条目（≈ 200 KB），10 000 条目已在 128 MB 边缘，50 000 必然超限（生产上该请求报
  内存超限，未在 Cloudflare 上验证）。Node 上的上限是堆：默认堆（本机 4 GB）下 10 MiB 的合法 CRL 也能发布。风险：上传默认不要令牌，
  解码先于任何检查，10 MiB 的"全 NULL 的 SEQUENCE"（524 万个节点）在 Node 上需约 3 GB 堆（峰值 RSS 3.2 GB，堆上限 ≤ 2 GB 时进程以
  heap out of memory 退出，整个服务停摆；本地 workerd 运行时同样崩溃重启），1 MiB 的同类输入需 384 MB、2 MiB 需 768 MB。修复前
  asn1js 的 1 万节点默认值意外挡住了它（代价是拒收真实的大 CRL）。待定（不在本次修复中决定）：建议把 `AIA_MAX_UPLOAD_BYTES` 默认值降到
  1 MiB（≈ 25 000 条目，最坏输入约 400 MB 堆），需要更大 CRL 的部署显式调高并设 `AIA_UPLOAD_TOKEN`；或保留 10 MiB 而要求 Node 部署设置令牌。

## 开工前需 owner 确认

2026-10-20 已确认：五项均取推荐默认（附录 C）。

1. SHA-1 签名的 CRL（`sha1WithRSAEncryption`、`ecdsa-with-SHA1`）：推荐接受（分发服务不是校验器，旧实现也接受）；否则 `unsupported_algorithm`。
2. 只含 `distributionPoint` 的关键 IDP（AD CS 的 CDP 选项 'Include in the IDP extension of issued CRLs'，夹具 `full-idp-dp-only`）：推荐接受
   （仍是该 DP 的完整 CRL，勾选后不至于整站停发）；任何 `onlyContains*`、`onlySomeReasons`、`indirectCRL` 仍 `scoped_crl_unsupported`。
   线上 CRL 目前没有 IDP。
3. 无 AKI 或 AKI 无 `keyIdentifier`（夹具 `full-no-aki`）：推荐 `issuer_not_found` + `details.reason = "missing_aki"`；备选 `invalid_crl`。
4. 多张证书共用 SKI（AD CS 同钥续期，夹具 `issuing-ca-1-renewed`）：推荐按目标配置的签发者验签，`applyConfig` 拒绝同 kind
   且签发者 SKI 相同的两个目标，上传不产生 `issuer_mismatch`（只留给切片 7 的历史导入）；备选：上传保留该码，用于"候选绑定了多个同 kind 目标"。
5. 外层与 TBS 内签名算法不一致：推荐 `invalid_crl`（RFC 5280 §5.1.1.2 要求相同）；备选沿用旧实现不比较。

其余（5 分钟边界取"恰好 5 分钟接受"、1 + 3 次重试、状态码表、同号更晚 `thisUpdate` 为 `updated`、两侧无号比 `thisUpdate`、
history 标记、blob 键带 CRL 号、不设 20 octet 上限）为规划默认值，可推翻，不阻塞开工。
