# Codex Sleep State Sugar：给 Agent 的一键配置提示词

将下面整段提示词交给能够操作本机 Surge 的 Agent。家宽配置默认保持策略名为空，让 Surge 按现有规则选择默认出口；只有明确需要固定出口时，才在本机填写策略名。

```text
请在这台 macOS 电脑上配置公开项目 Codex Sleep State Sugar。

目标：让 Surge 为 ChatGPT/Codex 的 Responses HTTP 流量自动采集合格的 292 字符、10 块 turn-state，在 TTL 内跨新会话复用，并在 TTL 临近时自动续期；同时提供可查看当前状态和最近历史的 Surge 面板。

操作要求：
1. 使用这个 Surge 模块 URL 导入：
   surge:///install-module?url=https%3A%2F%2Fraw.githubusercontent.com%2Ftzf1003%2Fcsss%2Fmain%2Fcodex-state.sgmodule
2. 在 Surge 的模块设置中启用「Codex Sleep State Sugar」。
3. 确认 Surge 的增强模式、脚本、MITM 已启用，并确认 chatgpt.com 与 api.openai.com 的 MITM 证书可用。
4. 家宽配置保持模块脚本参数中的 policy 为空，让 Surge 按默认规则选路；只有用户明确要求固定出口时，才将 policy 设置为用户已有的策略名。不要创建、猜测或输出任何账号、代理密码、订阅链接、Cookie、Authorization 或完整 turn-state。
5. 打开 macOS 菜单栏 Surge 图标 → 面板 →「Codex 292 状态」，确认面板可以显示当前是否会注入、TTL 和最近记录。
6. 只做一次最小化验证：检查模块是否启用、配置是否生效、面板是否可打开。除非用户明确要求，不要自动发送模型测试请求。

报告时只返回：模块启用结果、MITM/脚本/增强模式状态、面板显示内容和失败原因。所有敏感值只在本机使用，不要写入日志、截图、提交或聊天消息。
```
