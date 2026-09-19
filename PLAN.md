# 计划

## 当前需求：Shadowrocket 提示栏通知

- [x] 收到有效 state 后继续沿用现有校验和缓存流程，采集成功通知显示实际有效期。
- [x] 每次使用缓存注入时发送“292 打票成功”通知，正文说明注入的 state 长度。
- [x] 探针及正式响应收到 312 时提示“收到 312，请注意”；补充其他异常 state、401/403、429、网络和探针失败提醒。
- [x] 无可用缓存时提示本次未注入；通知不可用或抛错不影响请求。
- [x] 更新说明，通过模拟 Shadowrocket 运行时验证通知、请求透传及缓存行为。

验证结果：`node test-codex-state-shadowrocket.js` 和 `node --check codex-state-shadowrocket.js` 均通过。尚未在真实 Shadowrocket 设备上验证系统横幅。

## 提交与推送

- [x] 检查变更范围并重新运行本地测试。
- [ ] 将通知功能、说明和测试提交至 main 并推送 origin。
