# 许可证与发布决策

根项目许可证尚未选择，当前仓库保持私有审核。已有第三方代码、字体和依赖分别保留自己的许可；将来选择根许可证时，也不能替换这些上游条件。

## 需要维护者决定的授权方向

以下是给自有代码选择许可证时的比较，不是对整个依赖组合的放行：

| 选项 | 适合的意愿 | 需要保留的关注点 |
| --- | --- | --- |
| MIT | 希望使用、修改和商业采用门槛较低，许可文本简短 | 许可包含保留版权/许可声明条件；另查第三方分发要求 |
| Apache-2.0 | 希望采用宽松许可，并使用明确的专利授权及相关条款 | 需遵守许可证的通知与再分发条件；另查第三方分发要求 |

官方依据：[MIT](https://opensource.org/license/mit)、[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)。维护者决定后再增加根 `LICENSE` 并更新包元数据；本次没有代为授予开源许可。

## 首版分发策略

首版先准备源码、锁文件、网页资源和安装文档。暂不发布捆绑模型客户端、Python/LibreOffice/字体的安装包或执行镜像；也不因为工作流能编译就自动发布软件包。

这个策略减少首批分发产物的复杂度，但不免除源码、已有前端资源或本机安装依赖的许可审核。实际要分发哪一份源码、二进制、镜像或网络服务，应按那份组合分别判断。

## 已确认需要单独核对的部分

| 部分 | 本仓库的证据 | 后续处理 |
| --- | --- | --- |
| PyMuPDF/MuPDF | 可选文档运行时锁定 PyMuPDF 1.28.2；精确版本元数据及官方说明提供 AGPL/商业双许可 | 公开或分发相关功能前决定适用授权及满足方式，或先实施并验收替代方案；默认关闭工具不能替代许可判断 |
| sharp 的预构建包和 libvips | 默认 npm 锁文件中，部分平台包声明 LGPL-3.0-or-later 或与 Apache/MIT 的组合 | 按实际目标平台、二进制及附带库检查许可证、来源与再分发材料，不把 sharp 的顶层许可套用于整个预构建包 |
| Rust 原生执行模块 | 本地保留 Apache-2.0、NOTICE、WezTerm MIT 声明及逐文件来源记录 | 保留既有通知；构建发行物时还需记录实际依赖及相应许可 |
| LibreOffice 与运行时字体 | 可选运行时清单分别记录 MPL-2.0 和 OFL-1.1，并保留字体许可 | 发布相应运行时前按实际分发文件补齐许可与来源材料 |
| 前端资源和编辑器 | KaTeX、highlight.js、Vaul 和文档编辑器的许可随文件保留 | 保留现有许可，更新或重打包时重新核对；图标、技能文本和项目自有素材的来源需维护者确认 |
| 供应商客户端、订阅与账号连接 | 相关适配源码保留，默认不启用 | 开源许可不等于供应商的服务或订阅授权；由使用者另行配置并遵守供应商条款 |

[PyMuPDF 官方许可说明](https://pymupdf.readthedocs.io/en/latest/about.html#license-and-copyright)确认其双许可。libvips 上游当前 README 声明 LGPL-2.1-or-later，而本仓库某些预构建 npm 包声明 LGPL-3.0-or-later；两者对象和组合不同，应核对实际分发包，不能直接用前者覆盖后者。[libvips 上游说明](https://github.com/libvips/libvips/blob/master/README.md)

## 声明盘点的范围

[DEPENDENCIES.md](DEPENDENCIES.md) 和 [dependency-inventory.json](dependency-inventory.json)记录 npm、Python 和 Cargo 锁定依赖的版本、许可声明及来源。元数据缺失会明确标记；包含 GPL、LGPL、AGPL、MPL 或未取得表达式的条目先列入进一步审查，并不自动判定为不能使用。

该清单没有逐一检查每个压缩包和原生二进制中的全部嵌入库，不是完整 SBOM，也不是漏洞扫描或许可兼容性结论。主项目许可和实际发布组合仍是公开前的待办。

## 根目录的第三方通知

[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)提供已有上游许可文件的导航。它不会代替各依赖原本的 LICENSE、NOTICE 或 COPYRIGHT 文件。
