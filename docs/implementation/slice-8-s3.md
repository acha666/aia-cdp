# 切片 8：S3（按需）

## 目标与范围

为 Node 多实例部署提供共享存储：`src/storage/s3.ts` 用 `@aws-sdk/client-s3` 实现 plan §5.4 的端口（plan §2 记录的版本是 3.1152.0，开工时 `npm view` 复核）；`AIA_STORE=s3`；对 MinIO 跑一致性测试（`pnpm run ci:s3`，GitHub CI 里是可选任务）；`docs/operations.md` 加多实例一章。只有 owner 确认 1 选"做"才开工。

不做：Worker 走 S3（Workers 只用 R2 绑定）；分段上传（对象都在 KB 级，单次 PutObject 就够）；多个进程共享一个 fs 目录（仍是非目标，plan §1）；把 R2 的 S3 端点列为受支持后端（未验证）。

## 前置

- 切片 1：按适配器参数化的一致性套件 `tests/storage/conformance.ts`（D5）。
- 切片 2：catalog 条件写重试。
- 切片 5a：对 §5.6 备忘开不开的决定。
- 切片 6：`docs/operations.md`。
- 本机有 Docker（跑 MinIO 容器）。

## 步骤

1. `src/runtime/settings.ts`：`AIA_STORE` 枚举加 `s3`，校验失败即退出 1（B13）。新增变量（默认值，可推翻）：`AIA_S3_BUCKET`（`s3` 时必填）；`AIA_S3_ENDPOINT`（不设即 AWS）；`AIA_S3_REGION`（默认 `us-east-1`）；`AIA_S3_PREFIX`（键前缀，默认空，测试用随机前缀隔离）；`AIA_S3_FORCE_PATH_STYLE`（设了 endpoint 时默认 `true`，MinIO 需要）；`AIA_S3_ACCESS_KEY_ID(_FILE)` / `AIA_S3_SECRET_ACCESS_KEY(_FILE)`（都不设就走 SDK 的默认凭据链）。
2. `src/storage/s3.ts`（约 100 行，无旧实现可迁）。构造函数接收 `{ send(command) }` 形状的客户端，便于单测注入。端口方法映射：

   | 端口方法 | S3 调用 | 映射规则 |
   | --- | --- | --- |
   | `get` | `GetObjectCommand` | `NoSuchKey` → `null`；字节用 `Body.transformToByteArray()` |
   | `head` | `HeadObjectCommand` | 404 → `null` |
   | `put` | `PutObjectCommand` | `ifMatch` → `IfMatch`，`ifNoneMatch` → `IfNoneMatch: "*"`；HTTP 412 → `{ ok: false, reason: "precondition-failed" }`；并发冲突的 409（AWS 记为 `ConditionalRequestConflict`）同样映射，交给 catalog 重试重读 |
   | `list` | `ListObjectsV2Command` | 按 `NextContinuationToken` 翻页（每页 ≤ 1000），去掉 `AIA_S3_PREFIX` |
   | `delete` | `DeleteObjectCommand` | — |

   ETag：S3 返回带引号的值，适配器原样保存、原样回传给 `IfMatch`，不剥引号也不解析（R2 正相反，必须不带引号，B14）。只用单次 PutObject，不会出现多段 ETag。store ETag 不外露（总则 §2.6）。
3. `src/runtime/node.ts` 按 `AIA_STORE` 选适配器；`s3` 时 `await import("../storage/s3.ts")`，fs 部署不加载 SDK。健康检查不变（切片 2 步骤 7）。
4. Worker 隔离：`tsconfig.worker.json` 不包含 `s3.ts`，Worker 图里没有文件引用它。另加最小 bundle 检查（默认值，可推翻；与 D9 的 `"node:` 断言同一做法，切片 1 步骤 12）：`ci:worker` 在 dry-run 之后执行 `! grep -q "@aws-sdk" dist/worker/worker.js.map`。查 source map 的 `sources` 而不是正文，因为 `minify: true` 之后正文里不一定留着包名；cloudflare spike 已确认 dry-run 会写出 `worker.js.map`，且 `sources` 列出 `node_modules` 路径。理由：SDK 一旦被拉进 Worker 包，问题要到部署时才暴露。
5. 依赖：`@aws-sdk/client-s3` 放进 `dependencies`（Docker 的生产依赖阶段需要，B18）；用 `docker image ls` 记录镜像大小的变化。
6. 一致性：`tests/storage/s3.test.ts` 复用共享套件，`describe.skipIf(process.env.AIA_TEST_S3 !== "1")`。
   - S3 专属用例：N 个并发 `ifMatch` 写只有一个成功（与 R2 spike 相同）；带引号 ETag 的往返；超过 1000 个键的翻页（慢，单独标记）。
   - 两条既有用例兼作探针：`ifNoneMatch` 撞上已存在的键、过期的 `ifMatch` 都必须失败；服务端若忽略条件头，套件即失败。
   - `pnpm run ci:s3`：`docker run -d --rm -p 9000:9000 -e MINIO_ROOT_USER=… -e MINIO_ROOT_PASSWORD=… minio/minio:<固定标签> server /data` → globalSetup 用 `CreateBucketCommand` 建桶（不依赖 `mc`）→ `AIA_TEST_S3=1 pnpm exec vitest run --project storage` → 停容器。
   - `.github/workflows/ci.yml` 加可选的 `s3` 任务，只调用 `pnpm run ci:s3`（D3）。
7. 多实例与 §5.6 备忘：写路径（publish、import、applyConfig、retire、delete）一律直读 `config.json` / `catalog.json`，不经备忘，否则实例 B 拿着过期的 catalog 会把旧 CRL 判成 `unchanged` 而不是 `stale_crl`。读路径允许最多 TTL 的陈旧，下载缓存本身就有 60–3600 s。切片 5a 已开备忘的话，本步只补测试；没开就不改。
8. `docs/operations.md` 多实例章：只有 `s3` 支持多实例，fs 仍是一个进程一个目录；生产 S3 端点上线前，必须在该端点上跑通 `AIA_TEST_S3=1` 的一致性套件（MinIO 通过不代表 AWS S3 或 R2-S3 也行）；写明备忘的陈旧窗口；凭据走 `_FILE`。

## 测试

- `tests/storage/s3.test.ts`：步骤 6 的 MinIO 套件。
- `tests/storage/s3-unit.test.ts`：每次运行，不需要 Docker。注入假的 `send`，验证错误映射（412、409、`NoSuchKey`、head 的 404）、前缀的拼接与剥离、翻页循环、SDK 重试场景（第一次写已生效，重试收到 412）。
- `tests/integration/multi-instance.test.ts`：每次运行。两个 `createApp` 共享一个 `MemoryStore`（切片 5a 实现了备忘就开启它）：A 发布新 CRL 后 B 立即收到旧 CRL，必须返回 `stale_crl`；两边并发发布同一目标，catalog 里最终只有一个 current，另一方得到 `updated`、`unchanged` 或 `stale_crl`。
- Docker 冒烟（手动）：镜像设 `-e AIA_STORE=s3` 指向 MinIO，依次确认 health 为 `degraded` → `aia config apply` → 一次下载。

## 出口条件

- `pnpm run ci:s3` 通过，所用 MinIO 标签固定在脚本里。
- 未设 `AIA_TEST_S3` 时，`pnpm verify` 里的 s3 套件为 skipped。
- `pnpm run ci:worker` 通过，其中包含 `! grep -q "@aws-sdk" dist/worker/worker.js.map`。
- `pnpm exec vitest run --project integration multi-instance` 通过。
- Docker 冒烟：`curl -s localhost:8080/api/v1/health` 返回 `degraded`；`aia config apply` 之后下载返回 200。
- `docs/operations.md` 有多实例一章。

## 风险与对策

- MinIO 通过不等于 AWS S3 或 R2-S3 也行：条件 PutObject 的支持随 MinIO 版本不同。对策：固定镜像标签；任何新端点上线前都以这套一致性测试为准入；R2 的 S3 端点在跑过套件之前不列为受支持。
- MinIO 镜像可能拉不到：开工时确认所选标签能拉取，并记录版本。
- SDK 自动重试与条件写叠加：第一次请求其实已成功，重试却收到 412，报 precondition-failed。catalog 重试重读后结果被标成 `unchanged`，但状态是对的；`PUT /admin/config` 则可能对已生效的配置返回 412。文档写明"收到 412 先 GET 再判断"，单测覆盖这一场景。
- SDK 体积：只进 Node 包和 Docker 镜像，Worker 包由步骤 4 的 grep 守住。
- 多实例下备忘陈旧：步骤 7 的规则加 multi-instance 测试。

## 开工前需 owner 确认

| # | 问题 | 选项 | 推荐 |
| --- | --- | --- | --- |
| 1 | 切片 8 做不做 | (a) 做；(b) 暂缓，出现 Node 多实例或高可用需求时再开 | (b)：现在的部署是 Cloudflare 单 Worker + R2，没有多实例 Node 的需求；plan §12 保留这个切片 |
| 2 | 若做，哪些端点必须通过一致性套件 | MinIO（固定标签）/ AWS S3 / R2 的 S3 端点 / 其他 | 只承诺 MinIO，加上 owner 实际要用的那一个 |
