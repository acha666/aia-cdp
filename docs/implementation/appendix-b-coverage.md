# 附录 B. 缺陷与评审项覆盖

"切片 N 步骤 k"指该切片"步骤"下的第 k 条；同一项分在几处处理时按先后列出。

## B.1 plan §10 旧实现缺陷

| 编号 | 缺陷（简） | 处理 |
| --- | --- | --- |
| §10 #1 | 下载无 304、HEAD 无 `Content-Length`、`ETag` 无引号 | 切片 3 步骤 3–4（摘要 `ETag`、`ifNoneMatchHit` 先于读 blob、显式 `Content-Length`）；测试 `tests/http/downloads.test.ts`、`tests/integration/downloads.test.ts` |
| §10 #2 | 下载暴露 `archive/`、`by-keyid/` 与任意对象；详情接受归档 id | 切片 3 步骤 2（只走路径表，内部键不可达）；切片 5a 步骤 6（id 参数格式，归档形 id → 400）；切片 5b 步骤 6（UI 对非法 id 不发请求）；切片 7 步骤 8（按访问日志决定是否给旧 URL 加路径） |
| §10 #3 | CRL `max-age` 无上限、过期后为 0 | 切片 3 步骤 3（夹紧 [60 s, 3600 s]，无 `nextUpdate` 300 s） |
| §10 #4 | 相同 CRL 重复上传 409 | 切片 4 步骤 5（`unchanged` 200）；切片 5b 步骤 7（`unchanged` 是成功文案） |
| §10 #5 | 伴随写失败报 500；`caches.default` 在 Node 上崩 | 切片 2 步骤 5（导入单提交点）；切片 4 步骤 6（无伴随写、无边缘缓存，catalog 写成功即完成） |
| §10 #6 | 归档写无条件、并发发布无保护 | 切片 4 步骤 2、6（内容寻址 blob + `ifMatch` 条件写重试）；已被 Gen A/B 覆盖的旧版本不可恢复，切片 7 步骤 4 在报告写明 |
| §10 #7 | `revokedCount` 未知时显示 0 | 切片 4 步骤 2（发布时必有非空 `revokedCount`）；切片 5a 步骤 5（"未知"只以 `current: null` 出现）；切片 5b 步骤 6 |
| §10 #8 | 详情缺 `signatureAlgorithm`、`parameters` 不输出、死变体 | 切片 5a 步骤 1、3（构建器迁入；删 `UnknownExtensionValueSchema`；签名算法必填） |
| §10 #9 | 全 null 信封通过 200 校验成空列表 | 切片 5a 步骤 5–6（按状态码 schema；store 抛错 500，不是 `200 []`） |
| §10 #10 | `relationships` 恒空 | 切片 5a 步骤 5（证书 `targets`、CRL `issuer`）；切片 5b 步骤 6（页面链接） |
| §10 #11 | 畸形 ASN.1 时间成 1899 | 切片 2 步骤 1（`assertWellFormed` 随 pki 迁入，证书导入即拒）；切片 4 步骤 6（CRL `reason: "time"`） |
| §10 #12 | 未来 `thisUpdate`、未知关键扩展、作用域 CRL 无策略 | 切片 4 步骤 3 |
| §10 #13 | `constructor.name` 判编码 | 切片 2 步骤 1（`toDer` 按字节识别 PEM / DER）；DN 编码按 tag 判定随切片 5a 步骤 3 的构建器迁入 |
| §10 #14 | 证书只能手工放进 R2 | 切片 2 步骤 3、5、8（导入接口，导入时生成完整摘要） |
| §10 #15 | 健康检查硬编码 | 切片 1 步骤 4（真实 store / configuration 检查，D5）；切片 2 步骤 7（完整 schema 与规则） |
| §10 #16 | 统计按桶前缀字节 | 切片 5a 步骤 5 |
| §10 #17 | ts-rest 忽略 `no-store` | 切片 1 步骤 6（`hc` 的 `init.cache`）；切片 5a 步骤 7（API `no-store`）；切片 5b 步骤 5（上传后全量失效） |
| §10 #18 | `SITE_NAME` 多条死通道 | 切片 1 步骤 6（只剩构建期 `VITE_SITE_NAME`，校验与默认值）；切片 5b 步骤 6（页头、页脚） |
| §10 #19 | 上传无体积上限、无鉴权 | 切片 4 步骤 8（`bodyLimit`、可选 `bearerAuth`）；切片 7 开工前需 owner 确认第 3 项（生产启用令牌） |
| §10 #20 | 助手 PS5 死分支、手搓 multipart、按扩展名判格式、409 当失败 | 切片 4 步骤 11；切片 7 步骤 9（生产安装） |
| §10 #21 | 测试 glob、钩子挂起、`pretest` 重生成夹具 | 切片 1 步骤 9–10 |
| §10 #22 | 没有 Node / Docker 运行方式 | 切片 1 步骤 5、11 |
| §10 #23 | 没有退役、删除、历史的管理路径 | 切片 2 步骤 8–9（import / config）；切片 6 步骤 1–7 |
| §10 #24 | 日志无结构 | 切片 1 步骤 4（请求日志）；切片 2 步骤 8、切片 4 步骤 6、切片 6 步骤 2（导入 / 发布 / 退役各一行）；总则 §2.6 |
| §10 #25 | `thisUpdate` 缺失序列化为空串 | 切片 4 步骤 6（解析期拒绝）、步骤 8（成功体 `thisUpdate` 必填） |
| §10 #26 | 文档与代码多处不一致 | 切片 6 步骤 8–12（OpenAPI 漂移、docs-consistency 测试、README / `docs/api.md` / `docs/operations.md` 重写） |
| §10 #27 | 详情解析覆盖不足 | 切片 5a 步骤 1、3（41 个解析器与 schema 迁入）；回归改用合成夹具（D7，切片 5a 测试表）；线上工件的解码核对在切片 7 步骤 7 |
| §10 #28 | 未识别扩展只给 hex；UI 签名算法 Unknown | 切片 5a 步骤 5（详情一次全量）；切片 5b 步骤 3、6（ASN.1 dump、带参数的签名算法） |

## B.2 完整性评审：计划矛盾

| 编号 | 矛盾（简） | 处理 |
| --- | --- | --- |
| C1 | PKIjs `crl.verify()` 暗中比较签发者 DN | 切片 4 步骤 4（`verifyWithPublicKey`，B21）；步骤 1 的 `issuing-ca-1-renamed` 夹具与 `verify.test.ts` |
| C2 | PKIjs 隐藏的关键扩展闸（关键 AD CS 扩展被拒、关键 IDP 被收） | 切片 4 步骤 3（显式策略表，含条目扩展）、步骤 4（绕开闸）；`verify.test.ts` 回归 |
| C3 | 新鲜度结果与旧实现不同（同号同时间、单侧有号） | 切片 4 步骤 5 |
| C4 | 不可验算法一律报 `invalid_signature` | 切片 4 步骤 4（白名单，名单外 → `unsupported_algorithm`） |
| C5 | `issuer_mismatch` 两种含义、按 plan 不可达 | 切片 2 步骤 6（V6）；切片 4 步骤 6–7（上传不产生）；切片 7 步骤 5（只用于临时历史导入），步骤 11 删除 |
| C6 | 内容类型按键后缀（PEM `text/plain`） | 切片 3 步骤 3、6 |
| C7 | 缓存头去掉 `s-maxage` / `stale-while-revalidate`、丢 `Last-Modified` | 切片 3 步骤 3、6；切片 7 步骤 10（CryptoAPI 冒烟） |
| C8 | 孤儿 blob 进历史、破坏零写入不变量 | 切片 4 步骤 6（history 标记，历史 = 标记 ∪ current）；切片 6 步骤 4（列表不含孤儿）；切片 2 步骤 5（证书孤儿 blob 不可见）；切片 7 步骤 5（导入写标记） |
| C9 | 历史迁移前提描述的是从未部署的 Gen C | 切片 7 目标与范围、步骤 1–4（尽力而为、HTTP 探测 + stats 对账）；开工前需 owner 确认第 1 项 |
| C10 | 旧助手把 v1 响应记为失败 | 切片 4 步骤 11（重写）；切片 7 步骤 9（切换时替换脚本与令牌文件） |
| C11 | plan §11 声称的夹具覆盖不存在 | 切片 1 步骤 9（生成器随切片 1 提交；12 张证书、30 个 CRL、6 个无效输入与 17 个场景逐项列在附录 D，即重写契约）；切片 4 步骤 1 与测试（逐场景断言）、步骤 12（plan §11 同步） |
| C12 | Workers SPA 兜底会把 `/api` 与下载未命中答成 200 HTML | 切片 1 步骤 4（`ui.ts` 与 `notFound`）、步骤 12（`smoke.sh` 跑两条运行时）；切片 3 步骤 5；切片 5b 出口 4 |
| C13 | `Content-Disposition` 迁移基线不明、路径未净化 | 切片 3 步骤 3（形状同线上，filename 净化）；切片 2 步骤 6（V2 路径字符集） |
| C-内部 | plan 内部：`revokedCount` 可空 vs 发布即解析；严格时间放在切片 4 而切片 2 已需要 | 切片 5a 步骤 5（非空）；切片 2 步骤 1（严格时间随 pki 迁入提前到切片 2） |

## B.3 完整性评审：计划漏写的旧规则

| 编号 | 规则（简） | 处理 |
| --- | --- | --- |
| M1 | 证书与 CRL 严格 DER：单一顶层元素、解码错误即拒、BER 编码（不定长、非最短长度或标签、构造形式的字符串、空 INTEGER 等）即拒、RFC 5280 时间 | 切片 2 步骤 1、5（证书）；切片 4 步骤 6（CRL） |
| M2 | CRL Number / Delta 指示须 INTEGER、非负、BigInt、无 20 octet 上限 | 切片 4 步骤 6；切片 2 测试 `tests/core/pki/parsers.test.ts` |
| M3 | AKI `keyIdentifier` 必需 | 切片 4 步骤 6（默认 `issuer_not_found` + `missing_aki`，开工前需 owner 确认第 3 项） |
| M4 | key id 规范为小写 hex | 切片 2 步骤 4（schema 拒大写）与 `tests/core/summary.test.ts` 的跨切片锁定；切片 4 步骤 6 |
| M5 | 签发者并列规则（畸形 SKI、多证书同 SKI） | 切片 2 步骤 3（畸形 SKI 拒导入）、步骤 6（V6）；切片 4 步骤 6（按目标配置的签发者验签，开工前需 owner 确认第 4 项）；切片 7 步骤 2、5（迁移归属与历史导入同一规则） |
| M6 | 带合法 Delta 指示才是 delta | 切片 4 步骤 6；切片 5a 步骤 3（删 `determineCrlType`） |
| M7 | PEM 输入策略 | 切片 2 步骤 1（`toDer`、`splitPemBlocks`，开工前需 owner 确认第 1 项）；切片 4 步骤 6 |
| M8 | 上传 body：字段 `crl`、字符串字段、415 `details.received` | 切片 4 步骤 8；切片 5b 步骤 7 |
| M9 | 任何拒绝零写入 | 切片 2 步骤 5（导入）；切片 4 步骤 6（发布）；切片 6 步骤 3（退役后上传） |
| M10 | 可验算法集与 SHA-1 | 切片 4 步骤 4（开工前需 owner 确认第 1 项） |
| M11 | 外层与 TBS 签名算法须相同 | 切片 4 步骤 3（开工前需 owner 确认第 5 项） |
| M12 | 对收到的 TBS 字节验签 | 切片 4 步骤 4 |
| M13 | CRL 条目扩展的关键性 | 切片 4 步骤 3 |
| M14 | 已识别扩展标为关键时接受 | 切片 4 步骤 3 |
| M15 | 新鲜度细节（两侧无号、同号更晚、BigInt 与时刻比较） | 切片 4 步骤 5 |
| M16 | 上传结果带 `baseCrlNumber` 与签发者 | 切片 4 步骤 8；切片 5b 步骤 7 |
| M17 | `Content-Disposition` filename 与路径字符集 | 切片 2 步骤 6（V2）；切片 3 步骤 3 |
| M18 | 下载 `Last-Modified` | 切片 3 步骤 3（保留，默认值） |
| M19 | 下载错误纯文本 | 切片 1 步骤 4（404）；切片 3 步骤 4–5（404 / 405 带 `no-store`，405 另带 `Allow`） |
| M20 | 下载路径精确匹配、`%2F`、畸形 `%` | 切片 3 步骤 2 |
| M21 | 证书摘要格式与可空 | 切片 2 步骤 4 |
| M22 | PEM 输出格式（64 列、LF、结尾换行） | 切片 3 步骤 1 |
| M23 | 导入证书不等于授权签发者 | 切片 2 步骤 5；切片 4 步骤 6（`target_not_configured`）；切片 6 步骤 10（`docs/api.md`）；切片 7 步骤 3 |
| M24 | 助手顺序与单文件失败隔离 | 切片 4 步骤 11；切片 7 步骤 9 |
