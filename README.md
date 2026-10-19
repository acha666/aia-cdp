# aia-cdp

X.509 CA 证书与 CRL 的 AIA/CDP 分发服务：一份代码，运行在 Cloudflare Workers + R2 或 Node 24 + 本地磁盘（Docker）。

当前状态：plan 与实施计划 2026-10-19 评审后定稿；代码尚未搭建，下一步是切片 1（批次 1）。

- [docs/plan.md](docs/plan.md)：设计文档（决策、存储模型、领域规则、API、切片划分）。
- [docs/implementation.md](docs/implementation.md)：分步实施计划（每个切片的步骤、测试、出口条件、待 owner 确认项）；与 plan.md 冲突时以其 §0 为准。

## 开发环境

- Node 24（`.nvmrc` = `24`，`engines.node` = `^24.11.0`，`engine-strict`）。本机工具链不在默认 PATH 上，每个 shell 先执行
  `export PATH=$HOME/.local/opt/node-24/bin:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0`（后者让 corepack 下载 pnpm 时不停下来询问）。
- pnpm 经 corepack 按 `package.json` 的 `packageManager`（`pnpm@10.34.7`）解析，不要用全局安装的 pnpm（npm `latest` 已是 12.x）。
- OpenSSL ≥ 3.0（不是 LibreSSL）与 bash：生成测试夹具用，只在开发与 CI 需要，运行时不需要。
- 只有本地 git，暂无远端：每个切片在 `slice/<n>-<name>` 分支开发，CI 任务用 `pnpm run ci:<job>` 在本机执行。
