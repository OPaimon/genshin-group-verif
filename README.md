# genshin-group-verif

一个基于 [mtcute](https://github.com/mtcute/mtcute) 的 Telegram 入群验证机器人。新成员加入群组或通过入群申请进入时，必须先回答一道题目，验证通过后才被放行。

## 功能概览

- 入群直接加入 / 入群申请两种验证流程
- 管理员添加或批准成员时自动跳过验证
- 验证状态后端支持 `memory` 与 `sqlite`
- 可选 Sentry 错误监控与日志转发
- `/ping` 健康检查、`/reload` 热重载题库
- ReScript 核心状态机 + TypeScript 效果解释器

## 文档

- [docs/design.md](docs/design.md) — 设计意图与行为约定
- [docs/deploy-non-docker.md](docs/deploy-non-docker.md) — 非 Docker 手动部署详细说明
- [docs/analysis/README.md](docs/analysis/README.md) — 架构分析索引（如已合入）

## 环境要求

| 组件 | 要求 |
| --- | --- |
| Node.js | `>= 22.13`（代码使用 Node 内置 `node:sqlite`） |
| pnpm | 与 lockfile 匹配，当前为 `pnpm@10.17.1` |
| 网络 | 能访问 Telegram API（出方向 443） |
| 磁盘 | `bot-data/` 需要持久化：题库、SQLite state、mtcute session |

## 快速开始（开发模式）

```bash
# 1. 获取代码
git clone git@github.com:OPaimon/genshin-group-verif.git
cd genshin-group-verif
corepack enable
pnpm --version   # 期望 10.17.1

# 2. 安装依赖
pnpm install --frozen-lockfile

# 3. 准备题库（构建/运行前必须存在）
# 参考下方「题库 quizzes.json」
# 创建 bot-data/quizzes.json

# 4. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 API_ID / API_HASH / BOT_TOKEN / LOG_PEER

# 5. 开发运行（tsx 直接运行源码）
pnpm start
```

> `pnpm start` 是开发/快速启动方式，直接通过 `tsx` 运行源码，**不是生产部署方式**。
> 生产环境请使用 `pnpm build` + `dist/main.mjs`，见下方「手动部署」。

## 配置

复制 `.env.example` 为 `.env` 后填写。

必填项：

- `API_ID` — Telegram API ID
- `API_HASH` — Telegram API Hash
- `BOT_TOKEN` — Telegram Bot Token
- `LOG_PEER` — 接收验证日志的聊天/频道数字 peer id

常用可选项：

- `ADMIN_IDS` — 允许执行 `/reload` 的用户 id，逗号分隔；留空表示禁用
- `AD_LIST_URL` — 验证消息底部附加的加群广告链接；留空用默认值，设为空字符串禁用
- `STATE_BACKEND` — `memory`（默认）或 `sqlite`
- `STATE_SQLITE_PATH` — `STATE_BACKEND=sqlite` 时的数据库路径，默认 `bot-data/state.db`
- `SENTRY_DSN` — 留空则完全禁用 Sentry
- `SENTRY_ENVIRONMENT` — Sentry 环境标签，默认 `production`（生产构建）/ `development`（本地）
- `SENTRY_LOG_LEVEL` — 转发到 Sentry Logs 的最低级别：`debug | info | warn | error`

> Redis 状态后端已从主包移除并归档到 `archive/state-redis/`。当前 `STATE_BACKEND`
> 只接受 `memory` 和 `sqlite`，不再支持 `REDIS_URL`。

## 题库 quizzes.json

`bot-data/quizzes.json` **不会被 git 跟踪**，属于需要手动提供的数据文件。

- 构建脚本 `build.mjs` 会读取并复制该文件到 `dist/bot-data/`
- 运行时 `src/interpreter/quizSource.ts` 读取 `process.cwd()/bot-data/quizzes.json`
- 如果该文件缺失，`pnpm build` 会直接失败；即使构建成功，运行时也会因题库为空而拒绝新的验证请求

因此部署前必须手动创建 `bot-data/quizzes.json`。最小合法格式如下：

```json
[
    {
        "Id": 1,
        "Question": "示例问题？",
        "Options": ["选项A", "选项B"],
        "CorrectOptionIndex": 0
    }
]
```

字段说明：

- `Id` — 题目数字 id
- `Question` — 题目文本
- `Options` — 选项数组
- `CorrectOptionIndex` — 正确选项在 `Options` 中的下标，从 0 开始

## 手动部署（非 Docker）

以下步骤适用于直接在 Linux 主机 / VM 上部署，不使用 Docker。

### 1. 获取代码

```bash
git clone git@github.com:OPaimon/genshin-group-verif.git
cd genshin-group-verif
corepack enable
pnpm --version   # 期望 10.17.1
```

### 2. 准备题库

```bash
mkdir -p bot-data
# 将生产题库放到 bot-data/quizzes.json
# 或先按上面的示例创建最小文件
```

### 3. 安装依赖

```bash
pnpm install --frozen-lockfile
```

如果只打算在服务器上运行构建产物，而不在服务器上重新构建，可以只装 production 依赖：

```bash
pnpm install --prod --frozen-lockfile
```

> 注意：即使运行的是 `dist/main.mjs`，`node_modules` 里仍需要 `better-sqlite3`
> 和 `@mtcute/wasm`，因为 esbuild 将 native addon 和 wasm 作为运行时外部资源处理。
> `better-sqlite3` 已作为直接依赖保留，因此 `pnpm install --prod` 会把它安装到
> 顶层 `node_modules/better-sqlite3`，`dist/main.mjs` 才能正确解析到它。
> 如果遇到模块解析问题，最稳妥的方式是直接执行完整的 `pnpm install --frozen-lockfile`。

### 4. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env
```

生产环境建议启用 SQLite 持久化：

```bash
STATE_BACKEND=sqlite
STATE_SQLITE_PATH=bot-data/state.db
```

### 5. 构建

```bash
pnpm build
```

构建输出：

```text
dist/main.mjs
dist/main.mjs.map
dist/bot-data/quizzes.json
dist/metafile.json
```

### 6. 运行

前台运行（快速验证）：

```bash
node --env-file=.env --enable-source-maps dist/main.mjs
```

> `pnpm start:prod` 不会自动读取 `.env`，所以上面使用 Node 的 `--env-file` 显式加载。

推荐使用 systemd 常驻运行。创建 `/etc/systemd/system/genshin-group-verif.service`：

```ini
[Unit]
Description=genshin-group-verif Telegram bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=genshin-bot
Group=genshin-bot
WorkingDirectory=/opt/genshin-group-verif
EnvironmentFile=/opt/genshin-group-verif/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node --enable-source-maps dist/main.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

启用并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now genshin-group-verif
sudo systemctl status genshin-group-verif
journalctl -u genshin-group-verif -f
```

### 7. 目录布局建议

```text
/opt/genshin-group-verif/
├── .env
├── bot-data/
│   ├── quizzes.json
│   ├── state.db              # STATE_BACKEND=sqlite 时生成
│   └── session/              # mtcute 登录会话
├── dist/
│   ├── main.mjs
│   └── main.mjs.map
└── node_modules/
```

运行用户需要对 `bot-data/` 有读写权限。备份时优先备份：

- `bot-data/quizzes.json`
- `bot-data/state.db`
- `bot-data/session/`

### 8. 状态后端选择

| 后端 | 是否跨重启保留验证会话 | 说明 |
| --- | --- | --- |
| `memory`（默认） | 否 | 适合本地/临时测试；重启后 pending session 丢失 |
| `sqlite` | 是 | 推荐单机生产；单文件 DB，无需额外服务 |

Redis 后端已归档到 `archive/state-redis/`，不作为主包默认后端；重新引入计划见对应 GitHub issue。

### 9. 升级 / 回滚

```bash
cd /opt/genshin-group-verif
git pull
pnpm install --frozen-lockfile
pnpm build
sudo systemctl restart genshin-group-verif
```

SQLite 升级前建议备份：

```bash
cp bot-data/state.db bot-data/state.db.bak
```

## Docker 部署

仓库附带 `Dockerfile` 和 `docker-compose.yaml`。

> 构建镜像时同样需要 `bot-data/quizzes.json` 已存在，否则 `pnpm build` 会在 Docker 构建阶段失败。

```bash
# 先准备 bot-data/quizzes.json
mkdir -p bot-data
# 将题库放到 bot-data/quizzes.json

# 构建并启动
docker compose up -d --build
```

`docker-compose.yaml` 会把宿主机的 `./bot-data` 挂载到容器 `/app/bot-data`，因此题库、SQLite state 和 session 都会持久化在宿主机目录中。

## 测试

```bash
pnpm lint
pnpm test
```

当前 `pnpm test` 覆盖 Flow 测试与 memory/sqlite 状态后端测试；Redis 测试已随 Redis 后端一起移入 `archive/state-redis/`，不作为默认测试运行。
