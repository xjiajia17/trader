# K线回放训练 · Kline Replay

> 基于历史 K 线数据的模拟交易复盘训练工具——在真实行情中练习你的交易决策，不花一分钱学费。

![Tech](https://img.shields.io/badge/HTML5-E34F26?logo=html5&logoColor=white)
![Tech](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black)
![Tech](https://img.shields.io/badge/Python-3776B5?logo=python&logoColor=white)
![Tech](https://img.shields.io/badge/Lightweight%20Charts-2962FF?logo=tradingview&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## 这是什么？

Kline Replay 是一个**交易员复盘训练工具**。它加载真实的历史 K 线数据，像播放器一样逐根"回放"行情——你可以在任意时间点暂停、下单、设置止损止盈，然后继续播放，观察市场如何走出后续走势。

它不是回测框架，不跑策略；它是**给人用的**——让你在无风险环境中反复磨炼盘感、验证交易计划、积累交易心理经验。

```
┌──────────────────────────────────────────────────────┐
│  ▶ 播放历史K线 → 看到价格 → 做出决策 → 下单 → 继续看走势  │
│                                                     │
│  每一笔交易都被记录：胜率、盈亏比、最大回撤、收益曲线      │
└──────────────────────────────────────────────────────┘
```

## 功能特性

### 回放控制

- 逐根 K 线播放 / 暂停，速度可调 **0.5s ~ 5s**
- ⏪ 上一根 / ⏩ 下一根，单步精修
- 底部进度条拖拽，跳到任意时间点
- 跟随最新 K 线开关（拖动图表后自动暂停跟随）
- 一键重置回到起点

### 支持品种与周期

| 品种 | 代码 | 日线历史 |
|------|------|---------|
| 现货黄金 | XAUUSD | 2006 年起（约 20 年） |
| WTI 原油 | USOIL | 约 10 年 |
| 美元/日元 | USDJPY | 金十逐分钟累积 |
| 欧元/美元 | EURUSD | 金十逐分钟累积 |

周期覆盖 **1m / 5m / 15m / 30m / 1h / 4h / 1d** 共 7 档。

### 模拟交易

- **订单类型**：市价单 / 限价单 / 止损单
- **方向**：做多 / 做空
- **仓位**：手数（lots）或金额（USD）两种输入模式
- **杠杆**：1x ~ 1000x 可调
- **止损止盈**：按百分比设置，或直接在图表上拖拽 SL / TP 标签
- **右键快捷下单**：在图表任意位置右键，一键挂限价/止损单
- **持仓可视化**：入场价、SL、TP 在图表上以标签线展示，可拖动调整

### 技术指标

- **EMA 均线**：5 / 10 / 20 / 60，四条独立开关
- **Stochastic 随机指标**：%K / %D 参数可调

### 图表画线工具

趋势线 · 水平线 · 垂直线 · 矩形 · 斐波那契回撤
- 选中删除 / 一键清空

### 统计分析

- 总交易数 · 胜率 · 盈亏比（Profit Factor）
- 最大回撤 · 最大连胜 · 最大连败
- 实时收益曲线
- 完整交易历史记录表

### 账户模拟

- 初始资金 $10,000（可在代码中修改）
- 实时计算余额、可用保证金、已用保证金、浮动盈亏

---

## 快速开始

### 环境要求

- Python 3.7+（仅标准库，无需 pip install）
- 现代浏览器（Chrome / Edge / Safari）

### 启动步骤

```bash
# 1. 克隆仓库
git clone https://github.com/xjiajia17/trader.git kline-replay
cd kline-replay

# 2. 启动数据服务（推荐，提供实时数据刷新）
python3 tools/data_service.py
# → 数据服务运行在 http://127.0.0.1:8090

# 3. 在另一个终端启动静态文件服务
python3 -m http.server 8080
# → 前端运行在 http://127.0.0.1:8080
```

打开浏览器访问 `http://127.0.0.1:8080` 即可开始使用。

> **不需要数据服务也能用**：前端会自动降级读取 `data/*.json` 静态文件，开箱即用。启动数据服务后才能获取最新行情。

### 一键启动脚本

```bash
# 前台启动，5分钟自动刷新数据
./tools/start_service.sh

# 自定义刷新间隔（秒）
./tools/start_service.sh 180

# 只更新一次数据（适合 crontab）
./tools/start_service.sh --once
```

---

## 技术架构

```
kline-replay/
├── index.html              # 主页面
├── css/
│   └── style.css           # 全部样式（暗色主题）
├── js/
│   ├── app.js              # 应用入口、事件绑定、状态管理
│   ├── chart.js            # 图表封装（基于 lightweight-charts）
│   ├── data.js             # 数据加载与缓存
│   ├── replay.js           # K线回放引擎
│   ├── trading.js          # 模拟交易引擎（订单/仓位/盈亏计算）
│   ├── stats.js            # 统计计算与收益曲线
│   ├── draw.js             # 画线工具
│   └── lib/
│       └── lightweight-charts.js  # TradingView 图表库
├── data/                   # 前端直接读取的 K 线数据（JSON）
│   ├── XAUUSD_1m.json
│   ├── XAUUSD_5m.json
│   ├── ...
│   └── store/              # Python 服务累积的原始数据
├── tools/
│   ├── data_service.py      # Python 数据服务（HTTP API）
│   └── start_service.sh    # 启动脚本
└── fetch_data.py            # 金十数据获取工具（独立脚本）
```

### 前端

纯原生 JavaScript，无框架、无构建步骤。图表使用 [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts)。

### 数据服务（Python）

`data_service.py` 基于 Python 标准库 `http.server`，零第三方依赖，提供：

| API | 说明 |
|-----|------|
| `GET /api/health` | 健康检查与配额统计 |
| `GET /api/info?symbol=XAUUSD` | 数据元信息（根数/时间范围/缺口） |
| `GET /api/klines?symbol=XAUUSD&tf=1m` | 指定周期 K 线 |
| `GET /api/all?symbol=XAUUSD` | 全部周期一次返回 |
| `POST /api/refresh` | 立即刷新数据 |
| `POST /api/backfill?hours=24` | 回溯补齐近期数据 |

---

## 数据来源

| 周期 | 来源 | 说明 |
|------|------|------|
| 1m | 金十数据 | 唯一实时源，逐分钟累积 |
| 5m ~ 4h | TwelveData + 金十聚合 | 长期历史为底，最新数据覆盖 |
| 1d | 新浪外盘 | 黄金可回溯至 2006 年（约 20 年） |
| 5m 长期补全 | 币安 PAXG/XAUT | 1:1 实物黄金背书代币，免费无需 Key |

> 金十数据每日调用限额 1500 次，服务端已限制在 1350 次以内。

---

## 使用技巧

1. **从日线开始**：先切到 1d 周期浏览长期走势，建立大局观，再切到小周期找入场点。
2. **用画线工具标记关键位**：趋势线、水平线、斐波那契回撤——这些标记会跟随回放保留。
3. **设置止损止盈**：不要裸单。按百分比或图表拖拽设置 SL/TP，养成风险控制习惯。
4. **记录交易日志**：每笔交易的开平仓都被自动记录，训练结束后回看统计面板，找出自己的薄弱环节。
5. **慢就是快**：用 2s~5s 的速度播放，给自己足够时间思考，而不是机械地点下一步。

---

## 免责声明

本工具仅供学习和训练使用，不构成任何投资建议。市场有风险，交易需谨慎。所有模拟交易均为虚拟资金，不涉及真实交易。

---

## License

MIT
