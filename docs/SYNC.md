# 从维护源码更新

维护源码仓库继续管理生产版本，本仓库保存经过筛选的社区代码。默认采用“生产版本完成验证 → 导出到更新分支 → 扫描与编译 → PR 审核 → 合入”的节奏，每次同步都以明确的已验证提交为单位。当前没有定时任务，也没有无人审核的自动推送。

同步导入文件内容，不导入源仓库 Git 历史、分支、提交说明、作者信息、凭据或运行数据。社区构建与原生产发布没有执行器或密钥依赖。

## 建立更新分支

确认本仓库工作区干净并更新本地 `main`，再建立自己的更新分支。不要把当前未提交的社区改动当作可以覆盖的文件。

```bash
git switch main
git pull --ff-only
git switch -c codex/community-update
```

下面的源目录和提交都是示例参数，按自己的本机 checkout 与维护记录填写。将源提交保存在本地维护记录中；不把私人部署详情写进公开 PR。

```bash
python3 tools/upstream/export.py --source /path/to/source-checkout --ref SOURCE_COMMIT --check
python3 tools/upstream/export.py --source /path/to/source-checkout --ref SOURCE_COMMIT
npm ci
npm run check
npm run build
npm run build:web
python3 tools/license-inventory.py
```

如果锁文件发生变化，改用 `python3 tools/license-inventory.py --refresh-registry`，联网核对精确版本的注册表元数据，再把完成审核的盘点结果同时更新到覆盖模板。

## 清单与社区覆盖

`tools/upstream/manifest.json` 是逐文件允许清单，新文件不会自动导入。缺失文件、脱敏片段哈希变化、软链接或明显隐私匹配都会阻止导出。只读取指定提交的 Git blob，不读取工作目录里的 `.env`、本地快照、stash 或诊断文件。

`tools/upstream/overlays/` 独立维护社区配置、README、部署模板和工具等内容。以后要保留的社区改动，先修改对应覆盖模板，再运行导出。需要适配源文件改动时，复核并更新哈希补丁；补丁只保存旧片段哈希和行范围，不保存待删除的私人原文。

`.upstream-state.json` 仅留本地，记录准确源提交与管理状态。随仓库保存的 `.upstream-managed.json` 只包含公开文件的内容哈希，供新的 clone 恢复比较基线。导出会先检查将写入或删除的所有管理文件；独立修改会阻止覆盖。不要手动伪造哈希来跳过冲突。

## 更新 PR

查看 `git diff`，核对新文档、图片、端点、第三方声明以及默认能力。可使用本机安装的 Gitleaks：

```bash
git add --all
gitleaks git . --staged --redact=100
```

逐项核实误报，不添加宽泛忽略。当前健康任务源码中的固定任务标识可能被识别成 generic API key，只有确认它仍是任务 ID 时才记录为误报。

检查后正常提交并推送这个更新分支，在本仓库创建 PR。PR 说明面向社区描述具体行为、功能范围及验证结果；不要复制源仓库的私有提交说明、诊断或生产记录。维护者审核后合入 `main`。

导出脚本本身不会提交、推送、启用 Actions、部署或改变仓库可见性。第一次遇到新的私人目录或数据类型时，应先完善筛选与扫描策略。

## 独立构建

`.github/workflows/build.yml` 只使用 GitHub 托管的 Ubuntu 与 Node 24，权限为读取源码。它执行依赖安装、类型检查、服务端编译和网页编译，不运行测试、不访问生产、不上传构建附件、不发布软件包。

工作流已准备好，仓库 Actions 仍关闭，所以尚无云端通过结果。维护者决定启用后，它可用于更新 PR、`main` 提交或手动构建；启用工作流不等于授权改为 Public。
