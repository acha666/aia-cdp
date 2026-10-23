# aia-cdp

X.509 CA 证书与 CRL 的 AIA/CDP 分发服务：一份代码，运行在 Cloudflare Workers + R2 或 Node 24 + 本地磁盘（Docker）。

功能：

- 下载：按配置的路径表提供 `/ca/`（CA 证书）、`/crl/`（完整 CRL）与 `/dcrl/`（delta CRL）。只存 DER，`.pem` 在读取时派生；
  摘要 `ETag` 与 304，纯文本 404 / 405。
- CRL 发布：`POST /api/v1/crls`，请求体是 CRL 本身（DER 或单个 PEM，按字节识别），默认匿名可写，请求体上限
  `AIA_MAX_UPLOAD_BYTES`（默认 1 MiB）；设了 `AIA_UPLOAD_TOKEN` 就要令牌。与目标当前 CRL 相同的字节直接回答 unchanged，
  其余先只解码不含吊销条目的部分并验签，通过后才完整解码。CLI 是 `aia publish`；Windows AD CS 助手是
  `scripts/adcs-crl-uploader.ps1`，安装与计划任务见 [docs/operations.md](docs/operations.md)。
- 管理：导入 CA 证书、写入与校验配置（`/api/v1/admin/*`，需要 `AIA_ADMIN_TOKEN`），CLI 是 `aia import` / `aia config`。
- 公开只读 API：`GET /api/v1/certificates`、`/certificates/{id}`、`/crls`、`/crls/{targetId}`、`/stats`、`/health`；
  OpenAPI 文档在 [docs/openapi.json](docs/openapi.json)（`pnpm run openapi` 重新生成）。
- Web UI：总览（统计与"需关注"、证书表、CRL 目标表、CRL 上传）、证书与 CRL 目标详情（X.509 扩展、吊销列表、PEM），
  `en` / `zh-CN`，亮 / 暗主题。

- [docs/plan.md](docs/plan.md)：设计文档（决策、存储模型、领域规则、API、切片划分）。
- [docs/implementation/](docs/implementation/README.md)：实施总则（决策、完成定义、通用约定）与未完成的切片 6–8；与 plan.md
  冲突时以它为准。

## 开发环境

- Node 24（`.nvmrc` = `24`，`engines.node` = `^24.11.0`，`engineStrict`）。本机工具链不在默认 PATH 上，每个 shell 先执行
  `export PATH=$HOME/.local/opt/node-24/bin:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0`（后者让 corepack 下载 pnpm 时不停下来询问）。
- pnpm 12：`package.json` 的 `devEngines.packageManager` 给出范围（`^12.15.0`），实际版本记在 `pnpm-lock.yaml`；经 corepack 使用
  （`corepack enable pnpm`）。pnpm 默认不解析发布不满 1 天的版本（`minimumReleaseAge`）。
- bash：冒烟脚本用（`smoke:worker`、`ci:docker`）。OpenSSL ≥ 3.0（不是 LibreSSL）只在重新生成测试夹具时需要。
- Docker Engine ≥ 25：`ci:docker` 与镜像构建用。
- 远端 `github.com/acha666/aia-cdp`：每个切片在 `slice/<n>-<name>` 分支开发，本地合入 `main` 后推送；GitHub Actions 在推送 `main` 与 PR 时
  运行，每个任务只调用对应的 `pnpm run ci:<job>`，本机也能原样执行。
- 也可以用 `.devcontainer/`（Node 24、Debian 13、OpenSSL ≥ 3.0、PowerShell，非 root）；进入后先 `pnpm install --frozen-lockfile`。

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
  在尚无配置时应用一份示例配置，再给除 issuing-ca-2 的 delta 外的每个目标发布一个 CRL；可重复执行（再跑全部 unchanged，已有配置不动）。
  `pnpm run reset:dev` 删除本地数据（`.wrangler/state`、`.data`）。

CLI：`pnpm aia <命令>`（镜像内为 `node dist/server/cli/aia.js <命令>`），读 `AIA_URL` 与当前命令的令牌：import / config 用
`AIA_ADMIN_TOKEN_FILE` / `AIA_ADMIN_TOKEN`，`publish <file...>` 用 `AIA_UPLOAD_TOKEN_FILE` / `AIA_UPLOAD_TOKEN`（服务端未设上传令牌时可不给）；
`--token-file` 优先于两个变量。令牌只经 `https://` 发送，经 `http://` 只发往 `localhost`、`127.0.0.0/8` 与 `[::1]`；其他主机要加
`--allow-insecure-http`，否则是用法错误、不发请求。退出码 0 成功、1 失败、2 用法错误；`pnpm aia --help` 列出子命令。`pnpm aia config validate docs/config.example.json` 离线校验示例配置（不需要服务与令牌）。

测试夹具 `tests/fixtures/pki/` 入库，由 `tests/fixtures/generate-test-data.sh` 生成，测试只读不写。改了脚本就 `pnpm run fixtures`
重新生成并提交（每次生成都用新密钥，签名、摘要、key id 全变）。

## Docker

```sh
docker build -t aia-cdp .   # 站名：--build-arg VITE_SITE_NAME='Acha PKI'（默认 PKI AIA/CDP）
docker run -d --name aia-cdp -p 8080:8080 -v aia-cdp-data:/data aia-cdp
```

预构建镜像 `ghcr.io/acha666/aia-cdp`（linux/amd64，站名是默认的 `PKI AIA/CDP`）由 `.github/workflows/docker-publish.yml` 发布：
推送 `main` 更新 `:main`，推送 `vX.Y.Z` 标签发布 `:X.Y.Z`、`:X.Y` 与 `:latest`。用法同上，把最后的 `aia-cdp` 换成例如
`ghcr.io/acha666/aia-cdp:main`。

容器以 uid 1000（`node`）运行，数据在 `/data`。命名卷自动属 uid 1000；bind mount 的宿主目录必须属 uid 1000
（`sudo chown 1000:1000 <目录>`），或以目录属主的 uid 运行（`--user <uid>:<gid>`），否则启动时记 `data_dir_unusable` 并以 1 退出（容器停止）。
未写配置时 `/api/v1/health` 返回 `degraded`（容器仍算 healthy）。
