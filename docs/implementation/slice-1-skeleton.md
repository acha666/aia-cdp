# 切片 1：骨架、存储端口与适配器

## 目标与范围

两条运行时（Workers + R2、Node 24 + fs）从同一个 `createApp(deps)` 提供 UI 占位页、`GET /api/v1/health`（真实的 store / configuration
检查）与 `GET /api/v1/openapi.json`；ObjectStore 端口、memory / fs / r2 适配器与一致性测试在本切片完成（D5）；类型检查、lint、测试、夹具、
Worker 打包、Docker 镜像都能用 `pnpm run ci:<job>` 在本机跑通。处理的缺陷与评审项：

- §10 #15 健康检查真实检查 store 与 configuration，有 `degraded`；#18 `SITE_NAME` 只剩构建期 `VITE_SITE_NAME` 一条通道（UI 的使用见切片 5b）；
  #21 vitest `projects`、无 shell glob、无 `pretest`、幂等夹具；#22 `runtime/node.ts` + Dockerfile；#24 每请求一行 JSON 日志。
- C12：两条运行时上 `/api` 与下载前缀的未命中都不进 UI 兜底。M19 只做"下载前缀未命中 = 纯文本 404"，其余见切片 3。
- 评审 §3.3 风险"shadcn-vue init + Vite 8 + Tailwind 4"在本切片验证（plan §8 末条）。
- owner 2026-10-19 的两项决定在本切片落地：边界护栏（D9，步骤 2、7、12）与 devcontainer（D10，步骤 15）。

不做（各一行）：

- catalog / config schema、条件写重试、`importCertificate`、`applyConfig`、管理路由、CLI、`src/core/pki`、`pkijs`/`asn1js` 依赖：见切片 2。
- 下载路由、下载前缀上的 405、路径匹配（含畸形 `%`）、`Content-Disposition`（M17、M20、C13）：见切片 3。上传与 `bodyLimit`/`bearerAuth`：见切片 4。
- 列表 / 详情 / 统计路由：见切片 5a。真实 UI、`vue-sonner`、偏好迁移：见切片 5b。真实 `wrangler deploy`、`bucket_name`：见切片 7。
- 旧 v2 路由层删除不迁：`worker-aia-cdp@5b570aa:src/worker/utils/json-response.ts`、`api/v2/router.ts`、`api/v2/server.ts`、
  `src/contracts/api.ts`、`tests/worker/json-response.test.ts`。
- 不迁：`.actrc`、`redocly.yaml`、`.github/workflows/pages.yml`、`scripts/generate-docs-index.ts`（无文档站，OpenAPI lint 改为测试断言）、
  `tailwind.config.ts`（Tailwind 4 CSS-first 由 shadcn-vue init 生成）、`tests/data/adcs.ts`（D7）。

## 前置

- 每个 shell：`export PATH=$HOME/.local/opt/node-24/bin:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0`。pnpm 一律经 corepack 按
  `packageManager` 解析（npm `latest` 是 pnpm 12）；不要在没有 `package.json` 的目录跑 pnpm。
- OpenSSL ≥ 3.0 CLI（不是 LibreSSL）、bash、Docker Engine ≥ 25（`HEALTHCHECK --start-interval`）。需要联网（npm registry、
  shadcn-vue registry、Docker Hub）；不需要 Cloudflare 登录。
- 本节末"开工前需 owner 确认"两项已于 2026-10-19 答复（D9、D10）。
- 工作树里有未跟踪的 `tests/fixtures/generate-test-data.sh`（713 行，sha256 `872a483b…7ac6`），步骤 9 提交。

## 步骤

1. **根文件与依赖**：`package.json`（重写 `worker-aia-cdp@5b570aa:package.json`）、`.npmrc`、`.nvmrc`、`pnpm-workspace.yaml`、
   `.gitignore`、`.gitattributes`、`.prettierrc.json`、`.prettierignore`、`LICENSE`、`pnpm-lock.yaml`（重新生成）。
   - `package.json`：`name: "aia-cdp"`、`private`、`type: "module"`、`license: "MIT"`、`packageManager: "pnpm@10.34.7"`、
     `engines.node: "^24.11.0"`；不写 `prepare` / `postinstall`（Docker 的 prod-deps 阶段会坏）。`scripts` 在本步按步骤 12 的表一次写全，
     后续步骤都用 `pnpm run …`；脚本引用的文件在对应步骤建好之前失败属预期。
   - `.npmrc`：`engine-strict=true`、`save-exact=true`。`.nvmrc`：`24`。
   - `pnpm-workspace.yaml`：`ignoredBuiltDependencies: [esbuild, workerd, vue-demi]`；`publicHoistPattern: [espree, eslint-scope]`
     （防 Debian node 的 `Parsing error: Invalid Version: main`）。改动后删 `node_modules` 全新安装才生效。
   - `.gitignore`（迁 `worker-aia-cdp@5b570aa:.gitignore` 后改）：`node_modules/`、`dist/`、`coverage/`、`.wrangler/`、`.data/`、
     `.vite/`、`*.tsbuildinfo`、`*.log`、`.env.local`、`.env.*.local`、`.dev.vars*`（例外 `!.dev.vars.example`，该文件切片 2 新建）、`worker-configuration.d.ts`、`/tests/fixtures/pki.tmp.*/`（生成器的暂存目录；夹具本身入库）、
     IDE / OS 文件。删掉旧的整目录 `tests/fixtures`（会把生成脚本也藏掉）与 `/public/`、`site/`、`.act*`。
   - `.gitattributes`：`*.sh text eol=lf`。`.prettierrc.json`、`LICENSE`：从 `worker-aia-cdp@5b570aa` 原样迁入。
   - `.prettierignore`：`pnpm-lock.yaml`、`worker-configuration.d.ts`、`docs/openapi.json`、`dist/`、`coverage/`、`.wrangler/`、`.data/`、
     `tests/fixtures/pki/`、`docs/**/*.md`（默认值：手写中文文档的宽表格不交给 Prettier 重排）。
   - 依赖（全部精确版本；浏览器包都是 devDependencies，Docker 运行阶段只装生产依赖）：

   | 组 | 包 |
   | --- | --- |
   | dependencies | `hono@4.13.13`、`@hono/zod-openapi@1.6.3`、`zod@4.6.7`、`@hono/node-server@2.1.5` |
   | dev：工具链 | `typescript@5.9.3`（npm latest 7.0.2 超出 typescript-eslint 的 `<6.1.0`）、`@types/node@24.19.2`、`wrangler@4.151.1` |
   | dev：测试 | `vitest@5.0.5`、`happy-dom@21.0.3`、`@vue/test-utils@2.5.1` |
   | dev：质量 | `eslint@10.13.0`、`@eslint/js@10.0.1`、`typescript-eslint@8.71.2`、`eslint-plugin-vue@10.11.1`、`vue-eslint-parser@10.4.1`、`jiti@2.7.0`（ESLint 10 加载 `eslint.config.ts`）、`prettier@3.9.10` |
   | dev：前端构建 | `vite@8.3.4`、`@vitejs/plugin-vue@6.0.10`、`vue-tsc@3.3.13`、`tailwindcss@4.3.3`、`@tailwindcss/vite@4.3.3`、`tw-animate-css@1.4.0` |
   | dev：浏览器运行 | `vue@3.5.44`、`vue-router@5.4.0`、`@tanstack/vue-query@5.104.4`、`vue-i18n@11.4.16`、`@vueuse/core@14.4.0`（与 reka-ui 2.11.0 的 `^14.1.0` 同一份）、`reka-ui@2.11.0`、`class-variance-authority@0.7.1`、`cn@0.5.0`、`@lucide/vue@1.59.0` |

2. **tsconfig 拓扑与边界检查**（B3、B4、D9；源码约定见本文 §2.1，拓扑概览见本文 §2.2）。重写
   `worker-aia-cdp@5b570aa:tsconfig.json`、`tsconfig.node.json`、`tsconfig.app.json`（→ `tsconfig.web.json`），只参考选项，按下表新写。
   可验证时机：步骤 5 建好 `wrangler.jsonc` 与 `src/runtime/worker.ts` 之后 `pnpm run typecheck`（它先跑 `types`）。

   | 文件 | 要点 |
   | --- | --- |
   | `tsconfig.base.json` | `target`/`lib` `ES2024`；`module`/`moduleResolution` `NodeNext`；`moduleDetection: force`；`verbatimModuleSyntax`、`erasableSyntaxOnly`、`allowImportingTsExtensions`、`rewriteRelativeImportExtensions`、`isolatedModules`、`resolveJsonModule`、`strict`、`noUncheckedIndexedAccess`、`noImplicitOverride`、`noImplicitReturns`、`noFallthroughCasesInSwitch`、`noUnusedLocals`、`noUnusedParameters`、`forceConsistentCasingInFileNames`、`skipLibCheck: true`（pkijs / wrangler 的 d.ts 需要）、`types: []`；不开 `exactOptionalPropertyTypes`（生成组件 10 处报错） |
   | `tsconfig.worker.json` | `noEmit`；`lib: ["ES2024"]`（无 DOM）；`types: ["./worker-configuration.d.ts"]`（只 include 不列 types 时 @types/node 会自动混入，边界失效）；include `src/core/**`、`src/http/**`、`src/storage/r2.ts`、`src/runtime/worker.ts`、`src/runtime/settings.ts`、`tests/boundary/worker-canary.ts` |
   | `tsconfig.node.json` | `noEmit`；`types: ["node"]`；include `src/core/**`、`src/http/**`、`src/storage/**`、`src/runtime/{node,node-ui,settings}.ts`、`scripts/**`、`tests/**`、`eslint.config.ts`、`vite.config.ts`、`vitest.config.ts`；exclude `tests/web/**`、`tests/boundary/worker-canary.ts`；切片 2 起加 `src/cli/**` |
   | `tsconfig.build.json` | extends node；`noEmit: false`、`rootDir: "src"`、`outDir: "dist/server"`、`sourceMap`、`noEmitOnError`；include 只有 `src/runtime/node.ts`（tsc 顺依赖图产出）；不进根 references |
   | `tsconfig.web.json` | `noEmit`；`module: ESNext`、`moduleResolution: Bundler`（shadcn-vue 生成代码无后缀）；`lib` 加 `DOM`、`DOM.Iterable`；`types: ["vite/client"]`；`rewriteRelativeImportExtensions: false`（否则 vue-tsc 在 `.vue` 导入报 TS2876）；`paths {"@/*": ["./src/web/*"]}`；include `src/web/**/*.ts`、`src/web/**/*.vue`、`tests/web/**/*.ts` |
   | `tsconfig.json` | 解决方案式：`files: []`；references 依次 worker、node、web（typescript-eslint 用第一个包含该文件的程序，`src/core`/`src/http` 因此按 Worker 全局检查）；`compilerOptions.paths` 同 web（shadcn-vue 只读这个文件） |

   - canary：`tests/boundary/worker-canary.ts` 为 `// @ts-expect-error -- process must not exist in the Worker program` + `export type NodeLeak = typeof process;`；
     `tests/boundary/node-canary.ts` 为 `// @ts-expect-error -- R2Bucket must not exist in the Node program` + `export type WorkersLeak = R2Bucket;`。
     类型泄漏会让指令变成"未使用"而编译失败；只写类型别名（避开 `no-unsafe-*`），指令带说明（`ban-ts-comment`）。web 程序经 `import type { AppType }`
     在 lib.dom 下第三次编译 `src/http` 与 `src/core`，上面的写法约束对三套全局类型都成立。
   - `scripts/check-worker-program.ts`（D9；quality spike 验证过的约 30 行脚本）：`node_modules/typescript/bin/tsc -p tsconfig.worker.json --listFilesOnly`，
     任一行匹配 `/\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(@types\/node|@hono\/node-server|vite|vitest|wrangler)\//` 即打印条数与前 5 个文件、
     提示 `tsc -p tsconfig.worker.json --explainFiles`，`exitCode = 1`；否则打印文件数。脚本 `typecheck:boundary` = `node scripts/check-worker-program.ts`，
     在 `typecheck` 里紧跟 `types`、先于三套编译（步骤 12；Node 类型泄漏时 worker canary 先报 TS2578，会盖住本脚本指明来源的输出）。spike 中它抓住了
     core 导入 `@hono/node-server` 与 `import type … from "vite"` 两类漏洞（前者编译与 canary 都放过，后者 canary 只报 TS2578），干净树上通过。

3. **存储端口与适配器**（D5、B14）：`src/core/store.ts`、`src/core/digest.ts`、`src/storage/memory.ts`、`src/storage/fs.ts`、`src/storage/r2.ts`。
   - `store.ts`：plan §5.4 的 `ObjectStore` 原样，另导出 `PutOptions`、`PutResult`；加 `assertStoreKey(key)`：`/` 分段，每段
     `[A-Za-z0-9_-][A-Za-z0-9._-]*`（拒绝空键、空段、`.`、`..`、点开头、绝对路径、`\`、NUL），抛 `TypeError`；加 `assertStorePrefix(prefix)`：
     `""`（列全部，测试清桶用）或"一个以上合法段 + 结尾 `/`"（`blobs/`、`history/<targetId>/`），其余（`a`、`/a/`、`a//`、`../`、`./`、`a\b/`、含 NUL）
     抛 `TypeError`；段规则另导出为 `isStoreKeySegment(segment)`（fs 的 `list` 与临时文件清理用）。三个适配器的 `list` 先调 `assertStorePrefix`，其余方法先调 `assertStoreKey`（一个实现；同时是 fs 的穿越防护）。plan §5.1 的全部键
     与切片 4、6 的列表前缀都满足。ETag 不透明、只回传给同一后端，永远不当 HTTP `ETag` 用。
   - `digest.ts`：`sha256Hex(bytes)`，WebCrypto；输入已由 `ArrayBuffer` 支撑时不复制，直接收窄为 `Uint8Array<ArrayBuffer>`。
   - `memory.ts`：`Map`；ETag = 内容 SHA-256；`put` 先 `await` 算摘要，再同步完成比较与写入（两者之间有 `await` 时并发 CAS 会双赢）；
     `put` 与 `get` 都复制字节；`list` 按键排序。语义来源：`worker-aia-cdp@5b570aa:tests/helpers/r2.ts` 的 `MemoryBucket`。
   - `fs.ts`（新写）：根目录由构造参数给，不自动创建；`get`/`head` 读文件算 SHA-256，`ENOENT` → `null`；`put` 在按键的进程内互斥段里：
     读当前 ETag → 判 `ifNoneMatch`/`ifMatch` → `mkdir -p` 父目录 → 同目录写 `.<名>.<uuid>.tmp`（`open(…, "wx")`、写、`sync()`、关闭）→
     `rename` → 从键的父目录到根逐级 fsync（不论目录是否本次创建：别的 put 刚建还没 sync，或建后失败，目录项都可能还不持久）；任一步失败删临时文件。
     `list(prefix)`：自己用 `readdir(dir, { withFileTypes: true })` 递归，只进入名字符合 `isStoreKeySegment` 的目录（`lost+found`、点开头的目录
     从不打开，不可读也无妨），只取名字符合段规则的条目（临时文件、`a (copy).der`、`x.der~` 都不是键，列出来的键一定能 `get`/`delete`），
     `size` 来自 `stat`（跟随符号链接），键用 `/`，排序；根目录不存在返回 `[]`。`removeTemporaryFiles()`：在同样的目录范围里删除匹配
     `.<段>.<uuid>.tmp` 的普通文件（被 SIGKILL、OOM、断电打断的 put 留下的），返回个数；只在没有 put 进行时调用（Node 入口在开始服务前调一次）。
     `delete` 为 `rm(…, { force: true })`。一个目录一个进程（plan §1）。
   - `r2.ts`：结构化类型 `R2BucketLike`（`get`/`head`/`put`/`list`/`delete` 子集），所以在 node 程序里也能编译，`new R2Store(env.STORE)` 由 worker
     程序证明可赋值。`put` → `bucket.put(key, bytes, { httpMetadata: contentType ? { contentType } : undefined, onlyIf })`，`onlyIf` 为
     `{ etagMatches: ifMatch }` 或 `{ etagDoesNotMatch: "*" }`；结果 `null` → `precondition-failed`；其他异常（含 R2 单键写速率）原样抛出
     （切片 2 的重试循环也不重试抛错的 `put`）。`get` 用不带引号的 `R2Object.etag`，不用 `httpEtag`（带引号的值传回 `etagMatches` 会抛 `TypeError`）。`list` 跟随
     `truncated`/`cursor`（每页 1000）。来源：`worker-aia-cdp@5b570aa:src/worker/r2/objects.ts`（`putBinary` 的形状；删 `customMetadata`、
     `getArtifact`、`getExistingCRL`）与 `src/worker/r2/listing.ts`（`listAllWithPrefix` 的游标循环；删边缘缓存）。

4. **HTTP 应用**（B7、B8、B10–B12）：`src/http/types.ts`、`errors.ts`、`schemas.ts`、`log.ts`、`ui.ts`、`app.ts`、`routes/health.ts`，`src/core/health.ts`。
   - `types.ts`：`AppDeps = { store; now: () => Date; settings: AppSettings; clientIpHeader: ClientIpHeader; log: (line: string) => void; ui?: (req: Request) => Response | Promise<Response> }`，
     `ClientIpHeader = "cf-connecting-ip" | "x-forwarded-for"`（入口决定，§2.6）；
     `AppSettings = { logFormat: "json" | "pretty"; trustProxy: boolean; maxUploadBytes: number; adminToken?: string; uploadToken?: string }`；
     `AppEnv` 不含 `Bindings`（应用不认识运行时 env）。
   - `schemas.ts`：`ERROR_CODES` = plan §7.3 全部错误码；`errorSchema(codes)` 每个状态码一个 schema；`HealthOk`（`status: healthy | degraded`，
     `checks.store: "ok"`，`checks.configuration: ok | missing | invalid`）、`HealthUnavailable`（`unhealthy`，`store: "error"`，`configuration: "unknown"`），
     均 `.openapi()` 命名。
   - `errors.ts`（重写 `worker-aia-cdp@5b570aa:src/worker/api/v2/response.ts`）：`errorBody`、`ApiError`（显式字段，非参数属性）、
     `createErrorHandler(log)`：`ApiError` → 信封；`HTTPException` → 按状态取码、库文本换成自己的文案、保留 `WWW-Authenticate` / `Allow` /
     `Retry-After`；其他 → 500 `{"error":{"code":"internal","message":"Internal server error"}}`，栈只进日志。`onMethodNotAllowed` → 信封 + `Allow`；
     `validationHook` → 400 `bad_request`，`details.issues`（`issue.path.map(String)`）。
   - `log.ts`：`next()` 之后写一行 `{"level":"info","msg":"request","method","path","status","ms"}`；`settings.trustProxy` 为真时加 `client`
     （`deps.clientIpHeader` 为 `cf-connecting-ip` 取整个值，为 `x-forwarded-for` 只取最右一项；`isIpAddress` 判定是 IPv4 点分十进制或 IPv6 字面量才记，
     否则省略，§2.6）；`path` 用 `c.req.path`（不含查询串）；不记任何头与体；`pretty` 输出一行人读文本（裸值只限不含空格、`"`、`=` 的可打印 ASCII，
     其余 JSON 编码并转义 DEL、C1、U+2028 / U+2029）。签名 `requestLog(deps, log)`：`deps` 只用 `settings.trustProxy` 与 `clientIpHeader`；`log` 是
     `createLogger(deps)` 的结构化 Logger（与 `createErrorHandler(log)` 同一个），不是 `deps.log`。
   - `core/health.ts` + `routes/health.ts`（重写 `worker-aia-cdp@5b570aa:src/worker/api/v2/stats.ts` 的健康部分，它把 `cache: ok` 写死，§10 #15）：
     `head("config.json")` 抛错 → `unhealthy` 503；`null` → `missing`；存在 → `get` 后 `JSON.parse` 且 `version === 1` → `ok`，否则 `invalid`
     （`get` 抛错按 `unhealthy`）。两项都 ok 才 `healthy`，`degraded` 为 200。`Cache-Control: no-store`。异常写一行
     `{"level":"error","msg":"health_store_error","error":{name,message}}`，不进响应体。`createRoute` 带 `operationId: "getHealth"` 与 `summary`。
     切片 2 把 `version === 1` 换成完整 config schema。本切片的测试与冒烟要"已配置"时一律写最小配置
     `{"version":1,"certificates":{},"targets":{},"paths":{}}`（下称最小配置，切片 2 的完整 schema 下仍是 `ok`），不写 `{"version":1}`。
   - `ui.ts` + `app.notFound`：保留前缀 `^/api(?:/|$)` 与 `^/(?:ca|crl|dcrl)/`（带尾斜杠：`/crls/`、`/certificates/` 是 UI 路由）。前缀在规范化后的路径
     （`reservedPrefixPath`：`%2F` / `%2f` 解码、连续 `/` 合并）上匹配，`//api/v1/x`、`/api%2Fv1/x`、`/crl%2fx` 也是保留前缀（C12）；路由本身仍看原始路径。

   | 请求 | 响应 |
   | --- | --- |
   | `/api`、`/api/*` 未命中 | JSON 信封 404 `not_found`，`no-store` |
   | `/ca/*`、`/crl/*`、`/dcrl/*` 未命中 | `text/plain` 404 `Not Found`，`no-store`（CryptoAPI 客户端；与线上一致） |
   | 已注册路径、方法不符 | 405 信封 + `Allow`（GET 路由自动含 HEAD） |
   | 其他路径 GET / HEAD | `deps.ui(req)`，先复制（`new Response(res.body, { status, statusText, headers: new Headers(res.headers) })`，workerd 的绑定响应头不可变）；路径在 `/assets/` 下、最后一段带扩展名、响应不是 `text/html` 且状态为 200 / 206 / 304 时设 `public, max-age=31536000, immutable`，其余（含 `/assets/`、`/assets/foo` 得到的 SPA `index.html` 与 ui 的错误状态，状态码照传）一律 `no-cache`；ui 返回 404，或最后一段带扩展名（非 `.html`）而 ui 返回 `text/html`（SPA 兜底）→ 纯文本 404；304 原样返回（头已改写） |
   | 其他路径的其他方法；或未注入 `ui` | 纯文本 404 |

   - `app.ts`：`new OpenAPIHono<AppEnv>({ defaultHook: validationHook })`；`onError`、`notFound`；中间件顺序
     `secureHeaders({ strictTransportSecurity: false })` → `requestLog(deps, log)` → `methodNotAllowed({ app, onMethodNotAllowed })` →
     （认证 / `bodyLimit` 见切片 2、4）→ 路由。`GET /api/v1/openapi.json`：每个 app 实例首次请求时 `getOpenAPI31Document(OPENAPI_CONFIG)` 序列化并缓存，
     `public, max-age=300`。返回 `app.route("/api/v1", healthRoutes(deps))` 的链式值；导出 `OPENAPI_CONFIG`
     （`openapi: "3.1.0"`，`info: { title: "aia-cdp API", version: "1" }`）与 `type AppType`。规则：不注册 `app.get("*")`（会让所有未知路径的 POST
     变 405）；全部路由在 `createApp` 内注册完（SmartRouter 首个请求后冻结）。

5. **运行时入口**（B6、B13）：`src/runtime/settings.ts`、`node-ui.ts`、`node.ts`、`worker.ts`、`wrangler.jsonc`。来源：重写
   `worker-aia-cdp@5b570aa:src/worker/worker.ts`（保留"`/api` 未命中 JSON 404、下载前缀未命中文本 404、其余交给 ASSETS"的路由规则）与
   `src/worker/env.ts`（改为 `wrangler types` 的 `Env` + settings）。
   - `settings.ts`：纯 zod、无 `node:*`（Worker 与 Node 共用）；字段与默认值严格按 plan §4.2（`PORT` 0–65535、`AIA_STORE` 只有 `fs`、
     `AIA_TRUST_PROXY` 只接受 `true`/`false`、`AIA_MAX_UPLOAD_BYTES` 正整数、`AIA_LOG_FORMAT` `json`/`pretty`、令牌可选且非空）。
     `resolveFileVariants(env, readText)`：`X_FILE` 读文件、去掉一个结尾换行；`X` 与 `X_FILE` 同时设置报错。`parseSettings(env)` 返回可读的失败原因。
   - `node-ui.ts`：`createNodeUi(staticDir)` 内部一个 `Hono`：`use(serveStatic({ root }))`，再对最后一段无扩展名的路径
     `use(serveStatic({ root, path: "index.html" }))`；返回 `(req) => inner.fetch(req)`。
   - `node.ts`：解析 `_FILE`（`readFileSync`）与设置，失败 → stderr 原因 + exit 1；`AIA_DATA_DIR` 必须是可读写目录，否则 JSON 错误日志 + exit 1；
     `<AIA_STATIC_DIR>/index.html` 不存在 → 一行 `{"level":"warn","msg":"static_dir_missing","staticDir":<解析后的绝对路径>}` 后照常启动（不退出：
     `dev:node` 不构建 UI，UI 由 Vite dev server 提供）；开始服务前调一次 `FsStore.removeTemporaryFiles()`，记 `{"level":"info","msg":"temp_files_removed","count":N}`
     （抛错只记 warn `temp_files_cleanup_failed`）；`createApp({ store, now: () => new Date(), settings, clientIpHeader: "x-forwarded-for", log: 写 stdout 一行,
     ui: createNodeUi(staticDir) })`；`serve({ fetch: app.fetch, port })`（显式传 port，默认是 3000；不传 hostname → `::` 双栈）；就绪日志
     `{"level":"info","msg":"listening","port":<实际端口>}`；`server.on("error")` → JSON 日志 + exit 1；SIGTERM / SIGINT → `shutdown` 日志、`server.close()`
     （回调里 `closed` 日志、exit 0，出错 1），随即 `closeIdleConnections()`，2 s 宽限（`unref()`）后 `closeAllConnections()`：还没发完请求的连接
     （preconnect、半截请求头、慢客户端）`close()` 会一直等，而 `close()` 又停掉了 Node 的请求头超时检查；10 s `unref()` 强制退出（exit 1）只作兜底。生产：`node --enable-source-maps dist/server/runtime/node.js`；开发与测试可直接 `node src/runtime/node.ts`（type stripping）。
   - `worker.ts`：`WeakMap<Env, App>` 按 env 缓存；`type WorkerEnv = Env & Partial<Record<"AIA_ADMIN_TOKEN" | … | "AIA_LOG_FORMAT", unknown>>`（令牌可选，
     不用 `secrets.required`；wrangler 的 `vars` 可以是任意 JSON 值、原样到达）：这五个变量的布尔与数字先 `String()` 再交 `parseSettings`
     （`"AIA_TRUST_PROXY": true`、`"AIA_MAX_UPLOAD_BYTES": 1048576` 可用），对象、数组、`null` 作为无效设置（错误只点名变量，不回显值）；
     `createApp({ store: new R2Store(env.STORE), now, settings, clientIpHeader: "cf-connecting-ip", log: (l) => console.log(l), ui: (req) => env.ASSETS.fetch(req) })`；
     `export default { fetch(req, env, ctx) { … } } satisfies ExportedHandler<Env>`；设置无效时每个请求返回 500 信封并记一行 error 日志。
   - `wrangler.jsonc`（迁 `worker-aia-cdp@5b570aa:wrangler.jsonc` 后改；`name` 绝不能是旧的 `aia-cdp-worker`）：

     ```jsonc
     {
       "$schema": "./node_modules/wrangler/config-schema.json",
       "name": "aia-cdp",
       "main": "src/runtime/worker.ts",
       "compatibility_date": "2026-10-12",
       "minify": true,
       "upload_source_maps": true,
       "send_metrics": false,
       "observability": { "logs": { "enabled": true } },
       "r2_buckets": [{ "binding": "STORE" }],
       "assets": {
         "directory": "dist/web",
         "binding": "ASSETS",
         "run_worker_first": true,
         "not_found_handling": "single-page-application"
       }
     }
     ```

     不设 `compatibility_flags`（nodejs_compat 自 2026-08-04 默认开，真正的护栏是 tsconfig 的 `types`）、`build.command`、`vars`；删除旧的
     `env.local`、`keep_vars`、`vars.SITE_NAME`、`limits.cpu_seconds`（无效键，wrangler 静默忽略）。`send_metrics` 挡不住 deploy 的 autoconfig 事件，
     所以脚本另设 `WRANGLER_SEND_METRICS=false WRANGLER_HIDE_BANNER=true`。`compatibility_date` 与 wrangler 一起升级。

6. **Web 占位与 shadcn-vue**（D1、D6、B20）。先写 `tsconfig.json`（含 `paths`）、`vite.config.ts`、`src/web/styles/main.css`（内容 `@import "tailwindcss";`；
   取代 `worker-aia-cdp@5b570aa:src/web/styles/tailwind.css`，重写、不参考旧文件），再初始化：
   - `vite.config.ts`（重写 `worker-aia-cdp@5b570aa:vite.config.ts`）：`root: src/web`、`envDir: <repo>`、`plugins: [vue(), tailwindcss()]`、
     `resolve.alias["@"] = src/web`、`build.outDir: <repo>/dist/web`、`emptyOutDir: true`、`server.proxy: { "^/(?:api|ca|crl|dcrl)/": "http://127.0.0.1:8787" }`
     （字符串键 `/crl` 会吞掉 SPA 路由 `/crls/`）。`loadEnv(mode, repoRoot, "VITE_")` 取 `VITE_SITE_NAME`，空则默认 `PKI AIA/CDP`，含 `< > & "` 即抛错
     （`%VITE_SITE_NAME%` 不做 HTML 转义），再写回 `process.env.VITE_SITE_NAME`。不写 `minify: "esbuild"`、对象形式 `manualChunks`、固定文件名。
   - `pnpm dlx shadcn-vue@2.8.2 init --base reka --style nova --icon-library lucide --base-color neutral --font inter --yes --no-rtl --no-pointer < /dev/null`，
     然后 `pnpm dlx shadcn-vue@2.8.2 add button badge --yes < /dev/null`。永远不用 `--defaults`（= `--preset nova --template nuxt`），永远显式 `--style`。
   - 初始化后：删 `main.css` 里的 Google Fonts `@import url(...)` 与 `components.json` 的 `"font"` 键（否则每次 `add` 都加回）；CLI 写进
     `dependencies` 的包用 `pnpm add -D <包>@<步骤 1 的版本>` 移到 devDependencies；
     `pnpm exec prettier --write src/web/styles/main.css components.json src/web/components/ui src/web/lib` 改成仓库风格（`init` 重写的 `main.css` 用单引号，
     删掉字体行后还留有开头空行，`format:check` 会报）；每次 `add` 之后重跑同一命令；提交 `components.json`、生成文件与 lockfile（registry 是活的，
     重跑 `add` 可能得到不同代码）。
   - 迁入：`src/web/index.html`（迁 `worker-aia-cdp@5b570aa:src/web/index.html`，`%SITE_NAME%` → `%VITE_SITE_NAME%`，保留两个 favicon 链接）、
     `src/web/public/favicon.svg`、`favicon.ico`（原样）、`src/web/env.d.ts`（迁后改：保留 `*.vue` shim 供 typescript-eslint，`ImportMetaEnv.VITE_SITE_NAME: string`，
     加 `ViteTypeOptions.strictImportMetaEnv`，去掉 `/// <reference types="vite/client" />`）。
   - 新写（`worker-aia-cdp@5b570aa:src/web/main.ts` 重写、不参考：Pinia 退出）：`main.ts`（router、i18n、`VueQueryPlugin` + `QueryClient({ defaultOptions: { queries: { staleTime: 0 } } })`、`./styles/main.css`）；`App.vue`
     （页头：站名、`HealthBadge`、`ThemeToggle`、`LocaleSwitch`；`<RouterView>`）；`router.ts`（`createAppRouter(history = createWebHistory())`：`/`、
     `/certificates/:id`、`/crls/:targetId`、`/:pathMatch(.*)*`，详情页懒加载）；`pages/{Overview,Certificate,Crl,NotFound}Page.vue` 占位；`i18n.ts`
     （`createAppI18n(locale)`）+ `locales/en.json`、`locales/zh-CN.json`；`site.ts`（`siteName = import.meta.env.VITE_SITE_NAME`）；`client/api.ts`
     （`hc<AppType>("", { init: { cache: "no-store" } })`，`import type { AppType } from "../../http/app.ts"`）；`components/HealthBadge.vue`（`useQuery` 调
     `api.api.v1.health.$get()`：200 显示 healthy / degraded，503 显示 unhealthy，网络错误显示 unknown，用生成的 `Badge`）；`components/ThemeToggle.vue`
     （`const { store } = useColorMode({ storageKey: "theme-preference" })`，沿用旧实现的键与取值，见切片 5b 步骤 9）；`components/LocaleSwitch.vue`。
   - `src/web` 顶层目录不得叫 `api`、`ca`、`crl`、`dcrl`（`root: src/web` 时 dev server 把目录当 URL 服务），客户端放 `src/web/client/`。

7. **ESLint 与 Prettier**（B17）：`eslint.config.ts`（迁 `worker-aia-cdp@5b570aa:eslint.config.ts` 后改）。
   - `defineConfig` / `globalIgnores` 来自 `eslint/config`；忽略 `dist/`、`coverage/`、`.wrangler/`、`.data/`、`tests/fixtures/pki/`、`worker-configuration.d.ts`。
   - `js.configs.recommended`、`tseslint.configs.recommendedTypeChecked` + `stylisticTypeChecked`；`parserOptions: { projectService: true,
     tsconfigRootDir: import.meta.dirname, extraFileExtensions: [".vue"] }`。之后 `pluginVue.configs["flat/recommended"]`、
     `{ name: "vue/no-layout-rules", rules: pluginVue.configs["no-layout-rules"].rules }`（它的类型是 LegacyConfig，只取 rules）；`**/*.vue`：
     `parserOptions.parser: tseslint.parser`、`no-undef: off`、`vue/multi-word-component-names: off`。
   - 保留旧规则：`eqeqeq`、`curly: all`、`prefer-template`、`no-unused-vars`（`_` 前缀）、`no-explicit-any`、`no-non-null-assertion`（tests 关闭）。
     新增 `consistent-type-imports`（separate）+ `no-import-type-side-effects`；`require-await: off`（实现异步端口的方法可以没有 await）。
     删除手写 globals、`semi`、`naming-convention`、对 `console.log` 的警告（Workers 日志就是 `console.log`）、旧 `src/worker/pki/**` 的 restricted-imports
     （由下一条取代）。不用 `--cache`。
   - 分层规则（D9）：`src/core/**` 的 `no-restricted-imports` `patterns` 禁 `**/http/**`、`**/storage/**`、`**/runtime/**`、`**/web/**`、`hono`、`hono/*`、
     `@hono/*`、`node:*`、`vite`、`vitest`、`wrangler`；`src/http/**` 禁 `node:*`、`@hono/node-server`、`**/storage/fs.ts`、`**/runtime/**`。`import type`
     同样受限。规则写对与否由出口 9 的探针证明（相对路径 `../http/…` 必须被 `**/http/**` 拦住）。
   - 生成组件也 lint；警告与错误同等对待：`lint` 与 `check` 用 `eslint --max-warnings 0`。生成代码上触发的任何规则（类型感知规则，以及
     `reka-nova` 的 `Button` / `Badge` 已触发的 `vue/require-default-prop` 警告）只为 `src/web/components/ui/**` 关掉那条规则，不手改生成代码（Prettier 除外）。

8. **OpenAPI 生成**（B11）：`scripts/generate-openapi.ts`（重写 `worker-aia-cdp@5b570aa:scripts/generate-openapi.ts`，保留字节级 `--check`）与提交的 `docs/openapi.json`。
   用 `createApp({ store: new MemoryStore(), now: () => new Date(0), settings: <parseSettings({}) 的默认值>, clientIpHeader: "x-forwarded-for", log: () => {} }).getOpenAPI31Document(OPENAPI_CONFIG)`
   （`parseSettings` 来自 `src/runtime/settings.ts`，与步骤 10 的 `testDeps()` 同源，运行时文档与 `docs/openapi.json` 因此出自相同的 deps），
   写 `JSON.stringify(doc, null, 2) + "\n"`；`--check` 不一致时 exit 1 并提示运行 `pnpm run openapi`。直接 `node scripts/generate-openapi.ts` 运行。
   `src` 不导入 `docs/openapi.json`（越出 `rootDir: src`，Node 产物运行时找不到）。

9. **夹具**（B16、D7）：`tests/fixtures/generate-test-data.sh`、`tests/fixtures/global-setup.ts`、`tests/fixtures/pki.ts`。脚本是对
   `worker-aia-cdp@5b570aa:scripts/generate-test-data.sh` 的重写，成品已在工作树：`tests/fixtures/generate-test-data.sh`（未跟踪，713 行，sha256
   `872a483b05ac846a075f7c0c1d6044557b461ec0614455c03d63f064d9cc7ac6`，2026-10-19 从 fixtures spike 逐字节拷入）。
   - 提交：先原样提交该文件（`sha256sum` 核对上面的值，保留来源），再单独提交下一条的修改。
   - 必改 `leaf-min`：OpenSSL 3 对没写 SKI / AKI 的扩展节默认补上两者，spike 产出的 `certs/leaf-min` 带 SKI 与 AKI（manifest 写的
     "basicConstraints only" 不实；切片 2 的 `summary.test.ts` 与 V5 反例要求它没有 SKI）。`[ ext_leaf_min ]` 改为三行
     `basicConstraints       = critical, CA:FALSE`、`subjectKeyIdentifier   = none`、`authorityKeyIdentifier = none`，2026-10-19 在 OpenSSL 3.5.5 与
     3.0.20（`node:24-bookworm`）上实测两项都消失。改后 715 行，sha256 变为 `a37b4bd64f91f957d1cb3b8051ee5932b15632c94ce1bdad97f51ad2e8bba7c7`
     （照这三行原样改得出；实测值写进合并说明），`.stamp` 与 manifest 的 `generatorSha256` 随之变，已有的生成树下次运行整体重建。
   - 历史：spike 原件 2026-10-18 在 tmpfs 上（`/tmp/claude-1000/-home-acha-aia-cdp/639b68bb-844a-43cc-840b-763e935adee5/scratchpad/spikes/fixtures/generate-test-data.sh`，
     重启即失），`~/.cache/aia-cdp/batch1-scratch-2026-10-19.tgz` 是该目录的备份。工作树文件与备份都拿不到时按下表与附录 D 重写：附录 D 的用例矩阵
     （文件名、签发者、kind、CRL 号、时间、`expect`、scenarios）是重写契约，后续切片的测试按它写；摘要与大小随密钥变，不在契约内。

   | 项 | 约定 |
   | --- | --- |
   | 调用 | `bash tests/fixtures/generate-test-data.sh [--force \| --check] OUT_DIR`；永远用 `bash` 调用（owner 的交互 shell 是 zsh） |
   | 产物 | `certs/`（12 张：EC P-384 根、AD CS SubCA 形状的 RSA 签发 CA ×2、同钥续期、rogue、Ed25519、Ed448、5 张叶子）、`crls/<issuer>/<case>.der`（30 个，另 3 个 PEM 变体）、`invalid/`（6）、`manifest.json`（`now = 2026-01-04T00:00:00Z`、声明值、`expect`、17 个 `scenarios`）、`SHA256SUMS`、`.stamp`（脚本 sha256，最后写）；逐项见附录 D |
   | 确定性 | 日期、序列号、CRL 号固定（`openssl ca -startdate/-enddate`、`-crl_lastupdate/-crl_nextupdate`、固定 serial / crlnumber 文件）；只有密钥派生值变 |
   | 幂等 | stamp 相符且 `SHA256SUMS` 校验通过 → 不写（约 15 ms）；`--check` 只读，0 / 1；`--force` 重建（约 2.2 s） |
   | 安全 | 私钥、CSR、CA 库只在 `mktemp -d`（0700），EXIT trap 删除；产物含 `PRIVATE KEY` 即失败；暂存到 `OUT_DIR.tmp.*` 后 rename；`flock` 串行；非空且无 `.stamp` 的目录拒绝覆盖；openssl 失败立即退出 |
   | 依赖 | bash、OpenSSL ≥ 3.0（拒绝 LibreSSL；`OPENSSL=` 可覆盖）、od / awk / sed；不再需要 Node |

   - `global-setup.ts`：`spawnSync("bash", [脚本, "--check", tests/fixtures/pki])`，每个 vitest 进程一次，不用 `pretest`；不一致即抛错并提示
     `pnpm run fixtures` 后提交。（原为每次调用生成器、产物 gitignore；夹具入库后改为只校验。）
   - `pki.ts`：导出 `manifest`、`NOW = new Date(manifest.now)`、`fixture(path)`。规则：sha256、key id、大小、签名永远从文件或 manifest 读，不写字面量
     （ECDSA 签名长度每次生成都变）。切片 1 只有夹具自检用到它；发布场景见切片 2、4。永远不以 root 身份生成。

10. **vitest**（B15）：`vitest.config.ts`（独立文件，不继承 `vite.config.ts` 的 `root`）。根 `test`：`environment: "node"`、`hookTimeout` 与
    `teardownTimeout` 10 s、`globalSetup: ["./tests/fixtures/global-setup.ts"]`；`projects`：`core`、`http`、`storage`、`integration`（各自
    `tests/<名>/**/*.test.ts`）与 `web`（`plugins: [vue()]`、`resolve.alias["@"]`、`environment: "happy-dom"`、`env: { VITE_SITE_NAME: "Test PKI" }`）。
    HTTP 测试走 `createApp(testDeps()).request()`，`tests/helpers/app.ts` 的 `testDeps()` 用 `MemoryStore`、固定 `now`、`parseSettings({})` 的默认值、`clientIpHeader: "x-forwarded-for"`（Node 入口的取值，可覆盖），并收集日志行。

11. **Docker**（B18）：`Dockerfile`、`.dockerignore`。

    ```dockerfile
    # syntax=docker/dockerfile:1
    ARG NODE_VERSION=24
    FROM node:${NODE_VERSION}-slim AS base
    ENV PNPM_HOME=/pnpm COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    WORKDIR /app
    RUN corepack enable pnpm
    COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
    RUN corepack install

    FROM base AS prod-deps
    RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --prod --frozen-lockfile --ignore-scripts

    FROM base AS build
    RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --ignore-scripts
    COPY tsconfig.base.json tsconfig.node.json tsconfig.build.json vite.config.ts ./
    COPY src ./src
    ARG VITE_SITE_NAME
    RUN pnpm run build:web && pnpm run build:server

    FROM node:${NODE_VERSION}-slim AS runtime
    ENV NODE_ENV=production
    WORKDIR /app
    RUN mkdir -p /data && chown node:node /data
    COPY --from=prod-deps /app/node_modules ./node_modules
    COPY package.json ./
    COPY --from=build /app/dist ./dist
    USER node
    VOLUME /data
    EXPOSE 8080
    HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=3 \
      CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/v1/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"]
    CMD ["node", "--enable-source-maps", "dist/server/runtime/node.js"]
    ```

    - `.dockerignore` 用白名单：`*`，再放行 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`.npmrc`、`tsconfig.base.json`、`tsconfig.node.json`、
      `tsconfig.build.json`、`vite.config.ts`、`src`；末尾 `**/*.test.ts`、`**/.env*.local`。`tests/fixtures`、`.dev.vars`、`.wrangler`、`.git` 进不了构建上下文。
    - `ARG VITE_SITE_NAME` 不设默认（空值与未传都落到 `vite.config.ts` 的默认）；`package.json` 必须进运行镜像（`"type": "module"`）；基础镜像用浮动的
      `node:24-slim`（bookworm），digest 固定以后再定。CI 里不用 `--no-cache`（会清掉 store 缓存挂载）。

12. **冒烟脚本与 `package.json` scripts**：`scripts/smoke.sh`、`scripts/node-smoke.sh`、`scripts/worker-smoke.ts`、`scripts/docker-smoke.sh`。
    - `smoke.sh <base-url>`：与运行时无关的 curl 用例（见"测试"末行），任一失败 exit 1；从 `index.html` 解析哈希 JS 文件名；不测 `/index.html`
      （Workers 的 `html_handling` 回 307，Node 回 200）。
    - `node-smoke.sh`：要求已 `pnpm run build`；临时 `AIA_DATA_DIR`、`PORT=0`，从就绪日志取端口，启动 `node --enable-source-maps dist/server/runtime/node.js`，
      跑 `smoke.sh`，写入最小配置（步骤 4）后检查 `healthy`，SIGTERM 后 12 s 内 exit 0；trap 清理。
    - `worker-smoke.ts`：`createTestHarness({ workers: [{ configPath: "./wrangler.jsonc", prebuiltWorkerDir: "./dist/worker" }] })`，`listen()` 后对其
      URL 跑 `smoke.sh`，`finally` 里 `close()`（测的是 dry-run 产物本身；存储隔离，health 为 `degraded`）。
    - `docker-smoke.sh`：`docker build --check .`；构建；建临时命名卷；`docker run -d -p 127.0.0.1::8080 -v <卷>:/data`；60 s 内等到
      `.State.Health.Status = healthy`；health 为 200 且 `"status":"degraded"`；跑 `smoke.sh`；`docker exec` 检查 `id -u` 为 1000、写入
      `/data/config.json` = 最小配置后 `healthy`；`docker stop` 5 s 内完成且退出码 0；trap 删容器与卷。

    | script | 命令 |
    | --- | --- |
    | `types` | `WRANGLER_SEND_METRICS=false WRANGLER_HIDE_BANNER=true wrangler types --env-file=/dev/null`（不读 `.dev.vars`，生成结果确定） |
    | `typecheck:worker` / `:node` / `:web` | `tsc -p tsconfig.worker.json` / `tsc -p tsconfig.node.json` / `vue-tsc -p tsconfig.web.json` |
    | `typecheck:boundary` | `node scripts/check-worker-program.ts`（D9，步骤 2） |
    | `typecheck` | `pnpm run types && pnpm run typecheck:boundary && pnpm run typecheck:worker && pnpm run typecheck:node && pnpm run typecheck:web`（boundary 在前，见步骤 2） |
    | `lint` / `lint:fix` | `pnpm run types && eslint --max-warnings 0 .` / `pnpm run types && eslint --fix .` |
    | `format` / `format:check` | `prettier --write .` / `prettier --check .` |
    | `openapi` / `openapi:check` | `node scripts/generate-openapi.ts` / `node scripts/generate-openapi.ts --check` |
    | `check` | `pnpm run typecheck && eslint --max-warnings 0 . && pnpm run format:check && pnpm run openapi:check` |
    | `test` / `test:r2` | `vitest run` / `WRANGLER_SEND_METRICS=false WRANGLER_HIDE_BANNER=true AIA_TEST_R2=1 vitest run --project storage`（r2 套件在 `import("wrangler")` 前也自设这两个变量） |
    | `fixtures` / `:check` / `:force` | `bash tests/fixtures/generate-test-data.sh [--check \| --force] tests/fixtures/pki` |
    | `build:web` / `build:server` / `build` | `vite build` / `tsc -p tsconfig.build.json` / `pnpm run build:web && pnpm run build:server` |
    | `start` | `node --enable-source-maps dist/server/runtime/node.js` |
    | `dev:web` / `dev:node` / `dev:worker` | `vite` / `mkdir -p .data && PORT=8787 AIA_DATA_DIR=.data node src/runtime/node.ts` / `pnpm run build:web && WRANGLER_SEND_METRICS=false WRANGLER_HIDE_BANNER=true wrangler dev --ip 127.0.0.1 --port 8787` |
    | `smoke:node` / `smoke:worker` | `bash scripts/node-smoke.sh` / `node scripts/worker-smoke.ts` |
    | `verify` | `pnpm run check && pnpm run test && pnpm run build` |
    | `ci:check` / `ci:test` | `pnpm run check` / `pnpm run test && pnpm run build && pnpm run smoke:node` |
    | `ci:worker` | `pnpm run build:web && WRANGLER_SEND_METRICS=false WRANGLER_HIDE_BANNER=true wrangler deploy --dry-run --outdir dist/worker && ! grep -q '"node:' dist/worker/worker.js && pnpm run smoke:worker && pnpm run test:r2`（`"node:` 断言为 D9；spike 的 Worker 包里为 0 处） |
    | `ci:docker` | `bash scripts/docker-smoke.sh` |

    不加 `deploy` 脚本：新 Worker 名首次真实部署会自动置备新桶 `aia-cdp-store`，桶的决定见切片 7。

13. **CI 与 dependabot**（B19、D3）：`.github/workflows/ci.yml`（重写 `worker-aia-cdp@5b570aa:.github/workflows/ci.yml`）、`.github/dependabot.yml`（迁后改）。
    - `ci.yml`：push / PR 到 `main` 与 `workflow_dispatch`；`permissions: contents: read`；按 ref 并发取消；`env` 设 `WRANGLER_SEND_METRICS=false`、
      `WRANGLER_HIDE_BANNER=true`；四个任务 `check` / `test` / `worker` / `docker`，均 `runs-on: ubuntu-24.04`（OpenSSL 3.0.x），步骤为
      `actions/checkout@v6`、`pnpm/action-setup@v4`、`actions/setup-node@v6`（`node-version-file: .nvmrc`、`cache: pnpm`）、`pnpm install --frozen-lockfile`、
      `pnpm run ci:<job>`。远端建立前不运行；本机脚本是唯一事实来源。
    - `dependabot.yml`：`npm`、`github-actions`、`docker` 三个生态，每周一 09:00 America/Vancouver；修掉旧的双前缀（`prefix: "chore"` + `include: scope`；
      actions 用 `prefix: "ci"`）；npm 忽略 `typescript` ≥ 6.1 与 `@types/node` 的 major 升级。远端建立前处于休眠。

14. **文档**：`README.md` 重写为最小中文版（用途、Node 24 PATH 前缀、OpenSSL ≥ 3.0、`pnpm install` 后先 `pnpm run types`、`verify` 与 `ci:*`、
    三个 `dev:*`、bind mount 的 `/data` 须属 uid 1000；完整内容见切片 6）。`docs/templates/implementation-slice.md` 迁
    `worker-aia-cdp@5b570aa:docs/templates/implementation-slice.md` 后改：PR 改为本地分支合并，保留"不授权部署或改动生产对象存储"一行。

15. **devcontainer**（D10）：`.devcontainer/devcontainer.json`（重写 `worker-aia-cdp@5b570aa:.devcontainer/devcontainer.json`：旧版是 Node 22 镜像加未固定版本的
    act 安装脚本）。纯 JSON、不写注释（出口 13 用 `JSON.parse` 校验；Prettier 照常格式化）：
    - `image`: `mcr.microsoft.com/devcontainers/typescript-node:5-24-bookworm`。选法：2026-10-19 查 MCR 标签表
      （`https://mcr.microsoft.com/v2/devcontainers/typescript-node/tags/list`），取镜像大版本 5 的 Node 24 bookworm 变体；它与 `24-bookworm` 同 digest
      （`sha256:970eebf5…`，镜像 5.2.3，`NODE_VERSION=24.21.0` 满足 `^24.11.0`，元数据 `remoteUser: node`）。固定大版本 `5-` 防镜像大改静默生效；
      bookworm 的 OpenSSL 3.0.x 与 CI（ubuntu-24.04）、`node:24-slim` 一致；不用不带发行版的 `24`（digest 不同）。
    - `features`: `{ "ghcr.io/devcontainers/features/powershell:1": {} }`（`pwsh` 用来解析与试跑 `scripts/adcs-crl-uploader.ps1`；真实 AD CS 验证仍在 Windows，切片 4）。
      不装 `act`（无远端，CI 就是 `pnpm run ci:*`）。容器内 Docker 可选：需要在容器里跑 `ci:docker` 时自行加
      `ghcr.io/devcontainers/features/docker-outside-of-docker:1`，默认不加，`ci:docker` 在主机上跑。
    - `remoteUser: "node"`，`updateRemoteUserUID` 保持默认 `true`（容器 uid 对齐主机用户，工作树里生成的文件不属 root）；`containerEnv`
      `{ "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0", "WRANGLER_SEND_METRICS": "false" }`；`postCreateCommand`:
      `corepack enable --install-directory "$(npm prefix -g)/bin" pnpm`（以 `node` 运行，不用 sudo。2026-10-19 在该镜像实测：`corepack enable pnpm` 写
      root 所有的 `/usr/local/bin`，EACCES；`--install-directory ~/.local/bin` 目录不存在、也不在 PATH 上，镜像自带的全局 pnpm 12 在 PATH 上靠前。
      `npm prefix -g` 即属 `node` 的 `/usr/local/share/npm-global`，shim 替换其 `bin/pnpm`）；`forwardPorts`: `[5173, 8080, 8787]`。
    - 不在 `postCreateCommand` 里装依赖或生成夹具：首次进入后手动 `pnpm install --frozen-lockfile`，夹具已入库。

## 测试

| 文件 | 用例 |
| --- | --- |
| `tests/core/health.test.ts` | `checkHealth` 矩阵：缺失 → `degraded`/`missing`；最小配置 → `healthy`/`ok`；`not json`、`{"version":2}`、`[]`、`null` → `invalid`；`head` 抛错 → `unhealthy`/`unknown`；`head` 成功而 `get` 抛错 → `unhealthy` |
| `tests/core/store-keys.test.ts` | `assertStoreKey` 接受 plan §5.1 的四类键；拒绝 `""`、`/a`、`a//b`、`../a`、`a/./b`、`.a`、`a\b`、含 NUL。`assertStorePrefix` 接受 `""`、`blobs/`、`blobs/crls/<uuid>/`、`history/<uuid>/`；拒绝 `blobs`、`/a/`、`a//`、`../`、`./`、`a\b/`、含 NUL |
| `tests/storage/conformance.ts`（共享，`describeObjectStore(name, factory)`；每例拿一个空存储：memory / fs 每例新建实例与临时目录，r2 见下行） | ① 缺失键 `get`/`head` → `null`，`delete` 不报错；② 无条件 `put` 后 `get` 字节相等、ETag 等于 `put` 返回值，`head.size` 正确；③ 改动 `put` 的输入或 `get` 的输出不影响已存对象；④ `ifNoneMatch: "*"`：缺失键成功，已存在 → `precondition-failed` 且内容不变；⑤ `ifMatch` 当前 ETag → 成功且 ETag 改变；⑥ 过期 `ifMatch` → `precondition-failed`，内容不变；⑦ 缺失键上的 `ifMatch` → `precondition-failed`；⑧ 同一 `ifMatch` 并发 5 次 → 恰好 1 次 `ok`（5 份字节互不相同且都不同于当前内容：ETag 按内容生成，同内容写入不改 ETag，会人人"成功"）；⑨ `list(prefix)` 递归、只含前缀内键、带 `size`、按键排序，`list("blobs/")` 不含 `blobsX/…`，`list("")` 列全部；⑩ `delete` 后 `get`/`head`/`list` 都看不到；⑪ 非法键在 `get`/`head`/`put`/`delete`、非法前缀在 `list` 上抛错（取 `store-keys.test.ts` 的反例）且存储不变；⑫ 带 `contentType` 的 `put` 语义不变 |
| `tests/storage/memory.test.ts`、`fs.test.ts` | 每次运行一致性套件。fs 另测：新建 `FsStore` 指向同一目录能读到旧数据；预置的 `.x.tmp` 与 `put` 过程中的临时文件不出现在 `list`；`blobs/a (copy).der`、`blobs/x.der~`、`blobs/old copy/b.der`、`lost+found/c.der` 也不出现，`list` 列出的每个键都能 `delete`；名字不是键段且不可读（`chmod 000`）的 `lost+found` 不让 `list("")`、`removeTemporaryFiles()` 抛错（uid 0 时跳过）；在已存在、非本次创建的 `blobs/crls/t1` 下 `put`：间谍 `rename` 与只读 `open` 的 `sync()` 记录到 rename → fsync `blobs/crls/t1`、`blobs/crls`、`blobs`、根；`removeTemporaryFiles()` 只删键目录里的 `.<名>.<uuid>.tmp`（返回 3），不动 `.x.tmp`、非 uuid 名、点开头目录与 `lost+found` 里的同形文件、同名目录和无点前缀的 `a.der.<uuid>.tmp`（它是键，照常被 `list`），再跑返回 0；不可读的根目录上 `head` 抛错（uid 0 时跳过） |
| `tests/storage/fakes/r2-bucket.ts` + `r2.test.ts` | 假桶 migrate-adapt 自 `worker-aia-cdp@5b570aa:tests/helpers/r2.ts`（保留 `MemoryBucket` 的 `etagMatches` / `etagDoesNotMatch:"*"` → `null`、字节复制、排序前缀列表；加可配页大小与"带引号 ETag 抛 `TypeError`"；删 `testEnv`/`testContext`/`installCache` 与对旧 `Env` 的导入）。两处必改：旧 `put` 先 `await this.head(key)` 再比较写入，5 个并发写会全部成功，改为比较与写入之间没有 `await`（同步算摘要，或先算好再同步比较写入）；类型改用 `src/storage/r2.ts` 的 `R2BucketLike`，不用 `R2PutOptions`、`R2Object` 等 Workers 全局类型（node 程序里没有，TS2304）。每次运行：一致性套件、页大小 2 时 `list` 跨页、`contentType` 进 `httpMetadata`。`AIA_TEST_R2=1`：先设 `process.env.WRANGLER_SEND_METRICS = "false"`、`WRANGLER_HIDE_BANNER = "true"`，再 `await import("wrangler")`，然后 `getPlatformProxy({ configPath: "wrangler.jsonc", persist: false })`（一个 proxy 一个桶），`beforeEach` 清桶（`for (const o of await store.list("")) await store.delete(o.key)`）后跑一致性套件、1001 个键跨页（经 proxy 约 4 s，该例 `{ timeout: 60_000 }`）、带引号 ETag 抛错；`afterAll` 里 `await proxy.dispose()` |
| `tests/http/health.test.ts` | 空 `MemoryStore` → 200 `{status:"degraded",checks:{store:"ok",configuration:"missing"}}` 且 `no-store`；最小配置 → 200 `healthy`；坏 JSON / `version: 2` → 200 `degraded` + `invalid`；`head` 抛 `Error("EACCES /data secret")` → 503 `{status:"unhealthy",checks:{store:"error",configuration:"unknown"}}`，响应不含异常文本，日志有一行 error；`HEAD` → 200 空体 |
| `tests/http/app.test.ts`（重写 `worker-aia-cdp@5b570aa:tests/worker/api-routing.test.ts` 前两条） | `/api`、`/api/`、`/api/v1/missing` → 404 JSON `not_found` + `no-store`，ui 替身未被调用；`/ca/x.crt`、`/crl/missing.crl`、`/dcrl/x.crl` 的 GET 与 POST → 404 `text/plain` `Not Found`，ui 未调用；`/`、`/certificates/<64 位 hex>`、`/crls/<uuid>` 的 GET 与 HEAD → ui 被调用（HEAD 原样转交）、`no-cache`、返回的不是 ui 的原对象；`/assets/index-abc.js` → `immutable`，ui 的 206 / 304 也是；`/assets/`、`/assets/foo`（SPA `index.html`）与 `/assets/page.html` → `no-cache`；ui 在 `/assets/index-abc.js` 上的 500 / 503 / 416 → 状态照传、`no-cache`；`//api/v1/missing`、`/api%2Fv1/missing`、`/api%2fv1/missing`、`//api`、`/%2Fapi/x` → JSON 404，`/crl%2fissuing`、`/crl%2Fx.crl`、`//crl/x.crl`、`/ca%2fx.crt`、`///dcrl//x.crl` → 纯文本 404，ui 都未调用；`/api%2Fv1/health` 不是健康路由（JSON 404），`/crls%2F<uuid>`、`//crls/<uuid>` 仍进 UI；`/assets/missing.js`、`/missing.png`（ui 返回 `text/html`）→ 纯文本 404；`POST /crls/abc`、`PUT /` → 404 而非 405；`POST`/`DELETE /api/v1/health` → 405 信封 + `Allow: GET, HEAD`；首个请求前注册的测试路由抛 `Error("hunter2")` → 500 `internal` 信封，响应不含 `hunter2`，日志含栈；JSON、文本 404、UI 三类响应都有 `X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`，对 `https://` 请求也没有 `Strict-Transport-Security`；每请求恰好一行日志（405 / 500 记最终状态），带 `Authorization: Bearer s3cret` 与 `?token=s3cret` 的请求日志不含 `s3cret`，`trustProxy` 关时无 `client`；开时 `x-forwarded-for` 取最右一项（`6.6.6.6, 203.0.113.7` → `203.0.113.7`、IPv6、多行头取最后一行），只有 `CF-Connecting-IP`、最右项是 `1.2.3.4 spoofed` / `unknown` / 空 / 带端口 / `256.1.1.1` / 带方括号时无 `client`（不回退）；`cf-connecting-ip` 取 `CF-Connecting-IP`（忽略 XFF），非 IP 值或只有 XFF 时无 `client`；`isIpAddress` 正反例；`pretty` 为一行非 JSON，路径里的 ESC / BEL / U+009B / DEL 以 `\u001b` 等转义写出、行内无原始控制字符；`formatLogLine` 的 `pretty`：可打印 ASCII 裸写，空格、`"`、`=`、空串、非 ASCII、换行、NUL、DEL、C1、U+2028 / U+2029 与嵌套对象 JSON 编码并转义；未注入 `ui` 时非保留路径 → 纯文本 404 |
| `tests/http/openapi.test.ts` | 200 + `public, max-age=300`，两次请求字节相同；含 `/api/v1/health` 的 200 / 503；每个 operation 都有 `operationId` 与 `summary`（代替 redocly lint）；运行时文档深等于 `docs/openapi.json` |
| `tests/http/worker-entry.test.ts` | Worker 入口进程内运行（假 R2 桶作 `STORE`、替身 `ASSETS`、截获 `console.log`；`worker.ts` 只属 Worker 程序，经变量说明符动态导入）：`AIA_TRUST_PROXY: true`（JSON 布尔）+ `AIA_MAX_UPLOAD_BYTES: 1048576`（数字）→ health 200，`client` 取 `CF-Connecting-IP`；布尔 `false` 与字符串形式等价；只有 XFF 时无 `client`；`AIA_LOG_FORMAT: ["json"]`、`AIA_MAX_UPLOAD_BYTES: {…}`、`AIA_TRUST_PROXY: null`、对象形式的 `AIA_ADMIN_TOKEN` → 500 `internal` 信封 + 一行 `invalid_settings` 点名变量、不含值；数字 `1.5` 经 `parseSettings` 报 `AIA_MAX_UPLOAD_BYTES` |
| `tests/http/client.test.ts` | `hc<AppType>("http://test.local", { fetch: app.request })`：200 时 `body.status` 收窄为 `healthy \| degraded`，503 时为 `unhealthy`；`// @ts-expect-error` 证明不是 `any`（由 `tsconfig.node.json` 检查） |
| `tests/integration/node-runtime.test.ts` | 以 `process.execPath src/runtime/node.ts` 起真实进程（临时数据目录与含 `index.html`、`assets/index-abc.js` 的临时静态目录，`PORT=0`）：启动前在数据目录放一个 `.config.json.<uuid>.tmp`，日志先是 `temp_files_removed`（`count: 1`）再 `listening`、文件已删；真实 socket 上 health 从 `degraded` 到 `healthy`（写入最小配置）；`AIA_TRUST_PROXY=true` 时 `X-Forwarded-For: 6.6.6.6, 203.0.113.7` 加 `CF-Connecting-IP` → `client` 为 `203.0.113.7`；`HEAD /api/v1/health` 无体；`HEAD /crls/<uuid>` 有 `Content-Length`；`/crl/x.crl` 文本 404；`/assets/missing.js` 404；stdout 每行都是 JSON；SIGTERM → exit 0 且有 `shutdown`、`closed`；开着一个什么都不发的连接、一个请求头发了一半的连接和一个空闲 keep-alive 连接时 SIGTERM → 5 s 内 exit 0、三个连接都被关闭、无 `forced_exit`；`AIA_STATIC_DIR` 为不存在的相对路径 → 一行 warn `static_dir_missing`（`staticDir` 为解析后的绝对路径）、照常监听、health 200、`/` 纯文本 404、SIGTERM exit 0；`PORT=abc` → exit 1 且 stderr 指出 `PORT`；数据目录不存在 → exit 1；`AIA_ADMIN_TOKEN` 与 `_FILE` 同时设置 → exit 1；`_FILE` 内容（去结尾换行）被读入；端口被占用 → exit 1 + JSON 错误日志 |
| `tests/integration/fixtures.test.ts` | `--check` exit 0；再跑一次输出 up to date 且 `.stamp` 不变；manifest 里每个证书 / CRL 的 sha256 等于文件摘要；`manifest.now` 为 `2026-01-04T00:00:00Z`；声明值（如 `crls/issuing-ca-1/full-02.der` 的 `crlNumber: "3"`）；树中没有文件含 `PRIVATE KEY`；`certs/leaf-min.der` 无 SKI / AKI（`openssl x509 -inform DER -noout -text` 的输出不含 `Key Identifier`，步骤 9） |
| `tests/web/health-badge.test.ts` | 替身 `fetch`：请求 URL 以 `/api/v1/health` 结尾且 `init.cache === "no-store"`；200 `degraded` 显示 zh-CN 文案；503 显示 unhealthy；`QueryClient` `retry: false`；用库默认值的 `QueryClient`（不设 `retry`）时一次网络错误后 `fetch` 只调用 1 次、立即显示 unknown（`HealthBadge` 自带 `retry: false`） |
| `tests/web/router.test.ts` | memory history：`/crls/<uuid>` → CrlPage 并拿到参数；`/certificates/<id>` → CertificatePage；`/nope` → NotFound；`siteName` 为 `Test PKI` |
| `tests/boundary/{worker,node}-canary.ts` | 编译期，由 `typecheck:worker` / `typecheck:node` 执行（见步骤 2） |
| `scripts/smoke.sh`（Node、`wrangler dev`、createTestHarness、Docker 共用） | health 200 + `no-store` + `nosniff` + 无 HSTS；HEAD health 200 无体；POST health 405 + `Allow: GET, HEAD` + 信封；`/api/v1/missing`、`/api` 404 JSON；`/ca/x.crt`、`/crl/missing.crl`、`/dcrl/x.crl` 404 `text/plain`；`/` 200 HTML `no-cache`；`/certificates/<64 位 hex>`、`/crls/<uuid>` 的 GET 与 HEAD 200 HTML；哈希 JS 200 `immutable`；`/assets/missing-0000.js` 404；`POST /crls/x` 404；openapi 200 `max-age=300`；`--path-as-is` 的 `//api/v1/missing`、`/api%2Fv1/missing`、`/crl%2fissuing` 非 2xx、非 5xx、不是 HTML；`--path-as-is` 的 `/../package.json`、`/%2e%2e/package.json`、`/assets/..%2f..%2fpackage.json`，以及够深、在主机（`dist/web`）与镜像（`/app/dist/web`）上都能够到真实文件的 `/..%2f..%2fpackage.json`、`/%2e%2e%2f%2e%2e%2fpackage.json`、`/assets/..%2f..%2f..%2fpackage.json`、`/../../../../../../../../../../etc/passwd`、十级 `..%2f` 的 `/etc%2fpasswd`（根下与 `/assets/` 下）都非 5xx、正文不含 `"packageManager"` 与 `root:x:0:0`（Worker 对编码穿越回 307 也算通过；对一个解码 `%2f` 的故意有漏洞的处理器，新加的六条都失败） |

## 出口条件

前提：`export PATH=$HOME/.local/opt/node-24/bin:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0 T=$HOME/.cache/aia-cdp/exit && mkdir -p "$T"`
（与仓库同一文件系统；`/tmp` 是 tmpfs，在那里全新克隆会让 pnpm 把 store 建到 `/tmp/.pnpm-store`），在 `slice/1-skeleton` 上且已提交；
以下命令都在仓库根执行，可重复执行。

1. 全新克隆中通过：`rm -rf "$T/aia-cdp-clean" && git clone . "$T/aia-cdp-clean" && (cd "$T/aia-cdp-clean" && pnpm install --frozen-lockfile && pnpm run verify)`
   （子 shell，不改变当前目录；安装无 "Ignored build scripts" 提示；`worker-configuration.d.ts` 与夹具由脚本现场生成）。
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
| 无远端时 r2 一致性测试从不运行 | `ci:worker` 含 `test:r2`，出口 3 要求 passed |
| node 作为 PID 1 不处理 SIGTERM；没发完请求的连接（preconnect、半截请求头）让 `server.close()` 等满 10 s 后 exit 1；bind mount 的 uid 不是 1000 | 信号处理器；`closeIdleConnections()` + 2 s 后 `closeAllConnections()`，10 s 强制退出只兜底；`node-runtime.test.ts` 的空连接用例与 `ci:docker` 检查停止时间；README 写明 `/data` 属 uid 1000 |
| Debian 自带 node 下 `.vue` lint 报 `Invalid Version: main` | `engine-strict` + `publicHoistPattern`；出口 8 |
| devcontainer 在本机无法全自动验证；镜像大版本漂移 | 出口 13 的自动检查 + 合并说明里的人工记录；镜像标签固定大版本 `5-` |
| 生成器只在未跟踪的工作树文件里，提交前被误删 | 步骤 9 先原样提交；备份 tarball；附录 D 是重写契约 |

## 开工前需 owner 确认

1. **边界漏洞的补丁**（推翻 plan §3 "不另设 ESLint 导入边界规则和 bundle 卫生断言"）。三处编译加 canary 抓不到三类问题：core 导入 Node-only 包
   （如 `@hono/node-server`）、类型导入一个带 `/// <reference types="node" />` 的包（如 `vite`）后 `process` 在整个 Worker 程序里合法（实测 worker canary
   会报 TS2578，但看不出来源）、core → http / hono
   的分层；`wrangler deploy --dry-run` 也照样 exit 0。**已确认（2026-10-19，D9）：加。** ESLint `no-restricted-imports` 分层规则（步骤 7）；
   quality spike 的 `scripts/check-worker-program.ts` 作 `typecheck:boundary` 并入 `typecheck`（步骤 2、12；只靠名单式 ESLint 规则时，`src/http` 里
   `import type … from "vite"` 仍会把整个 `@types/node` 带进 Worker 程序）；`ci:worker` 在 dry-run 后断言 `dist/worker/worker.js` 不含 `"node:` 导入（步骤 12）；
   出口 9 用探针证明三者生效。
2. **devcontainer**：旧 `.devcontainer/devcontainer.json` 用 Node 22 镜像、未固定版本的 act 安装脚本。**已确认（2026-10-19，D10）：本切片建**，
   Node 24 镜像、PowerShell feature、非 root、无 act（步骤 15，出口 13）。
