# aia-cdp 运维手册

本文的部署、令牌、备份、迁移与回滚各节由切片 6 补全；目前只有切片 4 写的"AD CS 助手"一节。

## AD CS 助手

`scripts/adcs-crl-uploader.ps1`（仅 PowerShell 7）把 AD CS 写到本地目录的 CRL 经 `POST /api/v1/crls` 发布。参数与默认值以脚本头部的
帮助为准（`Get-Help <脚本路径> -Full`）；本节写它的行为要点、CA 上的安装与计划任务，以及一次手动 Windows 验证的记录。

凡涉及 AD CS 本身的事实（事件号与所在日志、CDP 设置、文件名、CertSvc 写文件的时序、运行账户在 CA 上的权限）都没有在真实 AD CS 上
验证过，逐项标"未核对"；切片 7 在生产 CA 上切换时核对并改掉这些标记。

### 行为要点

- 只看 `-SourceDir` 一层的 `*.crl`、`*.dcrl`、`*.pem`，按 `LastWriteTimeUtc` 升序（同时刻按文件名）；`X` 存在时跳过 `X.pem`（记为 Skipped）。
  full 与 delta 不靠文件名区分，服务端按内容的 Delta CRL 指示判定。
- 每个文件：以 `FileShare.Read` 打开（CA 还在写时抛 `IOException`，间隔 1 s 共试 5 次）→ 读到的字节的 SHA-256 等于账本里该路径的值 →
  Skipped，不发请求 → 首字节 `0x30` 发 `application/pkix-crl`，含 `-----BEGIN X509 CRL-----` 发 `application/x-pem-file`，都不是 → 失败、
  不上传 → 原始体 POST。两次实际上传之间停 `-UploadIntervalMs`（默认 1000 ms：R2 对 `catalog.json` 单键约每秒一次写，plan §5.5）。
- 账本 `-LedgerPath`（默认 `C:\ProgramData\PKI\crl-uploader\published.json`）是"文件完整路径 → 服务端接受过的字节的 SHA-256"：
  created / updated / unchanged 之后写入（临时文件 + `Move-Item -Force`）。账本缺失或损坏按空处理并 WARN，代价只是全部重发一遍、
  服务端答 unchanged。账本写不进去时该文件记为失败（服务端已接受，下次重发得 unchanged）。
- `stale_crl` 算失败：账本里没有这份字节，说明 CA（或误放进目录的旧副本）产出了比已发布更旧的 CRL。它不进账本，之后每次运行都会再失败，
  直到操作员查明并移走该文件。401 失败并提示 `-UploadTokenFile`；其余错误码、5xx、网络错误、超时（`-TimeoutSec`，默认 60）都只算该文件失败。
- 汇总行 `Completed. Created: n, Updated: n, Unchanged: n, Skipped: n, Failed: n`；有失败退出 1，否则 0（没有文件也是 0，WARN）。
  `-SourceDir` 不存在、`-UploadTokenFile` 指的文件缺失 / 为空 / 不是合法 bearer 令牌、带令牌而 `-UploadUri` 是 `http://`（未加
  `-AllowInsecureHttp`，该开关只给测试用）都在任何上传之前退出 1。
- 令牌只从 `-UploadTokenFile` 读（首尾空白忽略），经 `Invoke-RestMethod -Authentication Bearer -Token` 发送，不进日志、不进任务命令行。
  不给 `-UploadTokenFile` 时不发 `Authorization`，只有服务端未设 `AIA_UPLOAD_TOKEN` 时才能成功。
- 日志 `-LogPath`（默认 `C:\ProgramData\PKI\crl-uploader\upload.log`，UTF-8，追加）与控制台同一行格式
  `[yyyy-MM-dd HH:mm:ss.fffK][LEVEL] …`；写日志失败不影响运行。

### 安装

1. CA 上装 PowerShell 7（`C:\Program Files\PowerShell\7\pwsh.exe`）。
2. 脚本放在只有管理员可写的位置，例如 `C:\Program Files\aia-cdp\adcs-crl-uploader.ps1`：运行账户对数据目录有写权限（日志、账本），
   脚本若也在那里，该账户就能改写管理员日后手动运行的代码。脚本须在本地盘：`pwsh` 在 Windows 上默认 `RemoteSigned`，从网络路径
   （验证时的 `\\wsl.localhost\…`）或带下载标记的文件运行未签名脚本会被拒；经浏览器下载的文件先 `Unblock-File`。
3. 数据目录 `C:\ProgramData\PKI\crl-uploader\`：账本、日志、令牌文件，以及（第 4 步的第二种做法时）SourceDir `CertEnroll\`。
4. SourceDir 必须是 CA 的一个本地 CRL 发布位置，二选一（未核对）：
   - 用 AD CS 默认 CDP 的本地发布目录 `%windir%\System32\CertSrv\CertEnroll`（加 `-SourceDir`）；那里还有 CA 证书 `.crt`，助手不读；
   - 或在 CA 属性的"扩展"页给 CDP 加一个文件位置 `C:\ProgramData\PKI\crl-uploader\CertEnroll\<CaName><CRLNameSuffix><DeltaCRLAllowed>.crl`，
     勾选发布 CRL 与发布增量 CRL 到此位置，即脚本默认的 SourceDir。AD CS 给 delta 文件名加 `+`（如 `Example CA+.crl`），与 full 同为 `.crl`。
5. `certutil -setreg CA\LogLevel 4` 后 `Restart-Service certsvc`：旧部署的 README 说事件 68/69/70 在此级别才记录（未核对）。
6. 令牌文件 `C:\ProgramData\PKI\crl-uploader\upload-token.txt`，内容为服务端的 `AIA_UPLOAD_TOKEN`（`openssl rand -hex 32` 一类；只能含
   字母、数字与 `-._~+/`，可以 `=` 结尾），限权见下。

### 运行账户与权限

- 用专用的低权限账户，不用 SYSTEM 或域管理员。域成员 CA 推荐组托管服务账户（gMSA，例如 `EXAMPLE\svc-crl-upload$`；不存密码，账户需
  "作为批处理作业登录"权限，未核对）；最省事的是 `NT AUTHORITY\NETWORK SERVICE`（本机许多服务共用，令牌文件也就对它们可读）。
- 账户需要：读 SourceDir 与令牌文件，写数据目录（日志、账本的临时文件与改名），出站 HTTPS 到服务。CertSvc 以 LocalSystem 写 SourceDir（未核对）。
- 限权（管理员 PowerShell；`*S-1-5-32-544` = Administrators、`*S-1-5-18` = SYSTEM，用 SID 避开本地化组名）：

  ```powershell
  $dir = 'C:\ProgramData\PKI\crl-uploader'
  $account = 'NT AUTHORITY\NETWORK SERVICE'   # 或 gMSA，如 'EXAMPLE\svc-crl-upload$'
  icacls $dir /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' "${account}:(OI)(CI)M"
  icacls "$dir\upload-token.txt" /inheritance:r /grant:r '*S-1-5-32-544:(F)' "${account}:(R)"
  ```

  第一行去掉从 `C:\ProgramData` 继承的 Users 权限（普通用户可在其子目录建文件），给运行账户修改权；第二行令牌文件只有管理员与运行账户可读。
  两行的语法在 Windows 11（zh-CN）的临时目录上执行过（`NT AUTHORITY\NETWORK SERVICE` 能解析）；CA 上的效果未核对。

### 计划任务

- 触发器：
  1. 事件：日志 Application，来源 `Microsoft-Windows-CertificationAuthority`，事件 ID 68、69、70，延迟 1 分钟（让同一次发布的 full 与 delta
     都写完）。事件号来自旧部署；Microsoft 的 AD CS CRL 发布事件表只列失败事件（62、65–67、74、75、130），68–70 的含义与所在日志未核对。
  2. 定时补扫：每小时一次。补上 `IgnoreNew` 丢掉的触发、上次的失败与服务端 500（R2 单键写限速不重试，plan §5.5）；无变化时账本让它零上传。
- 设置：`MultipleInstances IgnoreNew`（同一时刻只跑一个实例，每个签发者只有一个发布者，账本也只有一个写者）、错过的计划尽快补跑、执行时限 30 分钟。
- 运行账户见上，"不管用户是否登录都要运行"。
- 动作：程序 `C:\Program Files\PowerShell\7\pwsh.exe`，参数
  `-NoProfile -NonInteractive -File "C:\Program Files\aia-cdp\adcs-crl-uploader.ps1" -UploadUri https://<host>/api/v1/crls -UploadTokenFile "C:\ProgramData\PKI\crl-uploader\upload-token.txt"`
  （SourceDir 不是默认值时另加 `-SourceDir …`）。任务定义对本机用户可读，所以令牌只放文件。"上次运行结果" 0 为成功，1 为有文件失败或
  无法开始，原因看 `upload.log`。
- 用 PowerShell 建任务（不提交任务 XML）：

  ```powershell
  $dir = 'C:\ProgramData\PKI\crl-uploader'
  $action = New-ScheduledTaskAction -Execute 'C:\Program Files\PowerShell\7\pwsh.exe' `
      -Argument ("-NoProfile -NonInteractive -File `"C:\Program Files\aia-cdp\adcs-crl-uploader.ps1`" " +
          "-UploadUri https://pki.example.com/api/v1/crls -UploadTokenFile `"$dir\upload-token.txt`"")
  $onEvent = New-CimInstance -ClientOnly -CimClass (
      Get-CimClass -Namespace Root/Microsoft/Windows/TaskScheduler -ClassName MSFT_TaskEventTrigger)
  $onEvent.Enabled = $true
  $onEvent.Delay = 'PT1M'
  $onEvent.Subscription = '<QueryList><Query Id="0" Path="Application"><Select Path="Application">' +
      "*[System[Provider[@Name='Microsoft-Windows-CertificationAuthority'] and (EventID=68 or EventID=69 or EventID=70)]]" +
      '</Select></Query></QueryList>'
  $hourly = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Hours 1)
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
      -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
  $principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\NETWORK SERVICE' -LogonType ServiceAccount
  # gMSA: New-ScheduledTaskPrincipal -UserId 'EXAMPLE\svc-crl-upload$' -LogonType Password
  Register-ScheduledTask -TaskPath '\PKI\' -TaskName 'aia-cdp CRL upload' -Action $action `
      -Trigger $onEvent, $hourly -Settings $settings -Principal $principal
  ```

  `Register-ScheduledTask` 之前的各对象在 Windows 11 的 PowerShell 7.6.6 上构造过（`New-ScheduledTask` 得到两个触发器、`IgnoreNew`、
  延迟 `PT1M`、重复 `PT1H`），没有注册；注册、事件实际触发、Windows Server 上不带 `-RepetitionDuration` 的无限重复都未核对。

### 手动 Windows 验证（2026-10-20）

环境：Windows 11（NT 10.0.26200，zh-CN）上的 PowerShell 7.6.6；服务是本分支的 Node 运行时（`node src/runtime/node.ts`，Node 24.22.0），
跑在同一台机器的 WSL2 里（mirrored 网络），fs 存储在临时目录，`AIA_ADMIN_TOKEN_FILE`、`AIA_UPLOAD_TOKEN_FILE` 已设，不是真实 CA。
`aia import certs/issuing-ca-1.der` 后 `aia config apply` 一份只有 issuing-ca-1 full + delta 两个目标的配置。夹具
`tests/fixtures/pki/crls/issuing-ca-1/` 的 CRL 按 AD CS 的命名复制进 SourceDir：full 为 `issuing-ca-1.crl`，delta 为 `issuing-ca-1+.crl`。

- 运行：脚本复制到全新的 `%TEMP%\aia-cdp-adcs-<随机>`（直接从 `\\wsl.localhost\…` 运行被 `RemoteSigned` 拦下），SourceDir、账本、日志、
  令牌文件都在该目录，令牌文件用上节的 `icacls` 限权（账户换成当前用户）；
  `pwsh.exe -NoProfile -NonInteractive -File <脚本> -UploadUri http://127.0.0.1:<端口>/api/v1/crls -AllowInsecureHttp -UploadTokenFile …
  -SourceDir … -LedgerPath … -LogPath …`。mirrored 网络下 Windows 只经 `127.0.0.1` 连得到 WSL 里监听 `::` 的服务：`localhost` 先解析成
  `::1`，IPv6 回环不镜像，请求超时；WSL 的局域网地址被防火墙挡住。
- "上传请求"是服务端 `request` 日志里 `POST /api/v1/crls` 的行数。第 6 条要求 full-01 仍是当前 full CRL，所以按 1、2、3、6、4、5、7 的顺序跑。
- 先跑一遍，改了脚本（账本写失败的分支）后在全新存储上用提交 `f56353a` 的脚本整套重跑，两遍结果相同；下表取第二遍。之后脚本只改了帮助里的示例路径。

| # | 操作 | 退出码 | 上传请求 | 日志摘录 |
| --- | --- | --- | --- | --- |
| 1 | full-01 + delta-01，无账本 | 0 | 2（201、201） | `[WARN] Ledger not found, starting empty`；`[SUCCESS] issuing-ca-1.crl: created (target …, full CRL Number 1, thisUpdate 2026-01-01T00:00:00Z)`；`issuing-ca-1+.crl: created (…, delta CRL Number 2, …)`；`Completed. Created: 2, Updated: 0, Unchanged: 0, Skipped: 0, Failed: 0`；账本 2 条 |
| 2 | 原样再跑 | 0 | 0 | `[INFO] Skipped: issuing-ca-1.crl (accepted before, sha256 …)` 两条；`Completed. … Skipped: 2, Failed: 0` |
| 3 | 删账本再跑 | 0 | 2（200、200） | `[WARN] Ledger not found, starting empty`；两条 `unchanged`；`Completed. … Unchanged: 2, Skipped: 0, Failed: 0`；账本重新为 2 条 |
| 6 | 另一个 SourceDir 只放 `full-01.pem`，另一个账本 | 0 | 1（200） | `Uploading: full-01.pem (application/x-pem-file, 751 bytes, …)`；`full-01.pem: unchanged (…, full CRL Number 1, …)`；`Unchanged: 1` |
| 4 | full-02 覆盖 `issuing-ca-1.crl` | 0 | 1（200） | `Skipped: issuing-ca-1+.crl`；`issuing-ca-1.crl: updated (…, full CRL Number 3, thisUpdate 2026-01-02T00:00:00Z)`；`Updated: 1, Unchanged: 0, Skipped: 1, Failed: 0` |
| 5 | 加入 full-01 的副本 `issuing-ca-1-copy.crl`（修改时间设为 2026-01-01，最先处理），同时 delta-02 覆盖 `issuing-ca-1+.crl` | 1 | 2（409、200） | `[ERROR] issuing-ca-1-copy.crl: HTTP 409 stale_crl: The CRL is older than the target's current CRL {"current":{"sha256":"7af2…","crlNumber":"3","thisUpdate":"2026-01-02T00:00:00Z"}} (the CA wrote a CRL older than the published one)`；随后 `Skipped: issuing-ca-1.crl`、`issuing-ca-1+.crl: updated (…, delta CRL Number 4, …)`；`Completed. Created: 0, Updated: 1, Unchanged: 0, Skipped: 1, Failed: 1` |
| 7a | 错令牌（另一个合法格式的令牌），新账本（目录里仍是第 5 条的三个文件） | 1 | 3（401 ×3） | 每个文件一条 `[ERROR] <文件>: HTTP 401 unauthorized: Unauthorized (the token in -UploadTokenFile is wrong)`；`Failed: 3` |
| 7b | `-UploadTokenFile` 指向不存在的文件 | 1 | 0 | `[ERROR] Token file not found: …\missing-token.txt` |
| 7c | `http://` 带令牌，不加 `-AllowInsecureHttp` | 1 | 0 | `[ERROR] Refusing to send the upload token over http://: use https:// (-AllowInsecureHttp is for tests)` |
| 7d | SourceDir 不存在 | 1 | 0 | `[ERROR] SourceDir not found: …\missing-dir` |

附加检查（不在出口条件里，覆盖保留与新增的其余行为）：

| 操作 | 退出码 | 上传请求 | 日志摘录 |
| --- | --- | --- | --- |
| 空 SourceDir | 0 | 0 | `[WARN] No CRL files found in …` |
| `issuing-ca-1.crl` 旁放 `issuing-ca-1.crl.pem`，另加文本文件 `notes.dcrl` | 1 | 1 | `Skipped: issuing-ca-1.crl.pem (issuing-ca-1.crl is uploaded instead)`；`[ERROR] notes.dcrl: neither DER nor PEM with an X509 CRL block, not uploaded` |
| 服务端设了令牌，助手不给 `-UploadTokenFile` | 1 | 1（401） | `HTTP 401 unauthorized: Unauthorized (the service requires a token: pass -UploadTokenFile)` |
| 空令牌文件 | 1 | 0 | `[ERROR] Token file is empty: …` |
| 账本内容为 `{ not json` | 0 | 2（200 ×2） | `[WARN] Ledger unreadable, starting empty: …`；`Unchanged: 2` |
| 另一进程以 `FileShare.None` 占住 `issuing-ca-1.crl` 3 秒 | 0 | 0 | `[WARN] Cannot read …\issuing-ca-1.crl yet (attempt 1 of 5): The process cannot access the file … because it is being used by another process.` 三条，之后 `Skipped: 2` |
| 账本路径不可写 | 1 | 1（200） | `[ERROR] issuing-ca-1.crl: unchanged on the service, but the ledger could not be written: …` |

两次实际上传之间的 1 s 间隔见各条时间戳（如第 1 条 `07:18:31.779` → `07:18:32.820`）。没有验证的：真实 AD CS（事件、文件名、写文件时序）、
Windows Server、服务账户与 gMSA、经 TLS 的 `https://`（验证用的是 `http://` + `-AllowInsecureHttp`）、R2 的单键写限速。
