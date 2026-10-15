# 源码下载与二次开发

本源码包是 API Cache Replay v0.7.5 的完整开发快照，供公司内部学习、改造与优化。它包含源代码、固定版本的依赖锁文件、构建脚本、核心及浏览器测试、验收页面、需求和设计文档。安装即用的插件包为 `api-cache-replay-0.7.5.zip`；本源码包为 `api-cache-replay-source-0.7.5.zip`。

## 从源码运行

1. 解压源码包，进入 `api-cache-replay` 目录。
2. 使用 Node.js 22.12 及以上；原开发验证环境为 Node.js 24.20.0。
3. 在该目录执行以下命令（首次安装依赖需要访问 npm）：

```sh
npm ci
npm run check
```

`check` 依次完成类型检查、核心测试和生产构建。构建生成 `dist/manifest.json` 及扩展文件；manifest 由 `scripts/build.mjs` 生成，因此源码包根目录没有 manifest 属于正常情况。

编译完成后，将 `dist` 中的全部文件复制到 `releases` 下新建的 `api-cache-replay-0.*.*` 文件夹。该目录第一层应直接包含 `manifest.json`，不要再嵌套一层 `dist`。构建命令只输出 `dist`，不会自动更新 `releases`。

打开 Chrome 的 `chrome://extensions`，更新时先移除旧扩展，开启开发者模式，选择“加载已解压的扩展程序”（或“加载未打包的扩展程序”），加载 `releases` 中刚准备好的新文件夹。随后重新添加前端网站并授权，再刷新业务页面。

## 修改与调试

```sh
npm run dev
```

该命令监听 `src/` 并重新构建到 `dist`。如果 Chrome 加载的是 `releases` 中的文件夹，先将新的 `dist` 产物复制过去；若开发调试直接加载 `dist`，则无需复制。修改完成后，需要在 Chrome 扩展管理页点击“重新加载”，再刷新业务页面。修改构建脚本或其他未监听文件后，重新运行构建命令。领取新版发行安装包时，先在 Chrome 扩展管理页移除旧扩展，再加载新的解压文件夹，并重新添加网站与授权。这里的开发重载仅用于当前源码目录的本地调试。

## 自动与手动验收

```sh
npx playwright install chromium
npm run test:e2e
```

浏览器测试加载实际构建产物，运行前应先执行 `npm run check`。也可通过环境变量 `CHROME_PATH` 指定兼容的 Chrome for Testing 可执行文件。自动化使用隔离的临时浏览器配置，不使用日常 Chrome 个人配置。

自动回归会自行启动本地验收服务，需保证 4173、4174、4175 端口可用。手动验收可单独运行 `npm run fixture`，打开 `http://127.0.0.1:4173/users`；运行自动回归前先停止手动 fixture 服务。生产插件运行不依赖这些服务。

## 代码阅读与改造入口

| 目录 / 文件 | 职责与适合的改造 |
| --- | --- |
| `src/content/main.ts`、`fetch-interceptor.ts`、`xhr-interceptor.ts` | 页面请求包装、真实请求与合成响应 |
| `src/content/index.ts`、`bridge.ts` | 隔离环境消息桥、悬浮面板挂载 |
| `src/background/core.ts` | 缓存资格、匹配、录制、开关与强制缓存语义 |
| `src/background/cache-store.ts` | IndexedDB 存储、容量与淘汰 |
| `src/background/network-reason.ts`、`scope-discovery.ts` | 未命中原因、API 范围自动发现 |
| `src/shared/` | 类型、参数规范化、缓存键相关逻辑 |
| `src/ui/`、`src/options/` | 悬浮面板、网站与规则设置 |
| `scripts/build.mjs` | 构建与 Chrome Manifest V3 配置 |
| `tests/` | 核心测试、真实扩展回归和模拟后端 |
| `PRODUCT.md`、`DESIGN.md`、`docs/ACCEPTANCE_RESULTS.md` | 当前需求、设计取舍和已有验证范围 |

修改缓存键、身份隔离、清空逻辑或请求时序时，补充相应核心测试与浏览器回归，并通过本地模拟后端计数确认真实请求是否发生。修改面板时检查折叠、展开和窄屏状态。版本号来源为 `package.json`，构建时注入界面和 manifest。

`docs/brief/` 保留原始交接资料，部分历史要求已被后续需求覆盖；当前行为以 README、PRODUCT、DESIGN 和实际代码为准。

## 打包范围

本源码快照不包含 `node_modules`、生成的 `dist`、历史发行包、浏览器个人配置、运行时业务缓存、飞书发布记录或测试临时产物。依赖使用 `npm ci` 恢复，扩展使用构建命令生成。ZIP 是一次性的版本快照，不提供后续改动的自动同步。
