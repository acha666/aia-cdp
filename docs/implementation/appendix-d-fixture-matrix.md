# 附录 D. 夹具用例矩阵（重写契约）

与入库的 `tests/fixtures/pki/manifest.json` 一致（含切片 1 步骤 9 对 `leaf-min` 的修改）。
后续切片的测试按名字引用这些夹具、从 manifest 读值；重写生成器时，文件名、签发者、kind、声明值（序列号、有效期、CRL 号、base 号、时间、吊销条数）
与期望结果必须逐项保持，sha256 与大小随密钥变、不在契约内。时间为 UTC，未写年份的是 2026；路径相对 `tests/fixtures/pki/`；`manifest.now` =
`2026-01-04T00:00:00Z`。切片 4 步骤 1 另加 `certs/issuing-ca-1-renamed` 与 CRL 条目的 `nextPublish` 字段。

## D.1 证书（`certs/<名>.der` 与 `.pem`，12 张）

| 名 | 签发者 | 密钥 | 序列号（hex） | 有效期 | `import` | 用途 |
| --- | --- | --- | --- | --- | --- | --- |
| `root-ca` | 自签 | EC P-384 | 1000 | 2025-01-01 – 2045-01-01 | 是 | 离线根，ecdsa-with-SHA384（同线上根） |
| `issuing-ca-1` | root-ca | RSA-2048 | 1001 | 2025-01-01 – 2035-01-01 | 是 | AD CS SubCA 形状：CA Version 0、模板名 BMPString `SubCA`、AIA、CDP |
| `issuing-ca-2` | root-ca | RSA-2048 | 1002 | 2025-01-01 – 2035-01-01 | 是 | 第二个签发 CA |
| `issuing-ca-1-renewed` | root-ca | RSA-2048（issuing-ca-1 的钥） | 1003 | 2025-12-01 – 2035-12-01 | 否 | 同钥同 SKI 续期：CA Version 1、Previous CA Certificate Hash（V6、M5、C5） |
| `rogue-ca` | 自签 | RSA-2048 | 4000 | 2025-01-01 – 2035-01-01 | 否 | 主体与 issuing-ca-1 相同、密钥不同，从不导入 |
| `ed25519-ca` | 自签 | Ed25519 | 5000 | 2025-01-01 – 2035-01-01 | 是 | `unsupported_algorithm` 的签发者 |
| `ed448-ca` | 自签 | Ed448 | 6000 | 2025-01-01 – 2035-01-01 | 是 | `unsupported_algorithm` 的签发者 |
| `leaf-full` | issuing-ca-1 | EC P-256 | 2000 | 2025-12-01 – 2026-12-01 | 否 | 扩展齐全：UTF8String 主体、SAN（DNS / IPv4 / IPv6 / URI / email / UPN otherName）、CDP、Freshest CRL、AIA（含 OCSP）、证书策略 |
| `leaf-min` | issuing-ca-1 | EC P-256 | 2001 | 2025-12-01 – 2026-12-01 | 否 | 只有 basicConstraints，无 SKI / AKI |
| `leaf-revoked` | issuing-ca-1 | EC P-256 | 2002 | 2025-12-01 – 2026-12-01 | 否 | 自 issuing-ca-1 `full-01` 起吊销：keyCompromise + invalidityDate |
| `leaf-superseded` | issuing-ca-1 | EC P-256 | 2003 | 2025-12-01 – 2026-12-01 | 否 | 自 `full-03` 起吊销：superseded |
| `leaf-hold` | issuing-ca-2 | EC P-256 | 3000 | 2025-12-01 – 2026-12-01 | 否 | issuing-ca-2 `full-01`：certificateHold + holdInstructionReject |

## D.2 CRL（`crls/<签发者>/<名>.der`，30 个）

另有 3 个 PEM 变体 `issuing-ca-1/full-01.pem`、`issuing-ca-1/full-01.crlf.pem`（CRLF 换行）、`root-ca/full-01.pem`，解码后与对应 DER 逐字节相同。
"首次上传"即 manifest 的 `expect`：目标已配置、尚无 current 时的结果。签名者都是所在目录的 CA，`full-forged-aki` 除外。

| 文件 | kind | CRL 号 | base | thisUpdate | nextUpdate | 吊销 | 首次上传 | 场景 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `root-ca/full-01` | full | 4096 | — | 01-01 00:00 | 07-01 00:00 | 0 | `created` | ECDSA P-384 |
| `root-ca/full-02` | full | 4097 | — | 01-02 00:00 | 07-02 00:00 | 0 | `created` | 在 full-01 之后 updated |
| `root-ca/full-02-resigned` | full | 4097 | — | 01-02 00:00 | 07-02 00:00 | 0 | `created` | TBS 同 full-02、ECDSA 重签：对 full-02 conflict |
| `issuing-ca-1/full-01` | full | 1 | — | 01-01 00:00 | 01-08 00:00 | 1 | `created` | 首个 full |
| `issuing-ca-1/delta-01` | delta | 2 | 1 | 01-01 12:00 | 01-03 00:00 | 1 | `created` | base 1 的 delta（在 `now` 已过期） |
| `issuing-ca-1/full-02` | full | 3 | — | 01-02 00:00 | 01-09 00:00 | 1 | `created` | 在 full-01 之后 updated |
| `issuing-ca-1/full-02-conflict` | full | 3 | — | 01-02 00:00 | 01-09 12:00 | 1 | `created` | 同号同 thisUpdate、nextUpdate 不同：对 full-02 conflict |
| `issuing-ca-1/full-02-reissued` | full | 3 | — | 01-02 06:00 | 01-09 06:00 | 1 | `created` | 同号、thisUpdate 更晚：对 full-02 updated |
| `issuing-ca-1/delta-02` | delta | 4 | 3 | 01-02 12:00 | 01-04 06:00 | 1 | `created` | 在 delta-01 之后 updated |
| `issuing-ca-1/full-03` | full | 5 | — | 01-03 00:00 | 01-10 00:00 | 2 | `created` | 两条吊销 |
| `issuing-ca-1/full-04-older-time` | full | 6 | — | 01-02 20:00 | 01-09 20:00 | 2 | `created` | 号比 full-03 大、thisUpdate 更早：号优先，updated |
| `issuing-ca-1/full-no-number` | full | — | — | 01-03 06:00 | 01-10 06:00 | 2 | `created` | 无 CRL Number：与有号 current 双向 non_orderable |
| `issuing-ca-1/full-no-aki` | full | — | — | 01-03 06:00 | 01-10 06:00 | 2 | `issuer_not_found` | 没有任何 CRL 扩展（无 AKI；切片 4 默认另带 `details.reason = "missing_aki"`） |
| `issuing-ca-1/full-broken-sig` | full | 10 | — | 01-03 12:00 | 01-10 12:00 | 2 | `invalid_signature` | 签名末字节翻转 |
| `issuing-ca-1/full-forged-aki` | full | 11 | — | 01-03 12:00 | 01-10 12:00 | 0 | `invalid_signature` | issuing-ca-1 的名称与 AKI，rogue-ca 的密钥签名 |
| `issuing-ca-1/full-unknown-critical` | full | 12 | — | 01-03 12:00 | 01-10 12:00 | 2 | `unknown_critical_extension` | 关键 `1.3.6.1.4.1.32473.1` |
| `issuing-ca-1/full-unknown-noncritical` | full | 13 | — | 01-03 12:00 | 01-10 12:00 | 2 | `created` | 非关键 `1.3.6.1.4.1.32473.2`，原样保留 |
| `issuing-ca-1/full-idp-scoped` | full | 14 | — | 01-03 12:00 | 01-10 12:00 | 2 | `scoped_crl_unsupported` | 关键 IDP，onlyContainsUserCerts |
| `issuing-ca-1/full-idp-dp-only` | full | 15 | — | 01-03 12:00 | 01-10 12:00 | 2 | `scoped_crl_unsupported` | 只含 DP 的关键 IDP（AD CS 选项）；切片 4 owner 确认 2 的默认是接受（→ `created`） |
| `issuing-ca-1/full-pss` | full | 16 | — | 01-03 12:00 | 01-10 12:00 | 2 | `created` | RSASSA-PSS：SHA-256、MGF1 SHA-256、salt 32 |
| `issuing-ca-1/full-no-next-update` | full | 17 | — | 01-03 12:00 | — | 2 | `created` | 去掉 nextUpdate 后重签：下载缓存 300 s |
| `issuing-ca-1/full-bad-time` | full | 18 | — | 01-03 12:00 | 01-10 12:00 | 2 | `invalid_crl` | thisUpdate 为无秒 UTCTime `2601031200Z`，签名有效 |
| `issuing-ca-1/full-adcs` | full | 19 | — | 01-03 11:50 | 01-11 00:10 | 2 | `created` | AD CS 扩展集：CA Version、Next CRL Publish（01-10 12:00）、Freshest CRL、CRL Self CDP，均非关键 |
| `issuing-ca-1/delta-adcs` | delta | 20 | 19 | 01-03 17:50 | 01-05 06:10 | 2 | `created` | AD CS delta 扩展集：关键 Delta 指示、Next CRL Publish（01-04 18:00） |
| `issuing-ca-1/full-future` | full | 30 | — | 2099-01-01 00:00 | 2099-01-08 00:00 | 2 | `not_yet_valid` | GeneralizedTime 2099，任何时钟下都超前 |
| `issuing-ca-2/full-01` | full | 1 | — | 01-01 00:00 | 01-08 00:00 | 1 | `created` | certificateHold 条目 |
| `issuing-ca-2/delta-01` | delta | 2 | 1 | 01-01 12:00 | 01-03 00:00 | 1 | `created` | base 1 的 delta |
| `rogue-ca/full-01` | full | 1 | — | 01-01 00:00 | 01-08 00:00 | 0 | `issuer_not_found` | AKI 指向从不导入的证书 |
| `ed25519-ca/full-01` | full | 1 | — | 01-01 00:00 | 01-08 00:00 | 0 | `unsupported_algorithm` | Ed25519 签名 |
| `ed448-ca/full-01` | full | 1 | — | 01-01 00:00 | 01-08 00:00 | 0 | `unsupported_algorithm` | Ed448 签名 |

## D.3 无效输入（`invalid/`，6 个，期望都是 `invalid_crl`）

`garbage.txt`（文本）、`empty.bin`（0 字节）、`truncated.der`（DER CRL 的前 64 字节）、`truncated.pem`（缺 END 行的 PEM）、
`trailing-byte.der`（合法 CRL 后加一个 `0x00`）、`certificate.der`（把证书当 CRL 上传）。

## D.4 场景（`scenarios`，17 条；省略 `crls/` 与 `.der`）

| current | 上传 | 结果 |
| --- | --- | --- |
| — | `issuing-ca-1/full-01` | `created` |
| `issuing-ca-1/full-01` | `issuing-ca-1/full-01` | `unchanged` |
| `issuing-ca-1/full-01` | `issuing-ca-1/full-01.pem` | `unchanged` |
| `issuing-ca-1/full-01` | `issuing-ca-1/full-02` | `updated` |
| `issuing-ca-1/full-02` | `issuing-ca-1/full-01` | `stale_crl` |
| `issuing-ca-1/full-02` | `issuing-ca-1/full-02-conflict` | `conflict` |
| `issuing-ca-1/full-02` | `issuing-ca-1/full-02-reissued` | `updated` |
| `issuing-ca-1/full-02-reissued` | `issuing-ca-1/full-02` | `stale_crl` |
| `issuing-ca-1/full-03` | `issuing-ca-1/full-04-older-time` | `updated` |
| `issuing-ca-1/full-02` | `issuing-ca-1/full-no-number` | `non_orderable` |
| `issuing-ca-1/full-no-number` | `issuing-ca-1/full-02` | `non_orderable` |
| `issuing-ca-1/delta-01` | `issuing-ca-1/delta-02` | `updated` |
| `issuing-ca-1/delta-02` | `issuing-ca-1/delta-01` | `stale_crl` |
| `issuing-ca-1/delta-02` | `issuing-ca-1/delta-adcs` | `updated` |
| `issuing-ca-1/full-03` | `issuing-ca-1/full-adcs` | `updated` |
| `root-ca/full-01` | `root-ca/full-02` | `updated` |
| `root-ca/full-02` | `root-ca/full-02-resigned` | `conflict` |
