# 架构与可选能力

Zigent 面向可以自行部署和修改的个人 Agent。Giant Context 包括持续积累的生活/工作上下文、会话和记忆；模型窗口只是实现的一部分。数据接入提供可查询证据，程序执行触发规则，模型结合上下文决定内容与行动。

## 默认运行路径

`src/index.ts` 从 `config/agents.json`（或 `AGENTS_CONFIG_PATH`）读取 Agent 清单，创建模型、会话、记忆、工具与网页运行时。`web/` 使用网页 HTTP/SSE 与认证操作接口。`data/` 保存本机产生的会话、网页状态与记忆，始终排除在 Git 之外。

示例 Agent ID 是 `assistant`，环境变量前缀为 `ASSISTANT`。模型采用完整的 family-version-supplier 路由身份，默认示例仅启用一条官方 API 路线，复用源码中记录的供应商上下文和推理档位元数据。

## 长上下文与记忆

`src/models/` 负责请求适配、流式响应、上下文策略、压缩、供应商能力与用量。`src/memory/` 负责会话历史和持久化记忆。持续积累的个人上下文通过保存、查询和整理被后续任务使用；实际模型窗口仍以所选模型、供应商和运行时报告为准。

## 可选集成

账号授权、健康与定位接收、手机通知、语音、图像、视频、浏览器、项目同步、Codex/Claude 订阅适配等源码保留供审核与后续配置。没有导入个人授权、通知设备、存储桶、生产域名或登录缓存。示例不启用这些外部依赖。

## 文档与执行

文档解码 worker 位于 `ops/document-reader/`；编辑器源码位于 `ops/document-editor/`。通用执行 worker 与原生 Rust 模块位于 `ops/execution/`，文档库锁文件位于 `ops/file-runtime/`。高级执行需要独立准备环境、账户隔离和受控凭据。导出没有携带已有机器的安装、迁移、恢复和生产发布脚本。

项目登记表 `ops/project-spaces/projects.json` 默认为空。项目同步的历史 Agent/Windows 约束仍有待进一步通用化；它不属于默认示例的可用能力。不要将项目目录或生产账户信息直接写进公开配置。

## 第三方来源

原生模块的来源、版本和本地改动记录见 `ops/execution/native/UPSTREAM.md`。前端 KaTeX、highlight.js、Vaul 和文档编辑器的许可证随对应目录保留。完整项目许可证和依赖分发策略须在正式公开前完成审核。
