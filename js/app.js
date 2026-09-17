/**
 * ========================================
 * 主应用控制器 (App)
 * ========================================
 * 整合所有模块，负责UI事件绑定、状态管理和初始化流程
 * 
 * 核心流程：
 * 1. 加载数据后展示全量K线图（预览模式）
 * 2. 用户在进度条上选择回放起始位置
 * 3. 点击播放开始回放，从起始位置逐根弹出K线
 * 4. 支持市价单和限价单
 */

const App = (function() {
    'use strict';

    let currentTimeframe = '1m';
    let currentSymbol = 'XAUUSD';
    let lastPrice = 0;
    let lastPriceDirection = 0;
    let isReady = false;
    let replayMode = false; // 是否处于回放模式
    let replayStartIndex = 0; // 回放起始位置

    let dom = {};
    let quickTpSlEl = null;
    let currentOrderType = 'market';
    let draggingSltp = null; // { key: 'stopLoss'|'takeProfit', price } 拖动中实时显示盈亏
    let tradeMode = 'lots'; // 'lots' 手数模式 | 'amount' 金额模式

    async function init() {
        cacheDomElements();
        bindEvents();
        setTradeMode(tradeMode); // 应用默认数量模式（手数）

        ChartManager.init('mainChart', 'volumeChart');
        TradingManager.init(10000);
        StatsManager.init('equityChart');
        DrawManager.init();

        ChartManager.onLineDrag((target, price, phase) => {
            // 挂单线拖动（order_{id} / order_{id}_sl / order_{id}_tp）
            if (target.startsWith('order_')) {
                handleOrderLineDrag(target, price, phase);
                return;
            }
            // 持仓 SL/TP 拖动
            if (phase === 'start') {
                TradingManager.setSuppressSLTPCheck(true);
                const pos = TradingManager.getPosition();
                draggingSltp = { key: target, price: pos ? (target === 'stopLoss' ? pos.stopLoss : pos.takeProfit) : null };
                return;
            }
            if (phase === 'end') {
                TradingManager.setSuppressSLTPCheck(false);
                draggingSltp = null;
                // 松手时校正方向，避免止损/止盈落在会被立即触发的一侧
                normalizeSltpAfterDrag(target);
                updatePositionPanel();
                updatePositionLabels();
                return;
            }
            // move：自由双向拖动（不限制方向，允许把止损移到盈利侧、止盈移到亏损侧）
            draggingSltp = { key: target, price };
            if (target === 'stopLoss') {
                TradingManager.setStopLoss(price);
            } else if (target === 'takeProfit') {
                TradingManager.setTakeProfit(price);
            }
            updatePositionPanel();
            updatePositionLabels();
        });

        /**
         * 处理挂单线拖动：改入场价 / 挂单SL / 挂单TP
         * target: order_{id} | order_{id}_sl | order_{id}_tp
         */
        function handleOrderLineDrag(target, price, phase) {
            const m = target.match(/^order_(\d+)(_sl|_tp)?$/);
            if (!m) return;
            const orderId = parseInt(m[1]);
            const suffix = m[2] || '';
            if (phase === 'end') {
                // 拖动结束：刷新面板与挂单线（重新渲染为最终状态）
                updatePendingOrders();
                updatePendingOrderLines();
                return;
            }
            if (phase === 'start' || price === null || !(price > 0)) return;
            // move：静默更新挂单数据（不触发回调，避免与拖动视觉重建冲突）
            if (suffix === '') {
                TradingManager.updateOrderPrice(orderId, price, true);
            } else if (suffix === '_sl') {
                TradingManager.updateOrderSltp(orderId, 'stopLoss', price, true);
            } else if (suffix === '_tp') {
                TradingManager.updateOrderSltp(orderId, 'takeProfit', price, true);
            }
        }

        ChartManager.onRangeChange(() => {
            const pos = TradingManager.getPosition();
            if (pos) updatePositionLabels();
        });

        dom.symbolSelect.disabled = true;
        await DataManager.init(currentSymbol);
        dom.symbolSelect.disabled = false;

        syncContractSize();
        applySpread();
        loadData(currentTimeframe);

        ChartManager.toggleEMA('EMA20', true);
        updateUI();
        isReady = true;

        // 数据来源与新鲜度提示 + 启动自动更新
        announceDataStatus();
        if (typeof DataManager.startAutoRefresh === 'function') {
            DataManager.startAutoRefresh(onDataUpdated, 60000); // 每 60 秒检查一次本地数据服务
        }
        console.log('[App] 系统初始化完成');
    }

    /**
     * 展示数据来源与新鲜度（真实/静态/模拟、最新时间、滞后分钟、缺口）
     */
    function announceDataStatus() {
        const info = DataManager.getDataInfo ? DataManager.getDataInfo() : null;
        if (!info) return;
        const srcMap = {
            service: '本地数据服务(实时合并)',
            static: '静态数据文件',
            mock: '模拟数据(非真实，仅供演示)'
        };
        const meta = info.meta || {};
        const parts = [srcMap[info.source] || info.source];
        if (meta.count) parts.push(`1m ${meta.count} 根`);
        if (meta.lastBj) parts.push(`最新 ${meta.lastBj}`);
        if (typeof meta.staleMinutes === 'number') parts.push(`滞后 ${meta.staleMinutes} 分钟`);
        if (typeof meta.realGapCount === 'number' && meta.realGapCount > 0) {
            parts.push(`真实缺口 ${meta.realGapCount} 处`);
        }
        const msg = parts.join(' · ');

        // 附加：长期历史来源（5m / 日线）
        const extras = [];
        const srcName = {
            'twelvedata': 'TwelveData现货金',
            'binance': '币安黄金代币',
            'sina': '新浪外盘'
        };
        const readable = (s) => {
            if (!s) return '';
            const [head, tail] = String(s).split(':');
            return `${srcName[head] || head}${tail ? ' ' + tail : ''}`;
        };
        if (meta.ext5mCount) {
            extras.push(`5m ${meta.ext5mCount} 根(${readable(meta.ext5mSource)} ${meta.ext5mFirstBj}起)`);
        }
        if (meta.dailyCount) {
            extras.push(`日线 ${meta.dailyCount} 根(${readable(meta.dailySource)} ${meta.dailyFirstBj}起)`);
        }
        const extraText = extras.length ? `｜长期历史: ${extras.join('，')}` : '';

        const isStale = typeof meta.staleMinutes === 'number' && meta.staleMinutes > 30;
        if (info.isMock) {
            showNotification(`数据警告: ${msg}`, 'error');
        } else if (isStale || meta.realGapCount > 0) {
            showNotification(`数据提示: ${msg}`, 'warning');
        } else {
            showNotification(`数据就绪: ${msg}${extraText}`, 'info');
        }
        if (extras.length) console.log(`[App] 长期历史: ${extras.join(' | ')}`);
    }

    /**
     * 自动更新回调：预览模式下重建图表；回放中不打断，仅提示
     */
    function onDataUpdated() {
        if (replayMode) {
            showNotification('K线数据已在后台更新（重新开始回放后生效）', 'info');
            return;
        }
        const data = DataManager.getData(currentTimeframe);
        if (!data || data.length === 0) return;

        ChartManager.setData(data);
        // setData 后重新应用已选中的均线
        if (dom.ma5Toggle.checked) ChartManager.toggleEMA('EMA5', true);
        if (dom.ma10Toggle.checked) ChartManager.toggleEMA('EMA10', true);
        if (dom.ma20Toggle.checked) ChartManager.toggleEMA('EMA20', true);
        if (dom.ma60Toggle.checked) ChartManager.toggleEMA('EMA60', true);

        const lastBar = data[data.length - 1];
        updateStatusBar(lastBar);
        updateCurrentPrice(lastBar.close);
        updateBidAsk();
        DrawManager.refresh();

        const meta = DataManager.getDataInfo().meta || {};
        showNotification(`K线数据已自动更新（最新 ${meta.lastBj || ''}）`, 'success');
    }

    function cacheDomElements() {
        dom.symbolSelect = document.getElementById('symbolSelect');
        dom.tfButtons = document.querySelectorAll('.tf-btn');
        dom.playBtn = document.getElementById('playBtn');
        dom.followBtn = document.getElementById('followBtn');
        dom.drawBtns = document.querySelectorAll('.draw-btn[data-tool]');
        dom.drawDeleteBtn = document.getElementById('drawDeleteBtn');
        dom.drawClearBtn = document.getElementById('drawClearBtn');
        dom.ctxMenu = document.getElementById('chartContextMenu');
        dom.ctxPrice = document.getElementById('ctxPrice');
        dom.mainChart = document.getElementById('mainChart');
        dom.resetBtn = document.getElementById('resetBtn');
        dom.prevBarBtn = document.getElementById('prevBarBtn');
        dom.nextBarBtn = document.getElementById('nextBarBtn');
        dom.speedBtns = document.querySelectorAll('.speed-btn');
        dom.ma5Toggle = document.getElementById('ma5Toggle');
        dom.ma10Toggle = document.getElementById('ma10Toggle');
        dom.ma20Toggle = document.getElementById('ma20Toggle');
        dom.ma60Toggle = document.getElementById('ma60Toggle');
        dom.kdjN = document.getElementById('kdjN');
        dom.kdjM1 = document.getElementById('kdjM1');
        dom.spreadDisplay = document.getElementById('spreadDisplay');

        dom.balanceValue = document.getElementById('balanceValue');
        dom.availableMargin = document.getElementById('availableMargin');
        dom.usedMargin = document.getElementById('usedMargin');
        dom.totalPnL = document.getElementById('totalPnL');

        dom.currentPrice = document.getElementById('currentPrice');
        dom.askPrice = document.getElementById('askPrice');
        dom.bidPrice = document.getElementById('bidPrice');
        dom.positionInfo = document.getElementById('positionInfo');
        dom.positionBadge = document.getElementById('positionBadge');
        dom.positionSide = document.getElementById('positionSide');
        dom.entryPrice = document.getElementById('entryPrice');
        dom.positionSize = document.getElementById('positionSize');
        dom.stopLossPrice = document.getElementById('stopLossPrice');
        dom.takeProfitPrice = document.getElementById('takeProfitPrice');
        dom.floatingPnL = document.getElementById('floatingPnL');
        dom.tradeAmount = document.getElementById('tradeAmount');
        dom.leverageSelect = document.getElementById('leverageSelect');
        dom.sizeLabel = document.getElementById('sizeLabel');
        dom.sizeHint = document.getElementById('sizeHint');
        dom.sizeModeBtns = document.querySelectorAll('.size-mode-btn');
        dom.stopLossPercent = document.getElementById('stopLossPercent');
        dom.takeProfitPercent = document.getElementById('takeProfitPercent');
        dom.buyBtn = document.getElementById('buyBtn');
        dom.sellBtn = document.getElementById('sellBtn');
        dom.closeBtn = document.getElementById('closeBtn');

        dom.totalTrades = document.getElementById('totalTrades');
        dom.winRate = document.getElementById('winRate');
        dom.profitFactor = document.getElementById('profitFactor');
        dom.maxDrawdown = document.getElementById('maxDrawdown');
        dom.maxWinStreak = document.getElementById('maxWinStreak');
        dom.maxLoseStreak = document.getElementById('maxLoseStreak');

        dom.historyList = document.getElementById('historyList');
        dom.historyCount = document.getElementById('historyCount');

        dom.currentTime = document.getElementById('currentTime');
        dom.progressText = document.getElementById('progressText');
        dom.progressBar = document.getElementById('progressBar');
        dom.openPrice = document.getElementById('openPrice');
        dom.highPrice = document.getElementById('highPrice');
        dom.lowPrice = document.getElementById('lowPrice');
        dom.closePrice = document.getElementById('closePrice');
        dom.volumeValue = document.getElementById('volumeValue');

        dom.notification = document.getElementById('notification');
        dom.positionLabels = document.getElementById('positionLabels');
        dom.entryTag = document.getElementById('entryTag');
        dom.quickSlBtn = document.getElementById('quickSlBtn');
        dom.quickTpBtn = document.getElementById('quickTpBtn');
        dom.pendingOrderGroup = document.getElementById('pendingOrderGroup');
        dom.pendingPrice = document.getElementById('pendingPrice');
        dom.orderTabs = document.querySelectorAll('.order-tab');
        dom.pendingOrdersPanel = document.getElementById('pendingOrdersPanel');
        dom.pendingOrdersList = document.getElementById('pendingOrdersList');
        quickTpSlEl = dom.positionLabels;
    }

    function bindEvents() {
        dom.symbolSelect.addEventListener('change', async (e) => {
            currentSymbol = e.target.value;
            dom.symbolSelect.disabled = true;
            await DataManager.setSymbol(currentSymbol);
            dom.symbolSelect.disabled = false;
            syncContractSize();
            applySpread();
            loadData(currentTimeframe);
            ChartManager.toggleEMA('EMA20', dom.ma20Toggle.checked);
            const name = DataManager.getSymbolConfig(currentSymbol).name;
            showNotification(`已切换到 ${name}`, 'info');
        });

        dom.tfButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const tf = btn.dataset.tf;
                if (tf !== currentTimeframe) {
                    switchTimeframe(tf);
                    dom.tfButtons.forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                }
            });
        });

        dom.playBtn.addEventListener('click', () => {
            if (!replayMode) {
                startReplay();
            } else {
                ReplayManager.togglePlay();
            }
        });

        dom.resetBtn.addEventListener('click', () => {
            exitReplay();
        });

        dom.prevBarBtn.addEventListener('click', () => {
            // 预览模式下先进入回放（不自动播放），再退一根
            if (!replayMode) startReplay(false);
            ReplayManager.prevBar();
        });

        dom.nextBarBtn.addEventListener('click', () => {
            // 预览模式下先进入回放（不自动播放），再单步推进一根
            if (!replayMode) startReplay(false);
            ReplayManager.nextBar();
        });

        dom.speedBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const ms = parseInt(btn.dataset.interval);
                ReplayManager.setReplayInterval(ms);
                dom.speedBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });

        // 跟随最新K线开关
        dom.followBtn.addEventListener('click', () => {
            const next = !ChartManager.getFollowLatest();
            ChartManager.setFollowLatest(next);
            dom.followBtn.classList.toggle('active', next);
            if (next) showNotification('已开启跟随最新K线', 'info');
            else showNotification('已关闭跟随，可自由拖动图表', 'info');
        });
        ChartManager.onFollowChange((following) => {
            dom.followBtn.classList.toggle('active', following);
        });

        // 画图工具栏
        dom.drawBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const t = btn.dataset.tool;
                DrawManager.setTool(t);
                dom.drawBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                btn.blur(); // 避免空格/回车再次触发该按钮
            });
        });
        // 画完自动切回光标时，同步工具栏高亮
        DrawManager.onToolChange((t) => {
            dom.drawBtns.forEach(b => b.classList.toggle('active', b.dataset.tool === t));
        });
        dom.drawDeleteBtn.addEventListener('click', () => {
            DrawManager.deleteSelected();
        });
        dom.drawClearBtn.addEventListener('click', () => {
            DrawManager.clearAll();
            showNotification('已清空所有画线', 'info');
        });

        setupChartContextMenu();

        // EMA 开关
        dom.ma5Toggle.addEventListener('change', (e) => ChartManager.toggleEMA('EMA5', e.target.checked));
        dom.ma10Toggle.addEventListener('change', (e) => ChartManager.toggleEMA('EMA10', e.target.checked));
        dom.ma20Toggle.addEventListener('change', (e) => ChartManager.toggleEMA('EMA20', e.target.checked));
        dom.ma60Toggle.addEventListener('change', (e) => ChartManager.toggleEMA('EMA60', e.target.checked));

        // Stochastic 参数
        [dom.kdjN, dom.kdjM1].forEach(input => {
            input.addEventListener('change', () => {
                ChartManager.setStochParams({
                    kPeriod: parseInt(dom.kdjN.value) || 14,
                    dPeriod: parseInt(dom.kdjM1.value) || 3
                });
            });
        });

        // 进度条：预览模式下选择起始位置，回放模式下拖拽跳转
        dom.progressBar.addEventListener('input', (e) => {
            const percent = parseInt(e.target.value);
            const total = ReplayManager.getTotalBars();
            const index = Math.floor(total * percent / 100);
            if (replayMode) {
                ReplayManager.seekTo(index);
            } else {
                replayStartIndex = index;
                dom.progressText.textContent = `起始: ${index} / ${total}`;
                // 在图表上标记起始位置
                ChartManager.markStartPosition(index);
            }
        });

        // 订单类型切换
        dom.orderTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                currentOrderType = tab.dataset.type;
                dom.orderTabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                dom.pendingOrderGroup.style.display = currentOrderType === 'market' ? 'none' : 'block';
                // 挂单模式下预填当前价，并刷新手数换算提示
                if (currentOrderType !== 'market' && dom.pendingPrice && !dom.pendingPrice.value) {
                    let p = TradingManager.getCurrentPrice();
                    if (!(p > 0)) {
                        const lb = ChartManager.getLatestBar();
                        if (lb && lb.close > 0) p = lb.close;
                    }
                    if (p > 0) {
                        const decimals = DataManager.getSymbolConfig(currentSymbol).decimals || 2;
                        dom.pendingPrice.value = p.toFixed(decimals);
                    }
                }
                updateSizeHint();
            });
        });

        // 交易
        dom.buyBtn.addEventListener('click', () => handleTrade('long'));
        dom.sellBtn.addEventListener('click', () => handleTrade('short'));
        dom.closeBtn.addEventListener('click', () => handleClosePosition());

        dom.leverageSelect.addEventListener('change', (e) => {
            TradingManager.setLeverage(parseInt(e.target.value));
            updateAccountPanel();
        });

        // 数量模式切换（手数 / 金额）
        if (dom.sizeModeBtns) {
            dom.sizeModeBtns.forEach(btn => {
                btn.addEventListener('click', () => setTradeMode(btn.dataset.mode));
            });
        }
        if (dom.tradeAmount) {
            dom.tradeAmount.addEventListener('input', updateSizeHint);
        }
        if (dom.pendingPrice) {
            dom.pendingPrice.addEventListener('input', updateSizeHint);
        }

        // 止损止盈点击编辑
        dom.stopLossPrice.addEventListener('click', () => {
            if (!TradingManager.getPosition()) return;
            const newSL = prompt('设置止损价（留空取消止损）:', TradingManager.getPosition().stopLoss || '');
            if (newSL !== null) {
                const price = parseFloat(newSL);
                if (isNaN(price) || newSL === '') {
                    TradingManager.setStopLoss(null);
                } else {
                    TradingManager.setStopLoss(price);
                }
                updatePositionPanel();
                updateChartPositionLines();
            }
        });

        dom.takeProfitPrice.addEventListener('click', () => {
            if (!TradingManager.getPosition()) return;
            const newTP = prompt('设置止盈价（留空取消止盈）:', TradingManager.getPosition().takeProfit || '');
            if (newTP !== null) {
                const price = parseFloat(newTP);
                if (isNaN(price) || newTP === '') {
                    TradingManager.setTakeProfit(null);
                } else {
                    TradingManager.setTakeProfit(price);
                }
                updatePositionPanel();
                updateChartPositionLines();
            }
        });

        // 快捷止损止盈标签：支持「拖动设置/调整」+「点击切换开关」
        setupQuickTagDrag();

        // 键盘快捷键
        document.addEventListener('keydown', (e) => {
            const tag = (e.target.tagName || '').toUpperCase();
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
            // Delete/Backspace 删除选中画线
            if (e.code === 'Delete' || e.code === 'Backspace') {
                if (DrawManager.getSelectedId() !== null) {
                    e.preventDefault();
                    DrawManager.deleteSelected();
                }
                return;
            }
            if (e.code === 'Escape') {
                // ESC 退出画图工具，回到光标
                DrawManager.switchToCursor();
                return;
            }
            if (e.code === 'Space') { e.preventDefault(); dom.playBtn.click(); }
            if (e.code === 'ArrowRight') { e.preventDefault(); dom.nextBarBtn.click(); }
            if (e.code === 'ArrowLeft') { e.preventDefault(); dom.prevBarBtn.click(); }
            if (e.code === 'KeyB') { e.preventDefault(); handleTrade('long'); }
            if (e.code === 'KeyS') { e.preventDefault(); handleTrade('short'); }
            if (e.code === 'KeyC') { e.preventDefault(); handleClosePosition(); }
        });

        // 回放回调
        ReplayManager.on('onPlay', () => {
            dom.playBtn.textContent = '⏸';
            dom.playBtn.title = '暂停';
        });
        ReplayManager.on('onPause', () => {
            dom.playBtn.textContent = '▶';
            dom.playBtn.title = '播放';
        });
        ReplayManager.on('onReset', () => {
            dom.playBtn.textContent = '▶';
            dom.playBtn.title = '播放';
        });
        ReplayManager.on('onIndexChange', (index) => {
            updateProgressBar(index);
            if (!ReplayManager.getIsPlaying()) {
                ChartManager.setVisibleBars(index);
                const data = DataManager.getData(currentTimeframe);
                if (index > 0 && data[index - 1]) {
                    const bar = data[index - 1];
                    updatePriceAndTrading(bar);
                    updateStatusBar(bar);
                }
            }
        });
        ReplayManager.on('onBarReveal', (barIndex, bar) => {
            ChartManager.addBar(bar);
            updatePriceAndTrading(bar);
            updateStatusBar(bar);
            DrawManager.refresh();
        });
        ReplayManager.on('onFinish', () => showNotification('回放完成', 'info'));

        // 交易回调
        TradingManager.on('onPositionOpen', (position) => {
            updatePositionPanel();
            updateAccountPanel();
            updateTradeButtons();
            updateChartPositionLines();
            ChartManager.addTradeMarker({
                barIndex: position.entryBarIndex,
                time: position.entryTime,
                side: position.side === 'long' ? 'buy' : 'sell',
                text: position.side === 'long' ? '多' : '空'
            });
            const sideText = position.side === 'long' ? '做多' : '做空';
            showNotification(`开仓 ${sideText} @ ${formatPrice(position.entryPrice)}`, 'success');
        });
        TradingManager.on('onPositionClose', (trade, position) => {
            updatePositionPanel();
            updateAccountPanel();
            updateTradeButtons();
            updateChartPositionLines();
            updateStats();
            updateHistoryList();
            if (trade) {
                const profitText = trade.pnl >= 0 ? '盈利' : '亏损';
                const pnlColor = trade.pnl >= 0 ? 'success' : 'error';
                const reasonText = getCloseReasonText(trade.reason);
                showNotification(
                    `${reasonText} ${profitText} ${StatsManager.formatCurrency(trade.pnl)} (${trade.pnlPercent.toFixed(2)}%)`,
                    pnlColor
                );
            }
        });
        TradingManager.on('onPositionUpdate', () => {
            updatePositionPanel();
            updateAccountPanel();
        });
        TradingManager.on('onBalanceChange', () => updateAccountPanel());
        TradingManager.on('onLiquidation', (info) => {
            showNotification(`强制平仓！亏损 ${info.lossPercent.toFixed(1)}%`, 'error');
        });
        TradingManager.on('onOrderPlaced', () => { updatePendingOrders(); updatePendingOrderLines(); });
        TradingManager.on('onOrderCancelled', (info) => {
            updatePendingOrders();
            updatePendingOrderLines();
            if (info.reason !== '手动取消') {
                showNotification(`挂单取消: ${info.reason}`, 'warning');
            }
        });
        TradingManager.on('onOrderFilled', (info) => {
            updatePendingOrders();
            updatePendingOrderLines();
            const typeText = info.order.type === 'limit' ? '限价单' : '止损单';
            const sideText = info.order.side === 'long' ? '做多' : '做空';
            showNotification(`${typeText} ${sideText} 已成交 @ ${formatPrice(info.order.price)}`, 'success');
        });
    }

    /**
     * 应用当前品种的点差
     */
    function applySpread() {
        const cfg = DataManager.getSymbolConfig(currentSymbol);
        const spread = cfg.spread || 0;
        TradingManager.setSpread(spread);
        if (dom.spreadDisplay) {
            dom.spreadDisplay.textContent = formatPrice(spread);
        }
    }

    /**
     * 同步当前品种的合约规格（1手对应的标的数量）
     */
    function syncContractSize() {
        const cfg = DataManager.getSymbolConfig(currentSymbol);
        TradingManager.setContractSize(cfg.contractSize || 0);
        updateSizeHint();
    }

    /**
     * 切换数量模式（手数 / 金额）
     */
    function setTradeMode(mode) {
        tradeMode = mode === 'amount' ? 'amount' : 'lots';
        const isLots = tradeMode === 'lots';
        if (dom.sizeLabel) dom.sizeLabel.textContent = isLots ? '手数' : '数量 (USD)';
        if (dom.tradeAmount) {
            dom.tradeAmount.step = isLots ? '0.01' : '10';
            dom.tradeAmount.min = isLots ? '0.01' : '10';
            dom.tradeAmount.value = isLots ? '0.10' : '1000';
        }
        if (dom.sizeModeBtns) {
            dom.sizeModeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === tradeMode));
        }
        updateSizeHint();
    }

    /**
     * 更新数量输入下方的换算提示（名义价值 / 手数）
     */
    function updateSizeHint() {
        if (!dom.sizeHint) return;
        const cs = TradingManager.getContractSize();
        const raw = parseFloat(dom.tradeAmount ? dom.tradeAmount.value : '');
        // 参考价：挂单模式用挂单价，其余用当前价（回放未开始时回退到最新K线收盘价）
        let refPrice = TradingManager.getCurrentPrice();
        if (!(refPrice > 0)) {
            const lb = ChartManager.getLatestBar();
            if (lb && lb.close > 0) refPrice = lb.close;
        }
        if (currentOrderType !== 'market' && dom.pendingPrice) {
            const op = parseFloat(dom.pendingPrice.value);
            if (!isNaN(op) && op > 0) refPrice = op;
        }
        if (isNaN(raw) || raw <= 0 || !(cs > 0) || !(refPrice > 0)) {
            dom.sizeHint.textContent = '≈ --';
            return;
        }
        if (tradeMode === 'lots') {
            const notional = raw * cs * refPrice;
            dom.sizeHint.textContent = `≈ 名义价值 ${StatsManager.formatCurrency(notional)}（${raw}手 × ${cs}${symbolUnitText()}）`;
        } else {
            const lots = raw / (cs * refPrice);
            dom.sizeHint.textContent = `≈ ${lots.toFixed(3)} 手`;
        }
    }

    /**
     * 当前品种的单位文本（辅助提示用）
     */
    function symbolUnitText() {
        const map = { XAUUSD: '盎司', USOIL: '桶', USDJPY: '', EURUSD: '' };
        return map[currentSymbol] || '';
    }

    /**
     * 按当前模式解析出「名义金额（USD）」，手数模式自动换算
     * @param {number} refPrice 参考价（市价用当前价，挂单用触发价）
     * @returns {{ok:boolean, amount?:number, lots?:number, message?:string}}
     */
    function resolveTradeSize(refPrice) {
        const raw = parseFloat(dom.tradeAmount.value);
        if (isNaN(raw) || raw <= 0) {
            return { ok: false, message: '请输入有效的交易数量' };
        }
        const cs = TradingManager.getContractSize();
        if (tradeMode === 'lots') {
            const cfg = DataManager.getSymbolConfig(currentSymbol);
            const minLots = cfg.minLots || 0.01;
            if (raw < minLots) {
                return { ok: false, message: `最小手数为 ${minLots} 手` };
            }
            if (!(cs > 0) || !(refPrice > 0)) {
                return { ok: false, message: '合约规格或价格无效' };
            }
            return { ok: true, amount: raw * cs * refPrice, lots: raw, message: '' };
        }
        return { ok: true, amount: raw, lots: TradingManager.calcLots(raw / refPrice), message: '' };
    }

    /**
     * 加载数据：展示全量K线图（预览模式）
     */
    function loadData(timeframe) {
        const data = DataManager.getData(timeframe);
        replayMode = false;
        replayStartIndex = 0;

        // 展示全量K线
        ChartManager.setData(data);
        ReplayManager.init(data);
        TradingManager.reset();
        StatsManager.reset();
        ChartManager.clearTradeMarkers();
        ChartManager.clearPositionLines();
        ChartManager.clearPendingOrderLines();

        // 重新开启已选中的 EMA
        if (dom.ma5Toggle.checked) ChartManager.toggleEMA('EMA5', true);
        if (dom.ma10Toggle.checked) ChartManager.toggleEMA('EMA10', true);
        if (dom.ma20Toggle.checked) ChartManager.toggleEMA('EMA20', true);
        if (dom.ma60Toggle.checked) ChartManager.toggleEMA('EMA60', true);

        // 更新UI为预览模式
        dom.playBtn.textContent = '▶';
        dom.playBtn.title = '开始回放';
        dom.progressText.textContent = `预览模式 — 拖动进度条选择起始位置`;
        dom.progressBar.value = 0;

        // 显示最后一根K线的信息
        if (data.length > 0) {
            const lastBar = data[data.length - 1];
            updateStatusBar(lastBar);
            updateCurrentPrice(lastBar.close);
            updateBidAsk();
        }

        updateUI();
    }

    /**
     * 开始回放：从选定的起始位置开始
     * @param {boolean} autoPlay 是否自动开始播放（单步操作时应传 false）
     */
    function startReplay(autoPlay = true) {
        const data = DataManager.getData(currentTimeframe);
        if (data.length === 0) return;

        replayMode = true;
        const startIndex = replayStartIndex || 0;

        // 重置图表：只显示起始位置之前的K线
        ChartManager.setVisibleBars(startIndex);
        ReplayManager.init(data);
        ReplayManager.seekTo(startIndex);

        // 重置交易状态
        TradingManager.reset();
        StatsManager.reset();
        ChartManager.clearTradeMarkers();
        ChartManager.clearPositionLines();
        ChartManager.clearPendingOrderLines();

        // 更新起始位置的价格信息
        if (startIndex > 0 && data[startIndex - 1]) {
            const bar = data[startIndex - 1];
            updatePriceAndTrading(bar);
            updateStatusBar(bar);
        }

        if (autoPlay) {
            ReplayManager.play();
            showNotification(`从第 ${startIndex} 根K线开始回放`, 'info');
        } else {
            showNotification(`已进入回放模式（第 ${startIndex} 根），可用 ⏩ 单步推进`, 'info');
        }
    }

    /**
     * 退出回放，返回预览模式
     */
    function exitReplay() {
        ReplayManager.pause();
        replayMode = false;
        loadData(currentTimeframe);
        showNotification('已退出回放，返回预览模式', 'info');
    }

    function switchTimeframe(tf) {
        currentTimeframe = tf;
        loadData(tf);
        showNotification(`已切换到 ${tf} 周期`, 'info');
    }

    function handleTrade(side) {
        if (!replayMode) {
            showNotification('请先开始回放', 'warning');
            return;
        }
        const currentIndex = ReplayManager.getCurrentIndex();
        if (currentIndex < 1) {
            showNotification('请先播放至少一根K线', 'warning');
            return;
        }
        const slPercent = parseFloat(dom.stopLossPercent.value);
        const tpPercent = parseFloat(dom.takeProfitPercent.value);
        const sl = isNaN(slPercent) ? null : slPercent;
        const tp = isNaN(tpPercent) ? null : tpPercent;

        if (currentOrderType === 'market') {
            // 市价单：按当前价换算名义金额后直接开仓
            const size = resolveTradeSize(TradingManager.getCurrentPrice());
            if (!size.ok) {
                showNotification(size.message, 'error');
                return;
            }
            const result = TradingManager.openPosition(side, size.amount, sl, tp);
            if (!result.success) showNotification(result.message, 'error');
        } else {
            // 限价单 / 止损单
            const orderPrice = parseFloat(dom.pendingPrice.value);
            if (isNaN(orderPrice) || orderPrice <= 0) {
                showNotification('请输入挂单触发价格', 'error');
                return;
            }
            const size = resolveTradeSize(orderPrice);
            if (!size.ok) {
                showNotification(size.message, 'error');
                return;
            }
            const result = TradingManager.placeOrder(currentOrderType, side, orderPrice, size.amount, sl, tp);
            if (result.success) {
                const typeText = currentOrderType === 'limit' ? '限价单' : '止损单';
                const sideText = side === 'long' ? '做多' : '做空';
                showNotification(`${typeText} ${sideText} @ ${formatPrice(orderPrice)} 已挂单`, 'info');
                updatePendingOrders();
                updatePendingOrderLines();
            } else {
                showNotification(result.message, 'error');
            }
        }
    }

    function handleClosePosition() {
        if (!TradingManager.getPosition()) {
            showNotification('当前没有持仓', 'warning');
            return;
        }
        const result = TradingManager.closePosition('manual');
        if (!result.success) showNotification(result.message, 'error');
    }

    function updatePriceAndTrading(bar) {
        const currentIndex = ReplayManager.getCurrentIndex();
        // 传入完整K线：止损止盈/挂单按K线最高最低价判定，而非仅用收盘价
        TradingManager.updatePrice(bar.close, bar.time, currentIndex - 1, bar);
        updateCurrentPrice(bar.close);
        updateBidAsk();
        updateFloatingPnL();
    }

    function updateCurrentPrice(price) {
        dom.currentPrice.textContent = formatPrice(price);
        if (price > lastPrice) {
            dom.currentPrice.classList.add('up');
            dom.currentPrice.classList.remove('down');
            lastPriceDirection = 1;
        } else if (price < lastPrice) {
            dom.currentPrice.classList.add('down');
            dom.currentPrice.classList.remove('up');
            lastPriceDirection = -1;
        }
        lastPrice = price;
        updateSizeHint();
    }

    function updateBidAsk() {
        const bid = TradingManager.getBid();
        const ask = TradingManager.getAsk();
        dom.bidPrice.textContent = formatPrice(bid);
        dom.askPrice.textContent = formatPrice(ask);
    }

    function updateUI() {
        updateAccountPanel();
        updatePositionPanel();
        updateTradeButtons();
        updateStats();
        updateHistoryList();
    }

    function updateAccountPanel() {
        const balance = TradingManager.getBalance();
        const availableMargin = TradingManager.getAvailableMargin();
        const usedMargin = TradingManager.getUsedMargin();
        const totalPnL = TradingManager.getTotalPnL();
        dom.balanceValue.textContent = StatsManager.formatCurrency(balance);
        dom.availableMargin.textContent = StatsManager.formatCurrency(Math.max(0, availableMargin));
        dom.usedMargin.textContent = StatsManager.formatCurrency(usedMargin);
        dom.totalPnL.textContent = StatsManager.formatCurrency(totalPnL);
        dom.totalPnL.classList.toggle('profit', totalPnL >= 0);
        dom.totalPnL.classList.toggle('loss', totalPnL < 0);
    }

    function updatePositionPanel() {
        const position = TradingManager.getPosition();
        if (position) {
            dom.positionInfo.style.display = 'block';
            dom.positionBadge.textContent = position.side === 'long' ? '持有多单' : '持有空单';
            dom.positionBadge.style.color = position.side === 'long' ? '#0ecb81' : '#f6465d';
            dom.positionSide.textContent = position.side === 'long' ? '做多' : '做空';
            dom.positionSide.style.color = position.side === 'long' ? '#0ecb81' : '#f6465d';
            dom.entryPrice.textContent = formatPrice(position.entryPrice);
            dom.positionSize.textContent = formatPositionSize(position);
            dom.stopLossPrice.textContent = formatSltpPanel(position.stopLoss, 'stopLoss');
            dom.takeProfitPrice.textContent = formatSltpPanel(position.takeProfit, 'takeProfit');
        } else {
            dom.positionInfo.style.display = 'none';
            dom.positionBadge.textContent = '无持仓';
            dom.positionBadge.style.color = '';
        }
    }

    /**
     * 持仓数量显示：手数 + 名义价值
     */
    function formatPositionSize(position) {
        const notional = StatsManager.formatCurrency(position.size);
        const lots = position.lots;
        if (lots === null || lots === undefined) return notional;
        const lotText = lots >= 1 ? lots.toFixed(2) : lots.toFixed(3);
        return `${lotText} 手 / ${notional}`;
    }

    /**
     * 面板中的止损/止盈显示：价格 (预期盈亏金额)
     */
    function formatSltpPanel(price, key) {
        if (!price) return '点击设置';
        const pnl = TradingManager.calcNetPnLAt(price);
        const sign = pnl >= 0 ? '+' : '';
        return `${formatPrice(price)} (${sign}${StatsManager.formatCurrency(pnl)})`;
    }

    function updateFloatingPnL() {
        const position = TradingManager.getPosition();
        if (position) {
            const pnl = TradingManager.getFloatingPnL();
            const pnlPercent = TradingManager.getFloatingPnLPercent();
            dom.floatingPnL.textContent = `${StatsManager.formatCurrency(pnl)} (${pnlPercent.toFixed(2)}%)`;
            dom.floatingPnL.classList.toggle('profit', pnl >= 0);
            dom.floatingPnL.classList.toggle('loss', pnl < 0);
        }
    }

    function updateTradeButtons() {
        const hasPosition = !!TradingManager.getPosition();
        dom.buyBtn.style.display = hasPosition ? 'none' : 'block';
        dom.sellBtn.style.display = hasPosition ? 'none' : 'block';
        dom.closeBtn.style.display = hasPosition ? 'block' : 'none';
    }

    function updateChartPositionLines() {
        const position = TradingManager.getPosition();
        if (position) {
            ChartManager.setPositionLines(
                position.entryPrice,
                position.stopLoss,
                position.takeProfit,
                position.side
            );
            updatePositionLabels();
        } else {
            ChartManager.clearPositionLines();
            if (quickTpSlEl) quickTpSlEl.style.display = 'none';
        }
    }

    function updatePositionLabels() {
        const pos = TradingManager.getPosition();
        const el = quickTpSlEl;
        if (!el || !pos) {
            if (el) el.style.display = 'none';
            return;
        }

        const entryY = ChartManager.priceToY(pos.entryPrice);
        if (entryY === null || entryY === undefined) {
            el.style.display = 'none';
            return;
        }
        el.style.display = 'block';

        // 入场标签：固定在入场价位置
        dom.entryTag.textContent = `入场 ${formatPrice(pos.entryPrice)}`;
        dom.entryTag.style.top = entryY + 'px';

        // 止损标签：有止损时跟随止损线，无止损时作为快捷入口放在入场价上方
        const hasSl = pos.stopLoss && pos.stopLoss > 0;
        dom.quickSlBtn.textContent = slLabelText(hasSl, pos.stopLoss, 'stopLoss');
        dom.quickSlBtn.classList.toggle('active', !!hasSl);
        const slY = hasSl ? ChartManager.priceToY(pos.stopLoss) : (entryY - 26);
        dom.quickSlBtn.style.top = (slY === null || slY === undefined ? entryY - 26 : slY) + 'px';

        // 止盈标签：有止盈时跟随止盈线，无止盈时作为快捷入口放在入场价下方
        const hasTp = pos.takeProfit && pos.takeProfit > 0;
        dom.quickTpBtn.textContent = slLabelText(hasTp, pos.takeProfit, 'takeProfit');
        dom.quickTpBtn.classList.toggle('active', !!hasTp);
        const tpY = hasTp ? ChartManager.priceToY(pos.takeProfit) : (entryY + 4);
        dom.quickTpBtn.style.top = (tpY === null || tpY === undefined ? entryY + 4 : tpY) + 'px';
    }

    /**
     * 生成 SL/TP 标签文字：始终显示该价位平仓的「预期净盈亏金额」（不显示价位）
     * 金额与平仓实际入账一致（已扣除平仓手续费）
     */
    function slLabelText(hasLevel, levelPrice, key) {
        const prefix = key === 'stopLoss' ? 'SL' : 'TP';
        // 拖动中优先使用实时拖动价，否则使用已设置的价位
        const dragPrice = (draggingSltp && draggingSltp.key === key) ? draggingSltp.price : null;
        const price = (dragPrice !== null && dragPrice !== undefined) ? dragPrice : (hasLevel ? levelPrice : null);
        if (!(price > 0)) return prefix;
        const pnl = TradingManager.calcNetPnLAt(price);
        const sign = pnl >= 0 ? '+' : '';
        return `${prefix} ${sign}${StatsManager.formatCurrency(pnl)}`;
    }

    /**
     * 拖动结束后校正止损/止盈价。
     * 拖动过程允许自由移动（不打断手感），但松手时若价格落在「会被立即触发」的一侧，
     * 就吸附到当前价的合法一侧（仅留 1 个最小跳动），避免订单在下一根K线瞬间被平掉。
     * @param {'stopLoss'|'takeProfit'} key
     * @returns {boolean} 是否发生了校正
     */
    function normalizeSltpAfterDrag(key) {
        const pos = TradingManager.getPosition();
        if (!pos) return false;
        const cur = TradingManager.getCurrentPrice();
        if (!(cur > 0)) return false;

        const price = key === 'stopLoss' ? pos.stopLoss : pos.takeProfit;
        if (!(price > 0)) return false;

        const isLong = pos.side === 'long';
        const isSl = key === 'stopLoss';
        const tick = Math.max(cur * 0.00005, 0.01);   // 最小跳动，避免贴着现价立即成交

        let fixed = price;
        if (isSl) {
            // 多单：止损必须在现价下方；空单：必须在现价上方
            if (isLong && price > cur - tick) fixed = cur - tick;
            if (!isLong && price < cur + tick) fixed = cur + tick;
        } else {
            // 多单：止盈必须在现价上方；空单：必须在现价下方
            if (isLong && price < cur + tick) fixed = cur + tick;
            if (!isLong && price > cur - tick) fixed = cur - tick;
        }

        if (Math.abs(fixed - price) < 1e-9) return false;

        if (isSl) TradingManager.setStopLoss(fixed);
        else TradingManager.setTakeProfit(fixed);
        updatePositionPanel();
        updateChartPositionLines();
        showNotification(
            `${isSl ? '止损' : '止盈'}已校正到 ${formatPrice(fixed)}（原位置会被立即触发）`,
            'warning'
        );
        return true;
    }

    /**
     * 止损/止盈标签拖动与点击逻辑
     * - 拖动标签：实时按鼠标Y坐标设置对应价格（无价格线时也能直接拖出）
     * - 原地点击（未移动）：切换开关（设置默认1%/2%或取消）
     */
    function setupQuickTagDrag() {
        const tags = [
            { btn: dom.quickSlBtn, key: 'stopLoss' },
            { btn: dom.quickTpBtn, key: 'takeProfit' }
        ];

        tags.forEach(({ btn, key }) => {
            let dragging = false;
            let moved = false;
            let startClientY = 0;
            const isSl = () => key === 'stopLoss';

            function applyPrice(rawPrice) {
                if (!(rawPrice > 0)) return;
                draggingSltp = { key, price: rawPrice };
                if (isSl()) TradingManager.setStopLoss(rawPrice);
                else TradingManager.setTakeProfit(rawPrice);
                updatePositionPanel();
                updateChartPositionLines();
            }

            function toggle() {
                const pos = TradingManager.getPosition();
                if (!pos) return;
                if (isSl()) {
                    if (pos.stopLoss) TradingManager.setStopLoss(null);
                    else TradingManager.setStopLoss(pos.side === 'long' ? pos.entryPrice * 0.99 : pos.entryPrice * 1.01);
                } else {
                    if (pos.takeProfit) TradingManager.setTakeProfit(null);
                    else TradingManager.setTakeProfit(pos.side === 'long' ? pos.entryPrice * 1.02 : pos.entryPrice * 0.98);
                }
                updatePositionPanel();
                updateChartPositionLines();
            }

            function startDrag(clientY) {
                if (!TradingManager.getPosition()) return;
                dragging = true;
                moved = false;
                startClientY = clientY;
                TradingManager.setSuppressSLTPCheck(true);
            }

            function onMove(clientY) {
                if (!dragging) return;
                const chartEl = document.getElementById('mainChart');
                if (!chartEl) return;
                if (Math.abs(clientY - startClientY) > 3) moved = true;
                const rect = chartEl.getBoundingClientRect();
                const price = ChartManager.yToPrice(clientY - rect.top);
                if (price !== null && price > 0) applyPrice(price);
            }

            function endDrag() {
                if (!dragging) return;
                dragging = false;
                TradingManager.setSuppressSLTPCheck(false);
                draggingSltp = null;
                if (!moved) {
                    toggle();
                } else {
                    // 拖动有位移：松手时做方向校正，避免落在会被立即触发的一侧
                    normalizeSltpAfterDrag(key);
                }
                updatePositionLabels();
            }

            btn.addEventListener('mousedown', (e) => {
                startDrag(e.clientY);
                if (dragging) { e.preventDefault(); e.stopPropagation(); }
            });
            btn.addEventListener('touchstart', (e) => {
                startDrag(e.touches[0].clientY);
                if (dragging) { e.preventDefault(); e.stopPropagation(); }
            }, { passive: false });

            window.addEventListener('mousemove', (e) => onMove(e.clientY));
            window.addEventListener('touchmove', (e) => { if (dragging) onMove(e.touches[0].clientY); }, { passive: false });
            window.addEventListener('mouseup', endDrag);
            window.addEventListener('touchend', endDrag);
        });
    }

    /**
     * 图表右键菜单：市价入场 / 在鼠标价位挂限价单、止损单
     */
    function setupChartContextMenu() {
        if (!dom.mainChart || !dom.ctxMenu) return;
        let ctxPriceValue = null;

        dom.mainChart.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const rect = dom.mainChart.getBoundingClientRect();
            // 右键落在已有画线上 → 删除该画线（不弹交易菜单）
            if (DrawManager.deleteUnderPoint(e.clientX - rect.left, e.clientY - rect.top)) {
                hideCtxMenu();
                showNotification('已删除该画线', 'info');
                return;
            }
            if (!replayMode) {
                showNotification('请先开始回放再交易', 'warning');
                return;
            }
            const price = ChartManager.yToPrice(e.clientY - rect.top);
            if (price === null || !(price > 0)) return;
            ctxPriceValue = price;
            dom.ctxPrice.textContent = `价格 ${formatPrice(price)}`;

            // 定位菜单（防止超出右/下边界）
            dom.ctxMenu.style.display = 'block';
            const mw = dom.ctxMenu.offsetWidth;
            const mh = dom.ctxMenu.offsetHeight;
            let x = e.clientX, y = e.clientY;
            if (x + mw > window.innerWidth) x = window.innerWidth - mw - 8;
            if (y + mh > window.innerHeight) y = window.innerHeight - mh - 8;
            dom.ctxMenu.style.left = x + 'px';
            dom.ctxMenu.style.top = y + 'px';
        });

        // 点击菜单项
        dom.ctxMenu.querySelectorAll('.ctx-item').forEach(item => {
            item.addEventListener('click', () => {
                const action = item.dataset.action;
                handleCtxAction(action, ctxPriceValue);
                hideCtxMenu();
            });
        });

        // 点击其他地方关闭
        document.addEventListener('click', (e) => {
            if (!dom.ctxMenu.contains(e.target)) hideCtxMenu();
        });
        document.addEventListener('contextmenu', (e) => {
            if (!dom.mainChart.contains(e.target) && !dom.ctxMenu.contains(e.target)) hideCtxMenu();
        });

        function hideCtxMenu() {
            dom.ctxMenu.style.display = 'none';
        }
    }

    /**
     * 处理右键菜单动作
     */
    function handleCtxAction(action, price) {
        const slPercent = parseFloat(dom.stopLossPercent.value);
        const tpPercent = parseFloat(dom.takeProfitPercent.value);
        const sl = isNaN(slPercent) ? null : slPercent;
        const tp = isNaN(tpPercent) ? null : tpPercent;

        if (action === 'buy' || action === 'sell') {
            const side = action === 'buy' ? 'long' : 'short';
            const size = resolveTradeSize(TradingManager.getCurrentPrice());
            if (!size.ok) {
                showNotification(size.message, 'error');
                return;
            }
            const result = TradingManager.openPosition(side, size.amount, sl, tp);
            if (!result.success) showNotification(result.message, 'error');
            return;
        }

        // 挂单：需输入价格，使用右键价位
        if (!(price > 0)) return;
        const map = {
            'limit-long': { type: 'limit', side: 'long' },
            'limit-short': { type: 'limit', side: 'short' },
            'stop-long': { type: 'stop', side: 'long' },
            'stop-short': { type: 'stop', side: 'short' }
        };
        const cfg = map[action];
        if (!cfg) return;
        const size = resolveTradeSize(price);
        if (!size.ok) {
            showNotification(size.message, 'error');
            return;
        }
        const result = TradingManager.placeOrder(cfg.type, cfg.side, price, size.amount, sl, tp);
        if (result.success) {
            const typeText = cfg.type === 'limit' ? '限价单' : '止损单';
            const sideText = cfg.side === 'long' ? '做多' : '做空';
            showNotification(`${typeText} ${sideText} @ ${formatPrice(price)} 已挂单`, 'info');
            updatePendingOrders();
            updatePendingOrderLines();
        } else {
            showNotification(result.message, 'error');
        }
    }

    function updateStats() {
        const tradeHistory = TradingManager.getTradeHistory();
        const initialBalance = TradingManager.getInitialBalance();
        const stats = StatsManager.calculate(tradeHistory, initialBalance);
        dom.totalTrades.textContent = stats.totalTrades;
        dom.winRate.textContent = stats.winRate.toFixed(1) + '%';
        dom.profitFactor.textContent = stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2);
        dom.maxDrawdown.textContent = stats.maxDrawdownPercent.toFixed(2) + '%';
        dom.maxWinStreak.textContent = stats.maxWinStreak;
        dom.maxLoseStreak.textContent = stats.maxLoseStreak;
    }

    function updateHistoryList() {
        const history = TradingManager.getTradeHistory();
        dom.historyCount.textContent = history.length + ' 笔';
        if (history.length === 0) {
            dom.historyList.innerHTML = '<div class="history-empty">暂无交易记录</div>';
            return;
        }
        const reversed = [...history].reverse();
        const html = reversed.map(trade => {
            const entryTime = DataManager.formatTimeShort(trade.entryTime);
            const exitTime = DataManager.formatTimeShort(trade.exitTime);
            const sideText = trade.side === 'long' ? '多' : '空';
            const sideClass = trade.side === 'long' ? 'long' : 'short';
            const pnlClass = trade.pnl >= 0 ? 'profit' : 'loss';
            const pnlSign = trade.pnl >= 0 ? '+' : '';
            return `
                <div class="history-item slide-in-right">
                    <span class="history-time">${entryTime}-${exitTime}</span>
                    <span class="history-side ${sideClass}">${sideText}</span>
                    <span>${formatPrice(trade.entryPrice)}</span>
                    <span>${formatPrice(trade.exitPrice)}</span>
                    <span class="history-pnl ${pnlClass}">${pnlSign}${trade.pnlPercent.toFixed(1)}%</span>
                </div>
            `;
        }).join('');
        dom.historyList.innerHTML = html;
    }

    function updatePendingOrders() {
        const orders = TradingManager.getPendingOrders();
        if (orders.length === 0) {
            dom.pendingOrdersPanel.style.display = 'none';
            return;
        }
        dom.pendingOrdersPanel.style.display = 'block';
        const html = orders.map(order => {
            const typeText = order.type === 'limit' ? '限价' : '止损';
            const typeClass = order.type === 'limit' ? 'limit' : 'stop';
            const sideText = order.side === 'long' ? '多' : '空';
            const sideClass = order.side === 'long' ? 'long' : 'short';
            return `
                <div class="pending-order-item">
                    <span class="po-type ${typeClass}">${typeText}</span>
                    <span class="po-side ${sideClass}">${sideText}</span>
                    <span>${formatPrice(order.price)}</span>
                    <span>$${order.amount}</span>
                    <button class="pending-cancel-btn" onclick="App.cancelPendingOrder(${order.id})">取消</button>
                </div>
            `;
        }).join('');
        dom.pendingOrdersList.innerHTML = html;
    }

    /**
     * 在图表上为所有挂单绘制价格线（限价蓝虚线/止损橙虚线 + 其SL/TP点线）
     */
    function updatePendingOrderLines() {
        ChartManager.setPendingOrderLines(TradingManager.getPendingOrders());
    }

    function cancelPendingOrder(orderId) {
        TradingManager.cancelOrder(orderId);
        updatePendingOrders();
        updatePendingOrderLines();
        showNotification('挂单已取消', 'info');
    }

    function updateProgressBar(index) {
        const total = ReplayManager.getTotalBars();
        const percent = total > 0 ? (index / total) * 100 : 0;
        dom.progressBar.value = percent;
        dom.progressText.textContent = `${index} / ${total}`;
    }

    function updateStatusBar(bar) {
        if (!bar) return;
        dom.currentTime.textContent = DataManager.formatTime(bar.time);
        dom.openPrice.textContent = formatPrice(bar.open);
        dom.highPrice.textContent = formatPrice(bar.high);
        dom.lowPrice.textContent = formatPrice(bar.low);
        dom.closePrice.textContent = formatPrice(bar.close);
        dom.volumeValue.textContent = formatVolume(bar.volume);
        const closeEl = dom.closePrice;
        if (bar.close >= bar.open) {
            closeEl.classList.add('up');
            closeEl.classList.remove('down');
        } else {
            closeEl.classList.add('down');
            closeEl.classList.remove('up');
        }
    }

    function formatPrice(price) {
        const symbolConfig = DataManager.getSymbolConfig(currentSymbol);
        const decimals = symbolConfig?.decimals || 2;
        return price.toLocaleString('en-US', {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals
        });
    }

    function formatVolume(vol) {
        if (vol >= 1000000) return (vol / 1000000).toFixed(2) + 'M';
        if (vol >= 1000) return (vol / 1000).toFixed(2) + 'K';
        return vol.toString();
    }

    function getCloseReasonText(reason) {
        const reasons = {
            'manual': '手动平仓',
            'stop_loss': '止损平仓',
            'take_profit': '止盈平仓',
            'liquidation': '强制平仓'
        };
        return reasons[reason] || '平仓';
    }

    let notificationTimeout = null;
    function showNotification(message, type = 'info') {
        const el = dom.notification;
        el.textContent = message;
        el.className = `notification show ${type}`;
        if (notificationTimeout) clearTimeout(notificationTimeout);
        notificationTimeout = setTimeout(() => el.classList.remove('show'), 2500);
    }

    return { init, cancelPendingOrder };
})();

document.addEventListener('DOMContentLoaded', () => App.init());
