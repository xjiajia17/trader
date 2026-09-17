/**
 * ========================================
 * 统计与复盘 (StatsManager)
 * ========================================
 * 负责交易统计分析、收益曲线、最大回撤等
 */

const StatsManager = (function() {
    'use strict';

    // 统计数据
    let stats = {
        totalTrades: 0,
        winCount: 0,
        lossCount: 0,
        winRate: 0,
        totalProfit: 0,
        totalLoss: 0,
        profitFactor: 0,
        maxWinStreak: 0,
        maxLoseStreak: 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalPnL: 0,
        totalPnLPercent: 0,
        equityCurve: []
    };

    // 收益曲线图表
    let equityChart = null;
    let equitySeries = null;
    let equityChartEl = null;

    /**
     * 初始化
     */
    function init(chartContainerId) {
        if (chartContainerId) {
            equityChartEl = document.getElementById(chartContainerId);
            if (equityChartEl) {
                createEquityChart();
            }
        }
        reset();
    }

    /**
     * 创建收益曲线图表
     */
    function createEquityChart() {
        if (typeof LightweightCharts === 'undefined') {
            console.warn('[StatsManager] lightweight-charts 未加载，跳过收益曲线图表');
            return;
        }

        equityChart = LightweightCharts.createChart(equityChartEl, {
            layout: {
                backgroundColor: 'transparent',
                textColor: '#848e9c',
                fontSize: 9
            },
            grid: {
                vertLines: { visible: false },
                horzLines: { visible: false }
            },
            rightPriceScale: {
                borderVisible: false,
                scaleMargins: {
                    top: 0.1,
                    bottom: 0.1
                }
            },
            timeScale: {
                borderVisible: false,
                timeVisible: false,
                secondsVisible: false
            },
            crosshair: {
                mode: LightweightCharts.CrosshairMode.Magnet,
                vertLine: { visible: false },
                horzLine: { visible: false }
            },
            handleScroll: {
                mouseWheel: false,
                pressedMouseMove: false,
                horzTouchDrag: false,
                vertTouchDrag: false
            },
            handleScale: {
                mouseWheel: false,
                pinch: false,
                axisPressedMouseMove: false
            }
        });

        equitySeries = equityChart.addAreaSeries({
            lineColor: '#2962ff',
            topColor: 'rgba(41, 98, 255, 0.4)',
            bottomColor: 'rgba(41, 98, 255, 0.05)',
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false
        });

        // 响应式
        const resizeObserver = new ResizeObserver(() => {
            if (equityChart && equityChartEl) {
                equityChart.applyOptions({
                    width: equityChartEl.clientWidth,
                    height: equityChartEl.clientHeight
                });
            }
        });
        resizeObserver.observe(equityChartEl);
    }

    /**
     * 重置统计
     */
    function reset() {
        stats = {
            totalTrades: 0,
            winCount: 0,
            lossCount: 0,
            winRate: 0,
            totalProfit: 0,
            totalLoss: 0,
            profitFactor: 0,
            maxWinStreak: 0,
            maxLoseStreak: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalPnL: 0,
            totalPnLPercent: 0,
            equityCurve: []
        };

        if (equitySeries) {
            equitySeries.setData([]);
        }
    }

    /**
     * 根据交易历史计算统计数据
     */
    function calculate(tradeHistory, initialBalance) {
        if (!tradeHistory || tradeHistory.length === 0) {
            reset();
            stats.totalPnL = 0;
            stats.totalPnLPercent = 0;
            return stats;
        }

        stats.totalTrades = tradeHistory.length;

        // 计算盈亏统计
        let winCount = 0;
        let lossCount = 0;
        let totalProfit = 0;
        let totalLoss = 0;
        let currentWinStreak = 0;
        let currentLoseStreak = 0;
        let maxWinStreak = 0;
        let maxLoseStreak = 0;

        // 收益曲线
        const equityCurve = [];
        let currentEquity = initialBalance;
        let peakEquity = initialBalance;
        let maxDrawdown = 0;
        let maxDrawdownPercent = 0;

        // 初始点
        equityCurve.push({
            time: 0,
            value: initialBalance
        });

        tradeHistory.forEach((trade, index) => {
            currentEquity += trade.pnl;

            // 收益曲线数据
            equityCurve.push({
                time: index + 1,
                value: currentEquity
            });

            // 最大回撤计算
            if (currentEquity > peakEquity) {
                peakEquity = currentEquity;
            }
            const drawdown = peakEquity - currentEquity;
            const drawdownPercent = (drawdown / peakEquity) * 100;
            if (drawdown > maxDrawdown) {
                maxDrawdown = drawdown;
            }
            if (drawdownPercent > maxDrawdownPercent) {
                maxDrawdownPercent = drawdownPercent;
            }

            // 胜负统计
            if (trade.pnl > 0) {
                winCount++;
                totalProfit += trade.pnl;
                currentWinStreak++;
                currentLoseStreak = 0;
                if (currentWinStreak > maxWinStreak) {
                    maxWinStreak = currentWinStreak;
                }
            } else {
                lossCount++;
                totalLoss += Math.abs(trade.pnl);
                currentLoseStreak++;
                currentWinStreak = 0;
                if (currentLoseStreak > maxLoseStreak) {
                    maxLoseStreak = currentLoseStreak;
                }
            }
        });

        stats.winCount = winCount;
        stats.lossCount = lossCount;
        stats.winRate = stats.totalTrades > 0 ? (winCount / stats.totalTrades) * 100 : 0;
        stats.totalProfit = totalProfit;
        stats.totalLoss = totalLoss;
        stats.profitFactor = totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? Infinity : 0);
        stats.maxWinStreak = maxWinStreak;
        stats.maxLoseStreak = maxLoseStreak;
        stats.maxDrawdown = maxDrawdown;
        stats.maxDrawdownPercent = maxDrawdownPercent;
        stats.totalPnL = currentEquity - initialBalance;
        stats.totalPnLPercent = ((currentEquity - initialBalance) / initialBalance) * 100;
        stats.equityCurve = equityCurve;

        // 更新图表
        if (equitySeries && equityCurve.length > 1) {
            equitySeries.setData(equityCurve);
            equityChart.timeScale().fitContent();
        }

        return stats;
    }

    /**
     * 添加一笔交易并更新统计
     */
    function addTrade(trade, initialBalance, tradeHistory) {
        return calculate(tradeHistory, initialBalance);
    }

    /**
     * 获取统计数据
     */
    function getStats() {
        return stats;
    }

    /**
     * 格式化数字
     */
    function formatNumber(num, decimals = 2) {
        if (num === null || num === undefined || isNaN(num)) return '0';
        return num.toLocaleString('en-US', {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals
        });
    }

    /**
     * 格式化百分比
     */
    function formatPercent(num, decimals = 2) {
        if (num === null || num === undefined || isNaN(num)) return '0%';
        return num.toFixed(decimals) + '%';
    }

    /**
     * 格式化货币
     */
    function formatCurrency(num, decimals = 2) {
        if (num === null || num === undefined || isNaN(num)) return '$0.00';
        const sign = num < 0 ? '-' : '';
        return sign + '$' + Math.abs(num).toLocaleString('en-US', {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals
        });
    }

    // 公开接口
    return {
        init,
        calculate,
        addTrade,
        getStats,
        reset,
        formatNumber,
        formatPercent,
        formatCurrency
    };
})();
