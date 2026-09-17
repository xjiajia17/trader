/**
 * ========================================
 * 图表渲染引擎 (ChartManager)
 * ========================================
 * 基于 lightweight-charts v3
 * 主图：K线 + EMA均线 + 买卖标记 + 可拖动止损止盈线
 * 副图：KDJ随机震荡指标
 * 价格轴在左侧
 */

const ChartManager = (function() {
    'use strict';

    let mainChart = null;
    let kdjChart = null;
    let candlestickSeries = null;
    let emaSeries = {};
    let kdjSeries = {};
    let tradeMarkers = [];

    let mainChartEl = null;
    let kdjChartEl = null;

    let currentData = [];
    let visibleBarCount = 0;
    let followLatest = true; // 是否自动跟随最新K线（用户手动拖动图表后自动关闭）
    // 右侧预留的空白K线数：决定「能把最新K线往左拖多远」以及回放的向前视野
    const RIGHT_OFFSET = 45;
    // 用户是否正在手动控制视图（滚轮/拖拽图表）——以此判断是否该关闭自动跟随，
    // 避免被程序化滚动（每根K线自动 scrollToEnd）或滚动动画的中间态误判
    let userViewControl = false;
    let userViewReleaseTimer = null;

    // Stochastic Oscillator 参数
    let stochParams = { kPeriod: 14, dPeriod: 3 };
    let stochData = [];

    // 拖动止损止盈
    let positionLines = {};
    let pendingOrderLines = {}; // 挂单价格线 key: order_{id} / order_{id}_sl / order_{id}_tp
    let dragState = null;
    let onLineDragCallback = null;
    let rangeChangeCallbacks = []; // 可见范围变化订阅者列表
    let onFollowChangeCallback = null;
    let startPositionLine = null;

    const config = {
        upColor: '#0ecb81',
        downColor: '#f6465d',
        borderUpColor: '#0ecb81',
        borderDownColor: '#f6465d',
        wickUpColor: '#0ecb81',
        wickDownColor: '#f6465d',
        gridColor: 'rgba(42, 46, 57, 0.5)',
        textColor: '#848e9c',
        background: '#0c0d0f'
    };

    // EMA 配置
    const emaConfig = {
        EMA5:  { period: 5,  color: '#f5a623' },
        EMA10: { period: 10, color: '#e91e63' },
        EMA20: { period: 20, color: '#9c27b0' },
        EMA60: { period: 60, color: '#00bcd4' }
    };

    // 北京时间偏移（秒）：UTC+8
    const BEIJING_OFFSET = 8 * 3600;

    // 时间轴刻度格式化（北京时间，UTC+8）
    function formatTickTime(timestamp) {
        const date = new Date((timestamp + BEIJING_OFFSET) * 1000);
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');
        const hours = String(date.getUTCHours()).padStart(2, '0');
        const minutes = String(date.getUTCMinutes()).padStart(2, '0');
        return `${month}-${day} ${hours}:${minutes}`;
    }

    function init(mainContainerId, kdjContainerId) {
        mainChartEl = document.getElementById(mainContainerId);
        kdjChartEl = document.getElementById(kdjContainerId);

        if (!mainChartEl || !kdjChartEl) {
            console.error('[ChartManager] 图表容器不存在');
            return false;
        }
        if (typeof LightweightCharts === 'undefined') {
            console.error('[ChartManager] LightweightCharts 库未加载');
            return false;
        }

        createMainChart();
        createKDJChart();
        setupSync();
        setupResize();
        setupDragHandling();

        return true;
    }

    function createMainChart() {
        mainChart = LightweightCharts.createChart(mainChartEl, {
            layout: {
                backgroundColor: config.background,
                textColor: config.textColor,
                fontSize: 11
            },
            grid: {
                vertLines: { color: config.gridColor, style: 0 },
                horzLines: { color: config.gridColor, style: 0 }
            },
            crosshair: {
                mode: LightweightCharts.CrosshairMode.Normal,
                vertLine: {
                    width: 1, color: 'rgba(41, 98, 255, 0.6)', style: 2,
                    labelBackgroundColor: '#2962ff'
                },
                horzLine: {
                    width: 1, color: 'rgba(41, 98, 255, 0.6)', style: 2,
                    labelBackgroundColor: '#2962ff'
                }
            },
            // 价格轴在右侧（左侧留给标签，避免遮挡价格）
            leftPriceScale: {
                visible: false
            },
            rightPriceScale: {
                borderColor: config.gridColor,
                visible: true,
                scaleMargins: { top: 0.1, bottom: 0.1 }
            },
            timeScale: {
                borderColor: config.gridColor,
                timeVisible: true,
                secondsVisible: false,
                // 右侧预留空间：回放时可把最新K线拖到画面中间，并留出"向前"视野
                rightOffset: RIGHT_OFFSET,
                tickMarkFormatter: (time) => formatTickTime(time)
            },
            localization: {
                locale: 'zh-CN',
                timeFormatter: (time) => formatTickTime(time)
            },
            handleScroll: { vertTouchDrag: false },
            handleScale: { axisPressedMouseMove: true }
        });

        candlestickSeries = mainChart.addCandlestickSeries({
            upColor: config.upColor,
            downColor: config.downColor,
            borderUpColor: config.borderUpColor,
            borderDownColor: config.borderDownColor,
            wickUpColor: config.wickUpColor,
            wickDownColor: config.wickDownColor,
            borderVisible: true,
            priceLineVisible: false,
            lastValueVisible: false,
            priceScaleId: 'right'
        });
    }

    function createKDJChart() {
        kdjChart = LightweightCharts.createChart(kdjChartEl, {
            layout: {
                backgroundColor: config.background,
                textColor: config.textColor,
                fontSize: 10
            },
            grid: {
                vertLines: { color: config.gridColor, style: 0 },
                horzLines: { color: config.gridColor, style: 0 }
            },
            leftPriceScale: {
                borderColor: config.gridColor,
                visible: true,
                // 固定 0~100，不留边距，避免出现负数刻度（KDJ 本身范围就是 0~100）
                scaleMargins: { top: 0, bottom: 0 }
            },
            rightPriceScale: { visible: false },
            timeScale: {
                borderColor: config.gridColor,
                timeVisible: false,
                secondsVisible: false
            },
            handleScroll: { vertTouchDrag: false },
            handleScale: { axisPressedMouseMove: false },
            crosshair: {
                mode: LightweightCharts.CrosshairMode.Magnet,
                vertLine: { visible: false },
                horzLine: { visible: false }
            }
        });

        kdjSeries.K = kdjChart.addLineSeries({
            color: '#2962ff', lineWidth: 1,
            priceLineVisible: false, lastValueVisible: true,
            priceScaleId: 'left',
            // 强制坐标轴范围固定为 0~100（%K 数学上不可能为负）
            autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } })
        });
        kdjSeries.D = kdjChart.addLineSeries({
            color: '#f5a623', lineWidth: 1,
            priceLineVisible: false, lastValueVisible: true,
            priceScaleId: 'left',
            autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } })
        });
        // J线保留但不显示（Stochastic只有K和D）
        kdjSeries.J = kdjChart.addLineSeries({
            color: 'transparent', lineWidth: 0,
            priceLineVisible: false, lastValueVisible: false,
            priceScaleId: 'left',
            autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } })
        });

        // 添加20/80参考线
        kdjSeries.K.createPriceLine({
            price: 80, color: 'rgba(246, 70, 93, 0.3)',
            lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: false, title: ''
        });
        kdjSeries.K.createPriceLine({
            price: 20, color: 'rgba(14, 203, 129, 0.3)',
            lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: false, title: ''
        });
    }

    function setupSync() {
        let isSyncing = false;
        mainChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
            if (isSyncing || !range) return;
            isSyncing = true;
            kdjChart.timeScale().setVisibleLogicalRange(range);
            isSyncing = false;
            // 只有「用户手动控制视图」时才关闭自动跟随（滚动/拖拽触发）
            // 程序化滚动（每根K线 scrollToEnd）不会命中这里，因此回放不会被误判打断
            if (followLatest && userViewControl) {
                followLatest = false;
                if (onFollowChangeCallback) onFollowChangeCallback(false);
            }
            for (const cb of rangeChangeCallbacks) {
                try { cb(); } catch (err) { console.error('[ChartManager] onRangeChange 回调错误:', err); }
            }
        });
        kdjChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
            if (isSyncing || !range) return;
            isSyncing = true;
            mainChart.timeScale().setVisibleLogicalRange(range);
            isSyncing = false;
        });
    }

    function setupResize() {
        const ro = new ResizeObserver(() => {
            if (mainChart && mainChartEl) {
                mainChart.applyOptions({ width: mainChartEl.clientWidth, height: mainChartEl.clientHeight });
            }
            if (kdjChart && kdjChartEl) {
                kdjChart.applyOptions({ width: kdjChartEl.clientWidth, height: kdjChartEl.clientHeight });
            }
        });
        if (mainChartEl) ro.observe(mainChartEl);
        if (kdjChartEl) ro.observe(kdjChartEl);
    }

    // ===== EMA 计算 =====
    function calculateEMA(data, period) {
        if (data.length < period) return [];
        const k = 2 / (period + 1);
        const result = [];
        let ema = 0;
        for (let i = 0; i < period; i++) ema += data[i].close;
        ema /= period;
        result.push({ time: data[period - 1].time, value: parseFloat(ema.toFixed(6)) });
        for (let i = period; i < data.length; i++) {
            ema = data[i].close * k + ema * (1 - k);
            result.push({ time: data[i].time, value: parseFloat(ema.toFixed(6)) });
        }
        return result;
    }

    // ===== Stochastic Oscillator 计算 =====
    // %K = (C - Ln) / (Hn - Ln) * 100
    // %D = SMA(%K, dPeriod)
    function calculateStochastic(data, params) {
        const { kPeriod, dPeriod } = params;
        const result = [];
        const kValues = [];

        for (let i = 0; i < data.length; i++) {
            if (i < kPeriod - 1) continue;
            let highest = -Infinity, lowest = Infinity;
            for (let j = i - kPeriod + 1; j <= i; j++) {
                if (data[j].high > highest) highest = data[j].high;
                if (data[j].low < lowest) lowest = data[j].low;
            }
            const k = highest === lowest ? 50 : ((data[i].close - lowest) / (highest - lowest)) * 100;
            kValues.push(k);

            // %D = SMA of %K over dPeriod
            let d = null;
            if (kValues.length >= dPeriod) {
                let sum = 0;
                for (let j = kValues.length - dPeriod; j < kValues.length; j++) {
                    sum += kValues[j];
                }
                d = sum / dPeriod;
            }

            result.push({ time: data[i].time, k, d });
        }
        return result;
    }

    function updateStoch() {
        const visibleData = currentData.slice(0, visibleBarCount);
        stochData = calculateStochastic(visibleData, stochParams);
        if (kdjSeries.K) kdjSeries.K.setData(stochData.filter(d => d.k !== null).map(d => ({ time: d.time, value: d.k })));
        if (kdjSeries.D) kdjSeries.D.setData(stochData.filter(d => d.d !== null).map(d => ({ time: d.time, value: d.d })));
        // J线不再使用，清空
        if (kdjSeries.J) kdjSeries.J.setData([]);
    }

    function setStochParams(params) {
        if (params.kPeriod) stochParams.kPeriod = params.kPeriod;
        if (params.dPeriod) stochParams.dPeriod = params.dPeriod;
        updateStoch();
    }

    function getStochParams() {
        return { ...stochParams };
    }

    // ===== 数据设置 =====
    function setData(data) {
        currentData = data.slice();
        visibleBarCount = data.length;
        candlestickSeries.setData(data);
        updateAllEMA();
        updateStoch();
        clearStartPosition();
        mainChart.timeScale().fitContent();
    }

    /**
     * 标记回放起始位置（垂直线）
     */
    function markStartPosition(index) {
        clearStartPosition();
        if (index <= 0 || index >= currentData.length) return;
        const bar = currentData[index];
        if (!bar) return;
        startPositionLine = mainChart.addLineSeries({
            color: 'rgba(41, 98, 255, 0.5)',
            lineWidth: 2,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            // 与K线同一价格轴，保证垂直标记位置准确
            priceScaleId: 'right'
        });
        // 用两条相同价格的点画一条垂直线
        startPositionLine.setData([
            { time: bar.time, value: bar.low * 0.99 },
            { time: bar.time, value: bar.high * 1.01 }
        ]);
    }

    function clearStartPosition() {
        if (startPositionLine) {
            mainChart.removeSeries(startPositionLine);
            startPositionLine = null;
        }
    }

    function updateAllEMA() {
        for (const [name, cfg] of Object.entries(emaConfig)) {
            if (emaSeries[name]) {
                const emaData = calculateEMA(currentData.slice(0, visibleBarCount), cfg.period);
                emaSeries[name].setData(emaData);
            }
        }
    }

    function toggleEMA(name, show) {
        if (!emaConfig[name]) return;
        if (show && !emaSeries[name]) {
            emaSeries[name] = mainChart.addLineSeries({
                color: emaConfig[name].color,
                lineWidth: 1,
                priceLineVisible: false,
                lastValueVisible: false,
                // 必须与K线同一价格轴（right），否则两者独立缩放会造成均线不贴合价格
                priceScaleId: 'right'
            });
            const emaData = calculateEMA(currentData.slice(0, visibleBarCount), emaConfig[name].period);
            emaSeries[name].setData(emaData);
        } else if (!show && emaSeries[name]) {
            mainChart.removeSeries(emaSeries[name]);
            delete emaSeries[name];
        }
    }

    function setVisibleBars(count) {
        if (count < 0) count = 0;
        if (count > currentData.length) count = currentData.length;
        visibleBarCount = count;
        clearStartPosition();

        if (count === 0) {
            candlestickSeries.setData([]);
            for (const name of Object.keys(emaSeries)) emaSeries[name].setData([]);
            updateStoch();
            updateMarkers();
            return;
        }

        candlestickSeries.setData(currentData.slice(0, count));
        updateAllEMA();
        updateStoch();
        updateMarkers();
    }

    function addBar(bar) {
        // 防御：忽略非法K线，避免污染序列（时间必须是 Unix 秒时间戳）
        if (!bar || typeof bar.time !== 'number' || !isFinite(bar.time)) return;
        currentData[visibleBarCount] = { ...bar };
        visibleBarCount++;
        candlestickSeries.update(bar);

        // 更新EMA
        for (const [name, cfg] of Object.entries(emaConfig)) {
            if (emaSeries[name] && visibleBarCount >= cfg.period) {
                const emaData = calculateEMA(currentData.slice(0, visibleBarCount), cfg.period);
                if (emaData.length > 0) {
                    emaSeries[name].update(emaData[emaData.length - 1]);
                }
            }
        }

        // 更新KDJ
        updateStoch();
        updateMarkers();
        if (followLatest) scrollToEnd();
    }

    function setFollowLatest(flag) {
        followLatest = !!flag;
        if (followLatest) {
            // 先清掉「用户正在控制视图」标记，避免随后的 scrollToEnd 又被判定为用户操作
            userViewControl = false;
            if (userViewReleaseTimer) {
                clearTimeout(userViewReleaseTimer);
                userViewReleaseTimer = null;
            }
            scrollToEnd();
        }
    }

    function getFollowLatest() {
        return followLatest;
    }

    // ===== 买卖标记 =====
    function addTradeMarker(marker) {
        tradeMarkers.push(marker);
        updateMarkers();
    }

    function clearTradeMarkers() {
        tradeMarkers = [];
        updateMarkers();
    }

    function updateMarkers() {
        const visibleMarkers = tradeMarkers.filter(m => m.barIndex < visibleBarCount);
        const markers = visibleMarkers.map(m => ({
            time: currentData[m.barIndex]?.time || m.time,
            position: m.side === 'buy' ? 'belowBar' : 'aboveBar',
            color: m.side === 'buy' ? '#0ecb81' : '#f6465d',
            shape: m.side === 'buy' ? 'arrowUp' : 'arrowDown',
            text: m.text || (m.side === 'buy' ? 'B' : 'S'),
            size: 2
        }));
        candlestickSeries.setMarkers(markers);
    }

    // ===== 可拖动止损止盈线 =====
    function setPositionLines(entryPrice, stopLoss, takeProfit, side) {
        clearPositionLines();
        if (!entryPrice) return;

        // 入场线：线条 + 右侧价格轴价格标签（左侧HTML标签展示）
        positionLines.entry = candlestickSeries.createPriceLine({
            price: entryPrice,
            color: '#f0b90b',
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: true,
            title: '入场'
        });
        positionLines.entry_price = entryPrice;

        // 止损线：线条 + 右侧价格轴价格标签（左侧HTML标签显示盈亏金额）
        if (stopLoss && stopLoss > 0) {
            positionLines.stopLoss = candlestickSeries.createPriceLine({
                price: stopLoss,
                color: '#f6465d',
                lineWidth: 2,
                lineStyle: LightweightCharts.LineStyle.Solid,
                axisLabelVisible: true,
                title: 'SL'
            });
            positionLines.stopLoss_price = stopLoss;
        }

        // 止盈线：线条 + 右侧价格轴价格标签
        if (takeProfit && takeProfit > 0) {
            positionLines.takeProfit = candlestickSeries.createPriceLine({
                price: takeProfit,
                color: '#0ecb81',
                lineWidth: 2,
                lineStyle: LightweightCharts.LineStyle.Solid,
                axisLabelVisible: true,
                title: 'TP'
            });
            positionLines.takeProfit_price = takeProfit;
        }
    }

    function clearPositionLines() {
        for (const key of Object.keys(positionLines)) {
            if (key.endsWith('_price')) {
                delete positionLines[key];
                continue;
            }
            if (positionLines[key]) {
                candlestickSeries.removePriceLine(positionLines[key]);
            }
            delete positionLines[key];
        }
    }

    // ===== 挂单价格线（可拖动改入场价/SL/TP） =====
    function setPendingOrderLines(orders) {
        clearPendingOrderLines();
        if (!orders || orders.length === 0) return;
        for (const order of orders) {
            const baseKey = `order_${order.id}`;
            const isLimit = order.type === 'limit';
            const mainColor = isLimit ? '#2962ff' : '#f5a623';
            pendingOrderLines[baseKey] = candlestickSeries.createPriceLine({
                price: order.price,
                color: mainColor,
                lineWidth: 1,
                lineStyle: LightweightCharts.LineStyle.Dashed,
                axisLabelVisible: true,
                title: isLimit ? '限价' : '止损'
            });
            pendingOrderLines[baseKey + '_price'] = order.price;
            pendingOrderLines[baseKey + '_color'] = mainColor;
            pendingOrderLines[baseKey + '_title'] = isLimit ? '限价' : '止损';

            // 挂单的止损/止盈线
            if (order.stopLoss && order.stopLoss > 0) {
                pendingOrderLines[baseKey + '_sl'] = candlestickSeries.createPriceLine({
                    price: order.stopLoss,
                    color: '#f6465d',
                    lineWidth: 1,
                    lineStyle: LightweightCharts.LineStyle.SparseDotted,
                    axisLabelVisible: false,
                    title: ''
                });
                pendingOrderLines[baseKey + '_sl_price'] = order.stopLoss;
            }
            if (order.takeProfit && order.takeProfit > 0) {
                pendingOrderLines[baseKey + '_tp'] = candlestickSeries.createPriceLine({
                    price: order.takeProfit,
                    color: '#0ecb81',
                    lineWidth: 1,
                    lineStyle: LightweightCharts.LineStyle.SparseDotted,
                    axisLabelVisible: false,
                    title: ''
                });
                pendingOrderLines[baseKey + '_tp_price'] = order.takeProfit;
            }
        }
    }

    function clearPendingOrderLines() {
        for (const key of Object.keys(pendingOrderLines)) {
            if (key.endsWith('_price') || key.endsWith('_color') || key.endsWith('_title')) {
                delete pendingOrderLines[key]; continue;
            }
            if (pendingOrderLines[key]) candlestickSeries.removePriceLine(pendingOrderLines[key]);
            delete pendingOrderLines[key];
        }
    }

    function setupDragHandling() {
        if (!mainChartEl) return;

        // 用捕获阶段监听，确保在chart库之前接收事件
        mainChartEl.addEventListener('mousedown', onMouseDown, true);
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);

        setupUserViewTracking();
    }

    /**
     * 追踪「用户手动控制视图」：滚轮、按住拖动图表时置位，松开后短暂保留再复位。
     * 仅用于判断是否应关闭自动跟随，不拦截、不修改任何事件。
     */
    function setupUserViewTracking() {
        if (!mainChartEl) return;
        const hold = () => {
            userViewControl = true;
            if (userViewReleaseTimer) {
                clearTimeout(userViewReleaseTimer);
                userViewReleaseTimer = null;
            }
        };
        const release = () => {
            if (userViewReleaseTimer) clearTimeout(userViewReleaseTimer);
            userViewReleaseTimer = setTimeout(() => { userViewControl = false; }, 150);
        };
        mainChartEl.addEventListener('pointerdown', hold, true);
        window.addEventListener('pointerup', release, true);
        mainChartEl.addEventListener('mousedown', hold, true);
        window.addEventListener('mouseup', release, true);
        mainChartEl.addEventListener('wheel', () => { hold(); release(); }, { capture: true, passive: true });
        mainChartEl.addEventListener('touchstart', hold, { capture: true, passive: true });
        window.addEventListener('touchend', release, true);
    }

    function onMouseDown(e) {
        if (!candlestickSeries || !mainChart) return;
        const rect = mainChartEl.getBoundingClientRect();
        // lightweight-charts 的坐标即 CSS 逻辑像素，与鼠标事件一致，无需 DPR 转换
        const y = e.clientY - rect.top;
        const x = e.clientX - rect.left;

        // 确保点击在图表区域内
        if (y < 0 || y > rect.height || x < 0 || x > rect.width) return;

        // 检查是否点击在止损/止盈/挂单线附近
        const threshold = 14;
        let dragTarget = findLineAtY(y, threshold);

        if (dragTarget) {
            dragState = { target: dragTarget, startY: y };
            mainChartEl.style.cursor = 'ns-resize';
            if (onLineDragCallback) onLineDragCallback(dragTarget, null, 'start');
            e.preventDefault();
            e.stopPropagation();
        }
    }

    function getLinePrice(key) {
        if (!positionLines[key]) return null;
        // priceLine 没有 getter，需要存储价格
        return positionLines[key + '_price'] || null;
    }

    function getPendingLinePrice(key) {
        if (!pendingOrderLines[key]) return null;
        return pendingOrderLines[key + '_price'] || null;
    }

    /**
     * 在指定Y坐标附近查找可拖动的线（持仓SL/TP + 挂单线/挂单SL/TP）
     * 返回 target 字符串：'stopLoss' | 'takeProfit' | 'order_{id}' | 'order_{id}_sl' | 'order_{id}_tp'
     */
    function findLineAtY(y, threshold) {
        // 优先持仓 SL/TP
        if (positionLines.stopLoss) {
            const p = getLinePrice('stopLoss');
            if (p !== null) {
                const ly = candlestickSeries.priceToCoordinate(p);
                if (ly !== null && Math.abs(y - ly) < threshold) return 'stopLoss';
            }
        }
        if (positionLines.takeProfit) {
            const p = getLinePrice('takeProfit');
            if (p !== null) {
                const ly = candlestickSeries.priceToCoordinate(p);
                if (ly !== null && Math.abs(y - ly) < threshold) return 'takeProfit';
            }
        }
        // 挂单线
        for (const key of Object.keys(pendingOrderLines)) {
            if (key.endsWith('_price')) continue;
            const p = getPendingLinePrice(key);
            if (p === null) continue;
            const ly = candlestickSeries.priceToCoordinate(p);
            if (ly !== null && Math.abs(y - ly) < threshold) return key;
        }
        return null;
    }

    function onMouseMove(e) {
        if (!mainChartEl || !candlestickSeries) return;
        const rect = mainChartEl.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const x = e.clientX - rect.left;

        if (dragState) {
            // 拖动中：更新价格线（coordinateToPrice 接受 CSS 逻辑像素坐标）
            const newPrice = candlestickSeries.coordinateToPrice(y);
            if (newPrice !== null && newPrice > 0) {
                const target = dragState.target;
                updateLineVisual(target, newPrice);
                if (onLineDragCallback) {
                    onLineDragCallback(target, newPrice, 'move');
                }
            }
            return;
        }

        // 悬停检测：改变光标（只在图表内检测）
        if (y < 0 || y > rect.height || x < 0 || x > rect.width) {
            mainChartEl.style.cursor = '';
            return;
        }

        const nearKey = findLineAtY(y, 14);
        mainChartEl.style.cursor = nearKey ? 'ns-resize' : '';
    }

    /**
     * 拖动中重建线的视觉（持仓SL/TP 或 挂单线）
     */
    function updateLineVisual(target, price) {
        // 持仓 SL/TP
        if (target === 'stopLoss' || target === 'takeProfit') {
            if (positionLines[target]) candlestickSeries.removePriceLine(positionLines[target]);
            const colors = { stopLoss: '#f6465d', takeProfit: '#0ecb81' };
            const titles = { stopLoss: 'SL', takeProfit: 'TP' };
            positionLines[target] = candlestickSeries.createPriceLine({
                price: price,
                color: colors[target],
                lineWidth: 2,
                lineStyle: LightweightCharts.LineStyle.Solid,
                axisLabelVisible: true,
                title: titles[target]
            });
            positionLines[target + '_price'] = price;
            return;
        }
        // 挂单线
        if (pendingOrderLines[target]) {
            candlestickSeries.removePriceLine(pendingOrderLines[target]);
            let color, style, label, title;
            if (target.endsWith('_sl')) {
                color = '#f6465d'; style = LightweightCharts.LineStyle.SparseDotted; label = false; title = '';
            } else if (target.endsWith('_tp')) {
                color = '#0ecb81'; style = LightweightCharts.LineStyle.SparseDotted; label = false; title = '';
            } else {
                color = pendingOrderLines[target + '_color'] || '#2962ff';
                style = LightweightCharts.LineStyle.Dashed; label = true;
                title = pendingOrderLines[target + '_title'] || '';
            }
            pendingOrderLines[target] = candlestickSeries.createPriceLine({
                price: price,
                color: color,
                lineWidth: 1,
                lineStyle: style,
                axisLabelVisible: label,
                title: title
            });
            pendingOrderLines[target + '_price'] = price;
        }
    }

    function onMouseUp() {
        if (dragState) {
            const target = dragState.target;
            dragState = null;
            mainChartEl.style.cursor = '';
            if (onLineDragCallback) onLineDragCallback(target, null, 'end');
        }
    }

    function onLineDrag(callback) {
        onLineDragCallback = callback;
    }

    function onRangeChange(callback) {
        // 支持多个订阅者（画层、持仓标签等），避免相互覆盖
        if (typeof callback !== 'function') return;
        if (!rangeChangeCallbacks.includes(callback)) {
            rangeChangeCallbacks.push(callback);
        }
    }

    function onFollowChange(callback) {
        onFollowChangeCallback = callback;
    }

    // ===== 工具方法 =====
    function scrollToEnd() {
        // 用「显式逻辑区间」把最新一根K线固定在右侧留白处（RIGHT_OFFSET 格）：
        // scrollToPosition(0) 在 v3 里不保证留出完整的 rightOffset，
        // 回放开始时会出现「最新K线跑到屏幕外」的问题；显式区间则精确可控。
        if (!mainChart) return;
        const n = visibleBarCount;
        if (n <= 0) {
            mainChart.timeScale().scrollToPosition(0, false);
            if (kdjChart) kdjChart.timeScale().scrollToPosition(0, false);
            return;
        }
        const ts = mainChart.timeScale();

        const apply = () => {
            const cur = ts.getVisibleLogicalRange();
            const span = (cur && (cur.to - cur.from) > 5) ? (cur.to - cur.from) : 91;
            // 以最新的 visibleBarCount 重新计算右边界，避免用上一帧的根数
            const to = visibleBarCount - 1 + RIGHT_OFFSET;
            const range = { from: to - span, to: to };
            try {
                ts.setVisibleLogicalRange(range);
            } catch (e) {
                ts.scrollToPosition(0, false);
            }
            if (kdjChart) {
                try { kdjChart.timeScale().setVisibleLogicalRange(range); } catch (e) { /* 忽略 */ }
            }
        };

        apply();

        // 时序兜底：series.update() 后库内部的时间轴还没重算完时，第一次设置会被吞掉，
        // 表现为「最新K线差十几根没跟上」。下一帧复核，不对就再设一次。
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => {
                const r = ts.getVisibleLogicalRange();
                const want = visibleBarCount - 1 + RIGHT_OFFSET;
                if (r && Math.abs(r.to - want) > 0.5) apply();
            });
        }
    }

    function fitContent() {
        mainChart.timeScale().fitContent();
    }

    function getVisibleBarCount() { return visibleBarCount; }
    function getCurrentData() { return currentData; }
    function getLatestBar() {
        return visibleBarCount > 0 ? currentData[visibleBarCount - 1] : null;
    }

    function subscribeCrosshair(callback) {
        if (mainChart && candlestickSeries) {
            mainChart.subscribeCrosshairMove(param => {
                if (param.time && param.seriesData && param.seriesData.get(candlestickSeries)) {
                    callback(param.seriesData.get(candlestickSeries), param.time);
                }
            });
        }
    }

    /**
     * 将价格转为 CSS 逻辑像素Y坐标（用于定位HTML标签）
     * lightweight-charts 的 priceToCoordinate 直接返回 CSS 逻辑像素，无需 DPR 转换
     */
    function priceToY(price) {
        if (!candlestickSeries) return null;
        const coord = candlestickSeries.priceToCoordinate(price);
        if (coord === null || coord === undefined) return null;
        return coord;
    }

    /**
     * 将Y坐标（相对图表容器顶部的CSS逻辑像素）转换为价格
     */
    function yToPrice(y) {
        if (!candlestickSeries) return null;
        const price = candlestickSeries.coordinateToPrice(y);
        if (price === null || price === undefined) return null;
        return price;
    }

    // ===== 画图所需坐标转换 =====
    function timeToX(time) {
        if (!mainChart) return null;
        const x = mainChart.timeScale().timeToCoordinate(time);
        return (x === null || x === undefined) ? null : x;
    }

    function xToTime(x) {
        if (!mainChart) return null;
        const t = mainChart.timeScale().coordinateToTime(x);
        return (t === null || t === undefined) ? null : t;
    }

    // 用逻辑索引转X（回放中未来bar可能无坐标，用逻辑索引更稳）
    function logicalToX(logical) {
        if (!mainChart) return null;
        const x = mainChart.timeScale().logicalToCoordinate(logical);
        return (x === null || x === undefined) ? null : x;
    }

    function xToLogical(x) {
        if (!mainChart) return null;
        const l = mainChart.timeScale().coordinateToLogical(x);
        return (l === null || l === undefined) ? null : l;
    }

    function getMainChartEl() { return mainChartEl; }

    /**
     * 诊断：同一价格在「K线」和「各条EMA」上的Y坐标是否一致。
     * 同轴（都用 right）时各值应完全相等；若均线挂在独立价格轴上则不相等。
     */
    function debugPriceScale(price) {
        const out = {};
        if (candlestickSeries) out.candleY = candlestickSeries.priceToCoordinate(price);
        for (const name of Object.keys(emaSeries)) {
            out[name + '_Y'] = emaSeries[name].priceToCoordinate(price);
        }
        return out;
    }

    /**
     * 诊断：当前主图可见逻辑范围 + 是否跟随最新
     */
    function debugViewport() {
        const r = mainChart ? mainChart.timeScale().getVisibleLogicalRange() : null;
        // 最新一根K线相对可视区右边界的距离（正数=在右边界左侧，即已可居中看）
        const gap = r ? +(r.to - (visibleBarCount - 1)).toFixed(2) : null;
        return {
            from: r ? +r.from.toFixed(2) : null,
            to: r ? +r.to.toFixed(2) : null,
            bars: visibleBarCount,
            followLatest: followLatest,
            leadBars: gap,
            canCenter: gap !== null ? gap > 8 : null
        };
    }

    function destroy() {
        if (mainChart) { mainChart.remove(); mainChart = null; }
        if (kdjChart) { kdjChart.remove(); kdjChart = null; }
        emaSeries = {};
        kdjSeries = {};
        tradeMarkers = [];
        positionLines = {};
    }

    return {
        init, setData, setVisibleBars, addBar,
        markStartPosition, clearStartPosition,
        toggleEMA, addTradeMarker, clearTradeMarkers,
        setPositionLines, clearPositionLines, setPendingOrderLines, clearPendingOrderLines,
        onLineDrag, onRangeChange, onFollowChange,
        setFollowLatest, getFollowLatest,
        setStochParams, getStochParams,
        scrollToEnd, fitContent,
        getVisibleBarCount, getCurrentData, getLatestBar,
        subscribeCrosshair, priceToY, yToPrice,
        timeToX, xToTime, logicalToX, xToLogical, getMainChartEl,
        debugPriceScale,
        debugViewport,
        destroy
    };
})();
