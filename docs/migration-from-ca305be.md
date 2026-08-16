# 迁移指南：从 ca305be 部署实例迁移到最新 main

> 适用对象：当前生产/测试实例仍运行在
> `ca305be7df5bf11fa4213c1b0001ae158daadcf2`
> （`feat: Enhance verification message with additional group join advertisement`），
> 需要迁移到最新 `main` head。

## 迁移前后主要变化

从 `ca305be` 到最新 `main`，代码经历了大量重构与功能新增，主要包括：

- **状态后端抽象**
  - 旧版：仅内存 `TTLMap`，重启后验证会话全部丢失。
  - 新版：`StateStore` 抽象，支持 `memory` / `sqlite`；Redis 后端已归档到 `archive/state-redis/`，不再作为主包后端。
- **Sentry 可观测性**
  - 新增 `@sentry/node`，支持错误监控与日志转发。
  - 新增 `SENTRY_DSN`、`SENTRY_ENVIRONMENT`、`SENTRY_LOG_LEVEL` 环境变量。
- **日志统一**
  - 新增 `src/logger.ts`，替换散落的 `console.*`。
- **代码结构重构**
  - 单体 `InterpreterMtCute.ts` 拆分为 `interpreter/` 下的多个模块。
  - 新增 `joinPolicy`、`quizSource`、`state` 等模块。
- **依赖变化**
  - mtcute 从 `^0.27` 升级到 `^0.31`。
  - 移除 `zod`。
  - `better-sqlite3` 继续作为直接依赖保留，版本范围与 `@mtcute/node` 对齐为 `^12.10.0`。
- **环境变量变化**
  - 必填项仍为 `API_ID`、`API_HASH`、`BOT_TOKEN`、`LOG_PEER`。
  - 新增可选：`ADMIN_IDS`、`AD_LIST_URL`、`STATE_BACKEND`、`STATE_SQLITE_PATH`、`SENTRY_*`。
  - Redis 相关 `REDIS_URL` 不再被主包读取。

## 迁移前备份

```bash
# 在旧部署目录执行
cp -a .env .env.bak
cp -a bot-data bot-data.bak
cp -a dist dist.bak 2>/dev/null || true
```

重点备份：

- `.env`
- `bot-data/quizzes.json`
- `bot-data/session/`（mtcute 登录会话）
- 如果之前已使用 sqlite/redis：对应的 state 数据

> 旧版是纯内存状态，因此没有可迁移的验证会话数据。升级到新版后如果启用
> `STATE_BACKEND=sqlite`，会新建 `bot-data/state.db`，不需要从旧版迁移数据。

## 迁移步骤

### 1. 获取最新代码

```bash
cd /path/to/genshin-group-verif
git fetch origin
git checkout main
git pull --ff-only origin main
# 或直接切换到目标 commit：
# git checkout 82e27b3
```

确认当前 head：

```bash
git rev-parse HEAD
# 期望：82e27b3（或更新的 main head）
```

### 2. 准备题库

`bot-data/quizzes.json` 不会被 git 跟踪，迁移后仍必须存在，否则 `pnpm build` 会失败。

```bash
mkdir -p bot-data
# 如果备份中有 quizzes.json，直接恢复：
cp bot-data.bak/quizzes.json bot-data/quizzes.json
# 否则创建最小合法文件
```

最小格式：

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

### 3. 安装依赖

如果需要在本机/服务器上构建：

```bash
pnpm install --frozen-lockfile
```

如果只运行已经构建好的 `dist/main.mjs`，可以只装 production 依赖：

```bash
pnpm install --prod --frozen-lockfile
```

> `better-sqlite3` 已作为直接依赖保留，`--prod` 安装也会把它放在顶层
> `node_modules/better-sqlite3`，`dist/main.mjs` 可以正常解析。

### 4. 更新环境变量

从备份恢复或重新创建 `.env`：

```bash
cp .env.bak .env
# 然后按需编辑
```

必填项：

```dotenv
API_ID=
API_HASH=
BOT_TOKEN=
LOG_PEER=
```

推荐生产配置：

```dotenv
STATE_BACKEND=sqlite
STATE_SQLITE_PATH=bot-data/state.db
```

可选 Sentry：

```dotenv
SENTRY_DSN=
SENTRY_ENVIRONMENT=production
SENTRY_LOG_LEVEL=info
```

其他可选：

```dotenv
ADMIN_IDS=
AD_LIST_URL=
```

注意：

- 如果旧 `.env` 中有 `REDIS_URL`，现在主包已不再使用，可以删除。
- 当前 `STATE_BACKEND` 只接受 `memory` 或 `sqlite`。
- 如果旧实例使用 Redis 后端，需要先评估是否迁移到 `sqlite`，或等待 Redis 作为可选后端重新引入。

### 5. 构建

```bash
pnpm build
```

构建产物：

```text
dist/main.mjs
dist/main.mjs.map
dist/bot-data/quizzes.json
dist/metafile.json
```

### 6. 冒烟测试

在正式切换前，先用前台方式验证：

```bash
node --env-file=.env --enable-source-maps dist/main.mjs
```

预期：

- 日志出现 `[State] Using ... backend`
- 日志出现 `Loaded N quizzes from ...`
- 日志出现 `🚀 Starting bot`
- 使用真实 Telegram 凭据时应能正常登录

如果使用假凭据，可能会在登录阶段报 `API_ID_INVALID` 等 Telegram 错误，这属于预期行为；只要没有 `ERR_MODULE_NOT_FOUND` 或模块加载错误即可。

### 7. 更新 systemd / Docker 部署

#### systemd

确认 service 文件中的：

- `WorkingDirectory` 指向新代码目录
- `EnvironmentFile` 指向新 `.env`
- `ExecStart` 使用生产 bundle：

```ini
ExecStart=/usr/bin/node --enable-source-maps dist/main.mjs
```

重启：

```bash
sudo systemctl daemon-reload
sudo systemctl restart genshin-group-verif
sudo systemctl status genshin-group-verif
journalctl -u genshin-group-verif -f
```

#### Docker / docker-compose

构建镜像前确保 `bot-data/quizzes.json` 已存在：

```bash
docker compose up -d --build
```

`docker-compose.yaml` 会挂载 `./bot-data:/app/bot-data`，因此题库、SQLite state 和 session 会持久化在宿主机。

### 8. 迁移后验证

- `/ping` 应返回 `Pong`
- `/reload` 应由管理员触发并成功重载题库
- 实际入群/入群申请流程应正常工作
- 如果配置了 Sentry，可在 Sentry 后台看到 environment 与日志
- 如果启用 `STATE_BACKEND=sqlite`，确认 `bot-data/state.db` 可写且重启后会话仍可恢复

## 回滚方案

如果迁移后出现问题，可以回滚到旧版本：

```bash
# 回到旧 commit
git checkout ca305be7df5bf11fa4213c1b0001ae158daadcf2
pnpm install --frozen-lockfile
pnpm build

# 恢复旧环境变量和题库
cp .env.bak .env
cp -a bot-data.bak/. bot-data/

# 重启服务
sudo systemctl restart genshin-group-verif
# 或
docker compose up -d --build
```

> 注意：如果新版已经写入了 `bot-data/state.db` 或修改了 mtcute session，
> 回滚前建议再备份一次新数据。

## 特别提醒

- mtcute 从 `^0.27` 升到 `^0.31` 属于大版本升级，`bot-data/session/` 中的会话文件可能出现不兼容。迁移前务必备份；如果登录异常，可删除 session 后让机器人用 `BOT_TOKEN` 重新登录。
- 旧版是纯内存状态，迁移到新版后若希望重启不丢验证会话，请设置 `STATE_BACKEND=sqlite`。
- Redis 后端已从主包移除并归档，不要在新部署中继续依赖 `STATE_BACKEND=redis` 或 `REDIS_URL`。
