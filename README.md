# Magpie Budget 离线插件 0.3.0

这是给已有 Magpie 安装的插件，包含 AntSeed、FreeLLMAPI 核心与 Kilo 接入。插件复用 Magpie 自带的 Bun，不包含另一份 Magpie、Node、前端或模型权重。安装时不运行 npm、不下载核心依赖；调用远程模型仍需要联网。

## 安装

1. 解压到固定目录，保留整个 `magpie-budget-plugin` 文件夹。
2. 在 Magpie 的插件页面添加该目录，或使用已有的 Magpie 命令：

   ```sh
   magpie plugin add "/absolute/path/magpie-budget-plugin"
   ```

3. 在原有路由组中选择新增模型。Kilo 注册为 `budget-kilo/kilo-auto/free`；配置并验证可用后，FreeLLMAPI 与 AntSeed 模型分别出现在 `budget-free`、`budget-antseed` 下。本地占位账号会自动建立，不需要另起服务器。

插件路径会被 Magpie 持续使用，安装后不要删除或移动解压目录。Magpie 首次使用任何插件时可能会自行准备 Bun；这是宿主的通用插件运行时，本包复用已经存在的运行时。

## 配置

首次加载自动生成 `config.json`：

| 系统 | 默认位置 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\MagpieBudget\config.json` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/magpie-budget/config.json` |

FreeLLMAPI 核心已内置，但模型需要有效额度、提供方密钥或你自己的端点。以下示例接入一个已有的兼容端点；将 URL、密钥和模型名改成你的实际值：

```json
{
  "version": 1,
  "free": {
    "enabled": true,
    "probeOnStart": true,
    "config": {
      "customProviders": [{
        "baseUrl": "http://127.0.0.1:8080/v1",
        "apiKey": "your-existing-key",
        "models": [{"model": "your-model", "supportsTools": true}]
      }]
    }
  },
  "antseed": {"enabled": false},
  "kilo": {"enabled": true}
}
```

AntSeed 默认关闭。启用时需设置 `antseed.enabled: true`，并提供 `antseed.router.maxPricing.defaults.inputUsdPerMillion` 与 `outputUsdPerMillion` 的价格上限；按 AntSeed 的正常钱包与付款流程准备资金。插件不会替你免除上游费用。配置变更后重新启动核心或退出并重开 Magpie。

你已在 Magpie 配置的低价模型继续保留，可与新增模型放入同一个原生路由组。FreeLLMAPI 仅上报已就绪的模型；`auto` 有可用模型池后才出现。

## 自动建立组合路由（可选）

`bin/cli.mjs` 可通过已有 Bun 调用已有 Magpie，建立 `group/magpie-budget`。`--own` 接受你的 `provider/model` 或 `group/id`，会保留既有分组和凭证：

```sh
"<existing-Bun-path>" bin/cli.mjs install --magpie "<existing-Magpie-path>" --own "group/my-cheap-models"
```

同一工具支持 `upgrade`、`status`、`restart`、`stop`、`uninstall`。自定义或受限制的配置目录可用 `--config-dir` 指定；核心数据目录可用 `--state` 指定。升级与卸载会等待核心停止；卸载保留数据库、密钥和身份。你编辑过的组合路由不会被工具覆盖或删除。

## 范围和验证

- 包含 Windows x64 与 Linux x64 的必要 WebRTC 原生模块。其它平台尚未打包。
- 核心以插件管理的本地进程运行：随机回环端口、私有令牌，多宿主共用；最后一个宿主退出后自动停止，并能在核心崩溃后重启。
- 图片原样转发，省略可选的 sharp 原生图片缩放模块。
- Kilo 只接入 `kilo-auto/free`，不向上游发送本地占位凭证。可用性和额度由上游决定。
- Linux 的原版 Magpie、官方 Bun、真实核心与本地推理验收结果见 `ACCEPTANCE.md`。Windows 原生文件已校验，但未在 Windows 实机执行。

GPL-3.0 对应源码在 `source.tar.gz`；上游版本、原生文件来源与哈希分别在 `upstream-pins.json`、`native-artifacts.json`。附带测试与许可证。
