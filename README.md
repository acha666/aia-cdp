# aia-cdp

X.509 CA 证书与 CRL 的 AIA/CDP 分发服务：一份代码，运行在 Cloudflare Workers + R2 或 Node 24 + 本地磁盘（Docker）。

当前状态：切片 1（骨架）——两条运行时、ObjectStore 端口与 memory / fs / r2 适配器、`/api/v1/health`、`/api/v1/openapi.json`、UI 占位、
测试夹具、Docker 镜像与本地 CI 脚本；证书与 CRL 功能从切片 2 起。完整的使用与运维文档在切片 6。

- [docs/plan.md](docs/plan.md)：设计文档（决策、存储模型、领域规则、API、切片划分）。
- [docs/implementation.md](docs/implementation.md)：分步实施计划（每个切片的步骤、测试、出口条件、待 owner 确认项）；与 plan.md 冲突时以其 §0 为准。

## 开发环境

- Node 24（`.nvmrc` = `24`，`engines.node` = `^24.11.0`，`engine-strict`）。本机工具链不在默认 PATH 上，每个 shell 先执行
  `export PATH=$HOME/.local/opt/node-24/bin:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0`（后者让 corepack 下载 pnpm 时不停下来询问）。
- pnpm 经 corepack 按 `package.json` 的 `packageManager`（`pnpm@10.34.7`）解析，不要用全局安装的 pnpm（npm `latest` 已是 12.x）。
- OpenSSL ≥ 3.0（不是 LibreSSL）与 bash：生成测试夹具用，只在开发与 CI 需要，运行时不需要。
- Docker Engine ≥ 25：`ci:docker` 与镜像构建用。
- 只有本地 git，暂无远端：每个切片在 `slice/<n>-<name>` 分支开发，CI 任务用 `pnpm run ci:<job>` 在本机执行。
- 也可以用 `.devcontainer/`（Node 24、OpenSSL 3.0、PowerShell，非 root）；进入后先 `pnpm install --frozen-lockfile`。

## 常用命令

```sh
pnpm install --frozen-lockfile
pnpm run types     # 生成 worker-configuration.d.ts（不入库）；装完先跑一次，check / typecheck / lint 也会先重生成
pnpm run verify    # check + test + build
pnpm run ci:check  # 以下四个就是 CI 的定义，合并前都要在本机跑通
pnpm run ci:test
pnpm run ci:worker
pnpm run ci:docker
```

本地开发服务器（`dev:node` 与 `dev:worker` 都用 8787，二选一）：

- `pnpm run dev:web`：Vite 开发服务器（5173），把 `/api/`、`/ca/`、`/crl/`、`/dcrl/` 代理到 127.0.0.1:8787。
- `pnpm run dev:node`：直接运行 Node 源码，端口 8787，数据目录 `.data/`。
- `pnpm run dev:worker`：先 `build:web`，再 `wrangler dev`（127.0.0.1:8787，本地 R2）。

测试夹具（`tests/fixtures/pki/`，不入库）由 vitest 的 globalSetup 自动生成；需要时手动 `pnpm run fixtures:force`。

## Docker

```sh
docker build -t aia-cdp .   # 站名：--build-arg VITE_SITE_NAME='Acha PKI'（默认 PKI AIA/CDP）
docker run -d --name aia-cdp -p 8080:8080 -v aia-cdp-data:/data aia-cdp
```

容器以 uid 1000（`node`）运行，数据在 `/data`。命名卷自动属 uid 1000；bind mount 的宿主目录必须属 uid 1000
（`sudo chown 1000:1000 <目录>`），或以目录属主的 uid 运行（`--user <uid>:<gid>`），否则 store 检查失败、健康状态为 `unhealthy`。
未写配置时 `/api/v1/health` 返回 `degraded`（容器仍算 healthy）。
