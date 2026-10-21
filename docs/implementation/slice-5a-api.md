# 切片 5a：API 与客户端

## 目标与范围

公开只读路由 `GET /api/v1/certificates`、`/certificates/{id}`、`/crls`、`/crls/{targetId}`、`/stats`（plan §7.1）及其 schema；
`worker-aia-cdp@5b570aa` 的四个详情构建器与 X.509 投影 schema 迁入 `src/core/summary/`；OpenAPI 文档补全、lint 与体积预算；
`hc<AppType>` 类型出口与网页客户端的错误处理（`src/web/client/`）。分支 `slice/5a-api`。

不在本切片：`src/core/pki` 解析层与目录摘要（切片 2）；下载与路径反查（切片 3）；`POST /api/v1/crls`（切片 4）；
history / retire / delete（切片 6）；页面、vue-query、扩展渲染块（切片 5b）。

§10 归属：#7、#8、#9、#10、#16、#17、#27、#28 与 #2 的"详情接受归档 id"在本切片；#4 服务端见切片 4、文案见切片 5b；#18 见切片 5b。

## 前置

- 切片 1：`createApp`、`errors.ts`（`defaultHook`、`onError`、`methodNotAllowed`、`no-store`）、ObjectStore / `MemoryStore`、
  运行时 `GET /api/v1/openapi.json` 与 `scripts/generate-openapi.ts --check`；`tests/fixtures/pki.ts` 的 `manifest` / `NOW` / `fixture()`
  （断言规则见总则 §2.5）。
- 切片 2：`src/core/catalog.ts` 的 config / catalog schema 与读取、`src/core/pki/*`、证书摘要、`importCertificate` / `applyConfig`。
- 切片 3：`src/core/resources.ts` 的路径反查。
- 切片 4：`publishCrl`、catalog `current.summary`（总含 `nextPublish`，切片 4 步骤 2）、`src/core/pki/asn1.ts` 的 `formatGeneralizedTime`。

## 步骤

1. **X.509 schema 入 core。** `src/core/summary/schemas.ts` ← `worker-aia-cdp@5b570aa:src/contracts/schemas.ts` L12–497、L542–556、L578–604；
   `src/core/summary/types.ts` ← L768–866 中指向这些范围的 77 个类型导出，名字不变（构建器只改导入路径）。`CrlTypeSchema`（L510）不搬，
   `kind` 用切片 2 `catalog.ts` 的定义；L502–508、516–540、558–572、606–668、674–762（v2 信封、存储、分页、查询）不搬。改动：
   - 删 `UnknownExtensionValueSchema`（L433，联合成员 L476）：没有解析器产出它（§10 #8 死变体）；
   - 必填化总会产出的字段：`SubjectPublicKeyInfo.parsed`（L170）、`TBSCertList.version`（L597）、`ECPublicKey.point.x/y`；
     v1 详情包装（步骤 6）里 `signatureAlgorithm` / `signatureValue` 必填（`include=` 已删，§10 #8、#28）；
   - `RevokedCertificatesSchema`（L589–594）改为 `{ count, items }`，在 `TBSCertList` 中必填；
   - 抽出具名 `DistributionPointNameSchema`（id `DistributionPointName`），`DistributionPoint` 与 IDP 共用（派生 schema 不继承 id）；
   - 在定义处挂 `.meta({ id })`：`Name`、`Time`、`GeneralName`、`DistributionPoint`、`AlgorithmIdentifier`、`SignatureValue`、
     `SubjectPublicKeyInfo`、`Extension`、`Extensions`、`TBSCertificate`、`TBSCertList`、`RevokedCertificate` 与 41 个 `*Value`
     （全部成员有 id 才生成 `discriminator.mapping`）；`types.ts` 另导出 `type ExtensionType = ParsedExtensionValue["extensionType"]`。
   `Asn1LineSchema` 与 `src/core/pki/asn1.ts` 的 `Asn1Line` 保持结构一致；zod 用法见总则 §2.1。

2. **zod 3 → 4 清单**（原文件在 zod 4.6.7 下 `tsc --strict` 与运行时检查全过；下表是要改或要守的点）：

   | # | 旧写法（`src/contracts/schemas.ts`） | v1 处理 |
   | --- | --- | --- |
   | 1 | 全文件 `import { z } from "zod"` | core 保持；http 从 `@hono/zod-openapi` 取 `z` / `createRoute`；`.openapi()` 只在 http 用（它在导入时才打补丁） |
   | 2 | `.describe()`（`:56`、`:70-72`、`:100`、`:121-122`、`:191-192`、`:489`） | 照常进 OpenAPI `description`，可并入 `.meta()` |
   | 3 | `.extend()` / `.shape.distributionPoint`（`:33`、`:297`） | 派生实例不继承 id → 内联；需要复用的抽成具名 schema |
   | 4 | `z.discriminatedUnion`（`:35-39`、`:42-53`、`:155-160`、`:434-477`） | 可用；失败 issue 由 `invalid_union_discriminator` 变为 `invalid_union`（note "No matching discriminator"），断言 issue 码的测试要改 |
   | 5 | `z.record(z.string(), …)`（`:686`、`:693-699`、`:719`） | 随 v2 包装删除；新 schema 不用 `z.record(z.enum())`（zod 4 下穷尽），用 `z.object` / `z.partialRecord` |
   | 6 | 无字符串格式 | 新字段：`z.uuid()`（严格 RFC 9562，与 config 同一校验器）、`z.iso.datetime()`、id `z.string().regex(/^[0-9a-fA-F]{64}$/).toLowerCase()`（先校验后规范化，文档的 `pattern` 才是输入的形状）；正则不带 flag（`/i` 会漏进 `pattern`） |
   | 7 | `ZodError.flatten()`（`certificates/list.ts:26`、`crls/list.ts:25`、`crls/detail.ts:40`） | 随旧路由删除；`defaultHook` 输出 `details.issues`（切片 1 步骤 4） |
   | 8 | `z.coerce.number()` 查询 schema（`:742-762`）、`createApiResponseSchema<T extends z.ZodTypeAny>`（`:730-736`） | 删：v1 无查询参数、无信封 |
   | 9 | `z.unknown()` 键 | zod 4 类型层面必填，新字段一律 `.optional()` |
   | 10 | `z.custom<File>`（`api.ts:101`） | 生成器不能表示；上传 body 的 `z.file().openapi({ type: "string", format: "binary" })` 见切片 4，5a 只要求全部路由能生成文档 |

3. **构建器迁入**（导入一次改完：相对路径、`.ts` 后缀、`import type`、无别名，B3）：

   | 旧（`worker-aia-cdp@5b570aa:`） | 新 | 改动 |
   | --- | --- | --- |
   | `src/worker/api/v2/builders/primitives.ts` | `src/core/summary/primitives.ts` | `../../../pki/constants` → `../pki/constants.ts`，`../../../pki/utils/conversion` → `../pki/conversion.ts`，`@contracts/types` → `./types.ts`；切片 2 未迁 `toJSDate` → `buildTime` 改收 `pkijs.Time`，读 `.value` / `.type`；`buildFingerprints(der)` 收 `Uint8Array`（经切片 2 的 `toDigestInput()`）；`formatGeneralizedTime` 改从 `src/core/pki/asn1.ts`（切片 4）导入，不留副本；评审修复：RSASSA-PSS 的 `saltLength` / `trailerField` 按内容字节读（同上） |
   | `src/worker/api/v2/builders/extensions.ts` | `src/core/summary/extensions.ts` | 改导入（`../../../pki/{constants,extensions,asn1}`、`utils/conversion`）；`:182-184` `buildTime({ type: 1, value: date })` → `new pkijs.Time({ type: 1, value: date })`；`noUncheckedIndexedAccess` 小修（`?? 0`、`bitFlags` 循环）与 `isBlock` 守卫，行为不变（附录 A）；评审修复：INTEGER / ENUMERATED 按内容字节读（asn1js 的 `valueDec` 从 4 个内容字节起为 0，PKIjs 的数值字段照抄它），超出 `Number.MAX_SAFE_INTEGER` → `parseStatus: "error"`；SCT 列表须每条完整解出（数值版本、32 字节 logID、签名），否则 `error`；41 个 `extensionType` 字面量与字段名一字不改（与 5b `ExtensionView` 的契约） |
   | `src/worker/api/v2/builders/certificate.ts` | `src/core/summary/certificate.ts` | 改导入；删 `options.extensions`（`:17`、`:35`） |
   | `src/worker/api/v2/builders/crl.ts` | `src/core/summary/crl.ts` | 改导入；删 `revocationsLimit` / `revocationsCursor` / `hasMore` / `nextCursor` 与 `options`（`:13-49`，默认每页 10 条），总是返回全部条目 `{ count, items }`；删 `determineCrlType`（`:86-89`，只看存在与否，M6），类型来自 config |

   `@contracts/*` 别名不进任何 tsconfig / vite 配置。详情扩展里的键标识仍是大写 hex（`extensions.ts:536`、`:715`，显示用）；
   目录摘要与 id 是小写（M4，切片 2），跨接口比较只用摘要字段。

4. **DN 标签**（默认值，可推翻）：`src/core/pki/constants.ts` 的 `OID_DICTIONARY` 删去 `2.5.4.12/13/15/17` 的 `short`
   （`T`、`DESCRIPTION`、`BUSINESS`、`POSTAL`，旧 `constants.ts:11-15`），标签回落到 `title`、`description`、`businessCategory`、`postalCode`，
   与 `Name.rfc4514` 的 "OpenSSL attribute names" 一致；线上 CA 的 DN 只有 CN / O / C，不受影响。

5. **读模型** `src/core/views.ts`（新，纯函数，入参 config + catalog，详情另加 blob 字节）。每请求经 `src/core/catalog.ts` 各 `get` 一次
   config 与 catalog（plan §5.6），详情再读一个 blob；统计不调 `list`。config 缺失 → 证书只来自 catalog、目标为空。

   | 字段 | 定义（默认值，可推翻） |
   | --- | --- |
   | 列表顺序 | 证书按 id、目标按 `targetId` 字典序；UI 自行排序 |
   | `label` | config 里的 `label`，未配置为 `null` |
   | 证书列表项 | `id`、`label`、`importedAt`、`size`、`summary`（切片 2 的证书摘要原样，CN / SKI / AKI 可空，M21）、`downloads`、`targets` |
   | `downloads` | 切片 3 的同一路径反查：路径字典序，每条 DER 路径后紧跟 `<path>.pem`；绝不出现 `blobs/` 或历史（§10 #2） |
   | 证书 `targets` | `config.targets` 中 `issuer` 等于该证书的 `{ targetId, kind, label }`（§10 #10） |
   | 证书详情 | 列表项全部字段 + `fingerprints`、`tbsCertificate`、`signatureAlgorithm`、`signatureValue`，每次全量构建（§10 #28） |
   | CRL 列表项 | `targetId`、`kind`（config）、`label`、`issuer: { id, label, subjectCN }`（§10 #10）、`downloads`、`current`（`{ sha256, size, publishedAt, summary }`，`summary` 为切片 4 的 CRL 摘要（含 `nextPublish`）；或 `null`） |
   | CRL 详情 | 列表项字段；`current` 为 `null`（未发布或已 retire，200）或 `{ sha256, size, publishedAt, verifier, summary, fingerprints, tbsCertList, signatureAlgorithm, signatureValue }` |
   | `revokedCount` | 非空整数（发布时解析得出）；"未知"只以 `current: null` 出现，UI 显示"未发布"（§10 #7） |
   | `revokedCertificates` | 必填，返回全部条目；空 CRL 为 `{ count: 0, items: [] }` |
   | stats | `{ certificates, targets: { full, delta }, published: { full, delta }, totalRevocations, derBytes }`（§10 #16）；不含时间相关字段（plan §7.1；末节 owner 项） |
   | `totalRevocations` | 已发布 **full** CRL 的 `revokedCount` 之和（delta 条目会在下一张 full 重现，不计）；没有已发布 full CRL 时 `null` |
   | `derBytes` | catalog 证书 `size` + config 中各目标的 `current` CRL `size`；历史 blob 不计（要 `list`，属管理接口）；config 已删目标留在 catalog 的 `current` 不是资源，不计也不列 |

   失败语义：catalog 有条目但 blob 缺失、SHA-256 与 catalog 不符（解析前先比）或解析失败，以及 config 目标的签发者证书不在 catalog（CRL 列表、
   详情与 stats 一样：计数不描述列表拒绝显示的状态）→
   `ReadInconsistencyError`，500 `internal` + 一行 `read_inconsistent` 日志（`reason`、id、store 键；导入 / 发布时已校验过）；
   config.json / catalog.json 无效或 store 抛错 → 500，绝不是 200 空列表（§10 #9）。

6. **HTTP schema** `src/http/schemas.ts`：`CertificateListItem`、`CertificateDetail`、`CrlTargetListItem`、`CrlTargetDetail`、`Stats`（`.openapi("<名>")`，
   组合 core schema）；参数 `CertificateIdParam`（`z.string().regex(/^[0-9a-fA-F]{64}$/).toLowerCase()`：
   大小写都收、规范化为小写；先校验后转换，生成的 `pattern` 是输入的形状 `^[0-9a-fA-F]{64}$`）与 `TargetIdParam`
   （`z.string().toLowerCase().check(z.uuid())`：与 config 同一个 `z.uuid()` 校验器，RFC 9562 §4 输入不区分大小写，规范化同证书 id；
   先转小写再校验，因为 zod 的 UUID 正则只收小写的 Max UUID；文档为 `format: uuid`；`tests/http/openapi.test.ts` 断言两个参数的文档形状）；
   错误体沿用切片 1 的按状态码 schema（400 `bad_request`、404 `not_found`、500 `internal`）。可空的 `current` 写成
   `z.union([schema, z.null()])`：生成器把具名 schema 的 `.nullable()` 输出成裸 `$ref`、丢掉 `null`。

7. **路由**：`src/http/routes/certificates.ts`、`stats.ts`（新），`src/http/routes/crls.ts`（切片 4 已有 POST，追加两条 GET）。每条
   `createRoute` 写 `operationId`（`listCertificates`、`getCertificate`、`listCrlTargets`、`getCrlTarget`、`getStats`）、`summary`、`tags`，
   措辞参考 `worker-aia-cdp@5b570aa:src/contracts/api.ts`（响应字段对照 `worker-aia-cdp@5b570aa:docs/templates/api-responses.example.json`，仅参考 v2 形状）；
   只声明实际可能出现的 200 / 400 / 404 / 500（500 由 `onError` 产出）；所有响应 `Cache-Control: no-store`（§10 #17）；HEAD 走自动 HEAD。
   `security` 若写成元素形状不同的数组（如上传路由的 `[{}, { uploadBearer: [] }]`），须显式标成 `Record<string, string[]>[]`：推断出的
   联合类型让 `createRoute` 退回约束类型、丢掉路由的字面量类型（`AppType` 随之变宽，切片 4 的 `crls.ts` 已这样写）。
   旧 `worker-aia-cdp@5b570aa:src/worker/api/v2/{certificates,crls}/{list,detail}.ts` 与 `stats.ts` 只作语义参考：
   `search`、分页、`include=`、`storage`、`relationships: {}`、`ctx.waitUntil` 回填全部不迁。

8. **AppType**：`createApp` 的返回链只串公开路由（health、certificates、crls、stats），管理路由用独立语句 `app.route(...)` 注册——运行时与
   OpenAPI 文档都包含它们，`AppType` 不含（默认值，可推翻；CLI 不用 `hc`）。

9. **OpenAPI**：`scripts/generate-openapi.ts`（切片 1）不改机制，重新生成并提交 `docs/openapi.json`；脚本另打印 `getOpenAPI31Document`
   的耗时（出口 9）。原 `redocly.yaml` 的 `operation-operationId`、`operation-summary`、`no-unused-components` 改为
   `tests/http/openapi.test.ts` 里的断言；管理路由缺 `security` 声明时在此补上。每个操作带 `tags`，文档顶层声明 `health`、`certificates`、
   `crls`、`stats`、`admin`（`OPENAPI_CONFIG`）。

10. **网页客户端** `src/web/client/`（B20；迁移表里的 `src/web/api/*` 一律落到这里）：
    - `errors.ts` ← `worker-aia-cdp@5b570aa:src/web/api/response.ts`（重写）：`ApiError { code, message, status, details? }`（字段显式声明，
      `erasableSyntaxOnly`；构造参数顺序 `(status, code, message, details?, options?)` 与服务端 `src/http/errors.ts` 的 `ApiError` 相同）；
      `code` 类型是 `string`：服务端更新后出现的未知码原样保留（5b 显示 `errors.unknown` 与原始 code）。运行时不带 zod。
      - `unwrap(res)`：2xx → JSON 体（类型取 hc 联合里 `ok: true` 成员的体，不做运行时校验）；否则解析 v1 信封抛 `ApiError`（信封的
        `code`、`message`、`details`，`status` 为 HTTP 状态）；体不是 JSON（代理的 HTML 页、空体，2xx 也算）或非 2xx 的 JSON 不是信封 →
        `invalid_response`（`status` 为 HTTP 状态）。
      - `network`（`status: 0`，同 `Response.error()`）：由 `apiFetch` 产出——它是 `api` 的 `fetch` 选项，调用时取全局 `fetch`，拒绝即换成
        `ApiError("network")`（`cause` 为原错误）；`unwrap` 读体失败同样是 `network`。所以经 `api` 的请求拿不到响应时总是 `ApiError`，
        不论调用方是否 `unwrap`（5b 的写法 `unwrap(await api…$get(…))` 不必再包 try）。中止（signal 已 abort 或 `AbortError`）原样抛出：
        vue-query 取消查询不是失败。
    - `types.ts`：`export type *` 再导出 `src/core/summary/types.ts` 的全部纯类型（`Name`、`GeneralName`、`Extension`、`Extensions`、
      `DistributionPoint`、`Asn1Line`、`AlgorithmIdentifier`、41 个 `*Value`、`ExtensionType` …）+ `InferResponseType` 别名：
      `CertificateList` / `CertificateListItem`、`CertificateDetail`、`CrlTargetList` / `CrlTargetListItem`、`CrlTargetDetail`、`Stats`
      （五条读路由的 200 体）与 `PublishedCrl`（上传的 200 / 201 体）。
    - `error-codes.ts`：`ERROR_CODES`（全部 v1 错误码的运行时数组，字面量，供 5b 的 i18n 测试遍历；web 不得在运行时导入 `src/http`，
      切片 5b 步骤 11）与 `CLIENT_ERROR_CODES`（`network`、`invalid_response`）；`tests/web/client.typetest.ts` 断言其元素类型与
      服务端的 `(typeof ERROR_CODES)[number]`（`import type` 自 `src/http/schemas.ts`）双向相等、两个数组长度相同（无重复）。
    - 保留切片 1 的 `hc<AppType>("", { init: { cache: "no-store" } })`，加 `fetch: apiFetch`；每请求的 `init`（如 vue-query 的 `signal`）
      与它合并，不替换 `cache`。`worker-aia-cdp@5b570aa:src/web/api/client.ts` 的分页、`include`、`encodeURIComponent(id)` 与
      `pagination.ts` 不迁。
11. **测量**：填出口条件 9 的测量表（plan §5.6 备忘保持默认关；R2 真实延迟要有部署环境，见切片 7 步骤 8 演练 B）。大 CRL 的结论写进
    `docs/operations.md` 的"容量"一节（切片 6 步骤 11 并入完整手册）。

## 测试

| 文件 | 来源（`worker-aia-cdp@5b570aa:`） | 内容 |
| --- | --- | --- |
| `tests/core/summary/extension-parsers.test.ts` | `tests/worker/extension-parsers.test.ts`（17 条） | 11 条不依赖 `adcs.ts` 的原样迁；用 `adcs.ts` 的 6 条（L54、L87、L106、L151、L647、L683）改用合成夹具：`certs/issuing-ca-1`（CA Version、模板名 `SubCA`、PrintableString DN、NULL 参数）、`certs/root-ca`（P-384 参数、ECDSA r/s）、`crls/issuing-ca-1/full-adcs`（Next CRL Publish、Freshest CRL、CRL Self CDP 及顺序）、`crls/issuing-ca-1/delta-adcs`（关键 delta 指示，base 取 `manifest`）、`certs/issuing-ca-2`（critical 计数）；L647 严格时间已在切片 2，此处只留 `buildTBSCertList` 的 `raw` 断言 |
| `tests/core/summary/values.test.ts` | `tests/worker/pki-values.test.ts` L28、L96、L111、L124、L181、L202，L55 / L75 的构建器部分（解析器部分在切片 2） | 旧根 RSA-2048、新根 EC P-384：L124 的 RSA 位数改读 `certs/issuing-ca-1`，L181 的算法断言随夹具改；L224 随构建器选项删除；L55 AKI 的 `keyIdentifier` / `authorityCertSerialNumber`（hex）/ `authorityCertIssuer`，L75 CRL Number / Delta CRL Indicator 2^100+123 → `parsed`，−1 / ENUMERATED / OCTET STRING → `error`；≥ 4 内容字节的 INTEGER / ENUMERATED（asn1js 的 `valueDec` 在此为 0）：转储与数值字段按内容读，超出 `Number.MAX_SAFE_INTEGER` → `error`（评审修复） |
| `tests/core/summary/extensions-structure.test.ts` | `tests/worker/extensions-structure.test.ts` | 路径改 `certs/leaf-full.der`、`certs/root-ca.pem`；删 `Buffer` 辅助 |
| `tests/core/summary/schemas.test.ts` | `tests/web/api-client.test.ts` 用例 (1)（放 core：类型在 core，core 不依赖 http） | 判别字段；schema 字面量集合 = 构建器集合 = 41；`unknown` 变体不存在；组件 id 唯一 |
| `tests/core/summary/revocations.test.ts`（新） | — | 把夹具 CRL 的条目复制到 11 条与 10 000 条后重编码（旧 L647 的 `toSchema(true)` 手法；详情不验签）：`count === items.length`；10 000 条只记录耗时 |
| `tests/core/summary/extension-parsers.test.ts` 追加 | 补旧测试缺口 | cRLReason / invalidityDate / holdInstructionCode 成功路径（合成夹具已有 keyCompromise、superseded、certificateHold）；EKU 成功路径；QC Statements、SCT List、Subject Directory Attributes 在测试内构造扩展值；截断或畸形的 SCT 列表（评审探针 `04 04 00 02 09 09`、空 SCT、未知版本、空签名）→ `error` + 转储 |
| `tests/core/views.test.ts`（新） | `tests/worker/api-stats.test.ts` 的意图 | 步骤 5 表逐行；`current.summary.nextPublish` 对 `crls/issuing-ca-1/full-adcs.der` 非空、对不带该扩展的 `full-01.der` 为 `null` |
| `tests/http/certificates.test.ts` | `tests/worker/api-routing.test.ts` 用例 (3) | 列表 / 详情字段、`targets`；大写 id 规范化；非 hex、嵌套（`%2F`）、`crl/archive/…` 形 id → 400（字面多段路径不是该路由：JSON 404）；未知 hex → 404；blob 缺失 → 500 不泄漏；200/400/404/500 均 `no-store`；HEAD 200 空体 |
| `tests/http/crl-targets.test.ts`（新） | — | 经 `importCertificate` / `applyConfig` / `publishCrl` 写 MemoryStore；未发布 → 列表与详情 `current: null`；非 uuid → 400、未知 → 404；`revokedCertificates.count === summary.revokedCount`；另把 `revocations.test.ts` 的 11 条重编码字节直接写成 blob + catalog 条目（详情不验签），断言全部返回 |
| `tests/http/lists.test.ts` | `tests/worker/api-pagination.test.ts` 的不变量 | 每个 catalog 证书 / config 目标恰好一项；`downloads` 不含 `blobs/` 与历史；store `get` 抛错 → 500 信封，不是 `200 []` |
| `tests/http/stats.test.ts` | `tests/worker/api-stats.test.ts` | 计数来自 config + catalog；`derBytes` = 夹具文件字节数之和；`totalRevocations` 只计 full、无已发布 full 时 `null`；store `list` 未被调用；目标的签发者不在 catalog → 500（与 `/crls` 一致） |
| `tests/http/openapi.test.ts` | 扩展切片 1 的同名文件；替代 `redocly.yaml` | 在切片 1 的断言上加：每个操作有唯一 `operationId`、`summary`、文档已声明的 `tags`；`/api/v1/admin/*` 有 `security`；无未引用组件、`$ref` 全可解析；体积 ≤ 100 000 字节（默认值，按运行时发出的紧凑 JSON 计；提交的 `docs/openapi.json` 缩进 2 格，约其 2.3 倍）；读路由的状态码；`extensionType` 判别的 41 项 `mapping` |
| `tests/http/routes.typetest.ts`、`tests/web/client.typetest.ts`（新） | — | 错形状、未声明状态码是编译错误；`hc` 按状态码与 `extensionType` 收窄，`@ts-expect-error` 在 `hc<any>` 下会失效，证明不是 `any`；`src/web/client/error-codes.ts` 与 `ERROR_CODES` 双向相等、长度相同；`unwrap` 对五条读路由与上传的结果类型等于 `types.ts` 的别名、不含错误体（步骤 10） |
| `tests/web/api-errors.test.ts` | `tests/web/state.test.ts` 用例 (3) | `unwrap`：v1 错误体 → `ApiError(code, status)`（含 `details`、未知码原样）；HTML / 空体 / 非信封 JSON / 2xx 的 HTML → `invalid_response`；`fetch` 抛错 → `network`（`status: 0`，`cause`），中止原样抛出；经 `hc` 的 `fetch` 选项断言 `init.cache === "no-store"`，每请求的 `init.signal` 与之合并 |
| `tests/http/client.test.ts` | 切片 1 / 4 已建 | 追加：`unwrap` 处理应用真实发出的 200 体、404 `not_found` 与 400 `bad_request` 信封 |
| `tests/integration/node-e2e.test.ts` | 切片 4 已建 | 追加真实 socket 上的 list / detail / stats 与 HEAD |
| `scripts/worker-smoke.ts`（`ci:worker`） | 切片 3 / 4 已建 | 追加读取段：在 workerd 上读两份列表、大写 id 的证书详情（ECDSA `(r, s)`）、`issuing-ca-1` 目标详情的全部条目、stats 与各自 HEAD，均 200 + `no-store`（PKIjs 与 WebCrypto SHA-1 / SHA-256 指纹在 workerd 上跑） |

HTTP 用例照总则 §2.5，需要类型化 body 时用 `hono/testing` 的 `testClient`。ECDSA 签名随机：r / s 断言 `≤ 96` hex 且不以 `00` 开头，
不断言等长；CRL / 签名大小不断言字面量（B16）。

## 出口条件

1. `pnpm run ci:check` 通过（含本切片两个 typetest 与 `node scripts/generate-openapi.ts --check`）。
2. 测试表全部用例在 `pnpm run ci:test` 中通过（`pnpm exec vitest run --project core --project http --project web --project integration`）。
3. `node scripts/generate-openapi.ts && git diff --exit-code docs/openapi.json` 无差异。
4. `diff <(grep -o 'extensionType: z.literal("[A-Za-z]*")' src/core/summary/schemas.ts | grep -o '"[A-Za-z]*"' | sort -u) <(grep -o 'extensionType: "[A-Za-z]*"' src/core/summary/extensions.ts | grep -o '"[A-Za-z]*"' | sort -u)`
   无输出，且两侧各 41 行。
5. `grep -rnE "revocationsLimit|hasMore|nextCursor|determineCrlType|toJSDate|@contracts" src tests` 无输出。
6. `pnpm run build && ! grep -rlE "getOpenAPI31Document|OpenAPIHono" dist/web`：网页包里没有服务端代码。
7. `pnpm why zod` 只出现一个版本（`.meta({ id })` 依赖全树一份 zod）。
8. （见总则 §1.3）
9. 下表"5a 实测"列填满，判定列无"超预算"未处理项。

| 测量项 | 基线（2026-10-18 spike） | 5a 实测 | 判定（默认值） |
| --- | --- | --- | --- |
| `vue-tsc -p tsconfig.web.json --extendedDiagnostics` 的 Instantiations / Check time | 336 542 / 1.50 s（2 条详情路由 + 客户端） | 676 325 / 1.6–1.8 s（471 个文件：5 条读路由 + 上传 + health 的 `AppType`、`src/web/client/`、两个 web typetest；加客户端之前 626 314 / 1.42 s） | 2.0 倍 / 约 1.2 倍，未超 5 倍：保持 `hc<AppType>`（`AppType` 本来只含公开路由，步骤 8） |
| OpenAPI 文档字节数（运行时紧凑 JSON） | 23 368（2 条详情路由，组件命名；内联为 91 732） | 运行时发出的紧凑 JSON 59 594（10 个操作、89 个组件 schema；评审修复前 59 560）；提交的缩进版 134 407（`main` `ab46f3e` 为 47 119） | ≤ 100 000，通过：预算按紧凑 JSON 计（与基线同口径），`tests/http/openapi.test.ts` 断言 |
| 文档生成耗时（`node scripts/generate-openapi.ts` 输出） | 3.8 ms（2 条路由） | 18–22 ms（新进程的第一个 app；同进程后建的 app 约 7 ms；缓存后每请求 < 1 ms） | 仅记录：每个进程 / isolate 的第一个 `openapi.json` 请求付一次 |
| Worker 包（`wrangler deploy --dry-run`，`minify: true`） | 526.83 KiB / gzip 118.86 KiB | 1039.42 KiB / gzip 240.35 KiB（`main` `ab46f3e` 996.36 / 227.87 KiB：本切片 +43.06 / +12.48 KiB，构建器与 X.509 schema；评审修复前 1038.01 / 239.95） | 仅记录 |
| 10 000 条吊销 CRL 详情构建（Node） | — | `crlWithEntries`（夹具条目，带 reasonCode + invalidityDate）480 336 B DER：`parseCRL` 740–800 ms + `buildTBSCertList` 120–130 ms，整条 `GET /api/v1/crls/{targetId}` 0.7–1.0 s，响应 5.48 MB，堆门槛（最高失败 / 最低通过）120 / 124 MB；5 000 条 0.4–0.5 s、2.74 MB。`signCrl` 的 10 000 条（9 字节序列号 + reasonCode，切片 4 同口径）420 222 B：上传与详情的堆门槛都是 104 / 108 MB（5 000 条 56 / 60–64，20 000 条 188 / 192），128 MB 下两条路径都到 12 500 条、13 000 条失败；峰值约 21 MB 基底 + 每千条 8.5 MB，由解码决定，详情的投影与响应不抬高峰值。不 gc 时的堆增长 90–250 MB 几乎全是垃圾（gc 后只剩 0.3–0.5 MB） | CPU 不是瓶颈（Workers Standard 默认每请求 30 s），不设 `limits.cpu_ms`；上限是内存：Workers 的 128 MB 隔离区还装着包与运行时，Node 的堆门槛不能直接换算，取约 5 000 条目作安全余量（未在 Cloudflare 上验证，与切片 4 的上传一致）；写进 `docs/operations.md`"容量" |
| 每请求读 config + catalog（memory / fs） | — | 夹具部署（5 证书、7 目标；config 2 169 B、catalog 7 432 B）：`readState` p50 memory 48 µs、fs 0.30 ms；放大 20 倍（100 证书、140 目标，catalog 147 KB）memory 0.85 ms、fs 1.09 ms；整条列表 / stats 请求 memory 0.05–0.15 ms、fs 0.4–0.5 ms | 备忘保持关：读两份小对象在亚毫秒级，远小于一次详情构建；R2 延迟留给切片 7 演练 B |

测量方法（2026-10-20，本机 WSL2、Node 24.22.0）：vue-tsc 连跑三次取范围；大 CRL（`tests/helpers/pki.ts` 的 `crlWithEntries`、
`tests/helpers/generated-ca.ts` 的 `signCrl`）的 DER、SHA-256 与摘要在不限堆的进程里先算好，测量进程只装载这些文件、发一个请求（上传：
`POST /api/v1/crls`；详情：blob + catalog 条目直接写入后 `GET`），按 4 MB 步长从两个方向找 `--max-old-space-size` 的最高失败与最低通过值，
边界各重跑 4 次（个别值 4 次里时过时不过，取较高者）；`--expose-gc` 下另取请求前后与 gc 后的 `heapUsed`；`readState` 与整条请求各跑
2 000 / 500 次（先热身 50 次），fs 为 `FsStore` 指向临时目录（每次 `get` 都读文件并算 SHA-256 作 ETag）。

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| 构建器原样迁入仍按 10 条分页；夹具与线上 CRL 条目都 ≤ 10，构建器用例照样全绿 | 步骤 3 删分页；core 与 http 各一条 > 10 条用例；出口 5 的 grep |
| "原样迁入"不是纯复制：导入后缀、`@contracts` 别名、`toJSDate`、schema 位置、组件 id | 步骤 1 / 3 的表；出口 4、5 |
| 41 个字面量与字段名是与 5b 的契约；删死变体、必填化会改类型 | 只做步骤 1 列出的删改；schema 测试锁定集合；5b 的 switch 用 `never` 穷尽 |
| 合成夹具 ≠ 线上字节：签发 CA 是 RSA-2048（线上 4096），DN、日期、URL 不同；旧断言的字面量全失效 | 断言改用夹具配置值 / `manifest`；线上工件"全部 Decoded"的核对在切片 7 步骤 7（§10 #27、D7） |
| 组件 id 挂在派生实例上或漏挂 → 文档内联膨胀 | 定义处 `.meta({ id })`；体积预算断言 |
| `hc<AppType>` 类型成本随路由增长，拖慢 `vue-tsc` 与编辑器 | 管理路由不进 `AppType`（步骤 8）；测量（出口 9：2.0 倍，未超预算）；超预算的退路写在测量表 |
| zod / hono 进网页包 | 网页只 `import type`；`consistent-type-imports`（B17）；出口 6 |
| 大 CRL 详情的 JS CPU；旧 `limits.cpu_seconds` 是无效键，从未生效 | 10 000 条已测（出口 9）：CPU 约 1 s，不设 `limits.cpu_ms`；内存才是上限（Node 堆门槛与上传相同；Workers 取约 5 000 条目的安全余量，未验证），写在 `docs/operations.md`"容量"（切片 6 步骤 11 并入完整手册） |
| `smoke:worker` 偶发 "Network connection lost"（阶段 2 约 48 次中 1 次，在切片 4 发布段的第一个 `POST /api/v1/crls`） | 之后 42 + 30 次未复现；本机此前唯一一次出现紧跟在 workerd 崩溃重启之后，很可能同因。不处理，再出现时先查其前有无 `The Workers runtime crashed` |
| 服务端与客户端时钟不一致 | stats 不含时间字段，状态与"需关注"数只在客户端按同一时钟算（切片 5b） |
| `.meta({ id })` 进全局注册表：重复 id 或两份 zod 会出错 | id 唯一性测试；出口 7 |

## 开工前需 owner 确认

2026-10-20 已确认：取推荐默认（附录 C）。

1. **状态阈值 / 即将过期规则**：即切片 5b 开工前需 owner 确认第 2 项（推荐默认在那里），须在本切片开工前定：它决定
   `/api/v1/stats` 是否含时间相关字段（推荐：不含）。CRL 列表项总带 `current.summary.nextPublish`，不受它影响。
