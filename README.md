# 闲鱼管理系统 · 私有部署与本地增强

把 [zhinianboke/xianyu-auto-reply](https://github.com/zhinianboke/xianyu-auto-reply) 用 Docker 私有部署在自己机器上，
并做了三处本地增强：**网页内消息弹窗**、**语音播报**、**首页禁用缓存**。

本仓库**只包含部署配置和本地增强代码**，不含任何账号数据。详见[「本仓库不包含什么」](#本仓库不包含什么)。

---

## 架构

整套系统由 6 个容器组成，通过一个 Docker 网络互联：

```
                     浏览器 / 手机
                          │
                          ▼
   ┌──────────────────────────────────────┐
   │  frontend (nginx)          :9000     │  ← 唯一需要对外暴露的
   │  托管前端 + 反代 /api → backend-web   │
   └───────────────┬──────────────────────┘
                   │
   ┌───────────────▼──────────────────────┐
   │  backend-web (FastAPI)     :8089     │  业务 API、鉴权、账号/商品/订单
   └───────────────┬──────────────────────┘
                   │
      ┌────────────┼────────────┬───────────────┐
      ▼            ▼            ▼               ▼
 ┌─────────┐ ┌──────────┐ ┌───────────┐ ┌──────────────┐
 │websocket│ │scheduler │ │  mysql    │ │   redis      │
 │  :8090  │ │  :8091   │ │  :3306    │ │   :6379      │
 └─────────┘ └──────────┘ └───────────┘ └──────────────┘
  闲鱼长连接    定时任务      数据持久化     缓存/任务协调
  IM 消息收推   补发/擦亮
```

### 各服务职责

| 服务 | 端口 | 职责 |
|---|---|---|
| `frontend` | 9000 | nginx 托管前端构建产物，并把 `/api` 反代到 backend-web。**只有它需要对外暴露** |
| `backend-web` | 8089 | 主业务 API：登录鉴权、账号管理、商品发布、订单、卡券、通知渠道 |
| `websocket` | 8090 | 与闲鱼建立 WebSocket 长连接，收发 IM 消息、刷新 token、处理滑块 |
| `scheduler` | 8091 | 定时任务：自动补发货、补评价、商品擦亮、数据库备份 |
| `mysql` | 3306 | 主数据存储（账号、Cookie、订单、商品、卡券、通知配置） |
| `redis` | 6379 | 缓存、Token 缓存、分布式锁 |

### 数据流向

```
买家发消息
   → 闲鱼服务器推送 → websocket 容器解析
        ├─ 写入 mysql
        ├─ 交给自动回复/AI 引擎决定是否回复
        ├─ 经 Redis 通知 backend-web
        └─ 按「通知渠道」配置推送到 钉钉 / PushPlus / 企业微信 / Bark …

浏览器
   → frontend :9000 → /api → backend-web :8089 → mysql/redis
   → WebSocket /api/v1/chat-new/ws/{账号} → backend-web → websocket
```

---

## 快速部署

### 环境要求

- Docker Desktop（含 Docker Compose v2）
- 磁盘：镜像约 8.7 GB
- 内存：建议 4 GB 以上给 Docker

### 步骤

```bash
# 1. 准备配置
cp .env.example .env
# 编辑 .env，把三处「改成你自己的强密码」替换掉

# 2. 创建数据挂载目录
mkdir -p xianyu_auto_reply/{mysql/data,redis/data,logs/backend_web,logs/websocket,logs/scheduler,static,backups,browser_data}

# 3. 拉镜像（约 8.7 GB，首次较慢）
docker compose -f docker-compose.deploy.yml pull

# 4. 启动
docker compose -f docker-compose.deploy.yml up -d
```

浏览器打开 `http://localhost:9000`，用 `admin` / `admin123` 登录，
**登录后第一件事是改密码**（后台「个人设置」里改）。

> Windows 用户：仓库里带了三个批处理，双击即可
> `启动系统.bat` / `停止系统.bat` / `查看状态.bat`。
> 注意它们内部设置了 `COMPOSE_PROJECT_NAME=xianyu-auto-reply`，
> 手动执行 compose 命令时也要带上这个环境变量，否则容器名会和项目名对不上。

详细步骤见 [docs/部署步骤.md](docs/部署步骤.md)。

---

## 本地增强（本仓库与上游的差异）

三处改动都通过 `docker-compose.deploy.yml` 里的只读挂载覆盖进容器，
**删掉对应的 volumes 行即可完全还原成上游原版**。

### 1. 网页内消息弹窗 + 语音播报

**文件**：`overrides/lognotify.js`、`overrides/index.html`

**挂载**：frontend 容器

```
./overrides/index.html    → /usr/share/nginx/html/index.html
./overrides/lognotify.js  → /usr/share/nginx/html/lognotify.js
```

`index.html` 里只多了一行 `<script src="/lognotify.js"></script>`，
其余逻辑全在 `lognotify.js` 中。

它**复用系统自带的在线聊天 WebSocket 通道**（不加新接口、不改后端）：

```
账号列表   GET  /api/v1/cookies/options
实时消息   WS   /api/v1/chat-new/ws/{账号ID}?token={登录令牌}
```

收到 `event=new_message` 且 `message.isSelf === false`（买家发来的）时触发：

- **右下角弹卡片**：买家昵称 + 账号备注 + 消息内容，点卡片跳到在线聊天页
- **两声提示音**：WebAudio 合成，峰值 0.9（正弦波 880Hz → 1180Hz）
- **语音播报**：SpeechSynthesis 播报「闲鱼有新消息，来自 XXX」，不念正文
- **标签页标题闪烁**：`🔔 有新消息`，页面切到后台也能看到
- **桌面通知**：Notification API，仅在页面处于后台时弹（避免重复打扰）

**两个已知限制**：

- 页面必须开着。这是网页内提醒的固有限制——关掉浏览器就收不到。
  需要"关掉浏览器也能收到"请改用**通知渠道**（见下）。
- 桌面通知与语音都需要浏览器支持。部分内置浏览器（如 Codex 应用内浏览器）
  没有 `Notification` 对象，脚本会自动隐藏"开启桌面通知"的按钮；
  脚本也会在第一次点击页面时解锁音频，否则提示音会被浏览器的
  自动播放策略静默拦掉。

### 2. 首页禁用缓存

**文件**：`overrides/nginx-default.conf`

**挂载**：frontend 容器

```
./overrides/nginx-default.conf → /etc/nginx/conf.d/default.conf
```

上游配置对 `index.html` 没有显式缓存策略，浏览器会按启发式规则缓存它。
结果是改了前端之后，用户按 F5 仍在跑缓存的旧页面，表现为"改了没反应"。

改动是给 `location = /index.html` 和 `location /` 加上：

```nginx
add_header Cache-Control "no-store, no-cache, must-revalidate";
```

构建产物是 hash 文件名，靠原有的 `/assets` 规则缓存即可，不受影响。

---

## 手机在外访问

**不要把 9000 端口直接暴露到公网。** 这套系统里存着全部账号的 Cookie 和明文密码。

推荐用 **[Tailscale](https://tailscale.com/)**（免费个人版 3 用户 / 100 设备）：

1. 电脑和手机各装一个 Tailscale，登录同一账号
2. 查电脑的 Tailscale 地址：
   ```bash
   tailscale ip -4        # 形如 100.x.y.z
   ```
3. 手机浏览器打开 `http://100.x.y.z:9000`

这样外人连"这个服务存在"都探测不到，只有你自己 tailnet 里的设备能访问。

其他方案的取舍见 [docs/网络与手机访问.md](docs/网络与手机访问.md)。

---

## 手机推送（关掉浏览器也能收到）

网页内弹窗依赖页面开着。要在**手机锁屏、电脑浏览器关闭**时也能收到提醒，
必须配**通知渠道**——那是由服务端主动推送的，与客户端是否在线无关。

支持 8 种渠道：

| 渠道 | 说明 | 备注 |
|---|---|---|
| **PushPlus** | 微信公众号推送 | **最省事**，只需一个 token |
| 微信通知 | 企业微信机器人 | 需建群拿 Webhook |
| 钉钉通知 | 钉钉机器人 | 注意安全设置（关键词或加签） |
| 飞书通知 | 飞书机器人 | 同上 |
| Bark | iOS 推送 | 仅 iPhone |
| 邮件 | SMTP | 延迟较高 |
| Telegram | Bot | 国内网络需代理 |
| Webhook | 自定义 HTTP | 可对接自建服务 |

**配置位置**：「通知渠道」建渠道 →「消息通知」把账号和渠道绑定。
**两步都要做**，只建渠道不绑定是不会推的。

> 钉钉的坑最多：安全设置三选一（关键词 / 加签 / IP 段），
> 选了加签就必须把 `SEC` 开头的完整密钥填进 `secret` 字段。
> 另外上游代码判断发送结果时只看 HTTP 200，而钉钉**被拒绝时也返回 200**，
> 所以日志里会显示"发送成功"但实际没收到——排查时优先检查安全设置。

---

## 运维

### 常开要求

服务跑在本机，所以**电脑必须开着**：

```
电脑开机 → Docker Desktop 运行 → 6 个容器在跑
```

任何一层断了，消息收发、自动回复、推送全部停止。

已做的配置：

- 容器 `restart: unless-stopped`，Docker 一起来就自动恢复
- 电源设为交流电下不睡眠

**仍需注意**：Windows 重启后会停在登录界面，Docker Desktop 是用户级程序，
不登录就不会启动。建议关掉 Windows 更新的自动重启。
不建议开启 Windows 自动登录——密码会明文存进注册表，
而这台机器里存着全部账号凭据。

### 常用命令

```bash
export COMPOSE_PROJECT_NAME=xianyu-auto-reply   # Windows: $env:COMPOSE_PROJECT_NAME='xianyu-auto-reply'

docker compose -f docker-compose.deploy.yml ps            # 状态
docker compose -f docker-compose.deploy.yml logs -f       # 日志
docker compose -f docker-compose.deploy.yml down          # 停止
docker compose -f docker-compose.deploy.yml pull          # 更新镜像
docker compose -f docker-compose.deploy.yml up -d         # 应用更新
```

### 备份

系统自身有定时备份，落在 `xianyu_auto_reply/backups/`。
备份文件是**gzip 压缩的明文 SQL，含全部账号凭据**，注意保管，
不要传到网盘、聊天工具或任何公开位置。

---

## 本仓库不包含什么

运行时会生成的数据目录 `xianyu_auto_reply/` 被 `.gitignore` 完全排除，
其中包括：

| 目录 | 内容 | 为什么危险 |
|---|---|---|
| `mysql/data/` | 数据库 | 含账号 Cookie 与**明文账号密码** |
| `backups/` | 自动备份 | gzip 加密前缀都没有的明文 SQL |
| `redis/data/` | 缓存 | 含 Token 缓存 |
| `browser_data/` | 浏览器配置 | 含登录态 |
| `logs/` | 运行日志 | 含账号 ID、消息内容 |
| `.env` | 配置 | 数据库与 Redis 密码 |

`.gitignore` 采用**白名单**写法（先 `*` 排除一切，再逐项 `!` 放行），
而不是常见的"列出要忽略的文件"——后者容易漏，一旦误提交就不可逆。

**提交前建议自查一遍**：

```bash
git add -A
git status --short          # 看看有没有多出不该有的文件
git diff --cached --stat    # 确认改动范围
```

---

## 上游与许可

- **上游项目**：[zhinianboke/xianyu-auto-reply](https://github.com/zhinianboke/xianyu-auto-reply)
- **许可证**：AGPL-3.0（本仓库的部署配置与增强代码同样遵循）
- **本仓库的改动**：见上文「本地增强」，均通过只读挂载方式覆盖，不修改上游源码

按 AGPL-3.0 要求，本仓库公开全部修改内容。若你需要分发本部署或基于它提供服务，
请一并遵守 AGPL-3.0。

---

## 免责声明

本项目是**第三方逆向实现**，非闲鱼官方接口。使用前请自行评估：

- 可能违反闲鱼/淘宝的用户协议，账号存在被风控、限制甚至封禁的风险
- 系统会持久化保存账号 Cookie 与账号密码，请自行确保运行环境的安全
- 请遵守相关法律法规，不要用于违法违规用途

建议使用非主力账号，并确保账号密码与本人在其他服务的密码不重复。
