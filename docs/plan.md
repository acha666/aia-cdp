# aia-cdp：新项目规划（2026-10-17）

状态：设计文档，2026-10-17 定稿，之后按 owner 决策与评审修订（经过见 git 历史）。切片 1–4 已完成（见 `main` 的合并提交），下一个是切片 5a。
分步实施计划（每个切片的步骤、测试、可执行的出口条件、待 owner 确认项）在 `docs/implementation/`；本文与之冲突时以后者为准，规则由各切片的
"文档同步"步骤写回本文。

来源：`worker-aia-cdp` 仓库中的三份分析——`docs/refactoring-plan.md`（2026-10-15 修订）、`docs/analysis-2026-10-13.md`、
`docs/plan-review-2026-10-17.md`，以及本仓库 `docs/review-2026-10-18.md`。本文只写新项目需要的东西，不复述对旧实现的逐项评审；
凡沿用的业务规则在 §6 一次列全，旧实现要补齐的缺陷在 §10 列全。

## 0. 决策记录

| #   | 事项       | owner 决定（2026-10-17；之后的修订注明日期）                                           |
| --- | ---------- | -------------------------------------------------------------------------------------- |
| 1   | HTTP 与契约 | Hono + `@hono/zod-openapi`；前端用 `hc` 类型客户端；ts-rest 与手写路由器退出         |
| 2   | 存储模型   | `config.json` + `catalog.json` + 内容寻址的不可变 blob；不用对象自定义元数据          |
| 3   | 管理通道   | 带独立管理令牌的 HTTP 管理接口；CLI 只是薄 HTTP 客户端                                |
| 4   | 首发后端   | memory、fs、R2；S3 兼容作为后续切片                                                   |
| 5   | 前端       | 2026-10-18 确认：Vue 3 + vue-router 5 + TanStack Query + shadcn-vue（Reka UI）+ Tailwind 4 重建；旧 UI 只迁移纯逻辑、扩展渲染块与测试；Pinia 退出。见 review §3、本文 §8 |
| 6   | 测试       | vitest                                                                                 |
| 7   | API        | 新 `/api/v1` 重新设计；下载 URL（`/ca/*`、`/crl/*`、`/dcrl/*`）不变；不再提供 v2      |
| 8   | 交付       | 2026-10-18：批次 1 = 实施计划（`docs/implementation/`）+ 本文修订 + 切片 1（已完成），之后每批一个切片 |
| 9   | Node       | 2026-10-18：Node 24 LTS（EOL 2028-04-30）全面取代 Node 22：`.nvmrc` = `24`、`engines.node` = `^24.11.0` + `engine-strict=true`、`@types/node` 24.x、Docker `ARG NODE_VERSION=24` 与 `node:24-slim` |
| 10  | 版本库     | 2026-10-18：`main` 放文档与已合入的切片，每个切片在 `slice/<n>-<name>` 分支开发、评审后本地 `--no-ff` 合并；每个 CI 任务都是本地可跑的 `pnpm run ci:<job>`。2026-10-19 建远端 `github.com/acha666/aia-cdp`，合并后推送，GitHub Actions 跑同一组脚本 |
| 11  | 切片 1 范围 | 2026-10-18：ObjectStore 端口、memory / fs / r2 适配器与一致性套件在切片 1（原在切片 2），`/api/v1/health` 在切片 1 就做真实的 store / configuration 检查（§10 #15） |
| 12  | shadcn-vue 风格 | 2026-10-18：`--style nova`、base color `neutral`、图标库 lucide（`@lucide/vue`） |
| 13  | 线上工件   | 2026-10-18：`tests/data/adcs.ts`（pki.acha.top 证书与 CRL 的 base64）不进新仓库；测试只用夹具脚本生成的合成 AD CS 风格夹具（fixtures spike 证明 CA Version / 模板名编码逐字节一致、扩展嵌套相同），旧仓库用到它的测试改用合成夹具迁入 |
| 14  | 迁移源     | 2026-10-18：`~/aia-cdp/worker-aia-cdp` 本地分支 `parsing-2026-10-18` 的提交 `5b570aa`；每个迁移步骤引用 `worker-aia-cdp@5b570aa:<path>` |
| 15  | 切片 1 两项 | 2026-10-19：加边界护栏，推翻原定"不另设 ESLint 导入边界规则和 bundle 卫生断言"（ESLint `no-restricted-imports` 分层规则、`typecheck:boundary` 检查 Worker 程序不含 Node 声明、`ci:worker` 断言 Worker 包无 `"node:` 导入）；切片 1 建 devcontainer（Node 24 镜像、PowerShell feature、非 root、无 `act`） |
| 16  | 切片 2 两项 | 2026-10-19：不记证书路径改绑账本——V7 只与当前 config 比对，"先删再加"不拦截、由操作员负责，`applyConfig` 只写 `config.json`（§5.2）；`PUT /api/v1/admin/config` 缺可用前置条件回 428 `precondition_required`，不用 400（§7.2、§7.3） |

决策 5、8–16 即 implementation 总则 §0 的 D1–D12（5 = D1，9 = D2，10 = D3，14 = D4，11 = D5，12 = D6，13 = D7，8 = D8，15 = D9 + D10，16 = D11 + D12）。

决策 3 的连带效果：所有写入都经过服务进程。fs 后端只需要进程内互斥，不需要跨进程文件锁
（`proper-lockfile` 不再需要）；Cloudflare 部署不需要 R2 的 S3 API 令牌，S3 适配器从
"Cloudflare 管理必需"降为"多实例 Node 可选"；旧方案里"演练 R2 S3 API 管理路径"的风险项消失。

## 1. 目标与非目标

目标：

- 一份代码，两种运行时：Cloudflare Workers + R2；Node 24 + 本地磁盘（Docker）。
  共用一个 `createApp(deps)`，两个入口文件各十几行。
- 公开分发 CA 证书与 CRL（AIA/CDP）。公开 URL 由操作员配置，DER 是唯一权威，PEM 读取时派生。
- AD CS 上传 CRL 后自动验签、比较新鲜度并发布，返回 created / updated / unchanged 三种结果。
- 导入证书、替换配置、退役目标、查看历史都走带令牌的 HTTP 管理接口，CLI 包装这些接口。
- Web UI 浏览证书与 CRL 目标（总览 + 详情页）、上传 CRL。
- 补齐 §10 列出的旧实现缺陷。

非目标（明确不做）：

- 证书签发、私钥管理、证书链验证。
- 数据库、队列、后台任务、边缘缓存、插件系统、分页与游标（资源数以十计）。
- 对象自定义元数据；多个服务进程共享一个 fs 数据目录（多实例走 S3，后续切片）。
- CORS；公开 API 暴露 CRL 历史；full 与 delta CRL 的合并或相互校验。
- 运行时注入 `SITE_NAME`；HTTP 管理 UI（首发只有 CLI）。

## 2. 技术选型

版本为规划时 `npm view` 查到的最新版，并经工具链 spike 修正。依赖一律精确版本（`.npmrc` `save-exact=true`），以提交的
`package.json` 与 `pnpm-lock.yaml` 为准，Docker、CI、全新克隆都用 `pnpm install --frozen-lockfile`；后续切片新增的包见 implementation 总则 §2.3。

| 领域          | 选型                                            | 版本                              | 说明                                                                                           |
| ------------- | ----------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------- |
| 运行时        | Node 24 LTS（固定）、Cloudflare Workers          | —                                 | `.nvmrc` = `24`、`engines.node` = `^24.11.0` + `.npmrc` `engine-strict=true`（不符即安装失败）、`node:24-slim`（决策 9） |
| 包管理        | pnpm 10（corepack）                              | 10.34.7                           | `packageManager: pnpm@10.34.7`；npm `latest` 已是 pnpm 12，pnpm 一律经 corepack 按 `packageManager` 解析；`pnpm-workspace.yaml` 设 `ignoredBuiltDependencies` 与 `publicHoistPattern` |
| HTTP          | `hono`                                          | 4.13.13                           | 路由、自动 HEAD、`methodNotAllowed`（`hono/method-not-allowed`，hono ≥ 4.13.0）、`bodyLimit`、`bearerAuth`、`secureHeaders`；下载的 ETag / 304 手写，不用 `hono/etag`（§6） |
| Node 服务器   | `@hono/node-server`                             | 2.1.5                             | `serve()` + `serve-static`；替代手写 `node:http` 桥                                            |
| 校验与 OpenAPI | `@hono/zod-openapi` + `zod`                    | 1.6.3 / 4.6.7                     | 路由声明即 schema，处理器返回值按状态码类型检查；OpenAPI 文档运行时从路由表生成，另写出提交的 `docs/openapi.json` 作漂移基线（§7.3） |
| 类型化客户端  | `hono/client` 的 `hc<AppType>`                  | 随 hono                           | 前端类型从服务端路由推导；`init: { cache: "no-store" }`                                        |
| PKI           | `pkijs` + `asn1js`                              | 3.4.1 / 3.1.0                     | 现有解析、扩展、验签、构建器迁入（切片 2 起）                                                  |
| 前端          | `vue`、`vue-router`、`@tanstack/vue-query`、`vue-i18n` | 3.5.44 / 5.4.0 / 5.104.4 / 11.4.16 | vue-router 与 vue-query 新增，Pinia 退出（决策 5）                                     |
| 前端构建      | `vite` + `@vitejs/plugin-vue`、`tailwindcss` + `@tailwindcss/vite`、`tw-animate-css`、`vue-tsc` | 8.3.4 / 6.0.10、4.3.3 / 4.3.3、1.4.0、3.3.13 | vite 8 相对旧项目是大版本（Rolldown、默认 oxc 压缩）；`vue-tsc` 检查 `tsconfig.web.json` |
| UI 组件       | shadcn-vue（CLI，`--style nova`）+ `reka-ui` + `class-variance-authority` + `cn` + `@lucide/vue` + `vue-sonner` | 2.8.2 / 2.11.0 / 0.7.1 / 0.5.0 / 1.59.0 / 2.0.9 | 组件源码生成到 `src/web/components/ui/`；生成代码用 `cn` 包，取代 `clsx` + `tailwind-merge`；`@lucide/vue` 取代已弃用的 `lucide-vue-next`；`vue-sonner` 需 `import "vue-sonner/style.css"`（切片 5b）；`@tanstack/vue-table` 不随 shadcn Table 安装，切片 5b 也没用上（吊销列表分页只是 `slice()`）；备选 Naive UI 2.45（review §3.2） |
| 前端工具      | `@vueuse/core`                                   | 14.4.0                            | 与 reka-ui 2.11.0 依赖的 `^14.1.0` 同一份（装 15 会出现两份）；`useColorMode`、`useNow`（统一时钟快照）、`useStorage`；复制不用 `useClipboard`（其 `execCommand` 退路失败也报成功，见切片 5b 步骤 4） |
| 测试          | `vitest`、`@vue/test-utils`、`happy-dom`、`playwright-core` | 5.0.5 / 2.5.1 / 21.0.3 / 1.64.1 | HTTP 用 `app.request()` 进程内测；R2 用 wrangler `getPlatformProxy`；夹具由脚本生成后入库，vitest `globalSetup` 校验（§11）；`playwright-core` 只给浏览器冒烟（切片 5b，不进 CI，浏览器另装） |
| Cloudflare    | `wrangler`                                      | 4.151.1（精确锁定）               | `wrangler types` 生成绑定类型 `worker-configuration.d.ts`（不入库）；不装 `@cloudflare/workers-types`；`compatibility_date` 随 wrangler 一起升 |
| CLI           | `node:util` `parseArgs` + `fetch`               | 内置                              | 零依赖                                                                                         |
| 后续          | `@aws-sdk/client-s3`                            | 3.1152.0                          | S3 适配器切片，仅进 Node bundle                                                                |
| 质量          | `typescript`；`eslint` + `@eslint/js` + `typescript-eslint` + `eslint-plugin-vue` + `vue-eslint-parser` + `jiti`；`prettier` | 5.9.3；10.13.0 / 10.0.1 / 8.71.2 / 10.11.1 / 10.4.1 / 2.7.0；3.9.10 | `typescript` 精确锁 5.9.3（npm latest 7.0.2 超出 typescript-eslint 的 `<6.1.0`）；`jiti` 供 ESLint 10 加载 `eslint.config.ts`；`@types/node` 24.19.2 |
| 开发前置      | OpenSSL CLI、bash、Docker Engine                 | OpenSSL ≥ 3.0（不是 LibreSSL）、Docker ≥ 25 | 只在开发与 CI 用：OpenSSL 生成测试夹具（§11），Docker 构建镜像（`HEALTHCHECK --start-interval` 需要 25）；运行时都不需要 |

`dependencies` 只放 Node 运行时要的包（`hono`、`@hono/zod-openapi`、`zod`、`@hono/node-server`，切片 2 起加 `pkijs`、`asn1js`）；
浏览器包、构建、测试、lint 工具都是 devDependencies（Docker 运行阶段只装生产依赖），shadcn-vue CLI 写进 `dependencies` 的包要挪走。

明确不用：`unstorage`（无条件写）、`@cloudflare/vitest-pool-workers`（R2 适配器几十行，
`getPlatformProxy` 一个测试够）、`ts-rest`（停更，锁 zod 3）、`aws4fetch`、`proper-lockfile`、
`srvx`、Express/Fastify（非 Workers 原生）、`hono/etag`（在处理器之后比较，做不到 304 不读 blob）、
`lucide-vue-next`（已弃用）、`clsx` + `tailwind-merge`（shadcn-vue 改用 `cn`）、`pinia`。

## 3. 仓库布局

```text
aia-cdp/
  package.json  pnpm-lock.yaml  pnpm-workspace.yaml  .nvmrc  .npmrc
  .gitignore  .gitattributes  .prettierrc.json  .prettierignore  .dockerignore
  tsconfig.json  tsconfig.base.json  tsconfig.worker.json  tsconfig.node.json
  tsconfig.build.json  tsconfig.web.json
  wrangler.jsonc  worker-configuration.d.ts（`pnpm run types` 生成，不入库）
  Dockerfile  vite.config.ts  vitest.config.ts  eslint.config.ts  components.json（shadcn-vue）
  .github/             workflows/ci.yml  dependabot.yml
  .devcontainer/       devcontainer.json（决策 15）
  src/
    core/              纯 TS：不引用 node:*、process、R2Bucket
      pki/             解析、扩展、验签、PEM 编解码（迁入）
      summary/         证书 / CRL 摘要与 API 投影构建器（迁入 builders）
      store.ts         ObjectStore 端口
      catalog.ts       catalog.json / config.json 的 schema、读取、条件写与重试
      resources.ts     路径表解析、下载策略
      import.ts        importCertificate(deps, bytes)
      publish.ts       publishCrl(deps, bytes)（入口取一次 deps.now()）
      admin.ts         validateConfig / applyConfig / retireTarget / deleteCertificate / listHistory
    http/
      app.ts           createApp(deps) → OpenAPIHono；中间件与挂载顺序
      routes/          health.ts  certificates.ts  crls.ts  stats.ts  admin.ts  downloads.ts
      schemas.ts       API v1 的请求 / 响应 / 错误 schema
      errors.ts        ApiError、onError、defaultHook、onMethodNotAllowed → 错误信封
      ui.ts            保留前缀与 UI 兜底、UI 缓存头（§4.4）
    storage/           memory.ts  fs.ts  r2.ts（s3.ts 后续）
    runtime/
      worker.ts        export default { fetch }
      node.ts          serve + SIGTERM / SIGINT
      node-ui.ts       serveStatic + index.html 兜底（Node 的 deps.ui）
      settings.ts      环境变量 schema（zod，两条运行时共用）
    cli/aia.ts         薄 HTTP 客户端
    web/               Vue UI（Vite root；按 §8 重建）
      client/          hc<AppType> 客户端（不得叫 api：dev server 会把 src/web 下的目录当 URL 服务）
      components/ui/   shadcn-vue 生成的组件（入库）
      lib/utils.ts     shadcn-vue 生成（cn）
  tests/
    core/  http/  storage/  web/  integration/
    boundary/          worker-canary.ts  node-canary.ts（只编译，见下）
    helpers/           testDeps()、store 包装、seed
    fixtures/          generate-test-data.sh（重写）  global-setup.ts  pki.ts；产物 pki/ 入库
  scripts/             adcs-crl-uploader.ps1  generate-openapi.ts  migrate-from-v2.ts  check-worker-program.ts
                       smoke.sh  node-smoke.sh  worker-smoke.ts  docker-smoke.sh
  docs/                plan.md（本文）  implementation/（总则 + 每切片一份）  api.md  operations.md  openapi.json
  dist/                web/（vite build） server/（tsc -p tsconfig.build.json） worker/（dry-run）；不入库
```

不入库：`worker-configuration.d.ts`、`dist/`、`.wrangler/`、`.data/`、`.dev.vars*`、`node_modules/`。
`.gitattributes` 设 `*.sh text eol=lf` 与 `tests/fixtures/pki/** -text`（夹具逐字节比较）；`.dockerignore` 用白名单，`tests/fixtures`、`.dev.vars`、`.git` 进不了构建上下文。

模块约定（全仓 ESM、服务端相对导入写 `.ts`、只用可擦除语法、`src/web` 对服务端模块只许 `import type`、core 与 http 只用 Web 标准全局）
见 implementation 总则 §2.1。tsconfig 拓扑（worker / node / web 三个程序加只发射的 `tsconfig.build.json`）与边界检查见总则 §2.2：三套程序都编译
`src/core` 与 `src/http`，两个 `@ts-expect-error` canary 断言 Worker 程序里没有 `process`、Node 程序里没有 `R2Bucket`；canary 抓不到的三类漏洞
（core 导入类型不引用 `@types/node` 的 Node-only 包、类型导入带 `/// <reference types="node" />` 的包、core → http / hono 分层）由决策 15 的护栏补上：
`eslint.config.ts` 对 `src/core/**`、`src/http/**` 的 `no-restricted-imports` 分层规则，`scripts/check-worker-program.ts`（`typecheck:boundary`），以及
`ci:worker` 断言 `dist/worker/worker.js` 不含 `"node:` 导入。R2 适配器按结构化类型 `R2BucketLike` 写，r2 一致性测试因此在 `tsconfig.node.json` 下编译。

## 4. 运行时与配置

### 4.1 Cloudflare Workers

- `wrangler.jsonc`：`name: "aia-cdp"`（绝不用旧 Worker 名 `aia-cdp-worker`，否则部署会覆盖线上 Worker）；
  `main: src/runtime/worker.ts`；`compatibility_date: "2026-10-12"`（= wrangler 4.151.1 自带的 workerd，随 wrangler 一起升）；
  不设兼容标志（`nodejs_compat` 自 2026-08-04 起默认开启，真正的护栏是 tsconfig 的 `types`，§3）；
  `observability.logs.enabled: true`（§4.3）；`minify: true`；`upload_source_maps: true`；
  `r2_buckets: [{ binding: "STORE" }]`，不写 `bucket_name`（自动置备；是否共用旧桶是切片 7 的 owner 项）；
  `assets: { directory: "dist/web", binding: "ASSETS", run_worker_first: true,
  not_found_handling: "single-page-application" }`（history 路由的兜底）。不写 `routes`、`build.command`、`vars`。
- 绑定类型：`wrangler types --env-file=/dev/null` 生成 `worker-configuration.d.ts`（不读 `.dev.vars`，结果确定），不入库；
  `pnpm run types` 在 check / typecheck / lint 之前重生成，ESLint 与 Prettier 排除它。
- 入口：按 `env` 缓存一个 app（`WeakMap<Env, App>`），`createApp({ store: new R2Store(env.STORE), now, settings,
  log: (line) => console.log(line), ui: (req) => env.ASSETS.fetch(req) })`，`app.fetch(req, env, ctx)`；设置无效时每个请求返回 500 信封并记一行 error 日志。
  ASSETS 只经 `deps.ui` 调用，保留前缀与 UI 兜底规则在应用内（§4.4）：`/api/*` 与下载前缀的未命中不会被 SPA 兜底答成
  200 HTML（C12）。
- 令牌是可选的 `wrangler secret`（`AIA_ADMIN_TOKEN` / `AIA_UPLOAD_TOKEN`），代码里类型为可选，不用 `secrets.required`；
  其余设置有默认值，需要时用 `vars`（写成 JSON 布尔 / 数字也可以，入口转成字符串；对象、数组、`null` 是无效设置）。
- 脚本与 CI 调 wrangler 时设 `WRANGLER_SEND_METRICS=false WRANGLER_HIDE_BANNER=true`（`send_metrics: false` 挡不住 deploy 的遥测）；
  `wrangler deploy --dry-run --outdir dist/worker` 需要先有 `dist/web`（先 `vite build`）。不加 `deploy` 脚本（首次部署会自动置备新桶，部署按 `docs/operations.md` 手工执行），生产部署只在切片 7。

### 4.2 Node / Docker

| 变量                                 | 默认                 | 说明                                                 |
| ------------------------------------ | -------------------- | ---------------------------------------------------- |
| `PORT`                               | `8080`               |                                                      |
| `AIA_STORE`                          | `fs`                 | `fs`；后续 `s3`                                      |
| `AIA_DATA_DIR`                       | `/data`              | fs 根目录；一个服务进程对应一个目录                  |
| `AIA_STATIC_DIR`                     | `./dist/web`         | UI 构建产物                                          |
| `AIA_ADMIN_TOKEN` / `_FILE`          | 无                   | 未设置时管理接口返回 503 `admin_disabled`            |
| `AIA_UPLOAD_TOKEN` / `_FILE`         | 无                   | 未设置时上传不需要令牌                               |
| `AIA_MAX_UPLOAD_BYTES`               | `1048576`            | `bodyLimit`；1 MiB ≈ 25 000 个吊销条目，也是解码内存的上界（§5.5） |
| `AIA_TRUST_PROXY`                    | `false`              | 为真时请求日志加 `client`：Node 取 `X-Forwarded-For` 最右一项（最近一跳代理追加的），Workers 取 `CF-Connecting-IP`；不是 IP 字面量就省略 |
| `AIA_LOG_FORMAT`                     | `json`               | `json` / `pretty`                                    |

启动（`src/runtime/node.ts`，设置 schema 在 `src/runtime/settings.ts`，纯 zod、Worker 与 Node 共用）：

- 用 zod 校验全部变量，字段与默认值按上表；`*_FILE` 在启动时读取（去掉一个结尾换行），`X` 与 `X_FILE` 同时设置报错；
  两个令牌须是 RFC 6750 `b64token`（字母、数字、`-._~+/`，末尾可接 `=`；`bearerAuth` 只从请求头读这种格式，其他字符的令牌
  永远 400）；无效即在 stderr 打印原因、exit 1。`AIA_DATA_DIR` 须是可读写目录，否则 JSON 错误日志 + exit 1。
- `serve({ fetch: app.fetch, port })`：`PORT` 显式传入（`@hono/node-server` 的默认是 3000），不传 hostname（`::` 双栈）；
  就绪日志一行 `listening`。`server.on("error")`（如端口被占用）→ JSON 日志 + exit 1；SIGTERM / SIGINT → `server.close()` 并立即关闭空闲连接，
  2 s 宽限后关闭其余全部连接（含没发完请求的 preconnect、半截请求头，`close()` 会一直等它们），另设 10 s `unref()` 的强制退出兜底（容器里 node 是 PID 1）。
- `AIA_STATIC_DIR/index.html` 不存在 → 一行 warn `static_dir_missing`（解析后的绝对路径）后照常启动（`dev:node` 的 UI 由 Vite dev server 提供）。
- 开始服务前删除 fs 存储里被打断的写入留下的临时文件（一个目录一个进程，此时没有写入在进行），日志 `temp_files_removed` 带个数。
- 生产 `node --enable-source-maps dist/server/runtime/node.js`；开发与测试直接 `node src/runtime/node.ts`（type stripping）。

Dockerfile（`ARG NODE_VERSION=24`，基础镜像浮动标签 `node:24-slim`，bookworm；digest 固定以后再定）：

- 阶段 base：`corepack enable pnpm`，复制 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`.npmrc` 后 `corepack install`；
  prod-deps：`pnpm install --prod --frozen-lockfile --ignore-scripts`（store 缓存挂载）；build：全量安装 + `vite build` +
  `tsc -p tsconfig.build.json`。`engine-strict` 让 `NODE_VERSION=22` 的构建在安装阶段失败。
- 阶段 runtime（`node:24-slim`）：`NODE_ENV=production`；只复制生产依赖、`dist/` 与 `package.json`（`"type": "module"` 需要它）；
  先建 `/data` 并 chown 给 `node`，再 `USER node`（uid 1000）与 `VOLUME /data`；`EXPOSE 8080`；
  exec 形式 `CMD ["node", "--enable-source-maps", "dist/server/runtime/node.js"]`；
  `HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=3`，用 `node -e` 的
  `fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/v1/health', { signal: AbortSignal.timeout(4000) })`，200 即健康（含 `degraded`）。
- `SITE_NAME` 只在 `vite build` 时通过 `VITE_SITE_NAME` 注入（Docker `ARG VITE_SITE_NAME`，无默认）；`%VITE_SITE_NAME%` 不做 HTML
  转义，`vite.config.ts` 构建期校验（含 `< > & "` 即失败），空值用默认 `PKI AIA/CDP`。
- `.dockerignore` 用白名单（只放行清单、tsconfig、`vite.config.ts`、`src`）。bind mount 的 `/data` 须属 uid 1000。

静态资源：`src/runtime/node-ui.ts` 的 `createNodeUi(AIA_STATIC_DIR)` 作为 `deps.ui`：`serveStatic({ root })`，最后一段无扩展名的
路径回退 `index.html`（history 路由）；保留前缀、扩展名与缓存规则在应用内（§4.4），与 Workers 相同。反向代理不得对下载前缀做
HTTPS 跳转（AIA/CDP 客户端只走明文 HTTP）。

### 4.3 日志

一个自写的小中间件：每请求一行 JSON（method、path、status、ms、可选 client），
每次发布 / 导入尝试一行（targetId 或 certificateId、outcome 或 reason、sha256；发布另有 kind、crlNumber、thisUpdate、expired、
attempts、ms、detail，字段规则见 implementation 切片 4 步骤 6）。
Node 写 stdout，Workers 用 `console.log`（Workers Logs 自动收集）。不记录令牌、请求体和查询串；
`AIA_LOG_FORMAT=pretty` 只把同一内容排成一行人读文本（只有不含空格、`"`、`=` 的可打印 ASCII 裸写，其余 JSON 编码并转义控制字符）。
`client` 的来源由入口经 `deps.clientIpHeader` 选定（§4.2 的 `AIA_TRUST_PROXY` 行）。

### 4.4 应用依赖、保留前缀与 UI 兜底（两条运行时共用）

`createApp(deps)` 返回 `OpenAPIHono`；`deps = { store, now, settings, clientIpHeader, log, sleep?, ui? }`（`sleep` 只给 catalog 条件写重试的退避，测试注入），`ui(req)` 是与平台无关的 UI 兜底
（Workers：`env.ASSETS.fetch`；Node：`serveStatic` + `index.html`）。应用不认识运行时 env；规则都在应用内，两条运行时一致：

| 请求 | 响应 |
| --- | --- |
| `/api`、`/api/*` 未命中 | JSON 信封 404 `not_found`，`no-store` |
| `/ca`、`/crl`、`/dcrl` 本身及其下未命中 | `text/plain` 404 `Not Found`，`no-store`（CryptoAPI 客户端；与线上一致） |
| 已注册路径、方法不符 | 405 + `Allow`：API 为信封（§7.3）；下载前缀为纯文本，`Allow: GET, HEAD`（切片 3） |
| 其他路径 GET / HEAD | `ui(req)`；ui 返回 404，或最后一段带扩展名（非 `.html`）而 ui 返回 HTML（SPA 兜底）→ 纯文本 404（缺失的 `/assets/x.js` 不变成 200 HTML） |
| 其他路径的其他方法；未注入 `ui` | 纯文本 404 |

- 保留前缀后须是 `/` 或路径结尾（`^/api(?:/|$)`、`^/(?:ca|crl|dcrl)(?:/|$)`）：`/crls/`、`/certificates/` 是 UI 路由，不是下载前缀；
  不带斜杠的 `/ca`、`/crl`、`/dcrl` 是下载路由（`/ca/*` 也匹配它，切片 3），GET / HEAD 纯文本 404、其他方法纯文本 405。匹配用规范化路径
  （`%2F` 解码、连续 `/` 合并），`//api/…`、`/api%2Fv1/…`、`/crl%2f…`、`//ca` 同样不进 UI；路由仍看原始路径。
- `secureHeaders`（§6，含 §8 的 CSP）由应用加在全部响应上，UI 响应也一样（先复制 ui 返回的响应），两条运行时的头相同。
- UI 缓存头由应用设置：`/assets/` 下最后一段带扩展名、非 HTML、状态 200 / 206 / 304 的哈希资源 → `public, max-age=31536000, immutable`，
  其余 UI 响应（`index.html`、SPA 兜底、ui 的错误状态）→ `no-cache`。先复制 ui 返回的响应再改头（workerd 绑定响应的头不可变）。
- 不注册 `app.get("*")`（会让未知路径的 POST 全变 405）；全部路由在 `createApp` 内、首个请求前注册完（SmartRouter 首个请求后冻结）。

## 5. 存储模型

### 5.1 对象布局（所有后端相同）

```text
config.json                                          操作员拥有；管理接口整体替换
catalog.json                                         服务拥有；导入与发布条件写
blobs/certificates/<sha256>.der                      不可变
blobs/crls/<targetId>/<YYYYMMDDHHMMSSZ>-<crlNumber|none>-<sha256>.der   不可变；当前与历史共用
history/<targetId>/<与 blob 同名>.json                不可变；历史标记（被取代或退役的 current、切片 7 导入的旧版本）
```

CRL 键的时间段是 `thisUpdate`（定宽，字典序即时间序），号段是十进制 CRL 号、无号时为 `none`；键只由 `crlBlobKey()`
生成（implementation 切片 4 步骤 2）。号进文件名，所以 CRL Number 与 Delta 指示的内容至多 48 octet（116 位十进制）：最长名字 202 字节，
fs 适配器的临时文件 `.<名字>.<uuid>.tmp` 244 字节，都在单个名字 255 字节以内（R2 键上限 1024）；更长的号拒为 `invalid_crl`
（`extension_value`）。这只给"不设 20 octet 上限"的默认值加了上界，RFC 5280 的 20 octet 仍不强制。键全部由服务生成（hex、uuid、十进制、固定名），不存在操作员命名的键，
因此不需要键编码、长度、大小写规则；三个适配器仍防御性地用 `assertStoreKey` 校验每个键（§5.4）。

### 5.2 `config.json`（操作员）

```jsonc
{
  "version": 1,
  "certificates": {
    "<sha256>": { "label": "Root CA" }
  },
  "targets": {
    "<uuid>": { "issuer": "<sha256>", "kind": "full", "label": "Issuing CA 1" },
    "<uuid>": { "issuer": "<sha256>", "kind": "delta", "label": "Issuing CA 1 delta" }
  },
  "paths": {
    "/ca/root-ca.crt": { "certificate": "<sha256>" },
    "/crl/issuing-ca-1.crl": { "target": "<uuid>" },
    "/dcrl/issuing-ca-1.crl": { "target": "<uuid>" }
  }
}
```

规则：

- 每条路径自动提供 PEM 变体 `<path>.pem`；路径表里只写 DER 路径。
- 路径必须以 `/ca/`、`/crl/`、`/dcrl/` 之一开头，且前缀与资源种类一致
  （`/ca/` → 证书，`/crl/` → full 目标，`/dcrl/` → delta 目标）。规范化后唯一。
- 被引用的证书必须已在 catalog 中；目标的签发者证书必须有 SKI；同一签发者同一 kind 只能有
  一个目标。
- 已有证书路径不能改绑到另一证书（证书下载是 `immutable` 缓存一年）：同一 `/ca/` 路径在当前 config 与新 config 中须指向同一
  证书。只与当前 config 比对，"先删再加"的两步改绑不检测，由操作员负责；更换 CA 证书用新路径。
- 已有目标不能改 `issuer` 或 `kind`；换签发者或种类用新 UUID（目标的 current 与全部 history 因此由同一张证书验证，删除保护覆盖历史，
  新鲜度不跨签发者比较；implementation 切片 2 步骤 6 V9）。
- 删除目标前，该目标的 `current` 必须已被 retire 清空；被目标或路径引用的证书不能删除。

### 5.3 `catalog.json`（服务）

```jsonc
{
  "version": 1,
  "certificates": {
    "<sha256>": {
      "key": "blobs/certificates/<sha256>.der",
      "size": 1234,
      "importedAt": "2026-10-17T00:00:00.000Z",
      "summary": { "subjectCN": "…", "issuerCN": "…", "serialNumber": "…", "notBefore": "…",
                   "notAfter": "…", "subjectKeyId": "…", "authorityKeyId": "…", "sha1": "…" }
    }
  },
  "targets": {
    "<uuid>": {
      "current": {
        "sha256": "…", "key": "blobs/crls/<uuid>/<thisUpdate>-<crlNumber>-<sha256>.der", "size": 4567,
        "publishedAt": "…", "verifier": "<sha256>",
        "summary": { "crlNumber": "42", "baseCrlNumber": null, "thisUpdate": "…",
                     "nextUpdate": "…", "revokedCount": 1, "sha1": "…", "nextPublish": null }
      }
    }
  }
}
```

catalog 只存当前指针，大小与资源数成正比，不随发布次数增长。历史 = `history/<uuid>/` 下的标记
（被取代或退役的 current 原样记录，或切片 7 导入的旧版本；键名与 blob 同名，自带 `thisUpdate`、CRL 号与摘要）∪ catalog 的 `current`；
`blobs/crls/<uuid>/` 下没有标记的孤儿 blob（发布竞争失败或崩溃留下）不算历史（C8）。管理接口各 `list` 一次两个前缀即可列出，
不逐个读对象。发布写的标记体是被取代的 `current` 记录原样，不带时间（退役写同样的形状，切片 7 的导入另带 `importedAt`）；发布写了
标记而 catalog 写输掉时，被标记的版本仍是 current，列历史时按版本名把标记与 current 合并成一条。标记不记取代时间：create-only 的
标记可能来自最终 `concurrent_update` 的调用，那时写下的时间之后永远改不掉；某版本被取代的时间就是取代它的那一版的 `publishedAt`。

格式（implementation 切片 2 步骤 4、切片 4 步骤 2）：证书 id、`sha1`、key id 小写 hex（key id 与 CN 缺失为 `null`），target id
小写 UUID；`serialNumber` 大写 hex，保留 INTEGER 内容字节的前导 `00`；时间为 `toISOString()`（含 `.000Z`）；
CRL 号十进制字符串、按 BigInt 比较；`revokedCount` 是非空整数（发布时总能解析，§10 #7）；`nextPublish` 取 AD CS Next CRL
Publish（`1.3.6.1.4.1.311.21.4`），缺失为 `null`。拟新增、开工前需 owner 确认的字段：`targets[id].retired`（退役终态，切片 6 第 1 项）。

### 5.4 端口与适配器

```ts
export interface ObjectStore {
  get(key: string): Promise<{ bytes: Uint8Array; etag: string } | null>;
  head(key: string): Promise<{ etag: string; size: number } | null>;
  put(key: string, bytes: Uint8Array, opts?: {
    contentType?: string;
    ifMatch?: string;      // 替换：当前 ETag 必须相等
    ifNoneMatch?: "*";     // 创建：键必须不存在
  }): Promise<{ ok: true; etag: string } | { ok: false; reason: "precondition-failed" }>;
  list(prefix: string): Promise<{ key: string; size: number }[]>;   // 仅管理接口
  delete(key: string): Promise<void>;                                // 仅管理接口
}
```

ETag 对调用方不透明，只回传给同一后端；HTTP 层的 `ETag` 永远来自内容摘要，store ETag 从不外露，HTTP `If-Match` 的值也从不
传进适配器。端口、三个适配器与一致性套件在切片 1 交付（决策 11）。三个适配器的 `get` / `head` / `put` / `delete` 先调同一个
`assertStoreKey`：`/` 分段，每段 `[A-Za-z0-9_-][A-Za-z0-9._-]*`，拒绝空键、空段、`.`、`..`、点开头、绝对路径、`\`、NUL（同时是 fs 的
路径穿越防护）；`list` 先调 `assertStorePrefix`：`""` 或一个以上合法段加结尾 `/`（如 `blobs/`、`history/<uuid>/`），其余拒绝。

| 适配器 | 条件写                                                                 | ETag            | 规模    |
| ------ | ---------------------------------------------------------------------- | --------------- | ------- |
| memory | 先算摘要，再同步完成比较与写入（中间有 `await` 时并发 CAS 会双赢）；读写都复制字节 | 内容 SHA-256    | ~40 行  |
| fs     | 按键的进程内互斥段里读当前文件摘要、判条件，再同目录临时文件 + fsync + `rename` + 从父目录到根逐级 fsync；`list` 递归、只认键段名（跳过临时文件与杂物，不进 `lost+found` 一类目录）；Node 启动时清理残留临时文件 | 内容 SHA-256    | ~80 行  |
| r2     | `onlyIf: { etagMatches }` / `{ etagDoesNotMatch: "*" }`，返回 `null` 即前置条件失败；其他异常（含单键写速率）原样抛出；`list` 跟随游标；桶按结构化类型 `R2BucketLike` 写 | `R2Object.etag`（不带引号；带引号的 `httpEtag` 传回 `etagMatches` 会抛错） | ~60 行  |

一致性套件 12 条用例（缺失键、put/get/head、字节隔离、`ifNoneMatch`、`ifMatch` 成功 / 过期 / 缺失键、同一 `ifMatch` 并发 5 次
恰好一次成功、递归前缀列表、delete、非法键、`contentType`），memory 与 fs 每次运行；r2 在 `AIA_TEST_R2=1`（`pnpm run test:r2`，
`ci:worker` 包含它且要求 passed）下经 `getPlatformProxy({ configPath: "wrangler.jsonc", persist: false })` 运行，结束时
`await dispose()`；另有假桶让 r2 适配器的套件每次都跑。

### 5.5 写入顺序

`publishCrl(deps, bytes)`，入口取一次 `deps.now()` 作本次的时间快照（与 `importCertificate` 同形），与 HTTP 无关：

1. 按字节识别 PEM/DER，得到 DER 与 `sha256`。
2. 解析 AKI、CRL 号、delta 指示、扩展、时间；时间解码失败、`thisUpdate` 超前 5 分钟以上、
   未识别的关键扩展、作用域 IDP 各是独立拒绝原因。
3. 读 `config.json` 与 `catalog.json`（各一次 `get`，记下 catalog 的 ETag）。
4. 用 AKI 在 catalog 的证书摘要里找 SKI 相等的证书，再在 config 里找绑定它且 kind 匹配的目标。
   无 AKI `keyIdentifier` 或找不到证书是 `issuer_not_found`，证书存在但无目标是 `target_not_configured`；两个匹配目标只会来自绕过
   规则 V6 手写的 config，按服务端故障 500。
5. 读签发者 DER（按已知键），用目标配置的签发者验签（同 SKI 的续期证书不影响选择）；结果在重试间按签发者复用。
6. 与 `targets[id].current` 比较：`sha256` 相等即 `unchanged`，不写；否则按 catalog 里的
   `crlNumber` / `thisUpdate` 摘要判新鲜度，不必再读当前 DER。
7. `put` blob（内容寻址，`ifNoneMatch: "*"`，已存在即视为成功，幂等）。
8. 若有旧 `current`，先 create-only 写它的 history 标记（§5.1）；再 `put catalog.json` 带 `ifMatch` 更新 `current`。
   失败则重读 config 与 catalog 回到第 4 步（目标或签发者变了就重新验签），重试三次（共 4 次尝试，250 ms、500 ms、
   1 s 退避），之后返回 `concurrent_update`。
9. 返回 `created`（之前无 current）或 `updated`。

CRL 的大小：解码按输入设 asn1js 的限额（节点数与内容长度都取输入字节数），唯一的上界是 `AIA_MAX_UPLOAD_BYTES`。内存约每 10 000 个
吊销条目 85–100 MB 堆（Node 实测：10 000 条目 420 KB 的堆门槛为 104 MB 失败、108 MB 通过，0.5 s；128 MB 堆约到 12 500 条目；100 000
条目 4 MB 需 1 GB、4.7 s；10 MiB 约 249 000 条目需 3 GB、12.8 s）。Workers 的隔离区 128 MB 还装着包与运行时，Node 的门槛不能直接换算：
按约 5 000 条目（≈ 200 KB）留安全余量（未在 Cloudflare 上验证），与上限无关；Node 受堆上限约束。
上传默认不要令牌而解码先于任何检查，畸形输入（全 NULL 的 SEQUENCE）每 MiB 约需 384 MB 堆，10 MiB 需约 3 GB，超过堆上限即整个 Node
进程退出。所以默认上限是 1 MiB（≈ 25 000 条目；评审后改的规划默认值，原为 10 MiB）；需要更大 CRL 的部署调高它，并应设
`AIA_UPLOAD_TOKEN`，让只有持令牌的人能送来大体。实测数字见 implementation 切片 4 的风险。线上 CRL 目前 0 个条目。
目标详情（§7.1）每次请求也解码一次当前 CRL，堆峰值与上传相同（10 000 条目 0.6–1 s、响应 4.3–5.5 MB，implementation 切片 5a 出口 9），
所以 Workers 上详情的安全余量同样约 5 000 条目；CPU 不是瓶颈，不设 `limits.cpu_ms`（`docs/operations.md`"容量"）。

第 7 步后崩溃只留下一个无人引用、不进历史的 blob，无害；第 8 步 catalog 写成功即完成，不存在"权威写成功但
派生写失败"的状态。第 1–6 步的拒绝与 `unchanged` 零写入；输掉的竞争只留下本次 blob 与旧 current 的标记（§5.3）。R2 对单键每秒一次写
的限制只落在 `catalog.json` 上：超限报错不是前置条件失败，服务端不重试（500），AD CS 助手顺序上传并按 `-UploadIntervalMs` 间隔。

config 与 catalog 是两个对象，catalog 的条件写不覆盖 config。每次尝试都重读两者再解析目标，剩下的窗口是发布读到 config 之后、
catalog 写成功之前目标被删（`config apply`）：catalog 会留下 config 里已没有的目标的 current（无路径引用、不可下载；切片 6 的 retire
允许清理这种残留）。不为此加跨对象锁：管理操作（导入、改配置、退役、删除）单人串行，删目标前先停该 CA 的发布任务（切片 6 手册）。

`importCertificate` 同理：解析、生成完整摘要、写 blob、条件更新 catalog；重复导入 `unchanged`。
`applyConfig` 校验 §5.2 规则后用 `ifMatch` 替换 `config.json`，首次用 `ifNoneMatch: "*"`；只写 `config.json`，不写 catalog，
状态规则按开头读到的 catalog 判定、不重查。

### 5.6 读取

公开读路由每个请求各 `get` 一次 `config.json` 与 `catalog.json`（两个小对象），详情再读它的一个 blob；列表与 stats 不读 blob，
也不 `list`。config / catalog 指向的东西撑不住（blob 缺失、摘要与 catalog 不符、解析失败、目标的签发者不在 catalog）→ 500 + 一行
`read_inconsistent` 日志；config / catalog 无效或 store 抛错也是 500，绝不当作空列表（§10 #9）。
进程内按 ETag 备忘、5 秒 TTL 是唯一允许的优化，默认关闭，切片 5a 实测后不开：两份对象的读取与解析在亚毫秒级（夹具部署 memory
约 0.05 ms、fs 约 0.3 ms，放大 20 倍约 1 ms），远小于一次详情构建；R2 的真实延迟在切片 7 演练 B 再看。写路径永远直读，不经备忘。

## 6. 领域规则（沿用旧方案，不再讨论）

- 身份：证书 `certificateId` = DER 的 SHA-256；CRL 目标 `targetId` = 创建时分配的 UUID；
  内容版本 = `contentSha256`。CN、文件名不参与身份、授权和路径。
- 验证：AKI/SKI 匹配 + 签名验证。CRL 没有 AKI `keyIdentifier` → `issuer_not_found`（`details.reason = "missing_aki"`，implementation
  切片 4 owner 确认 3）；keyIdentifier 存在但为空 → `invalid_crl` / `extension_value`（同证书摘要：空 key id 不标识任何密钥）；
  外层 `signatureAlgorithm` 与 TBS 内 `signature` 收到的字节不同（OID 或参数）→ `invalid_crl`（`signature_algorithm_mismatch`，
  owner 确认 5；比较收到的字节而不是重编码，外层不在签名之内）；证书导入同样比较（RFC 5280 §4.1.1.2），不同 → `invalid_certificate`
  （`signature_algorithm_mismatch`，implementation 切片 5a 评审修复：证书详情显示外层算法，导入后它必与 TBS 内的相同）。严格 DER 含 X.690 的内容规则
  （INTEGER 最短、OID 子标识符不以 0x80 开头、NULL 无内容、BOOLEAN 为 00 / FF），所以没有人能改写外层算法造出 OpenSSL 读不了、
  却先成为 current 的变体。ECDSA 签名本身可延展：`(r, n − s)` 是另一份 OpenSSL 也验得过的合法 CRL，谁先上传谁成为 current，CA 的原始
  字节随后得 `conflict`（只是 409 的麻烦，不是完整性问题）。`issuer_mismatch` 指 AKI 解析到的证书不是该目标配置的签发者：上传按目标配置的
  签发者验签、不产生此码（owner 确认 4），只留给切片 7 的临时历史导入（C5）。不比较签发者名称、不检查 `cRLSign` 和签发者有效期。
  验签方式（B21）：先过扩展与时钟策略，再在任何密码学调用之前按 OID 白名单判定：sha1/256/384/512WithRSAEncryption、RSASSA-PSS
  （哈希同这四种、MGF1 用同一哈希、`trailerField = 1`）、ecdsa-with-SHA1/256/384/512（签发者曲线 P-256 / P-384 / P-521）；SHA-1 接受
  （owner 确认 1，分发服务不是校验器）；名单外（Ed25519 / Ed448、SHA-224、DSA、SM2、MD5 等）→ `unsupported_algorithm`。参数与签名值
  同样先查：PKCS#1 v1.5 / ECDSA 的参数须缺省或 NULL，PSS 参数不合上述条件、`id-RSASSA-PSS` 受限密钥、名单外曲线或显式曲线参数 →
  `unsupported_algorithm`；签名族与签发者密钥不符、BIT STRING 有未用位、ECDSA 签名不是严格 DER → `invalid_signature`（PKIjs 会放过
  非严格 DER 的 ECDSA 签名与 MGF1 哈希不符的 PSS 签名）。最后对收到的 TBS 字节调
  `pkijs.getCrypto(true).verifyWithPublicKey(tbsView, signatureValue, issuerSpki, signatureAlgorithm)`。不用 PKIjs
  `crl.verify()`：它比较签发者名称，并对其自有名单外的关键扩展静默返回 false（旧实现即如此，见 §10 末的 C1–C4）；
  不调 `pkijs.setEngine`（pkijs 3 从 `globalThis.crypto` 自动初始化）。细则见 implementation 切片 4 步骤 4。
- 新鲜度：先比字节（相等 → `unchanged`），再比 CRL 号，再比 `thisUpdate`；号相等且
  `thisUpdate` 相等但字节不同 → `conflict`；CRL 号只在一侧存在 → `non_orderable`；更旧 → `stale_crl`。号按 BigInt、时间按 epoch ms
  比较（不比字符串）；同号而 `thisUpdate` 更晚 → `updated`，两侧都无号只比 `thisUpdate`；`nextUpdate` 不参与；full 与 delta 目标各比各的
  （AD CS 两者共用一个号计数器）；只读 catalog 的 `current.summary`，不读当前 DER（表见 implementation 切片 4 步骤 5）。
- 时钟：注入的 `now` 是唯一时间源；`thisUpdate` 超前 5 分钟以上拒绝 `not_yet_valid`（恰好 5 分钟接受）；
  `nextUpdate` 已过去的 CRL 接受并记录日志。
- 扩展：识别列表为 `2.5.29.20`、`2.5.29.27`（delta 指示）、`2.5.29.35`、`2.5.29.46`、`2.5.29.18`（IAN）、
  `1.3.6.1.5.5.7.1.1`（AIA）与 AD CS 私有 `1.3.6.1.4.1.311.21.1 / .4 / .14`；识别与关键性无关，标了关键也接受（M14）。`2.5.29.28`（IDP）不论关键性都读：
  只含 `distributionPoint` 接受（AD CS 的 CDP 选项，implementation 切片 4 owner 确认 2），含 `onlyContains*`、`onlySomeReasons`、`indirectCRL`
  即作用域 CRL，拒绝 `scoped_crl_unsupported`，畸形 IDP（含 RFC 5280 禁止的空 IDP）为 `invalid_crl`；其他未识别关键扩展拒绝
  `unknown_critical_extension`。同一扩展出现两次 → `invalid_crl`（X.509 每个扩展至多一次）。
  条目扩展同样检查：reasonCode、invalidityDate、holdInstructionCode 接受，certificateIssuer（间接 CRL）→
  `scoped_crl_unsupported`，其他关键 → `unknown_critical_extension`。未识别的非关键扩展保留原始字节在详情里展示。
  策略表见 implementation 切片 4 步骤 3。
- delta 与 base 相互独立：记录并展示 `baseCrlNumber`，不与已发布 full CRL 对账。
- 下载：路径表命中 → 资源 → catalog 的 current → 先用摘要生成 `ETag`（DER `"<sha256>"`，
  PEM `"<sha256>-pem"`）→ `If-None-Match` 命中直接 304、HEAD 直接回头（都不读 blob）→ 否则读 blob，DER 原样、PEM 现场派生。
  `If-None-Match` 手写比较（逗号列表、`W/`、`*`），在读 blob 之前；不用 `hono/etag`（它在处理器之后比较）。
  `Content-Length` 显式设置（两条运行时的 HEAD 都不会自动带）。目标存在但未发布 → 404。
  下载前缀上的 404 / 405 是纯文本（§4.4）。路径表命中而存储撑不住（引用失效、blob 缺失、大小与 catalog 不符）→ 500 + 日志行，不报 404。
  `Content-Disposition: attachment; filename="<路径最后一段>"`，与线上同形（filename 净化）；`Last-Modified` 取 `importedAt` /
  `publishedAt`，不评估 `If-Modified-Since`。
- 内容类型：DER 证书 `application/pkix-cert`，DER CRL `application/pkix-crl`，
  PEM `application/x-pem-file`。
- 缓存：证书 `public, max-age=31536000, immutable`；CRL `public, max-age=clamp(nextUpdate − now,
  60 s, 3600 s), must-revalidate`，无 `nextUpdate` 时 300 s；API JSON `no-store`；
  `openapi.json` `max-age=300`；UI 哈希资源 `immutable`，`index.html` `no-cache`（两条运行时都由应用设置，§4.4）。
- 安全头：`secureHeaders({ strictTransportSecurity: false })`，其余 Hono 默认（`X-Content-Type-Options: nosniff`、
  `X-Frame-Options: SAMEORIGIN`、`Cross-Origin-Resource-Policy: same-origin` 等）落在全部响应上。不发 HSTS：应用不知道自己是否
  在 TLS 之后，AIA/CDP 下载按设计走明文 HTTP，HSTS 留给 Cloudflare / 反向代理决定。另加 UI 的 `Content-Security-Policy`（§8，切片 5b），
  同样落在全部响应上，对 JSON 与下载没有作用。
- 退役：删路径即 404；`retire` 清空目标 current（先写其 history 标记）并保留历史 blob；被引用的证书不可删除。
  默认退役是终态，该 UUID 不再接受上传，恢复发布用新 UUID（implementation 切片 6 开工前需 owner 确认第 1 项）。
- 上传安全：`bodyLimit` 永远开；可选 `AIA_UPLOAD_TOKEN`；Node 部署的限速交给反向代理，
  文档写明。

## 7. HTTP API v1

### 7.1 公开路由

| 方法与路径                        | 用途                                                   | 状态                                                    |
| --------------------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| `GET /api/v1/health`              | `{ status, checks: { store, configuration } }`：`status` healthy / degraded / unhealthy；`store` ok / error；`configuration` ok / missing / invalid（store 出错时 unknown）；`no-store`。切片 1 只看 `config.json` 存在、是 JSON 且 `version: 1`，切片 2 升级为完整 schema 与规则 | 200（含 degraded：配置缺失或无效）；store 抛错 503 unhealthy |
| `GET /api/v1/certificates`        | 完整数组（无分页），按 id 排序；每项 `{ id, label, importedAt, size, summary, downloads, targets }`：`label` 来自 config（未配置为 `null`），`summary` 是 catalog 的证书摘要，`targets` 是以它为签发者的 `{ targetId, kind, label }` | 200 / 500 |
| `GET /api/v1/certificates/{id}`   | 列表项 + `fingerprints`、`tbsCertificate`（主体 / 签发者、有效期、公钥、全部扩展）、`signatureAlgorithm`（含参数）、`signatureValue`，每次全量构建；`id` 为 64 位 hex，大写规范化为小写 | 200 / 400 / 404 / 500 |
| `GET /api/v1/crls`                | 每个 config 目标一项，按 `targetId` 排序：`{ targetId, kind, label, issuer: { id, label, subjectCN }, downloads, current }`，`current` 为 `{ sha256, size, publishedAt, summary }`（`summary` 含 `nextPublish`）或 `null` | 200 / 500 |
| `GET /api/v1/crls/{targetId}`     | 列表项字段；`current` 另加 `verifier`、`fingerprints`、`tbsCertList`（CRL 号、base 号、时间、全部吊销条目 `{ count, items }`、扩展）、`signatureAlgorithm`、`signatureValue`；未发布为 `current: null`（200）；`targetId` 为 UUID，大写规范化 | 200 / 400 / 404 / 500 |
| `POST /api/v1/crls`               | 上传 CRL：multipart 字段 `crl`，或原始 body（`application/pkix-crl` / `application/x-pem-file` / `application/octet-stream`） | 201 created；200 updated / unchanged；400 / 401 / 409 / 413 / 415 / 422 / 500 |
| `GET /api/v1/stats`               | `{ certificates, targets: { full, delta }, published: { full, delta }, totalRevocations, derBytes }`：`totalRevocations` 为已发布 full CRL 的 `revokedCount` 之和（无已发布 full 时 `null`），`derBytes` 为 catalog 证书与 config 各目标 current CRL 的字节数（历史不计）；不含时间相关字段（"需关注"数由 UI 用客户端时钟算，§8） | 200 / 500                                       |
| `GET /api/v1/openapi.json`        | 运行时从路由表生成（`getOpenAPI31Document`），按进程 / isolate 缓存；与提交的 `docs/openapi.json` 深等（§7.3） | 200，`public, max-age=300`               |

上传成功体：

```json
{ "outcome": "created", "target": "<uuid>", "kind": "full", "sha256": "…",
  "crlNumber": "42", "baseCrlNumber": null, "thisUpdate": "…", "nextUpdate": "…",
  "issuer": "<sha256>",
  "downloads": ["/crl/issuing-ca-1.crl", "/crl/issuing-ca-1.crl.pem"] }
```

`thisUpdate` 必填、`nextUpdate` 可空；`baseCrlNumber` 与签发者证书 id `issuer` 见 M16；200 与 201 是同一个 schema。媒体类型忽略参数与
大小写，内容一律按字节识别（DER 或一个 X509 CRL PEM 块）。失败的状态与 `details`：

| 状态 | 码与 `details` |
| --- | --- |
| 400 | `bad_request`：字段 `crl` 缺失、重复或为空，空体，畸形 multipart 或 multipart `Content-Type` 带 `boundary` 以外的参数，畸形 `Authorization`（B9） |
| 401 | `unauthorized` + `WWW-Authenticate`（只在设了 `AIA_UPLOAD_TOKEN` 时） |
| 409 | `stale_crl`、`conflict`、`non_orderable`：`{ current: { sha256, crlNumber, thisUpdate } }`；`concurrent_update`：无 |
| 413 | `payload_too_large`（`AIA_MAX_UPLOAD_BYTES`，无 `Content-Length` 的流式体也算） |
| 415 | `unsupported_media_type`：`{ received, accepted }`，`received` 为小写、不带参数的媒体类型，缺失或空头为 `null` |
| 422 | `invalid_crl` `{ reason }`；`not_yet_valid` `{ thisUpdate }`；`unknown_critical_extension`、`scoped_crl_unsupported` `{ oid, serialNumber? }`（序列号只对条目扩展）；`issuer_not_found` `{ reason: "missing_aki" }` 或 `{ authorityKeyId }`；`target_not_configured` `{ kind, certificates }`；`invalid_signature`、`unsupported_algorithm` `{ algorithm }` |
| 500 | `internal`，不含异常文本（OpenAPI 里上传与五条公开读路由声明 500，管理路由不声明） |

OpenAPI 的 `security` 为 `[{}, { uploadBearer: [] }]`：令牌可选。

### 7.2 管理路由（`Authorization: Bearer <AIA_ADMIN_TOKEN>`）

| 方法与路径                                            | 用途                                            | 状态                        |
| ----------------------------------------------------- | ----------------------------------------------- | --------------------------- |
| `POST /api/v1/admin/certificates`                     | 导入证书（PEM/DER，multipart 或原始 body）       | 201 created / 200 unchanged / 422 |
| `DELETE /api/v1/admin/certificates/{id}`              | 删除未被引用的证书（blob 一并删除）              | 204 / 409 `referenced`      |
| `GET /api/v1/admin/config`                            | 当前 `config.json` 与 `ETag`                     | 200 / 404（尚未配置）       |
| `PUT /api/v1/admin/config`                            | 整体替换；`If-Match` 与首次的 `If-None-Match: *` 恰好一个 | 200 / 412 / 422 `config_invalid` / 428 `precondition_required`（缺可用前置条件） |
| `GET /api/v1/admin/crls/{targetId}/history`           | 历史条目（history 标记 ∪ current，§5.3；thisUpdate、CRL 号、sha256、size、是否 current） | 200                         |
| `GET /api/v1/admin/crls/{targetId}/history/{sha256}`  | 下载历史 DER                                     | 200 / 404                   |
| `POST /api/v1/admin/crls/{targetId}/retire`           | 清空 current，历史保留                           | 200                         |

未设置 `AIA_ADMIN_TOKEN` 时全部管理路由返回 503 `admin_disabled`（先于鉴权与读体）。令牌比较用 Hono
`bearerAuth`（常量时间）：令牌缺失或错误 → 401 + `WWW-Authenticate`；`Authorization` 头畸形时 `bearerAuth` 回 400，统一包成
`bad_request` 信封。因此每条管理路由的状态表另含 400 / 401 / 503，上传路由在设置 `AIA_UPLOAD_TOKEN` 时同样有 400 / 401（B9）。

### 7.3 信封、错误、中间件

- 成功：直接返回资源体，不包 `{ data }`。
- 失败：`{ "error": { "code": "…", "message": "…", "details"?: … } }`，每个状态码一个 schema。
- 错误码：`bad_request`、`unauthorized`、`not_found`、`method_not_allowed`、
  `payload_too_large`、`unsupported_media_type`、`admin_disabled`、`precondition_failed`、`precondition_required`、
  `config_invalid`、`referenced`、`invalid_crl`、`invalid_certificate`、`not_yet_valid`、
  `unknown_critical_extension`、`scoped_crl_unsupported`、`unsupported_algorithm`、
  `issuer_not_found`、`target_not_configured`、`invalid_signature`、`issuer_mismatch`、
  `stale_crl`、`conflict`、`non_orderable`、`concurrent_update`、`internal`。`issuer_mismatch` 只由切片 7 的临时历史导入
  路由产生，随该路由在 `slice/7-cleanup` 删除（§6）。`details.reason`：`invalid_certificate` / `invalid_crl` 为 `der`、`trailing_bytes`、
  `time`、`structure`、`extension_value`、`pem_label`、`pem_blocks`、`pem_base64`，两者另有 `signature_algorithm_mismatch`；
  `issuer_not_found` 为 `missing_aki`（否则 `details.authorityKeyId`）。
- 中间件顺序：`secureHeaders({ strictTransportSecurity: false })`（§6）→ 请求日志 →
  `methodNotAllowed({ app, onMethodNotAllowed })`（`hono/method-not-allowed`，hono ≥ 4.13.0；`onMethodNotAllowed` 产出
  `method_not_allowed` 信封 + `Allow`，GET 路由自动含 HEAD；下载前缀为纯文本，§4.4）→
  `/api/v1/admin/*` 的 `bearerAuth` → `POST /api/v1/crls` 的路由级 middleware（可选 `bearerAuth` → 媒体类型闸 → `bodyLimit`，都在
  zod-openapi 的校验器之前，匿名或类型不符的上传不读体）→
  路由 → `app.onError` 统一 500 信封，不泄漏异常文本。`bearerAuth`、`bodyLimit` 等抛出的 `HTTPException` 由 `onError` 换成
  信封（库文本换成自己的文案，保留 `WWW-Authenticate`、`Allow`、`Retry-After`）。处理器抛错时日志依次是该操作自己的一行（如
  `publish` 的 `reason: "internal"`）→ `unhandled_error` → `request`。
- OpenAPI（B11）：`GET /api/v1/openapi.json` 在运行时由路由表生成（`getOpenAPI31Document`），每个 app 实例首次请求时序列化并缓存，
  `max-age=300`；`scripts/generate-openapi.ts` 用同一调用写出提交的 `docs/openapi.json`，`--check`（`pnpm run openapi:check`）是
  CI 的漂移检查，测试断言运行时文档深等于该文件且每个 operation 都有 `operationId` 与 `summary`。服务端不读该文件：从 `src`
  导入它会越出 `rootDir: src`，Node 产物与 Worker 包都找不到。切片 1 从 health 路由开始，改路由的切片都重新生成并提交。

### 7.4 CLI

`aia` 读取 `AIA_URL` 与当前命令的令牌：管理命令用 `AIA_ADMIN_TOKEN(_FILE)`，`publish` 用 `AIA_UPLOAD_TOKEN(_FILE)`（可无，服务端只在
设了令牌时要求）；`--token-file` 优先于两个变量，指当前命令的令牌。令牌只经 `https://` 发送，或经 `http://` 发往回环主机（`localhost`、
`127.0.0.0/8`、`[::1]`：Docker exec 与开发）；带令牌而 URL 是其他主机的 `http://` 是用法错误（退出 2，不发任何请求），除非加
`--allow-insecure-http`（对应助手的 `-AllowInsecureHttp`）：生产主机为 AIA/CDP 下载提供明文 HTTP 且不跳转，`AIA_URL=http://<主机>`
能连上服务并把令牌明文发出。不带令牌的命令（`health`、服务端未设令牌时的 `publish`）不检查。子命令：
`import <file...>`、`config show | validate <file> | apply <file>`、`new-target-id`（打印
`crypto.randomUUID()`：目标 UUID 由工具分配，没有建目标接口）、`publish <file...>`
（走公开上传路由，按字节选 `application/pkix-crl` / `application/x-pem-file` 发原始体，逐个文件处理，created / updated / unchanged
之外都算该文件失败）、`history <targetId>`、`retire <targetId>`、
`delete-certificate <id>`、`health`。`config validate` 离线只跑静态规则（V1–V3、V4 / V6 的静态部分，
与服务端共用 `checkConfigStatic`），不连服务、不要令牌；状态与迁移规则（V4–V9 其余部分）由服务端在
apply 时判定，以服务端为准。参数解析用 `parseArgs`，输出为每个文件（块）一行加汇总行，或 `--json`；退出码 0 成功、1 失败（或服务
不健康）、2 用法错误。

## 8. 前端

owner 已确认（决策 5、12；评估与候选对比见 `docs/review-2026-10-18.md` §3）：不再整体迁入旧
`src/web`，而是在同一技术线（Vue 3 + Tailwind 4）上用组件库重建；旧代码只迁移纯逻辑与测试。

- 基座：`vue-router`（history 模式）；`@tanstack/vue-query`（列表 / 详情 `useQuery`，`staleTime: 0`，4xx 不重试、5xx 与网络失败重试一次；
  上传 `useMutation` 成功后先 `cancelQueries` 再全量 `invalidateQueries`）；shadcn-vue 生成的组件（Reka UI 原语，`--style nova`、
  base color `neutral`，源码在 `src/web/components/ui/`，生成代码用 `cn`）；`@vueuse/core`（`useColorMode`、`useNow`、
  `useStorage`；复制走 `src/web/utils/clipboard.ts`：Clipboard API，退回 `execCommand("copy")` 并检查其结果，都不行给 toast）；
  `vue-sonner`（上传结果与复制失败的 toast，顶部居中，`src/web/main.ts` 需 `import "vue-sonner/style.css"`）；
  `@lucide/vue`（取代已弃用的 `lucide-vue-next`）；`tw-animate-css`。Pinia 退出：服务端数据归 vue-query，UI 偏好归 `useStorage`。
  浏览器包全部是 devDependencies（§2）。
- 路由：`/`（总览）、`/certificates/:id`（小写 64 位 hex）、`/crls/:targetId`（小写 UUID），区分大小写；其余路径与格式不符的 id 进
  NotFound 页，不发请求。详情页懒加载；`document.title` = `<页面> · <站名>`。链接打开的页面从顶部开始，前进 / 后退回到
  原滚动位置。未知 UI 路径由 §4.4 的 UI 兜底返回应用（Workers `not_found_handling: "single-page-application"`，Node 回退
  `index.html`）；保留前缀与末段带扩展名的路径不兜底。
- 总览：统计条五格——证书数、CRL 目标数（full / delta）、已发布数、吊销条目（已发布 full CRL 的合计，没有时"未知"）、需关注（stale +
  expired + unknown 的目标数，客户端按徽标的同一时钟与规则算；`/api/v1/stats` 不含时间字段）；证书表（显示名 = 标签 ?? 主体 CN、
  签发者、有效期与剩余时间、状态、DER / PEM 下载，按显示名排序）；CRL 目标表（标签与签发者、类别徽标（证书蓝、full 紫、delta 绿）、
  CRL 号、thisUpdate – nextUpdate、吊销数、状态、下载；未发布显示"未发布"、吊销数 "—"；按标签排序，同名 full 在前）；上传卡片
  （拖放、选择文件或粘贴 PEM，都作为 multipart 文件字段 `crl` 发送；created / updated / unchanged 是三句成功文案，附 CRL 号与下载路径；
  错误按 `error.code` 映射 i18n，带 `details.reason` 时附原因，toast + 行内 Alert；可选上传令牌只存内存，`unauthorized` 时自动展开）。
  骨架屏只在首次加载显示。手机宽度（`sm` 以下）两张表只显示名称 / 标签、类别与状态，其余列在详情页。
- 状态规则（徽标、相对时间与"需关注"共用一个 `useNow({ interval: 60_000 })` 时钟；owner 确认，implementation 切片 5b 末节第 2 项）：
  证书 `not-yet-valid`、`valid`、`expiring`（剩余不足有效期的 10%：根 20 年 → 2 年，签发 CA 10 年 → 1 年；`now == notAfter` 仍在有效期内）、
  `expired`；CRL 目标 `unpublished`（无 current）、`unknown`（无 nextUpdate）、`expired`（now > nextUpdate）、`stale`（带 AD CS Next CRL
  Publish 时 now 超过它 1 h；不带时（如离线 OpenSSL 根 CRL）thisUpdate → nextUpdate 剩余不足 20%）、否则 `current`。
- 详情：证书页 Tabs = 概览（主体 / 签发者 DN 表含 `rfc4514`、有效期、序列号、公钥摘要、签名算法含参数与 ECDSA `(r, s)`、指纹、
  unique ID、它作为签发者的 CRL 目标链接）/ 扩展 / PEM（有 `.pem` 路径时）。CRL 目标页头 = 标签、类别、状态、签发者链接、下载；
  Tabs = 概览（CRL 号与 base 号、thisUpdate / nextUpdate / Next CRL Publish、算法、指纹、签发者 DN）/ 吊销列表 / 扩展；未发布目标
  （`current: null`）只有页头与"未发布"，不显示 0 或"未知"；API 404 显示"不存在"。扩展是 Accordion（关键在前）：每个解析结果映射为
  render block（rows / tags / general names / distribution points / access / policies / subtrees），未识别或解码失败显示 ASN.1 结构 dump
  与原始 hex。吊销列表：序列号、吊销时间、原因、失效起始、间接签发者；表头吸顶，超过 200 行按 200 行一页 `slice()` 分页，0 条显示空状态
  （不用 `@tanstack/vue-table`）。
- 从旧实现迁移：`utils/status.ts`、`utils/dates.ts`、`utils/format.ts`、`utils/x509.ts`、
  `useCrlUploadInput`、`ExtensionView` 的 render-block 映射、`GeneralNameList` /
  `DistributionPointList` / `Asn1Dump`，以及 `tests/web` 的状态与上传输入用例（改写为 vitest）。
- 客户端：`const api = hc<AppType>("", { init: { cache: "no-store" }, fetch: apiFetch })`，vue-query 的 `queryFn` 写
  `unwrap(await api…$get(…))`：2xx 返回 hc 推断类型的体，否则抛 `ApiError { code, message, status, details }`（v1 信封的码；非 JSON 或
  非信封为 `invalid_response`；拿不到响应为 `network`、`status: 0`，由 `apiFetch` 产出）；响应体类型与 core 的 X.509 类型从
  `src/web/client/types.ts` 取，错误码的运行时数组在 `src/web/client/error-codes.ts`（implementation 切片 5a 步骤 10）。
  删除 `readApiResponse`、`validateResponse`、`pagination.ts`、`collectPages`。客户端目录是 `src/web/client/`：
  Vite `root: src/web` 时 dev server 会把 `src/web` 下的目录当 URL 服务，叫 `api` 会与 `/api/` 冲突（`ca`、`crl`、`dcrl` 同理）。
  web 对服务端模块只许 `import type`（`AppType`、core 的 X.509 类型），运行时只导入 `hono/client`。切片 1 的健康徽标已走这条路径。
- 下载链接来自 API 的 `downloads`（`.pem` 结尾标 PEM，其余 DER；多条 DER 路径时另显示文件名）；未发布目标的路径在发布前是 404，
  不给链接（"—"）。
- `SITE_NAME` 只来自 `import.meta.env.VITE_SITE_NAME`（页头与页面标题）；页脚是站名与 OpenAPI 文档链接，不再写 "Cloudflare Workers"。
- i18n：`en` 与 `zh-CN`（完整翻译）；语言取存储的选择（`locale-preference`）→ 浏览器语言中第一个受支持的 → `en`，可切换并记住，
  `<html lang>` 跟随。主题 auto / light / dark（`theme-preference`）；`index.html` 的预绘制内联脚本在首帧前按同一规则设深色类，没有亮色闪烁。
- CSP（implementation 切片 5b 步骤 10）：`secureHeaders` 的 `contentSecurityPolicy`，同一个 app 下发，两条运行时一致：
  `default-src 'self'; script-src 'self' 'sha256-<预绘制脚本>'; style-src 'self'; img-src 'self' data:; connect-src 'self';
  object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'`，没有 `'unsafe-inline'` 与 `'unsafe-eval'`（组件经 CSSOM
  设样式，vue-i18n 11 不用 eval）。hash 写在 `src/http/csp.ts`，`tests/http/csp.test.ts` 与构建插件都对照 `index.html` 重算。
- 体积与依赖卫生：`pnpm run size:web` 逐文件 gzip `dist/web` 的 `index.html`、JS、CSS，总计预算 250 000 字节（`ci:worker` 执行）；
  切片 5b 完成时总计 165 087 字节，首屏（`index.html`、入口 JS、CSS）145 291 字节。构建插件在 web 运行时图解析到服务端模块
  （`src/{core,http,storage,runtime,cli}/`）或 `zod`、`@hono/zod-openapi`、`pkijs`、`asn1js` 时让构建失败。
- 浏览器冒烟：`node scripts/ui-smoke.ts <base> [截图目录]`（`playwright-core` + headless Chromium，对刚 `seed:dev` 的服务跑 en / zh-CN ×
  亮 / 暗，要求控制台无错误、无 CSP 违规；不进 CI，是切片出口里的步骤）。
- 构建到 `dist/web`（Vite `root: src/web`、`build.outDir` = `<repo>/dist/web`、`envDir` = 仓库根），两条运行时都从这里提供。
  dev 代理键用锚定正则 `^/(?:api|ca|crl|dcrl)/`（字符串键 `/crl` 会吞掉 SPA 路由 `/crls/`）。
- shadcn-vue 在切片 1 初始化：`pnpm dlx shadcn-vue@2.8.2 init --base reka --style nova --icon-library lucide --base-color neutral
  --font inter --yes --no-rtl --no-pointer`（永不用 `--defaults`，它等于 `--preset nova --template nuxt`），之后删掉 `main.css` 的
  Google Fonts `@import` 与 `components.json` 的 `font` 键；`components.json`、生成文件与 lockfile 一并入库（registry 是线上的，
  重跑 `add` 可能得到不同代码），生成代码按仓库 Prettier 风格重排。web spike 用 `vega` 风格验证过 init + Vite 8 + Tailwind 4.3，
  `nova` 在切片 1 首次生成。切片 1 只是占位页（路由占位、vue-query、`en` + `zh-CN`、主题切换、`VITE_SITE_NAME`、健康徽标），正式 UI 在
  切片 5b；nova 组件的 `data-open:`、`data-active:` 等状态变体定义在 shadcn-vue 包自带的 CSS 里，CLI 不导入它，`main.css` 抄了那 9 个
  `@custom-variant`。

## 9. AD CS 助手

`scripts/adcs-crl-uploader.ps1` 重写要点（implementation 切片 4 步骤 11；安装、计划任务与 Windows 验证记录见 `docs/operations.md`）：
仅 PowerShell 7；按字节识别（首字节 `0x30` → `application/pkix-crl`，含 X509 CRL PEM 块 → `application/x-pem-file`，都不是即失败、
不上传），`Invoke-RestMethod -Method Post -Body <bytes> -SkipHttpErrorCheck` 发原始体，不再手搓 multipart、不按扩展名判格式、
不调 `certutil`；`-UploadTokenFile`（令牌从受保护文件读，不进任务命令行与日志；带令牌而 URI 为 `http://` 时拒绝，除非
`-AllowInsecureHttp`）；按 `outcome` / `error.code` 判定，created / updated / unchanged 都算成功；本地账本 `published.json`（文件路径 →
被接受字节的 sha256，连同接受它们的 `-UploadUri`）跳过已发布文件，缺失、损坏或属于另一个 URI 时按空处理（同一 URI 上恢复或回滚服务后
删除它）；网络与 TLS 错误记整条异常链；从未被接受的文件返回 `stale_crl` 算失败（CA 产出了比已发布更旧的东西）；
以 `FileShare.Read` 读、`IOException` 重试（CA 可能正在写）；两次上传之间隔 `-UploadIntervalMs`（R2 单键写速率，§5.5）；单文件失败
不影响其余；SourceDir 或令牌文件缺失在任何上传之前退出 1；退出码 0 / 1；事件 68/69/70 触发与定时补扫不变（`MultipleInstances IgnoreNew`）。
2026-10-20 用 Windows 上的 PowerShell 7.6 对本机 Node 服务手动验证过（不是真实 CA）；生产 CA 上的运行在切换时验证（§13）。

## 10. 要补齐的旧实现缺陷

| #   | 旧实现问题                                                              | 新项目处理                                              | 切片 |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------- | ---- |
| 1   | 下载无 304、HEAD 无 `Content-Length`、`ETag` 未加引号                    | §6 下载规则                                              | 3    |
| 2   | 下载路径暴露 `archive/`、`by-keyid/` 与任意对象；详情接受归档 id         | 路径表 + catalog，请求路径不做发现                       | 3, 5a, 5b |
| 3   | CRL `max-age` 无上限，`nextUpdate` 过后降为 0                            | clamp [60 s, 3600 s]，无 `nextUpdate` 300 s              | 3    |
| 4   | 相同 CRL 重复上传返回 409，UI 显示失败                                   | `unchanged` 200                                          | 4, 5b |
| 5   | PEM / alias / archive 伴随写失败使成功发布报 500；`caches.default` 在 Node 上崩 | 无伴随写、无边缘缓存，单提交点                   | 2, 4 |
| 6   | 归档写无条件，重试覆盖来源信息；并发发布无保护                           | 内容寻址 blob + catalog 条件写重试                       | 4    |
| 7   | `revokedCount` 未知时显示 0                                              | 发布时总能解析，`revokedCount` 是非空整数；"未知"只以 `current: null`（未发布）出现，见 implementation 切片 5a 步骤 5 | 4, 5a, 5b |
| 8   | 详情缺 `signatureAlgorithm`；算法 `parameters` 从不输出；契约含永不产生的变体 | 已在迁移源 `5b570aa` 完成（参数解码、`SignatureValue.parsed`）；切片 5a 迁入，删死变体 `unknown`，详情的 `signatureAlgorithm` / `signatureValue` 必填 | 5a |
| 9   | 全 null 信封通过 200 校验变成空列表                                      | 按状态码 schema，无可空信封；store 出错是 500；客户端 `unwrap` 把非 JSON / 非信封的错误体报为 `invalid_response` | 5a   |
| 10  | `relationships` 永远为空                                                 | 从配置填充证书 `targets` 与 CRL `issuer`                 | 5a, 5b |
| 11  | 畸形 ASN.1 时间解码成 1899 并进入新鲜度判断                              | 已在迁移源 `5b570aa` 完成（`pki/asn1.ts` 严格时间，解析期拒绝）；切片 2 随 `src/core/pki` 迁入（证书导入即需要），切片 4 用于 CRL | 2, 4 |
| 12  | 未来 `thisUpdate`、未知关键扩展、作用域 CRL 无显式策略（实为 PKIjs 隐藏的已知扩展闸，见表后 C2） | 时钟策略与显式识别 / 关键性策略表，验签前执行 | 4    |
| 13  | `constructor.name` 判编码，压缩后退化为 unknown                          | 按字节识别 PEM/DER；DN 编码按 ASN.1 tag 判定随构建器迁入   | 2, 5a |
| 14  | 证书只能手工放进 R2 `ca/`，摘要靠请求时补全                              | 导入接口，导入时生成完整摘要                             | 2    |
| 15  | 健康检查硬编码 cache ok，从不降级                                        | 真实 store / configuration 检查，`degraded` 状态；切片 1 起检查，切片 2 升级为完整 schema 与规则 | 1, 2 |
| 16  | 统计按桶前缀字节                                                         | 按资源计数与字节                                         | 5a   |
| 17  | ts-rest 忽略 `no-store`，上传后 30 秒内读到旧数据                        | `hc` 的 `init` + API `no-store`                          | 1, 5a, 5b |
| 18  | `SITE_NAME` 四条通道三条是死的                                           | 仅构建时                                                 | 1, 5b |
| 19  | 上传无体积上限、无鉴权                                                   | `bodyLimit` + 可选令牌                                   | 4    |
| 20  | 助手含 PS5 死分支、手搓 multipart、按扩展名判格式、409 当失败            | §9；切换时必须安装新脚本（C10，§13）                      | 4, 7 |
| 21  | 测试 glob 依赖 shell；组件测试钩子失败挂起整个运行；`pretest` 重生成夹具打乱本地状态 | vitest；幂等夹具生成                        | 1    |
| 22  | 没有 Node / Docker 运行方式                                              | `runtime/node.ts` + Dockerfile                           | 1    |
| 23  | 没有退役、删除、历史查看的管理路径                                       | 管理接口 + CLI                                           | 2, 6 |
| 24  | 日志无结构                                                               | JSON 行                                                  | 1    |
| 25  | `thisUpdate` 缺失时序列化为空字符串                                      | 时间字段必填，缺失即拒绝                                 | 4    |
| 26  | 文档与代码多处不一致                                                     | OpenAPI 从代码生成；README、api.md、operations.md 重写   | 6    |
| 27  | 详情解析覆盖不足：AD CS 私有扩展（CA Version、模板名、Next CRL Publish、CRL Self CDP）、Freshest CRL、IDP、Name/Policy Constraints 等全是 `unsupported`，`1.3.6.1.4.1.311.21.1` 被错标为模板名；DN 编码靠 `constructor.name`；无 `rfc4514`、无 ECDSA (r, s) | 已在迁移源 `5b570aa` 完成（解析器 13 → 41 个，旧仓库用 `tests/data/adcs.ts` 的线上工件回归）；切片 5a 迁入解析器，回归改用合成 AD CS 风格夹具（`tests/data/adcs.ts` 不入库，决策 13） | 5a |
| 28  | 未识别扩展只给 hex；UI "签名算法"显示 Unknown（store 未请求该字段）       | 未识别 / 错误扩展附带 ASN.1 结构 dump（已完成）；新 UI 详情一次取全部分区 | 5a, 5b |

线上旧实现（`worker-aia-cdp@0ea3130`）与迁移源（`5b570aa`）都用 PKIjs `crl.verify()` 与同一套新鲜度比较，实际行为如下（完整性评审 C1–C4）；
§6 的对应规则是新规则而不是"沿用"，处理都在切片 4（implementation 附录 B.2）：

| # | 线上实际行为 | 新项目 |
| --- | --- | --- |
| C1 | 验签用 PKIjs `crl.verify({ issuerCertificate })`，它要求 CRL 签发者名称等于证书主体，名称不同即 400 `invalid_signature` | 不比较名称：`verifyWithPublicKey` 只看签名（§6） |
| C2 | 不是"无策略"：PKIjs 有隐藏的已知扩展闸——关键的 AD CS `1.3.6.1.4.1.311.21.1 / .4 / .14` 被拒成 `invalid_signature`；关键 IDP 反被接受（作用域 CRL 会被发布）；关键 IAN / AIA 接受；条目扩展从不检查 | 显式策略表，识别与关键性无关，条目扩展也检查；作用域 IDP（不论关键性）→ `scoped_crl_unsupported`，只含 `distributionPoint` 的接受，空 IDP 为 `invalid_crl` |
| C3 | 同号同 `thisUpdate` 而字节不同 → 409 `stale_crl`；CRL 号只在一侧时回退比 `thisUpdate`，更晚即接受。#4 只覆盖了字节相同 | 前者 `conflict`，后者 `non_orderable`（§6） |
| C4 | 所有不可验算法（Ed25519、Ed448、SHA-224 的 RSA / ECDSA、DSA、SM2、MD5）都报 400 `invalid_signature` | 白名单外一律 `unsupported_algorithm`，不只 EdDSA |

## 11. 测试与 CI

布局与夹具规则见 implementation 总则 §2.5（B15、B16、决策 13），脚本见 `package.json`。

- vitest 5 `projects`：`core`、`http`、`storage`、`integration`（node 环境）与 `web`（happy-dom），用例在
  `tests/<project>/**/*.test.ts`；独立的 `vitest.config.ts`（不继承 `vite.config.ts` 的 `root`）。HTTP 测试通过
  `createApp({ store: new MemoryStore(), now, … }).request()` 进程内运行，不起端口；只有真实 socket 才看得到的差异
  （HEAD 的 `Content-Length`、传输编码、信号）放 `integration`。
- 夹具：`tests/fixtures/generate-test-data.sh [--force|--check] OUT_DIR` 重写（不是迁入），产物入库；vitest `globalSetup` 每次运行只跑
  `--check`（不改写、不用 `pretest`），改了脚本由开发者 `pnpm run fixtures` 重新生成并提交。契约：日期、序列号、CRL 号固定；私钥、CSR、CA 库只在 `mktemp -d` 临时目录，退出即删，产物含
  `PRIVATE KEY` 即失败；产出证书、CRL、`invalid/`、`manifest.json`（`now = 2026-01-04T00:00:00Z`、声明值、期望结果、场景）、
  `SHA256SUMS` 与按脚本摘要的 `.stamp`（相符且校验通过就不重写，`--check` 只读）；输出 `tests/fixtures/pki/`；
  需要 bash 与 OpenSSL ≥ 3.0（不是 LibreSSL），只在开发与 CI，运行时不需要。测试里的摘要、key id、序列号、大小一律从文件或
  manifest 读（每次重新生成都换密钥，ECDSA / PSS 签名与摘要全变），`now` 注入 `manifest.now`。场景覆盖 created / updated / unchanged / stale /
  conflict / non_orderable / 坏签名 / 伪造 AKI / 未知关键扩展 / 作用域 IDP / 未来 `thisUpdate` / 过期 / delta / EdDSA / PSS /
  无 AKI / 畸形时间 / SHA-1 / AD CS 形态（C11；用例矩阵见 implementation 附录 D）；切片 4 起 `tests/core/publish.test.ts` 对 manifest 的
  31 个 CRL 的首次上传、17 个场景与 6 个无效输入逐条断言（证书 13 张）。不用线上工件（决策 13）。
- 存储一致性：同一套用例对 memory 与 fs 每次运行（r2 适配器另用假桶每次运行）；真 r2 在 `AIA_TEST_R2=1`（`pnpm run test:r2`）下经
  `getPlatformProxy({ configPath: "wrangler.jsonc", persist: false })` 运行，`ci:worker` 包含它且要求 passed 而不是 skipped。
- Node 集成：在临时目录起真实服务与 fs 存储，走 CLI import → config apply → 上传 →
  列表 / 详情 → DER / PEM / HEAD / 304 下载 → 重复上传 unchanged → 旧 CRL 被拒（stale_crl）→ retire → 404。
- Worker：`wrangler deploy --dry-run --outdir dist/worker`（先 `vite build`）；`createTestHarness` 对 dry-run 产物跑与运行时无关的
  `scripts/smoke.sh`，再经管理接口导入并应用配置，查下载的 GET / HEAD / 304 / 405（与 Node 集成测试比对同一组头）；切片 4 起经
  `POST /api/v1/crls` 在 workerd 上发布并验签（ECDSA P-384、RSA PKCS#1 v1.5、RSASSA-PSS、SHA-1）。`wrangler dev` 冒烟是切片出口里的人工步骤。
- Web：组件与逻辑在 vitest `web` 项目（happy-dom）；`tests/http/csp.test.ts` 对照 `index.html` 查 CSP hash，
  `tests/integration/web-build.test.ts` 在真实 `vite build` 里查服务端代码守卫与 CSP 内联脚本检查；浏览器冒烟（§8）是切片出口里的人工步骤。
- Docker：`docker build --check`、构建镜像、启动、健康检查 `healthy` 而 API 报 `degraded`、非 root、经镜像内 CLI `aia import` 与
  `config apply` 后 health `healthy`，下载 `/ca/root-ca.crt` 及其 `.pem`（GET 体等于夹具、`ETag` 与 `Content-Length`，HEAD 同头，
  `If-None-Match` → 304），`docker stop` < 5 s。
- CI：`.github/workflows/ci.yml` 四个任务 `check`（`pnpm run types` 后 worker / node / web 三套编译与 canary、lint、format、
  OpenAPI 漂移）、`test`（单元 + 集成 + `smoke:node`）、`worker`（`build:web` + `size:web` + dry-run + harness 冒烟 + R2 一致性）、`docker`，每个任务只装依赖并
  调用 `pnpm run ci:<job>`；`.github/dependabot.yml` 管 npm、github-actions、docker。GitHub Actions 在推送 `main` 与 PR 时运行（决策 10），本机执行的是
  同一组脚本。`pnpm verify` = check + test + build。

## 12. 实施切片

每个切片一个分支 `slice/<n>-<name>`，从最新 `main` 切出，评审后本地 `git merge --no-ff` 合入 `main` 再推送；不部署（生产部署只在切片 7）；
严格串行（决策 10、11）。每个切片的步骤、测试、可在本机执行的出口条件与"开工前需 owner 确认"见 `docs/implementation/` 下的切片文件，完成定义见
总则 §1.3；下表的出口条件只是摘要，以切片文件为准。

| 切片 | 内容                                                                                                              | 出口条件                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1 骨架与存储 | 依赖、tsconfig 拓扑与边界检查（§3：canary + 决策 15 的护栏）、devcontainer（决策 15）、ObjectStore 端口 + memory/fs/r2 适配器 + 一致性套件（决策 11）、`createApp`（真实 health、运行时 `openapi.json`、保留前缀与 UI 兜底）、Worker 与 Node 入口、Dockerfile、vitest、夹具脚本重写、日志中间件、`ci:*` 脚本与 CI 工作流、shadcn-vue 占位 UI | 全新克隆 `pnpm run verify` 通过；四个 `pnpm run ci:*` 本机通过（r2 一致性为 passed）；`wrangler dev` 冒烟；镜像 healthy 而 API 报 `degraded`（implementation 切片 1） |
| 2 catalog 与导入 | catalog/config schema 与条件写重试、`src/core/pki` 迁入、`importCertificate`、`applyConfig`、health 升级为完整 schema 与规则、管理路由 import/config、CLI import/config/health | CLI 在 fs（Node 集成测试）与本地 R2（`wrangler dev` + `seed:dev`）上导入并应用配置；镜像内 CLI 可用（implementation 切片 2） |
| 3 下载 | 路径表解析、下载路由、PEM 派生、ETag/304/`Content-Length`/`Cache-Control`、纯文本 404/405                         | 多个路径读同一 blob；内部键不可达；HEAD / 304 不读 blob；GET/HEAD 在两条运行时头与字节一致（implementation 切片 3） |
| 4 发布 | `publishCrl`、history 标记、上传路由、三种结果与拒绝原因、`bodyLimit`/`bearerAuth`、发布日志、`aia publish`、AD CS 助手重写 | 夹具覆盖 created/updated/unchanged/stale/conflict/并发/过期/未来/未知关键扩展，拒绝零写入；助手手动验证（implementation 切片 4） |
| 5a API 与客户端 | 列表 / 详情 / 统计路由、OpenAPI 补全、`hc` 类型导出、PKI 构建器迁入（含迁移源 `5b570aa` 补齐的扩展解析，回归改用合成 AD CS 风格夹具，决策 13） | 处理器返回值受类型检查；`openapi` 漂移检查通过；构建器用例在 vitest 下全绿；测量表填满（implementation 切片 5a） |
| 5b UI | §8 的路由、组件库、vue-query、总览与详情页、上传、zh-CN、CSP；`shadcn-vue init` 在切片 1 已完成 | web 测试与 UI 场景通过；两条运行时的 SPA 兜底可用；产物 < 250 KB gzip（implementation 切片 5b） |
| 6 管理补全与文档 | history / retire / delete 路由与 CLI、README、`docs/api.md`、`docs/operations.md`（含迁移与回滚手册）     | 每个职责只有一个实现；`pnpm verify` 与四个 `pnpm run ci:*` 本机全绿（implementation 切片 6） |
| 7 迁移 | `scripts/migrate-from-v2.ts`、临时历史导入路由、在非生产环境演练、生产切换（含替换 AD CS 助手）、`slice/7-cleanup` 删临时路由 | 路径表每条 URL 返回与旧 URL 相同的 DER 摘要（或 `advanced`）；旧对象未删；CryptoAPI 冒烟通过；回滚手册验证过（implementation 切片 7） |
| 8 S3（按需） | `storage/s3.ts`（`@aws-sdk/client-s3`，`IfMatch` / `IfNoneMatch`）、`pnpm run ci:s3`（MinIO）与可选 CI 任务、多实例部署说明；owner 确认要做才开工 | 一致性测试对 MinIO 绿（implementation 切片 8）                                               |

## 13. 从现有部署迁移

线上 pki.acha.top 跑的是 `worker-aia-cdp@0ea3130`（Gen B），更早的对象来自 Gen A，两代的归档名都不含摘要且同名覆盖，所以历史迁移是
**尽力而为**，不是确定性的；旧仓库分支 `parsing-2026-10-18`（含 `5b570aa`，称 Gen C）的归档键从未部署（C9）。旧助手把 v1 响应记为失败，
切换时必须换脚本，只改 `UploadUri` 不够（C10）。线上键布局、探测名集、盘点通道、归属规则与切换步骤以 implementation 切片 7 为准，
下文只保留轮廓。

新服务与旧 Worker 技术上可以共用同一个 R2 桶：新布局的前缀（`config.json`、`catalog.json`、
`blobs/`、`history/`）与旧前缀（`ca/`、`crl/`、`dcrl/`，其下有 `by-keyid/`、`archive/`）不相交，旧对象原样不动。推荐默认不共用：
新 Worker `aia-cdp` 自动置备独立的桶，旧桶零写入，回滚无数据风险（implementation 切片 7 开工前需 owner 确认第 2 项）。

`scripts/migrate-from-v2.ts` 是 HTTP 客户端加本地解析验签（复用 `src/core/pki`），不写旧 R2（盘点通道见 implementation 切片 7
开工前需 owner 确认第 1 项，推荐只用 HTTP）：

1. 从旧服务 `GET /api/v2/certificates` 与 `/ca/<file>` 取每张证书的 DER，
   `POST /api/v1/admin/certificates` 导入，记录 id。
2. 从旧服务 `GET /api/v2/crls` 取每个 full / delta CRL 的当前对象，签发者只按字节验签确定（键名与 metadata 不参与归属），
   为每个（签发者, kind）生成一个 target UUID，按旧 URL 生成 `config.json` 的路径表，
   `PUT /api/v1/admin/config`。
3. 对每个当前 CRL `POST /api/v1/crls`（正常发布路径，期待 created）。
4. 历史（尽力而为）：线上归档是 Gen A/B 的 `<folder>/archive/<名>-<crlNumber>.crl`，无摘要、同名覆盖（Gen C 的
   `crl/archive/<base>-<crlNumber>-<sha256>.crl` 从未部署）；脚本按可预测的名字逐号
   HTTP 探测、与 `/api/v2/stats` 对账，按字节归属与验签，按 CRL 号与 `thisUpdate` 顺序经仅迁移期使用的管理路由
   `POST /api/v1/admin/crls/{targetId}/history` 写入 blob 与 history 标记（不动 current；切片 7 加、`slice/7-cleanup` 删）。
   被同名覆盖的旧版本不可恢复，写进迁移报告。见 §14 #9。
5. 校验：对路径表逐条 GET 旧站与新站，比较 `sha256`（新站已按正常发布前进的记为 `advanced`）；history 列表等于计划的历史集。

切换：暂停 AD CS 计划任务 → 把自定义域 / 路由指到新 Worker（Node 部署则改 DNS 或代理）→
替换助手脚本（旧脚本读不懂 v1 响应，C10）并把 `UploadUri` 改为 `/api/v1/crls`、放好上传令牌文件 → 恢复任务 → 观察一次
`updated` 或 `unchanged`；域内机器上 `certutil -verify -urlfetch` 冒烟。
回滚：路由指回旧 Worker `aia-cdp-worker`，换回旧助手脚本与 `/api/v2/crls`，旧对象一直都在。确认稳定后再手工删除旧对象
（独立桶方案删旧 Worker 与整个旧桶）。

## 14. 本文自行取的默认值（可推翻）

1. 成功响应直接返回资源体，不包 `{ data }`。
2. 上传同时接受 multipart 字段 `crl` 与原始 body。
3. 未设置管理令牌时管理路由返回 503，而不是 404。
4. 公开路径只允许 `/ca/`、`/crl/`、`/dcrl/` 三个前缀；PEM 变体自动派生，不单独配置。
5. 证书路径不允许改绑（只与当前 config 比对，"先删再加"不检测，§5.2）；`config.json` 整体替换而不是逐条增删接口。
6. 公开 API 的 `DELETE /admin/certificates/{id}` 保留在首发里（约 30 行）。
7. 进程内 config/catalog 备忘默认关闭。
8. Node 侧用 `tsc -p tsconfig.build.json` 编译到 `dist/server`，不做单文件打包。
9. 历史迁移尽力而为：线上 Gen A/B 归档无摘要且同名覆盖，按可预测名 HTTP 探测 + stats 对账 + 按字节归属，按 CRL 号顺序迁入（C9），
   见 §13 与 implementation 切片 7。
10. i18n 保留现有 `en`，补 `zh-CN`（切片 1 的占位页已带两种 locale，切片 5b 补全翻译）。
11. 新项目目录 `~/aia-cdp/aia-cdp`（旧仓库在 `~/aia-cdp/worker-aia-cdp`），仓库名 `aia-cdp`；本文件路径 `docs/plan.md`。
12. 其余规划默认值（版本锁定、`worker-configuration.d.ts` 不入库、不发 HSTS、保留前缀与 UI 兜底、手写 ETag / 304、health 形状、运行时
    OpenAPI、夹具入库、浮动 Docker 基础标签、不加 `deploy` 脚本等）是 implementation 总则 §0 的 B1–B22，落实位置见该表；CRL blob 键、
    历史定义与重试次数见 §5，`revokedCount` 非空与 stats 不含时间字段见 §5.3、§7.1。
