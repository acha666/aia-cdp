# aia-cdp：新项目规划（2026-10-17）

状态：规划文档，已按 owner 2026-10-17 的决策定稿；代码尚未搭建。
2026-10-18 修订：§0 决策 5、§2、§4、§6、§8、§10、§12、§13、§14，依据 `docs/review-2026-10-18.md`；
前端方案（决策 5、§8、切片 5b）待 owner 确认。

来源：`worker-aia-cdp` 仓库中的三份分析——`docs/refactoring-plan.md`（2026-10-15 修订）、
`docs/analysis-2026-10-13.md`、`docs/plan-review-2026-10-17.md`。本文只写新项目需要的东西，
不再复述对旧实现的逐项评审；凡沿用的业务规则在 §6 一次列全，旧实现要补齐的缺陷在 §10 列全。

## 0. 决策记录

| #   | 事项       | owner 决定（2026-10-17）                                                               |
| --- | ---------- | -------------------------------------------------------------------------------------- |
| 1   | HTTP 与契约 | Hono + `@hono/zod-openapi`；前端用 `hc` 类型客户端；ts-rest 与手写路由器退出         |
| 2   | 存储模型   | `config.json` + `catalog.json` + 内容寻址的不可变 blob；不用对象自定义元数据          |
| 3   | 管理通道   | 带独立管理令牌的 HTTP 管理接口；CLI 只是薄 HTTP 客户端                                |
| 4   | 首发后端   | memory、fs、R2；S3 兼容作为后续切片                                                   |
| 5   | 前端       | 2026-10-18 修订（待确认）：Vue 3 + vue-router + TanStack Query + shadcn-vue（Reka UI）+ Tailwind 4 重建；旧 UI 只迁移纯逻辑、扩展渲染块与测试；Pinia 退出。见 review §3 |
| 6   | 测试       | vitest                                                                                 |
| 7   | API        | 新 `/api/v1` 重新设计；下载 URL（`/ca/*`、`/crl/*`、`/dcrl/*`）不变；不再提供 v2      |
| 8   | 交付       | 先只写本文；确认后按 §12 切片 1 搭骨架                                                |

决策 3 的连带效果：所有写入都经过服务进程。fs 后端只需要进程内互斥，不需要跨进程文件锁
（`proper-lockfile` 不再需要）；Cloudflare 部署不需要 R2 的 S3 API 令牌，S3 适配器从
"Cloudflare 管理必需"降为"多实例 Node 可选"；旧方案里"演练 R2 S3 API 管理路径"的风险项消失。

## 1. 目标与非目标

目标：

- 一份代码，两种运行时：Cloudflare Workers + R2；Node 22 + 本地磁盘（Docker）。
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

版本为 2026-10-17 `npm view` 查到的最新版，锁定以 lockfile 为准。

| 领域          | 选型                                            | 版本                              | 说明                                                                                           |
| ------------- | ----------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------- |
| 运行时        | Node 22（固定）、Cloudflare Workers              | —                                 | `.nvmrc`、`engines` + `engine-strict`、`node:22-slim`                                          |
| 包管理        | pnpm 10（corepack）                              | —                                 |                                                                                                |
| HTTP          | `hono`                                          | 4.13.13                           | 路由、自动 HEAD、`methodNotAllowed`、`etag`、`bodyLimit`、`bearerAuth`、`secureHeaders`         |
| Node 服务器   | `@hono/node-server`                             | 2.1.5                             | `serve()` + `serve-static`；替代手写 `node:http` 桥                                            |
| 校验与 OpenAPI | `@hono/zod-openapi` + `zod`                    | 1.6.3 / 4.6.7                     | 路由声明即 schema，处理器返回值按状态码类型检查；构建时写出 `docs/openapi.json`                |
| 类型化客户端  | `hono/client` 的 `hc<AppType>`                  | 随 hono                           | 前端类型从服务端路由推导；`init: { cache: "no-store" }`                                        |
| PKI           | `pkijs` + `asn1js`                              | 3.4.1 / 3.1.0                     | 现有解析、扩展、验签、构建器迁入                                                               |
| 前端          | `vue`、`vue-router`、`@tanstack/vue-query`、`vue-i18n`、`tailwindcss`、`vite` | 3.5.44 / 5.4.0 / 5.104.4 / 11.4.16 / 4.3.3 / 8.3.4 | 2026-10-18 修订：vue-router 与 vue-query 新增，pinia 退出；vite 8 相对旧项目是大版本，切片 5b 迁入时核对变更说明 |
| UI 组件       | shadcn-vue（CLI）+ `reka-ui` + `class-variance-authority` + `clsx` + `tailwind-merge` + `lucide-vue-next` + `vue-sonner` | 2.8.2 / 2.11.0 / — / — / — / 1.0.0 / 2.0.9 | 组件源码生成到 `src/web/components/ui/`；备选 Naive UI 2.45（review §3.2） |
| 前端工具      | `@vueuse/core`                                   | 15.0.0                            | `useColorMode`、`useNow`（统一时钟快照）、`useClipboard`、`useStorage`                        |
| 测试          | `vitest`、`@vue/test-utils`、`happy-dom`        | 5.0.5 / 2.5.1 / 21.0.3            | HTTP 用 `app.request()` 进程内测；R2 用 wrangler `getPlatformProxy`                            |
| Cloudflare    | `wrangler`                                      | 4.151.1                           | `wrangler types` 生成绑定类型；不装 `@cloudflare/workers-types`                                |
| CLI           | `node:util` `parseArgs` + `fetch`               | 内置                              | 零依赖                                                                                         |
| 后续          | `@aws-sdk/client-s3`                            | 3.1152.0                          | S3 适配器切片，仅进 Node bundle                                                                |
| 质量          | `typescript` 5.9、`eslint` 10 + `typescript-eslint`、`prettier` 3 | —               |                                                                                                |

明确不用：`unstorage`（无条件写）、`@cloudflare/vitest-pool-workers`（R2 适配器几十行，
`getPlatformProxy` 一个测试够）、`ts-rest`（停更，锁 zod 3）、`aws4fetch`、`proper-lockfile`、
`srvx`、Express/Fastify（非 Workers 原生）。

## 3. 仓库布局

```text
aia-cdp/
  package.json  pnpm-lock.yaml  .nvmrc  .npmrc
  tsconfig.base.json  tsconfig.worker.json  tsconfig.node.json  tsconfig.web.json
  wrangler.jsonc  Dockerfile  vite.config.ts  vitest.config.ts  eslint.config.ts
  src/
    core/              纯 TS：不引用 node:*、process、R2Bucket
      pki/             解析、扩展、验签、PEM 编解码（迁入）
      summary/         证书 / CRL 摘要与 API 投影构建器（迁入 builders）
      store.ts         ObjectStore 端口
      catalog.ts       catalog.json / config.json 的 schema、读取、条件写与重试
      resources.ts     路径表解析、配置校验、下载策略
      import.ts        importCertificate(deps, bytes)
      publish.ts       publishCrl(deps, bytes, now)
      admin.ts         applyConfig / retireTarget / deleteCertificate / listHistory
    http/
      app.ts           createApp(deps) → OpenAPIHono；中间件与挂载顺序
      routes/          health.ts  certificates.ts  crls.ts  stats.ts  admin.ts  downloads.ts
      schemas.ts       API v1 的请求 / 响应 / 错误 schema
      errors.ts        ApiError、onError、defaultHook → 错误信封
    storage/           memory.ts  fs.ts  r2.ts（s3.ts 后续）
    runtime/
      worker.ts        export default { fetch }
      node.ts          serve + serveStatic + SIGTERM
      settings.ts      环境变量 schema（zod）
    cli/aia.ts         薄 HTTP 客户端
    web/               Vue UI（迁入）
  tests/
    core/  http/  storage/  web/  integration/
    fixtures/          generate-test-data.sh（迁入，幂等，不提交私钥）
  scripts/             adcs-crl-uploader.ps1  generate-openapi.ts  migrate-from-v2.ts
  docs/                plan.md（本文）  api.md  operations.md  openapi.json
```

边界检查就是编译两次：`tsconfig.worker.json`（core + http + storage/r2 + runtime/worker，
用 `wrangler types` 的输出）与 `tsconfig.node.json`（core + http + storage/fs + runtime/node +
cli + tests）各编译一遍 `src/core` 与 `src/http`，任何平台全局引用都会在其中一个项目报错。
不另设 ESLint 导入边界规则和 bundle 卫生断言。

## 4. 运行时与配置

### 4.1 Cloudflare Workers

- `wrangler.jsonc`：`main: src/runtime/worker.ts`；`r2_buckets: [{ binding: "STORE" }]`；
  `assets: { directory: "dist/web", binding: "ASSETS", run_worker_first: true,
  not_found_handling: "single-page-application" }`（history 路由的兜底）。
- 入口：按 `env` 构造一次 deps（模块级缓存），`app.fetch(req, env)`；未命中路由时
  `env.ASSETS.fetch(req)`。
- 令牌用 `wrangler secret put AIA_ADMIN_TOKEN` / `AIA_UPLOAD_TOKEN`；其余设置用 `vars`。

### 4.2 Node / Docker

| 变量                                 | 默认                 | 说明                                                 |
| ------------------------------------ | -------------------- | ---------------------------------------------------- |
| `PORT`                               | `8080`               |                                                      |
| `AIA_STORE`                          | `fs`                 | `fs`；后续 `s3`                                      |
| `AIA_DATA_DIR`                       | `/data`              | fs 根目录；一个服务进程对应一个目录                  |
| `AIA_STATIC_DIR`                     | `./dist/web`         | UI 构建产物                                          |
| `AIA_ADMIN_TOKEN` / `_FILE`          | 无                   | 未设置时管理接口返回 503 `admin_disabled`            |
| `AIA_UPLOAD_TOKEN` / `_FILE`         | 无                   | 未设置时上传不需要令牌                               |
| `AIA_MAX_UPLOAD_BYTES`               | `10485760`           | `bodyLimit`                                          |
| `AIA_TRUST_PROXY`                    | `false`              | 为真时日志记录 `X-Forwarded-For`                     |
| `AIA_LOG_FORMAT`                     | `json`               | `json` / `pretty`                                    |

启动时用 zod 校验全部变量，失败即退出并打印原因。

Dockerfile：多阶段，`node:22-slim`；阶段一 `pnpm install` + `vite build` + `tsc -p
tsconfig.node.json`；阶段二只复制 `dist/`、生产依赖与 `package.json`，非 root 用户，
`VOLUME /data`，exec 形式 `CMD ["node", "dist/server/runtime/node.js"]`，
`HEALTHCHECK` 用 `node -e "fetch(...)"` 探 `/api/v1/health`（200 即健康，含 `degraded`）。
`SITE_NAME` 只在 `vite build` 时通过 `VITE_SITE_NAME` 注入（Docker `ARG`）。

静态资源：`serveStatic({ root: AIA_STATIC_DIR })`；未命中文件且路径不以 `/api/`、`/ca/`、`/crl/`、
`/dcrl/` 开头时返回 `index.html`（history 路由），其余 404。反向代理不得对下载前缀做 HTTPS 跳转
（AIA/CDP 客户端只走明文 HTTP）。

### 4.3 日志

一个自写的小中间件：每请求一行 JSON（method、path、status、ms、可选 client），
每次发布 / 导入尝试一行（targetId 或 certificateId、outcome 或 reason、sha256）。
Node 写 stdout，Workers 用 `console.log`（Workers Logs 自动收集）。不记录令牌和请求体。

## 5. 存储模型

### 5.1 对象布局（所有后端相同）

```text
config.json                                          操作员拥有；管理接口整体替换
catalog.json                                         服务拥有；导入与发布条件写
blobs/certificates/<sha256>.der                      不可变
blobs/crls/<targetId>/<thisUpdate UTC 紧凑格式>-<sha256>.der   不可变；当前与历史共用
```

键全部由服务生成（hex、uuid、固定名），不存在操作员命名的键，因此不需要键编码、长度、
大小写规则。fs 适配器仍防御性拒绝含 `..` 的键。

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
- 已有证书路径不能改绑到另一证书（证书下载是 `immutable` 缓存）；更换 CA 证书用新路径。
- 删除目标前，该目标的 `current` 必须已被 retire 清空；被目标或路径引用的证书不能删除。

### 5.3 `catalog.json`（服务）

```jsonc
{
  "version": 1,
  "certificates": {
    "<sha256>": {
      "key": "blobs/certificates/<sha256>.der",
      "size": 1234,
      "importedAt": "2026-10-17T00:00:00Z",
      "summary": { "subjectCN": "…", "issuerCN": "…", "serialNumber": "…", "notBefore": "…",
                   "notAfter": "…", "subjectKeyId": "…", "authorityKeyId": "…", "sha1": "…" }
    }
  },
  "targets": {
    "<uuid>": {
      "current": {
        "sha256": "…", "key": "blobs/crls/<uuid>/<thisUpdate>-<sha256>.der", "size": 4567,
        "publishedAt": "…", "verifier": "<sha256>",
        "summary": { "crlNumber": "42", "baseCrlNumber": null, "thisUpdate": "…",
                     "nextUpdate": "…", "revokedCount": 1, "sha1": "…" }
      }
    }
  }
}
```

catalog 只存当前指针，大小与资源数成正比，不随发布次数增长。历史就是
`blobs/crls/<uuid>/` 下的文件列表，键名自带签发时间与摘要，由管理接口列出。

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

ETag 对调用方不透明，只回传给同一后端；HTTP 层的 `ETag` 永远来自内容摘要。

| 适配器 | 条件写                                                                 | ETag            | 规模    |
| ------ | ---------------------------------------------------------------------- | --------------- | ------- |
| memory | 同步比较后写入                                                         | 内容 SHA-256    | ~40 行  |
| fs     | 临时文件 + `rename`；条件判断在进程内互斥段里读当前文件摘要后完成       | 内容 SHA-256    | ~80 行  |
| r2     | `onlyIf: { etagMatches }` / `{ etagDoesNotMatch: "*" }`，返回 `null` 即前置条件失败 | `R2Object.etag` | ~60 行  |

一致性测试约 10 条用例（put/get/head、`ifMatch` 成功与失败、`ifNoneMatch`、前缀列表、
delete），memory 与 fs 每次运行，r2 在 Cloudflare CI 任务里经 `getPlatformProxy` 运行。

### 5.5 写入顺序

`publishCrl(deps, bytes, now)`，与 HTTP 无关：

1. 按字节识别 PEM/DER，得到 DER 与 `sha256`。
2. 解析 AKI、CRL 号、delta 指示、扩展、时间；时间解码失败、`thisUpdate` 超前 5 分钟以上、
   未识别的关键扩展、关键 IDP 各是独立拒绝原因。
3. 读 `config.json` 与 `catalog.json`（各一次 `get`，记下 catalog 的 ETag）。
4. 用 AKI 在 catalog 的证书摘要里找 SKI 相等的证书，再在 config 里找绑定它且 kind 匹配的目标。
   找不到证书是 `issuer_not_found`，证书存在但无目标是 `target_not_configured`。
5. 读签发者 DER（按已知键），验签。
6. 与 `targets[id].current` 比较：`sha256` 相等即 `unchanged`，不写；否则按 catalog 里的
   `crlNumber` / `thisUpdate` 摘要判新鲜度，不必再读当前 DER。
7. `put` blob（内容寻址，无条件，幂等）。
8. `put catalog.json` 带 `ifMatch` 更新 `current`。失败则重读 catalog 回到第 6 步，
   最多三次（250 ms、500 ms、1 s 退避），之后返回 `concurrent_update`。
9. 返回 `created`（之前无 current）或 `updated`。

第 7 步后崩溃只留下一个无人引用的 blob，无害；第 8 步成功即完成，不存在"权威写成功但
派生写失败"的状态。R2 对单键每秒一次写的限制只落在 `catalog.json` 上，AD CS 助手是顺序上传的。

`importCertificate` 同理：解析、生成完整摘要、写 blob、条件更新 catalog；重复导入 `unchanged`。
`applyConfig` 校验 §5.2 规则后用 `ifMatch` 替换 `config.json`，首次用 `ifNoneMatch: "*"`。

### 5.6 读取

每个请求读一次 `config.json` 与 `catalog.json`（两个小对象）再读 blob。进程内按 ETag 备忘、
5 秒 TTL 是唯一允许的优化，默认关闭，切片 5 测量后再决定开不开。

## 6. 领域规则（沿用旧方案，不再讨论）

- 身份：证书 `certificateId` = DER 的 SHA-256；CRL 目标 `targetId` = 创建时分配的 UUID；
  内容版本 = `contentSha256`。CN、文件名不参与身份、授权和路径。
- 验证：AKI/SKI 匹配 + 签名验证；`issuer_mismatch` 指 AKI 解析到的证书不是该目标配置的
  签发者；不比较签发者名称、不检查 `cRLSign` 和签发者有效期；Ed25519/Ed448 报
  `unsupported_algorithm`。
- 新鲜度：先比字节（相等 → `unchanged`），再比 CRL 号，再比 `thisUpdate`；号相等且
  `thisUpdate` 相等但字节不同 → `conflict`；CRL 号只在一侧存在 → `non_orderable`；更旧 → `stale_crl`。
- 时钟：注入的 `now` 是唯一时间源；`thisUpdate` 超前 5 分钟以上拒绝 `not_yet_valid`；
  `nextUpdate` 已过去的 CRL 接受并记录日志。
- 扩展：识别列表为关键 `2.5.29.27`（delta 指示）、`2.5.29.28`（IDP）、非关键 `2.5.29.20`、
  `2.5.29.35`、`2.5.29.46` 与 AD CS 私有 `1.3.6.1.4.1.311.21.1 / .4 / .14`。关键 IDP 视为
  作用域 CRL，拒绝 `scoped_crl_unsupported`；其他未识别关键扩展拒绝 `unknown_critical_extension`。
  未识别的非关键扩展保留原始字节在详情里展示。
- delta 与 base 相互独立：记录并展示 `baseCrlNumber`，不与已发布 full CRL 对账。
- 下载：路径表命中 → 资源 → catalog 的 current → 先用摘要生成 `ETag`（DER `"<sha256>"`，
  PEM `"<sha256>-pem"`）→ `If-None-Match` 命中直接 304 → 否则读 blob，DER 原样、PEM 现场派生。
  `Content-Length` 显式设置（Node 侧 HEAD 不会自动带）。目标存在但未发布 → 404。
  `Content-Disposition: attachment; filename="<路径最后一段>"`，与线上一致。
- 内容类型：DER 证书 `application/pkix-cert`，DER CRL `application/pkix-crl`，
  PEM `application/x-pem-file`。
- 缓存：证书 `public, max-age=31536000, immutable`；CRL `public, max-age=clamp(nextUpdate − now,
  60 s, 3600 s), must-revalidate`，无 `nextUpdate` 时 300 s；API JSON `no-store`；
  `openapi.json` `max-age=300`；UI 哈希资源 `immutable`，`index.html` `no-cache`。
- 退役：删路径即 404；`retire` 清空目标 current 并保留历史 blob；被引用的证书不可删除。
- 上传安全：`bodyLimit` 永远开；可选 `AIA_UPLOAD_TOKEN`；Node 部署的限速交给反向代理，
  文档写明。

## 7. HTTP API v1

### 7.1 公开路由

| 方法与路径                        | 用途                                                   | 状态                                                    |
| --------------------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| `GET /api/v1/health`              | `status`: healthy / degraded / unhealthy；`checks.store`、`checks.configuration` | 200；store 不可读 503          |
| `GET /api/v1/certificates`        | 完整数组（无分页）                                     | 200                                                     |
| `GET /api/v1/certificates/{id}`   | 详情：主体 / 签发者、有效期、SKI/AKI、指纹、签名算法（含参数）、扩展、`downloads`、`targets` | 200 / 404 |
| `GET /api/v1/crls`                | 每个目标一项，`current` 为摘要或 `null`                | 200                                                     |
| `GET /api/v1/crls/{targetId}`     | 详情：签发者证书 id、CRL 号、base 号、时间、吊销条目、扩展、`downloads` | 200 / 404                      |
| `POST /api/v1/crls`               | 上传 CRL：multipart 字段 `crl`，或原始 body（`application/pkix-crl` / `application/x-pem-file` / `application/octet-stream`） | 201 created；200 updated / unchanged；400 / 401 / 409 / 413 / 415 / 422 |
| `GET /api/v1/stats`               | 证书数、目标数、已发布数、吊销总数（未知为 `null`）、DER 字节数 | 200                                             |
| `GET /api/v1/openapi.json`        | 构建时生成的文件                                       | 200                                                     |

上传成功体：

```json
{ "outcome": "created", "target": "<uuid>", "kind": "full", "sha256": "…",
  "crlNumber": "42", "thisUpdate": "…", "nextUpdate": "…",
  "downloads": ["/crl/issuing-ca-1.crl", "/crl/issuing-ca-1.crl.pem"] }
```

### 7.2 管理路由（`Authorization: Bearer <AIA_ADMIN_TOKEN>`）

| 方法与路径                                            | 用途                                            | 状态                        |
| ----------------------------------------------------- | ----------------------------------------------- | --------------------------- |
| `POST /api/v1/admin/certificates`                     | 导入证书（PEM/DER，multipart 或原始 body）       | 201 created / 200 unchanged / 422 |
| `DELETE /api/v1/admin/certificates/{id}`              | 删除未被引用的证书（blob 一并删除）              | 204 / 409 `referenced`      |
| `GET /api/v1/admin/config`                            | 当前 `config.json` 与 `ETag`                     | 200 / 404（尚未配置）       |
| `PUT /api/v1/admin/config`                            | 整体替换；`If-Match` 必填，首次 `If-None-Match: *` | 200 / 412 / 422 `config_invalid` |
| `GET /api/v1/admin/crls/{targetId}/history`           | 历史 blob 列表（thisUpdate、sha256、size）        | 200                         |
| `GET /api/v1/admin/crls/{targetId}/history/{sha256}`  | 下载历史 DER                                     | 200 / 404                   |
| `POST /api/v1/admin/crls/{targetId}/retire`           | 清空 current，历史保留                           | 200                         |

未设置 `AIA_ADMIN_TOKEN` 时全部管理路由返回 503 `admin_disabled`。令牌比较用 Hono
`bearerAuth`（常量时间）。

### 7.3 信封、错误、中间件

- 成功：直接返回资源体，不包 `{ data }`。
- 失败：`{ "error": { "code": "…", "message": "…", "details"?: … } }`，每个状态码一个 schema。
- 错误码：`bad_request`、`unauthorized`、`not_found`、`method_not_allowed`、
  `payload_too_large`、`unsupported_media_type`、`admin_disabled`、`precondition_failed`、
  `config_invalid`、`referenced`、`invalid_crl`、`invalid_certificate`、`not_yet_valid`、
  `unknown_critical_extension`、`scoped_crl_unsupported`、`unsupported_algorithm`、
  `issuer_not_found`、`target_not_configured`、`invalid_signature`、`issuer_mismatch`、
  `stale_crl`、`conflict`、`non_orderable`、`concurrent_update`、`internal`。
- 中间件顺序：`secureHeaders` → 请求日志 → `methodNotAllowed({ app })` →
  `/api/v1/admin/*` 的 `bearerAuth` → `POST /api/v1/crls` 的可选 `bearerAuth` + `bodyLimit` →
  路由 → `app.onError` 统一 500 信封，不泄漏异常文本。
- `app.doc31()` 运行时可用于开发；`scripts/generate-openapi.ts` 调 `getOpenAPI31Document()`
  写出 `docs/openapi.json`，CI 检查漂移，服务端从文件返回。

### 7.4 CLI

`aia` 读取 `AIA_URL` 与 `AIA_ADMIN_TOKEN(_FILE)`，子命令：
`import <file...>`、`config show | validate <file> | apply <file>`、`publish <file...>`
（走公开上传路由，可带 `AIA_UPLOAD_TOKEN`）、`history <targetId>`、`retire <targetId>`、
`delete-certificate <id>`、`health`。`config validate` 在本地用同一份 schema 与规则校验，
不需要连服务。参数解析用 `parseArgs`，输出为表格或 `--json`。

## 8. 前端

2026-10-18 修订（待 owner 确认；评估与候选对比见 `docs/review-2026-10-18.md` §3）：不再整体迁入旧
`src/web`，而是在同一技术线（Vue 3 + Tailwind 4）上用组件库重建；旧代码只迁移纯逻辑与测试。

- 基座：`vue-router`（history 模式）；`@tanstack/vue-query`（列表 / 详情 `useQuery`，上传
  `useMutation` 后 `invalidateQueries`，`staleTime: 0`）；shadcn-vue 生成的组件（Reka UI 原语，
  源码在 `src/web/components/ui/`）；`@vueuse/core`（`useColorMode`、`useNow`、`useClipboard`、
  `useStorage`）；`vue-sonner`（上传结果 toast）；`lucide-vue-next`。Pinia 退出：服务端数据归
  vue-query，UI 偏好归 `useStorage`。
- 路由：`/`（总览）、`/certificates/:id`、`/crls/:targetId`。未知路径由 Workers
  `not_found_handling: "single-page-application"` 与 Node 的 `index.html` 兜底返回应用。
- 总览：统计条（证书数、目标数、已发布、即将过期）；证书表（CN、签发者、有效期、状态徽标、
  DER/PEM 下载）；CRL 目标表（标签、full/delta、CRL 号、thisUpdate / nextUpdate、状态、下载，
  未发布显示"未发布"）；上传卡片（拖放 + PEM 粘贴；created / updated / unchanged 各有文案，
  错误按 `error.code` 映射 i18n，toast + 行内 Alert）。
- 详情：Tabs = 概览（DN 表含 `rfc4514`、有效期、公钥与签名算法含参数、指纹）、扩展（Accordion；
  每个解析结果映射为 render block：rows / tags / general names / distribution points / access /
  policies / subtrees；未识别或解码失败显示 ASN.1 结构 dump 与原始 hex）、吊销列表（表格：
  序列号、吊销时间、原因、失效起始、间接签发者；`revokedCount` 为 `null` 时显示"未知"；
  > 200 行启用 `@tanstack/vue-table` 分页）。
- 从旧实现迁移：`utils/status.ts`、`utils/dates.ts`、`utils/format.ts`、`utils/x509.ts`、
  `useCrlUploadInput`、`ExtensionView` 的 render-block 映射、`GeneralNameList` /
  `DistributionPointList` / `Asn1Dump`，以及 `tests/web` 的状态与上传输入用例（改写为 vitest）。
- 客户端：`const api = hc<AppType>("", { init: { cache: "no-store" } })`，作为 vue-query 的
  `queryFn`；删除 `readApiResponse`、`validateResponse`、`pagination.ts`、`collectPages`。
- 下载链接来自 API 的 `downloads`；状态徽标与相对时间共用 `useNow({ interval: 60_000 })`。
- `SITE_NAME` 只来自 `import.meta.env.VITE_SITE_NAME`；页脚不再写 "Cloudflare Workers"。
- i18n：`en` 与 `zh-CN`，跟随浏览器并可切换。
- 构建到 `dist/web`，两条运行时都从这里提供。`shadcn-vue init` 的 `components.json` 与 Vite
  别名在切片 1 骨架里先验证。

## 9. AD CS 助手

`scripts/adcs-crl-uploader.ps1` 重写要点：仅 PowerShell 7；`Invoke-RestMethod -Method Post
-ContentType application/pkix-crl -Body <bytes>`，不再手搓 multipart；新增
`-UploadTokenFile`（令牌从受保护文件读，不进任务命令行）；按字节识别 PEM/DER；
created / updated / unchanged 都算成功；本地摘要账本 `published.json`（路径 → sha256）跳过
已发布文件；从未被接受的文件返回 `stale_crl` 算失败（CA 产出了比已发布更旧的东西）；
退出码 0 / 1；事件 68/69/70 触发与定时补扫不变。改动用一次手动 Windows 运行验证并记录。

## 10. 要补齐的旧实现缺陷

| #   | 旧实现问题                                                              | 新项目处理                                              | 切片 |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------- | ---- |
| 1   | 下载无 304、无 `Content-Length`、`ETag` 未加引号                         | §6 下载规则                                              | 3    |
| 2   | 下载路径暴露 `archive/`、`by-keyid/` 与任意对象；详情接受归档 id         | 路径表 + catalog，请求路径不做发现                       | 3, 5 |
| 3   | CRL `max-age` 无上限，`nextUpdate` 过后降为 0                            | clamp [60 s, 3600 s]，无 `nextUpdate` 300 s              | 3    |
| 4   | 相同 CRL 重复上传返回 409，UI 显示失败                                   | `unchanged` 200                                          | 4, 5 |
| 5   | PEM / alias / archive 伴随写失败使成功发布报 500；`caches.default` 在 Node 上崩 | 无伴随写、无边缘缓存，单提交点                   | 2, 4 |
| 6   | 归档写无条件，重试覆盖来源信息；并发发布无保护                           | 内容寻址 blob + catalog 条件写重试                       | 4    |
| 7   | `revokedCount` 未知时显示 0                                              | 可空字段，UI 显示"未知"                                  | 5    |
| 8   | 详情缺 `signatureAlgorithm`；算法 `parameters` 从不输出；契约含永不产生的变体 | 2026-10-18 已在旧实现完成（参数解码、`SignatureValue.parsed`、死变体清理待新契约）；切片 5a 迁入 | 5a |
| 9   | 全 null 信封通过 200 校验变成空列表                                      | 按状态码 schema，无可空信封                              | 5    |
| 10  | `relationships` 永远为空                                                 | 从配置填充证书 `targets` 与 CRL `issuer`                 | 5    |
| 11  | 畸形 ASN.1 时间解码成 1899 并进入新鲜度判断                              | 2026-10-18 已在旧实现完成（`pki/asn1.ts` 严格时间，解析期拒绝）；切片 4 迁入 | 4    |
| 12  | 未来 `thisUpdate`、未知关键扩展、作用域 CRL 无策略                       | 时钟策略与识别列表                                       | 4    |
| 13  | `constructor.name` 判编码，压缩后退化为 unknown                          | 按字节识别 PEM/DER                                       | 2    |
| 14  | 证书只能手工放进 R2 `ca/`，摘要靠请求时补全                              | 导入接口，导入时生成完整摘要                             | 2    |
| 15  | 健康检查硬编码 cache ok，从不降级                                        | 真实 store / configuration 检查，`degraded` 状态          | 1    |
| 16  | 统计按桶前缀字节                                                         | 按资源计数与字节                                         | 5    |
| 17  | ts-rest 忽略 `no-store`，上传后 30 秒内读到旧数据                        | `hc` 的 `init` + API `no-store`                          | 5    |
| 18  | `SITE_NAME` 四条通道三条是死的                                           | 仅构建时                                                 | 1, 5 |
| 19  | 上传无体积上限、无鉴权                                                   | `bodyLimit` + 可选令牌                                   | 4    |
| 20  | 助手含 PS5 死分支、手搓 multipart、按扩展名判格式、409 当失败            | §9                                                       | 4    |
| 21  | 测试 glob 依赖 shell；组件测试钩子失败挂起整个运行；`pretest` 重生成夹具打乱本地状态 | vitest；幂等夹具生成                        | 1    |
| 22  | 没有 Node / Docker 运行方式                                              | `runtime/node.ts` + Dockerfile                           | 1    |
| 23  | 没有退役、删除、历史查看的管理路径                                       | 管理接口 + CLI                                           | 2, 6 |
| 24  | 日志无结构                                                               | JSON 行                                                  | 1    |
| 25  | `thisUpdate` 缺失时序列化为空字符串                                      | 时间字段必填，缺失即拒绝                                 | 4    |
| 26  | 文档与代码多处不一致                                                     | OpenAPI 从代码生成；README、api.md、operations.md 重写   | 6    |
| 27  | 详情解析覆盖不足：AD CS 私有扩展（CA Version、模板名、Next CRL Publish、CRL Self CDP）、Freshest CRL、IDP、Name/Policy Constraints 等全是 `unsupported`，`1.3.6.1.4.1.311.21.1` 被错标为模板名；DN 编码靠 `constructor.name`；无 `rfc4514`、无 ECDSA (r, s) | 2026-10-18 已在旧实现完成（解析器 13 → 41 个，`tests/data/adcs.ts` 用线上工件回归）；切片 5a 原样迁入 | 5a |
| 28  | 未识别扩展只给 hex；UI "签名算法"显示 Unknown（store 未请求该字段）       | 未识别 / 错误扩展附带 ASN.1 结构 dump（已完成）；新 UI 详情一次取全部分区 | 5a, 5b |

## 11. 测试与 CI

- vitest `projects`：`core`、`http`、`storage`（node 环境）；`web`（happy-dom）；
  `integration`（node）。HTTP 测试通过 `createApp({ store: new MemoryStore(), now, … }).request()`
  进程内运行，不起端口。
- 夹具：`tests/fixtures/generate-test-data.sh` 迁入，按生成脚本内容摘要打戳，只在脚本变化时
  重生成；私钥不提交。现有签名 CRL 夹具覆盖 created / updated / unchanged / stale / conflict /
  broken-sig / delta / invalid。
- 存储一致性：memory 与 fs 每次运行；r2 测试读 `AIA_TEST_R2=1` 才启用，用
  `getPlatformProxy({ configPath: "wrangler.jsonc" })` 拿到 `STORE`。
- Node 集成：在临时目录起真实服务与 fs 存储，走 CLI import → config apply → 上传 →
  列表 / 详情 → DER / PEM / HEAD / 304 下载 → 重复上传 unchanged → 过期拒绝 → retire → 404。
- Worker：`wrangler deploy --dry-run --outdir`；可选 `wrangler dev` 冒烟（health 与一次下载）。
- Docker：构建镜像、启动、健康检查返回 `degraded`、`config apply` 后一次下载。
- CI 四个任务：`check`（三个 tsconfig、lint、format、OpenAPI 漂移）、`test`（单元 + 集成）、
  `worker`（dry-run + R2 一致性）、`docker`。`pnpm verify` = check + test + build。

## 12. 实施切片

每个切片一个 PR，可独立评审。

| 切片 | 内容                                                                                                              | 出口条件                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1 骨架 | 依赖、三个 tsconfig、`createApp` 仅含 health 与静态资源、Worker 与 Node 入口、Dockerfile、vitest、CI、夹具脚本迁入、日志中间件 | 两条运行时提供 UI 占位页与 `/api/v1/health`；`deploy --dry-run` 通过；镜像健康检查通过 |
| 2 存储与导入 | 端口、memory/fs/r2 适配器、一致性测试、catalog/config schema 与条件写重试、`importCertificate`、`applyConfig`、管理路由 import/config、CLI import/config | 一致性测试 memory/fs 绿，r2 经 `getPlatformProxy` 绿；CLI 在 fs 与本地 R2 上导入并应用配置 |
| 3 下载 | 路径表解析、下载路由、PEM 派生、ETag/304/`Content-Length`/`Cache-Control`、405                                   | 多个路径读同一 blob；内部键不可达；GET/HEAD 在两条运行时字节一致                          |
| 4 发布 | `publishCrl`、上传路由、三种结果与拒绝原因、`bodyLimit`/`bearerAuth`、发布日志、AD CS 助手重写                   | 夹具覆盖 created/updated/unchanged/stale/conflict/并发/过期/未来/未知关键扩展；助手手动验证 |
| 5a API 与客户端 | 列表 / 详情 / 统计路由、OpenAPI 生成与漂移检查、`hc` 类型导出、PKI 构建器迁入（含 2026-10-18 在旧实现补齐的扩展解析与 `tests/data/adcs.ts` 回归工件） | 处理器返回值受类型检查；`openapi` 漂移检查通过；构建器用例在 vitest 下全绿 |
| 5b UI | §8 的路由、组件库、vue-query、总览与详情页、上传、zh-CN；`shadcn-vue init` 在切片 1 已验证 | web 测试与 UI 场景通过；两条运行时的 SPA 兜底可用；产物 < 250 KB gzip |
| 6 管理补全与文档 | history / retire / delete 路由与 CLI、README、`docs/api.md`、`docs/operations.md`（含迁移与回滚手册）     | 每个职责只有一个实现；`pnpm verify` 与四个 CI 任务全绿                                     |
| 7 迁移 | `scripts/migrate-from-v2.ts`、在非生产环境演练、生产切换                                                        | 路径表每条 URL 返回与旧 URL 相同的 DER 摘要；旧对象未删；回滚手册验证过                   |
| 8 S3（按需） | `storage/s3.ts`（`@aws-sdk/client-s3`，`IfMatch` / `IfNoneMatch`）、MinIO 可选 CI 任务、多实例部署说明     | 一致性测试对 MinIO 绿                                                                     |

## 13. 从现有部署迁移

新服务与旧 Worker 可以共用同一个 R2 桶：新布局的前缀（`config.json`、`catalog.json`、
`blobs/`）与旧前缀（`ca/`、`crl/`、`dcrl/`、`by-keyid/`、`archive/`）不相交，旧对象原样不动。

`scripts/migrate-from-v2.ts` 只是两个 HTTP 客户端，不碰 R2：

1. 从旧服务 `GET /api/v2/certificates` 与 `/ca/<file>` 取每张证书的 DER，
   `POST /api/v1/admin/certificates` 导入，记录 id。
2. 从旧服务 `GET /api/v2/crls` 取每个 full / delta CRL 的当前对象与签发者，为每个
   （签发者, kind）生成一个 target UUID，按旧 URL 生成 `config.json` 的路径表，
   `PUT /api/v1/admin/config`。
3. 对每个当前 CRL `POST /api/v1/crls`（正常发布路径，期待 created）。
4. 历史：旧归档键为 `crl/archive/<base>-<crlNumber>-<sha256>.crl`、`dcrl/archive/...`，可枚举且
   自带 CRL 号。脚本按 CRL 号顺序下载、解析 `thisUpdate` 后作为历史 blob 写入（需要一条仅迁移期
   使用的管理路由 `POST /api/v1/admin/crls/{targetId}/history`，切片 7 加、迁移后删）。
   只有无法枚举时才从切换日起算。此项见 §14。
5. 校验：对路径表逐条 GET 旧站与新站，比较 `sha256`。

切换：暂停 AD CS 计划任务 → 把自定义域 / 路由指到新 Worker（Node 部署则改 DNS 或代理）→
更新助手的 `UploadUri` → 恢复任务 → 观察一次 `updated` 或 `unchanged`。
回滚：路由指回旧 Worker，旧对象一直都在。确认稳定后再手工删除旧前缀对象。

## 14. 本文自行取的默认值（可推翻）

1. 成功响应直接返回资源体，不包 `{ data }`。
2. 上传同时接受 multipart 字段 `crl` 与原始 body。
3. 未设置管理令牌时管理路由返回 503，而不是 404。
4. 公开路径只允许 `/ca/`、`/crl/`、`/dcrl/` 三个前缀；PEM 变体自动派生，不单独配置。
5. 证书路径不允许改绑；`config.json` 整体替换而不是逐条增删接口。
6. 公开 API 的 `DELETE /admin/certificates/{id}` 保留在首发里（约 30 行）。
7. 进程内 config/catalog 备忘默认关闭。
8. Node 侧用 `tsc` 编译到 `dist/server`，不做单文件打包。
9. 历史迁移：旧归档键可枚举且含 CRL 号，按 CRL 号顺序迁入；无法枚举时才从切换日起算（2026-10-18 改）。
10. i18n 保留现有 `en`，切片 5b 补 `zh-CN`（2026-10-18 改）。
11. 新项目目录 `~/aia-cdp`，仓库名同名；本文件路径 `docs/plan.md`。
