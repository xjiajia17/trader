#!/bin/bash
# ========================================
# K线数据服务启动脚本
# ========================================
# 用法：
#   ./tools/start_service.sh              # 前台启动（5分钟自动刷新）
#   ./tools/start_service.sh 180          # 自定义刷新间隔（秒）
#   ./tools/start_service.sh --once       # 只更新一次后退出（适合放进 crontab）
#
# 长期历史回溯：
#   5分钟（推荐，TwelveData 现货金 XAU/USD，与金十同源、平价差）：
#     python3 tools/data_service.py --backfill-td 365         # 回溯 1 年 5m（约 7-15 分钟）
#     python3 tools/data_service.py --backfill-td 730         # 回溯 2 年 5m
#     （逐窗口即时落盘，可随时中断；再次运行会自动跳过已抓窗口，只补更早的部分）
#   5分钟（备选，币安黄金代币 PAXGUSDT，免费无需 Key，7×24 连续）：
#     python3 tools/data_service.py --backfill-5m 90          # 回溯 90 天 5m
#
# 数据来源优先级：
#   1m    金十（实时累积） ｜ 5m~4h TwelveData 现货金 ｜ 1d 新浪外盘（黄金约 20 年）
#
# 说明：
#   - 服务监听 http://127.0.0.1:8090
#   - 前端会优先读取该服务；服务未启动时自动降级到 data/*.json 静态文件
#   - 金十每日调用上限 1500 次，脚本已限制在 1350 次以内
#   - TwelveData 免费版 800 次/天、8 次/分钟，脚本已内置限速与失败拆分重试

set -e
cd "$(dirname "$0")/.."

INTERVAL="${1:-300}"

if [ "$INTERVAL" = "--once" ]; then
    echo ">>> 单次更新模式"
    exec python3 tools/data_service.py --once
fi

echo ">>> 启动数据服务（自动刷新间隔 ${INTERVAL}s）"
echo ">>> API: http://127.0.0.1:8090/api/all?symbol=XAUUSD"
exec python3 tools/data_service.py --port 8090 --interval "$INTERVAL"
