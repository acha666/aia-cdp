# 切片 1：骨架、存储端口与适配器

状态：已完成。分支 `slice/1-skeleton` 于 2026-10-19 以 `--no-ff` 合入 `main`（`0b391cc`），出口条件全部通过，只有出口 13 的人工 devcontainer 检查待
owner 执行。本文保留作记录：范围、文件之外的约束与踩坑原因、测试要点和可重复执行的出口命令仍然有效，后续切片按步骤号引用；各文件的确切内容以仓库为准。

## 目标与范围

两条运行时（Workers + R2、Node 24 + fs）从同一个 `createApp(deps)` 提供 UI 占位页、`GET /api/v1/health`（真实的 store / configuration
检查）与 `GET /api/v1/openapi.json`；ObjectStore 端口、memory / fs / r2 适配器与一致性测试在本切片完成（D5）；类型检查、lint、测试、夹具、
Worker 打包、Docker 镜像都能用 `pnpm run ci:<job>` 跑通。处理的缺陷与评审项：

- §10 #15 健康检查真实检查 store 与 configuration，有 `degraded`；#18 `SITE_NAME` 只剩构建期 `VITE_SITE_NAME` 一条通道（UI 的使用见切片 5b）；
  #21 vitest `projects`、无 shell glob、无 `pretest`、幂等夹具；#22 `runtime/node.ts` + Dockerfile；#24 每请求一行 JSON 日志。
- C12：两条运行时上 `/api` 与下载前缀的未命中都不进 UI 兜底。M19 只做"下载前缀未命中 = 纯文本 404"，其余见切片 3。
- 评审 §3.3 风险"shadcn-vue init + Vite 8 + Tailwind 4"在本切片验证（plan §8 末条）。
- 边界护栏（D9，步骤 2、7、12）与 devcontainer（D10，步骤 15）。

不做（各一行）：

- catalog / config schema、条件写重试、`importCertificate`、`applyConfig`、管理路由、CLI、`src/core/pki`、`pkijs`/`asn1js` 依赖：见切片 2。
- 下载路由、下载前缀上的 405、路径匹配（含畸形 `%`）、`Content-Disposition`（M17、M20、C13）：见切片 3。上传与 `bodyLimit`/`bearerAuth`：见切片 4。
- 列表 / 详情 / 统计路由：见切片 5a。真实 UI、`vue-sonner`、偏好迁移：见切片 5b。真实 `wrangler deploy`、`bucket_name`：见切片 7。
- 旧 v2 路由层删除不迁：`worker-aia-cdp@5b570aa:src/worker/utils/json-response.ts`、`api/v2/router.ts`、`api/v2/server.ts`、
  `src/contracts/api.ts`、`tests/worker/json-response.test.ts`。
- 不迁：`.actrc`、`redocly.yaml`、`.github/workflows/pages.yml`、`scripts/generate-docs-index.ts`（无文档站，OpenAPI lint 改为测试断言）、
  `tailwind.config.ts`（Tailwind 4 CSS-first 由 shadcn-vue init 生成）、`tests/data/adcs.ts`（D7）。

## 前置

- OpenSSL ≥ 3.0 CLI（不是 LibreSSL）、bash、Docker Engine ≥ 25（`HEALTHCHECK --start-interval`）。需要联网（npm registry、shadcn-vue registry、
  Docker Hub）；不需要 Cloudflare 登录。Node 24 与 pnpm 见总则 §2.3、§2.4（pnpm 一律经 corepack 按 `packageManager` 解析，npm `latest` 是 pnpm 12；
  不要在没有 `package.json` 的目录跑 pnpm）。

## 步骤

各文件的确切内容以仓库为准，配置文件的选项原因写在文件注释里；下面只记文件里看不出来的约束与踩过的坑。

1. **根文件与依赖**：`package.json`（重写 `worker-aia-cdp@5b570aa:package.json`）、`.npmrc`、`.nvmrc`、`pnpm-workspace.yaml`、`.gitignore`、
   `.gitattributes`、`.prettierrc.json`、`.prettierignore`、`LICENSE`、`pnpm-lock.yaml`（重新生成）。版本见 `package.json`：全部精确版本（B1、B2），
   `dependencies` 只有 `hono`、`@hono/zod-openapi`、`zod`、`@hono/node-server`，浏览器包都是 devDependencies（Docker 运行阶段只装生产依赖）；
   `@vueuse/core` 用 14.x（与 reka-ui 2.11.0 的 `^14.1.0` 同一份，装 15 会出现两份）。
   - `package.json`：不写 `prepare` / `postinstall`（Docker 的 prod-deps 阶段会坏）；`scripts` 一次写全（步骤 12），脚本引用的文件在对应步骤建好之前失败属预期。
   - `pnpm-workspace.yaml`：`ignoredBuiltDependencies: [esbuild, workerd, vue-demi]`；`publicHoistPattern: [espree, eslint-scope]`
     （防 Debian node 的 `Parsing error: Invalid Version: main`）。改动后删 `node_modules` 全新安装才生效。
   - `.gitignore`（迁 `worker-aia-cdp@5b570aa:.gitignore` 后改）：例外 `!.dev.vars.example`（该文件切片 2 新建）；`/tests/fixtures/pki.tmp.*/`（生成器的暂存目录；
     夹具本身入库）；删掉旧的整目录 `tests/fixtures`（会把生成脚本也藏掉）与 `/public/`、`site/`、`.act*`。
   - `.gitattributes`：`*.sh text eol=lf`、`tests/fixtures/pki/** -text`。`.prettierrc.json`、`LICENSE`：从 `worker-aia-cdp@5b570aa` 原样迁入。
     `.prettierignore` 含 `docs/**/*.md`（默认值：手写中文文档的宽表格不交给 Prettier 重排）。

2. **tsconfig 拓扑与边界检查**（B3、B4、D9；约定与拓扑见总则 §2.1、§2.2）。重写 `worker-aia-cdp@5b570aa:tsconfig.json`、`tsconfig.node.json`、
   `tsconfig.app.json`（→ `tsconfig.web.json`），只参考选项。踩过的坑（文件注释里也有）：worker 程序必须显式列 `types`（只 include 时 @types/node
   会自动混入，边界静默失效）；`skipLibCheck`（pkijs / wrangler 的 d.ts 需要）；不开 `exactOptionalPropertyTypes`（生成组件 10 处报错）；web 程序
   `rewriteRelativeImportExtensions: false`（否则 vue-tsc 在 `.vue` 导入报 TS2876）、`moduleResolution: Bundler`（生成代码无后缀）；根 `tsconfig.json` 的
   references 依次 worker、node、web——typescript-eslint 用第一个包含该文件的程序，`src/core` / `src/http` 因此按 Worker 全局检查；`paths` 必须写在根
   `tsconfig.json`（shadcn-vue 只读这个文件）；`tsconfig.build.json` 只 include `src/runtime/node.ts`（tsc 顺依赖图产出），不进根 references。
   - canary：`tests/boundary/worker-canary.ts` 为 `// @ts-expect-error -- process must not exist in the Worker program` + `export type NodeLeak = typeof process;`；
     `tests/boundary/node-canary.ts` 为 `// @ts-expect-error -- R2Bucket must not exist in the Node program` + `export type WorkersLeak = R2Bucket;`。
     类型泄漏会让指令变成"未使用"而编译失败；只写类型别名（避开 `no-unsafe-*`），指令带说明（`ban-ts-comment`）。web 程序经 `import type { AppType }`
     在 lib.dom 下第三次编译 `src/http` 与 `src/core`，这种写法对三套全局类型都成立。
   - `scripts/check-worker-program.ts`（D9）：`node_modules/typescript/bin/tsc -p tsconfig.worker.json --listFilesOnly`，任一行匹配
     `/\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(@types\/node|@hono\/node-server|vite|vitest|wrangler)\//` 即打印条数与前 5 个文件、提示
     `tsc -p tsconfig.worker.json --explainFiles`，`exitCode = 1`；否则打印文件数。`typecheck:boundary` 在 `typecheck` 里紧跟 `types`、先于三套编译
     （Node 类型泄漏时 worker canary 先报 TS2578，会盖住本脚本指明来源的输出）。quality spike 中它抓住了 core 导入 `@hono/node-server` 与
     `import type … from "vite"` 两类漏洞（前者编译与 canary 都放过，后者 canary 只报 TS2578）。

3. **存储端口与适配器**（D5、B14；端口、适配器表与一致性套件见 plan §5.4）：`src/core/store.ts`、`src/core/digest.ts`、`src/storage/{memory,fs,r2}.ts`。
   - `store.ts`：plan §5.4 的 `ObjectStore`，另导出 `PutOptions`、`PutResult`；`assertStoreKey`、`assertStorePrefix`（`""` 列全部，测试清桶用；其余须"一个以上
     合法段 + 结尾 `/`"，拒 `a`、`/a/`、`a//`、`../`、`./`、`a\b/`、NUL）、`isStoreKeySegment`（fs 的 `list` 与临时文件清理用），非法都抛 `TypeError`。
     三个适配器的 `list` 先调 `assertStorePrefix`，其余方法先调 `assertStoreKey`（一个实现，同时是 fs 的穿越防护）；plan §5.1 的全部键与切片 4、6 的列表前缀都满足。
   - `digest.ts`：`sha256Hex(bytes)`，WebCrypto；输入已由 `ArrayBuffer` 支撑时不复制，直接收窄为 `Uint8Array<ArrayBuffer>`（TS 5.9 的 DOM lib 拒收
     `Uint8Array<ArrayBufferLike>`）。
   - memory：`Map`，ETag = 内容 SHA-256；`put` 先 `await` 算摘要，再同步完成比较与写入（两者之间有 `await` 时并发 CAS 会双赢）；`put` 与 `get` 都复制字节；
     `list` 按键排序。语义来源 `worker-aia-cdp@5b570aa:tests/helpers/r2.ts` 的 `MemoryBucket`。
   - fs（新写）：根目录由构造参数给，不自动创建；`get` / `head` 读文件算 SHA-256，`ENOENT` → `null`。`put` 在按键的进程内互斥段里：读当前 ETag → 判条件 →
     `mkdir -p` 父目录 → 同目录写 `.<名>.<uuid>.tmp`（`open(…, "wx")`、写、`sync()`、关闭）→ `rename` → 从键的父目录到根逐级 fsync（不论目录是否本次创建：
     别的 put 刚建还没 sync，或建后失败，目录项都可能还不持久）；任一步失败删临时文件。`list(prefix)` 自己用 `readdir(dir, { withFileTypes: true })` 递归，只进入
     名字符合 `isStoreKeySegment` 的目录（`lost+found`、点开头的目录从不打开，不可读也无妨），只取名字符合段规则的条目（临时文件、`a (copy).der`、`x.der~` 都不是键，
     列出来的键一定能 `get` / `delete`），`size` 来自 `stat`（跟随符号链接），排序；根目录不存在返回 `[]`。`removeTemporaryFiles()` 在同样的目录范围里删除
     `.<段>.<uuid>.tmp`（被 SIGKILL、OOM、断电打断的 put 留下的），返回个数，只在没有 put 进行时调用（Node 入口开始服务前一次）。`delete` 为
     `rm(…, { force: true })`。一个目录一个进程（plan §1）。
   - r2：结构化类型 `R2BucketLike`（`get` / `head` / `put` / `list` / `delete` 子集），所以在 node 程序里也能编译，`new R2Store(env.STORE)` 由 worker 程序证明可赋值。
     `put` 的 `onlyIf` 为 `{ etagMatches: ifMatch }` 或 `{ etagDoesNotMatch: "*" }`，结果 `null` → `precondition-failed`；其他异常（含 R2 单键写速率）原样抛出
     （切片 2 的重试循环也不重试抛错的 `put`）。ETag 用不带引号的 `R2Object.etag`，不用 `httpEtag`（带引号的值传回 `etagMatches` 会抛 `TypeError`）。`list` 跟随
     `truncated` / `cursor`（每页 1000）。来源：`worker-aia-cdp@5b570aa:src/worker/r2/objects.ts`（`putBinary` 的形状；删 `customMetadata`、`getArtifact`、
     `getExistingCRL`）与 `src/worker/r2/listing.ts`（`listAllWithPrefix` 的游标循环；删边缘缓存）。

4. **HTTP 应用**（B7、B8、B10–B12）：`src/http/{types,errors,schemas,log,ui,app}.ts`、`src/http/routes/health.ts`、`src/core/health.ts`。
   - `types.ts`：`AppDeps` 见 plan §4.4（`clientIpHeader` 由入口决定，总则 §2.6）；`AppEnv` 不含 `Bindings`（应用不认识运行时 env）。
   - `schemas.ts`：`ERROR_CODES` = plan §7.3 全部错误码；`errorSchema(codes)` 每个状态码一个 schema；`HealthOk`、`HealthUnavailable` 均 `.openapi()` 命名。
   - `errors.ts`（重写 `worker-aia-cdp@5b570aa:src/worker/api/v2/response.ts`）：`ApiError`（显式字段，非参数属性）→ 信封；`HTTPException` → 按状态取码、库文本换成
     自己的文案、保留 `WWW-Authenticate` / `Allow` / `Retry-After`；其他 → 500 固定文案，栈只进日志；`onMethodNotAllowed` → 信封 + `Allow`；`validationHook` →
     400 `bad_request`，`details.issues`（`issue.path.map(String)`）。
   - `log.ts`：`next()` 之后写一行 `request`，因而记录最终状态（405、500 信封）；`path` 用 `c.req.path`（不含查询串）；不记任何头与体；`requestLog(deps, log)` 的
     `log` 是 `createLogger(deps)` 的结构化 Logger（与 `createErrorHandler(log)` 同一个），不是 `deps.log`。`client`、`pretty` 格式与转义见总则 §2.6。
   - `core/health.ts` + `routes/health.ts`（重写 `worker-aia-cdp@5b570aa:src/worker/api/v2/stats.ts` 的健康部分，它把 `cache: ok` 写死，§10 #15）：
     `head("config.json")` 抛错 → `unhealthy` 503；`null` → `missing`；存在 → `get` 后 `JSON.parse` 且 `version === 1` → `ok`，否则 `invalid`（`get` 抛错按
     `unhealthy`）。两项都 ok 才 `healthy`，`degraded` 为 200；`no-store`；异常写一行 `{"level":"error","msg":"health_store_error","error":{name,message}}`，不进响应体；
     `operationId: "getHealth"` 与 `summary`。切片 2 换成完整 config schema。本切片的测试与冒烟要"已配置"时一律写最小配置
     `{"version":1,"certificates":{},"targets":{},"paths":{}}`（下称最小配置，切片 2 的完整 schema 下仍是 `ok`），不写 `{"version":1}`。
   - `ui.ts` + `app.notFound`：规则表见 plan §4.4（C12）。实现要点：保留前缀 `^/api(?:/|$)` 与 `^/(?:ca|crl|dcrl)/` 在 `reservedPrefixPath`（`%2F` / `%2f` 解码、
     连续 `/` 合并）后的路径上匹配，路由本身仍看原始路径；ui 响应先复制（`new Response(res.body, { status, statusText, headers: new Headers(res.headers) })`，
     workerd 的绑定响应头不可变）再改 `Cache-Control`；`immutable` 只给 `/assets/` 下最后一段带扩展名、非 `text/html`、状态 200 / 206 / 304 的响应，其余（含 SPA
     `index.html` 与 ui 的错误状态，状态码照传）`no-cache`；304 原样返回（头已改写）。
   - `app.ts`：`new OpenAPIHono<AppEnv>({ defaultHook: validationHook })`；中间件顺序 `secureHeaders({ strictTransportSecurity: false })` → `requestLog(deps, log)` →
     `methodNotAllowed({ app, onMethodNotAllowed })` →（认证 / `bodyLimit` 见切片 2、4）→ 路由。`GET /api/v1/openapi.json` 每个 app 实例首次请求时
     `getOpenAPI31Document(OPENAPI_CONFIG)` 序列化并缓存，`public, max-age=300`。返回 `app.route("/api/v1", healthRoutes(deps))` 的链式值（`AppType` 由它推导）；
     导出 `OPENAPI_CONFIG`（`openapi: "3.1.0"`，`info: { title: "aia-cdp API", version: "1" }`）。不注册 `app.get("*")`（会让所有未知路径的 POST 变 405）；
     全部路由在 `createApp` 内注册完（SmartRouter 首个请求后冻结）。

5. **运行时入口**（B6、B13）：`src/runtime/{settings,node-ui,node,worker}.ts`、`wrangler.jsonc`。来源：重写 `worker-aia-cdp@5b570aa:src/worker/worker.ts`
   （保留"`/api` 未命中 JSON 404、下载前缀未命中文本 404、其余交给 ASSETS"的路由规则，现在在 `ui.ts`）与 `src/worker/env.ts`（改为 `wrangler types` 的 `Env` + settings）。
   - `settings.ts`：纯 zod、无 `node:*`（Worker 与 Node 共用）；字段与默认值按 plan §4.2（`PORT` 0–65535、`AIA_STORE` 只有 `fs`、`AIA_TRUST_PROXY` 只接受
     `true` / `false`、`AIA_MAX_UPLOAD_BYTES` 正整数、`AIA_LOG_FORMAT` `json` / `pretty`、令牌可选且非空）；错误信息不回显值（两个变量是令牌）。
     `resolveFileVariants(env, readText)`：`X_FILE` 读文件、去掉一个结尾换行，`X` 与 `X_FILE` 同时设置报错；`parseSettings(env)` 返回可读的失败原因。
   - `node-ui.ts`：`createNodeUi(staticDir)` 内部一个 `Hono`：`use(serveStatic({ root }))`，再对最后一段无扩展名的路径 `use(serveStatic({ root, path: "index.html" }))`。
   - `node.ts`：启动顺序、日志事件与退出码见 plan §4.2。要点：`serve()` 显式传 `port`（`@hono/node-server` 默认 3000），不传 hostname（`::` 双栈）；
     `static_dir_missing` 只警告不退出（`dev:node` 不构建 UI，UI 由 Vite dev server 提供）；`removeTemporaryFiles()` 抛错只记 warn `temp_files_cleanup_failed`；
     SIGTERM / SIGINT → `shutdown` 日志、`server.close()`（回调里 `closed`、exit 0），随即 `closeIdleConnections()`，2 s（`unref()`）后 `closeAllConnections()`——
     还没发完请求的连接（preconnect、半截请求头、慢客户端）`close()` 会一直等，而 `close()` 又停掉了 Node 的请求头超时检查；10 s `unref()` 强制退出（exit 1）
     只作兜底；容器里 node 是 PID 1，没有处理器就停不下来。
   - `worker.ts`：`WeakMap<Env, App>` 按 env 缓存；令牌可选，不用 `secrets.required`（未设时部署会失败）；wrangler 的 `vars` 可以是任意 JSON 值、原样到达：
     五个变量的布尔与数字先 `String()` 再交 `parseSettings`（`"AIA_TRUST_PROXY": true`、`"AIA_MAX_UPLOAD_BYTES": 1048576` 可用），对象、数组、`null` 作为无效设置
     （错误只点名变量，不回显值）；设置无效时每个请求返回 500 信封并记一行 `invalid_settings`（始终 JSON：格式本身可能就是无效项）；
     `satisfies ExportedHandler<Env>`。
   - `wrangler.jsonc`：内容见仓库文件与 plan §4.1；`name` 绝不能是旧的 `aia-cdp-worker`。不设 `compatibility_flags`（`nodejs_compat` 自 2026-08-04 默认开，
     真正的护栏是 tsconfig 的 `types`）、`build.command`、`vars`；删除旧的 `env.local`、`keep_vars`、`vars.SITE_NAME`、`limits.cpu_seconds`（无效键，wrangler
     静默忽略）。`send_metrics` 挡不住 deploy 的 autoconfig 事件，所以脚本另设 `WRANGLER_SEND_METRICS=false WRANGLER_HIDE_BANNER=true`。`compatibility_date`
     与 wrangler 一起升级。

6. **Web 占位与 shadcn-vue**（D1、D6、B20）。先写 `tsconfig.json`（含 `paths`）、`vite.config.ts`、`src/web/styles/main.css`（`@import "tailwindcss";`，重写、
   不参考旧 `tailwind.css`），再初始化：
   - `vite.config.ts`（重写）：`root: src/web`、`envDir: <repo>`、`plugins: [vue(), tailwindcss()]`、`resolve.alias["@"] = src/web`、`build.outDir: <repo>/dist/web`、
     `emptyOutDir: true`；dev 代理键 `"^/(?:api|ca|crl|dcrl)/": "http://127.0.0.1:8787"`（字符串键 `/crl` 会吞掉 SPA 路由 `/crls/`）。`loadEnv(mode, repoRoot, "VITE_")`
     取 `VITE_SITE_NAME`，空则默认 `PKI AIA/CDP`，含 `< > & "` 即抛错（`%VITE_SITE_NAME%` 不做 HTML 转义），再写回 `process.env.VITE_SITE_NAME`。不写
     `minify: "esbuild"`、对象形式 `manualChunks`、固定文件名。
   - `pnpm dlx shadcn-vue@2.8.2 init --base reka --style nova --icon-library lucide --base-color neutral --font inter --yes --no-rtl --no-pointer < /dev/null`，
     然后 `pnpm dlx shadcn-vue@2.8.2 add button badge --yes < /dev/null`。永远不用 `--defaults`（= `--preset nova --template nuxt`），永远显式 `--style`。
   - 初始化后：删 `main.css` 里的 Google Fonts `@import url(...)` 与 `components.json` 的 `"font"` 键（否则每次 `add` 都加回）；CLI 写进 `dependencies` 的包用
     `pnpm add -D <包>@<版本>` 移到 devDependencies；`pnpm exec prettier --write src/web/styles/main.css components.json src/web/components/ui src/web/lib` 改成仓库风格
     （`init` 重写的 `main.css` 用单引号，删掉字体行后还留有开头空行，`format:check` 会报），每次 `add` 之后重跑；提交 `components.json`、生成文件与 lockfile
     （registry 是活的，重跑 `add` 可能得到不同代码）。
   - 迁入：`src/web/index.html`（`%SITE_NAME%` → `%VITE_SITE_NAME%`，保留两个 favicon 链接）、`src/web/public/favicon.svg`、`favicon.ico`（原样）、
     `src/web/env.d.ts`（保留 `*.vue` shim 供 typescript-eslint，`ImportMetaEnv.VITE_SITE_NAME: string`，加 `ViteTypeOptions.strictImportMetaEnv`，去掉
     `/// <reference types="vite/client" />`）。
   - 新写（Pinia 退出，旧 `main.ts` 不参考）：`main.ts`（router、i18n、`VueQueryPlugin` + `QueryClient({ defaultOptions: { queries: { staleTime: 0 } } })`）；`App.vue`
     （页头：站名、`HealthBadge`、`ThemeToggle`、`LocaleSwitch`）；`router.ts`（`createAppRouter(history = createWebHistory())`：`/`、`/certificates/:id`、
     `/crls/:targetId`、`/:pathMatch(.*)*`，详情页懒加载）；四个占位页；`i18n.ts` + `en` / `zh-CN`；`site.ts`；`client/api.ts`（`hc<AppType>("", { init: { cache: "no-store" } })`，
     `import type { AppType } from "../../http/app.ts"`）；`HealthBadge.vue`（200 显示 healthy / degraded，503 unhealthy，网络错误 unknown）；`ThemeToggle.vue`
     （`useColorMode({ storageKey: "theme-preference" })`，沿用旧实现的键与取值，见切片 5b 步骤 9）；`LocaleSwitch.vue`。
   - `src/web` 顶层目录不得叫 `api`、`ca`、`crl`、`dcrl`（`root: src/web` 时 dev server 把目录当 URL 服务），客户端放 `src/web/client/`。

7. **ESLint 与 Prettier**（B17）：`eslint.config.ts`（迁 `worker-aia-cdp@5b570aa:eslint.config.ts` 后改；规则与原因见文件注释）。
   - `defineConfig` / `globalIgnores` 来自 `eslint/config`；`js.configs.recommended`、`tseslint.configs.recommendedTypeChecked` + `stylisticTypeChecked`、
     `projectService: true`、`extraFileExtensions: [".vue"]`；`pluginVue.configs["flat/recommended"]`，`no-layout-rules` 的类型是 LegacyConfig，只取 `rules`；
     `**/*.vue` 用 `tseslint.parser`、关 `no-undef` 与 `vue/multi-word-component-names`。
   - 保留旧规则：`eqeqeq`、`curly: all`、`prefer-template`、`no-unused-vars`（`_` 前缀）、`no-explicit-any`、`no-non-null-assertion`（tests 关闭）。新增
     `consistent-type-imports`（separate）+ `no-import-type-side-effects`；`require-await: off`（实现异步端口的方法可以没有 await）。删除手写 globals、`semi`、
     `naming-convention`、对 `console.log` 的警告（Workers 日志就是 `console.log`）、旧 `src/worker/pki/**` 的 restricted-imports。不用 `--cache`。
   - 分层规则（D9）：`src/core/**` 的 `no-restricted-imports` `patterns` 禁 `**/http/**`、`**/storage/**`、`**/runtime/**`、`**/web/**`、`hono`、`hono/*`、`@hono/*`、
     `node:*`、`vite`、`vitest`、`wrangler`；`src/http/**` 禁 `node:*`、`@hono/node-server`、`**/storage/fs.ts`、`**/runtime/**`。`import type` 同样受限。规则写对与否由
     出口 9 的探针证明（相对路径 `../http/…` 必须被 `**/http/**` 拦住）。
   - 生成组件也 lint，`--max-warnings 0`；生成代码上触发的规则（已见 `vue/require-default-prop`）只为 `src/web/components/ui/**` 关掉那一条，不手改生成代码
     （Prettier 除外）。

8. **OpenAPI 生成**（B11）：`scripts/generate-openapi.ts`（重写旧脚本，保留字节级 `--check`）用 `createApp({ store: new MemoryStore(), now: () => new Date(0),
   settings: <parseSettings({}) 的默认值>, clientIpHeader: "x-forwarded-for", log: () => {} }).getOpenAPI31Document(OPENAPI_CONFIG)`（与步骤 10 的 `testDeps()` 同源，
   运行时文档与 `docs/openapi.json` 因此出自相同的 deps），写 `JSON.stringify(doc, null, 2) + "\n"`；`--check` 不一致时 exit 1 并提示运行 `pnpm run openapi`。
   `src` 不导入 `docs/openapi.json`（越出 `rootDir: src`，Node 产物运行时找不到）。

9. **夹具**（B16、D7）：`tests/fixtures/generate-test-data.sh`（重写 `worker-aia-cdp@5b570aa:scripts/generate-test-data.sh`，取自 fixtures spike）、
   `tests/fixtures/global-setup.ts`、`tests/fixtures/pki.ts`；生成的 `tests/fixtures/pki/` 入库（总则 §2.5）。
   - `leaf-min` 必须没有 SKI / AKI（切片 2 的 `summary.test.ts` 与 V5 反例依赖它）：OpenSSL 3 对没写 SKI / AKI 的扩展节默认补上两者，所以
     `[ ext_leaf_min ]` 是 `basicConstraints       = critical, CA:FALSE`、`subjectKeyIdentifier   = none`、`authorityKeyIdentifier = none` 三行
     （OpenSSL 3.5.5 与 3.0.20（`node:24-bookworm`）上实测两项都消失）。
   - 用例矩阵（文件名、签发者、kind、CRL 号、时间、`expect`、scenarios）见附录 D，是重写生成器时的契约；摘要与大小随密钥变，不在契约内。

   | 项 | 约定 |
   | --- | --- |
   | 调用 | `bash tests/fixtures/generate-test-data.sh [--force \| --check] OUT_DIR`；永远用 `bash` 调用（owner 的交互 shell 是 zsh） |
   | 产物 | `certs/`（12 张：EC P-384 根、AD CS SubCA 形状的 RSA 签发 CA ×2、同钥续期、rogue、Ed25519、Ed448、5 张叶子）、`crls/<issuer>/<case>.der`（30 个，另 3 个 PEM 变体）、`invalid/`（6）、`manifest.json`（`now = 2026-01-04T00:00:00Z`、声明值、`expect`、17 个 `scenarios`）、`SHA256SUMS`、`.stamp`（脚本 sha256，最后写）；逐项见附录 D |
   | 确定性 | 日期、序列号、CRL 号固定（`openssl ca -startdate/-enddate`、`-crl_lastupdate/-crl_nextupdate`、固定 serial / crlnumber 文件）；只有密钥派生值变 |
   | 幂等 | stamp 相符且 `SHA256SUMS` 校验通过 → 不写（约 15 ms）；`--check` 只读，0 / 1；`--force` 重建（约 2.2 s） |
   | 安全 | 私钥、CSR、CA 库只在 `mktemp -d`（0700），EXIT trap 删除；产物含 `PRIVATE KEY` 即失败；暂存到 `OUT_DIR.tmp.*` 后 rename；`flock` 串行；非空且无 `.stamp` 的目录拒绝覆盖；openssl 失败立即退出 |
   | 依赖 | bash、OpenSSL ≥ 3.0（拒绝 LibreSSL；`OPENSSL=` 可覆盖）、od / awk / sed；不再需要 Node |

   - `global-setup.ts`：`spawnSync("bash", [脚本, "--check", tests/fixtures/pki])`，每个 vitest 进程一次，不用 `pretest`；不一致即抛错并提示 `pnpm run fixtures`
     后提交。（原为每次调用生成器、产物 gitignore；夹具入库后改为只校验。）
   - `pki.ts`：导出 `manifest`、`NOW = new Date(manifest.now)`、`fixture(path)`。sha256、key id、大小、签名永远从文件或 manifest 读，不写字面量。永远不以
     root 身份生成。

10. **vitest**（B15）：`vitest.config.ts`（独立文件，不继承 `vite.config.ts` 的 `root`）。根 `test`：`environment: "node"`、`hookTimeout` 与
    `teardownTimeout` 10 s、`globalSetup: ["./tests/fixtures/global-setup.ts"]`；`projects`：`core`、`http`、`storage`、`integration`（各自
    `tests/<名>/**/*.test.ts`）与 `web`（`plugins: [vue()]`、`resolve.alias["@"]`、`environment: "happy-dom"`、`env: { VITE_SITE_NAME: "Test PKI" }`）。
    HTTP 测试走 `createApp(testDeps()).request()`，`tests/helpers/app.ts` 的 `testDeps()` 用 `MemoryStore`、固定 `now`、`parseSettings({})` 的默认值、`clientIpHeader: "x-forwarded-for"`（Node 入口的取值，可覆盖），并收集日志行。

11. **Docker**（B18）：`Dockerfile`、`.dockerignore`（阶段与选项见 plan §4.2 与文件本身）。要点：`.dockerignore` 用白名单（`*`，再放行清单、三个 tsconfig、
    `vite.config.ts`、`src`；末尾排除 `**/*.test.ts`、`**/.env*.local`），`tests/fixtures`、`.dev.vars`、`.wrangler`、`.git` 进不了构建上下文；
    `ARG VITE_SITE_NAME` 不设默认（空值与未传都落到 `vite.config.ts` 的默认）；`package.json` 必须进运行镜像（`"type": "module"`）；base 阶段先
    `corepack install` 再分 prod-deps 与 build 两路装依赖（store 缓存挂载）；基础镜像用浮动的 `node:24-slim`（bookworm），digest 固定以后再定；CI 里不用
    `--no-cache`（会清掉 store 缓存挂载）。

12. **冒烟脚本与 `package.json` scripts**：`scripts/smoke.sh`、`scripts/node-smoke.sh`、`scripts/worker-smoke.ts`、`scripts/docker-smoke.sh`；命名规则见总则 §2.4，
    完整命令见 `package.json`。
    - `smoke.sh <base-url>`：与运行时无关的 curl 用例（见"测试"末行），任一失败 exit 1；从 `index.html` 解析哈希 JS 文件名；不测 `/index.html`
      （Workers 的 `html_handling` 回 307，Node 回 200）。
    - `node-smoke.sh`：要求已 `pnpm run build`；临时 `AIA_DATA_DIR`、`PORT=0`，从就绪日志取端口，启动 `node --enable-source-maps dist/server/runtime/node.js`，
      跑 `smoke.sh`，写入最小配置后检查 `healthy`，SIGTERM 后 12 s 内 exit 0；trap 清理。
    - `worker-smoke.ts`：`createTestHarness({ workers: [{ configPath: "./wrangler.jsonc", prebuiltWorkerDir: "./dist/worker" }] })`，`listen()` 后对其 URL 跑
      `smoke.sh`，`finally` 里 `close()`（测的是 dry-run 产物本身；存储隔离，health 为 `degraded`）。
    - `docker-smoke.sh`：`docker build --check .`；构建；建临时命名卷；`docker run -d -p 127.0.0.1::8080 -v <卷>:/data`；60 s 内等到
      `.State.Health.Status = healthy`；health 为 200 且 `"status":"degraded"`；跑 `smoke.sh`；`docker exec` 检查 `id -u` 为 1000、写入 `/data/config.json` =
      最小配置后 `healthy`；`docker stop` 5 s 内完成且退出码 0；trap 删容器与卷。
    - 脚本里的约束：`types` 用 `wrangler types --env-file=/dev/null`（不读 `.dev.vars`，生成结果确定）；`typecheck` = `types` → `typecheck:boundary` → worker、node、web
      三套编译（步骤 2）；`lint` 与 `check` 用 `eslint --max-warnings 0`；`test:r2` = `AIA_TEST_R2=1 vitest run --project storage`（r2 套件在 `import("wrangler")`
      前也自设 `WRANGLER_SEND_METRICS` / `WRANGLER_HIDE_BANNER`）；`ci:test` = `test` + `build` + `smoke:node`；`ci:worker` = `build:web` →
      `wrangler deploy --dry-run --outdir dist/worker` → `! grep -q '"node:' dist/worker/worker.js`（D9；spike 的 Worker 包里为 0 处）→ `smoke:worker` → `test:r2`；
      `dev:node` 用 `PORT=8787 AIA_DATA_DIR=.data`，`dev:worker` 先 `build:web` 再 `wrangler dev --ip 127.0.0.1 --port 8787`。
    - 不加 `deploy` 脚本：新 Worker 名首次真实部署会自动置备新桶 `aia-cdp-store`，桶的决定见切片 7。

13. **CI 与 dependabot**（B19、D3）：`.github/workflows/ci.yml`（重写旧文件）：push / PR 到 `main` 与 `workflow_dispatch`；`permissions: contents: read`；按 ref 并发
    取消；`env` 设 `WRANGLER_SEND_METRICS=false`、`WRANGLER_HIDE_BANNER=true`；四个任务 `check` / `test` / `worker` / `docker` 均 `runs-on: ubuntu-24.04`
    （OpenSSL 3.0.x），步骤为 checkout、`pnpm/action-setup`、`actions/setup-node`（`node-version-file: .nvmrc`、`cache: pnpm`）、`pnpm install --frozen-lockfile`、
    `pnpm run ci:<job>`。`.github/dependabot.yml`（迁后改）：`npm`、`github-actions`、`docker` 三个生态，每周一 09:00 America/Vancouver；修掉旧的双前缀
    （`prefix: "chore"` + `include: scope`；actions 用 `prefix: "ci"`）；npm 忽略 `typescript` ≥ 6.1 与 `@types/node` 的 major 升级。2026-10-19 推送远端后两者
    开始运行，首次推送的 CI 四个任务全过。

14. **文档**：`README.md` 为最小中文版（用途、Node 24、OpenSSL ≥ 3.0、`pnpm install` 后先 `pnpm run types`、`verify` 与 `ci:*`、三个 `dev:*`、bind mount 的
    `/data` 须属 uid 1000；完整内容见切片 6）。`docs/templates/implementation-slice.md` 迁旧模板后改：PR 改为本地分支合并，保留"不授权部署或改动生产对象存储"一行。

15. **devcontainer**（D10）：`.devcontainer/devcontainer.json`（重写旧版：Node 22 镜像加未固定版本的 act 安装脚本），纯 JSON、不写注释（出口 13 用 `JSON.parse` 校验）。
    - `image`：`mcr.microsoft.com/devcontainers/typescript-node:5-24-bookworm`，即镜像大版本 5 的 Node 24 bookworm 变体（2026-10-19 查 MCR 标签表 `https://mcr.microsoft.com/v2/devcontainers/typescript-node/tags/list`：与
      `24-bookworm` 同 digest `sha256:970eebf5…`，镜像 5.2.3，`NODE_VERSION=24.21.0` 满足 `^24.11.0`，元数据 `remoteUser: node`）。固定大版本 `5-` 防镜像大改静默生效；bookworm 的
      OpenSSL 3.0.x 与 CI、`node:24-slim` 一致；不用不带发行版的 `24`（digest 不同）。
    - `features` 只有 `ghcr.io/devcontainers/features/powershell:1`（`pwsh` 解析与试跑 `scripts/adcs-crl-uploader.ps1`；真实 AD CS 验证仍在 Windows，切片 4）。
      不装 `act`。容器内 Docker 可选：需要在容器里跑 `ci:docker` 时自行加 `ghcr.io/devcontainers/features/docker-outside-of-docker:1`，默认 `ci:docker` 在主机上跑。
    - `remoteUser: "node"`，`updateRemoteUserUID` 保持默认 `true`（容器 uid 对齐主机用户，工作树里生成的文件不属 root）；`containerEnv`
      `{ "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0", "WRANGLER_SEND_METRICS": "false" }`；`postCreateCommand` 为 `corepack enable --install-directory "$(npm prefix -g)/bin" pnpm`：
      `corepack enable pnpm` 写 root 所有的 `/usr/local/bin`（EACCES）；`--install-directory ~/.local/bin` 目录不存在、也不在 PATH 上，镜像自带的全局 pnpm 12 在
      PATH 上靠前；`npm prefix -g` 即属 `node` 的 `/usr/local/share/npm-global`，shim 替换其 `bin/pnpm`。`forwardPorts`：`[5173, 8080, 8787]`。
    - 不在 `postCreateCommand` 里装依赖：首次进入后手动 `pnpm install --frozen-lockfile`，夹具已入库。

## 测试

文件已在仓库里；下表只记每个文件的覆盖面与容易写错的用例。

| 文件 | 要点 |
| --- | --- |
| `tests/core/health.test.ts` | `checkHealth` 矩阵：缺失 → `degraded`/`missing`；最小配置 → `healthy`；`not json`、`{"version":2}`、`[]`、`null` → `invalid`；`head` 抛错 → `unhealthy`/`unknown`；`head` 成功而 `get` 抛错 → `unhealthy` |
| `tests/core/store-keys.test.ts` | `assertStoreKey` 接受 plan §5.1 的四类键，拒绝 `""`、`/a`、`a//b`、`../a`、`a/./b`、`.a`、`a\b`、NUL；`assertStorePrefix` 接受 `""`、`blobs/`、`blobs/crls/<uuid>/`、`history/<uuid>/`，拒绝 `blobs`、`/a/`、`a//`、`../`、`./`、`a\b/`、NUL |
| `tests/storage/conformance.ts`（共享 `describeObjectStore(name, factory)`，每例一个空存储） | plan §5.4 的 12 条。⑧ 同一 `ifMatch` 并发 5 次恰好 1 次 `ok`：5 份字节须互不相同且都不同于当前内容（ETag 按内容生成，同内容写入不改 ETag，会人人"成功"）；⑨ `list("blobs/")` 不含 `blobsX/…`；⑪ 非法键 / 前缀抛错且存储不变 |
| `tests/storage/memory.test.ts`、`fs.test.ts` | 每次跑一致性套件。fs 另测：新实例读到旧数据；临时文件、`blobs/a (copy).der`、`blobs/x.der~`、`blobs/old copy/b.der`、`lost+found/c.der` 不出现在 `list`，列出的键都能 `delete`；`chmod 000` 的 `lost+found` 不让 `list("")`、`removeTemporaryFiles()` 抛错（uid 0 时跳过）；在已存在的 `blobs/crls/t1` 下 `put`：rename → fsync `blobs/crls/t1`、`blobs/crls`、`blobs`、根的顺序；`removeTemporaryFiles()` 只删键目录里的 `.<名>.<uuid>.tmp`（返回 3），不动 `.x.tmp`、非 uuid 名、点开头目录与 `lost+found` 里的同形文件、无点前缀的 `a.der.<uuid>.tmp`（它是键），再跑返回 0；不可读的根上 `head` 抛错 |
| `tests/storage/fakes/r2-bucket.ts` + `r2.test.ts` | 假桶迁自 `worker-aia-cdp@5b570aa:tests/helpers/r2.ts`（`etagMatches` / `etagDoesNotMatch:"*"` → `null`、字节复制、排序前缀列表；加可配页大小与"带引号 ETag 抛 `TypeError`"）。两处必改：旧 `put` 先 `await this.head(key)` 再比较写入，5 个并发写会全部成功，改为比较与写入之间没有 `await`；类型用 `R2BucketLike`，不用 Workers 全局类型（node 程序里 TS2304）。每次跑：一致性套件、页大小 2 跨页、`contentType` 进 `httpMetadata`。`AIA_TEST_R2=1`：先设遥测变量再 `await import("wrangler")`，`getPlatformProxy({ configPath: "wrangler.jsonc", persist: false })`（一个 proxy 一个桶），`beforeEach` 清桶后跑一致性套件、1001 个键跨页（约 4 s，`{ timeout: 60_000 }`）、带引号 ETag 抛错；`afterAll` 里 `await proxy.dispose()` |
| `tests/http/health.test.ts` | 空 store → 200 `degraded` / `missing` + `no-store`；最小配置 → `healthy`；坏 JSON / `version: 2` → `invalid`；`head` 抛 `Error("EACCES /data secret")` → 503 `unhealthy`，响应不含异常文本、日志一行 error；`HEAD` → 200 空体 |
| `tests/http/app.test.ts`（重写旧 `api-routing.test.ts` 前两条） | plan §4.4 表的每一行，ui 替身是否被调用都断言：`/api` 与下载前缀未命中（含 `//api/v1/missing`、`/api%2Fv1/missing`、`/crl%2fissuing`、`///dcrl//x.crl` 等）不进 UI；`/crls%2F<uuid>`、`//crls/<uuid>` 仍进 UI；`/api%2Fv1/health` 不是健康路由；`/assets/` 缓存规则（206 / 304 也 `immutable`，500 / 503 / 416 照传、`no-cache`）；缺失哈希资源与 `/missing.png` → 纯文本 404；`POST /crls/abc`、`PUT /` → 404 而非 405；`POST` / `DELETE /api/v1/health` → 405 + `Allow: GET, HEAD`；测试路由抛 `Error("hunter2")` → 500 不含 `hunter2`、日志含栈；三类响应都有 `nosniff`、`SAMEORIGIN`，`https://` 请求也无 HSTS；每请求一行日志（405 / 500 记最终状态），令牌与 `?token=` 不进日志；`client`：XFF 取最右项（含 IPv6、多行头），非 IP 值不回退，`cf-connecting-ip` 忽略 XFF；`isIpAddress` 正反例；`pretty` 转义 ESC / BEL / U+009B / DEL 等；未注入 `ui` 时纯文本 404 |
| `tests/http/openapi.test.ts` | 200 + `public, max-age=300`，两次请求字节相同；含 health 的 200 / 503；每个 operation 有 `operationId` 与 `summary`（代替 redocly lint）；深等于 `docs/openapi.json` |
| `tests/http/worker-entry.test.ts` | Worker 入口进程内运行（假 R2 桶、替身 `ASSETS`、截获 `console.log`；`worker.ts` 只属 Worker 程序，经变量说明符动态导入）：JSON 布尔 / 数字形式的 vars 生效且与字符串等价；`client` 只取 `CF-Connecting-IP`；数组、对象、`null` → 500 `internal` + 一行 `invalid_settings` 点名变量、不含值；`1.5` 报 `AIA_MAX_UPLOAD_BYTES` |
| `tests/http/client.test.ts` | `hc<AppType>(…, { fetch: app.request })`：200 时 `body.status` 收窄为 `healthy \| degraded`，503 时为 `unhealthy`；`@ts-expect-error` 证明不是 `any`（`tsconfig.node.json` 检查） |
| `tests/integration/node-runtime.test.ts` | 真实进程（`PORT=0`、临时数据与静态目录）：预置的 `.config.json.<uuid>.tmp` 被删且 `temp_files_removed`（`count: 1`）先于 `listening`；health 从 `degraded` 到 `healthy`；`AIA_TRUST_PROXY=true` 时 XFF 最右项；`HEAD /api/v1/health` 无体，`HEAD /crls/<uuid>` 有 `Content-Length`；stdout 每行都是 JSON；SIGTERM → exit 0 且有 `shutdown`、`closed`；开着空连接、半截请求头、空闲 keep-alive 时 SIGTERM → 5 s 内 exit 0、无 `forced_exit`；`AIA_STATIC_DIR` 不存在 → `static_dir_missing`（绝对路径）、照常监听、`/` 纯文本 404；`PORT=abc`、数据目录不存在、`X` 与 `X_FILE` 同设、端口被占 → exit 1；`_FILE` 去结尾换行后读入 |
| `tests/integration/fixtures.test.ts` | `--check` exit 0；再跑一次输出 up to date 且 `.stamp` 不变；manifest 的 sha256 等于文件摘要；`manifest.now`；声明值（如 `crls/issuing-ca-1/full-02.der` 的 `crlNumber: "3"`）；没有文件含 `PRIVATE KEY`；`certs/leaf-min.der` 无 `Key Identifier` |
| `tests/web/health-badge.test.ts` | 请求 URL 以 `/api/v1/health` 结尾且 `init.cache === "no-store"`；200 `degraded` 显示 zh-CN 文案；503 unhealthy；用库默认值的 `QueryClient`（不设 `retry`）时一次网络错误后 `fetch` 只调用 1 次、立即显示 unknown（`HealthBadge` 自带 `retry: false`） |
| `tests/web/router.test.ts` | memory history：三条路由拿到参数，`/nope` → NotFound；`siteName` 为 `Test PKI` |
| `tests/boundary/{worker,node}-canary.ts` | 编译期，由 `typecheck:worker` / `typecheck:node` 执行（步骤 2） |
| `scripts/smoke.sh`（Node、`wrangler dev`、createTestHarness、Docker 共用） | health 200 + `no-store` + `nosniff` + 无 HSTS；HEAD health 无体；POST health 405 + `Allow` + 信封；API 与下载前缀 404 的类型；`/`、两条详情路由的 GET 与 HEAD 200 HTML `no-cache`；哈希 JS `immutable`；`/assets/missing-0000.js` 404；`POST /crls/x` 404；openapi `max-age=300`；`--path-as-is` 的编码前缀非 2xx、非 5xx、不是 HTML；`--path-as-is` 的穿越探针（`/../package.json`、`/%2e%2e/package.json`、`/assets/..%2f..%2fpackage.json`，以及在主机与镜像上都够得到真实文件的多级 `..%2f`、`%2e%2e%2f`、`/../../../../../../../../../../etc/passwd`、十级 `..%2f` 的 `/etc%2fpasswd`）都非 5xx、正文不含 `"packageManager"` 与 `root:x:0:0`（Worker 对编码穿越回 307 也算通过；对一个解码 `%2f` 的故意有漏洞的处理器，后六条都失败） |

## 出口条件

前提：`export PATH=$HOME/.local/opt/node-24/bin:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0 T=$HOME/.cache/aia-cdp/exit && mkdir -p "$T"`
（与仓库同一文件系统；`/tmp` 是 tmpfs，在那里全新克隆会让 pnpm 把 store 建到 `/tmp/.pnpm-store`），在 `slice/1-skeleton` 上且已提交；
以下命令都在仓库根执行，可重复执行。

1. 全新克隆中通过：`rm -rf "$T/aia-cdp-clean" && git clone . "$T/aia-cdp-clean" && (cd "$T/aia-cdp-clean" && pnpm install --frozen-lockfile && pnpm run verify)`
   （子 shell，不改变当前目录；安装无 "Ignored build scripts" 提示；`worker-configuration.d.ts` 由脚本现场生成，入库的夹具由 globalSetup 校验）。
2. `pnpm run ci:test`：vitest 全绿，`smoke:node` 对编译产物通过（含 HEAD、SIGTERM exit 0）。
3. `pnpm run ci:worker` 退出 0（dry-run、`dist/worker/worker.js` 不含 `"node:`、createTestHarness 冒烟、`test:r2`）；r2 用例为 passed 而不是 skipped：
   `AIA_TEST_R2=1 pnpm exec vitest run --project storage --reporter=json --outputFile="$T/r2.json" && node -e 'const r=require(process.argv[1]); process.exit(r.numTotalTests > 0 && r.numPendingTests === 0 && r.numFailedTests === 0 ? 0 : 1)' "$T/r2.json"`
   退出 0。
4. `wrangler dev` 冒烟：先确认端口空闲，`curl -s -o /dev/null --max-time 2 http://127.0.0.1:8787/` 必须失败（有应答就先停掉占用者，否则冒烟测的是
   别的服务）；然后
   `pnpm run build:web && (WRANGLER_SEND_METRICS=false WRANGLER_HIDE_BANNER=true pnpm exec wrangler dev --ip 127.0.0.1 --port 8787 < /dev/null > "$T/dev.log" 2>&1 & echo $! > "$T/dev.pid")`，
   `curl -sS --retry 40 --retry-delay 1 --retry-connrefused -o /dev/null http://127.0.0.1:8787/api/v1/health`，
   `bash scripts/smoke.sh http://127.0.0.1:8787`（exit 0），`kill -TERM "$(cat "$T/dev.pid")"`（用记录的 PID，不用 `pgrep -f`）。
5. `pnpm run ci:docker`：`docker build --check .` 无警告；容器变为 `healthy` 而 API 报 `degraded`；写入配置后 `healthy`；非 root；`docker stop` < 5 s。
6. 引擎护栏：`docker build --build-arg NODE_VERSION=22 --target prod-deps -o type=cacheonly .` 失败且输出含 `ERR_PNPM_UNSUPPORTED_ENGINE`。
7. OpenSSL 3.0 上生成夹具：`docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/w" -w /w node:24-bookworm bash -c 'openssl version && bash tests/fixtures/generate-test-data.sh --force /tmp/pki'`
   exit 0，且打印的版本为 `OpenSSL 3.0.x`。
8. `.vue` 的 lint：`pnpm exec eslint src/web` exit 0（含 `App.vue` 与生成组件）；主机有 Debian `/usr/bin/node` 时
   `/usr/bin/node node_modules/eslint/bin/eslint.js src/web` 也 exit 0（`publicHoistPattern` 回归）。
9. 边界检查自证（每项临时改动后都 `git checkout -- tests/boundary src` 还原）：
   - canary：删掉 `tests/boundary/worker-canary.ts` 的 `@ts-expect-error` 行，`pnpm run typecheck:worker` 报 TS2591；对 node canary 同样操作，
     `pnpm run typecheck:node` 报 TS2304。
   - `typecheck:boundary`（D9）：在 `src/http/types.ts` 末尾加 `import type { Plugin } from "vite";` 与 `export type VitePlugin = Plugin;`（导出它，免得
     `noUnusedLocals` 先报错），`pnpm run typecheck` 失败且输出含 `pulls in Node-only declarations`（失败来自先跑的 `typecheck:boundary`，三套编译不再运行；
     单跑时 `typecheck:worker` 报 worker canary 的 TS2578，node、web 照常通过）。
   - ESLint 分层（D9）：在 `src/core/health.ts` 加 `import type { AppDeps } from "../http/types.ts";`，`pnpm exec eslint src/core/health.ts` 的输出含
     `no-restricted-imports`；在 `src/http/app.ts` 加 `import { serve } from "@hono/node-server";`，`pnpm exec eslint src/http/app.ts` 同样报它。
   - 还原后 `pnpm run typecheck && pnpm run lint` 通过。
10. shadcn-vue：`grep -q nova components.json && ! grep -q '"font"' components.json && ! grep -q fonts.googleapis.com src/web/styles/main.css`；
    `pnpm ls --prod --depth 0` 只列 `hono`、`@hono/zod-openapi`、`zod`、`@hono/node-server`；`ls node_modules/.pnpm | grep -c '^@vueuse+core@'` 为 `1`。
11. `SITE_NAME`：`VITE_SITE_NAME='Acha PKI' pnpm run build:web && grep -q '<title>Acha PKI</title>' dist/web/index.html`；
    `VITE_SITE_NAME='A&B' pnpm run build:web` 失败；未设置时标题为 `PKI AIA/CDP`。
12. 仓库卫生：`for p in worker-configuration.d.ts dist/ .data/; do git check-ignore -q "$p" || echo "$p"; done` 无输出（目录写尾斜杠：
    `.data/` 一类模式只匹配目录，路径不存在时不带斜杠会误报）；`! git grep -qE -e '-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY-----'` 退出 0（只匹配 PEM 私钥封装；
    文档、生成器第 702 行与 `fixtures.test.ts` 里的 `PRIVATE KEY` 字样不算）；`grep -q '"name": "aia-cdp"' wrangler.jsonc && ! grep -q aia-cdp-worker wrangler.jsonc`；
    `git status` 干净。
13. devcontainer（D10）。没有 VS Code 或 devcontainer CLI 时只能验证一部分，分两类：
    - 自动：`node -e 'const c=JSON.parse(require("fs").readFileSync(".devcontainer/devcontainer.json","utf8")); process.exit(c.remoteUser==="node" && Object.keys(c.features).join()==="ghcr.io/devcontainers/features/powershell:1" ? 0 : 1)'`
      退出 0（纯 JSON、非 root、只有 PowerShell feature，无 act）；`docker buildx imagetools inspect mcr.microsoft.com/devcontainers/typescript-node:5-24-bookworm`
      退出 0（标签可解析）；`docker run --rm -u node mcr.microsoft.com/devcontainers/typescript-node:5-24-bookworm bash -c 'node -v && openssl version'` 打印 ≥ `v24.11`
      的 `v24.x` 与 `OpenSSL 3.`。
    - 人工（写进合并说明）：VS Code "Reopen in Container"（或 `devcontainer up --workspace-folder .`）后在容器内 `id -u` 不为 0、`node -v` 为 v24、`pnpm -v` 为
      `10.34.7`、`pwsh -v`、`openssl version` 为 3.0.x，`pnpm install --frozen-lockfile && pnpm run test` 通过；回到主机 `find . -user root` 无输出。
14. 评审通过后把 `slice/1-skeleton` 本地合并到 `main`。

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| 未锁版本的 `pnpm add` 拉到 TypeScript 7 / `@types/node` 26 / pnpm 12 | 精确版本 + `save-exact`；`packageManager` + Dockerfile 里先 `corepack install`；dependabot 忽略规则 |
| @types/node 混进 Worker 程序（只 include 不列 `types`），边界检查静默失效 | base `types: []`、worker 显式 `types`、canary 与出口 9 |
| Node-only npm 包的导入（类型不引用 `@types/node` 时编译与 canary 都放过，只有 `typecheck:boundary` 能抓）；带 `/// <reference types="node" />` 的类型导入（worker canary 会报 TS2578，但看不出来源，`typecheck:boundary` 指明是哪个包）；core → http / hono 分层（编译与 canary 都抓不到） | D9：`typecheck:boundary`、ESLint 分层规则、`ci:worker` 的 `"node:` 断言；出口 9 的探针证明三者生效 |
| `app.get("*")` 兜底让未知路径 POST 全变 405；首个请求后加路由抛错 | 兜底只在 `notFound`；全部路由在 `createApp` 内注册；`app.test.ts` 的 POST 404 用例 |
| Workers SPA 兜底把 `/api` 与下载前缀未命中答成 200 HTML（C12），`//api/…`、`%2F` 形式同样；缺失哈希资源 200 HTML；SPA 的 `index.html` 或错误响应被标成一年 `immutable`；绑定响应头不可变（500） | 保留前缀在应用内、在规范化路径上判定；扩展名规则；`immutable` 只给 `/assets/` 下带扩展名、非 HTML 的 200 / 206 / 304；先复制再改头；createTestHarness 与 `wrangler dev` 都跑 `smoke.sh` |
| `secureHeaders` 默认 HSTS 落到所有响应 | `strictTransportSecurity: false`；其余默认头对下载的影响在切片 3 做头快照 |
| shadcn-vue registry 是活的；`--defaults` 陷阱；CLI 把包写进 `dependencies`；生成代码不合仓库风格 | 固定 CLI 版本与参数，提交生成文件与 lockfile，移包到 devDependencies，Prettier 重排，出口 10 |
| lint 在生成组件上报错或警告（`vue/require-default-prop` 已见） | `--max-warnings 0`；只对 `src/web/components/ui/**` 关闭具体规则 |
| `%VITE_SITE_NAME%` 不转义；`root: src/web` 时 `.env*` 找错目录；dev proxy 前缀吞 `/crls/` 或源码目录 | 构建期校验 + 默认值；`envDir`；锚定正则键；客户端目录叫 `client` |
| 夹具：CI 的 OpenSSL 3.0 未实测；旧脚本的时钟定时炸弹 | 出口 7；固定日期 + `manifest.now` 注入；测试不写密钥派生字面量 |
| `wrangler types` 受本地 `.dev.vars` 影响；遥测与 banner；dry-run 需要 `dist/web`；`vars` 写成 JSON 布尔 / 数字时整个 Worker 500 | `--env-file=/dev/null`；环境变量关闭（`test:r2` 与 r2 套件也设）；`ci:worker` 先 `build:web`；Worker 入口把布尔 / 数字转成字符串 |
| 新 Worker 名首次部署会置备新桶 | 本切片不加 `deploy` 脚本；`bucket_name` 见切片 7 |
| R2：带引号 ETag 抛错；单键写速率错误不是 `precondition-failed` | 适配器只传 store ETag 且不吞异常；假桶与 proxy 用例；单键写速率的应对见切片 4 风险与对策 |
| fs 持久性与并发；被杀的写入留下临时文件；数据目录里的杂物（`lost+found`、编辑器备份） | 文件 fsync，rename 后从父目录到根逐级 fsync；按键互斥、单进程；Node 启动时 `removeTemporaryFiles()`；`list` 只认键段名、不进非键段目录；memory 适配器比较与写入之间无 `await` |
| r2 一致性测试被 skip 而没人发现 | `ci:worker` 含 `test:r2`（本机与 GitHub Actions 都跑），出口 3 要求 passed 而不是 skipped |
| node 作为 PID 1 不处理 SIGTERM；没发完请求的连接（preconnect、半截请求头）让 `server.close()` 等满 10 s 后 exit 1；bind mount 的 uid 不是 1000 | 信号处理器；`closeIdleConnections()` + 2 s 后 `closeAllConnections()`，10 s 强制退出只兜底；`node-runtime.test.ts` 的空连接用例与 `ci:docker` 检查停止时间；README 写明 `/data` 属 uid 1000 |
| Debian 自带 node 下 `.vue` lint 报 `Invalid Version: main` | `engine-strict` + `publicHoistPattern`；出口 8 |
| devcontainer 在本机无法全自动验证；镜像大版本漂移 | 出口 13 的自动检查 + 合并说明里的人工记录；镜像标签固定大版本 `5-` |
| dependabot 的 pnpm 拒绝发布不满 `minimumReleaseAge` 的版本（`ERR_PNPM_NO_MATURE_MATCHING_VERSION`）：锁文件里刚升级的包会让 npm 更新任务暂时失败（2026-10-19 首次运行即因 2 天前发布的 `@lucide/vue@1.59.0`） | 不改配置，几天后自愈；手动升级依赖时避开刚发布的版本 |

## 开工前需 owner 确认

1. **边界漏洞的补丁**：已确认（2026-10-19，D9）：加——ESLint 分层规则（步骤 7）、`typecheck:boundary`（步骤 2、12）、`ci:worker` 的 `"node:` 断言（步骤 12），
   出口 9 用探针证明三者生效。起因：三套编译加 canary 抓不到 core 导入 Node-only 包（如 `@hono/node-server`）、类型导入带
   `/// <reference types="node" />` 的包（如 `vite`，worker canary 只报 TS2578、看不出来源）与 core → http / hono 的分层，`wrangler deploy --dry-run` 也照样 exit 0；
   只靠名单式 ESLint 规则时，`src/http` 里 `import type … from "vite"` 仍会把整个 `@types/node` 带进 Worker 程序。
2. **devcontainer**：已确认（2026-10-19，D10）：本切片建（步骤 15，出口 13）。
