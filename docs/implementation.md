# aia-cdp：实施步骤（2026-10-18）

状态：实施计划，2026-10-18 起草，2026-10-19 评审后定稿；代码尚未搭建（`main` 只有 `a30f6dc` 的 plan 与 review），下一步是切片 1。
owner 决策 D1–D10 已定，B1–B22 是规划默认值，可推翻（§0）；各切片未决事项列在该切片的"开工前需 owner 确认"，汇总见附录 C。

2026-10-19 评审修订：覆盖面（10 条）、切片 1 可执行性（13 条）、一致性（20 条）三份评审共 43 条，逐条对照文档、spike 与旧源码核实后
全部采纳、0 条驳回（重叠的按同一问题只改一次）。主要改动：夹具用例矩阵列入附录 D 作重写契约，生成器已在工作树、切片 1 步骤 9 提交并去掉
`leaf-min` 的 SKI / AKI；`list` 改用 `assertStorePrefix`；切片 1 出口条件改为可重复执行的命令；health 用最小完整配置；切片 2 加 V9
（目标的签发者与 kind 不可改）、`PUT /admin/config` 可替换无效配置；补齐切片 2→4、3→4、5a→7、5a→6 的断链与切片 7 的 §10 #27 核对。
同日 owner 确认切片 1 的两项：加边界护栏（D9），本切片建 devcontainer（D10）。

来源：`docs/plan.md`（2026-10-17 定稿、10-18 修订）、`docs/review-2026-10-18.md`；2026-10-18 对 `worker-aia-cdp@5b570aa` 的迁移盘点
（PKI、存储与发布、HTTP 契约、Web、工具链五份清单与一份完整性评审）；在 Node 24.22.0 上跑的六个工具链 spike（hono-node、quality、
web、docker、cloudflare、fixtures）。这些原始报告是临时材料，不在仓库里；本文只用其结论，写"spike 验证"的事实以当时的版本为准。

引用约定：`§N`、`§10 #k` 指 `docs/plan.md` 的章节与 §10 缺陷表第 k 行；`C1`–`C13`、`M1`–`M24` 是完整性评审列出的计划矛盾与
旧代码中计划漏写的规则，逐条去向见附录 B；`D`、`B` 编号见 §0；本文自身章节写"本文 §N"，切片写"切片 N"（"切片 N 步骤 k"指该切片
"步骤"下的第 k 条）。

## 0. 决策与默认值

本节与 `docs/plan.md` 冲突时以本节为准；plan.md 在批次 1 按本节修订（本文 §1.2）。

owner 决策（2026-10-18 逐项询问后确定；D9、D10 为 2026-10-19 切片 1 开工前确认）：

| # | 事项 | owner 决定（2026-10-18；D9、D10 为 2026-10-19） |
| --- | --- | --- |
| D1 | 前端（plan 决策 5） | 确认：Vue 3 + vue-router 5 + TanStack Query + shadcn-vue（Reka UI）+ Tailwind 4；Pinia 退出 |
| D2 | Node | Node 24 LTS（EOL 2028-04-30）全面取代 Node 22：`.nvmrc` = `24`、`engines.node` = `^24.11.0`、`engine-strict=true`、`@types/node` 24.x、Docker `ARG NODE_VERSION=24` 与 `node:24-slim`；本机工具链 `~/.local/opt/node-24`（PATH 前缀） |
| D3 | Git | 新仓库只有本地 git，暂无 GitHub 远端；`main` 放文档，每个切片在 `slice/<n>-<name>` 上开发、评审后本地合并；CI 工作流照写但无远端时不运行，每个 CI 任务都有本地 `pnpm run ci:<job>`，出口条件用它们在本机验证 |
| D4 | 迁移源 | `~/aia-cdp/worker-aia-cdp` 本地分支 `parsing-2026-10-18` 的提交 `5b570aa`；每个迁移步骤引用 `worker-aia-cdp@5b570aa:<path>` |
| D5 | 切片 1 的存储 | ObjectStore 端口、memory / fs / r2 适配器与一致性套件从切片 2 移到切片 1，`/api/v1/health` 在切片 1 就做真实的 store / configuration 检查（§10 #15）；切片 2 保留 catalog/config schema 与条件写重试、`importCertificate`、`applyConfig`、管理路由与 CLI 的 import / config |
| D6 | shadcn-vue 风格 | `--style nova`、base color `neutral`、图标库 lucide（`@lucide/vue`） |
| D7 | 线上工件 | `tests/data/adcs.ts`（pki.acha.top 证书与 CRL 的 base64）不进新仓库；测试只用夹具脚本生成的合成 AD CS 风格夹具（fixtures spike 证明 CA Version / 模板名编码逐字节一致、扩展嵌套相同）；旧仓库用到它的测试改用合成夹具迁入 |
| D8 | 批次 1 | 本文 + plan.md 修订 + 切片 1 |
| D9 | 边界护栏（推翻 plan §3"不另设 ESLint 导入边界规则和 bundle 卫生断言"） | 加：ESLint `no-restricted-imports` 分层规则（`src/core/**`、`src/http/**`）；`scripts/check-worker-program.ts` 作 `typecheck:boundary` 并入 `typecheck`；`ci:worker` 在 dry-run 后断言 `dist/worker/worker.js` 不含 `"node:` 导入。落实：切片 1 步骤 2、7、12，出口 9 |
| D10 | devcontainer | 切片 1 建 `.devcontainer/devcontainer.json`：Node 24 镜像、PowerShell feature（AD CS 助手）、非 root `remoteUser`、不装 `act`、OpenSSL ≥ 3.0 可生成夹具；容器内 Docker 可选；不以 root 生成文件。落实：切片 1 步骤 15，出口 13 |

规划默认值（全部可推翻；推翻时改本表与"落实"列指向的步骤）：

| # | 默认值（可推翻） | 落实 |
| --- | --- | --- |
| B1 | 精确锁 `typescript@5.9.3`（npm latest 7.0.2 超出 typescript-eslint 的 `<6.1.0`）、`wrangler@4.151.1`、`packageManager: pnpm@10.34.7`（npm latest 是 12.x，pnpm 一律经 corepack）；其余版本按 plan §2 与 spike | 切片 1 步骤 1 |
| B2 | 包修正：`@lucide/vue` 取代 `lucide-vue-next`；生成代码用 `cn`；补 `tw-animate-css`、`@vitejs/plugin-vue`、`@tailwindcss/vite`、`vue-tsc`、`eslint-plugin-vue`、`vue-eslint-parser`、`jiti`；`vue-sonner` 需 `import "vue-sonner/style.css"`；浏览器包都是 devDependencies；`@tanstack/vue-table` 仅 5b 需要时加；`@vueuse/core` 用 reka-ui 依赖的同一 major | 切片 1 步骤 1、切片 5b 步骤 1 |
| B3 | 模块约定：相对导入带 `.ts`；`allowImportingTsExtensions` + `rewriteRelativeImportExtensions` + `verbatimModuleSyntax` + `erasableSyntaxOnly`、`types: []`、`skipLibCheck`；服务端无路径别名，web 可用 `@/`；共享代码只用裸 `crypto` / `performance`、`Uint8Array<ArrayBuffer>`，core / http 无 `Buffer`、`process` | 本文 §2.1 |
| B4 | tsconfig 拓扑：解决方案式 `tsconfig.json` + base / worker / node / build / web；边界检查 = 三套编译 + 两个 `@ts-expect-error` canary（另加 D9 的 `typecheck:boundary`）；R2 适配器用结构化类型 `R2BucketLike` | 本文 §2.2、切片 1 步骤 2 |
| B5 | `wrangler types --env-file=/dev/null` 生成的 `worker-configuration.d.ts` 不入库，`pnpm run types` 在 check / typecheck / lint 前重生成；ESLint、Prettier 排除它 | 切片 1 步骤 1、12 |
| B6 | wrangler：`name: "aia-cdp"`（绝不用旧名 `aia-cdp-worker`）、`compatibility_date: "2026-10-12"`、无兼容标志、logs、`minify`、source maps、`STORE` 不写 `bucket_name`（共用旧桶与否是切片 7 的 owner 项）、assets `run_worker_first` + SPA；令牌是可选 secret；脚本关遥测；dry-run 前先建 `dist/web` | 切片 1 步骤 5、12 |
| B7 | `createApp({ store, now, settings, log, ui? })`；保留前缀 `/api/`、`/ca/`、`/crl/`、`/dcrl/` 不进 UI 兜底（API JSON 404、下载纯文本 404）；末段带扩展名的路径不兜底；UI 缓存头由 app 设置（先复制 ASSETS 响应）；405 用 `hono/method-not-allowed`；不注册 `app.get("*")`；路由在首个请求前注册完 | 切片 1 步骤 4 |
| B8 | `secureHeaders({ strictTransportSecurity: false })`，其余默认；CSP 由切片 5b 定 | 切片 1 步骤 4、切片 5b 步骤 10 |
| B9 | 下载不用 `hono/etag`，手写 `If-None-Match`（列表、`W/`、`*`）且先于读 blob；显式 `Content-Length`；`bearerAuth` 对畸形头回 400，进管理与上传的状态表 | 切片 3 步骤 3–4、切片 2 步骤 8、切片 4 步骤 8 |
| B10 | health：`{ status, checks: { store, configuration } }`；store 抛错 → 503 `unhealthy`；config 缺失 / 无效 → 200 `degraded`；`no-store`；切片 2 升级为完整 schema 校验 | 切片 1 步骤 4、切片 2 步骤 7 |
| B11 | OpenAPI 文档运行时从路由表生成并按进程 / isolate 缓存，`GET /api/v1/openapi.json` `max-age=300`；`scripts/generate-openapi.ts` 写入提交的 `docs/openapi.json`，`--check` 查漂移；`src` 不导入该文件 | 切片 1 步骤 8 |
| B12 | 每请求一行 JSON（`method`、`path`、`status`、`ms`，`AIA_TRUST_PROXY` 时加 `client`）；`AIA_LOG_FORMAT=pretty` 给人读；不记令牌与请求体 | 切片 1 步骤 4、本文 §2.6 |
| B13 | Node：`settings.ts` 的 zod schema 照 plan §4.2；`PORT` 8080 显式传给 `serve()`；`*_FILE` 启动时读；无效即打印原因 exit 1；`server.on("error")` 与 SIGTERM / SIGINT 处理；`node --enable-source-maps dist/server/runtime/node.js` | 切片 1 步骤 5 |
| B14 | 适配器（D5）：memory sha256 ETag；fs 临时文件 + fsync + `rename`、按键互斥、拒 `..` 与绝对路径、递归 `list`；r2 `onlyIf` 用不带引号的 `R2Object.etag`、`put` 返回 `null` 即 `precondition-failed`、`list` 跟随游标；一致性套件 memory + fs 每次跑，r2 在 `AIA_TEST_R2=1` 下经 `getPlatformProxy`；store ETag 从不当 HTTP ETag | 切片 1 步骤 3 |
| B15 | vitest 5 `projects` = core、http、storage、integration（node）+ web（happy-dom）；独立 `vitest.config.ts`；HTTP 用 `createApp(...).request()`；夹具在 `globalSetup` 校验 | 切片 1 步骤 10、本文 §2.5 |
| B16 | 夹具：重写的 `tests/fixtures/generate-test-data.sh [--force\|--check] OUT_DIR`，固定日期 / 序列号 / CRL 号，`manifest.json` + `SHA256SUMS` + `.stamp`，产物入库（`.gitattributes` `tests/fixtures/pki/** -text`）、`globalSetup` 只跑 `--check`，需要 OpenSSL ≥ 3.0；测试从文件或 manifest 读值、`now` = `manifest.now`；`.gitattributes` `*.sh text eol=lf` | 切片 1 步骤 9、本文 §2.5 |
| B17 | ESLint 10 flat `eslint.config.ts`、typescript-eslint 8.71.2 projectService、eslint-plugin-vue、`consistent-type-imports` + `no-import-type-side-effects`、`--max-warnings 0`；`pnpm-workspace.yaml` 的 `ignoredBuiltDependencies` 与 `publicHoistPattern`；Prettier 3 沿用旧 `.prettierrc.json`，生成组件每次 `add` 后重排 | 切片 1 步骤 1、7 |
| B18 | Docker：base → prod-deps ∥ build → runtime（`node:24-slim`、uid 1000、`/data`、`NODE_ENV=production`、exec 形式 CMD、HEALTHCHECK）；`ARG VITE_SITE_NAME`；白名单 `.dockerignore`；浮动基础标签 | 切片 1 步骤 11 |
| B19 | `.github/workflows/ci.yml` 四个任务 check / test / worker / docker 各调 `pnpm run ci:<job>`；dependabot 管 npm、github-actions、docker；`pnpm verify` = check + test + build；无远端时本机为准 | 切片 1 步骤 12–13 |
| B20 | Web 占位：Vite root `src/web`、`outDir` `dist/web`、`envDir` 仓库根；`shadcn-vue@2.8.2 init` 固定参数（不用 `--defaults`）；路由占位、vue-query、i18n `en` + `zh-CN`、主题、`VITE_SITE_NAME`、经 `hc<AppType>` 的健康徽标；客户端目录 `src/web/client/`；dev 代理键 `^/(?:api\|ca\|crl\|dcrl)/` | 切片 1 步骤 6 |
| B21 | 切片 4 验签不用 PKIjs `crl.verify()`，改为对收到的 TBS 字节调 `pkijs.getCrypto(true).verifyWithPublicKey(...)`，在扩展策略之后、按算法白名单（EdDSA 按 OID → `unsupported_algorithm`）；不调 `pkijs.setEngine` | 切片 4 步骤 3–4 |
| B22 | 未定的 owner 问题列在需要它的切片的"开工前需 owner 确认"，每项带推荐默认 | 附录 C |

## 1. 顺序、分支与完成定义

### 1.1 顺序与依赖

| 切片 | 分支 | 内容 | 依赖 |
| --- | --- | --- | --- |
| 1 | `slice/1-skeleton` | 骨架、存储端口与适配器（本文 §3） | — |
| 2 | `slice/2-catalog-import` | catalog/config 与导入（§4） | 1 |
| 3 | `slice/3-downloads` | 下载（§5） | 1、2 |
| 4 | `slice/4-publish` | 发布与 AD CS 助手（§6） | 1–3 |
| 5a | `slice/5a-api` | API 与客户端（§7） | 1–4 |
| 5b | `slice/5b-ui` | UI（§8） | 1、4、5a |
| 6 | `slice/6-admin-docs` | 管理补全与文档（§9） | 1–5b |
| 7 | `slice/7-migration`，收尾 `slice/7-cleanup` | 迁移（§10） | 1–6 |
| 8 | `slice/8-s3` | S3，按需（§11） | 1、2、5a、6；owner 确认要做 |

```text
1 ──► 2 ──► 3 ──► 4 ──► 5a ──► 5b ──► 6 ──► 7 ──► 7-cleanup
                                       │
                                       └──► 8（按需，与 7 无先后）
```

严格串行：每个切片都改 `src/http/app.ts`、`src/http/errors.ts`、`docs/openapi.json` 或 `package.json` 的脚本，从最新 `main` 切分支，
上一个切片合入后再开下一个；依赖列只说明"用到谁的产物"，不表示可以并行。

### 1.2 批次 1

D8：批次 1 = 本文 + plan.md 修订 + 切片 1。顺序：

1. 在 `main` 上提交 `docs/implementation.md`、修订后的 `docs/plan.md` 与 `README.md`（仓库已 `git init`，`main` 现有 `a30f6dc`），
   只 `git add` 这三个文件。工作树里未跟踪的 `tests/fixtures/generate-test-data.sh` 不进 `main`，留到切片 1 步骤 9 在
   `slice/1-skeleton` 上提交，在此之前不得删除（切分支时未跟踪文件随工作树保留）。
2. plan.md 修订范围（只改与本文 §0 冲突或被其取代的部分，其余规则修订由各切片的"文档同步"步骤做）：头部状态行与 §0 决策 5（D1 确认）；
   §1、§2、§4.2 的 Node 22 → 24（D2）；§2 版本与包修正（B1、B2）；§3 tsconfig 拓扑与边界检查（B4）、`tests/boundary/`、`src/web/client/`；
   §4.1 wrangler 配置、保留前缀与 UI 兜底（B6、B7、C12）、`secureHeaders`（B8）；§4.2 Dockerfile（B18）；§5.4 适配器细节与一致性套件
   归切片 1（B14、D5）；§7.1 health 形状与 `openapi.json` 运行时生成（B10、B11）；§11 测试布局、夹具规则、CI 本地脚本（B15、B16、B19、
   D3），删掉"现有签名 CRL 夹具覆盖 …"的不实描述（C11）；§12 按 D5 调整切片 1/2，"每个切片一个 PR"改为本地分支（D3），出口条件改为
   指向本文；§13、§14 #9 标注历史迁移前提有误、见本文切片 7（C9、C10）。2026-10-19 评审后另改：§0 决策 15（D9、D10）；§3 推翻
   "不另设 ESLint 导入边界规则和 bundle 卫生断言"、布局加 `.devcontainer/` 与 `scripts/check-worker-program.ts`、`admin.ts` 承担配置校验；
   §5.4 `assertStorePrefix`；§3、§5.5 的 `publishCrl(deps, bytes)`；§8 统计条与 §9 PEM 内容类型指向本文切片 5b、4。
3. 从 `main` 切 `slice/1-skeleton`，按本文 §3 实施，满足 §1.3 后合入。

批次 1 之后每批一个切片；开工前先确认附录 C 中该切片的 owner 项，未答复就按推荐默认实施并在合并说明里写明。

### 1.3 完成定义（每个切片）

1. 在该切片分支上全部提交，`git status` 干净；从 `main` 的最新提交切出（必要时 rebase）。
2. `pnpm run verify` 通过（= `check` + `test` + `build`）。
3. 该切片"出口条件"逐条在本机执行通过；从切片 1 起，合并前另跑一遍四个 `pnpm run ci:<job>`（`ci:check`、`ci:test`、`ci:worker`、
   `ci:docker`）——它们就是 CI 的定义，无远端时没有别的东西会替你跑（D3）。需要人工的出口（`wrangler dev` 冒烟、Windows 助手验证、
   浏览器检查、生产操作）把命令与输出摘要写进合并提交说明，或写进出口条件指定的文档。
4. 改了路由的切片：`node scripts/generate-openapi.ts` 重新生成并提交 `docs/openapi.json`，`pnpm run openapi:check` 无漂移。
5. 改了 plan 规则的切片：同一分支里同步 `docs/plan.md`（各切片的"文档同步"步骤）。
6. 评审通过后在本地合入 `main`（`git merge --no-ff slice/<n>-<name>`，保留切片边界），不推送、不部署；生产部署只在切片 7。

### 1.4 迁移源与引用

- 迁移源固定为 `worker-aia-cdp@5b570aa`（D4），引用写 `worker-aia-cdp@5b570aa:<path>[:<行>]`，行号相对该提交。处置用附录 A 的词：
  原样迁入（migrate-as-is）、迁后改（migrate-adapt）、重写（rewrite）、仅参考（reference-only）、不迁（drop）。
- 读取不切换旧仓库的分支：`GIT_OPTIONAL_LOCKS=0 git -C ~/aia-cdp/worker-aia-cdp show 5b570aa:<path>`；原样迁入的文件用它写出，
  再按本文 §2.1 改导入。旧仓库只读：不提交、不切分支、不在里面安装依赖或跑构建。
- 线上现状（pki.acha.top 跑的是旧仓库 `main` = `0ea3130`，切片 7 称 Gen B）引用 `worker-aia-cdp@0ea3130:<path>`，只用来说明线上行为与
  迁移，不作迁移源。
- 每个 `§10` 缺陷、`C`、`M` 项在处理它的步骤或测试里按编号引用；不处理的写"不做，原因…"。附录 B 是总表。

## 2. 通用约定

切片正文只写本节以外的细节；二者冲突时以本节为准并修正切片。

### 2.1 模块与导入（B3）

- 全仓 ESM（`"type": "module"`）。服务端代码（`src/core`、`src/http`、`src/storage`、`src/runtime`、`src/cli`、`scripts`、`tests` 中除
  `tests/web` 外）相对导入写 `.ts` 后缀、不用路径别名；`tsc -p tsconfig.build.json` 按 `rewriteRelativeImportExtensions` 改写为 `.js`，
  开发与测试由 Node 24 直接运行 `.ts`（type stripping）。
- 只用可擦除语法（`erasableSyntaxOnly`）：不写 enum、namespace、构造参数属性，私有状态用 `#field`；纯类型导入写 `import type`
  （`verbatimModuleSyntax`；ESLint `consistent-type-imports` 分开写 + `no-import-type-side-effects`）。
- `src/web` 走 Bundler 解析，可用 `@/` 别名、导入不带后缀（shadcn-vue 生成代码如此）；web 对服务端模块只许 `import type`
  （`AppType`、core 的 X.509 类型），运行时只放行 `hono/client`（切片 5b 步骤 11 的构建插件强制）。
- core 与 http 只用 Web 标准全局：裸 `crypto`、`performance`、`TextEncoder`，类型写 `typeof crypto`；交给 WebCrypto 的字节为
  `Uint8Array<ArrayBuffer>`；不出现 `Buffer`、`process`、`node:*`。core 不导入 http、storage、runtime、hono（ESLint
  `no-restricted-imports` 强制，D9，切片 1 步骤 7）。
- zod：core 只 `import { z } from "zod"`，对外 schema 用 `.meta({ id })` 命名；`.openapi()`、`createRoute` 只在 http，`z` 从
  `@hono/zod-openapi` 取。全依赖树只允许一份 zod。

### 2.2 tsconfig 拓扑（B4）

| 文件 | 用途 |
| --- | --- |
| `tsconfig.json` | 解决方案式：`files: []`，references 依次 worker、node、web；另带 `compilerOptions.paths {"@/*": ["./src/web/*"]}`（shadcn-vue 只读这个文件） |
| `tsconfig.base.json` | 共享严格选项与 B3 的模块选项，`types: []` |
| `tsconfig.worker.json` | ES2024 无 DOM，类型只有 `worker-configuration.d.ts`：`src/core`、`src/http`、`src/storage/r2.ts`、`src/runtime/{worker,settings}.ts`、Worker canary |
| `tsconfig.node.json` | NodeNext、`types: ["node"]`、`noEmit`：src 的 Node 图、`src/cli`（切片 2 起）、`scripts`、`tests`（除 `tests/web` 与 Worker canary）、根配置文件 |
| `tsconfig.build.json` | 继承 node，只发射 `src` 的 Node 图：`rootDir: src` → `dist/server`；不进根 references |
| `tsconfig.web.json` | vue-tsc：`src/web` + `tests/web`，DOM，Bundler，`rewriteRelativeImportExtensions: false` |

边界检查 = 三套程序都编译 `src/core` 与 `src/http`（web 经 `import type { AppType }`），加 `tests/boundary/` 两个 `@ts-expect-error`
canary（Worker 程序里 `process` 不存在、Node 程序里 `R2Bucket` 不存在），再加 `typecheck:boundary`（D9）：Worker 程序的文件清单里
出现 `@types/node`、`@hono/node-server`、`vite`、`vitest`、`wrangler` 的声明即失败——Node-only 包（`@hono/node-server`）的类型导入编译与
canary 都放过；依赖的 `/// <reference types="node" />` 会让 `process` 在整个 Worker 程序里合法，worker canary 只报 TS2578、看不出来源，所以
`typecheck` 先跑 `typecheck:boundary` 再编译 worker、node、web。每个被 lint 的文件都要落在某个被引用的 tsconfig 里
（typescript-eslint projectService）。逐文件选项见切片 1 步骤 2。

### 2.3 版本锁定（B1、B2）

- 依赖一律精确版本（`.npmrc` `save-exact=true`、`engine-strict=true`），提交 `pnpm-lock.yaml`；Docker、CI、全新克隆都用
  `pnpm install --frozen-lockfile`。
- pnpm 只经 corepack 按 `packageManager: pnpm@10.34.7` 解析；`typescript` 锁 `5.9.3`、`wrangler` 锁 `4.151.1`；dependabot 忽略
  `typescript` ≥ 6.1 与 `@types/node` 的 major 升级。`compatibility_date` 随 wrangler 一起升。
- 首发版本表在切片 1 步骤 1。后续切片新增：`pkijs@3.4.1`、`asn1js@3.1.0`（切片 2，dependencies）；`playwright-core@1.64.1`（切片 5b，
  devDependency，不进 `ci:*`）；`@aws-sdk/client-s3`（切片 8，dependencies，开工时 `npm view` 复核版本）。
- `dependencies` 只放 Node 运行时要的包（Docker 运行阶段只装 `--prod`）；浏览器包、构建、测试、lint 工具都是 devDependencies；
  shadcn-vue CLI 写进 `dependencies` 的包用 `pnpm add -D <包>@<版本>` 挪走。

### 2.4 脚本命名（D3、B19）

- `pnpm run ci:<job>`（`ci:check`、`ci:test`、`ci:worker`、`ci:docker`，切片 8 加 `ci:s3`）是 CI 任务的可执行定义；
  `.github/workflows/ci.yml` 的每个任务只装依赖并调用它。无远端期间本机结果是唯一事实来源。
- 组合：`verify` = `check` + `test` + `build`；`check` = `typecheck` + lint + `format:check` + `openapi:check`；`types` 在 `typecheck`、
  `lint` 之前重生成 `worker-configuration.d.ts`。
- 命名为"动作[:变体]"：`typecheck:worker`、`build:web`、`dev:node`、`smoke:worker`、`fixtures:check`、`openapi:check`、`test:r2`。
  完整表见切片 1 步骤 12；后续新增 `aia`、`seed:dev`、`reset:dev`（切片 2）、`size:web`（切片 5b）、`ci:s3`（切片 8）。不加 `deploy` 脚本。
- TypeScript 脚本直接 `node scripts/<名>.ts`；shell 脚本一律 `bash <脚本>`（owner 的交互 shell 是 zsh）；调用 wrangler 的脚本都带
  `WRANGLER_SEND_METRICS=false WRANGLER_HIDE_BANNER=true`。
- 每个 shell 先 `export PATH=$HOME/.local/opt/node-24/bin:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0`；不以 root 在工作树里跑 pnpm、
  夹具脚本或容器。

### 2.5 测试布局与夹具（B15、B16、D7）

- vitest 5 `projects`：`core`、`http`、`storage`、`integration`（node 环境）与 `web`（happy-dom）；用例在
  `tests/<project>/**/*.test.ts`。`tests/helpers/` 放共享辅助（`testDeps()`、记录写入的 store 包装、seed），`tests/boundary/` 只放编译期
  canary，`*.typetest.ts` 只编译不运行。迁入的旧测试从 `node:test` 改为 vitest，`node:assert/strict` 可保留。
- HTTP 用例走 `createApp({ store: new MemoryStore(), now, … }).request()`，不起端口；只有真实 socket 才看得到的差异（HEAD 的
  `Content-Length`、传输编码、信号处理）放 `integration`。
- 存储一致性套件 `tests/storage/conformance.ts` 对每个适配器跑同一组用例；r2 只在 `AIA_TEST_R2=1`（`pnpm run test:r2`）下经
  `getPlatformProxy({ configPath: "wrangler.jsonc", persist: false })` 跑，`ci:worker` 包含它且要求 passed。
- 夹具只来自 `tests/fixtures/generate-test-data.sh`，产物 `tests/fixtures/pki/` 入库（`.gitattributes` `-text`：`SHA256SUMS` 逐字节校验，
  `full-01.crlf.pem` 故意是 CRLF）；vitest `globalSetup` 每次运行只跑 `--check`，不改写已跟踪文件、不用 `pretest`，过期时报错并提示
  `pnpm run fixtures` 后提交；私钥只在脚本的临时目录；开发与 CI 需要 OpenSSL ≥ 3.0（不是 LibreSSL），运行时不需要。
- 断言里的摘要、key id、序列号、大小、签名一律从夹具文件或 `manifest.json` 读（`tests/fixtures/pki.ts` 的 `manifest`、`NOW`、
  `fixture()`），不写字面量——每次重新生成都换密钥，ECDSA / PSS 签名与摘要全变；时间注入 `manifest.now`（`2026-01-04T00:00:00Z`）。
- 不用线上工件（D7）：`tests/data/adcs.ts` 不入库；切片 7 盘点下载的线上对象只放 gitignore 的 `.migration/`。

### 2.6 错误信封、状态码与日志（plan §4.3、§7.3、B12）

- 失败体 `{ "error": { "code", "message", "details"? } }`，每个状态码一个 schema，code 枚举按路由收窄；成功体直接返回资源，不包
  `{ data }`。异常文本与栈只进日志；未预期错误一律 500 `internal` + 固定文案。
- `details.reason` 词表：`invalid_certificate` / `invalid_crl` 用 `der`、`trailing_bytes`、`time`、`structure`、`extension_value`、
  `pem_label`、`pem_blocks`、`pem_base64`（切片 2）；CRL 另有 `signature_algorithm_mismatch`（切片 4）；`issuer_not_found` 另有
  `missing_aki`（切片 4 默认）。新增取值同步 `docs/api.md` 的码表（切片 6 的 docs-consistency 测试检查）。
- 头：API JSON（含错误）`Cache-Control: no-store`；`/api/v1/openapi.json` `public, max-age=300`。HTTP `ETag` 永远来自内容 sha256
  （下载 DER `"<sha256>"`、PEM `"<sha256>-pem"`，管理 config `"<sha256(存储字节)>"`）；store ETag 只回传给同一适配器，绝不外露（B14）。
- 保留前缀：`/api/*` 未命中 → JSON 404 `not_found`；`/ca/`、`/crl/`、`/dcrl/` 下未命中 → `text/plain` 404 `Not Found`，方法不符 →
  `text/plain` 405 + `Allow: GET, HEAD`（CryptoAPI 客户端；404 从切片 1 起，405 从切片 3 起，切片 1 里方法不符也是 404）。其余 405 走
  `onMethodNotAllowed` 的信封 + `Allow`。
- 鉴权：管理令牌未配置 → 503 `admin_disabled`（先于鉴权与读体）；令牌缺失或错误 → 401 + `WWW-Authenticate`；`Authorization` 畸形 →
  400 `bad_request`（B9）。上传令牌可选，未设置时上传不鉴权。
- 日志只经 `deps.log(line)`（Node 写 stdout，Workers `console.log`），每行一个 JSON 对象，必有 `level` 与 `msg`；`msg` 为事件名：
  `request`（每请求恰好一行，`method`、`path`、`status`、`ms`，可选 `client`）、`import`、`publish`、`retire`、`download_blob_missing`、
  `listening`、`shutdown`、`static_dir_missing`、`temp_files_removed` 等。`AIA_LOG_FORMAT=pretty` 只把同一内容排成一行人读文本：不含空格、`"`、`=`
  的可打印 ASCII 才裸写，其余一律 JSON 编码，并另把 DEL、C1 控制字符与 U+2028 / U+2029 转义（`path` 来自请求，ESC、BEL 等不能原样进终端）。
  永不记录令牌、请求体与查询串。
- `client`（只在 `AIA_TRUST_PROXY=true` 时）：取哪个头由入口经 `AppDeps.clientIpHeader` 决定，应用本身与运行时无关。Workers 只取
  `CF-Connecting-IP`（Cloudflare 边缘设置）；Node 只取 `X-Forwarded-For` 的最右一项（最近一跳受信代理追加的地址，左边各项是客户端自填的）。
  值是 IPv4 / IPv6 字面量才记，否则省略（不回退到别的头或别的项）。

## 3. 切片 1：骨架、存储端口与适配器

### 目标与范围

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

### 前置

- 每个 shell：`export PATH=$HOME/.local/opt/node-24/bin:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0`。pnpm 一律经 corepack 按
  `packageManager` 解析（npm `latest` 是 pnpm 12）；不要在没有 `package.json` 的目录跑 pnpm。
- OpenSSL ≥ 3.0 CLI（不是 LibreSSL）、bash、Docker Engine ≥ 25（`HEALTHCHECK --start-interval`）。需要联网（npm registry、
  shadcn-vue registry、Docker Hub）；不需要 Cloudflare 登录。
- 本节末"开工前需 owner 确认"两项已于 2026-10-19 答复（D9、D10）。
- 工作树里有未跟踪的 `tests/fixtures/generate-test-data.sh`（713 行，sha256 `872a483b…7ac6`），步骤 9 提交。

### 步骤

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

### 测试

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

### 出口条件

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

### 风险与对策

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

### 开工前需 owner 确认

1. **边界漏洞的补丁**（推翻 plan §3 "不另设 ESLint 导入边界规则和 bundle 卫生断言"）。三处编译加 canary 抓不到三类问题：core 导入 Node-only 包
   （如 `@hono/node-server`）、类型导入一个带 `/// <reference types="node" />` 的包（如 `vite`）后 `process` 在整个 Worker 程序里合法（实测 worker canary
   会报 TS2578，但看不出来源）、core → http / hono
   的分层；`wrangler deploy --dry-run` 也照样 exit 0。**已确认（2026-10-19，D9）：加。** ESLint `no-restricted-imports` 分层规则（步骤 7）；
   quality spike 的 `scripts/check-worker-program.ts` 作 `typecheck:boundary` 并入 `typecheck`（步骤 2、12；只靠名单式 ESLint 规则时，`src/http` 里
   `import type … from "vite"` 仍会把整个 `@types/node` 带进 Worker 程序）；`ci:worker` 在 dry-run 后断言 `dist/worker/worker.js` 不含 `"node:` 导入（步骤 12）；
   出口 9 用探针证明三者生效。
2. **devcontainer**：旧 `.devcontainer/devcontainer.json` 用 Node 22 镜像、未固定版本的 act 安装脚本。**已确认（2026-10-19，D10）：本切片建**，
   Node 24 镜像、PowerShell feature、非 root、无 act（步骤 15，出口 13）。

## 4. 切片 2：catalog/config 与导入

### 目标与范围

把旧实现的解析层迁入 `src/core/pki`，定下 `config.json` / `catalog.json` 的 schema 与规范格式，实现条件写重试、
`importCertificate`、`applyConfig`、三条管理路由与 CLI 的 import / config / health。分支 `slice/2-catalog-import`（D3）。

- 做：`src/core/pki/*`、`src/core/summary/catalog-summary.ts`（证书部分）、`src/core/catalog.ts`、`src/core/import.ts`、
  `src/core/admin.ts`（`validateConfig`、`applyConfig`）、`src/core/health.ts` 升级、`src/http/routes/admin.ts`、`src/cli/aia.ts`、
  `scripts/seed-dev.ts`、`docs/config.example.json`。
- 不做：ObjectStore 端口、三个适配器与一致性套件见切片 1（D5；`src/worker/r2/{objects,listing}.ts`、`tests/helpers/r2.ts` 的迁移
  也在切片 1）；`publishCrl`、CRL 摘要与 `toDer` 的 CRL 用法见切片 4；
  路径表解析与下载见切片 3；retire / delete / history 与对应 CLI 见切片 6；summary builders 见切片 5a。
- 本切片处理：§10 #5（导入只有一个提交点、无伴随写与边缘缓存）、#11（证书部分；CRL 见切片 4）、#13、#14、#15（升级）、
  #23（import / config 部分）；C5（V6）、C8（证书部分）、C13（路径字符集部分）；M1（证书）、M4、M5、M7（证书）、M9（导入）、
  M17（路径部分；响应头见切片 3）、M21、M22（`derToPem` 原样保留，规格见切片 3）、M23。

### 前置

- 切片 1 已合入 `main`：`createApp(deps)`、`errors.ts`（`HTTPException` 重包信封并保留 `WWW-Authenticate`）、`settings.ts`
  （`AIA_ADMIN_TOKEN(_FILE)`、`AIA_MAX_UPLOAD_BYTES`；Worker 端令牌是可选字段，B6）、ObjectStore + memory/fs/r2、
  fixture 生成器 + `globalSetup` + `tests/fixtures/pki.ts`（`manifest`、`NOW`、`fixture()`）、`ci:*` 脚本、边界 canary。
- 依赖：`pkijs@3.4.1`、`asn1js@3.1.0` 进 `dependencies`（本切片安装；2026-10-18 已验证旧 PKI 用例在 Node 24 + vitest 5 全过、workerd 内可解析与验签）。
- 测试只用合成 AD CS 风格夹具（D7）；`tests/data/adcs.ts` 不入库，其余用到它的解析用例见切片 5a。

### 步骤

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

   `toDer` 规则（M7，§10 #13；内容类型只用于 415 闸，格式一律按字节识别）：首字节 `0x30` 且外层 TLV 长度恰等于字节数 → DER；
   否则 UTF-8 解码（BOM、前后说明文字容忍），含 `-----BEGIN ` → PEM：标签必须是该 kind 的（证书 `CERTIFICATE`，CRL `X509 CRL`），
   否则 `pem_label`；完整块数 ≠ 1（缺 END 或多块）→ `pem_blocks`；base64 非法 → `pem_base64`；都不是 → 原样交严格解析
   （得到 `der` / `trailing_bytes`）。旧行为"静默取第一块"取消（见 owner 确认 1）。
2. **导入说明符 codemod**（B3）：`perl -pi -e 's{(from\s+"\.{1,2}/[^"]+?)(?<!\.ts)"}{$1.ts"}g' src/core/pki/*.ts`，再把
   `./utils/conversion.ts` 改成 `./conversion.ts`；`tsc` 报 TS1484 的改 `import type`。5a 迁 builders 复用同一命令。
   核对：`grep -rnE 'from "\.\.?/' src/core | grep -v '\.ts"'` 无输出。
3. **`src/core/summary/catalog-summary.ts`**（源 `worker-aia-cdp@5b570aa:src/worker/r2/summary.ts:68-86`，只取字段推导；
   `ensureSummaryMetadata`、合并删除、`SUMMARY_VERSION` 不迁）：`buildCertificateSummary(cert, der)` → `{ subjectCN, issuerCN,
   serialNumber, notBefore, notAfter, subjectKeyId, authorityKeyId, sha1 }`，格式见步骤 4。SKI / AKI 扩展存在但畸形 →
   `invalid_certificate`（`reason: "extension_value"`；旧代码静默跳过，M5）。整份替换，不合并。`buildCrlSummary` 由切片 4 加到同一模块（摘要只有一个实现）。
4. **`src/core/catalog.ts`**：zod 4（core 只用 `zod`，对外 schema 加 `.meta({ id })`），对象一律 `z.strictObject`（拼错键即失败）。
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

   - `ConfigSchema` = plan §5.2 形状（`version: 1`、`certificates{label}`、`targets{issuer,kind,label}`、`paths{certificate}|{target}`；三个映射必填、可为空，
     切片 1 的最小配置因此合法）；
     `CatalogSchema` = plan §5.3 + 新字段 `certificatePaths: Record<path, certificateId>`（改绑账本，只增不减，步骤 6 V7）；
     `targets[*].current` 的字段按 §5.3 先定，CRL 摘要（`revokedCount` 非空、`nextPublish`）由切片 4 步骤 2 补全。
   - `readState(store)` → `{ config, configEtag, catalog, catalogEtag }`；`catalog.json` 缺失视为空 catalog（etag `null`）；
     存储内容非 JSON 或不合 schema 一律抛错（500 + 日志），从不覆盖。写出格式 `JSON.stringify(v, null, 2) + "\n"`，
     `contentType: "application/json"`。store ETag 只回传给同一后端（B14）。
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
   | V7 | `/ca/` 路径若在 `catalog.certificatePaths` 中已绑定别的证书即拒绝；堵住"先删再加"的两步改绑 | 迁移 |
   | V8 | 新配置删掉的目标，其 `catalog.targets[id].current` 必须为空（retire 见切片 6） | 迁移 |
| V9 | 当前 config 里已有的 target id 不得改 `issuer` 或 `kind`；换签发者或种类 = 新 UUID（默认值，可推翻）。这样一个目标的 current 与全部 history 标记都由同一张证书验证，切片 6 的删除保护（`config.targets[*].issuer`、`retired.last.verifier`）才覆盖历史，新鲜度也不会跨签发者比较 | 迁移 |

   V9 写回 plan §5.2（本切片同步）。
   `applyConfig(deps, body, { ifMatch? | ifNoneMatch? })`：读 state（`config.json` 宽松读取：只取原始字节与 store etag，能解析才用于 V9；`catalog.json` 仍走
   会抛错的 `readState`）→ HTTP 前置条件比对（见步骤 8；比的是 `sha256(存储字节)`，所以不合 schema 的现有 config 也能被带匹配 `If-Match` 的 PUT 替换，
   GET"原样返回，便于修复"因此成立；这种 config 只有带外写坏才会出现，此时跳过 V9）→ V1–V6、V9 → `updateCatalog`
   （mutate 内对最新 catalog 重跑 V4–V8，再 `certificatePaths ∪=` 新配置的 `/ca/` 绑定；账本先于 config 写，失败方向是
   fail-closed：最多多记一条从未生效的绑定）→ `put config.json`（`ifMatch` = 读到的 store ETag，首次 `ifNoneMatch: "*"`），
   `precondition-failed` → `precondition_failed`，不重试。目标 UUID 由工具分配（CLI `new-target-id`、seed、切片 7 迁移脚本都用
   `crypto.randomUUID()`），没有建目标接口。`JSON.parse` 对重复键取最后一个，无法检测。
7. **health 升级**（`src/core/health.ts`，B10）：store 改为 `get` config 与 catalog；configuration：缺失 → `missing`；
   非 JSON、`ConfigSchema` / `CatalogSchema` 不过、或静态 + 状态规则不过 → `invalid`；否则 `ok`。迁移规则（V7–V9）不参与。
   同步切片 1 的产物：`tests/core/health.test.ts`、`tests/http/health.test.ts` 的 `head` 抛错用例改为 `get` 抛错；`node-runtime.test.ts`、
   `scripts/node-smoke.sh`、`scripts/docker-smoke.sh` 写的最小配置在完整 schema 下仍为 `ok`，不改。
8. **管理路由 `src/http/routes/admin.ts`**，独立子应用挂到 `/api/v1`（切片 5a 步骤 8 只把公开路由的类型给 web）。
   `app.use("/api/v1/admin/*", …)` 依次：令牌未设置 → 503 `admin_disabled`（先于鉴权与读体）；`bearerAuth({ token })`
   （常量时间；缺失 / 错误 401 + `WWW-Authenticate`，畸形头 400，B9）；`bodyLimit`（上限取 `AIA_MAX_UPLOAD_BYTES`）。OpenAPI 用
   `app.openAPIRegistry.registerComponent("securitySchemes", "adminBearer", { type: "http", scheme: "bearer" })`，路由声明
   `security`。错误码表补 `invalid_certificate`、`config_invalid`、`precondition_failed`、`concurrent_update`。

   | 路由 | 请求 | 状态 |
   | --- | --- | --- |
   | `POST /api/v1/admin/certificates` | 原始体 `application/pkix-cert` / `application/x-pem-file` / `application/octet-stream`，或 multipart 文件字段 `certificate`（字符串字段 400）；`body.required: false`；空体 400 | 201 created / 200 unchanged，体 `{ outcome, id, size, importedAt, summary }`；400 / 401 / 409 `concurrent_update` / 413 / 415 / 422 `invalid_certificate`（`details.reason`）/ 503 |
   | `GET /api/v1/admin/config` | — | 200 存储原文（不合 schema 也原样返回，便于修复）+ `ETag: "<sha256(存储字节)>"`；404；401 / 400 / 503 |
   | `PUT /api/v1/admin/config` | JSON；`If-Match: "<sha256>"`（单个强 ETag）与 `If-None-Match: *` 恰好一个，缺或都有 → 400 | 200 + 新 `ETag`；400（含非 JSON）/ 401 / 412 `precondition_failed` / 422 `config_invalid` / 503 |

   HTTP ETag 永远是存储字节的 sha256，不透出 store ETag（B14）；`W/` 不匹配 → 412。`PUT` 用 `openapi(route, handler, hook)`
   的路由级钩子把 `json` 目标的校验失败映射为 422，其余目标走 `defaultHook` 400。每次导入尝试一行日志
   `{ level, msg: "import", certificateId, outcome | reason }`，不记令牌与请求体（plan §4.3）。改完跑 `node scripts/generate-openapi.ts` 更新 `docs/openapi.json`。
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

### 测试

全部从 `manifest` / 文件读摘要、key id、序列号与大小，`now` 取 `manifest.now`；写入断言用 `tests/helpers/store.ts`
（本切片新建：`recordingStore` 记写入序列，`flakyStore` 让前 n 次 `ifMatch` 失败或让 `put` 抛错）。

| 文件 | 来源（`worker-aia-cdp@5b570aa:`） | 要点 |
| --- | --- | --- |
| `tests/core/pki/asn1.test.ts` | `tests/worker/extension-parsers.test.ts:647`（改用合成 `crls/root-ca/full-01.der`，D7） | 非法 / 非规范时间：`parseCRL` 抛 `PkiParseError`（`reason: "time"`），`readStrictTime` 抛 `Asn1TimeError`；UTCTime 50 分界；`buildTBSCertList` 断言留 5a |
| `tests/core/pki/parsers.test.ts` | `tests/worker/pki-values.test.ts:149`、`:75` 与 `:55` 的解析器部分 | 尾随字节（`certs/root-ca.der` + `00`、`invalid/trailing-byte.der`）→ `trailing_bytes`；CRL 号 BigInt 精度、负数 / ENUMERATED / OCTET 拒绝；偏移视图输入；非字符串 CN；`getAuthorityKeyIdHex`；`pkijs.getEngine().name === "webcrypto"` |
| `tests/core/pki/pem.test.ts` | `tests/worker/pem.test.ts` 原样 + 新增 | `toDer` 矩阵：DER、PEM、BOM + 说明文字、CRLF（`full-01.crlf.pem`）、错误标签、两块、缺 END、坏 base64、以 `0` 开头的文本；`splitPemBlocks` |
| `tests/core/pki/conversion.test.ts` | `tests/worker/conversion.test.ts` | 序列号字面量改读 manifest；`sha256Hex` 只哈希视图字节 |
| `tests/core/summary.test.ts` | `tests/worker/r2-summary.test.ts` 用例 1 | 每张证书：序列号 = manifest `serial`、时间同刻且以 `.000Z` 结尾、`sha1` 40 位小写；`root-ca` 的 AKI 与 `leaf-min` 的 SKI / AKI 为 `null`；**跨切片锁定（M4）**：`issuing-ca-1` 的 `subjectKeyId` 与 `getAuthorityKeyIdHex` 从 `parseCRL(crls/issuing-ca-1/full-01.der)` 读出的值字符串全等；用例 2（CRL 摘要整份替换）见切片 4 测试（同名文件追加） |
| `tests/core/catalog.test.ts` | `r2-summary.test.ts` 用例 3 | 严格对象拒 `tagrets`、大写 hex、非 RFC 9562 UUID；空 catalog；`updateCatalog` 首写 `ifNoneMatch`、失败重读后对手写入保留、4 次后 `concurrent_update` 且睡眠序列 = `[250, 500, 1000]`、终态不写、`put` 抛错不重试 |
| `tests/core/import.test.ts` | `r2-summary.test.ts` 用例 1 后半 | DER created → 同证书 PEM unchanged 零写入；blob 键与字节；`invalid/garbage.txt`、`empty.bin`、CRL 当证书（`structure`）、CRL PEM（`pem_label`）、两证书 bundle（`pem_blocks`）、测试内改坏 `notBefore`（`time`）均零写入；并发导入同证书 → 一 created 一 unchanged；EdDSA CA 可导入；导入后无目标 |
| `tests/core/admin.test.ts` | `tests/worker/crl-upload.test.ts`"different issuers cannot share…"改写 | V1–V9 各一正一反（V5 用 `leaf-min`，它没有 SKI 靠切片 1 步骤 9 的生成器修改；V6 用 `issuing-ca-1` + `issuing-ca-1-renewed`；V7 直接改绑与先删再加两种；V8 往 catalog 预置 `current`；V9 同一 UUID 改 `issuer`、改 `kind` 各一反例，只改 `label` 为正例）；违规全量返回；写入顺序 = catalog 账本先于 config |
| `tests/http/admin.test.ts` | 新 | 上表每个状态；令牌未设置时超限体也是 503；畸形 `Authorization` 400；`DELETE …/admin/config` 带有效令牌 → 405 + `Allow`（无令牌是 401：`bearerAuth` 先抛错，`methodNotAllowed` 只改写无错误的 404）；`no-store`；包一层返回不透明 etag 的 store，证明 HTTP `ETag` 是 sha256；直接往 store 写入不合 schema 的 `config.json` → GET 200 原文 → 带匹配 `If-Match` 的 PUT → 200；日志行无令牌 |
| `tests/http/health.test.ts`（切片 1 文件） | — | 拼错键 / 引用缺失 → `invalid`；apply 后 `healthy` |
| `tests/integration/cli.test.ts` | 新 | `main` 注入 `fetch = app.request`；各子命令输出与退出码；`config validate docs/config.example.json` 离线通过 |
| `tests/integration/node-e2e.test.ts` | 新（切片 3、4 续写） | 子进程起 `node src/runtime/node.ts`（临时 `AIA_DATA_DIR`、空闲端口、`AIA_ADMIN_TOKEN_FILE`）+ CLI 子进程：import ×3 → config apply → health healthy → 重启后 ETag 不变、重复 import 全 unchanged |

### 出口条件

1. `pnpm run ci:check` 通过（三套编译 + canary、lint、format、`node scripts/generate-openapi.ts --check`；`worker-configuration.d.ts`
   不入库，由 `pnpm run types` 现场生成，B5）。
2. `pnpm run ci:test` 通过，含上表全部文件。
3. `grep -rnE 'BufferSource|toJSDate|setEngine|derBufferFromMaybePem|console\.' src/core` 无输出；步骤 2 的说明符核对无输出。
4. `tests/integration/node-e2e.test.ts` 绿（CLI 在 fs 上导入并应用配置）。
5. 本地 R2：`cp .dev.vars.example .dev.vars && pnpm exec wrangler dev --ip 127.0.0.1 --port 8787`（需已有 `dist/web`）后 `AIA_URL=http://127.0.0.1:8787 AIA_ADMIN_TOKEN=dev-admin-token pnpm seed:dev`
   成功，`pnpm aia health` 退出 0，再跑一次 `seed:dev` 全部 unchanged；结果写进合并提交说明（D3，无远端 CI）。
6. `pnpm run ci:docker` 增加：`docker cp` 夹具证书进容器，`docker exec … node dist/server/cli/aia.js import …` 与 `config apply …`
   后 `/api/v1/health` 为 `healthy`（证明镜像带 CLI）。
7. `node src/cli/aia.ts config validate docs/config.example.json` 在无 `AIA_URL`、无网络时退出 0。

### 风险与对策

| 风险 | 对策 |
| --- | --- |
| key id 大小写跨切片不一致，切片 4 静默 `issuer_not_found`（M4） | schema regex 拒大写；`summary.test.ts` 锁定 SKI 与 CRL AKI 全等 |
| config 与 catalog 分别条件写，跨对象竞争 | 状态 / 迁移规则在 `updateCatalog` 的 mutate 内对最新 catalog 重查，账本先写；发布与删目标、删证书与 apply 的竞争见切片 4、6；读取方忽略 config 中已不存在的 target 条目 |
| R2 单键写速率错误不是 `precondition-failed`，重试循环把它变成 500；miniflare 不模拟 | 本切片不重试抛错的 `put`（不知是否已生效）；应对见切片 4 风险与对策（助手 `-UploadIntervalMs`） |
| 删 `toJSDate` 后 5a 的 `buildTime` 无法原样迁入 | 5a 改收 `pkijs.Time`（见切片 5a）；本切片不迁 builders |
| zod-openapi 媒体闸、`body.required`、路由钩子行为偏离预期 | `tests/http/admin.test.ts` 逐状态断言 415 / 400 / 422 |
| r2 一致性与本地 R2 冒烟没有 CI 执行者 | 出口 5 手动执行并记录；`AIA_TEST_R2=1` 套件同次跑 |
| `config validate` 离线查不了 catalog 相关规则 | 文档写明服务端为准；apply 返回全部 `issues` |

### 开工前需 owner 确认

1. 多块 PEM：推荐 API 拒绝（`pem_blocks`）、CLI 拆块逐个导入；备选 API 接受 bundle 并逐个导入（响应变为数组）。
2. 改绑账本 `catalog.certificatePaths`（plan §5.3 新增字段，只增不减）：推荐采用；备选只比对当前配置（放过"先删再加"）。
3. V6 状态部分（SKI 相同的证书不得各有同 kind 目标）：推荐先拒绝；它与切片 4 开工前需 owner 确认第 4 项（多证书共享 SKI 时选哪个签发者）一起定，
   若切片 4 改为"优先已配置的签发者"，V6 可放宽。
4. `PUT` 缺前置条件头：推荐 400 `bad_request`（不新增错误码）；备选 428。

## 5. 切片 3：下载

### 目标与范围

按路径表提供 `/ca/*`、`/crl/*`、`/dcrl/*` 的 DER 与读取时派生的 PEM：摘要 `ETag`、`If-None-Match` → 304（不读 blob）、
GET 与 HEAD 都显式带 `Content-Length`、按资源种类定 `Content-Type` / `Cache-Control`（CRL 夹紧）、filename 净化过的
`Content-Disposition`、纯文本 404 / 405。处理 `§10 #1`、`§10 #2`（下载部分）、`§10 #3`，以及 `C6`、`C7`、`C12`（回归）、`C13`、
`M17`（下载侧）、`M18`、`M19`、`M20`、`M22`。

不在本切片：发布与上传（见切片 4）；配置路径规则——字符集、只写 DER 路径、前缀与种类一致、证书路径不改绑（见切片 2）；
详情接受归档 id（`§10 #2` 的另一半）与 API 的 `downloads` 字段（见切片 5a）；§5.6 备忘的测量（见切片 5a）；
`docs/operations.md` 的头差异清单（见切片 6）；CryptoAPI 冒烟（见切片 7）。

### 前置

- 切片 1 已合并：`createApp(deps)`（`{ store, now, settings, log, ui? }`）、保留前缀 notFound（下载前缀纯文本 404，B7）、
  `methodNotAllowed` + `onMethodNotAllowed`、`secureHeaders({ strictTransportSecurity: false })`（B8）、请求日志（B12）、
  memory / fs / r2 适配器（D5）、vitest 五个 project、夹具脚本、`ci:*` 脚本与基于 `createTestHarness` 的 Worker 冒烟。
- 切片 2 已合并：`src/core/catalog.ts` 的 config / catalog schema 与读取；`src/core/pki/pem.ts`（`derToPem`、`PEM_BLOCK_MARKERS`）；
  `src/core/summary/catalog-summary.ts`；管理路由与 CLI 的 import / config。
- 本切片依赖、但不重复校验的配置不变量（切片 2 的 `applyConfig` 保证）：路径表只含 DER 路径、不以 `.pem` 结尾；前缀与种类一致；
  被引用的证书在 catalog 中。
- 从 `main` 切分支 `slice/3-downloads`（D3）。

### 步骤

1. **PEM 字节格式定为规范（M22）**。`src/core/pki/pem.ts`：`derToPem` 不改（64 列 base64、LF、末尾换行；
   `worker-aia-cdp@5b570aa:src/worker/pki/pem.ts:52-66`）；新增 `pemLength(derSize, markers)` =
   `begin.length + end.length + b64 + ceil(b64 / 64) + 2`，`b64 = 4 * ceil(n / 3)`。注意：`"<sha256>-pem"` 与 HEAD 长度都依赖
   这个格式；改换行或列宽必须同时换 ETag 后缀。
2. **路径表解析**。`src/core/resources.ts` 新增纯函数 `resolveDownload(config, catalog, path)`，返回 `found`（`kind`、`format`、
   `sha256`、`key`、`size`、`filename`、`nextUpdate`、`lastModified`）/ `not_found` / `inconsistent`：
   - `Object.hasOwn(config.paths, path)` 精确匹配、区分大小写 → DER；否则以 `.pem` 结尾且去后缀后命中 → PEM；其余 `not_found`。
   - 证书 → `catalog.certificates[id]`；目标 → `catalog.targets[id]?.current`，缺失或为空（未发布、已 retire）→ `not_found`（plan §6）。
   - 路径引用的证书不在 catalog，或引用的目标不在 `config.targets` → `inconsistent`（例如删除证书与 `applyConfig` 竞争）。
   - 请求路径取 `c.req.path`（Hono 按 `decodeURI` 解码）；不再 `decodeURIComponent`，请求路径也不再当存储键
     （改写 `worker-aia-cdp@5b570aa:src/worker/worker.ts:59-69`）。`src/worker/api/v2/shared/resource.ts` 不迁。
   匹配规则（M20；2026-10-18 用 hono 4.13.13 探针验证）：

   | 请求 | `c.req.path` | 新 | 旧 |
   | --- | --- | --- | --- |
   | `/ca/Root%2DCA.crt` | `/ca/Root-CA.crt` | 命中 | 命中 |
   | `/ca/a%2Fb.crt` | 保留 `%2F` | 404 | 解成 `/` 后查键 |
   | `/ca/%ZZ.crt` | 原样 | 404 | 400 `Bad Request` |
   | `/ca/X.crt`（表中为 `x.crt`） | 原样 | 404 | 404 |
   | `/ca/./x.crt`、`/ca/%2e%2e/…` | URL 解析已消去点段 | 按结果路径处理 | 同 |
   | `/ca//x.crt`、`/ca/x.crt/`、`/ca/` | 原样 | 404 | 404 |
   | `/ca`（无斜杠） | 原样 | 404（`/ca/*` 也匹配它） | 走 ASSETS，404（旧 `assets` 无 `not_found_handling`） |
   | `/ca/x.crt?a=1` | 不含查询串 | 命中 | 命中 |

3. **下载策略（纯函数）**。`src/core/resources.ts` 新增 `downloadHeaders(found, now)` 与 `ifNoneMatchHit(header, etag)`；改写
   `worker-aia-cdp@5b570aa:src/worker/utils/content.ts`（按键后缀 → 按种类），迁入并改写
   `worker-aia-cdp@5b570aa:src/worker/cache/config.ts:54-67`（`getArtifactCacheControlHeader`：注入 `now`、夹紧、去边缘指令）。

   | 头 | 证书 | CRL（full / delta） |
   | --- | --- | --- |
   | `Content-Type` | DER `application/pkix-cert`；PEM `application/x-pem-file` | DER `application/pkix-crl`；PEM `application/x-pem-file` |
   | `ETag` | DER `"<sha256>"`，PEM `"<sha256>-pem"`；sha256 取自 catalog，store ETag 永不外露 | 同 |
   | `Content-Length` | DER = catalog `size`；PEM = `pemLength(size)` | 同 |
   | `Cache-Control` | `public, max-age=31536000, immutable` | `public, max-age=<clamp(floor((nextUpdate − now) / 1 s), 60, 3600)>, must-revalidate`；无 `nextUpdate` 时 `max-age=300` |
   | `Last-Modified` | `importedAt` 转 HTTP 日期 | `current.publishedAt` |
   | `Content-Disposition` | `attachment; filename="<路径最后一段>"`（PEM 带 `.pem`） | 同 |

   - filename 净化沿用 `worker-aia-cdp@5b570aa:src/worker/worker.ts:76`（`[^\x20-\x7e]`、`"`、`\` → `_`），去掉 `filename*`，
     形状与线上一致（C13）。切片 2 限制字符集后净化是空操作，作纵深防御保留（M17）。
   - `Last-Modified`（M18，默认值，可推翻）：保留；不评估 `If-Modified-Since`（秒级精度在同一秒两次发布时会误判 304，ETag 已覆盖）。
   - `ifNoneMatchHit` 照 `hono/etag` 的 `etagMatches`：逗号拆分、`trim`、去 `W/` 后比较（弱比较）；整头 `trim` 后为 `*` 即命中；
     无引号的值不命中（客户端缓存的线上无引号 MD5 只会多一次全量下载）。不用 `hono/etag` 中间件（B9：它在 `next()` 之后比较）。
4. **路由**。`src/http/routes/downloads.ts`：普通 `Hono`（不进 OpenAPI、不进 `AppType`），注册 `get("/ca/*")`、`get("/crl/*")`、
   `get("/dcrl/*")`（HEAD 自动包含）。处理顺序：
   1. 读 config、catalog（切片 2 的读取，各一次 `get`）；`config.json` 不存在视为空路径表；解析失败抛错。
   2. `not_found` → `c.text("Not Found", 404, { "Cache-Control": "no-store" })`（`no-store` 为默认值，可推翻）；
      `inconsistent` → `deps.log` 记 `download_inconsistent`（path、引用 id）后抛错，由 `onError` 出 JSON 500 `internal`。
   3. `ifNoneMatchHit` → `c.body(null, 304, { ETag, "Cache-Control" })`，不带 `Content-Length` / `Content-Type`（RFC 9110 §15.4.5 集合）。
   4. `c.req.method === "HEAD"` → `c.body(null, 200, 全部头)`，不读 blob。
   5. GET：`store.get(key)`；`null` → 记 `download_blob_missing` 后抛错（500，不是 404）；`bytes.byteLength !== size` → 记
      `download_size_mismatch` 后抛错；DER 原样，PEM 为 `TextEncoder` 编码的 `derToPem(...)`；`Content-Length` 取实际字节数。
   注意：每个 200 分支都显式设 `Content-Type`——2026-10-18 探针（hono 4.13.13 + `@hono/node-server` 2.1.5 真实 socket）里未设时
   GET 被补成 `text/plain; charset=UTF-8`、HEAD 没有。`c.body` 只收 `Uint8Array<ArrayBuffer>`（Hono `Data` 类型），端口 `get`
   的返回类型按 B3 写，不在下载路径上复制。不支持 `Range`（忽略，200 全量，旧实现同）。旧 `worker.ts:79-83` 的"HEAD 读整对象"不保留。
5. **挂载与 405（M19、C12）**。`src/http/app.ts`：注册阶段 `app.route("/", downloadRoutes(deps))`（首个请求后 SmartRouter 冻结）。
   `src/http/errors.ts` 的 `onMethodNotAllowed` 按路径分支：`/ca`、`/crl`、`/dcrl` 本身或其下 →
   `c.text("Method Not Allowed", 405, { Allow: "GET, HEAD" })`，其余保持 JSON 信封。探针确认 `/ca/*` 也匹配 `/ca`，不匹配
   `/cafoo`、`/crls/…`：`/crls/<uuid>` 仍走 UI，`POST /dcrl` → 405 `Allow: GET, HEAD`。切片 1 的保留前缀 notFound 留作兜底。
6. **头差异记录**（本表是切片 6 `docs/operations.md` 与切片 7 切换说明的来源）：

   | 项 | 线上（`worker-aia-cdp@0ea3130`） | 新 | 依据 |
   | --- | --- | --- | --- |
   | 可达对象 | 前缀下任意 R2 键（`archive/`、`by-keyid/`、PEM 伴随对象） | 仅路径表及其 `.pem`；`blobs/…`、历史、`config.json`、`catalog.json` 不可达 | §10 #2 |
   | `ETag` / 304 / `Content-Length` | R2 MD5 无引号 / 无 / 无 | `"<sha256>"`、`"<sha256>-pem"` / 有 / GET 与 HEAD 都有 | §10 #1 |
   | 证书 `Cache-Control` | 另带 `s-maxage=31536000, stale-while-revalidate=604800` | 去掉边缘指令 | C7 |
   | CRL `Cache-Control` | `max-age=max(0, nextUpdate − now)`（线上见 428625）+ `s-maxage` | 夹紧 [60, 3600]，过期 0 → 60，无 `nextUpdate` 300 | §10 #3、C7 |
   | `Content-Type` | 按键后缀；PEM `text/plain; charset=utf-8` | 按种类；PEM `application/x-pem-file`（现有 `.crt` / `.crl` 路径的 DER 值不变） | C6 |
   | `Last-Modified` | R2 上传时间 | `importedAt` / `publishedAt`（切片 7 迁移后为导入时间） | M18 |
   | `Content-Disposition` | `attachment; filename="<原样>"` | 同形，filename 净化 | C13、M17 |
   | 404 / 405 | 纯文本；405 无 `Allow` | 纯文本；404 带 `no-store`，405 带 `Allow: GET, HEAD` | M19 |
   | 畸形 `%` / `%2F` | 400 / 解码为 `/` | 404 / 保留后 404 | M20 |
   | 安全头 | 无 | Hono `secureHeaders` 默认集，无 HSTS（含 `nosniff`、`Cross-Origin-Resource-Policy: same-origin`；CryptoAPI / OpenSSL 不看，浏览器顶层导航下载不受 CORP 影响） | B8 |

### 测试

- `tests/core/pki/pem.test.ts`（追加）：`pemLength(n)` 与 `derToPem(...).length` 在 n = 1…4096 及 1 MiB、两种 marker 下全等；
  `derToPem` 对 `certs/root-ca.der`、`crls/issuing-ca-1/full-01.der` 的输出与夹具 `certs/root-ca.pem`、`crls/issuing-ca-1/full-01.pem`
  （OpenSSL 输出）逐字节相等（2026-10-18 在 spike 夹具上验证成立）。
- `tests/core/resources.test.ts`（迁自 `worker-aia-cdp@5b570aa:tests/worker/cache-config.test.ts:78-114`，期望值换新）：步骤 2 匹配表；
  证书 immutable；CRL 无 `nextUpdate` 300、已过期 60（旧 0）、远未来 3600（旧无上限）、`nextUpdate − now = 1234.9 s` → 1234；
  四种 `Content-Type`；`ifNoneMatchHit` 的精确、`W/`、带空格列表、`*`、无引号、空串、缺失；filename 里 `"`、`\`、控制字符、
  非 ASCII → `_`；`inconsistent` 的两种来源。
- `tests/http/downloads.test.ts`：`createApp({ store, now: () => NOW, … }).request()`，`NOW` 取 `manifest.now`；新建
  `tests/helpers/seed-downloads.ts` 直接往 `MemoryStore` 写 blob、`config.json`、`catalog.json`（经切片 2 的 schema 与摘要构建器；
  CRL `current` 直接写，发布在切片 4）。夹具：`certs/root-ca.der`、`certs/issuing-ca-1.der`、`crls/issuing-ca-1/full-01.der`
  （NOW 后 4 天到期 → 3600）、`crls/issuing-ca-1/delta-01.der`（已过期 → 60）、`crls/issuing-ca-1/full-no-next-update.der`（300）；
  摘要与长度一律从文件或 manifest 读（B16）。用例：
  - DER / PEM 字节；两条路径指向同一证书 → 同字节、同 ETag、读同一个 blob 键；
  - 头快照：证书 DER GET、证书 PEM HEAD、CRL DER GET、304 四个响应的完整头（去 `Date`、排序后 `toEqual` 内联期望），并断言没有
    `Strict-Transport-Security`、`s-maxage`、`stale-while-revalidate`、`filename*`；
  - HEAD 与 GET 头相同，`Content-Length` 等于 GET 体长；包装 store 计数：HEAD 与 304 对 `blobs/` 键的 `get` 为 0 次；
  - `If-None-Match` 精确、`W/`、列表、`*` → 304；不匹配 → 200；
  - 纯文本 404 `Not Found`：未知路径、`.pem.pem`、大小写不同、`%2F`、`%ZZ`、`/ca/`、`/ca`、未发布目标、current 为空；
    内部键 `/blobs/certificates/<sha256>.der`、`/ca/blobs/…`、`/crl/archive/x.crl`、`/crl/by-keyid/<aki>.crl`、`/config.json`、
    `/catalog.json` 都拿不到存储内容；下载前缀从不调用 `ui` 桩（C12）；
  - `POST` / `PUT` / `DELETE` / `OPTIONS` → 纯文本 405 `Allow: GET, HEAD`；`POST /api/v1/health` 仍是 JSON 405；切片 1
    `tests/http/app.test.ts` 里"下载前缀 POST → 404"的期望随之改为 405（`scripts/smoke.sh` 不受影响）；
  - store `get` 抛错 → 500 JSON `internal`，体中无异常文本（迁自 `worker-aia-cdp@5b570aa:tests/worker/api-routing.test.ts:27-39`）；
    blob 缺失、size 不符、引用失效各得 500 与对应日志行。
- `tests/integration/downloads.test.ts`（Node 真实 socket）：fs 适配器 + 临时目录 + 同一 seed，`@hono/node-server` 的 `serve()` 监听
  随机端口，`node:http` 读原始头：DER / PEM 的 GET 与 HEAD 头一致（去 `Date`），HEAD 有 `Content-Length`、无 `Transfer-Encoding`，
  304 无体，体 sha256 等于夹具。
- Worker：切片 1 的 Worker 冒烟（`createTestHarness`，`prebuiltWorkerDir: "./dist/worker"`）加下载段：令牌经 harness secrets 注入，
  用切片 2 的管理路由导入 `root-ca` 并应用含 `/ca/root-ca.crt` 的配置，检查 GET / HEAD / 304 / 405，以及未配置的 `/crl/x.crl`
  返回纯文本 404 而不是 `index.html`。CRL 在 workerd 上的下载检查随切片 4 补进同一段。

### 出口条件

- `pnpm run ci:check` 通过（含 `node scripts/generate-openapi.ts --check`：下载路由不进 OpenAPI，`docs/openapi.json` 不变）。
- `pnpm run ci:test` 通过；`pnpm exec vitest run --project core --project http --project integration` 中本节用例全绿。
- `pnpm run ci:worker` 通过，含下载段。
- 多路径读同一 blob、内部键不可达、HEAD / 304 零 blob 读：`tests/http/downloads.test.ts` 对应用例通过。
- GET / HEAD 两条运行时一致：Node 集成测试与 Worker 冒烟对 `/ca/root-ca.crt` 及其 `.pem` 得到相同的 `ETag`、`Content-Length`、
  `Content-Type`、`Cache-Control`，体 sha256 等于 `certs/root-ca.der`（PEM 等于派生结果）。
- 本地手工：用切片 2 的 CLI 导入 `root-ca` 并应用配置后，`curl -sSI http://127.0.0.1:8080/ca/root-ca.crt` 显示 `Content-Length` 与
  带引号的 `ETag`；加 `-H 'If-None-Match: <该 ETag>'` 返回 304。
- 评审后把 `slice/3-downloads` 本地合并到 `main`（D3）。

### 风险与对策

| 风险 | 对策 |
| --- | --- |
| 自动 HEAD 跑完整 GET 处理器，漏掉分支就读 blob | 步骤 4 的 `HEAD` 分支；store 计数用例 |
| HEAD 在两条运行时都不自动带 `Content-Length`，`app.request()` 也看不出 Node 传输层差异 | 显式设置；Node 真实 socket 集成测试；Worker 冒烟 |
| PEM 格式漂移使 `-pem` ETag 与 HEAD 长度失真（M22） | `pemLength` 全等测试 + 与 OpenSSL PEM 夹具逐字节比较 |
| 切片 2 的路径规则未落实（字符集、DER-only、不改绑） | 下载侧净化 filename、精确匹配兜底；证书路径改绑会被 `immutable` 缓存一年——见切片 2 |
| 每次下载读 config + catalog（GET 3 次 store 读，HEAD / 304 2 次） | 资源以十计可接受；§5.6 备忘测量见切片 5a |
| 头变化对 CryptoAPI 可见（PEM 类型、去边缘指令、`Last-Modified` 值、过期 CRL 60 s、安全头） | 步骤 6 表格；切片 7 用 `certutil -URL` / `-verify -urlfetch` 冒烟 |
| 存储不一致（blob 缺失、引用失效）被 404 掩盖 | 一律 500 + 日志行（`download_blob_missing`、`download_inconsistent`、`download_size_mismatch`） |

## 6. 切片 4：发布与 AD CS 助手

### 目标与范围

- 分支 `slice/4-publish`。交付 `publishCrl(deps, bytes)`（入口取一次 `deps.now()`，与 `importCertificate` 同形；plan §5.5）、`POST /api/v1/crls`、`aia publish`、
  每次发布尝试一行日志、history 标记（C8 的解法，步骤 6），以及重写的 `scripts/adcs-crl-uploader.ps1`（plan §9）。
- 覆盖 `§10 #4 #5 #6 #11 #12 #13 #19 #20 #25`；`C1 C2 C3 C4 C5 C8 C10 C11`；`M2 M3 M6 M8–M16 M24`。
- 不在本切片：history / retire 路由与 CLI（见切片 6）；UI 上传卡片与令牌输入（见切片 5b）；
  生产助手替换与令牌文件下发（C10，见切片 7）；CRL 详情投影（见切片 5a）。

### 前置

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

### 步骤

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

### 测试

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

### 出口条件

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

### 风险与对策

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

### 开工前需 owner 确认

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

## 7. 切片 5a：API 与客户端

### 目标与范围

公开只读路由 `GET /api/v1/certificates`、`/certificates/{id}`、`/crls`、`/crls/{targetId}`、`/stats`（plan §7.1）及其 schema；
`worker-aia-cdp@5b570aa` 的四个详情构建器与 X.509 投影 schema 迁入 `src/core/summary/`；OpenAPI 文档补全、lint 与体积预算；
`hc<AppType>` 类型出口与网页客户端的错误处理（`src/web/client/`）。分支 `slice/5a-api`，评审后本地合并（D3）。

不在本切片：`src/core/pki` 解析层与目录摘要（见切片 2）；下载与路径反查（见切片 3）；`POST /api/v1/crls`（见切片 4）；
history / retire / delete（见切片 6）；页面、vue-query、扩展渲染块（见切片 5b）。

§10 归属：#7、#8、#9、#10、#16、#17、#27、#28 与 #2 的"详情接受归档 id"在本切片；#4 服务端见切片 4、文案见切片 5b；#18 见切片 5b。

### 前置

- 切片 1–4 已合并：`createApp` / `errors.ts`（`defaultHook`、`onError`、`methodNotAllowed`、`no-store`）、运行时 `GET /api/v1/openapi.json`
  与 `scripts/generate-openapi.ts --check`（1）；ObjectStore、`src/core/catalog.ts` 的 config / catalog schema 与读取、`src/core/pki/*`、
  证书摘要（2）；`src/core/resources.ts` 的路径反查（3）；`publishCrl` 与 catalog `current.summary`（4）。
- 夹具：`tests/fixtures/pki.ts` 的 `manifest` / `NOW` / `fixture()` 与 vitest `globalSetup`（切片 1）。断言值取自文件或 `manifest.json`，
  不写摘要、密钥 id、大小字面量（B16）；`tests/data/adcs.ts` 不入库（D7）。
- 切片 5b 开工前需 owner 确认第 2 项（状态阈值）已定：它只决定 `/api/v1/stats` 是否含时间相关字段（CRL 列表项总带 `current.summary.nextPublish`，
  切片 4 步骤 2 总会记录它）。

### 步骤

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

### 测试

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

### 出口条件

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

### 风险与对策

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

### 开工前需 owner 确认

1. **状态阈值 / 即将过期规则**：与切片 5b 开工前需 owner 确认第 2 项是同一问题，推荐默认写在那里；须在本切片开工前定，因为它决定
   `/api/v1/stats` 是否含时间相关字段（推荐：不含）。CRL 列表项总带 `current.summary.nextPublish`（切片 4 步骤 2 总会记录），不受它影响。

## 8. 切片 5b：UI

### 目标与范围

在切片 1 的占位 UI 上按 plan §8 建成正式 UI：总览、证书详情、CRL 目标详情、CRL 上传；迁入旧实现的纯逻辑与
X.509 渲染组件并补上它们缺失的测试；补 `zh-CN`；定下 CSP；产物 < 250 KB gzip 且有可重复的测量。分支 `slice/5b-ui`。

不在本切片：`hc` 客户端、`ApiError` / `unwrap`、类型再导出与列表 / 详情 / 统计路由（见切片 5a）；SPA 兜底与 UI 缓存头的机制
（见切片 1，本切片只在出口复验，含 C12）；`VITE_SITE_NAME` 默认值与转义守卫（见切片 1）；管理操作 UI（不做，原因：管理通道是
令牌 + CLI，plan §7.2 / §7.4，浏览器里不放管理令牌）。

本切片处理：§10 #7、#17、#18、#28 的 UI 部分，以及 #2、#4、#10 的 UI 部分；M8 与 M16 的 UI 侧；以及 5b 的已知风险：状态阈值、渲染无测试、偏好延续、`import type` 纪律、客户端 404 与重试、上传令牌。
其余 §10 / C / M 条目与 UI 无关，归各自切片。

### 前置

- 切片 1 已合并：Vite `root: src/web`、`outDir: dist/web`、`envDir`；`shadcn-vue@2.8.2 init --style nova`（D6）与
  `components.json`、`src/web/lib/utils.ts`；路由占位、`VueQueryPlugin`、i18n 骨架、`useColorMode` 主题切换、
  `tw-animate-css`；dev 代理键 `^/(?:api|ca|crl|dcrl)/`；两条运行时的 UI 兜底与缓存头；
  `scripts/smoke.sh` 与 `tests/integration/node-runtime.test.ts`。
- 切片 4 已合并：`POST /api/v1/crls` 的三种结果、错误码、可选 `AIA_UPLOAD_TOKEN`；multipart 字段 `crl` 接受文件与字符串（M8，切片 4 步骤 8）；UI 一律发文件（步骤 7）。
- 切片 5a 已合并，并提供下列 UI 依赖（缺哪项就在 5a 补，不在 UI 里绕）：
  - `src/web/client/`：`api`（`hc<AppType>`，`init: { cache: "no-store" }`）、`ApiError`（`code`、`status`、`message`、`details`）+ `unwrap`、
    `types.ts`（从 core summary schema 做 type-only 再导出：`Name`、`GeneralName`、`Extension(s)`、`Asn1Line`、`DistributionPoint`、
    `AlgorithmIdentifier`、列表项与详情）；错误码数组 `src/web/client/error-codes.ts`（运行时值，供测试遍历；切片 5a 步骤 10）。
  - 列表项带 `downloads[]`；证书项含 `label: string | null`、`summary`（`subjectCN`、`issuerCN`、`notBefore`、`notAfter` 等，切片 5a 步骤 5）、`targets[]`；目标项含 `label`、`kind`、
    `issuer`、`current`（可空；`current.summary` 含 `crlNumber`、`baseCrlNumber`、`thisUpdate`、`nextUpdate`、`revokedCount`（非空整数，切片 5a 步骤 5）、`nextPublish | null`）。
  - 已配置但未发布的目标详情返回 200 + `current: null`；上传成功体含 `kind`、`crlNumber`、`baseCrlNumber`、`downloads`（M16）。
  - 死变体 `extensionType: "unknown"` 已删；吊销条目不再按旧 builder 的默认 10 条分页。
- 本地：`tests/fixtures/pki/` 已由生成脚本产出；切片 2 的 CLI 能 `import` / `config apply`，用于冒烟数据。

### 步骤

1. **组件**：`pnpm dlx shadcn-vue@2.8.2 add <名单> --yes < /dev/null`，名单为下列中切片 1 尚未生成的
   `accordion alert badge button card collapsible input label skeleton sonner table tabs textarea tooltip`。之后：新包用
   `pnpm add -D` 移到 devDependencies（Docker 运行阶段只装生产依赖）；`sonner` 带来 `vue-sonner`，在 `src/web/main.ts` 加
   `import "vue-sonner/style.css"`（B2）；确认 `components.json` 无 `font` 键、`main.css` 无 Google Fonts `@import`；
   `pnpm exec prettier --write src/web/styles/main.css components.json src/web/components/ui src/web/lib`（生成代码改为仓库风格，同切片 1 步骤 6）。
   不引入 `@tanstack/vue-table`：分页只是 `slice()`（默认值，可推翻）。
   注意：nova 风格在 spike 中未验证（spike 用 vega），切片 1 只生成过 `button`、`badge`；registry 是线上的，生成文件与 lockfile 一并提交，日后 `shadcn-vue diff` 再比。
2. **纯逻辑迁入**（类型一律 `import type` 自 `@/client/types`）：
   - `src/web/utils/status.ts` ← `worker-aia-cdp@5b570aa:src/web/utils/status.ts`：`computeCertificateStatus` / `computeCrlStatus`
     的含边界与秒粒度原样保留；删死函数 `computeCertificateValidity`、`computeCrlValidity`；新增 `unpublished`（`current === null`）
     与 owner 确认后的 `nextPublish` / 证书 `expiring` 规则（见末节）；`nowMs` 改为必填，不再默认 `Date.now()`。
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
   （`${name} (${code})`、模板版本 `major.minor`、SCT `hash/signature`、子树范围 ` [min–max]`）。组件迁到 `src/web/components/x509/`：
   `ExtensionView.vue`（`AccordionItem`：名称 / OID、Critical 徽标、解析状态徽标；未解析时 `parseError` + `Asn1Dump` + 原始 hex
   `Collapsible`）、`ExtensionList.vue`（关键在前、`localeCompare`、对副本排序，`Accordion type="multiple"`）、`GeneralNameList.vue`、
   `DistributionPointList.vue`、`Asn1Dump.vue`、`NameDetails.vue`，来源均为 `worker-aia-cdp@5b570aa:src/web/components/<同名>.vue`。
   `TAG_TONES`（blue / purple / amber）改为 Badge 的 cva 变体，颜色只用 token。
4. **通用组件**：`StatusBadge.vue`（Badge 上的 cva 状态表，加 `unpublished`、`expiring`，删未用的 `showLabel`）；`HexValue.vue`
   （`useClipboard({ legacy: true })`、复制 / 已复制文案走 i18n、写剪贴板失败给 toast）；`DownloadLinks.vue`（依据
   `…:src/web/components/ResourceCard.vue:44-51,76-85`：由 `downloads[]` 驱动，`.pem` 结尾标 PEM 否则 DER，`<a download>`，空列表 "—"）；
   `KeyValueList.vue`（取代 `FingerprintDetails.vue` 与各处重复的 `dt/dd` 类名）；`LocaleSelect.vue`（取代切片 1 的 `LocaleSwitch.vue`）。
5. **查询层** `src/web/client/queries.ts`：键 `["health"]`、`["stats"]`、`["certificates"]`、`["certificate", id]`、`["crls"]`、
   `["crl", targetId]`，`queryFn` 一律 `unwrap(await api…$get(…))`。`src/web/main.ts` 的 `QueryClient`：`staleTime: 0`、
   `retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2`（404 不重试，否则详情页的 404 要等几秒）、`refetchOnWindowFocus` 保持默认。
   `useUploadCrl()` = `useMutation`，成功后 `queryClient.invalidateQueries()` 全量失效（数据量很小）。配合 5a 的 `no-store` 修 §10 #17。
   骨架屏只在无数据的首次加载显示，重取时保留旧数据（旧 `App.vue:72,125`）。旧 `stores/*`、`useCollectionLoader`、`useDetailCache` 不迁。
6. **路由与页面**：
   - `src/web/router.ts`：`/certificates/:id([0-9a-f]{64})`、`/crls/:targetId(<UUID 正则>)`，其余进 `/:pathMatch(.*)*` →
     `NotFoundPage.vue`；格式不符的 id 不发请求（§10 #2 的 UI 侧）。详情页懒加载；`document.title` = `<页面> · <siteName>`。
   - `src/web/App.vue`（壳）：页头 `import.meta.env.VITE_SITE_NAME`（删 i18n `app.title`）、`LocaleSelect`、`ThemeToggle`；`<RouterView>`；
     页脚不写 "Cloudflare Workers"（§10 #18 UI 部分）；`<Toaster />`；统一一个最大宽度。
   - `pages/OverviewPage.vue` + `components/overview/{StatsBar,CertificateTable,CrlTargetTable,CrlUploadCard}.vue`（参考
     `…:src/web/App.vue`、`CertificateCard.vue`、`CrlCard.vue`）：统计条的计数取 `stats`，`totalRevocations` 为 `null` 显示"未知"；
     时间相关的"需关注"数用 `useClock` 在客户端按徽标同一规则算，不用服务端时钟。证书表：`label ?? summary.subjectCN`，缺省 "Unknown Certificate"；
     目标表：类别色（证书蓝、full 紫、delta 绿）、`CRL #n`、吊销数、未发布显示"未发布"（吊销数显示 "—"）；相对时间只对 valid / current 显示。
     排序（默认值，可推翻）：证书按显示名；目标按 `label`，同名 full 在 delta 前。
   - `pages/CertificatePage.vue` + `components/certificate/CertificateOverview.vue` ← `…:src/web/components/CertificateDetails.vue`：
     Tabs = 概览（主体 / 签发者 `NameDetails` 含 `rfc4514`、有效期与相对时间规则 `:47-59`、序列号、公钥摘要 `:20-37`、签名算法含参数
     （§10 #28：一次请求拿全部分区，不再出现 Unknown）、ECDSA `(r, s)`、指纹、`issuerUniqueID` / `subjectUniqueID`、该证书作为签发者的
     CRL 目标链接（§10 #10））/ 扩展（`ExtensionList`）/ 原文（默认值：取 `downloads` 中 `.pem` 路径的文本 + 复制；无 `.pem` 路径时不显示该 Tab）。
   - `pages/CrlTargetPage.vue`（取代切片 1 的占位 `CrlPage.vue`，`tests/web/router.test.ts` 同步）+ `components/crl/RevokedTable.vue` ← `…:src/web/components/CrlDetails.vue`：页头（标签、类别、状态、下载）；
     概览（签发者链接 → `/certificates/:id`、CRL 号与 base 号（旧 UI 只在扩展里出现）、thisUpdate / nextUpdate / nextPublish、算法、指纹）；
     吊销列表（未发布不显示列表，不再把未知显示成 0（§10 #7）；0 → 空状态；列：序列号 / 吊销时间 / 原因 / 失效起始 / 间接签发者，表头吸顶，
     超过 200 行按 200 行一页客户端分页）；扩展。`current: null` → 页头 + "未发布"；`ApiError` `not_found` → 页内"不存在"状态。
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
9. **主题**：`ThemeToggle.vue`（重写 `worker-aia-cdp@5b570aa:src/web/components/ThemeToggle.vue`）用 `useColorMode({ storageKey: "theme-preference" })` 并解构 `store`（模板自动解包，`mode.store` 不可达）；
   取值 `auto` / `light` / `dark` 与旧 `…:src/web/composables/useTheme.ts` 相同，切换后同域的已有偏好直接生效（切片 1 已用该键）。
   循环 auto → light → dark，文案走 i18n。`src/web/index.html` 加预绘制内联脚本：try/catch 读
   `theme-preference`，在首帧前设 `dark` 类，消除旧版的亮色闪烁。
10. **CSP**（按末节 owner 确认的结果；下为推荐默认）：`src/http/csp.ts` 定义策略与预绘制脚本的 `sha256-…`，`src/http/app.ts` 改为
    `secureHeaders({ strictTransportSecurity: false, contentSecurityPolicy: … })`；UI 响应经 `deps.ui` 由同一个 app 发出（切片 1 已复制 ASSETS 响应），两条运行时一致。
    策略：`default-src 'self'; script-src 'self' 'sha256-<预绘制脚本>'; style-src 'self'; img-src 'self' data:; connect-src 'self';
    object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'`。冒烟发现样式违规再放宽为 `style-src 'self' 'unsafe-inline'`
    （hono-node spike 预计 vue-sonner 需要）；若 vue-i18n 运行时编译触发违规，改为构建期预编译消息。
11. **体积与依赖卫生**：`scripts/check-web-size.ts`（`node scripts/check-web-size.ts`）对 `dist/web/index.html` 与 `dist/web/assets/*.{js,css}`
    逐个 `zlib.gzipSync` 累加，打印每文件、首屏（`index.html` 引用的 script / modulepreload / stylesheet）与总计，总计 > 250 000 字节退出 1；
    `package.json` 加 `size:web`，接进 `ci:worker`（它本来先构建 `dist/web`）。`vite.config.ts` 加 `apply: "build"` 的小插件：解析到
    `src/{core,http,storage,runtime,cli}/` 或 `zod`、`@hono/zod-openapi`、`pkijs`、`asn1js` 即构建失败（`hono/client` 放行），把
    "web 只能 `import type` 服务端模块"变成硬检查。基线：web spike 骨架 125.7 kB JS + 9.4 kB CSS gzip（首屏约 111 kB）。
12. **清理**：旧 `@heroicons/vue`、`pinia`、`lucide-vue-next` 不进依赖；`SectionState.vue`、`pagination.ts`、`useTheme.ts` 不迁（见出口 grep）。

### 测试

全部在 vitest `web` 项目（happy-dom），除注明者外；夹具形状用 `satisfies` 对齐 `@/client/types`，不手写宽松对象。

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

### 出口条件

1. `pnpm run check` 退出 0（含 `vue-tsc -p tsconfig.web.json`、ESLint、Prettier）。
2. `pnpm exec vitest run --project web` 退出 0，上表文件齐全，`extension-blocks.test.ts` ≥ 41 例；`pnpm exec vitest run tests/http/csp.test.ts` 退出 0。
3. `pnpm run build:web && pnpm run size:web` 退出 0，打印总计 ≤ 250 000 字节 gzip；实测数字写进合并提交说明。构建插件未报服务端模块泄漏。
4. 两条运行时 SPA 兜底复验：`pnpm run ci:test`（`smoke:node` 用真实 `dist/web`）与 `pnpm run ci:worker`（createTestHarness 冒烟）通过；
   `wrangler dev` 下切片 1 的冒烟同样通过（`/crls/<uuid>` → `index.html`，`/crl/missing.crl` → 文本 404，`/api/v1/missing` → JSON 404，C12）。
5. `node scripts/ui-smoke.ts http://127.0.0.1:8080` 对 Node 运行时（fs 存储，用 CLI 从 `tests/fixtures/pki/` 导入并 `config apply`）全部 PASS；
   对 `http://127.0.0.1:8787`（`wrangler dev`，同样经 CLI 灌数据）全部 PASS。
6. `! grep -rnE "Cloudflare Workers|__SITE_NAME__|app\.title|lucide-vue-next|@heroicons|pinia" src/web package.json` 退出 0。
7. 浏览器里人工看一遍：亮 / 暗两种主题对比可读，zh-CN 下总览、两种详情、上传无英文漏翻；`pnpm verify` 全绿。

### 风险与对策

| 风险 | 对策 |
| --- | --- |
| 41 个 `extensionType` 字面量与字段名是 5a 与 5b 之间的契约 | 穷尽 switch + 测试遍历 schema 判别值；5a 之后改契约必须在同一分支里改 `extension-blocks.ts` |
| 渲染改动无测试即可满足"web 测试通过" | 出口 2 要求 ≥ 41 例，且断言无兜底块 |
| nova 风格未经 spike 验证；registry 线上漂移 | 第 1 步先生成并人工过一遍；生成文件入库，升级前 `shadcn-vue diff` |
| 体积随 Reka 组件增长 | 详情页懒加载（spike：Tabs / Accordion 落在 13 kB 的懒加载块）；超标先开 vue-i18n 特性开关（约 1.6 kB）、再预编译消息（约 6 kB） |
| `import type` 失守把 zod / hono 打进包 | `consistent-type-imports` + 第 11 步构建插件硬失败 |
| 状态阈值与 AD CS 周期冲突，徽标与统计不一致 | 末节 owner 确认；统计中的时间相关数只在客户端用同一时钟算 |
| 设了 `AIA_UPLOAD_TOKEN` 后 UI 上传不可用 | 第 7 步令牌框；401 时引导输入 |
| CSP 误伤运行时注入样式或消息编译 | 冒烟监听 `securitypolicyviolation`；按第 10 步的两条退路调整 |
| 大 CRL 详情 JSON 无上限 | 现网 0 条吊销，可接受；客户端分页避免一次渲染上千行 |
| `src/web` 下名为 `api`、`ca`、`crl`、`dcrl` 的目录会被 dev 代理吞掉（web spike） | 客户端目录固定 `src/web/client/`，评审时检查 |

### 开工前需 owner 确认

1. **CSP**。推荐：采纳第 10 步的策略，以响应头下发（`secureHeaders` 的 `contentSecurityPolicy`，两条运行时同一份），预绘制主题脚本用
   hash 放行；冒烟出现违规时只放宽 `style-src`。备选：不加 CSP，仍保留其余 `secureHeaders` 默认值与 `strictTransportSecurity: false`。
2. **状态阈值**（须在切片 5a 开工前定，切片 5a 的 owner 项指向这里）。旧 80% 规则让健康的 AD CS full CRL 每周约 24 h 显示 Stale
   （现网 full 有效约 180 h，Next CRL Publish 在约 168 h），"nextUpdate 7 天内"则几乎让所有签发 CA 的 CRL 常亮。推荐：CRL 有
   `nextPublish`（`1.3.6.1.4.1.311.21.4`）时，`now` 超过它 1 h 仍未更新才算 stale（1 h 吸收 CA 发布到助手上传的延迟）；没有时（如离线
   OpenSSL 根 CRL，半年有效）沿用 80% 规则（即剩余不足总有效期 20%）；统计条的"即将过期"改为"需关注" = stale + expired + unknown
   目标数，客户端用 `useClock` 计算，`/api/v1/stats` 不含时间相关字段；证书增加 `expiring`，阈值为剩余不足有效期的 10%（根 20 年 →
   2 年，签发 CA 10 年 → 1 年）。切片 4 的 CRL 摘要总记录 `nextPublish`，5a 列表项总带 `current.summary.nextPublish`；本项只决定徽标规则与
   `/api/v1/stats` 是否含时间字段。

## 9. 切片 6：管理补全与文档

### 目标与范围

- 补齐 plan §7.2 余下的管理路由（历史列表与下载、retire、删除证书）与 CLI（plan §7.4），并定下退役、删除的边界语义；
  这是 `§10 #23` 的切片 6 部分（import / config 已在切片 2）。
- 重写 `README.md`，新写 `docs/api.md`，补全 `docs/operations.md`（切片 4 已建"AD CS 助手"一节；两条运行时的部署、明文 HTTP 规则、HSTS 立场、AD CS 计划任务、
  令牌文件、数据目录、备份、迁移与回滚手册），记录放弃 GitHub Pages 文档站；对应 `§10 #26`。
- 分支 `slice/6-admin-docs`，评审后本地合入 `main`（仓库只有本地 git，无远端）。
- 不在本切片：`migrate-from-v2.ts`、临时历史导入路由、手册演练（见切片 7）；助手脚本本身（见切片 4）；
  状态阈值与 UI（见切片 5b）；HTTP 管理 UI（plan §1 非目标）。

### 前置

- 切片 1–5b 已合入 `main`：管理鉴权（`bearerAuth`、503 `admin_disabled`、畸形头 400）、`src/core/admin.ts` 的 `applyConfig`、
  catalog 条件写重试、CLI 骨架与退出码（切片 2）；下载与 404 表示（切片 3）；`publishCrl`、blob 键生成、错误码→状态码表、
  助手重写（切片 4）；OpenAPI 生成与漂移检查（切片 1 / 5a）。
- 下方 owner 确认已答复；未答复则按推荐默认实施。旧实现没有退役、删除、历史功能，步骤 1–7 无迁移源。

### 步骤

1. **退役状态进 catalog**（`src/core/catalog.ts`）：目标项加可选 `retired: { at, last }`（`last` = 退役时被清空的 `current`
   或 `null`），`version` 仍为 1。退役是终态（owner 确认 1 的默认）：该 UUID 不再接受上传；恢复发布 = config 里删旧目标、
   加新 UUID（同一签发者同一 kind 仍只能有一个目标，plan §5.2）。退役 UUID 重新加回 config 也仍是退役状态。
2. **`retireTarget(deps, targetId)`**（`src/core/admin.ts`）：目标既不在 config 也不在 catalog → `not_found`；已退役 → 原样返回、
   不写；否则先 create-only 写被清空 `current` 的 history 标记（格式同切片 4 步骤 6），再用切片 2 的条件写重试把 `current` 置 `null` 并写
   `retired`，返回 `{ targetId, retiredAt, previous }`
   （`previous` = `{ sha256, crlNumber, thisUpdate }` 或 `null`）。历史 blob 不动；一行日志（`msg: "retire"`）。
   catalog 有 `current` 但 config 已无此目标（跨对象竞态的残留）也允许退役，作为清理口。
3. **发布拒绝已退役目标**（改 `src/core/publish.ts`）：解析到目标后若有 `retired` → `target_not_configured`，
   `details: { targetId, retiredAt }`。检查放在切片 4 步骤 6 每次重读 state 后的目标解析里（第 5 小步）、写 blob 之前，保证零写入（M9），
   与 retire 竞态的发布也不会在退役后重建 `current`。这关掉两个缺口：退役后下一次助手上传静默 `created`，使"退役后删目标"
   被无限推迟；没有 baseline 时比退役前更旧的 CRL 也被当作 `created` 接受。
4. **历史**：`listHistory(deps, targetId)` 各 `list` 一次 `history/<targetId>/` 与 `blobs/crls/<targetId>/`；条目 = 有同名标记的 blob
   ∪ catalog 的 `current`（切片 4 步骤 6 的定义）。`thisUpdate`、`crlNumber`、`sha256` 从键名解出（键格式见切片 4 步骤 2），`size` 取自
   blob 的 `list`，`current` = 与 catalog 当前 `sha256` 相等；按 `thisUpdate` 降序、同时间按 CRL 号（BigInt）降序。不逐个读 blob 或标记
   （Workers 的子请求数与 CPU 撑不住）。解析不了的键跳过并记 warn；无标记的孤儿 blob 不列出（C8）；目标未知且两个前缀都为空 →
   `not_found`。`getHistoryBlob(deps, targetId, sha256)` 只对上述条目 `get` 其 blob，重算摘要，不等 → `internal` 并记日志（存储或恢复后的
   损坏可见）。
   - 历史的定义写进 `docs/api.md`：历史 = 曾作为 current 发布、后被取代或退役的 CRL + 当前 current + 切片 7 导入的旧版本；发布失败路径
     留下的孤儿 blob 不算历史（仍在存储里，不清扫，见切片 4）。`current: true` 表示正在发布。
5. **`deleteCertificate(deps, id)`**：不在 catalog → `not_found`。引用来源五类：`config.certificates[id]`、`config.targets[*].issuer`、
   `config.paths[*].certificate`、catalog 任一目标的 `current.verifier`、`retired.last.verifier`；命中任一 → `referenced`，
   `details.references` 列出来源（验证过已发布 CRL 的证书因此永久保留，owner 确认 2；切片 2 的 V9 保证一个目标的 current 与全部 history 标记都由
   同一签发者验证，所以这五类也覆盖历史标记里的 `verifier`）。否则条件写删 catalog 项 → 重读 config
   复核，期间出现引用则补偿写回并返回 `referenced` → 最后 `store.delete` blob。两步之间崩溃只留下无人引用的证书 blob，重新导入幂等。
6. **路由**（`src/http/routes/admin.ts`、`src/http/schemas.ts`）：全部 `Cache-Control: no-store`；鉴权与 400 / 401 / 503 沿用切片 2；
   参数 schema 复用切片 2 的 targetId 与 sha256 格式；错误码→状态码沿用切片 4 的码表；每条路由带 `operationId` 与 `summary`。

   | 路由 | 成功 | 其余失败 |
   | --- | --- | --- |
   | `GET /api/v1/admin/crls/{targetId}/history` | 200 `{ targetId, retiredAt, current, entries[] }` | 404 |
   | `GET /api/v1/admin/crls/{targetId}/history/{sha256}` | 200 DER，`application/pkix-crl`，`attachment; filename="<sha256>.crl"`，显式 `Content-Length` | 404 |
   | `POST /api/v1/admin/crls/{targetId}/retire` | 200（首次与重复同体） | 404、409 `concurrent_update` |
   | `DELETE /api/v1/admin/certificates/{id}` | 204 | 404、409 `referenced` / `concurrent_update` |

   公开 `/api/v1/crls` 不显示退役状态（`current: null` 即"未发布"）——不做，原因：按手册退役后随即从 config 删除目标。
7. **CLI**（`src/cli/aia.ts`，子命令结构与退出码沿用切片 2；只走 HTTP）：`history <targetId> [--json]`（列 thisUpdate、CRL 号、
   sha256 前 16 位、size、current）；`history <targetId> <sha256> --out <file>`（写 DER，本地重算摘要）；`retire <targetId> --yes`；
   `delete-certificate <id> --yes`（`referenced` 时打印来源）。缺 `--yes` 按用法错误退出（默认值，可推翻）。
8. **OpenAPI 与文档守卫**：`node scripts/generate-openapi.ts` 重新生成 `docs/openapi.json`。扩展 `tests/http/openapi.test.ts`（切片 1 建，
   5a 已用它接替 `worker-aia-cdp@5b570aa:redocly.yaml` 的 lint）：新路由同样要有 `operationId`、`summary` 与 bearer `security`，另加
   "4xx / 5xx 引用错误信封"。`tests/http/docs-consistency.test.ts`：生成文档的每个方法 + 路径出现在
   `docs/api.md`；`src/http/schemas.ts` 的 `ERROR_CODES` 每一项出现在 api.md 码表；`src/runtime/settings.ts` schema 的每个变量出现在
   `docs/operations.md`；CLI 子命令表（本切片从 `src/cli/aia.ts` 导出）的每个命令出现在 `README.md`。
9. **`README.md`**（中文重写，来源 `worker-aia-cdp@5b570aa:README.md`）：保留下载前缀与 `.pem` 规则（:72-80）；AD CS 前提
   （:119-121）移入 operations.md；删去 Workers Builds 部署（:28-52）、手工往 R2 `ca/` 放证书（:54-62）、v2 接口表（:82-95）、
   OpenAPI / Redoc / Pages（:97-117）。新内容：两条运行时（Node 24）、快速开始、下载 URL 与明文 HTTP、CLI 一览、部署入口、文档索引。
   "开发"一节取代 `worker-aia-cdp@5b570aa:docs/development.md`，不另设 `docs/development.md`，plan §3 文档列表不变（默认值，可推翻）：
   `.nvmrc`、OpenSSL ≥ 3.0、Docker、`pnpm run ci:*`、`.dev.vars.example`、夹具戳、不得以 root 在工作树上跑 pnpm 或容器、本地分支流程；
   丢弃其 act 一节（:99-116）与 "Recovering a partial CRL publication"（:146-167，单提交点下不存在）。
10. **`docs/api.md`**（参考 `worker-aia-cdp@5b570aa:docs/api-design-v2.md`，不迁移内容）：权威是 `GET /api/v1/openapi.json` 与
    提交的 `docs/openapi.json`，本文只写规范表达不了的：鉴权（管理令牌、可选上传令牌、503 / 401 / 400）、信封与错误码→状态码表、
    上传的两种 body 与三种结果、"导入证书不等于授权签发者，须有目标绑定"（M23）、下载语义（引用切片 3 的头与缓存规则）、
    管理流程（import → config apply → publish → retire → 删目标 → delete-certificate）、退役终态与历史定义（步骤 1–5）。
11. **`docs/operations.md`**（切片 4 已建"AD CS 助手"一节与 Windows 验证记录，本切片补全其余各节并把该节并入下表）：

    | 节 | 要点 |
    | --- | --- |
    | 部署：Workers | `wrangler login`；`wrangler secret put AIA_ADMIN_TOKEN` / `AIA_UPLOAD_TOKEN`（可选，不进 `secrets.required`）；`VITE_SITE_NAME` 取自 shell 或 `.env.production.local`；`pnpm run build:web` 后 `wrangler deploy`（`WRANGLER_SEND_METRICS=false`）；Worker 名 `aia-cdp`，绝不用 `aia-cdp-worker`；首次部署自动置备 R2 桶，交互终端会把 `bucket_name` 写回 `wrangler.jsonc`（共用旧桶与否见切片 7） |
    | 部署：Node / Docker | `docker build --build-arg VITE_SITE_NAME=…`；`docker run -v aia-data:/data -p …:8080 --read-only --cap-drop ALL --security-opt no-new-privileges`；环境变量表与 `settings.ts` 一致；健康 200（含 `degraded`）/ 503；Kubernetes 用 httpGet 探 `/api/v1/health`；一个数据目录只对应一个进程（plan §1） |
    | 明文 HTTP 与 HSTS | `/ca/`、`/crl/`、`/dcrl/` 必须明文 200：Cloudflare 不对其开 Always Use HTTPS 或重定向规则，反向代理不跳转（review §2.2 #2）；应用不发 HSTS（切片 1 的 `secureHeaders` 设 `strictTransportSecurity: false`）；推荐 PKI 主机名在边缘也不开 HSTS（HSTS 作用于整个主机名，遵守它的客户端会把明文下载升级为 HTTPS）；UI、API、上传走 HTTPS |
    | 反向代理 | 上传与管理路由的限速在代理做（plan §6）；`AIA_TRUST_PROXY` 只在 Node 前面有代理设置或追加 `X-Forwarded-For` 时打开（日志取最右一项）；代理体积上限 ≥ `AIA_MAX_UPLOAD_BYTES` |
    | 令牌 | `openssl rand -hex 32` 生成；Node 用 `AIA_*_TOKEN_FILE`，启动时读，轮换 = 换文件 + 重启；文件属主 uid 1000、`0400`、只读挂载；助手的令牌文件用 `icacls` 限权；CLI 用 `AIA_ADMIN_TOKEN_FILE`；令牌不进命令行与日志 |
    | 数据目录 | 绑定挂载须 `chown 1000:1000` 或 `--user <属主 uid>`（否则 health 503 `EACCES`）；总是显式 `-v …:/data`，避免匿名卷；不以 root 运行 |
    | 备份与恢复 | fs：先复制 `config.json`、`catalog.json`，再复制 `blobs/` 与 `history/`（blob 与标记不可变且先于 catalog 写入，快照引用的对象必在）；恢复 = 停服务 → 替换目录 → chown → 启动 → health。R2：按 owner 确认 3 的默认，操作员保存 `aia config show --json` 输出与 CA 证书文件，恢复 = import → config apply → 助手重跑或 `aia publish`，历史不能经 API 恢复 |
    | AD CS 计划任务（并入切片 4 的初稿） | `certutil -setreg CA\LogLevel 4` 后重启 CertSvc；CA 的本地 CDP 发布项写入助手的 SourceDir；任务 = 事件 68/69/70 触发 + 定时补扫、`MultipleInstances IgnoreNew`（每签发者一个发布者，`worker-aia-cdp@5b570aa:docs/architecture.md:122-124`）、运行账户对 SourceDir 与令牌文件只读、对日志与账本可写；动作 `pwsh.exe -NoProfile -NonInteractive -File …\adcs-crl-uploader.ps1 -UploadUri https://<host>/api/v1/crls -UploadTokenFile …`；参数、顺序与退出码以切片 4 的脚本为准（M24） |
    | 根 CRL | 离线 OpenSSL 签发、约半年有效；在 `nextUpdate` 前重签并 `aia publish`（review §2.2 #3）；到期提示阈值见切片 5b |
    | Worker CPU 与大 CRL | 切片 5a 的 10 000 条吊销详情构建实测；偏大时 `wrangler.jsonc` 设 `limits.cpu_ms`（旧 `limits.cpu_seconds` 是无效键），否则写明可接受的条目数上限 |
    | 退役与删除 | 先停该 CA 的计划任务 → `aia retire` → `aia config apply` 删路径与目标 → 需要时 `aia delete-certificate`；管理操作单人串行 |
    | 迁移与切换 | 前检：访问日志里 `by-keyid` / `archive` URL 是否在用（`worker-aia-cdp@5b570aa:docs/templates/migration-inventory.example.json:49-52`）、桶与历史枚举通道（C9，见切片 7）；步骤按 plan §13，切换时同时替换助手脚本并先放好令牌文件（C10）；预期头变化（同文件 `:110` 起）：ETag 加引号、新增 `Content-Length`、PEM 类型（C6）、去掉 `s-maxage` / `stale-while-revalidate`（C7）、`Last-Modified` 按切片 3（M18）、CRL `max-age` 夹紧（§10 #3）；域内机器上 `certutil -URL` 与 `certutil -verify -urlfetch` 冒烟 |
    | 回滚 | 路由指回 `aia-cdp-worker`；换回旧助手脚本与 `/api/v2/crls` 的 `UploadUri`（新助手读不了 v2 响应）；手动跑一次旧助手，补上切换窗口里只发到新服务的 CRL；旧对象从未改动 |

12. **放弃文档站**：不迁移 `worker-aia-cdp@5b570aa:.github/workflows/pages.yml`、`redocly.yaml`、`scripts/generate-docs-index.ts`，
    不装 `@redocly/cli`。原因：无远端，无从发布 Pages；redocly 给 lockfile 带进 react 19、redoc、styled-components、mobx、
    OpenTelemetry；运行时 `openapi.json` 已够用；lint 由步骤 8 的测试接替。决定记在 plan §3 的文档列表旁（步骤 13），不写进 README 与
    `docs/api.md`（出口 grep 查这两个文件里的 `Redoc`、`GitHub Pages`）。
13. **plan.md 同步**：§3 记录放弃文档站（步骤 12）、§5.3 `retired` 字段与历史的列法、§6 退役规则、§7.2 状态码列、§7.4 CLI 参数；§10 #23、#26 标为完成。

### 测试

- `tests/core/admin-retire.test.ts`（MemoryStore + 写日志 + 注入 `now`，夹具取切片 4 的 full / delta 集）：清空 `current` 并写
  `retired.last`、历史 blob 仍在；重复 retire 零写入；未知目标 `not_found`；从未发布的目标与"catalog 有 current、config 已无目标"
  都能退役；退役后上传更新与更旧的 CRL 都是 `target_not_configured` 且写日志为空（M9）；退役目标的下载路径 404；config 删旧目标、
  加新 UUID 后同一 CRL → `created`；退役 UUID 加回 config 仍被拒；竞态包装器让 retire 落在发布的读与条件写之间 → 发布被拒、`current` 为空。
- `tests/core/admin-history.test.ts`：发布 `full-01`..`full-03` 后的条目、顺序、CRL 号、摘要、size、`current`；退役后无 `current`、
  被清空的版本仍在；直接写进 blob 前缀、无标记的孤儿不列出（C8）；外来键跳过；`getHistoryBlob` 字节相等，未知摘要 `not_found`，篡改字节 → `internal`；
  已从 config 删除的退役目标仍可列。
- `tests/core/admin-delete.test.ts`：未引用 → 删除、blob 消失、重新导入 `created`；五类引用各一例 `referenced` 且带来源；补偿路径
  （包装器在 catalog 写后改 config）→ `referenced` 且 catalog 复原；重试耗尽 → `concurrent_update`。
- `tests/http/admin.test.ts`（扩展切片 2）：四条路由的状态码、信封、`no-store`、DER 下载头；无令牌 503、错令牌 401、畸形头 400；
  带有效令牌的 `GET …/retire` → 405 带 `Allow: POST`（无令牌是 401，见切片 2 同名测试）。`tests/http/openapi.test.ts`（扩展）、`tests/http/docs-consistency.test.ts` 见步骤 8。
- `tests/integration/node-e2e.test.ts`（扩展 plan §11 流程）：… retire → 下载 404 → `aia history` → 删签发者证书 409 → `config apply`
  删目标后仍 409（verifier 保护）→ 删一张无关证书 204 → `history … --out` 的字节摘要与条目一致。

### 出口条件

- `pnpm verify` 全绿。
- `pnpm run ci:check && pnpm run ci:test && pnpm run ci:worker && pnpm run ci:docker` 本地全绿。
- `pnpm exec vitest run tests/core/admin-retire.test.ts tests/core/admin-history.test.ts tests/core/admin-delete.test.ts
  tests/http/openapi.test.ts tests/http/docs-consistency.test.ts` 全绿；`node scripts/generate-openapi.ts --check` 无漂移。
- 每个职责只有一个实现：`grep -rn "storage/" src/cli` 无输出（CLI 只走 HTTP）；`grep -rnE "store\.(put|delete)\(" src/http src/runtime src/cli`
  无输出（写入只在 `src/core`）。
- 文档无旧口径：`grep -nE "Node 22|node:22" README.md docs/api.md docs/operations.md` 与
  `grep -nE "api/v2|Workers Builds|Redoc|GitHub Pages" README.md docs/api.md` 无输出（operations.md 的回滚节必须提 `/api/v2/crls`）。
- 在临时目录 `git clone` 本仓库，照 README 快速开始走到 `/api/v1/health` 返回 200。
- 照 operations.md 备份节对 Docker 部署做一次：备份 → 删容器与卷 → 新卷恢复 → health `healthy`，任一下载路径的 `sha256` 与备份前相同。
- `slice/6-admin-docs` 评审后本地合入 `main`。

### 风险与对策

| 风险 | 对策 |
| --- | --- |
| 退役改为终态，与 plan 原文"清空 current 后可继续上传"不同；误退役要改 config | owner 确认 1；`details.retiredAt` 让助手日志与 CLI 直接看出原因；api.md 与手册写恢复步骤 |
| config 与 catalog 分别条件写，retire / 删除证书与 `applyConfig` / 发布交错 | 发布在重试循环里复查退役；删除先删 catalog 项再复核 config、可补偿；残余窗口（`applyConfig` 在复核之后才落盘）靠手册"管理操作单人串行" |
| 历史不分页：delta 约 1.5 天一张，单目标每年约 250 条 | 规模内一次返回；r2 `list` 的 1000 条翻页由切片 1 一致性测试覆盖 |
| 已验过 CRL 的证书被永久锁住，误导入的签发者证书无法清理 | 本版不做 tombstone 清除；owner 确认 2 |
| 文档再次与代码漂移（§10 #26 的成因） | OpenAPI 漂移检查 + docs-consistency 测试 + 出口 grep |
| 计划任务、边缘 HSTS、Always Use HTTPS 都在仓库外，文档可能与现实不符 | owner 确认 4、5；未核对项在 operations.md 标"未核对"；切片 7 的 CryptoAPI 冒烟再验 |
| R2 无对象级备份，wrangler 4.151.1 也不能列对象 | owner 确认 3；手册写明恢复后历史缺失 |

### 开工前需 owner 确认

1. 退役语义。推荐：终态，退役 UUID 的上传一律 `target_not_configured`，恢复发布用新 UUID。备选：保留 baseline（只接受比退役前
   更新的 CRL 并重建 `current`，"退役后删目标"仍会被助手上传打断）；或按 plan 原文清空即重置（更旧的 CRL 也会 `created`）。
2. 证书删除保护。推荐：被任一 `current` 或 `retired.last` 作为 `verifier` 的证书永不可删（本版无 tombstone 清除）。
   备选：`--force` 允许删除，相关历史从此无法复验。
3. R2 备份。推荐：不申请 R2 S3 令牌（保持决策 3 的连带结论），只备份 config 与 CA 证书文件，接受历史丢失。备选：S3 令牌 + rclone 定期镜像。
4. AD CS 计划任务的现实配置：请在两台签发 CA 上用 `Export-ScheduledTask` 导出现有任务（事件 68/69/70 所在日志与来源、补扫间隔、
   运行账户）作为 operations.md 的依据。推荐：拿不到时按模板写并标"未核对"。
5. pki.acha.top 在 Cloudflare 上的 HSTS 与 Always Use HTTPS 现状（review §1 只证实明文 200、无 301）。推荐：该主机名两者都保持关闭。

## 10. 切片 7：迁移

### 目标与范围

把 pki.acha.top 从旧 Worker `aia-cdp-worker`（线上跑旧仓库 `main` = `worker-aia-cdp@0ea3130`，下文称 Gen B）切到新服务：下载 URL 返回的 DER 不变（决策 7），旧对象不删，随时可回滚。交付物：

- `scripts/migrate-from-v2.ts`（入口，`parseArgs` 子命令 `inventory` / `plan` / `apply` / `verify`）与 `scripts/migrate-v2/*.ts`（纯逻辑，可单测）；用 Node 24 直接运行（B3），复用 `src/core/pki` 解析验签与 `src/cli` 的 HTTP 客户端函数。
- 仅迁移期存在的 `POST /api/v1/admin/crls/{targetId}/history`（切换后删除）。
- 非生产演练记录、生产切换（含 AD CS 助手替换与令牌）、`docs/operations.md` 迁移与回滚章的实测版（骨架见切片 6）。

plan §13 的两个前提在本切片修正：历史迁移是**尽力而为**，不是确定性的（C9：线上归档是 Gen A/B，无摘要、同名覆盖，§14 #9 描述的 Gen C 键从未部署）；"只是两个 HTTP 客户端" 改为 "HTTP 客户端 + 本地解析验签"，盘点通道见 owner 确认 1。

不做：按任何一代派生规则重算 URL（线上 `/dcrl/AchaIssuingCA02.crl` 不符合任何规则，URL → 签发者只能来自盘点）；Gen C 归档解析；旧对象清理（owner 在稳定期后手工做，见步骤 12）。

### 前置

- 切片 1–6 已合并：管理接口（导入、config、history 列表）、`POST /api/v1/crls`、下载、`aia` CLI、切片 4 改写的 `scripts/adcs-crl-uploader.ps1`（含 `-UploadTokenFile`）、`docs/operations.md` 骨架。
- 切片 2 的严格解析（M1），切片 4 的策略检查与 `src/core/pki/verify.ts`（`verifyWithPublicKey`，B21）；切片 5a 的扩展解析器（要读 AIA、CDP、Freshest CRL、CRL Self CDP `.21.14` 里的 URL）；切片 2 的路径规则（M17）；切片 4 步骤 2 的 blob 键格式与步骤 6 的 history 标记（C8）。
- owner 确认 1–3 已答复；旧桶实名已用 `wrangler r2 bucket list` 查到并记录（按 wrangler 自动置备的命名规则推测为 `aia-cdp-worker-store`，未核实）。
- 一台入域 Windows 机器（CryptoAPI 冒烟），以及 CA 主机 Task Scheduler 的操作权限。

### 步骤

旧桶键布局速查（全部在 `ca/`、`crl/`、`dcrl/` 下，与新布局 `config.json` / `catalog.json` / `blobs/` / `history/` 不相交）。键名与 custom metadata 只用来探测和取证，**不参与归属**：

| 代 | 时期 | canonical 键 | 归档键 | 陷阱 |
| --- | --- | --- | --- | --- |
| A | `4ec9be5`（2025-09-16）… `40c0366` 之前（2026-04-12） | 硬编码：CN 含 `Issuing` 一律 `<folder>/AchaIssuingCA01.crl`（CA02 亦然），否则 `AchaRootCA.crl` | `<folder>/archive/<CN 去掉 [^\w.-]>-<crlNumber>.crl`，如 `AchaIssuingCA02RSA-…`、`AchaRootCAECC-…` | 名字里的 CA 未必是字节的签发者；同名覆盖 |
| B（线上） | `40c0366` … `0ea3130`（`main`） | 根级 metadata 扫描保留已有键，否则 `<folder>/<证书键去 ca/ 与扩展名>.crl` | `<folder>/archive/<同上，如 AchaIssuingCA01_RSA-4096>-<crlNumber>.crl`（`worker-aia-cdp@0ea3130:src/worker/pki/crls/issuers.ts:249`） | 无摘要，同名覆盖；归档的 metadata 描述的是**新上传**的那份 |
| C | `3e58fba` 起，只在分支 `parsing-2026-10-18`（含 `5b570aa`），从未部署 | — | `<folder>/archive/<logicalBase>-<crlNumber>-<sha256>.crl` | 线上不存在 |

另有 `crl|dcrl/by-keyid/<AKI 小写 hex>.crl`（每次上传无条件写的当前副本）与伴随 PEM `*.crl.pem`、`ca/*.crt.pem`（Gen B 存上传原文，字节可与派生 PEM 不同）。没有 CRL 号时，归档名的号段换成 `<sha256 前 16 位>`。

1. **盘点（只读）**：`node scripts/migrate-from-v2.ts inventory --source https://pki.acha.top --channel http|r2 --out .migration/<date>/inventory.json`。每个对象记录键、字节数、sha256（r2 通道另记 etag、uploaded），字节存为 `.migration/<date>/objects/<sha256>`。`.migration/` 写进 `.gitignore`（D7：线上工件不入库），由 owner 留存作迁移证据。
   - `http` 通道（推荐）：`GET /api/v2/certificates?limit=100` 与 `/api/v2/crls?limit=100` 拿根级键。列表项的 `id` 就是对象键（`worker-aia-cdp@0ea3130:src/worker/api/v2/crls/list.ts:73`）；不按 `hasMore` 翻页（线上 `hasMore: true` 但 `nextCursor: null`）。然后：每个 canonical 键探 `<key>.pem`；每个当前 CRL 按 AKI 探 `by-keyid`；归档名逐号探测，名字集由盘点到的证书键（Gen B）与证书 CN（Gen A）生成，线上应为 `AchaIssuingCA01_RSA-4096`、`AchaIssuingCA02_RSA-4096`、`AchaRootCA_ECC-P384`、`AchaIssuingCA01RSA`、`AchaIssuingCA02RSA`、`AchaRootCAECC`，号段取 1 到当前最大 CRL 号：2026-10-18 的线上工件里 CA01 是 255、CA02 是 237（AD CS 的 full 与 delta 共用一个号段），根是 4097。签发 CA 的 4 个名字在 `crl/`、`dcrl/` 两个目录都探 1–255（Gen A 可能把一个 CA 的字节放在另一个 CA 的名下，所以不按 CA 分号段）；根的 2 个名字只探 `crl/` 的 1–4097，owner 若知道根 CRL 号的起点可以缩短。先 HEAD，命中再 GET。旧下载路由对前缀下任意键都返回对象（`worker-aia-cdp@0ea3130:src/worker/worker.ts:46-61`，§10 #2），所以归档能经 HTTP 取到。请求串行，每秒不超过 10 次，总量约 1 万次 HEAD，约 17 分钟。
   - 对账：拿结果与 `GET /api/v2/stats` 比。Gen B 把 `crl/`、`dcrl/` 下所有 `.crl` / `.crl.pem`（canonical、PEM、by-keyid、归档）都计为 CRL，`storage.byPrefix` 是各前缀的字节和（`worker-aia-cdp@0ea3130:src/worker/api/v2/stats.ts:40-71`）。数量和字节都对上，盘点即完整；有差额就写进报告，再用 `r2` 通道补一次完整列表。
   - `r2` 通道：独立配置 `scripts/migrate-from-v2.wrangler.jsonc`（`r2_buckets: [{ binding: "LEGACY", bucket_name: "<旧桶实名>", remote: true }]`），加 `getPlatformProxy({ configPath, remoteBindings: true })`，需要 `wrangler login`。wrangler 4.151.1 的 schema 接受 `remote`，`getPlatformProxy` 有 `remoteBindings`（默认 `true`），这两点已查类型，但没有对真实账号实测，开工先跑一次 `list` 验证。绑定包成只暴露 `list` / `get` / `head` 的对象，脚本里没有写路径。
   - 注意：线上 `GET /api/v2/certificates` 会顺手 create-only 写 `ca/*.pem`（`worker-aia-cdp@0ea3130:src/worker/api/v2/certificates/list.ts:56-58`）。盘点因此不是严格零写，但不改动已有对象，记入报告。
2. **归属（只按字节）**：`plan --inventory … --out .migration/<date>/plan.json`，纯函数、无网络。`worker-aia-cdp@5b570aa:src/worker/r2/crls.ts` 只作旧语义参考（reference-only），不复用它的派生规则。对每个对象：
   - 按内容识别 PEM / DER（M7），PEM 解码后按 DER sha256 去重；证书走切片 2 的严格解析，CRL 走切片 4 的解析与策略检查。
   - 按 AKI 找 SKI 相等的候选证书（可能不止一张，M5），逐个 `verifyCrlSignature`，验过的就是签发者；多张都验过（同钥续期）时取证书 id 字典序最小者，
     `--reuse` 时优先 plan 里已是该目标签发者的那张，保证同一 AKI 的 current 与历史归到同一目标。
   - kind 由 delta 指示决定；与所在目录（`crl/` / `dcrl/`）不符的记为发现项。
   - 分类：`current`（根级 canonical）、`alias`、`archive`、`pem`、`unattributed`（没有签发者能验过）、`invalid`（严格解析拒绝，例如畸形时间或缺 AKI，M1 / M3）。
3. **生成配置**（同一个 `plan.json`）：
   - 证书：每个旧 DER 键 `/ca/<path>` 一条路径，`.pem` 键变为自动派生变体；只有 PEM 的证书补一条 DER 路径，并在报告里标出。
   - 目标：每个有根级 canonical CRL 的（签发者 sha256, kind）分配一个 UUID。没有 canonical CRL 的签发者不配目标（M23）。
   - 路径：每个 canonical 键一条，同一目标的多个旧名都指向它；label 取签发者 CN。
   - 所有路径必须通过切片 2 的路径规则（字符集，M17），不通过就停下。
   - **URL 交叉核对**：从全部证书的 AIA / CDP、全部 CRL 的 Freshest CRL 与 CRL Self CDP 里抽出 `http://pki.acha.top/` URL。每条都必须命中路径表，且命中目标的签发者必须等于含这条 URL 的证书或 CRL 所属的 CA。不一致（Gen A 把 CA02 的字节写进 CA01 名下即属此类）就停下，交 owner 判断。
   - UUID 写进 `plan.json` 后就固定：重跑 `plan --reuse` 读回已有 UUID，否则配置会漂移。
   - `by-keyid` 与 `archive` URL 默认不进路径表，步骤 8 查完访问日志再定。
   - owner 在 `apply` 之前审阅 `plan.json` 与报告。
4. **历史集与报告**：每个目标的历史集取归属到它的 `archive`、`alias`、`pem` 与旧 canonical 对象，按 sha256 去重、去掉 current，再按（CRL 号 BigInt, `thisUpdate` 时刻）排序（M15）；号相同而字节不同的两份都保留并标出。报告 `.migration/<date>/report.md` 写明每个目标找到、将导入、重复、`unattributed`、`invalid` 的数量，每个签发者号段里缺失的号（full 与 delta 合并看），并说明 Gen A/B 同名覆盖掉的版本已不可恢复（§10 #6）。预期导入数少于 stats 的对象数。
5. **临时历史导入路由**：新文件 `src/http/routes/admin-history-import.ts`（`createApp` 里一行挂载），加上 `src/core/admin.ts` 的 `importHistory(deps, targetId, bytes)`。语义：
   - 需要管理令牌；body 是原始 `application/pkix-crl`；复用 publish 的解析、策略检查与验签。
   - 签发者判定同切片 4 步骤 6 的第 5 小步：候选 = catalog 中 `subjectKeyId` 等于 AKI 的证书；无候选 → `issuer_not_found`；该目标配置的签发者不在候选中 →
     `issuer_mismatch`（plan §6 的含义，C5）；否则用配置的签发者验签。同钥续期时几张证书共用 SKI，"AKI 解析到哪张"没有唯一答案，所以只问"配置的签发者在不在候选里"。
     kind 也必须一致。
   - 按切片 4 步骤 5 的新鲜度不早于 current 的，返回 409 `conflict`（`details.reason: "not_older_than_current"`），这种 CRL 应走正常发布。
   - blob 键与 publish 相同（`crlBlobKey`，切片 4 步骤 2），`put` 带 `ifNoneMatch: "*"`，再 create-only 写同名 history 标记（体与切片 4 的
     标记同形，`supersededAt` 换成 `importedAt`）：两者都已存在返回 200 `unchanged`，否则 201 `created`。**不读写 catalog 的 current**，
     除上一条外不做新鲜度判断。
   - 路由进 OpenAPI，漂移检查照常。不加额外开关，暴露窗口靠步骤 11 删除收口。
   - 导入的版本从来不是 current，靠标记出现在 history 列表里（切片 6 步骤 4）；没有标记的孤儿 blob 仍不出现。
6. **应用**：`apply --plan plan.json --target <新服务 URL>`，令牌读 `AIA_ADMIN_TOKEN(_FILE)` 与 `AIA_UPLOAD_TOKEN(_FILE)`。
   - 前置检查：新服务 `GET /api/v1/health` 的 `checks.configuration` 为 `missing`，或现有 config 与 plan 一致（重跑的情况）。
   - 顺序：逐张 `POST /api/v1/admin/certificates` → `PUT /api/v1/admin/config`（首次带 `If-None-Match: *`，重跑带 `If-Match`）→ 每个 current 一次 `POST /api/v1/crls`（首次期望 `created`，重跑为 `unchanged` 或 `updated`）→ 按步骤 4 的顺序逐条 `POST …/history`。
   - 写 catalog 的调用之间至少间隔 1.1 s。R2 对单键每秒只允许一次写，超限报的不是 precondition-failed，会变成 500（见切片 2 风险）。
   - 整个过程幂等，可以反复跑。
7. **校验**：`verify --plan plan.json --old <URL> | --snapshot <inventory.json> --new <URL>`。
   - 路径表里每条 DER 路径两边各 GET 一次，比较 sha256。CRL 路径上，新服务的 CRL 若同一签发者签发且按切片 4 步骤 5 更新，记为 `advanced`，也算通过。
   - `.pem` 变体只比较解码后的 DER（Gen B 的 PEM 字节不同不算失败）。
   - 每个目标 `GET /api/v1/admin/crls/{id}/history` 返回的 sha256 集合必须等于 plan 的历史集加 current。
   - 扩展解码核对（§10 #27；D7 后真实 AD CS 字节的唯一回归）：对每张导入的证书与每个 current CRL 调 `GET /api/v1/certificates/{id}`、`/api/v1/crls/{id}`，
     断言没有扩展带解析错误或只回落为 ASN.1 dump，且 CA Version、证书模板名、Next CRL Publish、CRL Self CDP 都已解码；结果写进 `report.md`。
   - 重跑 URL 交叉核对。退出码 0 / 1。
8. **演练（非生产，按顺序）**：
   - 演练 A（Node + fs）：`AIA_DATA_DIR=$(mktemp -d)`，`node --enable-source-maps dist/server/runtime/node.js`，对线上源站只读地跑步骤 1–7。清空目录再跑一次；在已导入的目录上第二次 `apply`，结果全部是 `unchanged`。
   - 演练 B（Workers）：`wrangler.jsonc` 加 `env.rehearsal`（Worker `aia-cdp-rehearsal`；`r2_buckets` 不继承，要在 env 里重写，自动置备新桶），`wrangler deploy --env rehearsal`，经 workers.dev 地址跑步骤 6–7。再对 `GET /api/v1/crls` 与一条下载路径各计时 20 次取中位数（切片 5a 留下的 R2 真实延迟），
     据此定 plan §5.6 的备忘开不开，结果写进 operations.md 迁移章。结束后 `wrangler delete --env rehearsal`；演练桶在 dashboard 清空后删除，或留给下一次演练。
   - 演练 C（CryptoAPI）：在内网主机用 Docker 镜像起服务（`-p 80:8080`，数据来自演练 A）。测试用入域 Windows 机在 hosts 里把 `pki.acha.top` 指过去，跑步骤 10 的冒烟；再用改写后的助手把 CertEnroll 里的当前文件传给这台主机，期望 `unchanged`。最后把 hosts 改回，用 `certutil` 再验一次旧站，这就是回滚演练。
   - 日志核对（`by-keyid` / `archive` URL 是否保留，§10 #2）：在旧 Worker 的 Workers Logs（旧配置已开 `observability.logs.enabled`）里查近 30 天的 `/crl/by-keyid/`、`/dcrl/by-keyid/` 与 `/archive/` 请求。有真实客户端在用，就给对应 URL 加路径条目（§5.2 允许）；否则这些 URL 切换后返回 404。
   - 演练结果（时间、命令、输出摘要）写进 `docs/operations.md` 的迁移章。
9. **生产切换**（按 owner 确认 2、3 的推荐写）：
   1. 记录回滚基线：`wrangler deployments list --name aia-cdp-worker` 的输出，以及 dashboard 里 pki.acha.top 当前的绑定方式（自定义域还是路由）。旧 `wrangler.jsonc` 没有 `routes`，绑定是在仓库外配的；新 `wrangler.jsonc` 也不写 `routes`，免得 `wrangler deploy` 抢走域名。Worker 名是 `aia-cdp`，绝不用 `aia-cdp-worker`（B6）。
   2. 用 `openssl rand -hex 32` 生成两枚令牌，`wrangler secret put AIA_ADMIN_TOKEN` 与 `AIA_UPLOAD_TOKEN`；`wrangler deploy`；经 workers.dev 地址跑 `apply` 和 `verify --old https://pki.acha.top`。
   3. 准备 CA 主机：新助手放进旁路目录；令牌文件用 `icacls` 设成只有任务账户能读；保留旧脚本和旧任务动作的副本，供回滚。CertEnroll 里应只有当前文件，否则助手首跑可能遇到 `stale_crl` 而退出 1（plan §9）。
   4. 冻结：禁用 AD CS 上传计划任务，然后重跑 `apply` 和 `verify`，追平冻结前新发布的 CRL。
   5. 切域：在 dashboard 把 pki.acha.top 从 `aia-cdp-worker` 移到 `aia-cdp`。切换期间每秒跑一次 `curl -s -o /dev/null -w '%{http_code}' http://pki.acha.top/crl/AchaRootCA.crl`，记下不可用时长。
   6. 替换助手（C10）：旧脚本只把含 `$resp.data.id` 的响应当成功（`worker-aia-cdp@5b570aa:scripts/adcs-crl-uploader.ps1:240-249`），v1 的每次上传都会被记成失败，所以只改 `UploadUri` 不够，必须换脚本（改写本身在切片 4，§10 #20；这里只安装）。任务动作改为 `-UploadUri https://pki.acha.top/api/v1/crls -UploadTokenFile <file>`。先手动跑一次，期望结果 `unchanged` 或 `updated`、退出码 0（按 LastWriteTimeUtc 从旧到新，M24），再启用任务。
   7. 跑步骤 10 的冒烟；在 UI 打开总览和 5 个 CRL 目标的详情。
   8. 观察：下一次 AD CS 定时发布后，助手日志应出现 `updated`，`GET /api/v1/crls` 里的 CRL 号前进。根 CRL 的 `nextUpdate` 是 2026-11-07 00:00 UTC，换发后用 `aia publish` 发到新服务。
10. **CryptoAPI 冒烟**：证明 C6、C7、C13、M18 和 §10 #1/#3 带来的头部变化不影响真实客户端。
    - 在入域机上先 `certutil -urlcache * delete`，再对两张签发 CA 证书和一张由它们签发的终端证书各跑 `certutil -verify -urlfetch <file>.cer`。AIA 证书、CDP 的 full CRL、Freshest CRL 的 delta，每条都应为 `Verified`。
    - `certutil -URL http://pki.acha.top/crl/AchaRootCA.crl`（URL Retrieval Tool）核对检索状态。
    - `curl -sI http://…` 检查：200、没有 `Location`、没有 `Strict-Transport-Security`（B8；Cloudflare 的 "Always Use HTTPS" 不得覆盖下载前缀）、ETag 带引号、有 `Content-Length`、CRL 的 `max-age` ≤ 3600；带 `If-None-Match` 请求返回 304。
    - 所有输出存档。
11. **删除临时路由**：切换稳定、`verify` 通过后，在分支 `slice/7-cleanup` 删除 `admin-history-import.ts`、它的挂载行、`importHistory` 及其测试，以及 `ERROR_CODES` 中只剩它在用的 `issuer_mismatch`
    （切片 4 步骤 7），重新生成 `docs/openapi.json`，再部署。
12. **回滚手册**（写进 `docs/operations.md`，演练 C 验证过）：
    - 操作：dashboard 把域名移回 `aia-cdp-worker` → 任务动作和脚本换回旧副本 → 手动跑一次旧助手（旧服务对相同字节返回 409，是已知旧行为，无害）→ 切换窗口内只发到新服务的根 CRL，经旧 UI 重传。
    - 推荐方案下新服务用独立的桶，旧对象从来没被写过，回滚不需要修数据。
    - 保留期：旧 Worker 和旧桶保留到两张签发 CA 各走完一个 full CRL 周期（约 8 天），且根 CRL 已在新服务换发。之后由 owner 手工删除：独立桶方案删旧 Worker 和整个桶；共享桶方案只删 `ca/`、`crl/`、`dcrl/` 三个前缀。

### 测试

- `tests/integration/migrate-classify.test.ts`（归 `integration` 项目，B15 不新增项目）：用 fixture 脚本生成的合成 CRL（D7，不用线上工件）拼一个假旧桶，覆盖：Gen A 名下放的是另一个 CA 的字节；Gen B 同名覆盖；字节不同的 `.crl.pem`；与 current 相同的 `by-keyid`；没有签发者能验过的 CRL；畸形时间的 CRL；没有 AKI 的 CRL；同一 SKI 的两张证书只有一张验得过；放在 `crl/` 下的 delta。断言分类、归属、历史集排序、URL 交叉核对的失败路径，以及 `--reuse` 下 UUID 稳定。
- 探测名生成：给定证书键和 CN，产出上表的名字集（Gen A 去字符；Gen B 去掉 `ca/` 前缀和扩展名）。
- `tests/http/admin-history-import.test.ts`：无令牌 401、未配置令牌 503；签发者不对 `issuer_mismatch`、坏签名 `invalid_signature`、不早于 current 409；
  另导入 `issuing-ca-1-renewed`（与目标签发者 `issuing-ca-1` 共用 SKI）后，`issuing-ca-1` 签发的旧 CRL 仍 `created`，不是 `issuer_mismatch`；重复导入 200 `unchanged`；成功后 `catalog.json` 的 store ETag 不变，history 列表多一条。
- `tests/integration/migrate.test.ts`：测试里起一个只读的假 v2 源（列表项按 `worker-aia-cdp@0ea3130` 的形状返回 `id`，下载前缀返回任意键），新服务用临时目录 fs。依次跑 `inventory --channel http` → `plan` → `apply` → `verify`，再跑一次 `apply`，结果全部是 `unchanged`。

### 出口条件

- 在 `slice/7-migration` 和 `slice/7-cleanup` 上 `pnpm verify` 都通过（D3，以本地脚本为准）。
- 切换后，`node scripts/migrate-from-v2.ts verify --plan … --snapshot .migration/<date>/inventory.json --new https://pki.acha.top` 退出 0：每条 URL 返回与旧 URL 相同的 DER sha256，或标为 `advanced`。
- `report.md` 已经 owner 审阅，包括每个目标的导入数、`unattributed` / `invalid` 清单和不可恢复说明。
- 旧对象未删：`inventory --compare <切换前 inventory.json> --source <旧 Worker 的 workers.dev 地址>` 退出 0（旧 Worker 没开 workers.dev 时改用 `--channel r2`）。
- 回滚：演练 C 的记录已写进 `docs/operations.md`；`wrangler deployments list --name aia-cdp-worker` 与步骤 9.1 的基线一致。
- CryptoAPI 冒烟输出已存档，全部 `Verified`，`curl -sI` 的各项检查都通过。
- 助手：切换后第一次定时运行的日志为 `updated` 或 `unchanged`、退出码 0，Task Scheduler 历史里没有失败。
- 扩展解码核对（步骤 7）在演练 A 与生产切换后都通过，结果在 `report.md`（§10 #27、D7）。
- 临时路由已删除：`curl -s -o /dev/null -D - -H "Authorization: Bearer $(cat <管理令牌文件>)" -X POST https://pki.acha.top/api/v1/admin/crls/<id>/history`
  返回 405 且带 `Allow: GET, HEAD`（GET 路由仍在，B7；不带令牌时 `bearerAuth` 先回 401，看不出路由是否已删）；`node -e 'process.exit(require("./docs/openapi.json").paths["/api/v1/admin/crls/{targetId}/history"].post ? 1 : 0)'` 退出 0；`grep -rn importHistory src tests` 没有输出。

### 风险与对策

- 根 CRL 2026-11-07 00:00 UTC 过期：切换避开换发日。11-07 前切不了，就先在旧站换发，迁移时自然带过来。
- 归属与 URL 名不一致（Gen A 遗留）：步骤 3 停下，不自动映射。
- 历史本来就不完整（§10 #6）：报告写明，不做补救。
- 严格解析拒绝旧对象：只进报告。被拒的若是 current，切换阻断，交 owner；可能是切片 4 的策略过严。
- `getPlatformProxy` 的 `remoteBindings` 默认 `true`：主 `wrangler.jsonc` 永远不写 `remote: true`，否则一致性测试（B14）会直接写生产桶。r2 通道只用独立的配置文件。
- `aia-cdp` 若在切片 1–6 期间部署过，自动置备的 `aia-cdp-store` 里可能留有测试数据：`apply` 的前置检查要求 `configuration: missing`，不满足就先清桶。
- 令牌：只走 `wrangler secret` 和 `_FILE`，不进命令行和日志（plan §9）。
- 客户端缓存：CryptoAPI 缓存 CRL 到 `nextUpdate`，问题可能几天后才暴露。冒烟前先清 URL 缓存；切换后一周内每天看一次 Workers Logs 的 4xx/5xx。
- 切域时可能短暂不可用：放在 delta 刚发布之后做（delta 约 1.5 天有效，余量充足），并记下不可用时长。
- 探测给旧站的负载：约 1 万次 HEAD，串行限速，可以忽略。

### 开工前需 owner 确认

| # | 问题 | 选项 | 推荐 |
| --- | --- | --- | --- |
| 1 | 历史枚举通道（C9） | (a) 新 Worker 加临时路由，经共享的 `STORE` 列旧前缀（要求共享桶，读旧布局的代码进生产 Worker）；(b) R2 S3 API 令牌一次性列表（另需 S3 客户端与令牌管理）；(c) `getPlatformProxy` 远程 R2 绑定（需 `wrangler login`，未实测）；(d) dashboard 手工导出；(e) 只用 HTTP 探测可预测的 Gen A/B 归档名，再与 stats 对账 | (e) 为主，对账不平时用 (c) 补差：保住 §13 的 "不碰 R2"，且不需要凭据 |
| 2 | 是否共享旧 R2 桶（`bucket_name`） | (a) `aia-cdp` 设 `bucket_name` 为旧桶实名；(b) 不设，自动置备 `aia-cdp-store`（B6 默认）；(c) 复用旧 Worker 名 `aia-cdp-worker` | (b)：迁移走 HTTP，不需要共享；旧桶零写入，回滚没有数据风险，日后删整个桶即完成清理。(c) 不做：B6 规定不用旧名，否则会覆盖线上 Worker，回滚也变成 `wrangler rollback`。只有第 1 项选 (a) 时才必须共享 |
| 3 | AD CS 助手切换方式与上传令牌 | (a) 在冻结窗口内替换脚本（步骤 9）；(b) 切换前加第二个计划任务，并行发往新 Worker 的 workers.dev 地址，切域后停用旧任务。令牌：启用或不启用 `AIA_UPLOAD_TOKEN` | (a)：规模小、窗口短，CRL 文件在 CertEnroll 里等着就行。启用令牌（§10 #19），UI 上传用切片 5b 步骤 7 的令牌框 |

## 11. 切片 8：S3（按需）

### 目标与范围

为 Node 多实例部署提供共享存储：`src/storage/s3.ts` 用 `@aws-sdk/client-s3` 实现 plan §5.4 的端口（plan §2 记录的版本是 3.1152.0，开工时用 `npm view` 复核）；`AIA_STORE=s3`；对 MinIO 跑一致性测试，本地 `pnpm run ci:s3`，CI 里是可选任务；`docs/operations.md` 加多实例一章。只有 owner 确认 1 选"做"才开工。

不做：Worker 走 S3（Workers 只用 R2 绑定）；分段上传（对象都在 KB 级，单次 PutObject 就够）；多个进程共享一个 fs 目录（仍是非目标，plan §1）；把 R2 的 S3 端点列为受支持后端（未验证）。

### 前置

- 切片 1 的一致性套件（D5）能按适配器参数化；切片 2 的 catalog 条件写重试；切片 5a 对 §5.6 备忘的决定；切片 6 的 `docs/operations.md`。
- 本机有 Docker（跑 MinIO 容器）。

### 步骤

1. `src/runtime/settings.ts`：`AIA_STORE` 枚举加 `s3`，校验失败即退出 1（B13）。新增变量（默认值，可推翻）：`AIA_S3_BUCKET`（`s3` 时必填）；`AIA_S3_ENDPOINT`（不设即 AWS）；`AIA_S3_REGION`（默认 `us-east-1`）；`AIA_S3_PREFIX`（键前缀，默认空，测试用随机前缀隔离）；`AIA_S3_FORCE_PATH_STYLE`（设了 endpoint 时默认 `true`，MinIO 需要）；`AIA_S3_ACCESS_KEY_ID(_FILE)` / `AIA_S3_SECRET_ACCESS_KEY(_FILE)`（都不设就走 SDK 的默认凭据链）。
2. `src/storage/s3.ts`（约 100 行，没有旧实现可迁）。构造函数接收一个 `{ send(command) }` 形状的客户端，方便单测注入。端口方法的映射：

   | 端口方法 | S3 调用 | 映射规则 |
   | --- | --- | --- |
   | `get` | `GetObjectCommand` | `NoSuchKey` → `null`；字节用 `Body.transformToByteArray()` |
   | `head` | `HeadObjectCommand` | 404 → `null` |
   | `put` | `PutObjectCommand` | `ifMatch` → `IfMatch`，`ifNoneMatch` → `IfNoneMatch: "*"`；HTTP 412 → `{ ok: false, reason: "precondition-failed" }`；并发冲突的 409（AWS 记为 `ConditionalRequestConflict`）同样映射，交给 catalog 重试重读 |
   | `list` | `ListObjectsV2Command` | 按 `NextContinuationToken` 翻页（每页 ≤ 1000），去掉 `AIA_S3_PREFIX` |
   | `delete` | `DeleteObjectCommand` | — |

   ETag 规则：S3 返回带引号的值，适配器原样保存、原样回传给 `IfMatch`，不剥引号也不解析（R2 正相反，必须不带引号，B14）。只用单次 PutObject，不会出现多段 ETag。store ETag 永远不当作 HTTP ETag（§5.4）。
3. `src/runtime/node.ts` 按 `AIA_STORE` 选择适配器；`s3` 时用 `await import("../storage/s3.ts")` 加载，fs 部署不加载 SDK。健康检查不变（切片 2 步骤 7 的实现）。
4. Worker 隔离：`tsconfig.worker.json` 不包含 `s3.ts`，Worker 图里没有任何文件引用它。plan §3 不设 bundle 卫生断言，这里破例加一条最小检查（默认值，可推翻；与切片 1 开工前需 owner 确认第 1 项的 dry-run 断言同一做法）：`ci:worker` 在 dry-run 之后执行 `! grep -q "@aws-sdk" dist/worker/worker.js.map`。查 source map 的 `sources` 而不是正文，因为 `minify: true` 之后正文里不一定还留着包名；cloudflare spike 已确认 dry-run 会写出 `worker.js.map`，且 `sources` 列出 `node_modules` 路径。理由：SDK 一旦被拉进 Worker 包，问题要到部署时才会暴露。
5. 依赖：`@aws-sdk/client-s3` 放进 `dependencies`，因为 Docker 的生产依赖阶段需要它（B18）；用 `docker image ls` 记录镜像大小的变化。
6. 一致性：`tests/storage/s3.test.ts` 复用共享套件，`describe.skipIf(process.env.AIA_TEST_S3 !== "1")`。
   - S3 专属用例：N 个并发 `ifMatch` 写只有一个成功（与 R2 spike 相同）；带引号 ETag 的往返；超过 1000 个键的翻页（慢，单独标记）。
   - 两条既有用例兼作探针：`ifNoneMatch` 撞上已存在的键、过期的 `ifMatch` 都必须失败。服务端若忽略条件头，套件就会失败。
   - `pnpm run ci:s3` 的流程：`docker run -d --rm -p 9000:9000 -e MINIO_ROOT_USER=… -e MINIO_ROOT_PASSWORD=… minio/minio:<固定标签> server /data` → globalSetup 用 `CreateBucketCommand` 建桶（不依赖 `mc`）→ `AIA_TEST_S3=1 pnpm exec vitest run --project storage` → 停容器。
   - `.github/workflows/ci.yml` 加可选的 `s3` 任务，只调用 `pnpm run ci:s3`（D3）。
7. 多实例与 §5.6 备忘：写路径（publish、import、applyConfig、retire、delete）一律直读 `config.json` / `catalog.json`，不经备忘。否则实例 B 拿着过期的 catalog，会把旧 CRL 判成 `unchanged` 而不是 `stale_crl`。读路径允许最多 TTL 的陈旧，下载缓存本身就有 60–3600 s。切片 5a 已开备忘的话，本步只补测试；没开就不改。
8. `docs/operations.md` 多实例章：只有 `s3` 支持多实例，fs 仍是一个进程一个目录；生产 S3 端点上线前，必须在该端点上跑通 `AIA_TEST_S3=1` 的一致性套件（MinIO 通过不代表 AWS S3 或 R2-S3 也行）；写明备忘的陈旧窗口；凭据走 `_FILE`。

### 测试

- `tests/storage/s3.test.ts`：步骤 6 的 MinIO 套件。
- `tests/storage/s3-unit.test.ts`：每次运行，不需要 Docker。注入假的 `send`，验证错误映射（412、409、`NoSuchKey`、head 的 404）、前缀的拼接与剥离、翻页循环、SDK 重试场景（第一次写已生效，重试收到 412）。
- `tests/integration/multi-instance.test.ts`：每次运行。两个 `createApp` 共享一个 `MemoryStore`（切片 5a 实现了备忘就开启它）：A 发布新 CRL 后 B 立即收到旧 CRL，必须返回 `stale_crl`；两边并发发布同一目标，catalog 里最终只有一个 current，另一方得到 `updated`、`unchanged` 或 `stale_crl`。
- Docker 冒烟（手动）：镜像设 `-e AIA_STORE=s3` 指向 MinIO，依次确认 health 为 `degraded` → `aia config apply` → 一次下载。

### 出口条件

- `pnpm run ci:s3` 通过，用到的 MinIO 标签固定在脚本里。
- `pnpm verify` 通过；未设 `AIA_TEST_S3` 时 s3 套件显示 skipped。
- `pnpm run ci:worker` 通过，其中包含 `! grep -q "@aws-sdk" dist/worker/worker.js.map`。
- `pnpm exec vitest run --project integration multi-instance` 通过。
- Docker 冒烟：`curl -s localhost:8080/api/v1/health` 返回 `degraded`；`aia config apply` 之后下载返回 200。
- `docs/operations.md` 有多实例一章。

### 风险与对策

- MinIO 通过不等于 AWS S3 或 R2-S3 也行：条件 PutObject 的支持随 MinIO 版本不同。对策：固定镜像标签；任何新端点上线前都以这套一致性测试为准入；R2 的 S3 端点在跑过套件之前不列为受支持。
- MinIO 镜像可能拉不到：开工时确认所选标签能拉取，并记录版本。
- SDK 自动重试与条件写叠加：第一次请求其实已经成功，重试却收到 412，于是报 precondition-failed。catalog 重试重读后结果会被标成 `unchanged`，但状态是对的；`PUT /admin/config` 则可能对已生效的配置返回 412。文档写明"收到 412 先 GET 再判断"，单测覆盖这一场景。
- SDK 体积：只进 Node 包和 Docker 镜像，Worker 包由步骤 4 的 grep 守住。
- 多实例下备忘陈旧：步骤 7 的规则加 multi-instance 测试。

### 开工前需 owner 确认

| # | 问题 | 选项 | 推荐 |
| --- | --- | --- | --- |
| 1 | 切片 8 做不做 | (a) 做；(b) 暂缓，出现 Node 多实例或高可用需求时再开 | (b)：现在的部署是 Cloudflare 单 Worker + R2，没有多实例 Node 的需求；plan §12 保留这个切片 |
| 2 | 若做，哪些端点必须通过一致性套件 | MinIO（固定标签）/ AWS S3 / R2 的 S3 端点 / 其他 | 只承诺 MinIO，加上 owner 实际要用的那一个 |

## 附录 A. 迁移清单

来源 `worker-aia-cdp@5b570aa`（D4）。由五份迁移盘点生成，共 152 行，按旧路径列出处置、新位置与切片；处置词见本文 §1.4。下表照录，
只按各切片正文修正了 24 行：`src/worker/api/v2/crls/upload.ts` 的 `publishCrl` 签名（2026-10-19）；`tests/data/adcs.ts`、`src/worker/r2/{listing,objects}.ts`、`tests/helpers/r2.ts` 的切片（D5、D7 → 1）；
`src/worker/r2/summary.ts`、`tests/worker/{pki-values,crl-upload,r2-summary,extension-parsers}.test.ts`、`builders/primitives.ts`、
`src/contracts/openapi.ts`、`scripts/generate-openapi.ts` 的切片或新位置；`src/web/api/*` 落到 `src/web/client/`（B20）；`tsconfig.build.json`
的文件名（B4）；`tests/web/api-client.test.ts`、`tests/worker/api-pagination.test.ts` 的去向；`src/worker/r2/crls.ts` 的 `issuer_mismatch`
说明（切片 4 步骤 7）；`src/contracts/schemas.ts` 不搬 L510（切片 5a 步骤 1）；`.devcontainer`、夹具脚本、`docs/development.md`、`docs/templates/resources.example.json` 的处置或新位置。

| 旧路径（worker-aia-cdp@5b570aa） | 处置 | 新位置 | 切片 |
| --- | --- | --- | --- |
| `src/worker/pki/asn1.ts` | migrate-as-is | src/core/pki/asn1.ts | 2 |
| `src/worker/pki/constants.ts` | migrate-as-is | src/core/pki/constants.ts | 2 |
| `src/worker/pki/extensions.ts` | migrate-as-is | src/core/pki/extensions.ts | 2 |
| `src/worker/pki/parsers.ts` | migrate-adapt | src/core/pki/parsers.ts | 2 |
| `src/worker/pki/pem.ts` | migrate-adapt | src/core/pki/pem.ts | 2 |
| `src/worker/pki/pkijs.ts` | drop | — | none |
| `src/worker/pki/utils/conversion.ts` | migrate-adapt | src/core/pki/conversion.ts | 2 |
| `src/worker/pki/crls.ts` | reference-only | src/core/pki/verify.ts (rewrite) + freshness in src/core/publish.ts | 4 |
| `src/worker/api/v2/builders/primitives.ts` | migrate-adapt | src/core/summary/primitives.ts（`formatGeneralizedTime` 移入 src/core/pki/asn1.ts，切片 4） | 4,5a |
| `src/worker/api/v2/builders/extensions.ts` | migrate-as-is | src/core/summary/extensions.ts | 5a |
| `src/worker/api/v2/builders/certificate.ts` | migrate-as-is | src/core/summary/certificate.ts | 5a |
| `src/worker/api/v2/builders/crl.ts` | migrate-adapt | src/core/summary/crl.ts | 5a |
| `tests/data/adcs.ts` | drop（owner 2026-10-18：不入库；改用合成 AD CS 风格夹具） | — | 1 |
| `tests/worker/extension-parsers.test.ts` | migrate-adapt | tests/core/summary/extension-parsers.test.ts + tests/core/pki/asn1.test.ts | 2,5a |
| `tests/worker/pki-values.test.ts` | migrate-adapt | tests/core/pki/parsers.test.ts + tests/core/summary/values.test.ts + tests/core/publish.test.ts | 2,4,5a |
| `tests/worker/extensions-structure.test.ts` | migrate-as-is | tests/core/summary/extensions-structure.test.ts | 5a |
| `tests/worker/pem.test.ts` | migrate-as-is | tests/core/pki/pem.test.ts | 2 |
| `tests/worker/conversion.test.ts` | migrate-as-is | tests/core/pki/conversion.test.ts | 2 |
| `tests/worker/artifact-representation.test.ts` | drop | — | none |
| `src/worker/r2/certificates.ts` | rewrite | src/core/publish.ts (resolveIssuer/resolveTarget over catalog.certificates[*].summary.subjectKeyId + config.targets) | 4 |
| `src/worker/r2/crls.ts` | reference-only | scripts/migrate-from-v2.ts (slice 7); issuer_mismatch only in the temporary history-import route (slice 7; publish never emits it, slice 4) | 7 |
| `src/worker/r2/listing.ts` | reference-only | src/storage/r2.ts (list(prefix) cursor loop) | 1 |
| `src/worker/r2/metadata.ts` | drop | — | none |
| `src/worker/r2/objects.ts` | migrate-adapt | src/storage/r2.ts (put/get/head) | 1 |
| `src/worker/r2/summary.ts` | migrate-adapt | src/core/summary/catalog-summary.ts (buildCertificateSummary, buildCrlSummary) | 2,4 |
| `src/worker/api/v2/crls/upload.ts` | rewrite | src/core/publish.ts (publishCrl(deps, bytes); now = deps.now()) + src/http/routes/crls.ts (POST /api/v1/crls body handling) | 4 |
| `src/worker/api/v2/crls/metadata.ts` | drop | — | none |
| `src/worker/api/v2/certificates/metadata.ts` | drop | — | none |
| `src/worker/api/v2/shared/metadata-refresh.ts` | drop | — | none |
| `src/worker/cache/config.ts` | migrate-adapt | src/core/resources.ts (download cache policy) | 3 |
| `src/worker/cache/keys.ts` | drop | — | none |
| `src/worker/cache/operations.ts` | drop | — | none |
| `tests/worker/crl-upload.test.ts` | rewrite | tests/core/publish.test.ts + tests/core/freshness.test.ts + tests/http/crls-upload.test.ts + tests/integration/node-e2e.test.ts + tests/core/admin.test.ts (slice 2) | 2,4 |
| `tests/worker/r2-listing.test.ts` | drop | — | none |
| `tests/worker/r2-metadata.test.ts` | drop | — | none |
| `tests/worker/r2-summary.test.ts` | migrate-adapt | tests/core/summary.test.ts + tests/core/import.test.ts + tests/core/catalog.test.ts | 2,4 |
| `tests/worker/cache-config.test.ts` | migrate-adapt | tests/core/resources.test.ts + tests/http/downloads.test.ts | 3 |
| `tests/helpers/r2.ts` | migrate-adapt | tests/storage/fakes/r2-bucket.ts | 1 |
| `src/worker/worker.ts` | rewrite | src/runtime/worker.ts + src/http/app.ts + src/http/routes/downloads.ts | 1,3,5a |
| `src/worker/env.ts` | rewrite | wrangler types output (Env) + src/runtime/settings.ts | 1 |
| `src/worker/utils/content.ts` | rewrite | src/core/resources.ts (download policy) + src/http/routes/downloads.ts | 3 |
| `src/worker/utils/json-response.ts` | drop | — | 1 |
| `src/worker/api/v2/router.ts` | drop | — | 1 |
| `src/worker/api/v2/response.ts` | rewrite | src/http/errors.ts | 1 |
| `src/worker/api/v2/server.ts` | drop | — | 1 |
| `src/worker/api/v2/stats.ts` | rewrite | src/http/routes/health.ts (slice 1) + src/http/routes/stats.ts (slice 5a); counting in core | 1,5a |
| `src/worker/api/v2/certificates/list.ts` | rewrite | src/http/routes/certificates.ts | 5a |
| `src/worker/api/v2/certificates/detail.ts` | rewrite | src/http/routes/certificates.ts (builders → src/core/summary/) | 5a |
| `src/worker/api/v2/certificates/constants.ts` | drop | — | 2 |
| `src/worker/api/v2/certificates/index.ts` | drop | — | none |
| `src/worker/api/v2/crls/list.ts` | rewrite | src/http/routes/crls.ts | 5a |
| `src/worker/api/v2/crls/detail.ts` | rewrite | src/http/routes/crls.ts | 5a |
| `src/worker/api/v2/crls/constants.ts` | drop | — | 2 |
| `src/worker/api/v2/crls/index.ts` | drop | — | none |
| `src/worker/api/v2/shared/pagination.ts` | drop | — | none |
| `src/worker/api/v2/shared/resource.ts` | drop | — | 3 |
| `src/contracts/api.ts` | drop | — | 1,4,5a |
| `src/contracts/schemas.ts` | migrate-adapt | src/core/summary/schemas.ts (X.509 projection, lines 12-497, 542-556, 578-604, types 768-866; `CrlTypeSchema` L510 not moved) + src/http/schemas.ts (v1 wrappers and errors) | 5a |
| `src/contracts/openapi.ts` | rewrite | scripts/generate-openapi.ts (+ doc config shared with the runtime /api/v1/openapi.json route) | 1,5a |
| `src/contracts/types.ts` | drop | — | none |
| `src/contracts/index.ts` | drop | — | none |
| `scripts/generate-openapi.ts` | migrate-adapt | scripts/generate-openapi.ts | 1,5a |
| `tests/worker/api-pagination.test.ts` | reference-only | tests/http/lists.test.ts（只取不变量） | 5a |
| `tests/worker/api-routing.test.ts` | rewrite | tests/http/app.test.ts + tests/http/downloads.test.ts + tests/http/certificates.test.ts | 1,3,5a |
| `tests/worker/api-stats.test.ts` | rewrite | tests/http/stats.test.ts | 5a |
| `tests/worker/json-response.test.ts` | drop | — | 1 |
| `docs/api-design-v2.md` | reference-only | docs/api.md (slice 6) | 6 |
| `src/web/index.html` | migrate-adapt | src/web/index.html | 1 |
| `src/web/public/favicon.svg` | migrate-as-is | src/web/public/favicon.svg | 1 |
| `src/web/public/favicon.ico` | migrate-as-is | src/web/public/favicon.ico | 1 |
| `src/web/env.d.ts` | migrate-adapt | src/web/env.d.ts | 1 |
| `src/web/main.ts` | rewrite | src/web/main.ts | 1 |
| `src/web/styles/tailwind.css` | rewrite | src/web/styles/main.css | 1 |
| `tailwind.config.ts` | drop | — | 1 |
| `vite.config.ts` | rewrite | vite.config.ts | 1 |
| `tsconfig.app.json` | rewrite | tsconfig.web.json | 1 |
| `src/web/App.vue` | rewrite | src/web/App.vue (layout shell) + src/web/pages/OverviewPage.vue | 5b |
| `src/web/api/client.ts` | rewrite | src/web/client/api.ts | 1,5a |
| `src/web/api/response.ts` | rewrite | src/web/client/errors.ts | 5a |
| `src/web/api/pagination.ts` | drop | — | none |
| `src/web/utils/status.ts` | migrate-adapt | src/web/utils/status.ts | 5b |
| `src/web/utils/dates.ts` | migrate-adapt | src/web/utils/dates.ts | 5b |
| `src/web/utils/format.ts` | migrate-adapt | src/web/utils/format.ts | 5b |
| `src/web/utils/x509.ts` | migrate-adapt | src/web/utils/x509.ts | 5b |
| `src/web/composables/useCrlUploadInput.ts` | migrate-as-is | src/web/composables/useCrlUploadInput.ts | 5b |
| `src/web/composables/useLocale.ts` | rewrite | src/web/composables/useLocale.ts | 5b |
| `src/web/composables/useTheme.ts` | drop | — | 5b |
| `src/web/composables/useCollectionLoader.ts` | drop | — | none |
| `src/web/composables/useDetailCache.ts` | drop | — | none |
| `src/web/i18n.ts` | migrate-adapt | src/web/i18n.ts | 5b |
| `src/web/locales/en.json` | migrate-adapt | src/web/locales/en.json (+ new src/web/locales/zh-CN.json) | 5b |
| `src/web/stores/certificates.ts` | drop | — | none |
| `src/web/stores/crls.ts` | drop | — | none |
| `src/web/components/ExtensionView.vue` | migrate-adapt | src/web/utils/extension-blocks.ts + src/web/components/x509/ExtensionView.vue | 5b |
| `src/web/components/ExtensionList.vue` | migrate-adapt | src/web/components/x509/ExtensionList.vue | 5b |
| `src/web/components/GeneralNameList.vue` | migrate-adapt | src/web/components/x509/GeneralNameList.vue | 5b |
| `src/web/components/DistributionPointList.vue` | migrate-adapt | src/web/components/x509/DistributionPointList.vue | 5b |
| `src/web/components/Asn1Dump.vue` | migrate-adapt | src/web/components/x509/Asn1Dump.vue | 5b |
| `src/web/components/NameDetails.vue` | migrate-adapt | src/web/components/x509/NameDetails.vue | 5b |
| `src/web/components/HexValue.vue` | migrate-adapt | src/web/components/HexValue.vue | 5b |
| `src/web/components/StatusBadge.vue` | migrate-adapt | src/web/components/StatusBadge.vue | 5b |
| `src/web/components/FingerprintDetails.vue` | rewrite | src/web/components/KeyValueList.vue | 5b |
| `src/web/components/CertificateDetails.vue` | rewrite | src/web/pages/CertificatePage.vue (+ src/web/components/certificate/CertificateOverview.vue) | 5b |
| `src/web/components/CrlDetails.vue` | rewrite | src/web/pages/CrlTargetPage.vue (+ src/web/components/crl/RevokedTable.vue, src/web/utils/crl-entries.ts) | 5b |
| `src/web/components/CrlUpload.vue` | rewrite | src/web/components/overview/CrlUploadCard.vue | 5b |
| `src/web/components/ThemeToggle.vue` | rewrite | src/web/components/ThemeToggle.vue | 5b |
| `src/web/components/CertificateCard.vue` | reference-only | src/web/components/overview/CertificateTable.vue | 5b |
| `src/web/components/CrlCard.vue` | reference-only | src/web/components/overview/CrlTargetTable.vue | 5b |
| `src/web/components/ResourceCard.vue` | reference-only | src/web/components/DownloadLinks.vue | 5b |
| `src/web/components/SectionState.vue` | drop | — | none |
| `public/index.html` | drop | — | none |
| `public/js/main.js` | drop | — | none |
| `public/js/vue-B8VrgSNh.js` | drop | — | none |
| `public/js/state-BUPWKezW.js` | drop | — | none |
| `public/styles.css` | drop | — | none |
| `public/favicon.ico` | drop | — | none |
| `public/favicon.svg` | drop | — | none |
| `tests/web/status.test.ts` | migrate-adapt | tests/web/status.test.ts | 5b |
| `tests/web/upload-input.test.ts` | migrate-adapt | tests/web/upload-input.test.ts | 5b |
| `tests/web/components.test.ts` | rewrite | tests/web/components.test.ts | 5b |
| `tests/web/state.test.ts` | rewrite | tests/web/api-errors.test.ts | 5a |
| `tests/web/collection-loader.test.ts` | rewrite | tests/web/queries.test.ts | 5b |
| `tests/web/api-client.test.ts` | rewrite | tests/core/summary/schemas.test.ts (slice 5a) + tests/http/crls-upload.test.ts (slice 4) | 4,5a |
| `package.json` | rewrite | package.json | 1 |
| `pnpm-lock.yaml` | drop | pnpm-lock.yaml | 1 |
| `tsconfig.json` | rewrite | tsconfig.base.json + tsconfig.worker.json (+ solution-style tsconfig.json) | 1 |
| `tsconfig.node.json` | rewrite | tsconfig.node.json (check, noEmit) + tsconfig.build.json (rootDir src, outDir dist/server) | 1 |
| `eslint.config.ts` | migrate-adapt | eslint.config.ts | 1 |
| `.prettierrc.json` | migrate-as-is | .prettierrc.json | 1 |
| `.prettierignore` | migrate-adapt | .prettierignore | 1 |
| `.gitignore` | migrate-adapt | .gitignore | 1 |
| `.actrc` | drop | — | 1 |
| `redocly.yaml` | drop | — | none |
| `wrangler.jsonc` | migrate-adapt | wrangler.jsonc | 1 |
| `LICENSE` | migrate-as-is | LICENSE | 1 |
| `README.md` | rewrite | README.md | 6 |
| `.github/workflows/ci.yml` | rewrite | .github/workflows/ci.yml | 1 |
| `.github/workflows/pages.yml` | drop | — | none |
| `.github/dependabot.yml` | migrate-adapt | .github/dependabot.yml | 1 |
| `.devcontainer/devcontainer.json` | rewrite（D10，owner 2026-10-19：Node 24 镜像、PowerShell feature、非 root、无 act） | .devcontainer/devcontainer.json | 1 |
| `scripts/generate-test-data.sh` | rewrite | tests/fixtures/generate-test-data.sh（fixtures spike 成品 + `leaf-min` 修改；用例矩阵见附录 D） | 1 |
| `scripts/seed-dev.sh` | rewrite | scripts/seed-dev.ts | 2 |
| `scripts/reset-dev.sh` | drop | — | 2 |
| `scripts/adcs-crl-uploader.ps1` | rewrite | scripts/adcs-crl-uploader.ps1 | 4 |
| `scripts/generate-docs-index.ts` | drop | — | none |
| `docs/development.md` | rewrite | README.md 的"开发"一节（不另设 docs/development.md） | 6 |
| `docs/architecture.md` | reference-only | docs/plan.md / docs/operations.md (absorbed) | none |
| `docs/templates/api-responses.example.json` | reference-only | — | 5a |
| `docs/templates/implementation-slice.md` | migrate-adapt | docs/templates/implementation-slice.md | 1 |
| `docs/templates/migration-inventory.example.json` | reference-only | — | 7 |
| `docs/templates/resources.example.json` | reference-only | docs/config.example.json（新写） | 2 |
| `tests/fixtures/pki` | drop | tests/fixtures/pki/（重新生成后入库） | 1 |

## 附录 B. 缺陷与评审项覆盖

"切片 N 步骤 k"指该切片"步骤"下的第 k 条；同一项分在几处处理时按先后列出。

### B.1 plan §10 旧实现缺陷

| 编号 | 缺陷（简） | 处理 |
| --- | --- | --- |
| §10 #1 | 下载无 304、无 `Content-Length`、`ETag` 无引号 | 切片 3 步骤 3–4（摘要 `ETag`、`ifNoneMatchHit` 先于读 blob、显式 `Content-Length`）；测试 `tests/http/downloads.test.ts`、`tests/integration/downloads.test.ts` |
| §10 #2 | 下载暴露 `archive/`、`by-keyid/` 与任意对象；详情接受归档 id | 切片 3 步骤 2（只走路径表，内部键不可达）；切片 5a 步骤 6（id 参数格式，归档形 id → 400）；切片 5b 步骤 6（UI 对非法 id 不发请求）；切片 7 步骤 8（按访问日志决定是否给旧 URL 加路径） |
| §10 #3 | CRL `max-age` 无上限、过期后为 0 | 切片 3 步骤 3（夹紧 [60 s, 3600 s]，无 `nextUpdate` 300 s） |
| §10 #4 | 相同 CRL 重复上传 409 | 切片 4 步骤 5（`unchanged` 200）；切片 5b 步骤 7（`unchanged` 是成功文案） |
| §10 #5 | 伴随写失败报 500；`caches.default` 在 Node 上崩 | 切片 2 步骤 5（导入单提交点）；切片 4 步骤 6（无伴随写、无边缘缓存，catalog 写成功即完成） |
| §10 #6 | 归档写无条件、并发发布无保护 | 切片 4 步骤 2、6（内容寻址 blob + `ifMatch` 条件写重试）；已被 Gen A/B 覆盖的旧版本不可恢复，切片 7 步骤 4 在报告写明 |
| §10 #7 | `revokedCount` 未知时显示 0 | 切片 4 步骤 2（发布时必有非空 `revokedCount`）；切片 5a 步骤 5（"未知"只以 `current: null` 出现）；切片 5b 步骤 6 |
| §10 #8 | 详情缺 `signatureAlgorithm`、`parameters` 不输出、死变体 | 切片 5a 步骤 1、3（构建器迁入；删 `UnknownExtensionValueSchema`；签名算法必填） |
| §10 #9 | 全 null 信封通过 200 校验成空列表 | 切片 5a 步骤 5–6（按状态码 schema；store 抛错 500，不是 `200 []`） |
| §10 #10 | `relationships` 恒空 | 切片 5a 步骤 5（证书 `targets`、CRL `issuer`）；切片 5b 步骤 6（页面链接） |
| §10 #11 | 畸形 ASN.1 时间成 1899 | 切片 2 步骤 1（`assertWellFormed` 随 pki 迁入，证书导入即拒）；切片 4 步骤 6（CRL `reason: "time"`） |
| §10 #12 | 未来 `thisUpdate`、未知关键扩展、作用域 CRL 无策略 | 切片 4 步骤 3 |
| §10 #13 | `constructor.name` 判编码 | 切片 2 步骤 1（`toDer` 按字节识别 PEM / DER）；DN 编码按 tag 判定随切片 5a 步骤 3 的构建器迁入 |
| §10 #14 | 证书只能手工放进 R2 | 切片 2 步骤 3、5、8（导入接口，导入时生成完整摘要） |
| §10 #15 | 健康检查硬编码 | 切片 1 步骤 4（真实 store / configuration 检查，D5）；切片 2 步骤 7（完整 schema 与规则） |
| §10 #16 | 统计按桶前缀字节 | 切片 5a 步骤 5 |
| §10 #17 | ts-rest 忽略 `no-store` | 切片 1 步骤 6（`hc` 的 `init.cache`）；切片 5a 步骤 7（API `no-store`）；切片 5b 步骤 5（上传后全量失效） |
| §10 #18 | `SITE_NAME` 多条死通道 | 切片 1 步骤 6（只剩构建期 `VITE_SITE_NAME`，校验与默认值）；切片 5b 步骤 6（页头、页脚） |
| §10 #19 | 上传无体积上限、无鉴权 | 切片 4 步骤 8（`bodyLimit`、可选 `bearerAuth`）；切片 7 开工前需 owner 确认第 3 项（生产启用令牌） |
| §10 #20 | 助手 PS5 死分支、手搓 multipart、按扩展名判格式、409 当失败 | 切片 4 步骤 11；切片 7 步骤 9（生产安装） |
| §10 #21 | 测试 glob、钩子挂起、`pretest` 重生成夹具 | 切片 1 步骤 9–10 |
| §10 #22 | 没有 Node / Docker 运行方式 | 切片 1 步骤 5、11 |
| §10 #23 | 没有退役、删除、历史的管理路径 | 切片 2 步骤 8–9（import / config）；切片 6 步骤 1–7 |
| §10 #24 | 日志无结构 | 切片 1 步骤 4（请求日志）；切片 2 步骤 8、切片 4 步骤 6、切片 6 步骤 2（导入 / 发布 / 退役各一行）；本文 §2.6 |
| §10 #25 | `thisUpdate` 缺失序列化为空串 | 切片 4 步骤 6（解析期拒绝）、步骤 8（成功体 `thisUpdate` 必填） |
| §10 #26 | 文档与代码多处不一致 | 切片 6 步骤 8–12（OpenAPI 漂移、docs-consistency 测试、README / `docs/api.md` / `docs/operations.md` 重写） |
| §10 #27 | 详情解析覆盖不足 | 切片 5a 步骤 1、3（41 个解析器与 schema 迁入）；回归改用合成夹具（D7，切片 5a 测试表）；线上工件的解码核对在切片 7 步骤 7 |
| §10 #28 | 未识别扩展只给 hex；UI 签名算法 Unknown | 切片 5a 步骤 5（详情一次全量）；切片 5b 步骤 3、6（ASN.1 dump、带参数的签名算法） |

### B.2 完整性评审：计划矛盾

| 编号 | 矛盾（简） | 处理 |
| --- | --- | --- |
| C1 | PKIjs `crl.verify()` 暗中比较签发者 DN | 切片 4 步骤 4（`verifyWithPublicKey`，B21）；步骤 1 的 `issuing-ca-1-renamed` 夹具与 `verify.test.ts` |
| C2 | PKIjs 隐藏的关键扩展闸（关键 AD CS 扩展被拒、关键 IDP 被收） | 切片 4 步骤 3（显式策略表，含条目扩展）、步骤 4（绕开闸）；`verify.test.ts` 回归 |
| C3 | 新鲜度结果与旧实现不同（同号同时间、单侧有号） | 切片 4 步骤 5 |
| C4 | 不可验算法一律报 `invalid_signature` | 切片 4 步骤 4（白名单，名单外 → `unsupported_algorithm`） |
| C5 | `issuer_mismatch` 两种含义、按 plan 不可达 | 切片 2 步骤 6（V6）；切片 4 步骤 6–7（上传不产生）；切片 7 步骤 5（只用于临时历史导入），步骤 11 删除 |
| C6 | 内容类型按键后缀（PEM `text/plain`） | 切片 3 步骤 3、6 |
| C7 | 缓存头去掉 `s-maxage` / `stale-while-revalidate`、丢 `Last-Modified` | 切片 3 步骤 3、6；切片 7 步骤 10（CryptoAPI 冒烟） |
| C8 | 孤儿 blob 进历史、破坏零写入不变量 | 切片 4 步骤 6（history 标记，历史 = 标记 ∪ current）；切片 6 步骤 4（列表不含孤儿）；切片 2 步骤 5（证书孤儿 blob 不可见）；切片 7 步骤 5（导入写标记） |
| C9 | 历史迁移前提描述的是从未部署的 Gen C | 切片 7 目标与范围、步骤 1–4（尽力而为、HTTP 探测 + stats 对账）；开工前需 owner 确认第 1 项 |
| C10 | 旧助手把 v1 响应记为失败 | 切片 4 步骤 11（重写）；切片 7 步骤 9（切换时替换脚本与令牌文件） |
| C11 | plan §11 声称的夹具覆盖不存在 | 切片 1 步骤 9（生成器随切片 1 提交；12 张证书、30 个 CRL、6 个无效输入与 17 个场景逐项列在附录 D，即重写契约）；切片 4 步骤 1 与测试（逐场景断言）、步骤 12（plan §11 同步） |
| C12 | Workers SPA 兜底会把 `/api` 与下载未命中答成 200 HTML | 切片 1 步骤 4（`ui.ts` 与 `notFound`）、步骤 12（`smoke.sh` 跑两条运行时）；切片 3 步骤 5；切片 5b 出口 4 |
| C13 | `Content-Disposition` 迁移基线不明、路径未净化 | 切片 3 步骤 3（形状同线上，filename 净化）；切片 2 步骤 6（V2 路径字符集） |
| C-内部 | plan 内部：`revokedCount` 可空 vs 发布即解析；严格时间放在切片 4 而切片 2 已需要 | 切片 5a 步骤 5（非空）；切片 2 步骤 1（严格时间随 pki 迁入提前到切片 2） |

### B.3 完整性评审：计划漏写的旧规则

| 编号 | 规则（简） | 处理 |
| --- | --- | --- |
| M1 | 证书与 CRL 严格 DER：单一顶层元素、解码错误即拒、RFC 5280 时间 | 切片 2 步骤 1、5（证书）；切片 4 步骤 6（CRL） |
| M2 | CRL Number / Delta 指示须 INTEGER、非负、BigInt、无 20 octet 上限 | 切片 4 步骤 6；切片 2 测试 `tests/core/pki/parsers.test.ts` |
| M3 | AKI `keyIdentifier` 必需 | 切片 4 步骤 6（默认 `issuer_not_found` + `missing_aki`，开工前需 owner 确认第 3 项） |
| M4 | key id 规范为小写 hex | 切片 2 步骤 4（schema 拒大写）与 `tests/core/summary.test.ts` 的跨切片锁定；切片 4 步骤 6 |
| M5 | 签发者并列规则（畸形 SKI、多证书同 SKI） | 切片 2 步骤 3（畸形 SKI 拒导入）、步骤 6（V6）；切片 4 步骤 6（按目标配置的签发者验签，开工前需 owner 确认第 4 项）；切片 7 步骤 2、5（迁移归属与历史导入同一规则） |
| M6 | 带合法 Delta 指示才是 delta | 切片 4 步骤 6；切片 5a 步骤 3（删 `determineCrlType`） |
| M7 | PEM 输入策略 | 切片 2 步骤 1（`toDer`、`splitPemBlocks`，开工前需 owner 确认第 1 项）；切片 4 步骤 6 |
| M8 | 上传 body：字段 `crl`、字符串字段、415 `details.received` | 切片 4 步骤 8；切片 5b 步骤 7 |
| M9 | 任何拒绝零写入 | 切片 2 步骤 5（导入）；切片 4 步骤 6（发布）；切片 6 步骤 3（退役后上传） |
| M10 | 可验算法集与 SHA-1 | 切片 4 步骤 4（开工前需 owner 确认第 1 项） |
| M11 | 外层与 TBS 签名算法须相同 | 切片 4 步骤 3（开工前需 owner 确认第 5 项） |
| M12 | 对收到的 TBS 字节验签 | 切片 4 步骤 4 |
| M13 | CRL 条目扩展的关键性 | 切片 4 步骤 3 |
| M14 | 已识别扩展标为关键时接受 | 切片 4 步骤 3 |
| M15 | 新鲜度细节（两侧无号、同号更晚、BigInt 与时刻比较） | 切片 4 步骤 5 |
| M16 | 上传结果带 `baseCrlNumber` 与签发者 | 切片 4 步骤 8；切片 5b 步骤 7 |
| M17 | `Content-Disposition` filename 与路径字符集 | 切片 2 步骤 6（V2）；切片 3 步骤 3 |
| M18 | 下载 `Last-Modified` | 切片 3 步骤 3（保留，默认值） |
| M19 | 下载错误纯文本 | 切片 1 步骤 4（404）；切片 3 步骤 4–5（404 带 `no-store`，405 带 `Allow`） |
| M20 | 下载路径精确匹配、`%2F`、畸形 `%` | 切片 3 步骤 2 |
| M21 | 证书摘要格式与可空 | 切片 2 步骤 4 |
| M22 | PEM 输出格式（64 列、LF、结尾换行） | 切片 3 步骤 1 |
| M23 | 导入证书不等于授权签发者 | 切片 2 步骤 5；切片 4 步骤 6（`target_not_configured`）；切片 6 步骤 10（`docs/api.md`）；切片 7 步骤 3 |
| M24 | 助手顺序与单文件失败隔离 | 切片 4 步骤 11；切片 7 步骤 9 |

## 附录 C. 待 owner 确认汇总

未答复的项按推荐默认实施，并在该切片的合并说明里写明；已答复的标"已确认"与日期。

### 切片 1

| # | 问题 | 推荐默认 |
| --- | --- | --- |
| 1 | 边界漏洞补丁（推翻 plan §3"不另设 ESLint 导入边界规则和 bundle 卫生断言"） | 已确认（2026-10-19，D9）：加。ESLint `no-restricted-imports` 分层规则；`scripts/check-worker-program.ts` 作 `typecheck:boundary`；`ci:worker` 在 dry-run 后断言 `dist/worker/worker.js` 不含 `"node:` 导入 |
| 2 | devcontainer | 已确认（2026-10-19，D10）：本切片建（Node 24 镜像 + PowerShell feature，非 root，无 act；切片 1 步骤 15） |

### 切片 2

| # | 问题 | 推荐默认 |
| --- | --- | --- |
| 1 | 多块 PEM | API 拒绝（`pem_blocks`），CLI 拆块逐个导入 |
| 2 | 改绑账本 `catalog.certificatePaths`（plan §5.3 新字段，只增不减） | 采用 |
| 3 | V6 状态部分（SKI 相同的证书不得各有同 kind 目标） | 先拒绝；与切片 4 第 4 项一起定 |
| 4 | `PUT /api/v1/admin/config` 缺前置条件头 | 400 `bad_request`（不新增错误码） |

### 切片 3

无。

### 切片 4

| # | 问题 | 推荐默认 |
| --- | --- | --- |
| 1 | SHA-1 签名的 CRL | 接受（分发服务不是校验器，旧实现也接受） |
| 2 | 只含 `distributionPoint` 的关键 IDP（AD CS 的 CDP 选项） | 接受；`onlyContains*`、`onlySomeReasons`、`indirectCRL` 仍 `scoped_crl_unsupported` |
| 3 | 无 AKI 或 AKI 无 `keyIdentifier` | `issuer_not_found` + `details.reason = "missing_aki"` |
| 4 | 多张证书共用 SKI（同钥续期）时的签发者选择 | 按目标配置的签发者验签；`applyConfig` 拒绝同 kind 且签发者 SKI 相同的两个目标；上传不再产生 `issuer_mismatch` |
| 5 | 外层与 TBS 内签名算法不一致 | `invalid_crl`（`signature_algorithm_mismatch`） |

不阻塞开工的规划默认值：5 分钟边界"恰好 5 分钟接受"、1 + 3 次重试、状态码表、同号更晚 `thisUpdate` 为 `updated`、两侧无号比
`thisUpdate`、history 标记、blob 键带 CRL 号、不设 20 octet 上限。

### 切片 5a

| # | 问题 | 推荐默认 |
| --- | --- | --- |
| 1 | 状态阈值 / 即将过期规则 | 同切片 5b 第 2 项，须在 5a 开工前定：`/api/v1/stats` 不含时间相关字段（列表项总带 `current.summary.nextPublish`，不受此项影响） |

### 切片 5b

| # | 问题 | 推荐默认 |
| --- | --- | --- |
| 1 | CSP | 采纳切片 5b 步骤 10 的策略，经 `secureHeaders` 的 `contentSecurityPolicy` 以响应头下发（两条运行时同一份），预绘制主题脚本用 hash 放行；冒烟出现违规只放宽 `style-src` |
| 2 | 状态阈值 vs AD CS 节奏（旧 80% 规则与"7 天内"都会误报） | 有 `nextPublish` 时 `now` 超过它 1 h 仍未更新才算 stale；没有时沿用 80%（剩余不足 20%）；"即将过期"改为客户端计算的"需关注"（stale + expired + unknown），stats 不加时间字段；证书 `expiring` 阈值为剩余不足有效期 10% |

切片 5a 与 5b 的初稿对第 2 项各给了一套推荐（5a：服务端 stats 带 `expired` / `expiringSoon`，状态函数放 `src/core/status.ts` 供 UI 导入；
5b：时间相关数只在客户端算）。本文取 5b 的方案：plan §7.1 的 stats 本来就没有时间字段，5b 步骤 11 的构建插件禁止 web 在运行时导入
`src/core`，且客户端计算消除了服务端与浏览器时钟不一致；保留 5a 稿的 1 h 宽限。

### 切片 6

| # | 问题 | 推荐默认 |
| --- | --- | --- |
| 1 | 退役语义 | 终态：退役 UUID 的上传一律 `target_not_configured`，恢复发布用新 UUID |
| 2 | 证书删除保护 | 被任一 `current` 或 `retired.last` 作为 `verifier` 的证书永不可删（本版无 tombstone 清除） |
| 3 | R2 备份 | 不申请 R2 S3 令牌；只备份 config 与 CA 证书文件，接受历史丢失 |
| 4 | AD CS 计划任务的现实配置 | 请 owner 在两台签发 CA 上 `Export-ScheduledTask` 导出；拿不到时按模板写并标"未核对" |
| 5 | pki.acha.top 在 Cloudflare 上的 HSTS 与 Always Use HTTPS 现状 | 该主机名两者都保持关闭 |

### 切片 7

| # | 问题 | 推荐默认 |
| --- | --- | --- |
| 1 | 历史枚举通道（C9） | 以 HTTP 探测可预测的 Gen A/B 归档名为主，与 `/api/v2/stats` 对账不平时用 `getPlatformProxy` 远程 R2 绑定补差 |
| 2 | 是否共享旧 R2 桶（`bucket_name`） | 不共享：自动置备 `aia-cdp-store`（B6）；绝不复用旧 Worker 名 `aia-cdp-worker` |
| 3 | AD CS 助手切换方式与上传令牌 | 在冻结窗口内替换脚本；生产启用 `AIA_UPLOAD_TOKEN`，UI 上传用切片 5b 步骤 7 的令牌框 |

### 切片 8

| # | 问题 | 推荐默认 |
| --- | --- | --- |
| 1 | 切片 8 做不做 | 暂缓，出现 Node 多实例或高可用需求时再开 |
| 2 | 若做，哪些端点必须通过一致性套件 | 只承诺 MinIO（固定标签），加上 owner 实际要用的那一个 |

## 附录 D. 夹具用例矩阵（重写契约）

取自 2026-10-18 fixtures spike 产出的 `manifest.json`（生成器 sha256 `872a483b…7ac6`，OpenSSL 3.5.5），已计入切片 1 步骤 9 对 `leaf-min` 的修改。
后续切片的测试按名字引用这些夹具、从 manifest 读值；重写生成器时，文件名、签发者、kind、声明值（序列号、有效期、CRL 号、base 号、时间、吊销条数）
与期望结果必须逐项保持，sha256 与大小随密钥变、不在契约内。时间为 UTC，未写年份的是 2026；路径相对 `tests/fixtures/pki/`；`manifest.now` =
`2026-01-04T00:00:00Z`。切片 4 步骤 1 另加 `certs/issuing-ca-1-renamed` 与 CRL 条目的 `nextPublish` 字段。

### D.1 证书（`certs/<名>.der` 与 `.pem`，12 张）

| 名 | 签发者 | 密钥 | 序列号 | 有效期 | `import` | 用途 |
| --- | --- | --- | --- | --- | --- | --- |
| `root-ca` | 自签 | EC P-384 | 1000 | 2025-01-01 – 2045-01-01 | 是 | 离线根，ecdsa-with-SHA384（同线上根） |
| `issuing-ca-1` | root-ca | RSA-2048 | 1001 | 2025-01-01 – 2035-01-01 | 是 | AD CS SubCA 形状：CA Version 0、模板名 BMPString `SubCA`、AIA、CDP |
| `issuing-ca-2` | root-ca | RSA-2048 | 1002 | 2025-01-01 – 2035-01-01 | 是 | 第二个签发 CA |
| `issuing-ca-1-renewed` | root-ca | RSA-2048（issuing-ca-1 的钥） | 1003 | 2025-12-01 – 2035-12-01 | 否 | 同钥同 SKI 续期：CA Version 1、Previous CA Certificate Hash（V6、M5、C5） |
| `rogue-ca` | 自签 | RSA-2048 | 4000 | 2025-01-01 – 2035-01-01 | 否 | 主体与 issuing-ca-1 相同、密钥不同，从不导入 |
| `ed25519-ca` | 自签 | Ed25519 | 5000 | 2025-01-01 – 2035-01-01 | 是 | `unsupported_algorithm` 的签发者 |
| `ed448-ca` | 自签 | Ed448 | 6000 | 2025-01-01 – 2035-01-01 | 是 | `unsupported_algorithm` 的签发者 |
| `leaf-full` | issuing-ca-1 | EC P-256 | 2000 | 2025-12-01 – 2026-12-01 | 否 | 扩展齐全：UTF8String 主体、SAN（DNS / IPv4 / IPv6 / URI / email / UPN otherName）、CDP、Freshest CRL、AIA（含 OCSP）、证书策略 |
| `leaf-min` | issuing-ca-1 | EC P-256 | 2001 | 2025-12-01 – 2026-12-01 | 否 | 只有 basicConstraints，无 SKI / AKI |
| `leaf-revoked` | issuing-ca-1 | EC P-256 | 2002 | 2025-12-01 – 2026-12-01 | 否 | 自 issuing-ca-1 `full-01` 起吊销：keyCompromise + invalidityDate |
| `leaf-superseded` | issuing-ca-1 | EC P-256 | 2003 | 2025-12-01 – 2026-12-01 | 否 | 自 `full-03` 起吊销：superseded |
| `leaf-hold` | issuing-ca-2 | EC P-256 | 3000 | 2025-12-01 – 2026-12-01 | 否 | issuing-ca-2 `full-01`：certificateHold + holdInstructionReject |

### D.2 CRL（`crls/<签发者>/<名>.der`，30 个）

另有 3 个 PEM 变体 `issuing-ca-1/full-01.pem`、`issuing-ca-1/full-01.crlf.pem`（CRLF 换行）、`root-ca/full-01.pem`，解码后与对应 DER 逐字节相同。
"首次上传"即 manifest 的 `expect`：目标已配置、尚无 current 时的结果。签名者都是所在目录的 CA，`full-forged-aki` 除外。

| 文件 | kind | CRL 号 | base | thisUpdate | nextUpdate | 吊销 | 首次上传 | 场景 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `root-ca/full-01` | full | 4096 | — | 01-01 00:00 | 07-01 00:00 | 0 | `created` | ECDSA P-384 |
| `root-ca/full-02` | full | 4097 | — | 01-02 00:00 | 07-02 00:00 | 0 | `created` | 在 full-01 之后 updated |
| `root-ca/full-02-resigned` | full | 4097 | — | 01-02 00:00 | 07-02 00:00 | 0 | `created` | TBS 同 full-02、ECDSA 重签：对 full-02 conflict |
| `issuing-ca-1/full-01` | full | 1 | — | 01-01 00:00 | 01-08 00:00 | 1 | `created` | 首个 full |
| `issuing-ca-1/delta-01` | delta | 2 | 1 | 01-01 12:00 | 01-03 00:00 | 1 | `created` | base 1 的 delta（在 `now` 已过期） |
| `issuing-ca-1/full-02` | full | 3 | — | 01-02 00:00 | 01-09 00:00 | 1 | `created` | 在 full-01 之后 updated |
| `issuing-ca-1/full-02-conflict` | full | 3 | — | 01-02 00:00 | 01-09 12:00 | 1 | `created` | 同号同 thisUpdate、nextUpdate 不同：对 full-02 conflict |
| `issuing-ca-1/full-02-reissued` | full | 3 | — | 01-02 06:00 | 01-09 06:00 | 1 | `created` | 同号、thisUpdate 更晚：对 full-02 updated |
| `issuing-ca-1/delta-02` | delta | 4 | 3 | 01-02 12:00 | 01-04 06:00 | 1 | `created` | 在 delta-01 之后 updated |
| `issuing-ca-1/full-03` | full | 5 | — | 01-03 00:00 | 01-10 00:00 | 2 | `created` | 两条吊销 |
| `issuing-ca-1/full-04-older-time` | full | 6 | — | 01-02 20:00 | 01-09 20:00 | 2 | `created` | 号比 full-03 大、thisUpdate 更早：号优先，updated |
| `issuing-ca-1/full-no-number` | full | — | — | 01-03 06:00 | 01-10 06:00 | 2 | `created` | 无 CRL Number：与有号 current 双向 non_orderable |
| `issuing-ca-1/full-no-aki` | full | — | — | 01-03 06:00 | 01-10 06:00 | 2 | `issuer_not_found` | 没有任何 CRL 扩展（无 AKI；切片 4 默认另带 `details.reason = "missing_aki"`） |
| `issuing-ca-1/full-broken-sig` | full | 10 | — | 01-03 12:00 | 01-10 12:00 | 2 | `invalid_signature` | 签名末字节翻转 |
| `issuing-ca-1/full-forged-aki` | full | 11 | — | 01-03 12:00 | 01-10 12:00 | 0 | `invalid_signature` | issuing-ca-1 的名称与 AKI，rogue-ca 的密钥签名 |
| `issuing-ca-1/full-unknown-critical` | full | 12 | — | 01-03 12:00 | 01-10 12:00 | 2 | `unknown_critical_extension` | 关键 `1.3.6.1.4.1.32473.1` |
| `issuing-ca-1/full-unknown-noncritical` | full | 13 | — | 01-03 12:00 | 01-10 12:00 | 2 | `created` | 非关键 `1.3.6.1.4.1.32473.2`，原样保留 |
| `issuing-ca-1/full-idp-scoped` | full | 14 | — | 01-03 12:00 | 01-10 12:00 | 2 | `scoped_crl_unsupported` | 关键 IDP，onlyContainsUserCerts |
| `issuing-ca-1/full-idp-dp-only` | full | 15 | — | 01-03 12:00 | 01-10 12:00 | 2 | `scoped_crl_unsupported` | 只含 DP 的关键 IDP（AD CS 选项）；切片 4 owner 确认 2 的默认是接受（→ `created`） |
| `issuing-ca-1/full-pss` | full | 16 | — | 01-03 12:00 | 01-10 12:00 | 2 | `created` | RSASSA-PSS：SHA-256、MGF1 SHA-256、salt 32 |
| `issuing-ca-1/full-no-next-update` | full | 17 | — | 01-03 12:00 | — | 2 | `created` | 去掉 nextUpdate 后重签：下载缓存 300 s |
| `issuing-ca-1/full-bad-time` | full | 18 | — | 01-03 12:00 | 01-10 12:00 | 2 | `invalid_crl` | thisUpdate 为无秒 UTCTime `2601031200Z`，签名有效 |
| `issuing-ca-1/full-adcs` | full | 19 | — | 01-03 11:50 | 01-11 00:10 | 2 | `created` | AD CS 扩展集：CA Version、Next CRL Publish（01-10 12:00）、Freshest CRL、CRL Self CDP，均非关键 |
| `issuing-ca-1/delta-adcs` | delta | 20 | 19 | 01-03 17:50 | 01-05 06:10 | 2 | `created` | AD CS delta 扩展集：关键 Delta 指示、Next CRL Publish（01-04 18:00） |
| `issuing-ca-1/full-future` | full | 30 | — | 2099-01-01 00:00 | 2099-01-08 00:00 | 2 | `not_yet_valid` | GeneralizedTime 2099，任何时钟下都超前 |
| `issuing-ca-2/full-01` | full | 1 | — | 01-01 00:00 | 01-08 00:00 | 1 | `created` | certificateHold 条目 |
| `issuing-ca-2/delta-01` | delta | 2 | 1 | 01-01 12:00 | 01-03 00:00 | 1 | `created` | base 1 的 delta |
| `rogue-ca/full-01` | full | 1 | — | 01-01 00:00 | 01-08 00:00 | 0 | `issuer_not_found` | AKI 指向从不导入的证书 |
| `ed25519-ca/full-01` | full | 1 | — | 01-01 00:00 | 01-08 00:00 | 0 | `unsupported_algorithm` | Ed25519 签名 |
| `ed448-ca/full-01` | full | 1 | — | 01-01 00:00 | 01-08 00:00 | 0 | `unsupported_algorithm` | Ed448 签名 |

### D.3 无效输入（`invalid/`，6 个，期望都是 `invalid_crl`）

`garbage.txt`（文本）、`empty.bin`（0 字节）、`truncated.der`（DER CRL 的前 64 字节）、`truncated.pem`（缺 END 行的 PEM）、
`trailing-byte.der`（合法 CRL 后加一个 `0x00`）、`certificate.der`（把证书当 CRL 上传）。

### D.4 场景（`scenarios`，17 条；省略 `crls/` 与 `.der`）

| current | 上传 | 结果 |
| --- | --- | --- |
| — | `issuing-ca-1/full-01` | `created` |
| `issuing-ca-1/full-01` | `issuing-ca-1/full-01` | `unchanged` |
| `issuing-ca-1/full-01` | `issuing-ca-1/full-01.pem` | `unchanged` |
| `issuing-ca-1/full-01` | `issuing-ca-1/full-02` | `updated` |
| `issuing-ca-1/full-02` | `issuing-ca-1/full-01` | `stale_crl` |
| `issuing-ca-1/full-02` | `issuing-ca-1/full-02-conflict` | `conflict` |
| `issuing-ca-1/full-02` | `issuing-ca-1/full-02-reissued` | `updated` |
| `issuing-ca-1/full-02-reissued` | `issuing-ca-1/full-02` | `stale_crl` |
| `issuing-ca-1/full-03` | `issuing-ca-1/full-04-older-time` | `updated` |
| `issuing-ca-1/full-02` | `issuing-ca-1/full-no-number` | `non_orderable` |
| `issuing-ca-1/full-no-number` | `issuing-ca-1/full-02` | `non_orderable` |
| `issuing-ca-1/delta-01` | `issuing-ca-1/delta-02` | `updated` |
| `issuing-ca-1/delta-02` | `issuing-ca-1/delta-01` | `stale_crl` |
| `issuing-ca-1/delta-02` | `issuing-ca-1/delta-adcs` | `updated` |
| `issuing-ca-1/full-03` | `issuing-ca-1/full-adcs` | `updated` |
| `root-ca/full-01` | `root-ca/full-02` | `updated` |
| `root-ca/full-02` | `root-ca/full-02-resigned` | `conflict` |
