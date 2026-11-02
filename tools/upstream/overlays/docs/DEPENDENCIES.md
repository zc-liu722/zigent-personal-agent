# 第三方依赖声明盘点

从锁文件读取实际版本；npm 使用锁文件中的许可声明，Python/Rust 使用精确版本的公开注册表元数据。

这是声明盘点，不是完整二进制 SBOM 或法律放行。平台可选包、开发依赖和不同锁文件中的重复项分别记录；未声明的许可与带有分发条件的声明均需要继续核对。

| 生态 | 依赖条目 |
| --- | ---: |
| cargo | 63 |
| npm | 340 |
| pypi | 25 |

未取得许可表达式：**1** 条。注册表核对日期：2026-11-02。

## 需要额外核对的声明

| 依赖 | 版本 | 声明或状态 | 范围 |
| --- | --- | --- | --- |
| jszip | 3.10.2 | (MIT OR GPL-3.0-or-later) | npm |
| @img/sharp-libvips-darwin-arm64 | 1.3.4 | LGPL-3.0-or-later | npm |
| @img/sharp-libvips-darwin-x64 | 1.3.4 | LGPL-3.0-or-later | npm |
| @img/sharp-libvips-linux-arm | 1.3.4 | LGPL-3.0-or-later | npm |
| @img/sharp-libvips-linux-arm64 | 1.3.4 | LGPL-3.0-or-later | npm |
| @img/sharp-libvips-linux-ppc64 | 1.3.4 | LGPL-3.0-or-later | npm |
| @img/sharp-libvips-linux-riscv64 | 1.3.4 | LGPL-3.0-or-later | npm |
| @img/sharp-libvips-linux-s390x | 1.3.4 | LGPL-3.0-or-later | npm |
| @img/sharp-libvips-linux-x64 | 1.3.4 | LGPL-3.0-or-later | npm |
| @img/sharp-libvips-linuxmusl-arm64 | 1.3.4 | LGPL-3.0-or-later | npm |
| @img/sharp-libvips-linuxmusl-x64 | 1.3.4 | LGPL-3.0-or-later | npm |
| @img/sharp-wasm32 | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later AND MIT | npm |
| @img/sharp-win32-arm64 | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later | npm |
| @img/sharp-win32-ia32 | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later | npm |
| @img/sharp-win32-x64 | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later | npm |
| pdfplumber | 0.11.10 | 未取得表达式（retrieved） | pypi |
| PyMuPDF | 1.28.2 | Dual Licensed - GNU AFFERO GPL 3.0 or Artifex Commercial License | pypi |

## 审核与维护

- 完整条目、元数据来源和锁文件哈希见 [dependency-inventory.json](dependency-inventory.json)。
- 根项目许可证、PyMuPDF、libvips、原生依赖、字体与预构建产物见 [许可证决策说明](LICENSING.md)。
- 更新锁文件后运行 `python3 tools/license-inventory.py --refresh-registry`；不加参数会保留已有精确版本的注册表结果，新增版本会标记为待核对。
- 本脚本不安装依赖，不读取账号凭据，也不自动修改任何许可证。
