# 发布流程

本流程从 `betaV0.1` 开始执行。每一个新版本都必须同时保留 Git 记录和可直接体验的发布包，方便内部验收、用户试用和问题回溯。

## 版本落地顺序

1. 在候选分支完成开发、文档和测试。
2. 运行发布前验证：

```bash
pnpm run ci
pnpm test:postgres
pnpm package
pnpm package:verify
```

3. 将候选版本合入 `main`，并推送 `main`。
4. 从 `main` 当前提交创建版本分支，分支名必须等于版本名，例如 `betaV0.1`。
5. 创建同名 Git tag，tag 名必须等于版本名。
6. 生成发布资产并上传到 GitHub Release。

## 发布资产要求

每个版本至少提供当前构建平台上的两类资产：

- 安装包：例如 Windows 的 `DBAgent-betaV0.1-win-x64-setup.exe`。
- 解压包：例如 Windows 的 `DBAgent-betaV0.1-win-x64-unpacked.zip`。

同时必须提供 `SHA256SUMS.txt`，记录全部发布资产的 SHA256，便于用户下载后校验。

如果当前机器无法产出 macOS 或 Linux 包，该版本可以只发布 Windows 包，但版本记录中必须说明缺失平台和原因。后续进入跨平台验收阶段后，Windows、macOS、Linux 都应分别产出安装或解压资产。

## 本地资产目录

发布资产先放在仓库根目录的 `release/<version>/` 下。该目录不进入 Git 历史，只作为 GitHub Release 上传来源。

当前约定命名：

```text
release/<version>/DBAgent-<version>-win-x64-setup.exe
release/<version>/DBAgent-<version>-win-x64-unpacked.zip
release/<version>/SHA256SUMS.txt
```

## GitHub Release

GitHub Release 标题使用版本名，例如 `betaV0.1`。Release 正文应包含：

- 版本定位。
- 主要能力。
- 验证命令和结果。
- 发布资产清单。
- 已知限制。

Release 附件必须包含安装包、解压包和 `SHA256SUMS.txt`。不允许只推 tag 而没有用户可直接安装或解压体验的包。

## 身份与分支规则

本仓库后续提交使用 `Chandler Niu` 作为提交身份。不要创建带工具来源含义的开发分支名；临时开发分支应使用业务或版本语义命名。
