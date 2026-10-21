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
- 冒烟数据：`pnpm run seed:dev`（切片 2 的 `scripts/seed-dev.ts`，经 CLI `import` / `config apply` 灌入已入库的 `tests/fixtures/pki/`）。
  切片 2 说 CRL 发布"在切片 4 加"，切片 4 没加，本切片补上：除 issuing-ca-2 的 delta 外每个目标发布一个 CRL（root-ca `full-01`、
  issuing-ca-1 `full-adcs` + `delta-adcs`、issuing-ca-2 `full-01`），留一个未发布目标给页面的"未发布"状态和浏览器冒烟的 `created` 上传；
  再跑一次全部 unchanged（`tests/integration/node-e2e.test.ts`，它也核对 issuing-ca-1 的两个目标确是那对 AD CS CRL）。

## 步骤

1. **组件**：`pnpm dlx shadcn-vue@2.8.2 add <名单> --yes < /dev/null`，名单为下列中切片 1 尚未生成的
   `accordion alert badge button card collapsible input label skeleton sonner table tabs textarea tooltip`。之后：新包用 `pnpm add -D` 挪到
   devDependencies（总则 §2.3）；`sonner` 带来 `vue-sonner`，在 `src/web/main.ts` 加 `import "vue-sonner/style.css"`（B2）；确认 `components.json`
   无 `font` 键、`main.css` 无 Google Fonts `@import`；
   `pnpm exec prettier --write src/web/styles/main.css components.json src/web/components/ui src/web/lib`（同切片 1 步骤 6）。
   不引入 `@tanstack/vue-table`：分页只是 `slice()`（默认值，可推翻）。
   注意：切片 1 只生成过 `button`、`badge`，其余 nova 组件是首次生成（见风险表）；生成文件与 lockfile 一并提交（plan §8）。
   nova 组件的 `data-open:`、`data-active:`、`group-data-horizontal/tabs:` 等状态变体定义在 shadcn-vue 包自带的 `tailwind.css`，`init` / `add`
   都不导入它；Tailwind 内置的 `data-*` 变体匹配的是 Reka UI 不设的属性（`[data-open]` 而非 `[data-state="open"]`），Tabs 会丢掉布局与选中态。
   因此把该文件的 9 个 `@custom-variant` 原样抄进 `main.css`（不加 shadcn-vue 依赖；手风琴关键帧由 `tw-animate-css` 提供）。生成代码触发的
   ESLint 规则只在 `src/web/components/ui/**` 关闭（`Input.vue`、`Textarea.vue` 的 `prefer-function-type`）。
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
   switch 写成穷尽（`const _exhaustive: never = value`），随 5a 删除 `unknown` 一并删 `json` 块，剩 plan §8 的 7 种块；运行时遇到本构建
   不认识的类型（更新的服务端）返回 `null`，`ExtensionView` 按未解码显示（ASN.1 dump + 原始 hex）。保留块内固定文本
   （`${name} (${code})`、模板版本 `major.minor`、SCT `hash/signature`、子树范围 ` [min–max]`）。组件迁到 `src/web/components/x509/`，
   来源均为 `worker-aia-cdp@5b570aa:src/web/components/<同名>.vue`：`ExtensionView.vue`（`AccordionItem`：名称 / OID、Critical 徽标、
   解析状态徽标；未解析时 `parseError` + `Asn1Dump` + 原始 hex `Collapsible`）、`ExtensionList.vue`（关键在前、`localeCompare`、
   对副本排序，`Accordion type="multiple"`）、`GeneralNameList.vue`、`DistributionPointList.vue`、`Asn1Dump.vue`、`NameDetails.vue`。
   `TAG_TONES`（blue / purple / amber）改为 Badge 的 cva 变体，颜色只用 token（`components/x509/TagList.vue`：blue → secondary 填充、
   purple → 描边、amber → `warning`；同一扩展内只需区分这几类）。
4. **通用组件**：`StatusBadge.vue`（Badge 上的 cva 状态表，加 `unpublished`、`expiring`，删未用的 `showLabel`；`main.css` 为此新增
   `--success` / `--warning` 两个主题 token，亮 / 暗各一值，与 `destructive`、`muted` 一起覆盖全部状态。徽标文字压在自身 10%（暗色 20%）
   的底色上，叠在页面、卡片或悬停的表格行上都要 ≥ 4.5:1（WCAG AA，小字）：亮色 `--success`、`--warning` 与 `--destructive`、暗色
   `--destructive` 因此比 shadcn 原值调深 / 调浅，`unpublished` 改为虚线描边（灰字压灰底只有 4.35:1），`tests/web/contrast.test.ts`
   从 `main.css` 的 token 与组件实际类名按 sRGB 合成计算）；`HexValue.vue` 与 `PemText.vue`（复制经 `composables/useCopy.ts` →
   `utils/clipboard.ts`：先 Clipboard API `writeText`，被拒或非安全上下文时退回选中的离屏 `<textarea>` + `document.execCommand("copy")`，
   返回 `false` 即失败；两者都不行才 toast。不用 vueuse 的 `useClipboard`：它的 legacy 路径不看 `execCommand` 的返回值，失败也显示
   "已复制"，toast 永远出不来。复制 / 已复制文案走 i18n，复制后焦点回到按钮）；`DownloadLinks.vue`（依据
   `…:src/web/components/ResourceCard.vue:44-51,76-85`：由 `downloads[]` 驱动，`.pem` 结尾标 PEM 否则 DER，`<a download>`，空列表 "—"；
   类名经 `cn(buttonVariants(…))`，否则基础类的 `border-transparent` 压过变体的 `border-border`，亮色下没有描边；同一资源有多条 DER
   路径时在格式后显示文件名（末段），否则几对 DER / PEM 无从区分）；
   `KeyValueList.vue`（取代 `FingerprintDetails.vue` 与各处重复的 `dt/dd` 类名）；`LocaleSelect.vue`（取代切片 1 的 `LocaleSwitch.vue`）。
5. **查询层** `src/web/client/queries.ts`：键 `["health"]`、`["stats"]`、`["certificates"]`、`["certificate", id]`、`["crls"]`、
   `["crl", targetId]`，`queryFn` 一律 `unwrap(await api…$get(…, { init: { signal } }))`（传 TanStack 的 `signal`，取消即中止请求；
   `["health"]` 除外：沿用切片 1 `HealthBadge` 按状态码读，见前置）。
   `src/web/main.ts` 的 `QueryClient`（`createQueryClient()`，测试共用）：`staleTime: 0`、
   `retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 1`（4xx 不重试，否则详情页的 404 要等几秒；
   `network` 的 `status` 是 0，与 5xx 一样重试一次。TanStack 传入的 `n` 是此前的失败次数，首次失败为 0，写成 `n < 2` 会重试两次）、
   `refetchOnWindowFocus` 保持默认。
   `useUploadCrl()` = `useMutation`，成功后先 `cancelQueries()` 再 `invalidateQueries()` 全量失效（数据量很小）：TanStack 的 invalidate
   不重启尚无数据的首次加载，上传前发出的列表请求会在之后落地并留下旧数据，先取消即丢弃它；配合 5a 的 `no-store` 修 §10 #17。
   骨架屏只在无数据的首次加载显示，重取时保留旧数据（旧 `App.vue:72,125`）。旧 `stores/*`、`useCollectionLoader`、`useDetailCache` 不迁。
6. **路由与页面**：
   - `src/web/router.ts`：`/certificates/:id([0-9a-f]{64})`、`/crls/:targetId([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`，
     两条都 `sensitive: true`（vue-router 默认忽略大小写；只认 API 发出的小写 id），其余进 `/:pathMatch(.*)*` →
     `NotFoundPage.vue`；格式不符的 id 不发请求（§10 #2 的 UI 侧）。详情页懒加载；`document.title` = `<页面> · <siteName>`
     （`composables/usePageTitle.ts`，详情页用证书显示名 / 目标标签，"不存在"状态用其标题）。`scrollBehavior`：前进 / 后退回到原位置，
     带片段（跳到内容的 `#main`）滚到该元素，只改查询或片段不动，其余回到顶部——不设时链接沿用上一页的偏移，数据已缓存的页面整页
     立即渲染，手机上会直接停在页脚。
   - `src/web/App.vue`（壳）：页头 `import.meta.env.VITE_SITE_NAME`（删 i18n `app.title`）、`LocaleSelect`、`ThemeToggle`；`<RouterView>`；
     页脚不写 "Cloudflare Workers"（§10 #18 UI 部分；改为站点名 + `/api/v1/openapi.json` 链接）；`<Toaster position="top-center" />`
     （默认右下角会盖住上传卡片的提交按钮，指针停在上面时还不消失）；统一一个最大宽度。
   - `pages/OverviewPage.vue` + `components/overview/{StatsBar,CertificateTable,CrlTargetTable,CrlUploadCard}.vue`（参考
     `…:src/web/App.vue`、`CertificateCard.vue`、`CrlCard.vue`）：统计条的计数取 `stats`，`totalRevocations` 为 `null` 显示"未知"；
     "需关注"等时间相关数用 `useClock` 按徽标同一规则在客户端算。证书表：`label ?? summary.subjectCN`，缺省 "Unknown Certificate"；
     目标表：类别色（证书蓝、full 紫、delta 绿；`KindBadge.vue`，详情页头同用）、`CRL #n`、吊销数、未发布显示"未发布"（吊销数显示 "—"）；
     相对时间只对 valid / current 显示（证书的 `expiring` 是旧 valid 的最后 10%，同样显示）。未发布目标的下载列显示 "—"（路径在发布前是 404）。
     排序（默认值，可推翻）：证书按显示名；目标按 `label`，同名 full 在 delta 前。
     手机（`sm` 以下）两张表只留名称 / 标签、类别与状态，签发者、有效期、CRL 号、更新时间、吊销数与下载以 `hidden sm:table-cell` 隐藏：
     列全显示时表格在卡片内横向滚动（滚动条是覆盖式的，看不出能滚），状态列落在视口外，而状态正是总览要看的；被隐藏的内容在详情页
     一点即达。代价是手机上总览不再给下载与日期。名称列的最小宽度只在 `sm` 以上保留（那里列仍可能多于宽度），手机上 390 / 360 px
     都放得下三列，320 px 时英文"Not published"会让目标表多出约 10 px 的表内滚动。
   - `pages/CertificatePage.vue` + `components/certificate/CertificateOverview.vue` ← `…:src/web/components/CertificateDetails.vue`：
     Tabs = 概览（主体 / 签发者 `NameDetails` 含 `rfc4514`、有效期与相对时间规则 `:47-59`、序列号、公钥摘要 `:20-37`、签名算法含参数
     （§10 #28：一次请求拿全部分区，不再出现 Unknown）、ECDSA `(r, s)`、指纹、`issuerUniqueID` / `subjectUniqueID`、该证书作为签发者的
     CRL 目标链接（§10 #10），与总览同序：按标签、同名 full 在前）/ 扩展（`ExtensionList`）/ 原文（默认值：取 `downloads` 中 `.pem`
     路径的文本 + 复制；无 `.pem` 路径时不显示该 Tab）。
   - `pages/CrlTargetPage.vue`（取代切片 1 的占位 `CrlPage.vue`，`tests/web/router.test.ts` 同步）+ `components/crl/RevokedTable.vue`
     ← `…:src/web/components/CrlDetails.vue`：页头（标签、类别、状态与到 nextUpdate 的时间——尚未生效时改为到 thisUpdate，同证书页；
     下载，未发布时 "—"；签发者链接 → `/certificates/:id` 也在页头，未发布时同样可见）；
     概览（CRL 号与 base 号（旧 UI 只在扩展里出现）、thisUpdate / nextUpdate / nextPublish、算法、指纹）；吊销列表（未发布不显示列表，不再把未知显示成 0（§10 #7）；
     0 → 空状态；列同 plan §8，表头吸顶，超过 200 行按 200 行一页客户端分页，翻到首 / 末页时焦点交给另一个翻页按钮（被禁用的按钮会把
     焦点丢到 `<body>`）；序列号是等宽纯文本，不逐行放 `HexValue` 复制按钮——一页 200 个按钮，起初的 `useClipboard` 每个还查两次剪贴板权限）；扩展。
     `current: null` → 页头 + "未发布"；`ApiError` `not_found` → 页内"不存在"状态。
   - 两种详情页共有：`Tabs` 是 `section.grid` 的网格项，加 `min-w-0`，否则 `pre` / ASN.1 dump 的不换行内容把整页撑宽（390 px 下 PEM Tab
     585 px）；Tab 列表 `max-w-full overflow-x-auto justify-start`，放不下时（如 "Revoked Certificates (10000)"）在列表内滚动；Reka 让 Tab
     面板成为 Tab 停靠点，面板加 `focus-visible` 圆环。标题层级 h1 → h2：概览各分区与 `NameDetails` 用 h2，扩展面板放一个只给读屏的
     h2，手风琴标题保持 Reka 默认的 h3。
7. **上传卡片** `CrlUploadCard.vue` ← `…:src/web/components/CrlUpload.vue`：保留提交守卫 `:22`、仅当输入未变才清空 `:28`、拖放取第一个文件
   `:31-48`、重置 file input `:53`、`accept=".crl,.pem,.der"`、仅非空文本才提示 PEM 无效、按钮内 spinner；上传进行中禁用按钮（不并发；
   守卫是组件内在第一个 `await` 前置位的标志，同一 tick 的两次提交也只发一次）。进行中的按钮只是 `aria-disabled`（守卫挡住再次提交），
   真正 `disabled` 会把键盘焦点丢到 `<body>`；结束后若焦点还在按钮上（或已丢失），交给结果 Alert（`tabindex="-1"`，带 `focus-visible`
   圆环）——成功后清空的输入会让按钮变成 `disabled`。
   - 发送：文件原样；粘贴的 PEM 包成 `new File([text], "crl.pem", { type: "application/x-pem-file" })`，都走 multipart `crl`（M8：不发字符串字段），
     服务端按字节识别 PEM / DER。
   - 结果：`upload.outcome.{created,updated,unchanged}` 整句文案，`unchanged` 是成功而非错误（§10 #4 UI 部分）；标签按 `target` 从 `["crls"]`
     缓存查，查不到用 `kind`（`upload.kindTarget.<kind>`）；行内成功 Alert 列出 CRL 号与 `downloads`。
   - 错误：`error.code` → `errors.<code>`，toast.error + 行内 destructive Alert；未知码显示 `errors.unknown` 与原始 code。带 `details.reason`
     （`invalid_crl` 的解析原因、`issuer_not_found` 的 `missing_aki`）时附 `upload.reasons.<reason>`，本构建不认识的原因原样显示。
   - 上传令牌（默认值，可推翻）：卡片内折叠的密码输入框，只存内存（不进 localStorage / sessionStorage；模块级 `composables/useUploadToken.ts`，
     去详情页再回来仍在，刷新即失），去首尾空白后非空时经 `api` 的每请求 `headers`
     发 `Authorization: Bearer …`（`hc` 全局 `init` 只放 `cache`）；收到 `unauthorized` 自动展开并聚焦；空令牌不发头，避免 bearerAuth 的 400。
     发送前按 RFC 6750 b64token（`/^[A-Za-z0-9._~+/-]+=*$/`）校验，不符即不发请求，显示 `upload.token.invalid`（toast + 行内，`data-code`
     为 `invalid_token`）并聚焦令牌框：服务端本就不收，而 hono/client 经 `Headers.set` 设头时对非 Latin-1 文本直接抛 `TypeError`，
     原先只显示"Unexpected error (TypeError)"。
8. **i18n**：`src/web/i18n.ts` ← `…:src/web/i18n.ts`，保留 `createI18n({ legacy: false, globalInjection: true, fallbackLocale: "en" })`；
   locale 只有 `en`、`zh-CN`；检测顺序 存储值 → `navigator.languages` 中第一个受支持项（`zh*` → `zh-CN`，`en*` → `en`，其余跳过；
   修旧 `normalizeLocale` 永不返回 null 导致只看第一项）→ `en`；键沿用 `locale-preference`，旧值 `en-US` / `en-GB` 映射为 `en`；
   所有存储读写包 try/catch（旧代码在模块导入时裸读 localStorage）；启动与切换时写 `document.documentElement.lang`（`i18n.ts` 内的 watch，
   不再放在 `App.vue`）。`createI18n` 第三个类型参数为 `false`（全局 `locale` 才是 ref 类型）。
   `src/web/composables/useLocale.ts` 重写为 `useStorage("locale-preference")`（`onError` 为空：存储被禁时只是记不住，不往控制台报错），
   `LocaleSelect.vue` 经它切换并记住选择；其他标签页的选择（storage 事件）同样生效。`Intl` 用消息 locale，不保留 en-GB 区域格式（默认值）。
   `src/web/locales/en.json` ← `…:src/web/locales/en.json`：删未用键（`status.active`、`extension.unknownType`、
   `upload.errors.noValidContent`、`upload.errors.readFile`、`upload.helpers.der`）、v2 形状键（`upload.status.*`、`certificateCard.*`、
   `crlCard.*`）与 `app.title`；新增 `upload.outcome.*`、`errors.<code>`（全部 v1 错误码 + `network`、`invalid_response`、`unknown`）、
   统计与表头、`crl.unpublished`、`common.copy` / `copied`、主题与令牌文案。新建完整翻译的 `src/web/locales/zh-CN.json`。
   旧文件中新 UI 不再用到的键不迁：`extension.oid`、`common.from` / `until`、`common.showingFirst`（由吊销表的分页文案
   `details.crl.range` 取代）、`common.delta` / `full`（由类别徽标的 `kind.*` 取代）、`app.sections.deltaCrls`（full 与 delta 同表）、
   `details.crl.status`（状态是页头的徽标）；
   `app.footer` 改写（不含 "Cloudflare Workers"）。
9. **主题**：`ThemeToggle.vue`（重写 `worker-aia-cdp@5b570aa:src/web/components/ThemeToggle.vue`）用
   `useColorMode({ storageRef, disableTransition: false })`（`disableTransition` 每次切换插入一个 `<style>` 元素，
   不含 `'unsafe-inline'` 的 `style-src` 会拦）；`storageRef` 是自建的 `useStorage("theme-preference", "auto", …, { onError })`，因为
   `useColorMode` 不把 `onError` 传给内部的 `useStorage`，存储被禁时会往控制台报 `SecurityError`；取值 `auto` / `light` / `dark`
   与旧 `…:src/web/composables/useTheme.ts` 相同，同域已有偏好直接生效（切片 1 已用该键）。循环 auto → light → dark，文案走 i18n。`src/web/index.html` 加预绘制内联脚本：
   try/catch 读 `theme-preference`，在首帧前设 `dark` 类，消除旧版的亮色闪烁。规则同 `useColorMode`：存的是 `dark`，或是 `auto` /
   未存且系统偏好深色；其他值不设。该脚本是页面唯一的内联脚本，Vite 原样拷进 `dist/web/index.html`（步骤 10 按字节算 hash）。
10. **CSP**（末节第 1 项，owner 已确认）：`src/http/csp.ts` 定义策略 `CONTENT_SECURITY_POLICY`（`secureHeaders` 的指令对象）与预绘制脚本的
    `INLINE_SCRIPT_HASHES`，`src/http/app.ts` 改为 `secureHeaders({ strictTransportSecurity: false, contentSecurityPolicy: CONTENT_SECURITY_POLICY })`。
    UI 响应经 `deps.ui` 由同一个 app 发出（切片 1 已复制 ASSETS 响应），两条运行时一致；JSON、下载与错误响应也带同一个头，对它们没有作用。
    策略：`default-src 'self'; script-src 'self' 'sha256-<预绘制脚本>'; style-src 'self'; img-src 'self' data:; connect-src 'self';
    object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'`（上传表单 `@submit.prevent` 后走 `fetch`，从不提交导航）。
    hash 与脚本的同步：hash 写死在 `csp.ts`（Workers 运行时读不到 `index.html`，不现算）；`tests/http/csp.test.ts` 从 `src/web/index.html`
    重算，改了脚本不改 hash 即失败；`vite build` 的插件 `cspInlineScriptCheck`（`transformIndexHtml`，`order: "post"`）对产出的 `index.html`
    再算一次（`inlineScriptHashes`：浏览器的算法，即标签之间的文本，换行先按 HTML 解析器规范为 LF，CRLF 检出不改变 hash），有未列出的内联脚本
    即构建失败。两条退路都没用上（出口 5 的冒烟两条运行时都是 0 个 `securitypolicyviolation`）：Vue 的 `:style`、Reka UI 与 vue-sonner 都经
    CSSOM（`element.style`）设样式，`style-src` 不管；`useColorMode` 不用会插 `<style>` 的 `disableTransition`（步骤 9）；vue-i18n 11 的消息
    编译解释执行 AST，不用 `eval` / `new Function`（产物里没有），`script-src` 无需 `'unsafe-eval'`，也不必预编译消息。
    `public/favicon.svg` 用表现属性 `fill="#1e3050"` 而非内联 `<style>`：单独打开该文件时同一 CSP 会拦下 `<style>`，图形变黑。
11. **体积与依赖卫生**：`scripts/check-web-size.ts [目录]`（`pnpm run size:web`；目录默认 `dist/web`，测试传临时构建）对 `dist/web/index.html` 与 `dist/web/assets/*.{js,css}`
    逐个 `zlib.gzipSync`（默认级别；Vite 构建报告的压缩实现不同，数字略大）累加，打印每文件、首屏（`index.html` 引用的 script / modulepreload /
    stylesheet，标 `*`）与总计；总计 > 250 000 字节或 `index.html` 引用了不存在的文件 → 退出 1，没有构建 → 退出 2。`ci:worker` 在 `build:web`
    之后紧接着跑它。`vite.config.ts` 的 `serverCodeGuard`（`apply: "build"`）在构建结束时遍历模块图，解析到 `src/{core,http,storage,runtime,cli}/`
    或 `zod`、`@hono/zod-openapi`、`pkijs`、`asn1js`，或 `src/web` 的模块导入了 `hono/client` 以外的 `hono` / `@hono/*` 模块（总则 §2.1：
    运行时只放行 `hono/client`；它自己引用的 hono 工具模块导入者在 hono 包内，照常放行）即失败，并列出静态与动态 `import()` 的导入者
    （`import type` 在解析前已擦除，不会触发；内联的 `import { type X }` 留下副作用导入而失败）。两个插件都由
    `tests/integration/web-build.test.ts` 在不写盘的真实 `vite build` 里验证，同一文件还核对 `vite.config.ts` 解析后的插件里有这两个。
    基线：web spike 骨架 125.7 kB JS + 9.4 kB CSS gzip（首屏约 111 kB）。实测（2026-10-20，评审修复后）：总计 165 081 字节（预算的 66%），
    首屏 145 286 字节（`index.html` 655、入口 JS 132 073、CSS 12 558），懒加载块 `ExtensionList` 13 249、`CertificatePage` 3 187、`CrlTargetPage` 3 359。
12. **清理**：旧 `@heroicons/vue`、`pinia`、`lucide-vue-next` 不进依赖；`SectionState.vue`、`pagination.ts`、`useTheme.ts` 不迁（见出口 6 的 grep）。
    `package.json` 的 `description` 写着 "Cloudflare Workers + R2 and Node 24 + disk"，那是项目说明而不是 UI 文本（§10 #18 指 UI 页脚），
    所以出口 6 对 `package.json` 只查依赖名。

## 测试

除注明者外全在 vitest `web` 项目（happy-dom）；夹具形状用 `satisfies` 对齐 `@/client/types`，不手写宽松对象。

| 文件 | 内容 | 来源 |
| --- | --- | --- |
| `tests/web/status.test.ts` | 旧 2 例原样 + 无 `nextUpdate` → unknown、`unpublished`、`nextPublish` 规则（含恰好 +1 h）、证书 `expiring`（含 10% 边界）、`now == notAfter` 仍在有效期内（`expiring`，不是 `expired`） | `worker-aia-cdp@5b570aa:tests/web/status.test.ts` |
| `tests/web/upload-input.test.ts` | 旧 2 例不改 | `…:tests/web/upload-input.test.ts` |
| `tests/web/dates.test.ts` | 时区标签（每个日期用它自己的偏移：St. John's 7 月是夏令时 UTC-2:30）、分钟取整与进位、`h23`（UTC 00:05:07 不是 24:05:07；Node 对 `hour12: false` 也印 00:05，所以另查交给 `Intl.DateTimeFormat` 的选项是 `hourCycle: "h23"`）、注入 `nowMs`、zh-CN 文案 | 新 |
| `tests/web/format.test.ts`、`tests/web/x509.test.ts` | hex 分组 / 规范化；`formatAlgorithm` 的 PSS / 命名曲线 / NULL；`formatGeneralName` 的 otherName；`formatName` 用 `rfc4514` | 新 |
| `tests/web/extension-blocks.test.ts` | 每个 `extensionType` 一例（41 例），断言块种类与关键文本；遍历 5a schema 的判别值，断言每个都有用例且没有块落到兜底；AD CS 私有扩展（CA Version `v0.0`、模板名、Next CRL Publish、CRL Self CDP）用合成夹具同款值；CA Version 两个索引不同时不互换（V1.0） | 新（旧渲染改动零测试） |
| `tests/web/components.test.ts` | `NameDetails` 转义与空字段标签；`ExtensionList` 关键在前且不改原数组、可同时展开多项（`type="multiple"`）；`DownloadLinks` DER / PEM / 空、描边类、多条 DER 路径时的文件名；`StatusBadge` 每种状态、`KindBadge` 每个类别的颜色类；`GeneralNameList`、`DistributionPointList`（reasons、cRLIssuer）、`Asn1Dump` 缩进；`ExtensionView` 未解析 → dump + hex，解析后的策略（OID 带名称、CPS、用户通知、其他限定符）、名称约束（标题与范围）、CRL 分发点、AKI 的签发者标题、IDP 的标志与原因及其色调；`HexValue` / `PemText` 复制：Clipboard API、`<textarea>` 退路（焦点回到按钮）、`execCommand` 返回 `false` → toast | `…:tests/web/components.test.ts` 改写（旧第 4 例移到下一行） |
| `tests/web/revoked-table.test.ts` | 未发布目标不渲染表格；0 → 空状态；15 行全显示（服务端 10 条截断见切片 5a）；恰好 200 行不分页；201 行 → 两页；首 / 末页时焦点交给另一个翻页按钮；条目扩展的原因、失效日期与签发者（时区固定为 UTC，UTC+12 以东已是次日） | 新 |
| `tests/web/queries.test.ts` | 上传后的刷新胜过上传前已发出的列表请求（延迟 mock）；`fetch` 收到 `cache: "no-store"`；404 不重试、500 重试一次；`staleTime` 0 且窗口重获焦点即重取（`refetchOnWindowFocus` 未覆盖）；五个读查询都把 TanStack 的 `signal` 交给请求，取消即中止 | `…:tests/web/collection-loader.test.ts` 第 3 例改写 |
| `tests/web/upload-card.test.ts` | PEM 粘贴发 multipart `File`；拖放取第一个文件并 `preventDefault`；`accept=".crl,.pem,.der"`；三种结果文案；错误码映射与未知码，`details.reason`（含 `issuer_not_found` 的 `missing_aki`）；401 展开令牌框；令牌进 `Authorization`，空令牌不发头，不合 b64token 的令牌不发请求；进行中禁止再提交且按钮保有焦点（`aria-disabled`），同一 tick 的两次提交只发一次，结束后焦点交给结果 Alert；提交后改过输入则不清空 | 新 |
| `tests/web/i18n.test.ts`、`tests/web/locales.test.ts` | `["fr-FR","zh-CN"]` → zh-CN；存储键是 `locale-preference`，`en-GB` → en；localStorage 抛错仍能启动；`<html lang>`；zh-CN 与 en 键集合相同，除缩写（CA、CPS、DNS、IP、PEM、URI、X.400）外每条都与 en 不同；5a 错误码数组每项、服务端每个上传 `details.reason`（`PKI_PARSE_REASONS`、`signature_algorithm_mismatch`、`missing_aki`，即 `utils/errors.ts` 的 `UPLOAD_REASONS`）在两种语言都有文案 | 新 |
| `tests/web/theme.test.ts` | 预置 `theme-preference=dark` → `html.dark`；切换写回同一键；存储被禁时照常切换且控制台无报错（`i18n.test.ts` 同） | 新 |
| `tests/web/contrast.test.ts` | 各状态徽标文字对其底色（叠在页面、卡片、悬停行上）≥ 4.5:1，亮 / 暗两种主题；颜色取 `main.css` 的 token 与 `StatusBadge` 渲染出的类名（`web` 项目的 `css.include` 让 `main.css?raw` 保留原文） | 新（评审） |
| `tests/web/pages.test.ts` | 三页在 mock `fetch` 下渲染，用应用的 `createQueryClient()`（`retryDelay` 0：500 重试一次，404 不重试）；签名算法显示带参数的名称（§10 #28）；目标按 API 的 id 顺序送来（delta 在前）仍按标签、同名 full 在前；证书 `expiring` 也显示剩余时间；delta CRL 的概览（CRL 号与 base 号、thisUpdate / nextUpdate / Next CRL Publish）；未发布目标（无下载链接，签发者链接仍在）；API 404 → 不存在状态与标题；非法 id → NotFound 且不发请求（`tests/web/router.test.ts` 另有只含 hex 与短横的非 UUID）；页头为 `VITE_SITE_NAME`；toast 在顶部；手机隐藏的次要列；尚未生效的 CRL 计时到 thisUpdate；签发的 CRL 目标按总览顺序；标题层级不跳级、Tab 面板的焦点圆环与 `min-w-0`；CRL 页无 vue-i18n 警告 | 新 |
| `tests/http/csp.test.ts`（`http` 项目） | 从 `src/web/index.html` 取唯一的内联脚本算 sha256，等于 `src/http/csp.ts` 中的值；`inlineScriptHashes` 得出同一值（CRLF 副本也是），跳过带 `src` 的脚本；`/`、两种详情、未知 UI 路径的 GET / HEAD 都带该 CSP，JSON 与下载前缀的 404 也带且内容不变（`tests/http/downloads.test.ts` 的头快照同样含它） | 新 |
| `tests/integration/web-build.test.ts`（`integration` 项目） | 真实 `vite build`（不写盘）：类型导入服务端模块与 `hono/client` 通过；运行时导入 `src/core`、`src/http`、`src/storage`、`src/runtime` 的模块（动态 `import()` 同样，报出导入者），`zod`、`@hono/zod-openapi`、`pkijs`、`asn1js`、`hono`、`hono/secure-headers`、`@hono/node-server`，以及内联 `import { type X }` 都失败，断言的是该模块自己的报告行（不是出现在别的导入者里）；预绘制脚本通过，未列出的内联脚本与改了一个字节的预绘制脚本失败；`vite.config.ts` 解析后的插件含这两个检查 | 新 |
| `tests/integration/web-size.test.ts`（`integration` 项目） | `scripts/check-web-size.ts` 量临时目录里的小构建：总计恰好 250 000 字节退出 0、多 1 字节退出 1，`index.html` 引用的文件不存在退出 1，没有构建退出 2；首屏只计 `index.html` 引用的文件 | 新（评审） |

旧 `tests/web/state.test.ts` 与 `api-client.test.ts` 的去向见切片 5a / 4。

浏览器冒烟 `node scripts/ui-smoke.ts BASE_URL [截图目录]`（`playwright-core` 1.64.1，web spike 验证过的版本，devDependency；浏览器取
`AIA_CHROMIUM`，否则 `~/.cache/ms-playwright/chromium_headless_shell-*` 中最新的一个（`pnpm exec playwright-core install --only-shell chromium`；
本机现有的 1243 比 1.64.1 自带的 1248 旧，经 `executablePath` 照样可用）；不进 `ci:*`）。前提：服务刚由 `pnpm run seed:dev` 灌好（issuing-ca-2 的 delta 目标还没有 CRL；再跑一次只有 `created` 那项失败并说明原因）。
en / zh-CN × 亮 / 暗（浏览器语言与配色）各一个上下文：只靠预绘制脚本（入口 JS 换成空脚本）得到配色对应的主题——即该脚本在 CSP 下按 hash 执行；
总览（站名、健康、五个统计、3 张证书与 5 个目标、`<html lang>`、界面语言的页面标题）；深链 `/certificates/<issuing-ca-1>`、`/crls/<其 full 目标>`
各刷新一次，选中的 Tab 有高亮（其余透明），CA Version 扩展展开且带 `accordion-down` 动画、内容为 UI 语言的两行索引，吊销列表行数等于 CRL 的条目数；
上传卡片粘贴 issuing-ca-2 delta 的 PEM → `created`（只在第一个上下文）、再传 → `unchanged`，粘贴 issuing-ca-1 更旧的 `full-01` → `stale_crl`
行内 Alert，文案都与该语言的 locale 文件一致；未知路径与格式不符的 id → NotFound 且不发证书 / CRL API 请求，未知目标 → "不存在"状态；
选与系统相反的主题后刷新仍保持（打包代码与单独的预绘制脚本都如此）。每个上下文要求：控制台无 error / warning（只放过 Chrome 自己为本步骤预期的
响应打的 "Failed to load resource" 行：`stale_crl` 上传的 409、未知目标的 404，按 URL 与状态逐条匹配），无未捕获异常，无 `securitypolicyviolation`
（初始化脚本监听，经 `exposeBinding` 报回）。最后在 390 px 宽（en、亮色）：总览与证书页、CRL 目标页的每个 Tab 都不得横向滚动，总览两张表的
全部状态徽标不滚动表格即可见。给了截图目录时存整页 PNG：`<页面>-<语言>-<主题>.png`（1280×900；overview、certificate、
certificate-extensions、crl、crl-revoked、upload），外加 `overview-en-light-390.png`、`certificate-en-light-390.png`、
`crl-en-light-390.png`。约 15 s。

## 出口条件

1. （见总则 §1.3）
2. `pnpm exec vitest run --project web` 退出 0，上表文件齐全，`extension-blocks.test.ts` ≥ 41 例；`pnpm exec vitest run tests/http/csp.test.ts` 退出 0。
3. `pnpm run build:web && pnpm run size:web` 退出 0，打印总计 ≤ 250 000 字节 gzip；实测数字写进合并提交说明（见步骤 11）。构建插件未报服务端模块泄漏。
4. 两条运行时 SPA 兜底复验：`pnpm run ci:test`（`smoke:node` 用真实 `dist/web`）与 `pnpm run ci:worker`（createTestHarness 冒烟）通过；
   `wrangler dev` 下切片 1 的冒烟同样通过（`/crls/<uuid>` → `index.html`，`/crl/missing.crl` → 文本 404，`/api/v1/missing` → JSON 404，C12）。
5. `node scripts/ui-smoke.ts http://127.0.0.1:8080`（Node 运行时，fs 存储）与 `http://127.0.0.1:8787`（`wrangler dev`）全部 PASS；
   两者都先由 `pnpm run seed:dev` 经 CLI 从 `tests/fixtures/pki/` 导入、`config apply` 并发布 CRL（见前置）。
6. `! grep -rnE "Cloudflare Workers|__SITE_NAME__|app\.title|lucide-vue-next|@heroicons|pinia" src/web && ! grep -nE "lucide-vue-next|@heroicons|pinia" package.json`
   退出 0（`package.json` 的项目说明合法地含 "Cloudflare Workers"，见步骤 12）。
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
| CSP 误伤运行时注入样式或消息编译 | 冒烟监听 `securitypolicyviolation`；按步骤 10 的两条退路调整（实测都没用上） |
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
