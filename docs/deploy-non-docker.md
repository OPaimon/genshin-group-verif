# 非 Docker 构建与部署指南

> 适用于不使用 Docker / docker-compose，直接在 Linux 主机或 VM 上运行
> `genshin-group-verif`。

## 0. 审计要点（为什么这样部署）

- `pnpm start` 是 **tsx 直接运行源码** 的开发/快速启动方式，不是生产构建。
  生产构建是 `pnpm build` + `node --enable-source-maps dist/main.mjs`。
- 构建产物 `dist/main.mjs` **不是完全 self-contained**：
  - esbuild 把 `better-sqlite3` 作为 external，mtcute 内部仍会 `import` 它，
    因此运行时 `node_modules` 里必须有 `better-sqlite3`，并且它需要能被
    `dist/main.mjs` 直接解析（当前已作为直接依赖保留，`pnpm install --prod`
    会把它放在顶层 `node_modules/better-sqlite3`）；
  - `@mtcute/wasm` 的 `.wasm` 文件从 `node_modules/@mtcute/wasm/` 按包路径加载；
  - `bot-data/quizzes.json` 按 `process.cwd()/bot-data/quizzes.json` 读取；
    源文件存在时构建脚本会将其复制到 `dist/bot-data/`，缺失时则警告并继续。
    实际运行目录决定使用哪一份。
- 代码使用了 Node 内置 `node:sqlite`，而且它被静态打包进 bundle；
  所以 **Node.js 必须 >= 22.13**（代码注释：`node:sqlite` 自 Node 22.13 / 23.4 起
  无需 flag）。
- `bot-data/quizzes.json` 被 `bot-data/.gitignore` 忽略。fresh clone 可以直接构建，
  但启动验证服务前必须显式提供该运行时文件（见第 3 节）。

## 1. 环境要求

| 组件 | 要求 |
| --- | --- |
| Node.js | `>= 22.13`（推荐 22 LTS 最新版；24/25 也可） |
| pnpm | 和 lockfile 匹配，当前仓库固定 `pnpm@10.17.1`，可用 `corepack enable` 启用 |
| 网络 | 能访问 Telegram API；出方向 443 通常即可 |
| 磁盘 | `bot-data/` 需要持久化：mtcute session、SQLite state、题库 |

## 2. 获取代码

```bash
git clone git@github.com:OPaimon/genshin-group-verif.git
cd genshin-group-verif
corepack enable
pnpm --version   # 期望 10.17.1
```

## 3. 准备 `bot-data/quizzes.json`

`bot-data/quizzes.json` 没有被 git 跟踪，因此：

- 如果已有生产题库文件，直接放到 `bot-data/quizzes.json`；
- 如果只需要生成构建产物，可以暂时不提供；构建会警告并继续；
- 启动机器人前仍必须提供合法题库，否则新验证请求会被拒绝。

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

> 缺少该文件时 `pnpm build` 会输出跳过复制的警告并成功结束，不会生成空题库。
> 文件存在但复制失败时，构建仍会失败。

## 4. 安装依赖

```bash
pnpm install --frozen-lockfile
```

如果是在服务器上直接构建运行，安装全部依赖即可。
如果只部署构建产物（在 CI/另一台机器构建），服务器上至少需要 production
依赖：

```bash
pnpm install --prod --frozen-lockfile
```

> `better-sqlite3` 已作为直接依赖保留，因此 `--prod` 安装会保留它并放在顶层
> `node_modules/better-sqlite3`。如果遇到模块解析问题，最稳妥的方式是直接执行
> 完整的 `pnpm install --frozen-lockfile`。

## 5. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env
```

必填项：

- `API_ID`
- `API_HASH`
- `BOT_TOKEN`
- `LOG_PEER`

生产建议追加持久化状态配置：

```bash
STATE_BACKEND=sqlite
STATE_SQLITE_PATH=bot-data/state.db
```

Redis 后端已从主包中移除并归档到 `archive/state-redis/`，需要时以可选后端方式重新引入。

其他可选配置见 `.env.example` 和 `docs/design.md`。

## 6. 构建

```bash
pnpm build
```

构建输出：

```
dist/main.mjs
dist/main.mjs.map
dist/metafile.json
dist/bot-data/quizzes.json  # 仅当构建时源题库存在
```

构建脚本会先执行 ReScript 编译（`res:build`），再交给 esbuild 打包。

## 7. 运行

### 前台运行（快速验证）

```bash
node --env-file=.env --enable-source-maps dist/main.mjs
```

注意：`pnpm start:prod` 脚本本身不自动读取 `.env`；上面这条命令通过 Node 的
`--env-file` 显式加载 `.env`。

### systemd 常驻运行（推荐）

创建 `/etc/systemd/system/genshin-group-verif.service`：

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

## 8. 目录布局建议

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

- 运行用户需要对 `bot-data/` 有读写权限。
- 备份时优先备份 `bot-data/quizzes.json`、`bot-data/state.db` 和
  `bot-data/session/`（或已知 Telegram session 可重新登录）。

## 9. 状态后端选择

| 后端 | 是否跨重启保留验证会话 | 说明 |
| --- | --- | --- |
| `memory`（默认） | 否 | 适合本地/临时测试；重启后 pending session 丢失 |
| `sqlite` | 是 | 推荐单机生产；单文件 DB，无需额外服务 |

Redis 后端已归档（`archive/state-redis/`），不作为主包默认后端；重新引入计划见对应 GitHub issue。

## 10. 升级/回滚

```bash
cd /opt/genshin-group-verif
git pull
pnpm install --frozen-lockfile
pnpm build
sudo systemctl restart genshin-group-verif
```

SQLite 升级前建议：

```bash
cp bot-data/state.db bot-data/state.db.bak
```

## 11. 建议改进

- 保持真实题库不进入版本库或镜像层；fresh clone 构建应继续覆盖缺失题库场景。
- 当前仓库没有 CI workflow；建议增加 GitHub Actions 运行
  `pnpm lint`、`pnpm test`、`pnpm build`，防止 fresh clone 与构建问题再次出现。
