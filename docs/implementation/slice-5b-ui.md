# 切片 5b：UI

## 目标与范围

在切片 1 的占位 UI 上按 plan §8 建成正式 UI：总览、证书详情、CRL 目标详情、CRL 上传；迁入旧实现的纯逻辑与
X.509 渲染组件并补上它们缺失的测试；补 `zh-CN`；定下 CSP；产物 < 250 KB gzip 且有可重复的测量。分支 `slice/5b-ui`。

不在本切片：`hc` 客户端、`ApiError` / `unwrap`、类型再导出与列表 / 详情 / 统计路由（切片 5a）；SPA 兜底与 UI 缓存头的机制、
`VITE_SITE_NAME` 默认值与转义守卫（切片 1，本切片只在出口复验兜底，含 C12）；管理操作 UI（不做：管理通道是令牌 + CLI，
plan §7.2 / §7.4，浏览器里不放管理令牌）。

本切片处理：§10 #2、#4、#7、#10、#17、#18、#28 的 UI 部分；M8 与 M16 的 UI 侧。

## 前置

- 切片 1：Vite `root: src/web`、`outDir: dist/web`、`envDir`；`shadcn-vue@2.8.2 init --style nova`（D6）、`components.json`、
  `src/web/lib/utils.ts`；路由占位、`VueQueryPlugin`、i18n 骨架、`useColorMode` 主题切换、`tw-animate-css`；dev 代理键
  `^/(?:api|ca|crl|dcrl)/`；两条运行时的 UI 兜底与缓存头；`scripts/smoke.sh`、`tests/integration/node-runtime.test.ts`。
- 切片 4：`POST /api/v1/crls` 的三种结果、错误码、可选 `AIA_UPLOAD_TOKEN`；multipart 字段 `crl` 接受文件与字符串（M8，切片 4 步骤 8），
  UI 一律发文件（步骤 7）。
- 切片 5a 提供下列 UI 依赖（缺哪项就在 5a 补，不在 UI 里绕）：
  - `src/web/client/`（切片 5a 步骤 10）：`api`（`hc<AppType>("", { init: { cache: "no-store" }, fetch: apiFetch })`，每请求的 `init`
    如 `signal` 与之合并）；`errors.ts` 的 `ApiError`（`code: string`、`status: number`、`message`、`details?`）+ `unwrap(res)`：2xx → hc 推断的体，
    否则抛 `ApiError`——v1 信封的 `code` 与 HTTP 状态；非 JSON 或非信封 → `invalid_response`；拿不到响应 → `network`，`status: 0`（`apiFetch`
    已换好，`unwrap(await api…$get(…))` 不必再包 try）；中止原样抛出（不是 `ApiError`）；服务端更新后的未知码原样保留。`types.ts`：
    core 类型 `export type *`（`Name`、`GeneralName`、`Extension(s)`、`Asn1Line`、`DistributionPoint`、`AlgorithmIdentifier`、41 个 `*Value`、
    `ExtensionType` …）与响应体 `CertificateList` / `CertificateListItem`、`CertificateDetail`、`CrlTargetList` / `CrlTargetListItem`、
    `CrlTargetDetail`、`Stats`、`PublishedCrl`。`error-codes.ts`：`ERROR_CODES`（全部 v1 码）与 `CLIENT_ERROR_CODES`（`network`、
    `invalid_response`），供 i18n 测试遍历。
  - 列表是完整数组，按 id / `targetId` 排序（UI 自行排序）；`downloads[]` 只有 config 的路径（每条 DER 路径后紧跟 `.pem`）。证书项
    `{ id, label: string | null, importedAt, size, summary, downloads, targets: [{ targetId, kind, label }] }`，`summary` 含 `subjectCN`、
    `issuerCN`、`notBefore`、`notAfter` 等；目标项 `{ targetId, kind, label, issuer: { id, label: string | null, subjectCN }, downloads, current }`，
    `current` 为 `{ sha256, size, publishedAt, summary }` 或 `null`，`summary` 含 `crlNumber`、`baseCrlNumber`、`thisUpdate`、`nextUpdate`、
    `revokedCount`（非空整数）、`nextPublish | null`。证书详情另加 `fingerprints`、`tbsCertificate`、`signatureAlgorithm`、`signatureValue`；
    目标详情的 `current` 另加 `verifier`、`fingerprints`、`tbsCertList`（`revokedCertificates: { count, items }`，全部条目）、
    `signatureAlgorithm`、`signatureValue`。stats `{ certificates, targets: { full, delta }, published: { full, delta }, totalRevocations, derBytes }`，
    无时间字段——均见切片 5a 步骤 5。
  - 已配置未发布的目标详情 200 + `current: null`；详情 id 格式不符 400 `bad_request`、未知 404 `not_found`；上传成功体含 `kind`、`crlNumber`、
    `baseCrlNumber`、`downloads`（M16）。`GET /api/v1/health` 的 503 体不是错误信封（`unwrap` 会报 `invalid_response`），健康徽标按状态码读。
  - 死变体 `extensionType: "unknown"` 已删；吊销条目不再按旧 builder 的默认 10 条分页。
- 冒烟数据：已入库的 `tests/fixtures/pki/` 经切片 2 的 CLI `import` / `config apply` 灌入。

## 步骤

1. **组件**：`pnpm dlx shadcn-vue@2.8.2 add <名单> --yes < /dev/null`，名单为下列中切片 1 尚未生成的
   `accordion alert badge button card collapsible input label skeleton sonner table tabs textarea tooltip`。之后：新包用 `pnpm add -D` 挪到
   devDependencies（总则 §2.3）；`sonner` 带来 `vue-sonner`，在 `src/web/main.ts` 加 `import "vue-sonner/style.css"`（B2）；确认 `components.json`
   无 `font` 键、`main.css` 无 Google Fonts `@import`；
   `pnpm exec prettier --write src/web/styles/main.css components.json src/web/components/ui src/web/lib`（同切片 1 步骤 6）。
   不引入 `@tanstack/vue-table`：分页只是 `slice()`（默认值，可推翻）。
   注意：切片 1 只生成过 `button`、`badge`，其余 nova 组件是首次生成（见风险表）；生成文件与 lockfile 一并提交（plan §8）。
2. **纯逻辑迁入**（类型一律 `import type` 自 `@/client/types`）：
   - `src/web/utils/status.ts` ← `worker-aia-cdp@5b570aa:src/web/utils/status.ts`：`computeCertificateStatus` / `computeCrlStatus`
     的含边界与秒粒度原样保留；删死函数 `computeCertificateValidity`、`computeCrlValidity`；新增 `unpublished`（`current === null`）
     与 owner 确认后的 `nextPublish` / 证书 `expiring` 规则（末节第 2 项）；`nowMs` 改为必填，不再默认 `Date.now()`。
   - `src/web/utils/dates.ts` ← `…:src/web/utils/dates.ts`：`getRelativeTime*` 增加 `nowMs` 参数；删重复的 `formatDateReadable`；
     `hour12: false` 改 `hourCycle: "h23"`（旧引擎把 00:05 显示成 24:05）；时区标签与三种显示变体不变。
   - `src/web/utils/format.ts` ← `…:src/web/utils/format.ts`：保留三个 hex 函数，删 `copyToClipboard`（`execCommand`）。
   - `src/web/utils/x509.ts` ← `…:src/web/utils/x509.ts`：导出 `formatAttribute` 供 `DistributionPointList` 复用；字面量 `salt` 进 i18n。
   - `src/web/utils/crl-entries.ts` ← `…:src/web/components/CrlDetails.vue:46-65` 的 `describeEntry`。
   - `src/web/composables/useCrlUploadInput.ts` ← `…:src/web/composables/useCrlUploadInput.ts` 原样。
   - `src/web/composables/useClock.ts`（新）：`createSharedComposable(() => useNow({ interval: 60_000 }))`，徽标与相对时间共用一个时钟。
3. **扩展渲染块**：`src/web/utils/extension-blocks.ts` ← `…:src/web/components/ExtensionView.vue:30-290`（`Block` 联合、
   `describe()`、`describeSubtree`、helpers），签名 `describeExtension(value, ctx)`，`ctx` 注入 `field` / `nameLabel` / `time` / `yesNo`。
   switch 写成穷尽（`const _exhaustive: never = value`），随 5a 删除 `unknown` 一并删 `json` 块，剩 plan §8 的 7 种块。保留块内固定文本
   （`${name} (${code})`、模板版本 `major.minor`、SCT `hash/signature`、子树范围 ` [min–max]`）。组件迁到 `src/web/components/x509/`，
   来源均为 `worker-aia-cdp@5b570aa:src/web/components/<同名>.vue`：`ExtensionView.vue`（`AccordionItem`：名称 / OID、Critical 徽标、
   解析状态徽标；未解析时 `parseError` + `Asn1Dump` + 原始 hex `Collapsible`）、`ExtensionList.vue`（关键在前、`localeCompare`、
   对副本排序，`Accordion type="multiple"`）、`GeneralNameList.vue`、`DistributionPointList.vue`、`Asn1Dump.vue`、`NameDetails.vue`。
   `TAG_TONES`（blue / purple / amber）改为 Badge 的 cva 变体，颜色只用 token。
4. **通用组件**：`StatusBadge.vue`（Badge 上的 cva 状态表，加 `unpublished`、`expiring`，删未用的 `showLabel`）；`HexValue.vue`
   （`useClipboard({ legacy: true })`、复制 / 已复制文案走 i18n、写剪贴板失败给 toast）；`DownloadLinks.vue`（依据
   `…:src/web/components/ResourceCard.vue:44-51,76-85`：由 `downloads[]` 驱动，`.pem` 结尾标 PEM 否则 DER，`<a download>`，空列表 "—"）；
   `KeyValueList.vue`（取代 `FingerprintDetails.vue` 与各处重复的 `dt/dd` 类名）；`LocaleSelect.vue`（取代切片 1 的 `LocaleSwitch.vue`）。
5. **查询层** `src/web/client/queries.ts`：键 `["health"]`、`["stats"]`、`["certificates"]`、`["certificate", id]`、`["crls"]`、
   `["crl", targetId]`，`queryFn` 一律 `unwrap(await api…$get(…))`（`["health"]` 除外：沿用切片 1 `HealthBadge` 按状态码读，见前置）。
   `src/web/main.ts` 的 `QueryClient`：`staleTime: 0`、`retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2`
   （4xx 不重试，否则详情页的 404 要等几秒；`network` 的 `status` 是 0，要重试）、`refetchOnWindowFocus` 保持默认。
   `useUploadCrl()` = `useMutation`，成功后 `queryClient.invalidateQueries()` 全量失效（数据量很小）；配合 5a 的 `no-store` 修 §10 #17。
   骨架屏只在无数据的首次加载显示，重取时保留旧数据（旧 `App.vue:72,125`）。旧 `stores/*`、`useCollectionLoader`、`useDetailCache` 不迁。
6. **路由与页面**：
   - `src/web/router.ts`：`/certificates/:id([0-9a-f]{64})`、`/crls/:targetId(<UUID 正则>)`，其余进 `/:pathMatch(.*)*` →
     `NotFoundPage.vue`；格式不符的 id 不发请求（§10 #2 的 UI 侧）。详情页懒加载；`document.title` = `<页面> · <siteName>`。
   - `src/web/App.vue`（壳）：页头 `import.meta.env.VITE_SITE_NAME`（删 i18n `app.title`）、`LocaleSelect`、`ThemeToggle`；`<RouterView>`；
     页脚不写 "Cloudflare Workers"（§10 #18 UI 部分）；`<Toaster />`；统一一个最大宽度。
   - `pages/OverviewPage.vue` + `components/overview/{StatsBar,CertificateTable,CrlTargetTable,CrlUploadCard}.vue`（参考
     `…:src/web/App.vue`、`CertificateCard.vue`、`CrlCard.vue`）：统计条的计数取 `stats`，`totalRevocations` 为 `null` 显示"未知"；
     "需关注"等时间相关数用 `useClock` 按徽标同一规则在客户端算。证书表：`label ?? summary.subjectCN`，缺省 "Unknown Certificate"；
     目标表：类别色（证书蓝、full 紫、delta 绿）、`CRL #n`、吊销数、未发布显示"未发布"（吊销数显示 "—"）；相对时间只对 valid / current 显示。
     排序（默认值，可推翻）：证书按显示名；目标按 `label`，同名 full 在 delta 前。
   - `pages/CertificatePage.vue` + `components/certificate/CertificateOverview.vue` ← `…:src/web/components/CertificateDetails.vue`：
     Tabs = 概览（主体 / 签发者 `NameDetails` 含 `rfc4514`、有效期与相对时间规则 `:47-59`、序列号、公钥摘要 `:20-37`、签名算法含参数
     （§10 #28：一次请求拿全部分区，不再出现 Unknown）、ECDSA `(r, s)`、指纹、`issuerUniqueID` / `subjectUniqueID`、该证书作为签发者的
     CRL 目标链接（§10 #10））/ 扩展（`ExtensionList`）/ 原文（默认值：取 `downloads` 中 `.pem` 路径的文本 + 复制；无 `.pem` 路径时不显示该 Tab）。
   - `pages/CrlTargetPage.vue`（取代切片 1 的占位 `CrlPage.vue`，`tests/web/router.test.ts` 同步）+ `components/crl/RevokedTable.vue`
     ← `…:src/web/components/CrlDetails.vue`：页头（标签、类别、状态、下载）；概览（签发者链接 → `/certificates/:id`、CRL 号与 base 号
     （旧 UI 只在扩展里出现）、thisUpdate / nextUpdate / nextPublish、算法、指纹）；吊销列表（未发布不显示列表，不再把未知显示成 0（§10 #7）；
     0 → 空状态；列同 plan §8，表头吸顶，超过 200 行按 200 行一页客户端分页）；扩展。
     `current: null` → 页头 + "未发布"；`ApiError` `not_found` → 页内"不存在"状态。
7. **上传卡片** `CrlUploadCard.vue` ← `…:src/web/components/CrlUpload.vue`：保留提交守卫 `:22`、仅当输入未变才清空 `:28`、拖放取第一个文件
   `:31-48`、重置 file input `:53`、`accept=".crl,.pem,.der"`、仅非空文本才提示 PEM 无效、按钮内 spinner；上传进行中禁用按钮（不并发）。
   - 发送：文件原样；粘贴的 PEM 包成 `new File([text], "crl.pem", { type: "application/x-pem-file" })`，都走 multipart `crl`（M8：不发字符串字段），
     服务端按字节识别 PEM / DER。
   - 结果：`upload.outcome.{created,updated,unchanged}` 整句文案，`unchanged` 是成功而非错误（§10 #4 UI 部分）；标签按 `target` 从 `["crls"]`
     缓存查，查不到用 `kind`；行内成功 Alert 列出 `downloads`。
   - 错误：`error.code` → `errors.<code>`，toast.error + 行内 destructive Alert；未知码显示 `errors.unknown` 与原始 code。
   - 上传令牌（默认值，可推翻）：卡片内折叠的密码输入框，只存内存（不进 localStorage / sessionStorage），非空时经 `api` 的每请求 `headers`
     发 `Authorization: Bearer …`（`hc` 全局 `init` 只放 `cache`）；收到 `unauthorized` 自动展开并聚焦；空令牌不发头，避免 bearerAuth 的 400。
8. **i18n**：`src/web/i18n.ts` ← `…:src/web/i18n.ts`，保留 `createI18n({ legacy: false, globalInjection: true, fallbackLocale: "en" })`；
   locale 只有 `en`、`zh-CN`；检测顺序 存储值 → `navigator.languages` 中第一个受支持项（`zh*` → `zh-CN`，`en*` → `en`，其余跳过；
   修旧 `normalizeLocale` 永不返回 null 导致只看第一项）→ `en`；键沿用 `locale-preference`，旧值 `en-US` / `en-GB` 映射为 `en`；
   所有存储读写包 try/catch（旧代码在模块导入时裸读 localStorage）；切换时写 `document.documentElement.lang`。
   `src/web/composables/useLocale.ts` 重写为 `useStorage("locale-preference")`。`Intl` 用消息 locale，不保留 en-GB 区域格式（默认值）。
   `src/web/locales/en.json` ← `…:src/web/locales/en.json`：删未用键（`status.active`、`extension.unknownType`、
   `upload.errors.noValidContent`、`upload.errors.readFile`、`upload.helpers.der`）、v2 形状键（`upload.status.*`、`certificateCard.*`、
   `crlCard.*`）与 `app.title`；新增 `upload.outcome.*`、`errors.<code>`（全部 v1 错误码 + `network`、`invalid_response`、`unknown`）、
   统计与表头、`crl.unpublished`、`common.copy` / `copied`、主题与令牌文案。新建完整翻译的 `src/web/locales/zh-CN.json`。
9. **主题**：`ThemeToggle.vue`（重写 `worker-aia-cdp@5b570aa:src/web/components/ThemeToggle.vue`）用 `useColorMode({ storageKey: "theme-preference" })`
   并解构 `store`（模板自动解包，`mode.store` 不可达）；取值 `auto` / `light` / `dark` 与旧 `…:src/web/composables/useTheme.ts` 相同，
   同域已有偏好直接生效（切片 1 已用该键）。循环 auto → light → dark，文案走 i18n。`src/web/index.html` 加预绘制内联脚本：
   try/catch 读 `theme-preference`，在首帧前设 `dark` 类，消除旧版的亮色闪烁。
10. **CSP**（按末节第 1 项 owner 确认的结果；下为推荐默认）：`src/http/csp.ts` 定义策略与预绘制脚本的 `sha256-…`，`src/http/app.ts` 改为
    `secureHeaders({ strictTransportSecurity: false, contentSecurityPolicy: … })`；UI 响应经 `deps.ui` 由同一个 app 发出（切片 1 已复制 ASSETS 响应），
    两条运行时一致。策略：`default-src 'self'; script-src 'self' 'sha256-<预绘制脚本>'; style-src 'self'; img-src 'self' data:; connect-src 'self';
    object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'`。冒烟发现样式违规再放宽为 `style-src 'self' 'unsafe-inline'`
    （hono-node spike 预计 vue-sonner 需要）；若 vue-i18n 运行时编译触发违规，改为构建期预编译消息。
11. **体积与依赖卫生**：`scripts/check-web-size.ts`（`node scripts/check-web-size.ts`）对 `dist/web/index.html` 与 `dist/web/assets/*.{js,css}`
    逐个 `zlib.gzipSync` 累加，打印每文件、首屏（`index.html` 引用的 script / modulepreload / stylesheet）与总计，总计 > 250 000 字节退出 1；
    `package.json` 加 `size:web`，接进 `ci:worker`（它本来先构建 `dist/web`）。`vite.config.ts` 加 `apply: "build"` 的小插件：解析到
    `src/{core,http,storage,runtime,cli}/` 或 `zod`、`@hono/zod-openapi`、`pkijs`、`asn1js` 即构建失败（`hono/client` 放行；总则 §2.1）。
    基线：web spike 骨架 125.7 kB JS + 9.4 kB CSS gzip（首屏约 111 kB）。
12. **清理**：旧 `@heroicons/vue`、`pinia`、`lucide-vue-next` 不进依赖；`SectionState.vue`、`pagination.ts`、`useTheme.ts` 不迁（见出口 6 的 grep）。

## 测试

除注明者外全在 vitest `web` 项目（happy-dom）；夹具形状用 `satisfies` 对齐 `@/client/types`，不手写宽松对象。

| 文件 | 内容 | 来源 |
| --- | --- | --- |
| `tests/web/status.test.ts` | 旧 2 例原样 + 无 `nextUpdate` → unknown、`unpublished`、`nextPublish` 规则、证书 `expiring`、`now == notAfter` 仍 valid | `worker-aia-cdp@5b570aa:tests/web/status.test.ts` |
| `tests/web/upload-input.test.ts` | 旧 2 例不改 | `…:tests/web/upload-input.test.ts` |
| `tests/web/dates.test.ts` | 时区标签、分钟取整与进位、`h23`（UTC 00:05:07 不是 24:05:07）、注入 `nowMs`、zh-CN 文案 | 新 |
| `tests/web/format.test.ts`、`tests/web/x509.test.ts` | hex 分组 / 规范化；`formatAlgorithm` 的 PSS / 命名曲线 / NULL；`formatGeneralName` 的 otherName；`formatName` 用 `rfc4514` | 新 |
| `tests/web/extension-blocks.test.ts` | 每个 `extensionType` 一例（41 例），断言块种类与关键文本；遍历 5a schema 的判别值，断言每个都有用例且没有块落到兜底；AD CS 私有扩展（CA Version `v0.0`、模板名、Next CRL Publish、CRL Self CDP）用合成夹具同款值 | 新（旧渲染改动零测试） |
| `tests/web/components.test.ts` | `NameDetails` 转义与空字段标签；`ExtensionList` 关键在前且不改原数组；`DownloadLinks` DER / PEM / 空；`GeneralNameList`、`DistributionPointList`（reasons、cRLIssuer）、`Asn1Dump` 缩进；`ExtensionView` 未解析 → dump + hex | `…:tests/web/components.test.ts` 改写（旧第 4 例移到下一行） |
| `tests/web/revoked-table.test.ts` | 未发布目标不渲染表格；0 → 空状态；15 行全显示（服务端 10 条截断见切片 5a）；201 行 → 两页 | 新 |
| `tests/web/queries.test.ts` | 上传后的刷新胜过上传前已发出的列表请求（延迟 mock）；`fetch` 收到 `cache: "no-store"`；404 不重试、500 重试一次 | `…:tests/web/collection-loader.test.ts` 第 3 例改写 |
| `tests/web/upload-card.test.ts` | PEM 粘贴发 multipart `File`；三种结果文案；错误码映射与未知码；401 展开令牌框；令牌进 `Authorization`，空令牌不发头；进行中禁止再提交；提交后改过输入则不清空 | 新 |
| `tests/web/i18n.test.ts`、`tests/web/locales.test.ts` | `["fr-FR","zh-CN"]` → zh-CN；存储 `en-GB` → en；localStorage 抛错仍能启动；`<html lang>`；zh-CN 与 en 键集合相同；5a 错误码数组每项在两种语言都有文案 | 新 |
| `tests/web/theme.test.ts` | 预置 `theme-preference=dark` → `html.dark`；切换写回同一键 | 新 |
| `tests/web/pages.test.ts` | 三页在 mock `fetch` 下渲染；签名算法显示带参数的名称（§10 #28）；未发布目标；API 404 → 不存在状态；非法 id → NotFound 且不发请求；页头为 `VITE_SITE_NAME` | 新 |
| `tests/http/csp.test.ts`（`http` 项目） | 从 `src/web/index.html` 取内联脚本算 sha256，等于 `src/http/csp.ts` 中的值；UI 响应带该 CSP | 新（采纳 CSP 时） |

旧 `tests/web/state.test.ts` 与 `api-client.test.ts` 的去向见切片 5a / 4。浏览器冒烟 `scripts/ui-smoke.ts`（`playwright-core` 1.64.1，web spike
验证过的版本，devDependency；浏览器取 `AIA_CHROMIUM` 或 `~/.cache/ms-playwright/chromium_headless_shell-*`，不进 `ci:*`）：en / zh-CN ×
亮 / 暗；总览加载；深链 `/certificates/<id>`、`/crls/<uuid>` 刷新；展开 CA Version 扩展；粘贴 PEM 上传 → created、再传 → unchanged、旧 CRL →
`stale_crl` 行内 Alert；主题跨刷新保持；未知路径 → NotFound；控制台 0 error / warning、0 `securitypolicyviolation`。

## 出口条件

1. （见总则 §1.3）
2. `pnpm exec vitest run --project web` 退出 0，上表文件齐全，`extension-blocks.test.ts` ≥ 41 例；`pnpm exec vitest run tests/http/csp.test.ts` 退出 0。
3. `pnpm run build:web && pnpm run size:web` 退出 0，打印总计 ≤ 250 000 字节 gzip；实测数字写进合并提交说明。构建插件未报服务端模块泄漏。
4. 两条运行时 SPA 兜底复验：`pnpm run ci:test`（`smoke:node` 用真实 `dist/web`）与 `pnpm run ci:worker`（createTestHarness 冒烟）通过；
   `wrangler dev` 下切片 1 的冒烟同样通过（`/crls/<uuid>` → `index.html`，`/crl/missing.crl` → 文本 404，`/api/v1/missing` → JSON 404，C12）。
5. `node scripts/ui-smoke.ts http://127.0.0.1:8080`（Node 运行时，fs 存储）与 `http://127.0.0.1:8787`（`wrangler dev`）全部 PASS；
   两者都先经 CLI 从 `tests/fixtures/pki/` 导入并 `config apply`。
6. `! grep -rnE "Cloudflare Workers|__SITE_NAME__|app\.title|lucide-vue-next|@heroicons|pinia" src/web package.json` 退出 0。
7. 浏览器里人工看一遍：亮 / 暗两种主题对比可读，zh-CN 下总览、两种详情、上传无英文漏翻。

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| 41 个 `extensionType` 字面量与字段名是 5a 与 5b 之间的契约 | 穷尽 switch + 测试遍历 schema 判别值；5a 之后改契约必须在同一分支里改 `extension-blocks.ts` |
| 渲染改动无测试也能"web 测试通过" | 出口 2 要求 ≥ 41 例，且断言无兜底块 |
| nova 风格未经 spike 验证（spike 用 vega）；registry 线上漂移 | 步骤 1 生成后人工过一遍；生成文件入库，升级前 `shadcn-vue diff` |
| 体积随 Reka 组件增长 | 详情页懒加载（spike：Tabs / Accordion 落在 13 kB 的懒加载块）；超标先开 vue-i18n 特性开关（约 1.6 kB）、再预编译消息（约 6 kB） |
| `import type` 失守把 zod / hono 打进包 | `consistent-type-imports` + 步骤 11 构建插件硬失败 |
| 状态阈值与 AD CS 周期冲突，徽标与统计不一致 | 末节第 2 项；统计中的时间相关数只在客户端用同一时钟算 |
| 设了 `AIA_UPLOAD_TOKEN` 后 UI 上传不可用 | 步骤 7 令牌框；401 时引导输入 |
| CSP 误伤运行时注入样式或消息编译 | 冒烟监听 `securitypolicyviolation`；按步骤 10 的两条退路调整 |
| 大 CRL 详情 JSON 无上限 | 现网 0 条吊销，可接受；客户端分页避免一次渲染上千行 |
| `src/web` 下名为 `api`、`ca`、`crl`、`dcrl` 的目录会被 dev 代理吞掉（web spike，见 plan §8） | 客户端目录固定 `src/web/client/`，评审时检查 |

## 开工前需 owner 确认

2026-10-20 已确认：两项均取推荐默认（附录 C）。

1. **CSP**。推荐：采纳步骤 10 的策略，以响应头下发（`secureHeaders` 的 `contentSecurityPolicy`，两条运行时同一份），预绘制主题脚本用
   hash 放行；冒烟出现违规时只放宽 `style-src`。备选：不加 CSP，仍保留其余 `secureHeaders` 默认值与 `strictTransportSecurity: false`。
2. **状态阈值**（须在切片 5a 开工前定，切片 5a 的 owner 项指向这里）。旧 80% 规则让健康的 AD CS full CRL 每周约 24 h 显示 Stale
   （现网 full 有效约 180 h，Next CRL Publish 在约 168 h），"nextUpdate 7 天内"则几乎让所有签发 CA 的 CRL 常亮。推荐：CRL 有
   `nextPublish`（`1.3.6.1.4.1.311.21.4`）时，`now` 超过它 1 h 仍未更新才算 stale（1 h 吸收 CA 发布到助手上传的延迟）；没有时（如离线
   OpenSSL 根 CRL，半年有效）沿用 80% 规则（即剩余不足总有效期 20%）；统计条的"即将过期"改为"需关注" = stale + expired + unknown
   目标数，客户端用 `useClock` 计算，`/api/v1/stats` 不含时间相关字段；证书增加 `expiring`，阈值为剩余不足有效期的 10%（根 20 年 →
   2 年，签发 CA 10 年 → 1 年）。`nextPublish` 总会记录（切片 4）并出现在 5a 列表项，本项只决定徽标规则与 `/api/v1/stats` 是否含时间字段。
