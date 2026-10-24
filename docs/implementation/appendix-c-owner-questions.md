# 附录 C. 待 owner 确认汇总

未答复的项按推荐默认实施，并在该切片的合并说明里写明；已答复的标"已确认"与日期。

## 切片 1

| # | 问题 | 推荐默认 |
| --- | --- | --- |
| 1 | 边界护栏（core / http 的 ESLint 分层规则、`typecheck:boundary`、Worker 包的 `"node:` 断言） | 2026-10-19 确认加，2026-10-23 撤回（D9）：只用常规检查，另加一条 `src/web` 导入规则（plan §10） |
| 2 | devcontainer | 已确认（2026-10-19，D10）：本切片建（Node 24 镜像 + PowerShell feature，非 root，无 act） |

## 切片 2

| # | 问题 | 推荐默认 |
| --- | --- | --- |
| 1 | 多块 PEM | 已确认（2026-10-19）：API 拒绝（`pem_blocks`），CLI 用 `splitPemBlocks` 拆块逐个导入 |
| 2 | 改绑账本 `catalog.certificatePaths`（plan §5.3 新字段，只增不减） | 已确认（2026-10-19）：不采用（非推荐项）。catalog 无此字段（严格对象，带该键即无效）；V7 只与当前 config 比对，`applyConfig` 只写 `config.json`；"先删再加"的两步改绑不检测，由操作员负责（证书下载 `immutable` 缓存一年，换 CA 证书用新路径） |
| 3 | V6 状态部分（SKI 相同的证书不得各有同 kind 目标） | 已确认（2026-10-19）：拒绝（与切片 4 第 4 项的推荐默认一致） |
| 4 | `PUT /api/v1/admin/config` 缺前置条件头 | 已确认（2026-10-19）：428 `precondition_required`（非推荐项，新增错误码）。可用前置条件 = `If-Match` 或 `If-None-Match: *` 恰好一个；两者都缺、都有或 `If-None-Match` 不是 `*` → 428；可用但不匹配 → 412 `precondition_failed` |

## 切片 3

无。

## 切片 4

| # | 问题 | 推荐默认 |
| --- | --- | --- |
| 1 | SHA-1 签名的 CRL | 已确认（2026-10-20）：接受（分发服务不是校验器） |
| 2 | 只含 `distributionPoint` 的关键 IDP（AD CS 的 CDP 选项） | 已确认（2026-10-20）：接受；`onlyContains*`、`onlySomeReasons`、`indirectCRL` 仍 `scoped_crl_unsupported` |
| 3 | 无 AKI 或 AKI 无 `keyIdentifier` | 已确认（2026-10-20）：`issuer_not_found` + `details.reason = "missing_aki"`；keyIdentifier 存在但为空 → `issuer_not_found` + `details.authorityKeyId = ""`（导入的证书不会有空 SKI） |
| 4 | 多张证书共用 SKI（同钥续期）时的签发者选择 | 已确认（2026-10-20）：按目标配置的签发者验签；`applyConfig` 拒绝同 kind 且签发者 SKI 相同的两个目标 |
| 5 | 外层与 TBS 内签名算法不一致 | 已确认（2026-10-20）：`invalid_crl`（`signature_algorithm_mismatch`） |

不阻塞开工的规划默认值：5 分钟边界"恰好 5 分钟接受"、1 + 3 次重试、状态码表、同号更晚 `thisUpdate` 为 `updated`、两侧无号比
`thisUpdate`、history 标记、blob 键带 CRL 号、CRL 号与 Delta CRL 指示至多 20 octet（RFC 5280）。

## 切片 5a

| # | 问题 | 推荐默认 |
| --- | --- | --- |
| 1 | 状态阈值 / 即将过期规则 | 已确认（2026-10-20，同切片 5b 第 2 项）：`/api/v1/stats` 不含时间相关字段（列表项总带 `current.summary.nextPublish`，不受此项影响） |

## 切片 5b

| # | 问题 | 推荐默认 |
| --- | --- | --- |
| 1 | CSP | 已确认（2026-10-20）：采纳 `src/http/csp.ts` 的策略，经 `secureHeaders` 的 `contentSecurityPolicy` 以响应头下发（两条运行时同一份），预绘制主题脚本用 hash 放行（2026-10-23 撤回：亮 / 暗只跟随系统，没有内联脚本）；冒烟出现违规只放宽 `style-src` |
| 2 | 状态阈值 vs AD CS 节奏（只按 80% 或"7 天内"判断都会误报） | 已确认（2026-10-20）：有 `nextPublish` 时 `now` 超过它 1 h 仍未更新才算 stale；没有时沿用 80%（剩余不足 20%）；"即将过期"改为客户端计算的"需关注"（stale + expired + unknown），stats 不加时间字段；证书 `expiring` 阈值为剩余不足有效期 10% |

第 2 项取"时间相关数只在客户端算"：plan §7.1 的 stats 本来就没有时间字段，ESLint 规则禁止 web 在运行时导入 `src/core`（plan §3）（因此不做
服务端 `src/core/status.ts` 与 stats 的 `expired` / `expiringSoon`），且客户端计算消除了服务端与浏览器时钟不一致；1 h 宽限保留。

## 切片 6

| # | 问题 | 推荐默认 |
| --- | --- | --- |
| 1 | 退役语义 | 已确认（2026-10-24，非推荐项）：退役 = 从 config 删除目标；取消规则 V8，没有 retire 路由、命令与 catalog 字段（plan §5.2、§6） |
| 2 | 证书删除保护 | 已确认（2026-10-24）：被 config 引用或作为任一目标 current 的 `verifier` 的证书永不可删；不做删除后的复核与补偿 |
| 3 | R2 备份 | 2026-10-24：非代码事项，本版不考虑 |
| 4 | AD CS 计划任务的现实配置 | 2026-10-24：非代码事项，本版不考虑 |
| 5 | PKI 主机名在 Cloudflare 上的 HSTS 与 Always Use HTTPS 现状 | 2026-10-24：非代码事项，本版不考虑 |

同日另定：历史可下载（`history <targetId> <sha256> --out`）；不写 `docs/api.md`；README 重写与 operations.md 的部署、令牌、备份、
迁移与回滚各节不做；切片 8 列为远期计划。

## 切片 7

| # | 问题 | 推荐默认 |
| --- | --- | --- |
| 1 | 历史枚举通道 | 以 HTTP 探测可预测的 Gen A/B 归档名为主，与 `/api/v2/stats` 对账不平时用 `getPlatformProxy` 远程 R2 绑定补差 |
| 2 | 是否共享旧 R2 桶（`bucket_name`） | 不共享：自动置备 `aia-cdp-store`（B6）；绝不复用旧 Worker 名 `aia-cdp-worker` |
| 3 | AD CS 助手切换方式与上传令牌 | 在冻结窗口内替换脚本；生产启用 `AIA_UPLOAD_TOKEN`，UI 上传用上传卡片的令牌框 |

## 切片 8

| # | 问题 | 推荐默认 |
| --- | --- | --- |
| 1 | 切片 8 做不做 | 已确认（2026-10-24）：列为远期计划，出现 Node 多实例或高可用需求时再开 |
| 2 | 若做，哪些端点必须通过一致性套件 | 只承诺 MinIO（固定标签），加上 owner 实际要用的那一个 |
