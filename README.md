# 省省花花远程配置

这个仓库每天从飞书多维表格读取已启用的优惠券，检查推广链接后生成
`docs/coupons.json`，再通过 GitHub Pages 提供给 iOS App。

## 日常使用

只需在飞书的「优惠券配置表」更新内容。GitHub Actions 每天北京时间
04:15 自动同步，也可以在 Actions 页面手动运行 `同步优惠券配置`。

## GitHub Secrets

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_BITABLE_APP_TOKEN`
- `FEISHU_BITABLE_TABLE_ID`

密钥只供 GitHub Actions 读取，不会写入公开的 JSON。
