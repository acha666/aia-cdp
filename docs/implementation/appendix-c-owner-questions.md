# 附录 C. 待 owner 确认汇总

未答复的项按推荐默认实施，并在该切片的合并说明里写明；已答复的标"已确认"与日期。

## 切片 1

| # | 问题 | 推荐默认 |
| --- | --- | --- |
| 1 | 边界漏洞补丁（推翻 plan §3"不另设 ESLint 导入边界规则和 bundle 卫生断言"） | 已确认（2026-10-19，D9）：加。ESLint `no-restricted-imports` 分层规则；`scripts/check-worker-program.ts` 作 `typecheck:boundary`；`ci:worker` 在 dry-run 后断言 `dist/worker/worker.js` 不含 `"node:` 导入 |
| 2 | devcontainer | 已确认（2026-10-19，D10）：本切片建（Node 24 镜像 + PowerShell feature，非 root，无 act；切片 1 步骤 15） |

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
| 1 | SHA-1 签名的 CRL | 已确认（2026-10-20）：接受（分发服务不是校验器，旧实现也接受） |
| 2 | 只含 `distributionPoint` 的关键 IDP（AD CS 的 CDP 选项） | 已确认（2026-10-20）：接受；`onlyContains*`、`onlySomeReasons`、`indirectCRL` 仍 `scoped_crl_unsupported` |
| 3 | 无 AKI 或 AKI 无 `keyIdentifier` | 已确认（2026-10-20）：`issuer_not_found` + `details.reason = "missing_aki"` |
| 4 | 多张证书共用 SKI（同钥续期）时的签发者选择 | 已确认（2026-10-20）：按目标配置的签发者验签；`applyConfig` 拒绝同 kind 且签发者 SKI 相同的两个目标；上传不再产生 `issuer_mismatch` |
| 5 | 外层与 TBS 内签名算法不一致 | 已确认（2026-10-20）：`invalid_crl`（`signature_algorithm_mismatch`） |

不阻塞开工的规划默认值：5 分钟边界"恰好 5 分钟接受"、1 + 3 次重试、状态码表、同号更晚 `thisUpdate` 为 `updated`、两侧无号比
`thisUpdate`、history 标记、blob 键带 CRL 号、不设 20 octet 上限。

## 切片 5a

| # | 问题 | 推荐默认 |
| --- | --- | --- |
| 1 | 状态阈值 / 即将过期规则 | 已确认（2026-10-20，同切片 5b 第 2 项）：`/api/v1/stats` 不含时间相关字段（列表项总带 `current.summary.nextPublish`，不受此项影响） |

## 切片 5b

| # | 问题 | 推荐默认 |
| --- | --- | --- |
| 1 | CSP | 已确认（2026-10-20）：采纳切片 5b 步骤 10 的策略，经 `secureHeaders` 的 `contentSecurityPolicy` 以响应头下发（两条运行时同一份），预绘制主题脚本用 hash 放行；冒烟出现违规只放宽 `style-src` |
| 2 | 状态阈值 vs AD CS 节奏（旧 80% 规则与"7 天内"都会误报） | 已确认（2026-10-20）：有 `nextPublish` 时 `now` 超过它 1 h 仍未更新才算 stale；没有时沿用 80%（剩余不足 20%）；"即将过期"改为客户端计算的"需关注"（stale + expired + unknown），stats 不加时间字段；证书 `expiring` 阈值为剩余不足有效期 10% |

第 2 项取"时间相关数只在客户端算"：plan §7.1 的 stats 本来就没有时间字段，5b 步骤 11 的构建插件禁止 web 在运行时导入 `src/core`（因此不做
服务端 `src/core/status.ts` 与 stats 的 `expired` / `expiringSoon`），且客户端计算消除了服务端与浏览器时钟不一致；1 h 宽限保留。

## 切片 6

| # | 问题 | 推荐默认 |
| --- | --- | --- |
| 1 | 退役语义 | 终态：退役 UUID 的上传一律 `target_not_configured`，恢复发布用新 UUID |
| 2 | 证书删除保护 | 被任一 `current` 或 `retired.last` 作为 `verifier` 的证书永不可删（本版无 tombstone 清除） |
| 3 | R2 备份 | 不申请 R2 S3 令牌；只备份 config 与 CA 证书文件，接受历史丢失 |
| 4 | AD CS 计划任务的现实配置 | 请 owner 在两台签发 CA 上 `Export-ScheduledTask` 导出；拿不到时按模板写并标"未核对" |
| 5 | pki.acha.top 在 Cloudflare 上的 HSTS 与 Always Use HTTPS 现状 | 该主机名两者都保持关闭 |

## 切片 7

| # | 问题 | 推荐默认 |
| --- | --- | --- |
| 1 | 历史枚举通道（C9） | 以 HTTP 探测可预测的 Gen A/B 归档名为主，与 `/api/v2/stats` 对账不平时用 `getPlatformProxy` 远程 R2 绑定补差 |
| 2 | 是否共享旧 R2 桶（`bucket_name`） | 不共享：自动置备 `aia-cdp-store`（B6）；绝不复用旧 Worker 名 `aia-cdp-worker` |
| 3 | AD CS 助手切换方式与上传令牌 | 在冻结窗口内替换脚本；生产启用 `AIA_UPLOAD_TOKEN`，UI 上传用切片 5b 步骤 7 的令牌框 |

## 切片 8

| # | 问题 | 推荐默认 |
| --- | --- | --- |
| 1 | 切片 8 做不做 | 暂缓，出现 Node 多实例或高可用需求时再开 |
| 2 | 若做，哪些端点必须通过一致性套件 | 只承诺 MinIO（固定标签），加上 owner 实际要用的那一个 |
