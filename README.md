# Codex Sleep State Sugar

这是一个 Surge Mac 模块和 JavaScript 脚本，用于观察并管理 Codex Responses 请求中的 turn-state：

- 从成功的 HTTP 200 Responses 响应中校验并采集 292 字符、10 块的 state。
- 按账号与模型隔离缓存，在后续 GPT-6 Astra 请求中复用。
- TTL 默认 60 分钟，剩余 10 分钟时提前续期；单次探针失败会进入冷却，避免循环请求。
- 连续两次观察到上游 state 与注入值不一致时，强制下一次请求重新采集。
- Surge 原生面板显示当前是否会注入、TTL、最近探针、注入次数和最近 6 条记录。
- 捕获成功时发送本地 Surge 通知。

项目只处理本机 Surge 流量，不上传账号信息、请求正文、提示词、回答或完整 state。缓存由 Surge 的脚本持久化存储管理。

## 一键导入

点击下面的链接，或将链接复制到浏览器地址栏：

[一键导入 Surge 模块](surge:///install-module?url=https%3A%2F%2Fraw.githubusercontent.com%2Ftzf1003%2Fcsss%2Fmain%2Fcodex-state.sgmodule)

直接导入地址：

```text
https://raw.githubusercontent.com/tzf1003/csss/main/codex-state.sgmodule
```

导入后在 Surge 的「模块 → 未分类」中启用 `Codex Sleep State Sugar`。模块使用 GitHub Raw 地址加载脚本，并每天检查一次脚本更新。

## 完整配置教程

### 1. 准备 Surge

使用 Surge Mac，并确保当前配置本来就能访问 ChatGPT/Codex。先确认：

1. Surge 已打开并正在接管流量。
2. 「增强模式」已开启。
3. 「脚本」已开启。
4. 「MITM」已开启，并已为 `chatgpt.com`、`api.openai.com` 安装并信任 Surge 证书。
5. 现有规则能把 Codex 请求送到可用出口。

模块默认不写入任何私人节点名，也不覆盖你的代理规则。它会沿用 Surge 当前规则选择出口。

### 2. 导入并启用

打开一键链接后，进入 Surge「设置 → 模块 → 未分类」，选中 `Codex Sleep State Sugar`，勾选「启用」并应用。

如果网络无法访问 GitHub Raw，可以下载 `codex-state.js` 到本地，并把三处 `script-path` 改成本地绝对路径。

### 3. 固定探针出口（可选）

公开模块默认让 Surge 的规则决定出口。如果你希望探针和 Codex 请求固定到某个已有策略，编辑模块中三处 `argument=`，加入 URL 编码后的参数：

```text
policy=YOUR_EXISTING_SURGE_POLICY
```

例如策略名含空格时，使用 `%20`；不要把代理账号、密码、订阅 URL 或节点 URI 提交到 GitHub。

### 4. 打开状态面板

在 macOS 菜单栏点击 Surge 图标，打开「面板 → Codex 292 状态」。面板含义如下：

| 面板标题 | 含义 |
| --- | --- |
| `等待采集` | 当前没有可复用的合格 state；下一条匹配请求会先尝试采集 |
| `正在复用` | 当前请求会注入缓存中的 292；面板会显示 TTL 和续期时间 |
| `正在采集` | 探针正在运行，当前请求暂不使用旧值 |

最近记录会标注探针结果、请求是否注入、响应 state 长度和会话尾部标识。记录不保存提示词、回答或完整 token。

### 5. 验证流程

建议先打开面板，再在 Codex 中新建会话发送一条普通短消息。随后刷新面板：

1. 首次没有缓存时，状态应变为「正在采集」或显示探针结果。
2. 成功采集后，状态应显示「正在复用」和剩余 TTL。
3. 再开一个新会话，面板历史应出现「已注入 292」。
4. TTL 接近续期阈值时，下一条请求会先探测新值。

面板状态是流量处理的证据；模型回答内容可以作为你自己的业务验收信号，但不能单凭回答文本证明服务端内部路由实现。

## 工作原理

请求脚本只匹配 Responses HTTP/SSE 接口。若当前模型是 GPT-6 Astra 且没有可用 state，脚本会使用当前请求的认证头发起一次短探针；探针响应必须是 HTTP 200、完整 SSE，并通过 state 封装和 10 块校验，才会写入 Surge 持久化存储。

后续匹配请求会在发送前把缓存值写入 `x-codex-turn-state`。响应脚本会再次观察上游 state：若连续两次与注入值不一致，就让下一条请求重新采集。401、403、429 和网络失败会按状态进入冷却或等待，不会自动重放正式生成请求。

这套机制只能保持请求参数的一致性，不能保证模型质量、账号额度、服务端路由或任何特定回答。292/10 块是经验校验规则，不是 OpenAI 公布的质量指标。

## 常见问题

### 面板一直是「等待采集」

检查脚本、MITM、证书和 Responses 请求是否经过 Surge；确认当前模型和请求路径匹配。首次探针可能因网络、429、账号状态或上游响应形状不合格而失败。

### 出现 429

脚本会读取 `Retry-After` 并进入冷却。不要连续手动刷新或重复发送测试请求，等待冷却结束后再观察面板。

### 只想关闭注入

在 Surge 模块设置中停用模块即可；也可以只关闭脚本，保留普通代理规则。

### 如何清除缓存

在 Surge 的脚本持久化存储中删除 `codex-turn-state-v5`，或在脚本编辑器中清空对应存储后重新加载模块。删除前请确认你没有其他脚本共用该键名。

## 给 Agent 的一键配置提示词

完整可复制提示词见 [AGENT_PROMPT.md](AGENT_PROMPT.md)。它要求 Agent 自动导入模块、检查增强模式/脚本/MITM、打开面板并汇报结果，同时禁止输出账号、订阅、Cookie、Authorization 和完整 state。

## 安全与隐私

公开仓库不包含节点名称、代理地址、账号 ID、Authorization、Cookie、订阅 URL、脚本持久化数据或本机路径。使用者应把策略名和代理凭据留在本地 Surge 配置中。请不要在 Issue、截图或日志中粘贴完整请求头、订阅链接或 turn-state。

## 引用与致谢

- [Surge Information Panel 文档](https://manual.nssurge.com/tools/panel.html)
- [Surge Generic Script 文档](https://manual.nssurge.com/scripting/generic.html)
- [Surge Scripting API](https://manual.nssurge.com/scripting/api.html)
- [292 State 研究文章](https://blog.caowo.de/posts/chatgpt-codex-292-state-anti-degradation-2026/)
- [gylive/ccodex-sleep-state](https://github.com/gylive/ccodex-sleep-state)：感谢其对 state 生命周期、探针、TTL 和诊断体验的公开讨论；本仓库是独立的 Surge 脚本实现。

本项目与 OpenAI、Surge、上述作者或仓库没有隶属关系。

## 许可证

MIT，见 [LICENSE](LICENSE)。

## 本地自检

需要 Node.js 18 或更高版本：

```sh
node test-codex-state.js
```
