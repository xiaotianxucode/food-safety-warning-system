# 食品安全预警系统

食品伙伴网新闻监测、模型辅助分析与预警展示平台。用户前台展示具体食品风险；开发者后台管理新闻、来源、模型提示词、运行任务和账号。覆盖通用食品安全，重点标记调味品。

## Windows 启动

需要 **Node.js 24 或以上版本**，当前项目使用 Node 内置 SQLite，安装时不需要额外数据库或 Python。

```powershell
npm.cmd ci
Copy-Item .env.example .env
# 编辑 .env，填写 MODEL_API_KEY。不要覆盖已有 .env。
npm.cmd run init-admin
npm.cmd run build
npm.cmd start
```

打开 <http://127.0.0.1:3000>。创建的开发者账号可以访问全部后台；在“账号管理”创建普通用户。前台没有公开注册入口。初始化密码至少 10 位，不提供通用默认密码。当前本机如已完成初始化，访问凭据保存在被 Git 忽略的 `CREDENTIALS.local.txt`，请登录后自行修改密码。

后续可双击 `start.cmd`，或者执行 `powershell -ExecutionPolicy Bypass -File .\start.ps1`。脚本检查依赖并构建、启动系统。**定时采集需要进程持续运行**；电脑休眠或关机期间不执行任务，恢复启动后会检查是否到期。首次启动会自动发起采集，运行进度在开发者后台查看。浏览器页面只读取已保存结果，不直接触发模型。

开发时两个终端分别运行 `npm run dev` 和 `npm run dev:web`，访问 <http://127.0.0.1:5173>。

## 模型与配置

`.env.example` 提供阿里云兼容接口与模型名称。密钥只配置在服务端 `.env`，不会写入前端、日志或 Git。可更换 `MODEL_BASE_URL`、`MODEL_NAME`、`MODEL_API_KEY`。后台“采集与模型”支持测试已保存配置、修改采集间隔、回溯天数、单次上限、来源栏目和提示词。提示词版本化保存，每次分析关联实际使用的版本。

默认每 12 小时采集，回溯最近 7 天，单次最多抓取 200 篇；每个栏目最多扫描 10 页。来源仅允许食品伙伴网域名，重定向同样检查。请求设置超时、大小上限、间隔及最多 3 次重试。首次任务可能持续较长时间；模型调用按顺序执行。模型正文过长或返回不合规结构时不会发布，后台记录失败原因。

预警对象、原产地、企业及批次均不得凭空推断。模型必须给出包含食品名称的连续原文证据。地区、企业和批次若不为空，须能逐字匹配正文；校验失败保留错误并允许重试。新闻只是材料，不能改变分析指令。一次新闻可发布多个食品对象，也可以判定无需预警。

采集状态包括待分析、分析中、已发布、无需预警、已筛除、重复报道、采集失败、分析失败。失败重试不会将已发布的同一新闻再次发布。内容指纹合并重复报道，多个原始链接留在后台供开发者核查。新闻修改和撤稿不自动监测；开发者可撤下不应展示的预警。运行日志区分失败和“没有新增”，不会使用演示新闻填充正式数据库。

## 展示与提醒

前台每 30 秒通过发布序号查询增量，超过一页的新消息分批补取。卡片每 8 秒滚动展示，支持暂停和手动翻页，鼠标悬停、键盘聚焦、查看详情及页面隐藏时暂停，尊重系统减少动画设置。可加载更早记录；搜索和调味品、未读筛选作用于已载入内容。

新增提醒与阅读状态独立持久化。服务器以事务争取提醒，同一用户多个标签页仅有一个获得同一批提醒；离线消息会在下次进入页面时合并提示。提醒被关闭不等于已读，查看预警详情后才标记已读。网络中断时保留最近列表，并在恢复后补取；撤下的预警在下次轮询时移除。

## 架构与数据

- `server/`：Express API、SQLite 迁移、账号与会话、采集器、持久化任务锁、模型分析、定时调度。
- `src/`：React 前台与开发者后台，适配桌面和移动端。
- `tests/`：业务与权限测试、隔离数据库的浏览器端验收。

数据库默认位于 `data/food-safety.sqlite`。首次打开自动执行幂等建表迁移，`migrations` 保存版本。包含用户、会话、新闻、来源、任务、分析结果、提示词、预警、已读、提醒游标、配置和任务锁。进程间使用数据库租约互斥，30 秒续约，租约过期后恢复中断状态；仍推荐单服务实例。会话令牌以哈希入库，密码使用带随机盐的 scrypt；停用账号、重置或修改密码使会话失效。

主要接口：

| 接口                                                        | 用途                       |
| ----------------------------------------------------------- | -------------------------- |
| `POST /api/login`、`POST /api/logout`、`GET /api/me`        | 登录、退出、会话           |
| `POST /api/password`                                        | 修改密码并注销会话         |
| `GET /api/alerts?after=序号`                                | 增量预警、未读数、更新时间 |
| `GET /api/alerts?before=序号`                               | 加载更早预警               |
| `GET /api/alerts/:id`、`POST /api/alerts/:id/read`          | 详情与已读                 |
| `POST /api/notifications/claim`                             | 原子领取合并提醒           |
| `/api/admin/overview`、`/news`、`/alerts`                   | 新闻、来源、分析与任务记录 |
| `POST /api/admin/collect`、`POST /api/admin/news/:id/retry` | 采集与失败重试             |
| `GET/PUT /api/admin/config`、`POST /api/admin/model/test`   | 采集与模型配置             |
| `GET/POST /api/admin/users`、`PATCH /api/admin/users/:id`   | 创建、停用账号和重置密码   |
| `POST /api/admin/alerts/:id/withdraw`                       | 撤下预警                   |

所有 `/api/admin` 接口强制开发者权限，来源链接和原始处理日志只通过后台接口返回。

## 验证

```powershell
npm.cmd run build
npm.cmd test
npx.cmd playwright install chromium
npm.cmd run test:e2e
# 真实联网联调，会调用配置的模型 API；不写入正式数据库
npx.cmd tsx server/live-check.ts
```

业务测试覆盖同正文跨链接去重、一篇多对象、无风险新闻、证据校验、模型失败重试、任务锁与恢复、越权、离线未读、多标签页提醒、撤下和提示词版本。浏览器测试使用独立内存数据库和明确标记的测试样例。GitHub Actions 执行构建、业务及浏览器测试。

## 服务器部署

安装 Docker，按 `.env.example` 建立服务器 `.env` 并配置密钥：

```sh
docker compose build
docker compose run --rm food-safety npm run init-admin
docker compose up -d
```

数据库位于 `food-data` 命名卷，不随容器重建丢失。服务默认仅映射服务器 `127.0.0.1:3000`。对外使用 Nginx/Caddy 反向代理并配置 HTTPS；HTTPS 环境将 `COOKIE_SECURE=true`，直连本机 HTTP 时保持 false。代理需保留浏览器 Host 与 Origin，避免跨来源修改请求被拒绝。仅运行一份服务实例，不执行 `docker compose down -v`，以免删除数据库卷。

备份时先停止服务，再复制完整 `data` 目录或 Docker 数据卷，保留 SQLite 主文件及可能存在的 WAL/SHM 文件；恢复后启动服务检查后台记录。依赖锁定在 `package-lock.json`，升级前先备份数据并运行验证。

## GitHub 私有共享仓库

本地 Git 使用 `main` 分支。`.gitignore` 排除 `.env`、含密钥的原始需求文档、数据库、采集数据、凭据与测试产物。不要使用 `git add -f` 提交这些文件。

在 Git 凭据管理器已登录 GitHub 时，运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\publish-github.ps1
```

脚本使用现有登录创建 `food-safety-warning-system` **私有仓库** 并正常推送，不强制覆盖历史。没有有效登录或权限时停止；也可使用 GitHub CLI 执行 `gh auth login`，再执行 `gh repo create food-safety-warning-system --private --source=. --remote=origin --push`。随后在 GitHub 仓库 Settings → Collaborators 邀请指定协作者。
