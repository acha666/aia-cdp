# aia-cdp

X.509 CA 证书与 CRL 的 AIA/CDP 分发服务：一份代码，运行在 Cloudflare Workers + R2 或 Node 24 + 本地磁盘（Docker）。

当前状态：切片 4（发布）——在切片 1 的骨架（两条运行时、ObjectStore 与 memory / fs / r2 适配器、health、OpenAPI、UI 占位、
测试夹具、Docker 镜像与本地 CI 脚本）、切片 2 的 catalog/config 与导入（PKI 解析、`config.json` / `catalog.json` 的 schema 与规则 V1–V9、
管理接口与 CLI `aia`）与切片 3 的下载（按路径表提供 `/ca/`、`/crl/`、`/dcrl/`，`.pem` 读取时派生，摘要 `ETag` 与 304，纯文本 404 / 405）
之上，加了 CRL 发布：`POST /api/v1/crls`（multipart 字段 `crl` 或原始 DER / PEM 体，可选上传令牌 `AIA_UPLOAD_TOKEN`）按 AKI 与 kind 找到
配置的目标，经扩展与时钟策略、算法白名单验签与新鲜度比较，结果为 created / updated / unchanged 或带原因的拒绝，被取代的版本留下 history
标记；CLI `aia publish`；Windows AD CS 上的助手 `scripts/adcs-crl-uploader.ps1`（安装与计划任务见 [docs/operations.md](docs/operations.md)）。
完整的使用与运维文档在切片 6。

- [docs/plan.md](docs/plan.md)：设计文档（决策、存储模型、领域规则、API、切片划分）。
- [docs/implementation/](docs/implementation/README.md)：分步实施计划。`README.md` 是总则（决策、完成定义、通用约定），每个切片一份文件
  （步骤、测试、出口条件、待 owner 确认项）；与 plan.md 冲突时以它为准。

## 开发环境

- Node 24（`.nvmrc` = `24`，`engines.node` = `^24.11.0`，`engine-strict`）。本机工具链不在默认 PATH 上，每个 shell 先执行
  `export PATH=$HOME/.local/opt/node-24/bin:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0`（后者让 corepack 下载 pnpm 时不停下来询问）。
- pnpm 经 corepack 按 `package.json` 的 `packageManager`（`pnpm@10.34.7`）解析，不要用全局安装的 pnpm（npm `latest` 已是 12.x）。
- OpenSSL ≥ 3.0（不是 LibreSSL）与 bash：生成与校验测试夹具用，只在开发与 CI 需要，运行时不需要。
- Docker Engine ≥ 25：`ci:docker` 与镜像构建用。
- 远端 `github.com/acha666/aia-cdp`：每个切片在 `slice/<n>-<name>` 分支开发，本地合入 `main` 后推送；GitHub Actions 在推送 `main` 与 PR 时
  运行，每个任务只调用对应的 `pnpm run ci:<job>`，本机也能原样执行。
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
- `pnpm run dev:worker`：先 `build:web`，再 `wrangler dev`（127.0.0.1:8787，本地 R2）。管理令牌来自 `.dev.vars`
  （`cp .dev.vars.example .dev.vars`；上传不需令牌，除非在 `.dev.vars` 加 `AIA_UPLOAD_TOKEN`）；`dev:node` 则在命令前加 `AIA_ADMIN_TOKEN=dev-admin-token`。
- `AIA_URL=http://127.0.0.1:8787 AIA_ADMIN_TOKEN=dev-admin-token pnpm run seed:dev`：经 CLI 导入夹具里的根 CA 与两个签发 CA，
  并在尚无配置时应用一份示例配置；可重复执行（再跑全部 unchanged，已有配置不动）。`pnpm run reset:dev` 删除本地数据
  （`.wrangler/state`、`.data`）。

CLI：`pnpm aia <命令>`（镜像内为 `node dist/server/cli/aia.js <命令>`），读 `AIA_URL` 与当前命令的令牌：import / config 用
`AIA_ADMIN_TOKEN_FILE` / `AIA_ADMIN_TOKEN`，`publish <file...>` 用 `AIA_UPLOAD_TOKEN_FILE` / `AIA_UPLOAD_TOKEN`（服务端未设上传令牌时可不给）；
`--token-file` 优先于两个变量。令牌只经 `https://` 发送，经 `http://` 只发往 `localhost`、`127.0.0.0/8` 与 `[::1]`；其他主机要加
`--allow-insecure-http`，否则是用法错误、不发请求。退出码 0 成功、1 失败、2 用法错误；`pnpm aia --help` 列出子命令。`pnpm aia config validate docs/config.example.json` 离线校验示例配置（不需要服务与令牌）。

测试夹具 `tests/fixtures/pki/` 入库，由 `tests/fixtures/generate-test-data.sh` 生成；vitest 的 globalSetup 只校验它与脚本一致
（`--check`），不会改写。改了脚本就 `pnpm run fixtures` 重新生成并提交（每次生成都用新密钥，签名、摘要、key id 全变）。

## Docker

```sh
docker build -t aia-cdp .   # 站名：--build-arg VITE_SITE_NAME='Acha PKI'（默认 PKI AIA/CDP）
docker run -d --name aia-cdp -p 8080:8080 -v aia-cdp-data:/data aia-cdp
```

容器以 uid 1000（`node`）运行，数据在 `/data`。命名卷自动属 uid 1000；bind mount 的宿主目录必须属 uid 1000
（`sudo chown 1000:1000 <目录>`），或以目录属主的 uid 运行（`--user <uid>:<gid>`），否则 store 检查失败、健康状态为 `unhealthy`。
未写配置时 `/api/v1/health` 返回 `degraded`（容器仍算 healthy）。
