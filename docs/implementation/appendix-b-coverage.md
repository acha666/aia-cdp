# 附录 B. 缺陷与评审项覆盖

"切片 N 步骤 k"指该切片"步骤"下的第 k 条；同一项分在几处处理时按先后列出。

## B.1 plan §10 旧实现缺陷

| 编号 | 缺陷（简） | 处理 |
| --- | --- | --- |
| §10 #1 | 下载无 304、HEAD 无 `Content-Length`、`ETag` 无引号 | 切片 3 步骤 3–4（摘要 `ETag`、`ifNoneMatchHit` 先于读 blob、显式 `Content-Length`）；测试 `tests/http/downloads.test.ts`、`tests/integration/downloads.test.ts` |
| §10 #2 | 下载暴露 `archive/`、`by-keyid/` 与任意对象；详情接受归档 id | 切片 3 步骤 2（只走路径表，内部键不可达）；切片 5a 步骤 6（id 参数格式，归档形、嵌套与非 hex id → 400，字面多段路径 → JSON 404；测试 `tests/http/certificates.test.ts`、`tests/http/crl-targets.test.ts`）；切片 5b 步骤 6（UI 对非法 id 不发请求；测试 `tests/web/pages.test.ts`、`tests/web/router.test.ts`，浏览器冒烟 `scripts/ui-smoke.ts`）；切片 7 步骤 8（按访问日志决定是否给旧 URL 加路径） |
| §10 #3 | CRL `max-age` 无上限、过期后为 0 | 切片 3 步骤 3（夹紧 [60 s, 3600 s]，无 `nextUpdate` 300 s） |
| §10 #4 | 相同 CRL 重复上传 409 | 切片 4 步骤 5（`unchanged` 200）；测试 `tests/core/freshness.test.ts`、`tests/http/crls-upload.test.ts`；切片 5b 步骤 7（`unchanged` 是成功文案；测试 `tests/web/upload-card.test.ts`，浏览器冒烟） |
| §10 #5 | 伴随写失败报 500；`caches.default` 在 Node 上崩 | 切片 2 步骤 5（导入单提交点）；切片 4 步骤 6（无伴随写、无边缘缓存，catalog 写成功即完成）；测试 `tests/core/publish.test.ts` 的写日志 |
| §10 #6 | 归档写无条件、并发发布无保护 | 切片 4 步骤 2、6（内容寻址 blob + `ifMatch` 条件写重试）；测试 `tests/core/publish.test.ts`、`tests/storage/publish-stores.test.ts`（fs 与 R2 上的竞争）；已被 Gen A/B 覆盖的旧版本不可恢复，切片 7 步骤 4 在报告写明 |
| §10 #7 | `revokedCount` 未知时显示 0 | 切片 4 步骤 2（发布时必有非空 `revokedCount`）；切片 5a 步骤 5（"未知"只以 `current: null` 出现；测试 `tests/core/views.test.ts`、`tests/http/crl-targets.test.ts`）；切片 5b 步骤 6（未发布不渲染吊销表、统计"未知"；测试 `tests/web/revoked-table.test.ts`、`tests/web/pages.test.ts`） |
| §10 #8 | 详情缺 `signatureAlgorithm`、`parameters` 不输出、死变体 | 切片 5a 步骤 1、3（构建器迁入；删 `UnknownExtensionValueSchema`；签名算法必填）；测试 `tests/core/summary/schemas.test.ts`（无 `unknown` 变体、41 个字面量）、`tests/core/summary/values.test.ts`、`tests/http/certificates.test.ts` 与 `tests/http/crl-targets.test.ts`（详情带 `signatureAlgorithm` / `signatureValue`） |
| §10 #9 | 全 null 信封通过 200 校验成空列表 | 切片 5a 步骤 5–6（按状态码 schema；store 抛错 500，不是 `200 []`；测试 `tests/http/lists.test.ts`）；切片 5a 步骤 10（客户端 `unwrap`：非 JSON / 非信封为 `invalid_response`，不成为空的成功；测试 `tests/web/api-errors.test.ts`） |
| §10 #10 | `relationships` 恒空 | 切片 5a 步骤 5（证书 `targets`、CRL `issuer`；测试 `tests/core/views.test.ts`、`tests/http/certificates.test.ts`、`tests/http/crl-targets.test.ts`）；切片 5b 步骤 6（证书页的目标链接、CRL 页头的签发者链接；测试 `tests/web/pages.test.ts`） |
| §10 #11 | 畸形 ASN.1 时间成 1899 | 切片 2 步骤 1（`assertWellFormed` 随 pki 迁入，证书导入即拒）；切片 4 步骤 6（CRL `reason: "time"`，测试 `tests/core/publish.test.ts` 的 `full-bad-time`） |
| §10 #12 | 未来 `thisUpdate`、未知关键扩展、作用域 CRL 无策略 | 切片 4 步骤 3；测试 `tests/core/pki/crl-policy.test.ts` |
| §10 #13 | `constructor.name` 判编码 | 切片 2 步骤 1（`toDer` 按字节识别 PEM / DER）；DN 编码按 tag 判定随切片 5a 步骤 3 的构建器迁入 |
| §10 #14 | 证书只能手工放进 R2 | 切片 2 步骤 3、5、8（导入接口，导入时生成完整摘要） |
| §10 #15 | 健康检查硬编码 | 切片 1 步骤 4（真实 store / configuration 检查，D5）；切片 2 步骤 7（完整 schema 与规则） |
| §10 #16 | 统计按桶前缀字节 | 切片 5a 步骤 5（按资源计数，`derBytes` 来自 catalog，不 `list`）；测试 `tests/core/views.test.ts`、`tests/http/stats.test.ts` |
| §10 #17 | ts-rest 忽略 `no-store` | 切片 1 步骤 6（`hc` 的 `init.cache`）；切片 5a 步骤 7（API `no-store`；测试 `tests/http/{certificates,crl-targets,stats}.test.ts` 的各状态码）、步骤 10（每请求的 `init` 与 `cache` 合并；测试 `tests/web/api-errors.test.ts`）；切片 5b 步骤 5（上传后先取消再全量失效；测试 `tests/web/queries.test.ts`） |
| §10 #18 | `SITE_NAME` 多条死通道 | 切片 1 步骤 6（只剩构建期 `VITE_SITE_NAME`，校验与默认值）；切片 5b 步骤 6（页头、页脚、页面标题；测试 `tests/web/pages.test.ts`；出口 6 的 grep） |
| §10 #19 | 上传无体积上限、无鉴权 | 切片 4 步骤 8（`bodyLimit`、可选 `bearerAuth`）；测试 `tests/http/crls-upload.test.ts`；切片 7 开工前需 owner 确认第 3 项（生产启用令牌） |
| §10 #20 | 助手 PS5 死分支、手搓 multipart、按扩展名判格式、409 当失败 | 切片 4 步骤 11（手动 Windows 验证记录在 `docs/operations.md`）；切片 7 步骤 9（生产安装） |
| §10 #21 | 测试 glob、钩子挂起、`pretest` 重生成夹具 | 切片 1 步骤 9–10 |
| §10 #22 | 没有 Node / Docker 运行方式 | 切片 1 步骤 5、11 |
| §10 #23 | 没有退役、删除、历史的管理路径 | 切片 2 步骤 8–9（import / config）；切片 6 步骤 1–7 |
| §10 #24 | 日志无结构 | 切片 1 步骤 4（请求日志）；切片 2 步骤 8、切片 4 步骤 6、切片 6 步骤 2（导入 / 发布 / 退役各一行）；总则 §2.6 |
| §10 #25 | `thisUpdate` 缺失序列化为空串 | 切片 4 步骤 6（解析期拒绝）、步骤 8（成功体 `thisUpdate` 必填）；测试 `tests/core/publish.test.ts`、`tests/http/crls-upload.test.ts` |
| §10 #26 | 文档与代码多处不一致 | 切片 6 步骤 8–12（OpenAPI 漂移、docs-consistency 测试、README / `docs/api.md` / `docs/operations.md` 重写） |
| §10 #27 | 详情解析覆盖不足 | 切片 5a 步骤 1、3（41 个解析器与 schema 迁入）；回归改用合成夹具（D7，测试 `tests/core/summary/extension-parsers.test.ts`、`values.test.ts`、`extensions-structure.test.ts`，workerd 上 `scripts/worker-smoke.ts` 的读取段）；线上工件的解码核对在切片 7 步骤 7 |
| §10 #28 | 未识别扩展只给 hex；UI 签名算法 Unknown | 切片 5a 步骤 5（详情一次全量；测试 `tests/http/certificates.test.ts`（每张夹具证书的详情过 schema）、`tests/http/crl-targets.test.ts`）；切片 5b 步骤 3、6（ASN.1 dump、带参数的签名算法；测试 `tests/web/extension-blocks.test.ts`、`tests/web/components.test.ts`、`tests/web/pages.test.ts`） |

## B.2 完整性评审：计划矛盾

| 编号 | 矛盾（简） | 处理 |
| --- | --- | --- |
| C1 | PKIjs `crl.verify()` 暗中比较签发者 DN | 切片 4 步骤 4（`verifyWithPublicKey`，B21）；步骤 1 的 `issuing-ca-1-renamed` 夹具与 `verify.test.ts` |
| C2 | PKIjs 隐藏的关键扩展闸（关键 AD CS 扩展被拒、关键 IDP 被收） | 切片 4 步骤 3（显式策略表，含条目扩展）、步骤 4（绕开闸）；`verify.test.ts` 回归 |
| C3 | 新鲜度结果与旧实现不同（同号同时间、单侧有号） | 切片 4 步骤 5；测试 `tests/core/freshness.test.ts`、`tests/core/publish.test.ts` 的场景 |
| C4 | 不可验算法一律报 `invalid_signature` | 切片 4 步骤 4（白名单，名单外 → `unsupported_algorithm`）；测试 `tests/core/pki/verify.test.ts` 的 OID 表 |
| C5 | `issuer_mismatch` 两种含义、按 plan 不可达 | 切片 2 步骤 6（V6）；切片 4 步骤 6–7（上传不产生，owner 确认 4；测试 `tests/core/publish.test.ts` 的同钥续期）；切片 7 步骤 5（只用于临时历史导入），步骤 11 删除 |
| C6 | 内容类型按键后缀（PEM `text/plain`） | 切片 3 步骤 3、6 |
| C7 | 缓存头去掉 `s-maxage` / `stale-while-revalidate`、丢 `Last-Modified` | 切片 3 步骤 3、6；切片 7 步骤 10（CryptoAPI 冒烟） |
| C8 | 孤儿 blob 进历史、破坏零写入不变量 | 切片 4 步骤 6（history 标记，历史 = 标记 ∪ current；测试 `tests/core/publish.test.ts` 的竞争：孤儿 blob 不在 history）；切片 6 步骤 4（列表不含孤儿，标记与 current 同名时合并）；切片 2 步骤 5（证书孤儿 blob 不可见）；切片 7 步骤 5（导入写标记） |
| C9 | 历史迁移前提描述的是从未部署的 Gen C | 切片 7 目标与范围、步骤 1–4（尽力而为、HTTP 探测 + stats 对账）；开工前需 owner 确认第 1 项 |
| C10 | 旧助手把 v1 响应记为失败 | 切片 4 步骤 11（重写，Windows 上对 v1 服务验证过，`docs/operations.md`）；切片 7 步骤 9（切换时替换脚本与令牌文件） |
| C11 | plan §11 声称的夹具覆盖不存在 | 切片 1 步骤 9（生成器随切片 1 提交；12 张证书、30 个 CRL、6 个无效输入与 17 个场景逐项列在附录 D，即重写契约）；切片 4 步骤 1（加 `issuing-ca-1-renamed`、`full-sha1`，现为 13 张证书、31 个 CRL）与 `tests/core/publish.test.ts`（逐个 CRL、场景、无效输入断言）、步骤 12（plan §11 同步） |
| C12 | Workers SPA 兜底会把 `/api` 与下载未命中答成 200 HTML | 切片 1 步骤 4（`ui.ts` 与 `notFound`）、步骤 12（`smoke.sh` 跑两条运行时）；切片 3 步骤 5；切片 5b 出口 4（`smoke:node`、`smoke:worker` 与 `wrangler dev` 下的 `smoke.sh`） |
| C13 | `Content-Disposition` 迁移基线不明、路径未净化 | 切片 3 步骤 3（形状同线上，filename 净化）；切片 2 步骤 6（V2 路径字符集） |
| C-内部 | plan 内部：`revokedCount` 可空 vs 发布即解析；严格时间放在切片 4 而切片 2 已需要 | 切片 5a 步骤 5（非空）；切片 2 步骤 1（严格时间随 pki 迁入提前到切片 2） |

## B.3 完整性评审：计划漏写的旧规则

| 编号 | 规则（简） | 处理 |
| --- | --- | --- |
| M1 | 证书与 CRL 严格 DER：单一顶层元素、解码错误即拒、BER 编码（不定长、非最短长度或标签、构造形式的字符串、空 INTEGER、非最短 INTEGER / ENUMERATED、0x80 开头的 OID 子标识符、带内容的 NULL、非 00 / FF 的 BOOLEAN 等）即拒、RFC 5280 时间 | 切片 2 步骤 1、5（证书）；切片 4 步骤 6（CRL；内容规则来自切片 4 评审 C2，测试 `tests/core/pki/asn1.test.ts`） |
| M2 | CRL Number / Delta 指示须恰好一个 INTEGER、非负、BigInt；不设 RFC 5280 的 20 octet 上限，至多 48 octet（号进文件名） | 切片 4 步骤 2、6（测试 `tests/core/publish.test.ts` 的合成畸形值与生成的 CA、`tests/core/summary.test.ts`）；切片 2 测试 `tests/core/pki/parsers.test.ts` |
| M3 | AKI `keyIdentifier` 必需 | 切片 4 步骤 6（`issuer_not_found` + `missing_aki`，owner 确认 3；AKI 的 `keyIdentifier` 为空是 `invalid_crl`） |
| M4 | key id 规范为小写 hex | 切片 2 步骤 4（schema 拒大写）与 `tests/core/summary.test.ts` 的跨切片锁定；切片 4 步骤 6 |
| M5 | 签发者并列规则（畸形 SKI、多证书同 SKI） | 切片 2 步骤 3（畸形 SKI 拒导入）、步骤 6（V6）；切片 4 步骤 6（按目标配置的签发者验签，owner 确认 4）；切片 7 步骤 2、5（迁移归属与历史导入同一规则） |
| M6 | 带合法 Delta 指示才是 delta | 切片 4 步骤 6；切片 5a 步骤 3（删 `determineCrlType`） |
| M7 | PEM 输入策略 | 切片 2 步骤 1（`toDer`、`splitPemBlocks`，开工前需 owner 确认第 1 项）；切片 4 步骤 6 |
| M8 | 上传 body：字段 `crl`、字符串字段、415 `details.received` | 切片 4 步骤 8（测试 `tests/http/crls-upload.test.ts`）；切片 5b 步骤 7（UI 只发文件字段；测试 `tests/web/upload-card.test.ts`） |
| M9 | 任何拒绝零写入 | 切片 2 步骤 5（导入）；切片 4 步骤 6（发布，测试 `tests/core/publish.test.ts` 的写日志）；切片 6 步骤 3（退役后上传） |
| M10 | 可验算法集与 SHA-1 | 切片 4 步骤 4（SHA-1 接受，owner 确认 1；测试 `tests/core/pki/verify.test.ts`） |
| M11 | 外层与 TBS 签名算法须相同（比较收到的字节） | 切片 4 步骤 3（`invalid_crl` / `signature_algorithm_mismatch`，owner 确认 5；测试 `tests/core/pki/crl-policy.test.ts`；改写外层算法的上传见 `tests/core/publish.test.ts`）；证书导入同样比较（切片 5a 评审修复，`invalid_certificate` / `signature_algorithm_mismatch`；`tests/core/import.test.ts`、`tests/http/admin.test.ts`） |
| M12 | 对收到的 TBS 字节验签 | 切片 4 步骤 4；测试 `tests/core/pki/verify.test.ts` |
| M13 | CRL 条目扩展的关键性 | 切片 4 步骤 3；测试 `tests/core/pki/crl-policy.test.ts` |
| M14 | 已识别扩展标为关键时接受 | 切片 4 步骤 3；测试 `tests/core/pki/crl-policy.test.ts` |
| M15 | 新鲜度细节（两侧无号、同号更晚、BigInt 与时刻比较） | 切片 4 步骤 5；测试 `tests/core/freshness.test.ts` |
| M16 | 上传结果带 `baseCrlNumber` 与签发者 | 切片 4 步骤 8（测试 `tests/http/crls-upload.test.ts`）；切片 5b 步骤 7（成功 Alert 列 CRL 号、delta 的 base 号与下载路径；测试 `tests/web/upload-card.test.ts` 查 CRL 号与路径） |
| M17 | `Content-Disposition` filename 与路径字符集 | 切片 2 步骤 6（V2）；切片 3 步骤 3 |
| M18 | 下载 `Last-Modified` | 切片 3 步骤 3（保留，默认值） |
| M19 | 下载错误纯文本 | 切片 1 步骤 4（404）；切片 3 步骤 4–5（404 / 405 带 `no-store`，405 另带 `Allow`） |
| M20 | 下载路径精确匹配、`%2F`、畸形 `%` | 切片 3 步骤 2 |
| M21 | 证书摘要格式与可空 | 切片 2 步骤 4 |
| M22 | PEM 输出格式（64 列、LF、结尾换行） | 切片 3 步骤 1 |
| M23 | 导入证书不等于授权签发者 | 切片 2 步骤 5；切片 4 步骤 6（`target_not_configured`）；切片 6 步骤 10（`docs/api.md`）；切片 7 步骤 3 |
| M24 | 助手顺序与单文件失败隔离 | 切片 4 步骤 11（Windows 验证第 5 条，`docs/operations.md`）；切片 7 步骤 9 |
