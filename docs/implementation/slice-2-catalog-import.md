# 切片 2：catalog/config 与导入

## 目标与范围

把旧实现的解析层迁入 `src/core/pki`，定下 `config.json` / `catalog.json` 的 schema 与规范格式，实现条件写重试、
`importCertificate`、`applyConfig`、三条管理路由与 CLI 的 import / config / health。

- 做：`src/core/pki/*`、`src/core/summary/catalog-summary.ts`（证书部分）、`src/core/catalog.ts`、`src/core/import.ts`、
  `src/core/admin.ts`（`validateConfig`、`applyConfig`）、`src/core/health.ts` 升级、`src/http/routes/admin.ts`、`src/cli/aia.ts`、
  `scripts/seed-dev.ts`、`docs/config.example.json`。
- 不做：ObjectStore 端口、适配器、一致性套件及 `src/worker/r2/{objects,listing}.ts`、`tests/helpers/r2.ts` 的迁移（切片 1，D5）；
  `publishCrl`、CRL 摘要与 `toDer` 的 CRL 用法（切片 4）；路径表解析与下载（切片 3）；retire / delete / history 与对应 CLI（切片 6）；
  summary builders（切片 5a）。
- 本切片处理：§10 #5（导入只有一个提交点、无伴随写与边缘缓存）、#11（证书部分；CRL 见切片 4）、#13、#14、#15（升级）、
  #23（import / config 部分）；C5（V6）、C8（证书部分）、C13（路径字符集部分）；M1（证书）、M4、M5、M7（证书）、M9（导入）、
  M17（路径部分；响应头见切片 3）、M21、M22（`derToPem` 原样保留，规格见切片 3）、M23。

## 前置

- 切片 1：`createApp(deps)`；`src/http/errors.ts`（`HTTPException` 重包信封并保留 `WWW-Authenticate`）；`settings.ts` 的
  `AIA_ADMIN_TOKEN(_FILE)`、`AIA_MAX_UPLOAD_BYTES`（Worker 端令牌可选，B6）；ObjectStore 与 memory / fs / r2；`src/core/digest.ts`
  的 `sha256Hex`；`src/core/health.ts`；`tests/fixtures/pki.ts`（`manifest`、`NOW`、`fixture()`）。
- 新依赖 `pkijs@3.4.1`、`asn1js@3.1.0`（`dependencies`）：已验证旧 PKI 用例在 Node 24 + vitest 5 全过、workerd 内可解析与验签。
- `tests/data/adcs.ts` 不入库（D7），其余用到它的解析用例见切片 5a。

## 步骤

1. **迁入 `src/core/pki`**（源 `worker-aia-cdp@5b570aa:src/worker/pki/`）：

   | 源 | 处置 | 新文件与改动 |
   | --- | --- | --- |
   | `asn1.ts` | 原样 + 一处 | `src/core/pki/asn1.ts`；`readStrictTime` 抛 `Asn1TimeError`（消息不变），`assertWellFormed` 对带 asn1js `error` 的 UTCTime / GeneralizedTime 也抛它（asn1js 对无秒 UTCTime 只置 `block.error`） |
   | `constants.ts`、`extensions.ts` | 原样 | `src/core/pki/` 同名 |
   | `parsers.ts` | 改 | 入参 `ArrayBuffer \| Uint8Array`（偏移视图按 `byteLength` 判尾随字节，修掉旧 `derBytes.buffer as ArrayBuffer`）；抛 `PkiParseError { kind, reason }`，`reason` ∈ `der` / `trailing_bytes` / `time` / `structure`（PKIjs 构造失败）；`getCRLAKIHex` 泛化为 `getAuthorityKeyIdHex(extensions)`；`getCommonName` 非字符串值返回 `undefined` |
   | `pem.ts` | 改 | 保留 `PEM_BLOCK_MARKERS`、`extractPEMBlock`、`derToPem`；删 `derBufferFromMaybePem`（按键后缀判格式）；新增 `toDer(bytes, kind)` 与 `splitPemBlocks(text, kind)` |
   | `utils/conversion.ts` | 改 | 拍平为 `src/core/pki/conversion.ts`；`toBufferSource` → `toDigestInput(): Uint8Array<ArrayBuffer>`；删 `toJSDate`（`assertWellFormed` 后 `pkijs.Time.value` 已是合法 `Date`）；删全部 `console.warn`；`sha256Hex` 删本地实现，改为 `export { sha256Hex } from "../digest.ts"`（core 只有切片 1 的一个实现），`sha1Hex` 留在这里 |
   | `pkijs.ts` | 删 | PKIjs 导入时已用 `globalThis.crypto` 装好 `webcrypto` 引擎；`setEngine` 在 worker 类型下 TS2345 |
   | `crls.ts` | 不迁 | 见切片 4 |

   `toDer` 规则（M7，§10 #13；格式一律按字节识别，内容类型只用于 415 闸）：首字节 `0x30` 且外层 TLV 长度恰等于字节数 → DER；
   否则 UTF-8 解码（容忍 BOM、前后说明文字），含 `-----BEGIN ` → PEM：标签必须是该 kind 的（证书 `CERTIFICATE`，CRL `X509 CRL`），
   否则 `pem_label`；完整块数 ≠ 1（缺 END 或多块）→ `pem_blocks`；base64 非法 → `pem_base64`；都不是 → 原样交严格解析
   （得到 `der` / `trailing_bytes`）。旧的"静默取第一块"取消（开工前需 owner 确认第 1 项，已确认）。
2. **导入说明符 codemod**（B3）：`perl -pi -e 's{(from\s+"\.{1,2}/[^"]+?)(?<!\.ts)"}{$1.ts"}g' src/core/pki/*.ts`，再把
   `./utils/conversion.ts` 改成 `./conversion.ts`；`tsc` 报 TS1484 的改 `import type`。5a 迁 builders 复用同一命令。
   核对：`grep -rnE 'from "\.\.?/' src/core | grep -v '\.ts"'` 无输出。
3. **`src/core/summary/catalog-summary.ts`**（源 `worker-aia-cdp@5b570aa:src/worker/r2/summary.ts:68-86`，只取字段推导；
   `ensureSummaryMetadata`、合并删除、`SUMMARY_VERSION` 不迁）：`buildCertificateSummary(cert, der)` → `{ subjectCN, issuerCN,
   serialNumber, notBefore, notAfter, subjectKeyId, authorityKeyId, sha1 }`，格式见步骤 4。SKI / AKI 扩展存在但畸形 →
   `invalid_certificate`（`reason: "extension_value"`；旧代码静默跳过，M5）。整份替换，不合并。`buildCrlSummary` 由切片 4 加到同一模块（摘要只有一个实现）。
4. **`src/core/catalog.ts`**：zod 4（导入与 `.meta({ id })` 见总则 §2.1），对象一律 `z.strictObject`（拼错键即失败）。
   规范格式（M4、M21；默认值，可推翻；plan §5.3 示例需同步）：

   | 字段 | 规范形式 |
   | --- | --- |
   | 证书 id（`certificates` 键、`issuer`、`verifier`、`sha256`）/ `sha1` | 小写 hex 64 / 40；大写即拒绝 |
   | `subjectKeyId`、`authorityKeyId` | 小写偶数位 hex 或 `null` |
   | `serialNumber` | 大写 hex，INTEGER 原始内容字节，保留前导 `00` |
   | `subjectCN`、`issuerCN` | RDN 顺序第一个 CN，或 `null` |
   | 时间 | `Date.toISOString()`（含 `.000Z`），`z.iso.datetime()`；比较按时刻 |
   | target id | `z.uuid()`（RFC 9562，拒 `00000000-…-0001`）且小写 |
   | `crlNumber`、`baseCrlNumber` | 十进制字符串或 `null`，比较用 BigInt（M15，见切片 4） |

   - `ConfigSchema` = plan §5.2 形状（`version: 1`、`certificates{label}`、`targets{issuer,kind,label}`、`paths{certificate}|{target}`；
     三个映射必填、可为空，切片 1 的最小配置因此合法）；`CatalogSchema` = plan §5.3 原样（无改绑账本，owner 确认第 2 项；
     严格对象，带 `certificatePaths` 键即无效）；`targets[*].current` 的字段按 plan §5.3 先定，CRL 摘要（`revokedCount` 非空、`nextPublish`）由切片 4 步骤 2 补全。
   - `readState(store)` → `{ config, configEtag, catalog, catalogEtag }`；`catalog.json` 缺失视为空 catalog（etag `null`）；
     存储内容非 JSON 或不合 schema 一律抛错（500 + 日志），从不覆盖。写出格式 `JSON.stringify(v, null, 2) + "\n"`，
     `contentType: "application/json"`。
   - `updateCatalog(store, mutate, { sleep, backoffMs: [250, 500, 1000] })`：`mutate(catalog)` 纯函数，返回
     `{ next, result }` 或 `{ result }`（终态，不写）；有 etag 用 `ifMatch`，否则 `ifNoneMatch: "*"`；`precondition-failed` →
     睡眠后重读、重跑 `mutate`；共 1 + 3 次尝试后返回 `concurrent_update`（plan §5.5"最多三次"取 1 + 3）。`put` 抛错不重试、直接上抛
     （R2 单键写速率错误不是前置条件失败，见风险）。
5. **`src/core/import.ts`**：`importCertificate({ store, now, sleep? }, bytes)`：`toDer` → `parseCertificate`（M1：单一顶层元素、
   无解码错误、RFC 5280 时间）→ `sha256Hex` 得 id → `buildCertificateSummary` → 读 catalog，已有该 id → `unchanged`，零写入 →
   `put blobs/certificates/<id>.der`（`ifNoneMatch: "*"`，`precondition-failed` 即同内容已在，视为成功）→ `updateCatalog`
   （mutate 内再查一次：已存在则 `unchanged`，否则加 `{ key, size, importedAt: now().toISOString(), summary }`）。
   返回 `{ outcome: "created" | "unchanged", id, entry }` 或 `{ error: "invalid_certificate" | "concurrent_update", details }`。
   任何拒绝零写入（M9）；blob 写后 catalog 失败只留无人引用的证书 blob，证书列表来自 catalog，不可见（C8 证书部分）。
   导入不授权：证书只有被 config 目标绑定后才是签发者（M23；切片 4 的 `target_not_configured`）。EdDSA 证书可导入。
6. **`src/core/admin.ts`**：`validateConfig` 分三层，全部违规一次返回（`config_invalid`，`details.issues[] = { path, rule, message }`）：

   | # | 规则 | 层 |
   | --- | --- | --- |
   | V1 | `ConfigSchema` 严格解析（格式见步骤 4） | 静态 |
   | V2 | 路径 = `^/(ca\|crl\|dcrl)(/段)+$`，段 = `[A-Za-z0-9._~-]+` 且不是 `.` / `..`；无 `%`、空段、结尾 `/`；区分大小写、精确匹配；不得以 `.pem` 结尾（PEM 变体自动派生）。字符集即规范形，"规范化后唯一"退化为键唯一（M17；线上 URL 全部符合） | 静态 |
   | V3 | `/ca/` → `{certificate}`，`/crl/` → full 目标，`/dcrl/` → delta 目标 | 静态 |
   | V4 | 路径引用的目标在 `targets` 内（静态）；路径、`targets[*].issuer`、`certificates` 的键都在 catalog 中（状态） | 静态 + 状态 |
   | V5 | 目标签发者 `subjectKeyId !== null` | 状态 |
   | V6 | 同一（签发者, kind）至多一个目标（静态）；SKI 相同的不同证书不得各有同 kind 目标（状态；M5、C5，同钥续期 `issuing-ca-1-renewed`） | 静态 + 状态 |
   | V7 | `/ca/` 路径在当前 config 与新 config 中都存在时，证书 id 必须相同（无账本，owner 确认第 2 项）。"先删再加"的两步改绑（一次 apply 删路径，之后的 apply 再加回并指向别的证书）不检测，由操作员负责：证书下载按 `immutable` 缓存一年，换 CA 证书用新路径 | 迁移 |
   | V8 | 新配置删掉的目标，其 `catalog.targets[id].current` 必须为空（retire 见切片 6） | 迁移 |
   | V9 | 当前 config 里已有的 target id 不得改 `issuer` 或 `kind`；换签发者或种类 = 新 UUID（默认值，可推翻）。这样一个目标的 current 与全部 history 标记都由同一张证书验证，切片 6 的删除保护（`config.targets[*].issuer`、`retired.last.verifier`）才覆盖历史，新鲜度也不会跨签发者比较 | 迁移 |

   V7、V9 需要当前 config：缺失、非 JSON 或不合 `ConfigSchema` 时跳过。V8 不依赖当前 config：catalog 中
   `current` 非空的目标须仍在新配置里，照查。V9 写回 plan §5.2（本切片同步）。
   `applyConfig(deps, body, { ifMatch? | ifNoneMatch? })` 只写 `config.json`（不调 `updateCatalog`、不写 catalog，owner 确认第 2 项）：
   读 `config.json`（宽松读取：原始字节与 store etag，能解析才用于 V7、V9）与 `catalog.json`（走会抛错的 `readState`）→ HTTP 前置条件
   比对 `sha256(存储字节)`（步骤 8），所以不合 schema 的现有 config（只有带外写坏才会出现）也能被带匹配 `If-Match` 的 PUT 替换，与 GET
   原样返回配套 → V1–V9（状态规则按开头读到的 catalog 判定）→ `put config.json`（`ifMatch` = 读到的 store ETag，首次
   `ifNoneMatch: "*"`），`precondition-failed` → `precondition_failed`，不重试。读 catalog 之后、写 config 之前的跨对象竞争（期间的
   发布、退役、删证书）不重查，接受该窗口，靠切片 6 手册"管理操作单人串行"。目标 UUID 由工具分配（CLI `new-target-id`、seed、
   切片 7 迁移脚本都用 `crypto.randomUUID()`），没有建目标接口。`JSON.parse` 对重复键取最后一个，无法检测。
7. **health 升级**（`src/core/health.ts`，B10）：store 改为 `get` config 与 catalog；configuration：缺失 → `missing`；
   非 JSON、`ConfigSchema` / `CatalogSchema` 不过、或静态 + 状态规则不过 → `invalid`；否则 `ok`。迁移规则（V7–V9）不参与。
   同步切片 1 的产物：`tests/core/health.test.ts`、`tests/http/health.test.ts` 的 `head` 抛错用例改为 `get` 抛错；`node-runtime.test.ts`、
   `scripts/node-smoke.sh`、`scripts/docker-smoke.sh` 写的最小配置在完整 schema 下仍为 `ok`，不改。
8. **管理路由 `src/http/routes/admin.ts`**，独立子应用挂到 `/api/v1`（切片 5a 步骤 8 只把公开路由的类型给 web）。
   `app.use("/api/v1/admin/*", …)` 依次：令牌未设置 → 503 `admin_disabled`；`bearerAuth({ token })`（常量时间）；`bodyLimit`
   （上限 `AIA_MAX_UPLOAD_BYTES`）；各状态见总则 §2.6（B9）。OpenAPI 用
   `app.openAPIRegistry.registerComponent("securitySchemes", "adminBearer", { type: "http", scheme: "bearer" })`，路由声明
   `security`。错误码表补 `invalid_certificate`、`config_invalid`、`precondition_failed`、`precondition_required`（428，新增，owner 确认第 4 项）、
   `concurrent_update`。

   | 路由 | 请求 | 状态 |
   | --- | --- | --- |
   | `POST /api/v1/admin/certificates` | 原始体 `application/pkix-cert` / `application/x-pem-file` / `application/octet-stream`，或 multipart 文件字段 `certificate`（字符串字段 400）；`body.required: false`；空体 400 | 201 created / 200 unchanged，体 `{ outcome, id, size, importedAt, summary }`；400 / 401 / 409 `concurrent_update` / 413 / 415 / 422 `invalid_certificate`（`details.reason`）/ 503 |
   | `GET /api/v1/admin/config` | — | 200 存储原文（不合 schema 也原样返回，便于修复）+ `ETag: "<sha256(存储字节)>"`；404；401 / 400 / 503 |
   | `PUT /api/v1/admin/config` | JSON；可用前置条件恰好一个：`If-Match: "<sha256>"`（单个强 ETag）或 `If-None-Match: *`。两者都缺、都有、`If-None-Match` 不是 `*` → 428；`If-Match` 不是单个带引号的存储字节 sha256（`W/`、列表、无引号、`*`、哈希不符）、无 config 时带 `If-Match`、已有 config 时带 `If-None-Match: *` → 412 | 200 + 新 `ETag`；400（含非 JSON）/ 401 / 412 `precondition_failed` / 422 `config_invalid` / 428 `precondition_required` / 503 |

   HTTP ETag 规则见总则 §2.6（B14）；`W/` 不匹配 → 412。`PUT` 用 `openapi(route, handler, hook)`
   的路由级钩子把 `json` 目标的校验失败映射为 422，其余目标走 `defaultHook` 400。每次导入尝试一行日志
   `{ level, msg: "import", certificateId, outcome | reason }`（plan §4.3）。
9. **CLI `src/cli/aia.ts`**：`node:util` `parseArgs`（`strict: true`）+ `fetch`，零依赖；导出 `main(argv, io)`，`io = { fetch, env,
   stdout, stderr, readFile }` 可注入；`tsconfig.build.json` 纳入 `src/cli`（产出 `dist/server/cli/aia.js`，镜像自带）；
   脚本 `aia` = `node src/cli/aia.ts`。全局：`--url` / `AIA_URL`，`--token-file` / `AIA_ADMIN_TOKEN_FILE` / `AIA_ADMIN_TOKEN`
   （读文件后 trim，从不回显），`--json`。退出码 0 成功 / 1 操作失败或不健康 / 2 用法错误。

   | 子命令 | 行为 |
   | --- | --- |
   | `import <file...>` | DER 原样发 `application/pkix-cert`；PEM 用 `splitPemBlocks` 拆块，每块单独发 `application/x-pem-file`（`aia import chain.pem` 导入全部）；逐文件逐块隔离失败，最后汇总 |
   | `config show` | GET，打印 JSON；`--json` 输出 `{ etag, config }`；404 → 1 |
   | `config validate <file>` | 本地跑 V1–V3、V4/V6 静态部分，不连服务、不要令牌；状态与迁移规则只能在 apply 时由服务端判定 |
   | `config apply <file>` | 先本地 validate → GET 取 ETag（404 则 `If-None-Match: *`）→ PUT；412 只报告不重试；422 逐条打印 `issues` |
   | `new-target-id` | 打印 `crypto.randomUUID()` |
   | `health` | GET `/api/v1/health`；healthy → 0，degraded / unhealthy / 不可达 → 1 |

   `publish`、`history`、`retire`、`delete-certificate` 见切片 4、6。
10. **开发与文档**：`scripts/seed-dev.ts`（重写 `worker-aia-cdp@5b570aa:scripts/seed-dev.sh`；走 CLI 的 `main`）：导入
    `certs/root-ca.der`、`issuing-ca-1.der`、`issuing-ca-2.der`，生成带新 UUID 的配置（`/ca/<name>.crt`、`/crl/<name>.crl`、
    `/dcrl/issuing-ca-{1,2}.crl`）；已有 config 则跳过 apply（幂等）；CRL 发布在切片 4 加。脚本 `seed:dev` = `node scripts/seed-dev.ts`，
    `reset:dev` = `rm -rf .wrangler/state .data`（`scripts/reset-dev.sh` 删）。`.dev.vars.example`：`AIA_ADMIN_TOKEN=dev-admin-token`
    （新建；切片 1 的 `.gitignore` 已为它留例外）。`docs/config.example.json` 取代 `docs/templates/resources.example.json`（参考，不迁）。
    旧 `src/worker/api/v2/{certificates,crls}/constants.ts`（R2 前缀与后缀判定）删除，无替代。

## 测试

取值规则见总则 §2.5；写入断言用本切片新建的 `tests/helpers/store.ts`（`recordingStore` 记写入序列，`flakyStore` 让前 n 次
`ifMatch` 失败或让 `put` 抛错）。

| 文件 | 来源（`worker-aia-cdp@5b570aa:`） | 要点 |
| --- | --- | --- |
| `tests/core/pki/asn1.test.ts` | `tests/worker/extension-parsers.test.ts:647`（改用合成 `crls/root-ca/full-01.der`，D7） | 非法 / 非规范时间：`parseCRL` 抛 `PkiParseError`（`reason: "time"`），`readStrictTime` 抛 `Asn1TimeError`；UTCTime 50 分界；`buildTBSCertList` 断言留 5a |
| `tests/core/pki/parsers.test.ts` | `tests/worker/pki-values.test.ts:149`、`:75` 与 `:55` 的解析器部分 | 尾随字节（`certs/root-ca.der` + `00`、`invalid/trailing-byte.der`）→ `trailing_bytes`；CRL 号 BigInt 精度、负数 / ENUMERATED / OCTET 拒绝；偏移视图输入；非字符串 CN；`getAuthorityKeyIdHex`；`pkijs.getEngine().name === "webcrypto"` |
| `tests/core/pki/pem.test.ts` | `tests/worker/pem.test.ts` 原样 + 新增 | `toDer` 矩阵：DER、PEM、BOM + 说明文字、CRLF（`full-01.crlf.pem`）、错误标签、两块、缺 END、坏 base64、以 `0` 开头的文本；`splitPemBlocks` |
| `tests/core/pki/conversion.test.ts` | `tests/worker/conversion.test.ts` | 序列号字面量改读 manifest；`sha256Hex` 只哈希视图字节 |
| `tests/core/summary.test.ts` | `tests/worker/r2-summary.test.ts` 用例 1 | 每张证书：序列号 = manifest `serial`、时间同刻且以 `.000Z` 结尾、`sha1` 40 位小写；`root-ca` 的 AKI 与 `leaf-min` 的 SKI / AKI 为 `null`；**跨切片锁定（M4）**：`issuing-ca-1` 的 `subjectKeyId` 与 `getAuthorityKeyIdHex` 从 `parseCRL(crls/issuing-ca-1/full-01.der)` 读出的值字符串全等；用例 2（CRL 摘要整份替换）见切片 4 测试（同名文件追加） |
| `tests/core/catalog.test.ts` | `r2-summary.test.ts` 用例 3 | 严格对象拒 `tagrets`、大写 hex、非 RFC 9562 UUID；空 catalog；`updateCatalog` 首写 `ifNoneMatch`、失败重读后对手写入保留、4 次后 `concurrent_update` 且睡眠序列 = `[250, 500, 1000]`、终态不写、`put` 抛错不重试 |
| `tests/core/import.test.ts` | `r2-summary.test.ts` 用例 1 后半 | DER created → 同证书 PEM unchanged 零写入；blob 键与字节；`invalid/garbage.txt`、`empty.bin`、CRL 当证书（`structure`）、CRL PEM（`pem_label`）、两证书 bundle（`pem_blocks`）、测试内改坏 `notBefore`（`time`）均零写入；并发导入同证书 → 一 created 一 unchanged；EdDSA CA 可导入；导入后无目标 |
| `tests/core/admin.test.ts` | `tests/worker/crl-upload.test.ts`"different issuers cannot share…"改写 | V1–V9 各一正一反（V5 用无 SKI 的 `leaf-min`，切片 1 步骤 9；V6 用 `issuing-ca-1` + `issuing-ca-1-renewed`；V7 直接改绑为反例，先删再加（两次 apply 都成功）为正例，记录已接受的缺口；V8 往 catalog 预置 `current`；V9 同一 UUID 改 `issuer`、改 `kind` 各一反例，只改 `label` 为正例；当前 config 缺失或不合 schema 时 V7、V9 跳过）；违规全量返回；`applyConfig` 只写 `config.json`（无 catalog 写） |
| `tests/http/admin.test.ts` | 新 | 上表每个状态；`PUT` 无前置条件头、两者都有、`If-None-Match` 不是 `*` → 428 `precondition_required`，`W/`、列表、无引号、`If-Match: *`、无 config 时 `If-Match`、已有 config 时 `If-None-Match: *` → 412；令牌未设置时超限体也是 503；畸形 `Authorization` 400；`DELETE …/admin/config` 带有效令牌 → 405 + `Allow`（无令牌是 401：`bearerAuth` 先抛错，`methodNotAllowed` 只改写无错误的 404）；`no-store`；包一层返回不透明 etag 的 store，证明 HTTP `ETag` 是 sha256；直接往 store 写入不合 schema 的 `config.json` → GET 200 原文 → 带匹配 `If-Match` 的 PUT → 200；日志行无令牌 |
| `tests/http/health.test.ts`（切片 1 文件） | — | 拼错键 / 引用缺失 → `invalid`；apply 后 `healthy` |
| `tests/integration/cli.test.ts` | 新 | `main` 注入 `fetch = app.request`；各子命令输出与退出码；`config validate docs/config.example.json` 离线通过 |
| `tests/integration/node-e2e.test.ts` | 新（切片 3、4 续写） | 子进程起 `node src/runtime/node.ts`（临时 `AIA_DATA_DIR`、空闲端口、`AIA_ADMIN_TOKEN_FILE`）+ CLI 子进程：import ×3 → config apply → health healthy → 重启后 ETag 不变、重复 import 全 unchanged |

## 出口条件

1. `pnpm run ci:check`（见总则 §1.3）。
2. `pnpm run ci:test` 含上表全部文件。
3. `grep -rnE 'BufferSource|toJSDate|setEngine|derBufferFromMaybePem|console\.' src/core` 无输出；步骤 2 的说明符核对无输出。
4. `tests/integration/node-e2e.test.ts` 绿（CLI 在 fs 上导入并应用配置）。
5. 本地 R2：`cp .dev.vars.example .dev.vars && pnpm exec wrangler dev --ip 127.0.0.1 --port 8787`（需已有 `dist/web`）后 `AIA_URL=http://127.0.0.1:8787 AIA_ADMIN_TOKEN=dev-admin-token pnpm seed:dev`
   成功，`pnpm aia health` 退出 0，再跑一次 `seed:dev` 全部 unchanged；结果写进合并提交说明。
6. `pnpm run ci:docker` 增加：`docker cp` 夹具证书进容器，`docker exec … node dist/server/cli/aia.js import …` 与 `config apply …`
   后 `/api/v1/health` 为 `healthy`（证明镜像带 CLI）。
7. `node src/cli/aia.ts config validate docs/config.example.json` 在无 `AIA_URL`、无网络时退出 0。

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| key id 大小写跨切片不一致，切片 4 静默 `issuer_not_found`（M4） | schema regex 拒大写；`summary.test.ts` 锁定 SKI 与 CRL AKI 全等 |
| config 与 catalog 分别读写，跨对象竞争 | `applyConfig` 只条件写 `config.json`，状态规则按开头读到的 catalog 判定、不重查；读 catalog 后的发布、退役、删证书窗口接受，靠切片 6 手册"管理操作单人串行"；发布与删目标、删证书与 apply 的竞争见切片 4、6；读取方忽略 config 中已不存在的 target 条目 |
| R2 单键写速率错误不是 `precondition-failed`，重试循环把它变成 500；miniflare 不模拟 | 本切片不重试抛错的 `put`（不知是否已生效）；应对见切片 4 风险与对策（助手 `-UploadIntervalMs`） |
| 删 `toJSDate` 后 5a 的 `buildTime` 无法原样迁入 | 5a 改收 `pkijs.Time`（见切片 5a）；本切片不迁 builders |
| zod-openapi 媒体闸、`body.required`、路由钩子行为偏离预期 | `tests/http/admin.test.ts` 逐状态断言 415 / 400 / 422 |
| 本地 R2 冒烟（`wrangler dev` + `seed:dev`）不在 CI 里 | 出口 5 手动执行并记录；r2 一致性套件（`AIA_TEST_R2=1`）由 `ci:worker` 覆盖 |
| `config validate` 离线查不了 catalog 相关规则 | 文档写明服务端为准；apply 返回全部 `issues` |

## 开工前需 owner 确认

1. 多块 PEM：已确认（2026-10-19），API 拒绝（`pem_blocks`）、CLI 拆块逐个导入（推荐项）。
2. 改绑账本 `catalog.certificatePaths`（plan §5.3 新增字段，只增不减）：已确认（2026-10-19），不采用，取备选：V7 只比对当前配置，
   放过"先删再加"，由操作员负责；catalog 无此字段，`applyConfig` 只写 `config.json`（步骤 4、6）。
3. V6 状态部分（SKI 相同的证书不得各有同 kind 目标）：已确认（2026-10-19），拒绝（推荐项）；若切片 4 开工前需 owner 确认第 4 项
   （多证书共享 SKI 时选哪个签发者）改为"优先已配置的签发者"，V6 可再放宽。
4. `PUT` 缺前置条件头：已确认（2026-10-19），428 `precondition_required`，取备选（新增错误码；规则见步骤 8）。
