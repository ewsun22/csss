# Codex Sleep State Sugar

这是一个适用于 Shadowrocket 的 JavaScript 模块，用于观察并管理 Codex Responses 请求中的 turn-state：

- 从成功的 HTTP 200 Responses 响应中校验并采集 292 字符、10 块的 state。
- 按账号与模型隔离缓存，在后续 GPT-6 Astra 请求中复用。
- TTL 默认 60 分钟，剩余 10 分钟时提前续期；单次探针失败会进入冷却，避免循环请求。
- 连续两次观察到上游 state 与注入值不一致时，强制下一次请求重新采集。
- 采集结果通过 Shadowrocket 日志和通知观察。

项目只处理本机代理流量，不上传账号信息、请求正文、提示词、回答或完整 state。

## 安装

在 Shadowrocket 中添加模块 URL：

```text
https://raw.githubusercontent.com/ewsun22/csss/main/codex-state-shadowrocket.srmodule
```

启用模块，并在 Shadowrocket 的 MITM 设置中为 `chatgpt.com`、`api.openai.com` 安装并信任证书。确认 Codex/ChatGPT 请求经过 Shadowrocket 的当前规则和 VLESS 出口。

首次请求没有缓存时，脚本会用当前请求的认证头发起一次短探针；通过 292 字符、10 块和有效期校验后，缓存会写入 Shadowrocket 的持久化存储。后续请求会在有效期内注入 `x-codex-turn-state`，接近过期时自动续期。

## 配置

模块默认使用 `force_http=0`，不会主动中断 WebSocket。只有确认客户端需要 HTTP fallback 时，才把模块两处参数都改成 `force_http=1`；主动中断 WebSocket 可能触发连接错误。

脚本使用独立缓存键 `codex-turn-state-shadowrocket-v1`。清理缓存时只删除这个键。

## 工作原理

请求脚本只匹配 Responses HTTP/SSE 接口。若当前模型是 GPT-6 Astra 且没有可用 state，脚本会使用当前请求的认证头发起一次短探针；探针响应必须是 HTTP 200、完整 SSE，并通过 state 封装和 10 块校验，才会写入 Shadowrocket 持久化存储。

后续匹配请求会在发送前把缓存值写入 `x-codex-turn-state`。响应脚本会再次观察上游 state：若连续两次与注入值不一致，就让下一条请求重新采集。401、403、429 和网络失败会按状态进入冷却或等待，不会自动重放正式生成请求。

这套机制只能保持请求参数的一致性，不能保证模型质量、账号额度、服务端路由或任何特定回答。292/10 块是经验校验规则，不是 OpenAI 公布的质量指标。

## 常见问题

### 一直没有采集到 state

检查脚本、MITM、证书和 Responses 请求是否经过 Shadowrocket，并确认当前模型和请求路径匹配。首次探针可能因网络、429、账号状态或上游响应形状不合格而失败。

### 出现 429

脚本会读取 `Retry-After` 并进入冷却。不要连续手动刷新或重复发送测试请求，等待冷却结束后再观察日志。

### 如何清除缓存

在 Shadowrocket 的脚本持久化存储中删除 `codex-turn-state-shadowrocket-v1`，或在脚本编辑器中清空对应存储后重新加载模块。

## 安全与隐私

该脚本会在本机读取匹配请求的认证头来完成官方 OpenAI 探针，不会把账号、提示词、回答或完整 state 上传到第三方服务器。MITM 和远程脚本本身具有读取流量的能力，请只使用你信任的代码源。

公开仓库不包含节点名称、代理地址、账号 ID、Authorization、Cookie、订阅 URL、脚本持久化数据或本机路径。请不要在 Issue、截图或日志中粘贴完整请求头、订阅链接或 turn-state。

## 引用与致谢

- [292 State 研究文章](https://blog.caowo.de/posts/chatgpt-codex-292-state-anti-degradation-2026/)
- [gylive/ccodex-sleep-state](https://github.com/gylive/ccodex-sleep-state)：感谢其对 state 生命周期、探针、TTL 和诊断体验的公开讨论。

本项目与 OpenAI、上述作者或仓库没有隶属关系。

## 许可证

MIT，见 [LICENSE](LICENSE)。

## 本地自检

需要 Node.js 18 或更高版本：

```sh
node test-codex-state-shadowrocket.js
```
