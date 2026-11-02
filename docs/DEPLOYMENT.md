# HTTPS 与自行部署

基础部署由两个进程组成：Zigent 在本机 `127.0.0.1:8790` 接收请求，Caddy 提供 HTTPS 并保留 `/assistant/` 前缀转发。配置模板只包含通用占位信息，不关联已有生产环境。

## 本地 HTTPS

先按 [安装指南](GETTING_STARTED.md) 配置并启动后端。浏览器访问地址默认是 `https://localhost:8443/assistant/`。

安装 Caddy 后，在仓库根目录运行：

```bash
caddy adapt --config ops/community/Caddyfile.local --adapter caddyfile --pretty
caddy run --config ops/community/Caddyfile.local --adapter caddyfile
```

模板绑定 IPv4 回环地址，不接收局域网连接；没有启动 Caddy 管理 API，也不自动安装证书信任。本地根证书由 Caddy 在自己的数据目录中生成，不进入仓库。

首次运行后，按 [Caddy 官方本地证书说明](https://caddyserver.com/docs/automatic-https#local-https)，从运行 Caddy 的用户数据目录中找到 `pki/authorities/local/root.crt`，手动导入自己的系统与浏览器信任库。模板关闭了管理 API，因此这里采用手动导入；`caddy trust` 默认需要连接管理 API 获取根证书。须确认导入的是刚才运行实例的证书。信任操作可能要求操作系统管理员权限。只导入 `.crt` 证书，不共享 CA 私钥，不用忽略证书错误替代正确配置。

证书被信任后打开默认地址并输入自己的登录密码。`http://127.0.0.1:8790` 主要用于本机健康检查，完整登录通过 HTTPS 访问。

## 使用自己的域名

复制 `config/agents.example.json` 到本机不进入 Git 的 `.runtime/agents.local.json`，创建目录后修改 `agents[0].web.publicUrl` 为自己的地址，例如 `https://agent.example.com/assistant/`。在本机 `.env` 设置 `AGENTS_CONFIG_PATH=.runtime/agents.local.json`。

后端仍只监听 `127.0.0.1:8790`。域名解析到自己运行 Caddy 的主机，并按所选证书验证方式准备 80/443 的网络可达性。不要把域名、端口、凭据或数据绑定到任何其他人的服务器。

macOS/Linux 的前台启动示例：

```bash
# 终端一：在仓库根目录运行
npm run start:prod -- assistant

# 终端二：同一台机器；把示例域名改为自己的
export ZIGENT_DOMAIN=agent.example.com
caddy adapt --config ops/community/Caddyfile.domain --adapter caddyfile --pretty
caddy run --config ops/community/Caddyfile.domain --adapter caddyfile
```

Windows PowerShell 的第二个终端：

```powershell
$env:ZIGENT_DOMAIN = 'agent.example.com'
caddy run --config ops/community/Caddyfile.domain --adapter caddyfile
```

`ZIGENT_DOMAIN` 只填主机名，不带 `https://` 或路径；与 Agent 配置的地址一致。Caddy 为满足条件的公网域名自动管理 HTTPS 证书。详见 [自动 HTTPS](https://caddyserver.com/docs/automatic-https) 和 [反向代理](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。模板不移除 Agent 路径前缀，也没有给长连接额外设置短超时。

## 可选 Linux 服务

`ops/community/zigent.service.example` 提供基础 systemd 单元。它假定你自己准备了 `zigent` 系统账户、`/opt/zigent` 目录和 `/usr/bin/node`，并在该目录完成依赖安装、编译与本机 `.env` 配置。复制安装前修改实际路径，并确认服务账户可以读取程序和凭据、写入自己的 `data/`。

确认 `/usr/bin/node --version` 是目标 Node.js 版本，不能假定交互式终端的版本管理器同样适用于 systemd。Caddy 由其独立服务或自己的前台进程管理。

模板不创建账户、不修改系统设置，也不包含任何人的部署。需要安装它的主机管理员按正常 systemd 流程审核后操作。Windows 和 macOS 当前使用前台启动，持久化服务安装暂不属于已验收能力。

## 健康与首次验收

本机执行 `curl http://127.0.0.1:8790/healthz`，或 PowerShell 的 `Invoke-RestMethod` 查看健康状态。反向代理示例仅转发 Agent 路径，不把根健康与发布控制路径公开。

使用自己的浏览器、密码和模型账号检查：登录、创建会话、发送一条简单消息、回复流式展示、重启后重新读取会话。确认这些行为后，再自行创建需要的主动任务。当前仓库准备只完成源码/构建检查，不声称已代用户完成真实模型和 HTTPS 验收。

## 运行维护

`.env` 保存本机秘密；`data/` 保存会话、网页状态、记忆和后续任务。Caddy 的证书与 CA 文件在它自己的受保护数据目录。只把这些信息放到自己的受控备份中，不进入 Git、公开 Actions 附件或维护 PR。

停机备份时先等待活动完成，正常停止 Zigent，再一致备份整个 `data/` 和本机配置。在线 SQLite 备份应使用 SQLite 支持的备份方式，不只复制正在写入的主数据库文件。恢复到自己的独立目录，保留原件并核对账户和地址；不要用其他机器的个人数据覆盖已有实例。

升级时保留数据与秘密，阅读变更说明，安装新版本依赖并编译。回退代码前核对数据结构兼容性；不承诺所有数据库迁移都可直接逆转。仓库的代码同步不会同步任何运行数据。
