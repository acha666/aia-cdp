# 附录 A. 迁移清单

来源 `worker-aia-cdp@5b570aa`（D4）。由五份迁移盘点生成，按旧路径列出处置、新位置与切片；处置词见总则 §1.4。各切片正文与本表冲突时以切片为准。

| 旧路径（worker-aia-cdp@5b570aa） | 处置 | 新位置 | 切片 |
| --- | --- | --- | --- |
| `src/worker/pki/asn1.ts` | migrate-as-is | src/core/pki/asn1.ts | 2 |
| `src/worker/pki/constants.ts` | migrate-as-is | src/core/pki/constants.ts | 2 |
| `src/worker/pki/extensions.ts` | migrate-as-is | src/core/pki/extensions.ts | 2 |
| `src/worker/pki/parsers.ts` | migrate-adapt | src/core/pki/parsers.ts | 2 |
| `src/worker/pki/pem.ts` | migrate-adapt | src/core/pki/pem.ts | 2 |
| `src/worker/pki/pkijs.ts` | drop | — | none |
| `src/worker/pki/utils/conversion.ts` | migrate-adapt | src/core/digest.ts | 2 |
| `src/worker/pki/crls.ts` | reference-only | src/core/pki/verify.ts (rewrite) + freshness in src/core/publish.ts | 4 |
| `src/worker/api/v2/builders/primitives.ts` | migrate-adapt | src/core/summary/primitives.ts（`formatGeneralizedTime` 移入 src/core/pki/asn1.ts，切片 4） | 4,5a |
| `src/worker/api/v2/builders/extensions.ts` | migrate-adapt（导入；`buildTime` 收 `new pkijs.Time`；`noUncheckedIndexedAccess` 小修与 `isBlock` 守卫；评审修复：整数按内容字节读、SCT 列表校验；41 个字面量不变） | src/core/summary/extensions.ts | 5a |
| `src/worker/api/v2/builders/certificate.ts` | migrate-adapt（导入；删 `options.extensions`） | src/core/summary/certificate.ts | 5a |
| `src/worker/api/v2/builders/crl.ts` | migrate-adapt | src/core/summary/crl.ts | 5a |
| `tests/data/adcs.ts` | drop（D7：不入库；改用合成 AD CS 风格夹具） | — | 1 |
| `tests/worker/extension-parsers.test.ts` | migrate-adapt | tests/core/summary/extension-parsers.test.ts + tests/core/pki/asn1.test.ts | 2,5a |
| `tests/worker/pki-values.test.ts` | migrate-adapt | tests/core/pki/parsers.test.ts + tests/core/summary/values.test.ts + tests/core/publish.test.ts | 2,4,5a |
| `tests/worker/extensions-structure.test.ts` | migrate-as-is | tests/core/summary/extensions-structure.test.ts | 5a |
| `tests/worker/pem.test.ts` | migrate-as-is | tests/core/pki/pem.test.ts | 2 |
| `tests/worker/conversion.test.ts` | migrate-as-is | tests/core/pki/conversion.test.ts | 2 |
| `tests/worker/artifact-representation.test.ts` | drop | — | none |
| `src/worker/r2/certificates.ts` | rewrite | src/core/publish.ts (resolveIssuer/resolveTarget over catalog.certificates[*].summary.subjectKeyId + config.targets) | 4 |
| `src/worker/r2/crls.ts` | reference-only | scripts/migrate-from-v2.ts (slice 7); issuer_mismatch only in the temporary history-import route (slice 7; publish never emits it, slice 4) | 7 |
| `src/worker/r2/listing.ts` | reference-only | src/storage/r2.ts (list(prefix) cursor loop) | 1 |
| `src/worker/r2/metadata.ts` | drop | — | none |
| `src/worker/r2/objects.ts` | migrate-adapt | src/storage/r2.ts (put/get/head) | 1 |
| `src/worker/r2/summary.ts` | migrate-adapt | src/core/summary/catalog-summary.ts (buildCertificateSummary, buildCrlSummary) | 2,4 |
| `src/worker/api/v2/crls/upload.ts` | rewrite | src/core/publish.ts (publishCrl(deps, bytes); now = deps.now()) + src/http/routes/crls.ts (POST /api/v1/crls body handling) | 4 |
| `src/worker/api/v2/crls/metadata.ts` | drop | — | none |
| `src/worker/api/v2/certificates/metadata.ts` | drop | — | none |
| `src/worker/api/v2/shared/metadata-refresh.ts` | drop | — | none |
| `src/worker/cache/config.ts` | migrate-adapt | src/core/resources.ts (download cache policy) | 3 |
| `src/worker/cache/keys.ts` | drop | — | none |
| `src/worker/cache/operations.ts` | drop | — | none |
| `tests/worker/crl-upload.test.ts` | rewrite | tests/core/publish.test.ts + tests/core/freshness.test.ts + tests/http/crls-upload.test.ts + tests/integration/node-e2e.test.ts + tests/core/admin.test.ts (slice 2) | 2,4 |
| `tests/worker/r2-listing.test.ts` | drop | — | none |
| `tests/worker/r2-metadata.test.ts` | drop | — | none |
| `tests/worker/r2-summary.test.ts` | migrate-adapt | tests/core/summary.test.ts + tests/core/import.test.ts + tests/core/catalog.test.ts | 2,4 |
| `tests/worker/cache-config.test.ts` | migrate-adapt | tests/core/resources.test.ts + tests/http/downloads.test.ts | 3 |
| `tests/helpers/r2.ts` | migrate-adapt | tests/storage/fakes/r2-bucket.ts | 1 |
| `src/worker/worker.ts` | rewrite | src/runtime/worker.ts + src/http/app.ts + src/http/routes/downloads.ts | 1,3,5a |
| `src/worker/env.ts` | rewrite | wrangler types output (Env) + src/runtime/settings.ts | 1 |
| `src/worker/utils/content.ts` | rewrite | src/core/resources.ts (download policy) + src/http/routes/downloads.ts | 3 |
| `src/worker/utils/json-response.ts` | drop | — | 1 |
| `src/worker/api/v2/router.ts` | drop | — | 1 |
| `src/worker/api/v2/response.ts` | rewrite | src/http/errors.ts | 1 |
| `src/worker/api/v2/server.ts` | drop | — | 1 |
| `src/worker/api/v2/stats.ts` | rewrite | src/http/routes/health.ts (slice 1) + src/http/routes/stats.ts (slice 5a); counting in src/core/views.ts | 1,5a |
| `src/worker/api/v2/certificates/list.ts` | rewrite | src/http/routes/certificates.ts + src/core/views.ts | 5a |
| `src/worker/api/v2/certificates/detail.ts` | rewrite | src/http/routes/certificates.ts + src/core/views.ts (builders → src/core/summary/) | 5a |
| `src/worker/api/v2/certificates/constants.ts` | drop | — | 2 |
| `src/worker/api/v2/certificates/index.ts` | drop | — | none |
| `src/worker/api/v2/crls/list.ts` | rewrite | src/http/routes/crls.ts + src/core/views.ts | 5a |
| `src/worker/api/v2/crls/detail.ts` | rewrite | src/http/routes/crls.ts + src/core/views.ts | 5a |
| `src/worker/api/v2/crls/constants.ts` | drop | — | 2 |
| `src/worker/api/v2/crls/index.ts` | drop | — | none |
| `src/worker/api/v2/shared/pagination.ts` | drop | — | none |
| `src/worker/api/v2/shared/resource.ts` | drop | — | 3 |
| `src/contracts/api.ts` | drop | — | 1,4,5a |
| `src/contracts/schemas.ts` | migrate-adapt | src/core/summary/schemas.ts (X.509 projection, lines 12-497, 542-556, 578-604, types 768-866; `CrlTypeSchema` L510 not moved) + src/http/schemas.ts (v1 wrappers and errors) | 5a |
| `src/contracts/openapi.ts` | rewrite | scripts/generate-openapi.ts (+ doc config shared with the runtime /api/v1/openapi.json route) | 1,5a |
| `src/contracts/types.ts` | drop | — | none |
| `src/contracts/index.ts` | drop | — | none |
| `scripts/generate-openapi.ts` | migrate-adapt | scripts/generate-openapi.ts | 1,5a |
| `tests/worker/api-pagination.test.ts` | reference-only | tests/http/lists.test.ts（只取不变量） | 5a |
| `tests/worker/api-routing.test.ts` | rewrite | tests/http/app.test.ts + tests/http/downloads.test.ts + tests/http/certificates.test.ts | 1,3,5a |
| `tests/worker/api-stats.test.ts` | rewrite | tests/http/stats.test.ts | 5a |
| `tests/worker/json-response.test.ts` | drop | — | 1 |
| `docs/api-design-v2.md` | reference-only | docs/api.md (slice 6) | 6 |
| `src/web/index.html` | migrate-adapt | src/web/index.html（切片 5b 加预绘制主题脚本，CSP 按 hash 放行；2026-10-23 删除：亮 / 暗只跟随系统） | 1,5b |
| `src/web/public/favicon.svg` | migrate-as-is | src/web/public/favicon.svg | 1 |
| `src/web/public/favicon.ico` | migrate-as-is | src/web/public/favicon.ico | 1 |
| `src/web/env.d.ts` | migrate-adapt | src/web/env.d.ts | 1 |
| `src/web/main.ts` | rewrite | src/web/main.ts | 1 |
| `src/web/styles/tailwind.css` | rewrite | src/web/styles/main.css | 1 |
| `tailwind.config.ts` | drop | — | 1 |
| `vite.config.ts` | rewrite | vite.config.ts | 1 |
| `tsconfig.app.json` | rewrite | tsconfig.web.json | 1 |
| `src/web/App.vue` | rewrite | src/web/App.vue (layout shell) + src/web/pages/OverviewPage.vue | 5b |
| `src/web/api/client.ts` | rewrite | src/web/client/api.ts（`hc<AppType>` + `apiFetch`）+ src/web/client/types.ts（类型再导出与响应体别名） | 1,5a |
| `src/web/api/response.ts` | rewrite | src/web/client/errors.ts（`ApiError`、`unwrap`、`apiFetch`）+ src/web/client/error-codes.ts | 5a |
| `src/web/api/pagination.ts` | drop | — | none |
| `src/web/utils/status.ts` | migrate-adapt | src/web/utils/status.ts | 5b |
| `src/web/utils/dates.ts` | migrate-adapt | src/web/utils/dates.ts | 5b |
| `src/web/utils/format.ts` | migrate-adapt | src/web/utils/format.ts（`copyToClipboard` → src/web/utils/clipboard.ts，检查 `execCommand` 的结果） | 5b |
| `src/web/utils/x509.ts` | migrate-adapt | src/web/utils/x509.ts | 5b |
| `src/web/composables/useCrlUploadInput.ts` | migrate-as-is | src/web/composables/useCrlUploadInput.ts | 5b |
| `src/web/composables/useLocale.ts` | rewrite | src/web/composables/useLocale.ts | 5b |
| `src/web/composables/useTheme.ts` | drop | — | 5b |
| `src/web/composables/useCollectionLoader.ts` | drop | — | none |
| `src/web/composables/useDetailCache.ts` | drop | — | none |
| `src/web/i18n.ts` | migrate-adapt | src/web/i18n.ts | 5b |
| `src/web/locales/en.json` | migrate-adapt | src/web/locales/en.json (+ new src/web/locales/zh-CN.json) | 5b |
| `src/web/stores/certificates.ts` | drop | — | none |
| `src/web/stores/crls.ts` | drop | — | none |
| `src/web/components/ExtensionView.vue` | migrate-adapt | src/web/utils/extension-blocks.ts + src/web/components/x509/ExtensionView.vue | 5b |
| `src/web/components/ExtensionList.vue` | migrate-adapt | src/web/components/x509/ExtensionList.vue | 5b |
| `src/web/components/GeneralNameList.vue` | migrate-adapt | src/web/components/x509/GeneralNameList.vue | 5b |
| `src/web/components/DistributionPointList.vue` | migrate-adapt | src/web/components/x509/DistributionPointList.vue | 5b |
| `src/web/components/Asn1Dump.vue` | migrate-adapt | src/web/components/x509/Asn1Dump.vue | 5b |
| `src/web/components/NameDetails.vue` | migrate-adapt | src/web/components/x509/NameDetails.vue | 5b |
| `src/web/components/HexValue.vue` | migrate-adapt | src/web/components/HexValue.vue | 5b |
| `src/web/components/StatusBadge.vue` | migrate-adapt | src/web/components/StatusBadge.vue | 5b |
| `src/web/components/FingerprintDetails.vue` | rewrite | src/web/components/KeyValueList.vue | 5b |
| `src/web/components/CertificateDetails.vue` | rewrite | src/web/pages/CertificatePage.vue (+ src/web/components/certificate/CertificateOverview.vue) | 5b |
| `src/web/components/CrlDetails.vue` | rewrite | src/web/pages/CrlTargetPage.vue (+ src/web/components/crl/RevokedTable.vue, src/web/utils/crl-entries.ts) | 5b |
| `src/web/components/CrlUpload.vue` | rewrite | src/web/components/overview/CrlUploadCard.vue | 5b |
| `src/web/components/ThemeToggle.vue` | rewrite | src/web/components/ThemeToggle.vue（2026-10-23 删除：亮 / 暗只跟随系统） | 5b |
| `src/web/components/CertificateCard.vue` | reference-only | src/web/components/overview/CertificateTable.vue | 5b |
| `src/web/components/CrlCard.vue` | reference-only | src/web/components/overview/CrlTargetTable.vue | 5b |
| `src/web/components/ResourceCard.vue` | reference-only | src/web/components/DownloadLinks.vue | 5b |
| `src/web/components/SectionState.vue` | drop | — | none |
| `public/index.html` | drop | — | none |
| `public/js/main.js` | drop | — | none |
| `public/js/vue-B8VrgSNh.js` | drop | — | none |
| `public/js/state-BUPWKezW.js` | drop | — | none |
| `public/styles.css` | drop | — | none |
| `public/favicon.ico` | drop | — | none |
| `public/favicon.svg` | drop | — | none |
| `tests/web/status.test.ts` | migrate-adapt | tests/web/status.test.ts | 5b |
| `tests/web/upload-input.test.ts` | migrate-adapt | tests/web/upload-input.test.ts | 5b |
| `tests/web/components.test.ts` | rewrite | tests/web/components.test.ts | 5b |
| `tests/web/state.test.ts` | rewrite | tests/web/api-errors.test.ts | 5a |
| `tests/web/collection-loader.test.ts` | rewrite | tests/web/queries.test.ts | 5b |
| `tests/web/api-client.test.ts` | rewrite | tests/core/summary/schemas.test.ts (slice 5a) + tests/http/crls-upload.test.ts (slice 4) | 4,5a |
| `package.json` | rewrite | package.json | 1 |
| `pnpm-lock.yaml` | drop | pnpm-lock.yaml | 1 |
| `tsconfig.json` | rewrite | tsconfig.base.json + tsconfig.worker.json (+ solution-style tsconfig.json) | 1 |
| `tsconfig.node.json` | rewrite | tsconfig.node.json (check, noEmit) + tsconfig.build.json (rootDir src, outDir dist/server) | 1 |
| `eslint.config.ts` | migrate-adapt | eslint.config.ts | 1 |
| `.prettierrc.json` | migrate-as-is | .prettierrc.json | 1 |
| `.prettierignore` | migrate-adapt | .prettierignore | 1 |
| `.gitignore` | migrate-adapt | .gitignore | 1 |
| `.actrc` | drop | — | 1 |
| `redocly.yaml` | drop | — | none |
| `wrangler.jsonc` | migrate-adapt | wrangler.jsonc | 1 |
| `LICENSE` | migrate-as-is | LICENSE | 1 |
| `README.md` | rewrite | README.md | 6 |
| `.github/workflows/ci.yml` | rewrite | .github/workflows/ci.yml | 1 |
| `.github/workflows/pages.yml` | drop | — | none |
| `.github/dependabot.yml` | migrate-adapt | .github/dependabot.yml | 1 |
| `.devcontainer/devcontainer.json` | rewrite（D10：Node 24 镜像、PowerShell feature、非 root、无 act） | .devcontainer/devcontainer.json | 1 |
| `scripts/generate-test-data.sh` | rewrite | tests/fixtures/generate-test-data.sh（fixtures spike 成品 + `leaf-min` 修改；用例矩阵见附录 D） | 1 |
| `scripts/seed-dev.sh` | rewrite | scripts/seed-dev.ts（切片 5b 补上 CRL 发布） | 2,5b |
| `scripts/reset-dev.sh` | drop | — | 2 |
| `scripts/adcs-crl-uploader.ps1` | rewrite | scripts/adcs-crl-uploader.ps1 | 4 |
| `scripts/generate-docs-index.ts` | drop | — | none |
| `docs/development.md` | rewrite | README.md 的"开发"一节（不另设 docs/development.md） | 6 |
| `docs/architecture.md` | reference-only | docs/plan.md / docs/operations.md (absorbed) | none |
| `docs/templates/api-responses.example.json` | reference-only | — | 5a |
| `docs/templates/implementation-slice.md` | migrate-adapt | docs/templates/implementation-slice.md | 1 |
| `docs/templates/migration-inventory.example.json` | reference-only | — | 7 |
| `docs/templates/resources.example.json` | reference-only | docs/config.example.json（新写） | 2 |
| `tests/fixtures/pki` | drop | tests/fixtures/pki/（重新生成后入库） | 1 |
