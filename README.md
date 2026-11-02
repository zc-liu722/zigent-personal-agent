# Zigent — Your Personal Agent with Giant Context

Zigent 是一个可自行部署的个人 Agent，提供网页对话、持久化会话与记忆、长上下文管理、多供应商模型适配、主动任务以及可选的文档和代码执行能力。

当前仓库用于开源前的私有审核。它使用独立 Git 历史，仅包含经过清单筛选的产品代码、通用资源和示例配置。项目许可证及部分第三方分发事项仍待确认，尚未正式开源。

## 开始使用

需要 Node.js 22.5 或更高版本；建议使用当前受支持的 Node.js LTS。以下命令在仓库根目录运行：

```bash
npm ci
cp .env.example .env
npm run setup:password
npm run check
npm run build
npm start -- assistant
```

在 `.env` 填写自己的 `DEEPSEEK_API_KEY`，将密码工具输出的哈希填入 `ASSISTANT_WEB_PASSWORD_HASH`。示例配置位于 `config/agents.json`；也可通过 `AGENTS_CONFIG_PATH` 选择其他清单。不要提交真实凭据。

网页服务监听 `127.0.0.1:8790`。示例公开地址是 `https://localhost:8443/assistant/`，需要自行配置受信任的本地 HTTPS 反向代理，将该路径转发到监听端口。访问部署在其他机器上的实例时，将配置中的公开地址改为自己的 HTTPS 地址；登录使用 Secure Cookie，不能把 HTTP 直连当作完整登录部署。

默认示例只启用无需独立执行主机的对话、记忆、网页输出和主动任务。语音、健康、定位、账号连接、模型订阅登录、文档执行器和项目同步均需单独配置，默认不会连接任何已有生产环境或创建个人提醒任务。

## 代码入口

- `src/`：Agent 运行时、模型适配、记忆、工具、主动任务和网页服务。
- `web/`：网页客户端及组件。
- `skills/`：通用工作技能。
- `ops/document-reader/`、`ops/document-editor/`：文档读取与编辑器构建源码。
- `ops/execution/native/`：保留上游来源与许可证的原生执行模块；相关通用 worker、文档依赖和镜像定义也在 `ops/` 中。
- `ops/component-studio/`：本地组件工作台，使用 `npm run dev:components` 启动。需要用户自己的本地登录和配置。
- `tools/upstream/`：从独立源码仓库导出经过审核的文件清单与覆盖模板。

架构与可选能力见 [架构说明](docs/ARCHITECTURE.md)，更新流程见 [同步说明](docs/SYNC.md)，公开前待办见 [发布审核清单](docs/RELEASE_REVIEW.md)。

## 验证与发布

`npm run check` 进行类型检查，`npm run build` 编译服务端；`npm run build:web` 在 `build/web/` 生成前端发布文件。文档编辑器和原生执行模块有各自的锁定依赖及构建入口。

本仓库没有生产部署工作流，不接入原生产仓库的主机、密钥或自托管执行器。公开前由维护者审核代码、许可证和发布范围。
