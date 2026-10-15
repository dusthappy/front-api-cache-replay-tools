# 验收记录

日期：2026-10-14（Asia/Shanghai）

交付：API Cache Replay 0.6.0，接口缓存与回放。默认开启缓存并自动识别、直接采用 API 范围，无确认步骤；自动模式同标签页刷新复用缓存，避免 userInfo 和混合凭证请求误清缓存；接口状态旁提供一键强制缓存，并显示真实请求的具体原因。

## 0.7.5 悬浮按钮右侧定位

悬浮圆按钮使用 right 定位，默认 right 为 35px、top 为 55px，不设置 left。窗口宽度改变时保持右侧间距；继续兼容已有拖动位置、鼠标拖动、键盘移动与视口边界约束。

- 类型检查、生产构建通过。
- A02-A03 Chrome 回归通过（1 项，3.5 秒）：默认间距、无内联 left、窗口缩放、拖动与刷新恢复、桌面及窄窗口面板交互。
- 证据：[浏览器回归](verification/browser-tests-0.7.5.txt)。

## 0.7.4 默认悬浮位置

悬浮圆按钮的初始 top 与无已保存位置时的回退值统一为 55px，已拖动保存的位置保持优先，视口边界约束不变。类型检查与生产构建通过；此低影响默认值调整未新增或重跑浏览器测试。

## 0.7.3 清空后录制提示动态更新

清空后的响应成功写入后，行内与展开详情显示“已重新缓存”，悬停保留本次由清空触发真实请求的解释。请求中仍显示清空原因；失败或不支持的响应不显示成功；再次清空撤销成功提示，下一次命中只显示 HIT。此调整使用已有录制元数据，未改变后台缓存匹配与诊断记录。

- 类型检查、51 项核心测试及生产构建通过。
- E01 / F01 / G01 三项 Chrome 回归通过（13.4 秒），覆盖页面刷新后重新录制、清理过程、命中计数、HTTP 失败、非 JSON 响应和重复清理。
- 证据：[核心检查](verification/core-check-0.7.3.txt)、[浏览器回归](verification/browser-tests-0.7.3.txt)、[重新录制提示](verification/clear-recorded.png)。

## 0.7.2 移除手动添加绑定入口

移除悬浮面板“添加绑定”按钮、表单及专用状态与样式；保留自动发现和已有绑定。类型检查、生产构建及 A02-A03 真实 Chrome 面板交互/窄窗口回归通过。构建产物中已无“添加绑定”文案。证据：[面板回归](verification/browser-tests-0.7.2.txt)。

## 0.7.1 首次请求与命中时隐藏强制缓存按钮

首次请求（FIRST_REQUEST）和 HIT 状态隐藏强制缓存按钮，包括已开启态；其他状态沿用缓存资格判断。隐藏不改变强制缓存配置。已开启后命中隐藏，可手动重新请求后再通过按钮关闭模式。

- 类型检查、51 项核心测试及生产构建通过。
- D01 / E01 两项 Chrome 定向回归通过（9.0 秒）：首次请求隐藏、普通与强制模式 HIT 隐藏、参数变化时显示、手动重发后可关闭、刷新后隐藏规则仍有效。
- 证据：[核心检查](verification/core-check-0.7.1.txt)、[浏览器回归](verification/browser-tests-0.7.1.txt)。既有桌面/窄窗口按钮截图同步更新。

## 0.7.0 存储统计与全局清理

设置页顶部新增“存储与缓存”，区分精确的 UTF-8 缓存/预览正文大小与 Chrome 提供的扩展来源存储估算。单击清理所有网站的缓存、预览和请求记录，保留授权及配置；清理时作废在途票据，避免旧响应回写。

- `npm run check` 通过：类型检查、51 项核心测试及生产构建。
- 全量 Chrome 扩展回归 40/40 通过；新增 F01 / F02 覆盖精确正文统计、真实预览、非设置页访问拒绝、一键清理、在途响应隔离、配置与业务 Cookie/localStorage 保留、未保存表单保留、清理后重新录制命中、后台重启、估算不可用、读取/清理失败及恢复。
- 核心测试覆盖跨网站、跨页面全量清理，保留规则、失效旧在途写入，并验证下一次请求的 CLEARED 原因。
- 检查了 1280px 桌面、390px 窄窗口和清空后的真实 Chrome 截图；窄窗口无横向溢出，空态清理按钮禁用。机械界面检测无发现，独立界面审查结论 ship。
- 浏览器存储估算允许延迟或不可用；配置、索引等保留，清理后不承诺物理占用归零。未改变扩展权限。
- 证据：[核心检查](verification/core-check-0.7.0.txt)、[全量回归](verification/browser-tests-0.7.0.txt)、[桌面](verification/storage-desktop.png)、[窄窗口](verification/storage-narrow.png)、[空态](verification/storage-empty.png)。

## 0.6.2 恢复 MISS 行按钮

根据用户更正，撤销 0.6.1 的隐藏规则：MISS 状态显示强制缓存按钮，允许直接开启；开启态保留以便关闭。

- `npm run check` 通过：类型检查、49 项核心测试及生产构建。
- D01 / E01 定向浏览器回归 2/2 通过（9.4 秒）：从 MISS 行直接开启、强制模式首次录制和手动重发后按钮仍可见、HIT 回放及关闭模式均正常。
- 已查看桌面及 390px 截图，MISS 原因与按钮可读，窄屏正常换行。
- 输出：[核心检查](verification/core-check-0.6.2.txt)、[浏览器回归](verification/browser-tests-0.6.2.txt)。相关截图、现有解压加载目录及安装包已更新为 0.6.2。下方为历史版本记录。

## 0.6.1 按钮显示补丁

按用户要求，接口最新状态为 `MISS · 真实请求` 时隐藏强制缓存按钮，包括已开启态；其他状态沿用原有显示规则。

- `npm run check` 通过：类型检查、49 项核心测试及生产构建。
- `npm run test:e2e -- --grep 'D01|E01'`：2/2 通过（9.2 秒）。覆盖普通和强制模式下 MISS 隐藏、HIT 显示、手动重发后的隐藏与恢复；增加的 HIT 调用不增加后端请求数。
- 已检查更新后的桌面与 390px 截图，MISS 行仅显示状态和原因，按钮无残留；HIT/BYPASS 按原有规则显示。
- 输出：[核心检查](verification/core-check-0.6.1.txt)、[定向浏览器回归](verification/browser-tests-0.6.1.txt)。`dist/`、已有解压加载目录与 0.6.1 安装包均已同步；下方保留 0.6.0 的全量回归记录，相关 D01/E01 截图更新到 0.6.1。

## 0.4.1 默认地址补丁

新增网站表单与重置入口默认填入 `http://localhost:3000/`，已有网站仍显示保存的地址。`npm run typecheck` 与生产构建通过，安装包与已有加载目录同步到 0.4.1。该补丁现已包含在 0.6.0 交付中，下方结果为 0.6.0 全量回归。

## 执行环境与结果

- macOS arm64，Node.js 24.20.0，npm 12.0.2。
- Google Chrome for Testing **151.0.7922.34**，Playwright **1.64.0**，Axios **1.20.0**。
- `npm run typecheck`：通过。
- `npm test`：**49/49 通过**。
- `npm run build`：通过，构建目录为项目根目录下 `dist/`。
- `npm run test:e2e`：最终 **38/38 通过（30.3 秒）**，包含真实请求原因、缓存命中清除旧原因、强制缓存真实按钮操作、动态参数与手动重发、页面加载与刷新、Cookie/Token 身份变化、混合凭证、旧数据升级和自动 API 范围识别流程。全部请求通过实际安装的 MV3 扩展与真实本地 HTTP 后端，命中用后端调用计数验证。
- 已查看真实请求原因的桌面与 390px 窄窗口截图：原因紧邻状态，强制缓存按钮可见；长内容与时间自然换行，面板无横向溢出。强制缓存等既有截图也随本轮回归更新。

测试中的扩展副本预先授予 `http://127.0.0.1/*`，以避开自动化环境的 Chrome 原生授权弹框；交付 manifest 只有 `optional_host_permissions`。测试没有改动日常 Chrome 配置。

## 与原始 20 组验收场景的对应

“通过”指本表明确列出的自动化覆盖项。原文较大的场景组并不表示已穷举所有浏览器事件、异常组合和人工操作，剩余人工项列于表后。

| 场景 | 结果 | 已执行的验证 |
| --- | --- | --- |
| A00 零配置默认 | 通过 | 设置页只填网站地址并保存；非 /api 前缀、跨源 GET、POST、XHR、no-store 首次录制第二次命中；SPA 新页直接开启，无手动绑定与接口开关 |
| A01 网站与权限 | 核心通过；原生授权弹框未测 | 仅配置 4173，4175 没有按钮；交付 manifest 无默认 host_permissions；实际设置表单保存、暂停/恢复；后台拒绝未授权来源、跨端口和伪造票据 |
| A02 悬浮入口 | 通过 | 拖动不打开面板、位置重载恢复、点击展开、Escape 关闭、390px 视口按钮仍可见 |
| A03 默认折叠 | 通过 | 初始详情收起；操作接口开关不展开；打开详情后响应预览仍收起 |
| A04 页面绑定 | 通过 | 请求发出后 SPA 换页，响应仍归原页；历史绑定重载存在；精确路径、Hash 路由、页面区分参数 |
| A05 录制与命中 | 核心通过；可见 DevTools 窗口未测 | 首次真实请求加 1；后续相同请求及 Response clone/json/text 读取均不增加后端计数 |
| A06 参数匹配 | 通过 | JSON 对象键顺序归一、类型和数组顺序分离、重复 Query 顺序保持；缺失与 null 区分；Cookie credentials 模式分组 |
| A07 忽略参数 | 通过 | page/pageSize 变化命中同份正文；手动重发保留最近 page=3；规则改变使旧缓存失效；JSON Pointer 精确字段及数组边界单测 |
| A08 POST/写操作 | 通过 | POST 默认录制；明确关闭 POST 缓存、PUT/PATCH/DELETE、鉴权与始终直通每次访问后端；写成功后指定查询失效单测 |
| A09 三种时间 | 通过 | HIT 不改变真实请求/缓存时间；手动重发不改变页面调用时间；失败保留原成功缓存时间 |
| A10 重新请求 | 通过 | 当前运行时原始参数重发；指定参数组更新不覆盖其他组；鉴权接口禁用快捷重发 |
| A11 关闭时重发 | 通过 | 接口关闭后仍可安全重发，但 saved=false；旧缓存时间不变；关闭再开启保留原有效成功缓存单测 |
| A12 重发并刷新 | 通过 | public 模式实际点击“请求并刷新页面”，加载后立即读取新缓存，计数停留在 2；auto 无凭证模式同标签页完整刷新复用，页面加载自动请求也命中 |
| A13 失败与业务错误 | 通过 | HTTP 500、业务 code 错误、超大正文不录制；no-store 默认可录制，显式禁止时直通；401 失效及旧缓存保留规则单测；取消与超时浏览器测试 |
| A14 身份与环境 | 通过 | auto 无凭证请求同标签页刷新复用，新标签页隔离；Authorization 相同凭证跨刷新命中，变更则重新录制；Token、租户、环境隔离；旧未配置模式与显式会话模式；FormData 登录直通并失效旧缓存 |
| A15 凭证 | 通过 | 枚举实际扩展 IndexedDB 与 storage.local，不含测试 Authorization 明文；表单密码不进入模板/预览；跨域 omit/include 保持浏览器 Cookie 语义 |
| A16 在途响应 | 通过 | 延迟请求期间清空、关闭再开启都阻止回写；两个同键乱序请求保留后发成功结果；淘汰后旧响应仍不能覆盖序号水位单测 |
| A17 兼容性 | 通过已列路径 | fetch Request/init 覆盖、Response clone/json/text、请求中及回放后的 abort；XHR json/事件/响应头/timeout；真实 Axios XHR 适配器 |
| A18 故障恢复 | 通过 | 抑制 PREPARE 模拟查询超时，后端只调用一次；注入 IndexedDB 写入异常，页面响应仍成功；通过 CDP 停止后台，唤醒后继续命中 |
| A19 持久化/TTL/容量 | 通过；容量以核心测试验证 | 真实关闭并重启 Chrome 后规则与缓存恢复，运行时模板为空；TTL 到期重取、1 MiB 超限不录制、按页面清空隔离；100 MiB LRU 与事务回滚单测 |
| A20 边界 | 通过已列路径 | 带 Body 的 Request、二进制 XHR、Worker、iframe 原生请求正常执行；Worker/iframe 连续请求后端计数增加 2；不同状态与旁路原因呈现 |
| A20b 旧版本升级 | 通过 | Chrome IndexedDB schema1→2 一次性迁移；旧正文及无索引孤儿正文全清；站点/页面/接口与 POST/no-store 自动开启；保留始终直通；迁移后再次关闭不会被重置 |
| B01 自动范围检索 | 通过 | 成功 JSON 自动聚合精确 API origin 与首层路径；GET/POST 计数、去 Query/Hash 路径示例；跨域首录与命中；HTML/500/无效 JSON/鉴权不列入；后台重启恢复范围；界面真实轮询不覆盖未保存输入；查看列表、示例不增加后端请求数；无确认按钮 |
| B02 自定义范围边界 | 通过 | 自定义范围仍限制来源、端口和路径，自动发现不扩大手工限制；核心补网站访问隔离、文档权限、范围 metadata 上限、双斜杠路径及 0.2.0 状态兼容 |
| C01 页面加载与完整刷新 | 通过 | 真实 HTML 加载脚本并发 POST `/api/login/userInfo` 与 `/api/simple-list`；用户信息先完成、列表先完成、并行三种时序，首次各 +1 后连续刷新两次不再增加；真 login/logout 每次直通并使两条查询重新录制；浮窗和设置版本显示 v0.6.0 |
| C02 自动 Cookie 会话 | 通过 | 可见登录 Cookie A→B 不复用旧正文；同标签页刷新与后台重启命中；Chrome 重启后浏览器会话标识变化并重新录制；omit 不受 Cookie 变化影响，include/omit 交替分别命中 |
| C03 常见凭证头 | 通过 | token、x-auth-token、api-key 摘要识别身份；同凭证刷新/后台重启命中；组合凭证变化重新录制；有/无 Authorization 交替不清彼此缓存；实际 IDB/local/session 存储无测试凭证明文 |
| D01 强制缓存 | 通过 | 真实点击折叠行按钮保持折叠；开启后动态 Query/JSON Body 复用同一响应，刷新保持；真实点击重发使用最新完整原参数更新响应；关闭保留字段忽略规则、恢复普通参数匹配；核心补身份/页面/端点隔离、TTL/开关、在途切换与无效请求/响应 |
| E01 真实请求原因 | 通过 | 真实后端计数与浮窗文案同步验证首次、Query/Body 变化、相同参数过期、手动重发、清空、规则与强制模式切换；HIT 删除旧原因，展开显示所选参数组原因；核心补请求头/凭证/身份/会话、在途录制、未录制、容量淘汰、旧数据兼容和乱序响应 |
| E02 开关原因优先级 | 通过 | 参数同时变化时，关闭接口、本页、网站分别显示“缓存开关已关闭”，详情准确说明对应层级；核心补不支持请求优先显示直通原因 |

## 计数证据示例

- `/api/reason-hit`：首次真实请求后再次命中，后端增量 **1**；`/api/reason-query` 与 `/api/reason-body` 参数变化后各增 **2**，分别显示 Query 与 Body 变化；`/api/reason-expiry` 相同参数等待真实有效期结束后增 **2**，显示缓存过期。
- `/api/login/userInfo` 与 `/api/simple-list`：真实页面首次加载及连续两次完整刷新，在三种请求完成时序下每组接口后端增量均为 **1**。
- POST `/api/force-cache-query`：普通模式两个不同参数组增 **2**；开启强制后首次录制增 **1**，再改变两次参数和刷新均不增加；手动重发增 **1**，后续回放新正文；关闭后忽略字段变化继续命中，其他参数变化恢复真实请求。
- `/api/basic?a=1`：首次与第二次正文相同，后端增量 **1**；随后 clone/json/text 再次读取仍命中。
- 零配置 `/backend/default-get`、跨源 `/services/default-cors`、POST `/backend/default-post`、XHR `/backend/default-xhr`、no-store `/backend/default-no-store`：每组调用两次，后端分别只增 **1**。
- `/api/pagination`：page=2 首次、page=3 命中、手动重发 page=3，共 **2** 次；修改忽略规则后再调用变为 **3** 次。
- `/api/variants`：两个参数组首次共 **2** 次；重发一组后 **3** 次，另一组正文不变。
- `/api/order`：两个并发首次调用共 **2** 次；慢响应不能覆盖较晚发起且先成功的正文。
- `/api/cors`：credentials=omit/include 首次各 **1** 次，后续两组分别命中，总数 **2**。
- public 模式 `/api/restart`：关闭并重新启动浏览器后相同请求总数仍为 **1**；auto 无凭证模式重启浏览器后重新录制。

## 未执行项与限制

- Chrome 原生首次授权/撤权弹框的人工点击流程；程序权限检查、运行时拒绝与注册逻辑已覆盖。首次实际安装需按 README 授权后刷新页面。
- 可见 DevTools 窗口同时打开时的人工操作；自动化一直连接 CDP，扩展不使用 debugger API。
- 最低版本 Chrome 120 的独立运行；本次实际验证版本为 Chrome for Testing 151。
- 未在真实业务应用穷举所有 Axios 配置、XHR 反射细节、上传进度、同步 XHR、SSE、WebSocket、自主 Service Worker 或低磁盘配额。超出支持范围保持原生路线；不把这些模式列为缓存功能。
- 100 MiB 淘汰使用等价大小元数据的核心测试，未在浏览器真实写满 100 MiB。浏览器真实写失败降级已测试。
- auto 无法读取 HttpOnly Cookie、其他域 Cookie 或保证识别所有自定义 Cookie 名称。无凭证模式按浏览器会话与标签页隔离；未被观察到的身份变化需清空站点缓存或关闭后重开标签页，单纯刷新继续复用。高级显式 Cookie 分区仍需在切换账号时重置。普通业务 JSON 正文原样保存，相关敏感接口可设置直通。

0.1.0 已修复的兼容性问题继续回归：Chrome 设置标签页附带 tab 被误拒绝、合成 Response 取消时 Chrome 将错误改为 TypeError、Cookie credentials 模式未分组、LRU 淘汰后旧响应回写、登录完成时的并发失效以及 FormData 登录观察遗漏。

## 文件与复现

- [核心测试、类型检查与构建输出](verification/core-check.txt)
- [浏览器测试输出](verification/browser-tests.txt)
- [真实请求原因桌面](verification/network-reasons-desktop.png)
- [真实请求原因窄窗口](verification/network-reasons-narrow.png)
- [强制缓存按钮桌面](verification/force-cache-desktop.png)
- [强制缓存按钮窄窗口](verification/force-cache-narrow.png)
- [页面刷新后命中面板](verification/reload-panel.png)
- [桌面悬浮面板](verification/panel-desktop.png)
- [窄窗口展开详情](verification/panel-narrow.png)
- [零配置网站设置](verification/options-defaults-desktop.png)
- [零配置窄窗口设置](verification/options-defaults-narrow.png)
- [高级设置](verification/options-defaults-advanced.png)
- [默认接口命中面板](verification/panel-defaults.png)
- [自动范围设置页](verification/scopes-desktop.png)
- [自动范围窄窗口](verification/scopes-narrow.png)
- [自动范围悬浮面板](verification/scopes-panel.png)
- [测试实现](../tests/e2e/extension.spec.ts)
- [核心测试](../tests/core.test.ts)
- [安装与开发说明](../README.md)

从项目根目录运行 `npm ci && npm run check && npm run test:e2e`。若未找到测试浏览器，设置 `CHROME_PATH` 指向 Chrome for Testing 可执行文件，或先运行 `npx playwright install chromium`。
