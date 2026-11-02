# 从维护源码更新

本仓库保存可公开产品快照，维护源码仓库继续独立管理生产环境。同步只导入文件内容，不导入源仓库 Git 历史、分支、提交说明、作者信息或运行数据。

## 本地导出

在本仓库根目录执行，`--source` 指向本机独立的源码 Git checkout，`--ref` 指定已经完成生产验证的提交：

```bash
python3 tools/upstream/export.py --source /path/to/source-checkout --ref SOURCE_COMMIT --check
python3 tools/upstream/export.py --source /path/to/source-checkout --ref SOURCE_COMMIT
npm ci
npm run check
npm run build
npm run build:web
```

`manifest.json` 是逐文件允许清单。新文件不会自动加入；缺失文件、脱敏补丁的原始片段变化、软链接和明显的隐私匹配都会使导出失败。导出仅从指定提交读取 Git blob，不读取源码工作目录、`.env`、本地快照、stash 或诊断文件。

独立维护的配置、说明、角色、工具和文档位于 `tools/upstream/overlays/`，每次导出覆盖对应输出。公开版需要长期保留的改动应同时放入这些覆盖模板，或以审核后的哈希校验补丁维护。补丁只记录原片段的哈希和行范围，不保存待删除的私人原文。

导出记录 `.upstream-state.json` 保存确切源提交与已管理文件哈希，仅留本地。`.upstream-managed.json` 随本仓库保存导出文件的内容哈希，不包含源仓库地址、提交或私人原文；新的 clone 使用它恢复比较基线。后续运行会先检查所有将写入或删除的文件，独立改动会阻止覆盖。不要手动伪造基线来绕过保护。

## 检查与提交

查看 `git diff`，使用 Gitleaks 扫描新快照；人工复核新加入的文档、图片、端点和许可证。扫描误报应逐项核实，不添加宽泛忽略规则。

导出只更新本地文件，不提交、不推送、不修改仓库可见性、不触发生产操作。检查完成后正常提交到本仓库；团队协作可使用更新 PR。定期同步建议以生产已验证版本为单位，在独立环境运行。当前未配置无人审核的定时推送，也不复用生产执行器或生产凭据。
