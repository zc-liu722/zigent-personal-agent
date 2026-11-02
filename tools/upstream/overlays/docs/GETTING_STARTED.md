# 安装指南

## 适用范围

这条路径用于启动基础网页 Agent：对话、上下文、记忆、搜索、技能和主动任务。高级执行器、个人账号连接和设备接入的状态见 [功能支持表](SUPPORT.md)。完整登录和供应商调用仍在首版验收清单中，不以编译通过替代实际体验。

建议以 Node.js 24 LTS 作为首版部署基线。`package.json` 保留源码最低版本要求 `>=22.5.0`；其他 Node.js 版本的完整兼容性需单独确认。Node 24 仍处于 LTS，状态可查 [Node.js 官方版本表](https://nodejs.org/en/about/previous-releases)。

准备 Git、随 Node.js 安装的 npm、自己的 DeepSeek API key，以及用于 HTTPS 的 Caddy。Caddy 安装方式见 [官方说明](https://caddyserver.com/docs/install)。运行基础服务不需要 Python、Rust、Docker 或模型订阅登录；Python 3.11+ 只用于维护导出与许可证盘点工具。

## 获取源码

仓库已公开，可以通过下面的 HTTPS 地址直接克隆。克隆到自己的开发或部署目录；不要使用任何已有生产服务目录。

```bash
git clone https://github.com/zc-liu722/zigent-personal-agent.git
cd zigent-personal-agent
npm ci
```

在将要运行的机器上安装依赖，不跨平台复制 `node_modules/`；图片和画布库可能选择平台原生包。保留 npm 的可选依赖安装行为。

## 配置凭据

macOS/Linux：

```bash
cp .env.example .env
npm run setup:password
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
npm run setup:password
```

密码工具需要交互式终端，输入时不回显。使用 12–256 个字符的密码；它只输出兼容应用的 scrypt 哈希，不保存或发送密码。把输出的 `ASSISTANT_WEB_PASSWORD_HASH=...` 整行复制到 `.env`，填入自己的 `DEEPSEEK_API_KEY`。不要在聊天、截图、Git 提交或工单中粘贴真实值。

`.env` 中只放本机凭据及必要的环境变量。模型、URL、端口、工具和数据目录配置保存在 `config/agents.json`。本机配置中的凭据引用以 `ASSISTANT` 为前缀；不要把 API key 直接放进 JSON。

## 编译与启动

```bash
npm run check
npm run build
npm run start:prod -- assistant
```

以上命令对两种终端相同。`assistant` 是配置中的 Agent ID，必须与启动参数一致。开发时可用 `npm run dev -- assistant`；停止前台服务使用 Ctrl+C。

后端仅监听 `127.0.0.1:8790`。可在另一终端执行 `curl http://127.0.0.1:8790/healthz`，Windows PowerShell 可用 `Invoke-RestMethod http://127.0.0.1:8790/healthz`。健康接口成功只代表服务已启动，不代表模型账号已验证。

## 打开网页

按 [部署说明](DEPLOYMENT.md#本地-https) 启动本地 HTTPS，使用 `https://localhost:8443/assistant/`。登录输入原始密码。服务使用 Secure Cookie，浏览器须信任本地证书；不要依靠忽略证书警告完成正式使用。

登录后可新建会话并发送一条简单消息，自行确认模型回复、活动展示与会话保存。本次仓库准备没有代用户发起这类模型调用。

## 需要改哪些配置

| 配置 | 默认值与含义 |
| --- | --- |
| `agents[0].id` | `assistant`；启动参数及网页路径的身份 |
| `agents[0].envPrefix` | `ASSISTANT`；本机凭据环境变量前缀 |
| `web.publicUrl` | `https://localhost:8443/assistant/`；必须与浏览器实际地址一致，保留末尾 `/` |
| `web.listenHost` / `listenPort` | `127.0.0.1` / `8790`；由本机 HTTPS 代理转发 |
| `modelOrder` | 完整模型身份；不能用 `primary` 或 `fast` 等角色别名替代 |
| `storage` 与 `web.storage` | 本机 `data/` 下各自独立的数据库和记忆目录 |
| `allowedTools` | 启用的工具；添加高级工具前先准备其运行环境 |

可以复制示例到 `.runtime/agents.local.json`，在 `.env` 设置 `AGENTS_CONFIG_PATH=.runtime/agents.local.json`；该目录不进入 Git。不要误把本机 URL 和个人项目配置回写成公开示例。

`config/roles/assistant.md` 是通用角色参考文本，目前没有自动导入入口；修改它不等于已修改运行中的持久化规则。通过网页提供的记忆/规则编辑能力维护实际规则。

## 常见问题

| 现象 | 先检查 |
| --- | --- |
| 无可用模型或缺少配置 | `.env` 是否在仓库根目录；API key 的变量名是否正确 |
| 网页可打开但登录失败 | HTTPS 证书是否被信任、URL 是否与配置一致、是否填入了完整密码哈希 |
| 修改哈希后仍只能用旧密码 | 现有网页数据库可能已经保存密码；通过网页密码修改流程更新，启动配置并不保证覆盖已有设置 |
| 页面显示服务不可用 | 后端是否启动、Caddy 转发端口是否与配置一致 |
| 模型报错 | 核对账户、余额/权限和供应商网络；编译成功不会验证这些信息 |
| 文件执行或外部集成不可用 | 默认未启用；查看支持表，配置对应执行环境和授权 |
| 换机器后原生模块加载失败 | 在目标平台重新运行 `npm ci`，不要复制另一平台的依赖目录 |

本机运行数据和凭据的备份方式见 [运行维护](DEPLOYMENT.md#运行维护)。
