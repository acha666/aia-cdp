# 切片 3：下载

## 目标与范围

按路径表提供 `/ca/*`、`/crl/*`、`/dcrl/*` 的 DER 与读取时派生的 PEM：摘要 `ETag`、304 不读 blob、GET 与 HEAD 都显式带
`Content-Length`、按种类定 `Content-Type` / `Cache-Control`（CRL 夹紧）、净化 filename、纯文本 404 / 405。
处理 `§10 #1`、`§10 #2`（下载部分）、`§10 #3`，以及 `C6`、`C7`、`C12`（回归）、`C13`、`M17`（下载侧）、`M18`、`M19`、`M20`、`M22`。

不在本切片：发布与上传（切片 4）；配置路径规则——字符集、只写 DER 路径、前缀与种类一致、证书路径不改绑（切片 2）；
详情接受归档 id（`§10 #2` 的另一半）与 API 的 `downloads` 字段（切片 5a）；plan §5.6 备忘的测量（切片 5a）；
`docs/operations.md` 的头差异清单（切片 6）；CryptoAPI 冒烟（切片 7）。

## 前置

- 切片 1：`createApp(deps)`（`src/http/app.ts`）、保留前缀 notFound（B7）、`methodNotAllowed` + `onMethodNotAllowed`（`src/http/errors.ts`）、
  `secureHeaders`（B8）、`deps.log`；memory / fs / r2 适配器；`tests/http/app.test.ts`；基于 `createTestHarness` 的 Worker 冒烟。
- 切片 2：`src/core/catalog.ts` 的 config / catalog schema 与读取；`src/core/pki/pem.ts`（`derToPem`、`PEM_BLOCK_MARKERS`）；
  `src/core/summary/catalog-summary.ts`；管理路由与 CLI 的 import / config。
- 依赖、不重复校验的配置不变量（切片 2 `applyConfig` 保证）：路径表只含 DER 路径、不以 `.pem` 结尾；前缀与种类一致；
  被引用的证书在 catalog 中。

## 步骤

1. **PEM 字节格式定为规范（M22）**。`src/core/pki/pem.ts`：`derToPem` 不改（64 列 base64、LF、末尾换行；
   `worker-aia-cdp@5b570aa:src/worker/pki/pem.ts:52-66`）；新增 `pemLength(derSize, markers)` =
   `begin.length + end.length + b64 + ceil(b64 / 64) + 2`，`b64 = 4 * ceil(n / 3)`。`"<sha256>-pem"` 与 HEAD 长度都依赖
   这个格式，改换行或列宽必须同时换 ETag 后缀。
2. **路径表解析**。`src/core/resources.ts` 新增纯函数 `resolveDownload(config, catalog, path)`，返回 `found`（`kind`、`format`、
   `sha256`、`key`、`size`、`filename`、`nextUpdate`、`lastModified`）/ `not_found` / `inconsistent`：
   - `Object.hasOwn(config.paths, path)` 精确匹配、区分大小写 → DER；否则以 `.pem` 结尾且去后缀后命中 → PEM；其余 `not_found`。
   - 证书 → `catalog.certificates[id]`；目标 → `catalog.targets[id]?.current`，缺失或为空（未发布、已 retire）→ `not_found`（plan §6）。
   - 路径引用的证书不在 catalog，或引用的目标不在 `config.targets` → `inconsistent`（例如删除证书与 `applyConfig` 竞争）。
   - 请求路径取 `c.req.path`（Hono 按 `decodeURI` 解码）；不再 `decodeURIComponent`，请求路径也不再当存储键
     （改写 `worker-aia-cdp@5b570aa:src/worker/worker.ts:59-69`）。`src/worker/api/v2/shared/resource.ts` 不迁。
   匹配规则（M20；hono 4.13.13 探针验证）：

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
   每个 200 分支都显式设 `Content-Type`：hono 4.13.13 + `@hono/node-server` 2.1.5 真实 socket 探针里未设时 GET 被补成
   `text/plain; charset=UTF-8`、HEAD 没有。`c.body` 只收 `Uint8Array<ArrayBuffer>`（Hono `Data` 类型），端口 `get`
   的返回类型按 B3 写，不在下载路径上复制。不支持 `Range`（忽略，200 全量，旧实现同）。旧 `worker.ts:79-83` 的"HEAD 读整对象"不保留。
5. **挂载与 405（M19、C12）**。`src/http/app.ts`：注册阶段 `app.route("/", downloadRoutes(deps))`（首个请求后 SmartRouter 冻结）。
   `src/http/errors.ts` 的 `onMethodNotAllowed` 按路径分支：`/ca`、`/crl`、`/dcrl` 本身或其下 →
   `c.text("Method Not Allowed", 405, { "Cache-Control": "no-store", Allow: "GET, HEAD" })`（`no-store` 显式写：`c.text` 会沿用
   被替换的 404 的头），其余保持 JSON 信封。探针确认 `/ca/*` 也匹配 `/ca`，不匹配 `/cafoo`、`/crls/…`：`/crls/<uuid>` 仍走 UI，
   `POST /dcrl` → 405 `Allow: GET, HEAD`。切片 1 的保留前缀 notFound 留作兜底：路由不匹配的拼写（`/ca%2Fx`、`//crl/x`）任何方法都是纯文本 404；
   其下载前缀正则随之改为 `^/(?:ca|crl|dcrl)(?:/|$)`，`//ca` 这类裸前缀的拼写也不进 UI（plan §4.4）。
6. **头差异记录**（本表是切片 6 `docs/operations.md` 与切片 7 切换说明的来源）：

   | 项 | 线上（`worker-aia-cdp@0ea3130`） | 新 | 依据 |
   | --- | --- | --- | --- |
   | 可达对象 | 前缀下任意 R2 键（`archive/`、`by-keyid/`、PEM 伴随对象） | 仅路径表及其 `.pem`；`blobs/…`、历史、`config.json`、`catalog.json` 不可达 | §10 #2 |
   | `ETag` / 304 / `Content-Length` | R2 MD5 无引号 / 无 / GET 有（workerd 按 R2 对象体的长度补上，本地探针）、HEAD 无 | `"<sha256>"`、`"<sha256>-pem"` / 有 / GET 与 HEAD 都有 | §10 #1 |
   | 证书 `Cache-Control` | 另带 `s-maxage=31536000, stale-while-revalidate=604800` | 去掉边缘指令 | C7 |
   | CRL `Cache-Control` | `max-age=max(0, nextUpdate − now)`（线上见 428625；`nextUpdate` 取 R2 自定义元数据，缺失时 300）+ 同值 `s-maxage` | 夹紧 [60, 3600]，过期 0 → 60，无 `nextUpdate` 300 | §10 #3、C7 |
   | `Content-Type` | 按键后缀；PEM `text/plain; charset=utf-8` | 按种类；PEM `application/x-pem-file`（现有 `.crt` / `.crl` 路径的 DER 值不变） | C6 |
   | `Last-Modified` | R2 上传时间 | `importedAt` / `publishedAt`（切片 7 迁移后为导入时间） | M18 |
   | `Content-Disposition` | `attachment; filename="<原样>"` | 同形，filename 净化 | C13、M17 |
   | 404 / 405 | 纯文本；405 无 `Allow` | 纯文本，`no-store`；405 另带 `Allow: GET, HEAD` | M19 |
   | 500 | 异常 → JSON `{"error":"internal_error","detail":"<异常文本>"}`；对象缺失即 404 | JSON 信封 `internal`、`no-store`，异常只进日志；路径表命中而引用失效、blob 缺失、大小不符也是 500 + 日志行，不是 404 | 步骤 4 |
   | 畸形 `%` / `%2F` | 400 / 解码为 `/` | 404 / 保留后 404 | M20 |
   | 安全头 | 无 | Hono `secureHeaders` 默认集，无 HSTS（含 `nosniff`、`Cross-Origin-Resource-Policy: same-origin`；CryptoAPI / OpenSSL 不看，浏览器顶层导航下载不受 CORP 影响） | B8 |

## 测试

- `tests/core/pki/pem.test.ts`（追加）：`pemLength(n)` 与 `derToPem(...).length` 在 n = 1…4096 及 1 MiB、两种 marker 下全等；
  `derToPem` 对 `certs/root-ca.der`、`crls/issuing-ca-1/full-01.der` 的输出与夹具 `certs/root-ca.pem`、`crls/issuing-ca-1/full-01.pem`
  （OpenSSL 输出）逐字节相等（spike 夹具上已验证）。
- `tests/core/resources.test.ts`（迁自 `worker-aia-cdp@5b570aa:tests/worker/cache-config.test.ts:78-114`，期望值换新）：步骤 2 匹配表
  （路径表含两段路径 `/ca/sub/root-ca.crt`，`/ca/sub%2Froot-ca.crt` 不命中）；
  证书 immutable；CRL 无 `nextUpdate` 300、已过期 60（旧 0）、远未来 3600（旧无上限）、`nextUpdate − now = 1234.9 s` → 1234；
  四种 `Content-Type`，含无后缀的证书路径与 `.der` 结尾的 CRL 路径（按种类，不按后缀，C6）；`ifNoneMatchHit` 的精确、`W/`、
  带空格列表、`*`、无引号、空串、缺失；filename 里 `"`、`\`、控制字符、非 ASCII → `_`；`inconsistent` 的两种来源。
- `tests/http/downloads.test.ts`：`createApp({ store, now: () => NOW, … }).request()`；新建 `tests/helpers/seed-downloads.ts` 直接往
  `MemoryStore` 写 blob、`config.json`、`catalog.json`（经切片 2 的 schema 与摘要构建器；CRL `current` 直接写，发布在切片 4）。
  夹具：`certs/root-ca.der`、`certs/issuing-ca-1.der`、`crls/issuing-ca-1/full-01.der`（NOW 后 4 天到期 → 3600）、
  `crls/issuing-ca-1/delta-01.der`（已过期 → 60）、`crls/issuing-ca-1/full-no-next-update.der`（300）；取值见总则 §2.5。用例：
  - DER / PEM 字节，GET 对 config、catalog 各读一次、blob 一次；两条路径指向同一证书 → 同字节、同 ETag、读同一个 blob 键；
  - 头快照：证书 DER GET、证书 PEM HEAD、CRL DER GET、304 四个响应的完整头（去 `Date`、排序后 `toEqual` 内联期望），并断言没有
    `Strict-Transport-Security`、`s-maxage`、`stale-while-revalidate`、`filename*`；
  - HEAD 与 GET 头相同，`Content-Length` 等于 GET 体长；包装 store 计数：HEAD 与 304 对 `blobs/` 键的 `get` 为 0 次；
  - `If-None-Match` 精确、`W/`、列表、`*` → 304；不匹配 → 200；
  - 纯文本 404 `Not Found`（GET 与 HEAD，带 `If-None-Match: *` 也是 404）：未知路径、`.pem.pem`、大小写不同、`%2F`（seed 含两段路径
    `/ca/sub/root-ca.crt`，解码 `%2F` 就会命中）、`%ZZ`、`/ca/`、`/ca`、未发布目标、current 为空；
    内部键 `/blobs/certificates/<sha256>.der`、`/ca/blobs/…`、`/crl/archive/x.crl`、`/crl/by-keyid/<aki>.crl`、`/config.json`、
    `/catalog.json` 都拿不到存储内容；下载前缀从不调用 `ui` 桩（C12）；
  - `POST` / `PUT` / `DELETE` / `OPTIONS` → 纯文本 405 `Allow: GET, HEAD`；`POST /api/v1/health` 仍是 JSON 405；切片 1
    `tests/http/app.test.ts` 里"下载前缀 POST → 404"的期望随之改为 405（`scripts/smoke.sh` 不受影响）；
  - store `get` 抛错 → 500 JSON `internal`，体中无异常文本（迁自 `worker-aia-cdp@5b570aa:tests/worker/api-routing.test.ts:27-39`）；
    blob 缺失、size 不符、引用失效各得 500 与对应日志行。
- `tests/integration/downloads.test.ts`（Node 真实 socket）：fs 适配器 + 临时目录 + 同一 seed，`@hono/node-server` 的 `serve()` 监听
  随机端口，`node:http` 读原始头：根 CA 与 full CRL 的 DER / PEM，GET 与 HEAD 的头块一致（去 `Date`，顺序也同），HEAD 有
  `Content-Length`、无 `Transfer-Encoding`；原始 socket 上 HEAD 与 304（GET、HEAD）的头块后没有字节；体 sha256 等于夹具（PEM 等于派生结果）。
  `/ca/root-ca.crt` 及其 `.pem` 的 `ETag`、`Content-Length`、`Content-Type`、`Cache-Control` 与体摘要等于 `tests/helpers/runtime-downloads.ts`
  的期望：只由夹具文件算出（PEM 用 OpenSSL 的 `certs/root-ca.pem`），不经 `src/core`，Worker 冒烟比对同一份。
- Worker：`scripts/worker-smoke.ts`（`createTestHarness`，`prebuiltWorkerDir: "./dist/worker"`）在 health `degraded` 与 `smoke.sh` 之后跑
  下载段：管理令牌经 `workers[].secrets` 注入（每次随机，满足 b64token），用切片 2 的管理路由导入 `certs/root-ca.der`、以
  `If-None-Match: *` 应用只含 `/ca/root-ca.crt` 的配置（之后 health `healthy`），对它及其 `.pem` 检查 GET 与 HEAD（四个头等于同一份期望、
  体 sha256、HEAD 的头同 GET）、304（GET 与 HEAD，无 `Content-Length` / `Content-Type`）、纯文本 405 `Allow: GET, HEAD`，以及
  未配置的 `/crl/x.crl` 返回纯文本 404 而不是 `index.html`；四个头逐行打印为 `download-header <方法> <路径> <头>: <值>`。`smoke.sh`
  用异步 `spawn` 跑：`spawnSync` 在它运行的约 5 s 里阻塞事件循环，workerd 期间关掉的空闲 keep-alive 连接没被 fetch 察觉、仍在连接池里，
  下一个请求（导入的 POST，不会自动重试）就报 `other side closed`。HEAD 与 304 在 workerd 上只查头：fetch 不暴露它们的体，workerd 收到
  `Connection: close` 也不关原始 socket；线上无体由 Node 集成测试的原始 socket 断言。CRL 在 workerd 上的下载检查随切片 4 补进同一段。
- Docker：`scripts/docker-smoke.sh`（`pnpm run ci:docker`）在镜像内 CLI `aia import`、`config apply` 与 health `healthy` 之后，用 curl
  下载 `/ca/root-ca.crt` 与其 `.pem`：GET 200、体与 `certs/root-ca.der` / `certs/root-ca.pem` 逐字节相同、`ETag` 为带引号的
  `sha256sum`（PEM 加 `-pem`）、`Content-Length` 为夹具大小；HEAD 同 `ETag` 与 `Content-Length`；`If-None-Match` 该 ETag → 304（GET 与 HEAD）。

## 出口条件

- `docs/openapi.json` 不变：下载路由不进 OpenAPI，`node scripts/generate-openapi.ts --check` 无漂移。
- `pnpm exec vitest run --project core --project http --project integration` 中本节用例全绿。
- `pnpm run ci:worker` 的 Worker 冒烟含下载段；`pnpm run ci:docker` 从镜像下载 `/ca/root-ca.crt` 及其 `.pem`（200 / HEAD / 304）。
- 多路径读同一 blob、内部键不可达、HEAD / 304 零 blob 读：`tests/http/downloads.test.ts` 对应用例通过。
- GET / HEAD 两条运行时一致：Node 集成测试与 Worker 冒烟对 `/ca/root-ca.crt` 及其 `.pem` 得到相同的 `ETag`、`Content-Length`、
  `Content-Type`、`Cache-Control`，体 sha256 等于 `certs/root-ca.der`（PEM 等于派生结果）。两边都与 `tests/helpers/runtime-downloads.ts`
  比对；Worker 一侧的取值见 `pnpm run smoke:worker` 输出的 `download-header` 行。
- 本地手工：用切片 2 的 CLI 导入 `root-ca` 并应用配置后，`curl -sSI http://127.0.0.1:8080/ca/root-ca.crt` 显示 `Content-Length` 与
  带引号的 `ETag`；加 `-H 'If-None-Match: <该 ETag>'` 返回 304。

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| 自动 HEAD 跑完整 GET 处理器，漏掉分支就读 blob | 步骤 4 的 `HEAD` 分支；store 计数用例 |
| HEAD 在两条运行时都不自动带 `Content-Length`，`app.request()` 也看不出 Node 传输层差异 | 显式设置；Node 真实 socket 集成测试；Worker 冒烟 |
| PEM 格式漂移使 `-pem` ETag 与 HEAD 长度失真（M22） | `pemLength` 全等测试 + 与 OpenSSL PEM 夹具逐字节比较 |
| 切片 2 的路径规则未落实（字符集、DER-only、不改绑）；"先删再加"的两步改绑本就不拦（V7 只比对当前 config，owner 确认） | 下载侧净化 filename、精确匹配兜底；改绑后客户端仍按 `immutable` 用旧证书一年，下载侧无法补救，换 CA 证书须用新路径——见切片 2 步骤 6 V7 |
| 每次下载读 config + catalog（GET 3 次 store 读，HEAD / 304 2 次） | 资源以十计可接受；plan §5.6 的备忘测量见切片 5a |
| 头变化对 CryptoAPI 可见（PEM 类型、去边缘指令、`Last-Modified` 值、过期 CRL 60 s、安全头） | 步骤 6 表格；切片 7 用 `certutil -URL` / `-verify -urlfetch` 冒烟 |
| 存储不一致（blob 缺失、引用失效）被 404 掩盖 | 一律 500 + 日志行（`download_blob_missing`、`download_inconsistent`、`download_size_mismatch`） |
