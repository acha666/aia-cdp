# 切片 5a：API 与客户端

## 目标与范围

公开只读路由 `GET /api/v1/certificates`、`/certificates/{id}`、`/crls`、`/crls/{targetId}`、`/stats`（plan §7.1）及其 schema；
`worker-aia-cdp@5b570aa` 的四个详情构建器与 X.509 投影 schema 迁入 `src/core/summary/`；OpenAPI 文档补全、lint 与体积预算；
`hc<AppType>` 类型出口与网页客户端的错误处理（`src/web/client/`）。分支 `slice/5a-api`，评审后本地合并（D3）。

不在本切片：`src/core/pki` 解析层与目录摘要（见切片 2）；下载与路径反查（见切片 3）；`POST /api/v1/crls`（见切片 4）；
history / retire / delete（见切片 6）；页面、vue-query、扩展渲染块（见切片 5b）。

§10 归属：#7、#8、#9、#10、#16、#17、#27、#28 与 #2 的"详情接受归档 id"在本切片；#4 服务端见切片 4、文案见切片 5b；#18 见切片 5b。

## 前置

- 切片 1–4 已合并：`createApp` / `errors.ts`（`defaultHook`、`onError`、`methodNotAllowed`、`no-store`）、运行时 `GET /api/v1/openapi.json`
  与 `scripts/generate-openapi.ts --check`（1）；ObjectStore、`src/core/catalog.ts` 的 config / catalog schema 与读取、`src/core/pki/*`、
  证书摘要（2）；`src/core/resources.ts` 的路径反查（3）；`publishCrl` 与 catalog `current.summary`（4）。
- 夹具：`tests/fixtures/pki.ts` 的 `manifest` / `NOW` / `fixture()` 与 vitest `globalSetup`（切片 1）。断言值取自文件或 `manifest.json`，
  不写摘要、密钥 id、大小字面量（B16）；`tests/data/adcs.ts` 不入库（D7）。
- 切片 5b 开工前需 owner 确认第 2 项（状态阈值）已定：它只决定 `/api/v1/stats` 是否含时间相关字段（CRL 列表项总带 `current.summary.nextPublish`，
  切片 4 步骤 2 总会记录它）。

## 步骤

1. **X.509 schema 入 core。** `src/core/summary/schemas.ts` ← `worker-aia-cdp@5b570aa:src/contracts/schemas.ts` L12–497、L542–556、L578–604；
   `src/core/summary/types.ts` ← L768–866 中指向这些范围的 77 个类型导出，名字不变（构建器只改导入路径）。`CrlTypeSchema`（L510）不搬，
   `kind` 用切片 2 `catalog.ts` 的定义；L502–508、516–540、558–572、606–668、674–762（v2 信封、存储、分页、查询）不搬。改动：
   - 删 `UnknownExtensionValueSchema`（L433，联合成员 L476）：没有解析器产出它（§10 #8 死变体）；
   - 必填化总会产出的字段：`SubjectPublicKeyInfo.parsed`（L170）、`TBSCertList.version`（L597）、`ECPublicKey.point.x/y`；
     v1 详情包装（步骤 6）里 `signatureAlgorithm` / `signatureValue` 必填（`include=` 已删，§10 #8、#28）；
   - `RevokedCertificatesSchema`（L589–594）改为 `{ count, items }`，在 `TBSCertList` 中必填；
   - 抽出具名 `DistributionPointNameSchema`，`DistributionPoint` 与 IDP 共用（派生 schema 不继承 id）；
   - 在定义处挂 `.meta({ id })`：`Name`、`Time`、`GeneralName`、`DistributionPoint`、`AlgorithmIdentifier`、`SignatureValue`、
     `SubjectPublicKeyInfo`、`Extension`、`Extensions`、`TBSCertificate`、`TBSCertList`、`RevokedCertificate` 与 41 个 `*Value`
     （全部成员有 id 才生成 `discriminator.mapping`）；`types.ts` 另导出 `type ExtensionType = ParsedExtensionValue["extensionType"]`。
   注意：core 只 `import { z } from "zod"`，不调 `.openapi()`；`Asn1LineSchema` 与 `src/core/pki/asn1.ts` 的 `Asn1Line` 保持结构一致。

2. **zod 3 → 4 清单**（原文件在 zod 4.6.7 下 `tsc --strict` 通过、运行时检查全过，以下是要改或要守的点）：

   | # | 旧写法（`src/contracts/schemas.ts`） | v1 处理 |
   | --- | --- | --- |
   | 1 | 全文件 `import { z } from "zod"` | core 保持；http 从 `@hono/zod-openapi` 取 `z` / `createRoute`；`.openapi()` 只在 http 用（它在导入时才打补丁） |
   | 2 | `.describe()`（`:56`、`:70-72`、`:100`、`:121-122`、`:191-192`、`:489`） | 照常进 OpenAPI `description`，可并入 `.meta()` |
   | 3 | `.extend()` / `.shape.distributionPoint`（`:33`、`:297`） | 派生实例不继承 id → 内联；需要复用的抽成具名 schema |
   | 4 | `z.discriminatedUnion`（`:35-39`、`:42-53`、`:155-160`、`:434-477`） | 可用；失败 issue 由 `invalid_union_discriminator` 变为 `invalid_union`（note "No matching discriminator"），断言 issue 码的测试要改 |
   | 5 | `z.record(z.string(), …)`（`:686`、`:693-699`、`:719`） | 随 v2 包装删除；新 schema 不用 `z.record(z.enum())`（zod 4 下穷尽），用 `z.object` / `z.partialRecord` |
   | 6 | 无字符串格式 | 新字段：`z.uuid()`（严格 RFC 9562，与 config 同一校验器）、`z.iso.datetime()`、id `z.string().toLowerCase().regex(/^[0-9a-f]{64}$/)`；正则不带 flag（`/i` 会漏进 `pattern`） |
   | 7 | `ZodError.flatten()`（`certificates/list.ts:26`、`crls/list.ts:25`、`crls/detail.ts:40`） | 随旧路由删除；`defaultHook` 输出 `details.issues`（切片 1 步骤 4） |
   | 8 | `z.coerce.number()` 查询 schema（`:742-762`）、`createApiResponseSchema<T extends z.ZodTypeAny>`（`:730-736`） | 删：v1 无查询参数、无信封 |
   | 9 | `z.unknown()` 键 | zod 4 类型层面必填，新字段一律 `.optional()` |
   | 10 | `z.custom<File>`（`api.ts:101`） | 生成器不能表示；上传 body 的 `z.file().openapi({ type: "string", format: "binary" })` 见切片 4，5a 只要求全部路由能生成文档 |

3. **构建器迁入**（导入一次改完：相对路径、`.ts` 后缀、`import type`、无别名，B3）：

   | 旧（`worker-aia-cdp@5b570aa:`） | 新 | 改动 |
   | --- | --- | --- |
   | `src/worker/api/v2/builders/primitives.ts` | `src/core/summary/primitives.ts` | `../../../pki/constants` → `../pki/constants.ts`，`../../../pki/utils/conversion` → `../pki/conversion.ts`，`@contracts/types` → `./types.ts`；切片 2 未迁 `toJSDate` → `buildTime` 改收 `pkijs.Time`，读 `.value` / `.type`；`buildFingerprints(der)` 收 `Uint8Array`（经切片 2 的 `toDigestInput()`）；`formatGeneralizedTime` 已由切片 4 移入 `src/core/pki/asn1.ts`，改为导入，不留副本 |
   | `src/worker/api/v2/builders/extensions.ts` | `src/core/summary/extensions.ts` | 只改导入（`../../../pki/{constants,extensions,asn1}`、`utils/conversion`）；`:182-184` `buildTime({ type: 1, value: date })` → `new pkijs.Time({ type: 1, value: date })`；41 个 `extensionType` 字面量与字段名一字不改（与 5b `ExtensionView` 的契约） |
   | `src/worker/api/v2/builders/certificate.ts` | `src/core/summary/certificate.ts` | 改导入；删 `options.extensions`（`:17`、`:35`） |
   | `src/worker/api/v2/builders/crl.ts` | `src/core/summary/crl.ts` | 改导入；删 `revocationsLimit` / `revocationsCursor` / `hasMore` / `nextCursor` 与 `options`（`:13-49`，默认每页 10 条）；总是返回全部条目 `{ count, items }`；删 `determineCrlType`（`:86-89`，只看存在与否，M6），类型来自 config |

   `@contracts/*` 别名不进任何 tsconfig / vite 配置。键标识在详情扩展里仍是大写 hex（`extensions.ts:536`、`:715`，显示用）；
   目录摘要与 id 是小写（M4，见切片 2），跨接口比较只用摘要字段。

4. **DN 标签**（默认值，可推翻）：`src/core/pki/constants.ts` 的 `OID_DICTIONARY` 删去 `2.5.4.12/13/15/17` 的 `short`
   （`T`、`DESCRIPTION`、`BUSINESS`、`POSTAL`，旧 `constants.ts:11-15`），标签回落到 `title`、`description`、`businessCategory`、`postalCode`，
   与 `Name.rfc4514` 的 "OpenSSL attribute names" 一致；线上 CA 的 DN 只有 CN / O / C，不受影响。

5. **读模型** `src/core/views.ts`（新，纯函数，入参 config + catalog，详情另加 blob 字节）。每请求经 `src/core/catalog.ts` 各 `get` 一次
   config 与 catalog，详情再读一个 blob；统计不调 `list`。config 缺失 → 证书只来自 catalog、目标为空。

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
   | `revokedCount` | 非空整数（发布时解析得出）；"未知"只以 `current: null` 出现，UI 显示"未发布"（§10 #7；消解 plan 里"可空"与"发布即解析"的内部矛盾） |
   | `revokedCertificates` | 必填，返回全部条目；空 CRL 为 `{ count: 0, items: [] }` |
   | stats | `{ certificates, targets: { full, delta }, published: { full, delta }, totalRevocations, derBytes }`（§10 #16）；不含时间相关字段，"需关注"数由 UI 用客户端时钟算（切片 5b 开工前需 owner 确认第 2 项） |
   | `totalRevocations` | 已发布 **full** CRL 的 `revokedCount` 之和（delta 条目会在下一张 full 重现，不计）；没有已发布 full CRL 时 `null` |
   | `derBytes` | catalog 证书 `size` + 各 `current` CRL `size`；历史 blob 不计（要 `list`，属管理接口） |

   失败语义：catalog 有条目但 blob 缺失或解析失败 → 500 `internal` + 一行日志（导入 / 发布时已校验过）；store 抛错 → 500，绝不是 200 空列表（§10 #9）。

6. **HTTP schema** `src/http/schemas.ts`：`CertificateListItem`、`CertificateDetail`、`CrlTargetListItem`、`CrlTargetDetail`、`Stats`（`.openapi("<名>")`，
   组合 core schema）；参数 `CertificateIdParam`（`z.string().toLowerCase().regex(/^[0-9a-f]{64}$/)`，大写输入被规范化）与 `TargetIdParam`
   （`z.uuid()`）；错误体沿用切片 1 的按状态码 schema（400 `bad_request`、404 `not_found`、500 `internal`）。

7. **路由**：`src/http/routes/certificates.ts`、`stats.ts`（新），`src/http/routes/crls.ts`（切片 4 已有 POST，追加两条 GET）。每条
   `createRoute` 写 `operationId`（`listCertificates`、`getCertificate`、`listCrlTargets`、`getCrlTarget`、`getStats`）、`summary`、`tags`，
   措辞参考 `worker-aia-cdp@5b570aa:src/contracts/api.ts`（响应字段对照 `worker-aia-cdp@5b570aa:docs/templates/api-responses.example.json`，仅参考 v2 形状）；只声明实际可能出现的 200 / 400 / 404 / 500（500 由 `onError` 产出）；所有响应 `Cache-Control: no-store`（§10 #17）；
   HEAD 走自动 HEAD。旧 `worker-aia-cdp@5b570aa:src/worker/api/v2/{certificates,crls}/{list,detail}.ts` 与 `stats.ts` 只作语义参考：
   `search`、分页、`include=`、`storage`、`relationships: {}`、`ctx.waitUntil` 回填全部不迁。

8. **AppType**：`createApp` 的返回链只串公开路由（health、certificates、crls、stats），管理路由用独立语句 `app.route(...)` 注册——运行时与
   OpenAPI 文档都包含它们，`AppType` 不含（默认值，可推翻；CLI 不用 `hc`）。

9. **OpenAPI**：`scripts/generate-openapi.ts`（切片 1，源自 `worker-aia-cdp@5b570aa:scripts/generate-openapi.ts` 与 `src/contracts/openapi.ts`）
   不改机制，重新生成并提交 `docs/openapi.json`；`src` 不导入该文件（B11）。原 `redocly.yaml` 的 `operation-operationId`、
   `operation-summary`、`no-unused-components` 改为 `tests/http/openapi.test.ts` 里的断言；管理路由缺 `security` 声明时在此补上。

10. **网页客户端** `src/web/client/`（B20；迁移表里的 `src/web/api/*` 一律落到这里）：
    - `errors.ts` ← `worker-aia-cdp@5b570aa:src/web/api/response.ts`（重写）：`ApiError { code, message, status, details? }`（字段显式声明，
      `erasableSyntaxOnly`）；`unwrap(res)`：`res.ok` → `res.json()`，否则解析 v1 信封抛 `ApiError(code)`，非 JSON → `invalid_response`，
      `fetch` 失败 → `network`；运行时不带 zod。
    - `types.ts`：从 `src/core/summary/types.ts` 的纯类型再导出（`Name`、`GeneralName`、`Extension`、`DistributionPoint`、`Asn1Line`、
      `AlgorithmIdentifier`、`ExtensionType` …）+ 五条路由 200 体的 `InferResponseType` 别名。
    - `error-codes.ts`：错误码的运行时数组（字面量，供 5b 的 i18n 测试遍历；web 不得在运行时导入 `src/http`，切片 5b 步骤 11），
      `tests/web/client.typetest.ts` 断言它与 `(typeof ERROR_CODES)[number]`（`import type` 自 `src/http/schemas.ts`）双向相等。
    - 切片 1 的 `hc<AppType>("", { init: { cache: "no-store" } })` 保留；`worker-aia-cdp@5b570aa:src/web/api/client.ts` 的分页、`include`、
      `encodeURIComponent(id)` 与 `pagination.ts` 不迁。
11. **测量**（填出口条件 9 的测量表）：类型成本、文档体积与生成耗时、Worker 包、大 CRL 详情耗时、每请求读 config + catalog 的耗时
    （plan §5.6 备忘保持默认关；R2 真实延迟要有部署环境，见切片 7 步骤 8 演练 B）。

## 测试

| 文件 | 来源（`worker-aia-cdp@5b570aa:`） | 内容 |
| --- | --- | --- |
| `tests/core/summary/extension-parsers.test.ts` | `tests/worker/extension-parsers.test.ts`（17 条） | 11 条不依赖 `adcs.ts` 的原样迁（`node:test` → `vitest`，`node:assert/strict` 保留）；用 `adcs.ts` 的 6 条（L54、L87、L106、L151、L647、L683）改用合成夹具：`certs/issuing-ca-1`（CA Version、模板名 `SubCA`、PrintableString DN、NULL 参数）、`certs/root-ca`（P-384 参数、ECDSA r/s）、`crls/issuing-ca-1/full-adcs`（Next CRL Publish、Freshest CRL、CRL Self CDP 及顺序）、`crls/issuing-ca-1/delta-adcs`（关键 delta 指示，base 取 `manifest`）、`certs/issuing-ca-2`（critical 计数）；L647 严格时间已在切片 2，此处只留 `buildTBSCertList` 的 `raw` 断言 |
| `tests/core/summary/values.test.ts` | `tests/worker/pki-values.test.ts` L28、L96、L111、L124、L181、L202 | 旧根 RSA-2048、新根 EC P-384：L124 的 RSA 位数改读 `certs/issuing-ca-1`，L181 的算法断言随夹具改；L224 随构建器选项删除 |
| `tests/core/summary/extensions-structure.test.ts` | `tests/worker/extensions-structure.test.ts` | 路径改 `certs/leaf-full.der`、`certs/root-ca.pem`；删 `Buffer` 辅助 |
| `tests/core/summary/schemas.test.ts` | `tests/web/api-client.test.ts` 用例 (1)（放 core：类型在 core，core 不依赖 http） | 判别字段；schema 字面量集合 = 构建器集合 = 41；`unknown` 变体不存在；组件 id 唯一 |
| `tests/core/summary/revocations.test.ts`（新） | — | 把夹具 CRL 的条目复制到 11 条与 10 000 条后重编码（旧 L647 的 `toSchema(true)` 手法；详情不验签）：`count === items.length`；10 000 条只记录耗时 |
| `tests/core/summary/extension-parsers.test.ts` 追加 | 补旧测试缺口 | cRLReason / invalidityDate / holdInstructionCode 成功路径（合成夹具已有 keyCompromise、superseded、certificateHold）；EKU 成功路径；QC Statements、SCT List、Subject Directory Attributes 在测试内构造扩展值 |
| `tests/core/views.test.ts`（新） | `tests/worker/api-stats.test.ts` 的意图 | 步骤 5 表逐行；`current.summary.nextPublish` 对 `crls/issuing-ca-1/full-adcs.der` 非空、对不带该扩展的 `full-01.der` 为 `null` |
| `tests/http/certificates.test.ts` | `tests/worker/api-routing.test.ts` 用例 (3) | 列表 / 详情字段、`targets`；大写 id 规范化；非 hex、嵌套、`crl/archive/…` 形 id → 400；未知 hex → 404；blob 缺失 → 500 不泄漏；200/400/404/500 均 `no-store`；HEAD 200 空体 |
| `tests/http/crl-targets.test.ts`（新） | — | 经切片 2/4 的 `importCertificate` / `applyConfig` / `publishCrl` 写 MemoryStore；未发布 → 列表与详情 `current: null`；非 uuid → 400、未知 → 404；`revokedCertificates.count === summary.revokedCount`；另把 `revocations.test.ts` 的 11 条重编码字节直接写成 blob + catalog 条目（详情不验签），断言全部返回 |
| `tests/http/lists.test.ts` | `tests/worker/api-pagination.test.ts` 的不变量 | 每个 catalog 证书 / config 目标恰好一项；`downloads` 不含 `blobs/` 与历史；store `get` 抛错 → 500 信封，不是 `200 []` |
| `tests/http/stats.test.ts` | `tests/worker/api-stats.test.ts` | 计数来自 config + catalog；`derBytes` = 夹具文件字节数之和；`totalRevocations` 只计 full、无已发布 full 时 `null`；store `list` 未被调用 |
| `tests/http/openapi.test.ts` | 扩展切片 1 的同名文件；替代 `redocly.yaml` | 运行时文档 = `docs/openapi.json`、`max-age=300`；每个操作有唯一 `operationId`、`summary`、`tags`；`/api/v1/admin/*` 有 `security`；无未引用组件；体积 ≤ 100 000 字节（默认值） |
| `tests/http/routes.typetest.ts`、`tests/web/client.typetest.ts`（新） | — | 错形状、未声明状态码是编译错误；`hc` 按状态码与 `extensionType` 收窄，`@ts-expect-error` 在 `hc<any>` 下会失效，证明不是 `any`；`src/web/client/error-codes.ts` 与 `ERROR_CODES` 相等（步骤 10） |
| `tests/web/api-errors.test.ts` | `tests/web/state.test.ts` 用例 (3) | `unwrap`：v1 错误体 → `ApiError(code, status)`；HTML / 空体 → `invalid_response`；`fetch` 抛错 → `network`；经 `hc` 的 `fetch` 选项断言 `init.cache === "no-store"` |
| `tests/integration/node-e2e.test.ts` | 切片 4 已建 | 追加真实 socket 上的 list / detail / stats 与 HEAD |

HTTP 用例用 `createApp({ store: new MemoryStore(), now, … }).request()`，需要类型化 body 时用 `hono/testing` 的 `testClient`。
ECDSA 签名随机：r / s 断言 `≤ 96` hex 且不以 `00` 开头，不断言等长；CRL / 签名大小也不断言字面量（B16）。

## 出口条件

1. `pnpm run ci:check` 通过：`pnpm run types`、worker / node / web 三套编译与两个 canary、两个 typetest、lint、format、
   `node scripts/generate-openapi.ts --check`。
2. `pnpm run ci:test` 通过，含 `pnpm exec vitest run --project core --project http --project web --project integration` 的测试表全部用例。
3. `node scripts/generate-openapi.ts && git diff --exit-code docs/openapi.json` 无差异。
4. `diff <(grep -o 'extensionType: z.literal("[A-Za-z]*")' src/core/summary/schemas.ts | grep -o '"[A-Za-z]*"' | sort -u) <(grep -o 'extensionType: "[A-Za-z]*"' src/core/summary/extensions.ts | grep -o '"[A-Za-z]*"' | sort -u)`
   无输出，且两侧各 41 行。
5. `grep -rnE "revocationsLimit|hasMore|nextCursor|determineCrlType|toJSDate|@contracts" src tests` 无输出。
6. `pnpm run build && ! grep -rlE "getOpenAPI31Document|OpenAPIHono" dist/web`：网页包里没有服务端代码。
7. `pnpm why zod` 只出现一个版本（`.meta({ id })` 依赖全树一份 zod）。
8. `pnpm run ci:worker` 通过（`wrangler deploy --dry-run`）。
9. 下表"5a 实测"列填满，判定列无"超预算"未处理项。

| 测量项 | 基线（2026-10-18 spike） | 5a 实测 | 判定（默认值） |
| --- | --- | --- | --- |
| `vue-tsc -p tsconfig.web.json --extendedDiagnostics` 的 Instantiations / Check time | 336 542 / 1.50 s（2 条详情路由 + 客户端） | | 超过基线 5 倍 → `hc` 只用公开子应用类型 |
| `docs/openapi.json` 字节数 | 23 368（2 条详情路由，组件命名；内联为 91 732） | | ≤ 100 000 |
| 文档生成耗时（`node scripts/generate-openapi.ts` 输出） | 3.8 ms（2 条路由） | | 仅记录 |
| Worker 包（dry-run，`minify: true`） | 526.83 KiB / gzip 118.86 KiB | | 仅记录 |
| 10 000 条吊销 CRL 详情构建（Node） | — | | 仅记录；偏大时评估 `limits.cpu_ms` |
| 每请求读 config + catalog（memory / fs） | — | | 决定 §5.6 备忘（默认关） |

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| 构建器原样迁入仍按 10 条分页；夹具与线上 CRL 条目都 ≤ 10，"构建器用例全绿"照样成立 | 步骤 3 删分页；core 与 http 各一条 > 10 条用例；出口 5 的 grep |
| "原样迁入"不是纯复制：导入后缀、`@contracts` 别名、`toJSDate`、schema 位置、组件 id | 步骤 1 / 3 的表；出口 4、5 |
| 41 个字面量与字段名是与 5b 的契约；删死变体、必填化会改类型 | 只做步骤 1 列出的删改；schema 测试锁定集合；5b 的 switch 用 `never` 穷尽（见切片 5b） |
| 合成夹具 ≠ 线上字节：签发 CA 是 RSA-2048（线上 4096），DN、日期、URL 不同；旧断言的字面量全失效 | 断言改为夹具配置值 / `manifest`；线上工件"全部 Decoded"的核对在切片 7 步骤 7（§10 #27、D7） |
| 组件 id 挂在派生实例上或漏挂 → 文档内联膨胀 | 定义处 `.meta({ id })`；体积预算断言 |
| `hc<AppType>` 类型成本随路由增长，拖慢 `vue-tsc` 与编辑器 | 管理路由不进 `AppType`（步骤 8）；测量；超预算的退路写在测量表 |
| zod / hono 进网页包 | 网页只 `import type`；ESLint `consistent-type-imports`（B17）；出口 6 |
| 大 CRL 详情的 JS CPU；旧 `limits.cpu_seconds` 是无效键，从未生效 | 10 000 条测量；需要时设 `limits.cpu_ms` 或在 operations.md 写明上限（切片 6 步骤 11） |
| 服务端与客户端时钟不一致 | stats 不含时间相关字段；状态与"需关注"数只在客户端按同一时钟算（切片 5b） |
| `.meta({ id })` 进全局注册表：重复 id 或两份 zod 会出错 | id 唯一性测试；出口 7 |

## 开工前需 owner 确认

1. **状态阈值 / 即将过期规则**：与切片 5b 开工前需 owner 确认第 2 项是同一问题，推荐默认写在那里；须在本切片开工前定，因为它决定
   `/api/v1/stats` 是否含时间相关字段（推荐：不含）。CRL 列表项总带 `current.summary.nextPublish`（切片 4 步骤 2 总会记录），不受它影响。
