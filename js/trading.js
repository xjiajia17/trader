/**
 * ========================================
 * 交易模拟系统 (TradingManager)
 * ========================================
 * 负责账户管理、开仓平仓、止损止盈、盈亏计算
 */

const TradingManager = (function() {
    'use strict';

    // 账户状态
    let balance = 10000; // 账户余额（美元）
    let initialBalance = 10000; // 初始资金
    let leverage = 100; // 杠杆倍数（上限 1000:1）

    // 合约规格：1手对应的标的数量（黄金100盎司/手，原油1000桶/手，外汇100000/手）
    let contractSize = 100;

    // 当前持仓
    let position = null;
    /* position 结构:
    {
        side: 'long' | 'short',
        entryPrice: number,
        size: number,        // 合约数量（美元价值）
        quantity: number,    // 标的数量
        margin: number,      // 占用保证金
        stopLoss: number | null,
        takeProfit: number | null,
        entryTime: number,
        entryBarIndex: number,
        fees: number         // 开仓手续费
    }
    */

    // 挂单列表
    let pendingOrders = [];
    /* pendingOrder 结构:
    {
        id: number,
        type: 'limit' | 'stop',     // limit=限价单（触及价成交）, stop=止损单（突破价成交）
        side: 'long' | 'short',
        price: number,              // 触发价
        amount: number,             // 开仓金额
        stopLoss: number | null,
        takeProfit: number | null,
        createTime: number,
        createBarIndex: number
    }
    */

    // 交易历史
    let tradeHistory = [];

    // 费用配置
    const config = {
        slippageRate: 0.0001,    // 滑点 0.01%
        feeRate: 0.00005,        // 手续费 0.005%
        liquidationThreshold: 0.8 // 强平阈值（保证金亏损达到80%时强平）
    };

    // 点差配置（各品种的点差，单位为价格）
    let spread = 0;

    // 当前价格
    let currentPrice = 0;

    // 拖动SL/TP期间挂起触发检查，避免拖动瞬间误触发平仓
    let suppressSLTPCheck = false;
    let currentBid = 0;
    let currentAsk = 0;
    let currentTime = 0;
    let currentBarIndex = 0;

    // 事件回调
    let callbacks = {
        onPositionOpen: null,
        onPositionClose: null,
        onPositionUpdate: null,
        onBalanceChange: null,
        onLiquidation: null,
        onOrderPlaced: null,
        onOrderCancelled: null,
        onOrderFilled: null
    };

    /**
     * 初始化
     */
    function init(initialBalance = 10000) {
        balance = initialBalance;
        initialBalance = initialBalance;
        position = null;
        tradeHistory = [];
        leverage = 100;
    }

    /**
     * 设置杠杆（最大支持 1000:1）
     */
    function setLeverage(lev) {
        if (lev < 1) lev = 1;
        if (lev > 1000) lev = 1000;
        leverage = lev;
    }

    /**
     * 获取杠杆
     */
    function getLeverage() {
        return leverage;
    }

    /**
     * 设置合约规格（1手对应标的数量）
     */
    function setContractSize(cs) {
        contractSize = cs > 0 ? cs : 0;
    }

    function getContractSize() {
        return contractSize;
    }

    /**
     * 由标的数量换算手数
     */
    function calcLots(quantity) {
        return contractSize > 0 ? quantity / contractSize : null;
    }

    /**
     * 设置点差
     */
    function setSpread(s) {
        spread = s;
    }

    function getSpread() {
        return spread;
    }

    function getCurrentPrice() {
        return currentPrice;
    }

    function getBid() {
        return currentPrice - spread / 2;
    }

    function getAsk() {
        return currentPrice + spread / 2;
    }

    /**
     * 更新当前价格（由回放引擎驱动）
     * @param {number} price 收盘价
     * @param {number} time K线时间
     * @param {number} barIndex K线索引
     * @param {object} [bar] 完整K线 {open,high,low,close}；传入后止损止盈/挂单按K线高低极值判定
     */
    function updatePrice(price, time, barIndex, bar) {
        currentPrice = price;
        currentBid = price - spread / 2;
        currentAsk = price + spread / 2;
        currentTime = time;
        currentBarIndex = barIndex;

        // 无完整K线时退化为用收盘价（仅高低=收盘）
        const ref = (bar && typeof bar.high === 'number' && typeof bar.low === 'number')
            ? bar
            : { open: price, high: price, low: price, close: price };

        // 检查挂单是否触发（按K线极值）
        if (pendingOrders.length > 0 && !position) {
            checkPendingOrders(ref);
        }

        // 如果有持仓，检查止损止盈（按K线高低极值）；拖动SL/TP期间挂起触发
        if (position && !suppressSLTPCheck) {
            checkStopLossTakeProfit(ref);
            if (position) checkLiquidation(ref);
        }
    }

    /**
     * 检查挂单是否触发（按K线高低极值判定，更贴近真实撮合）
     */
    function checkPendingOrders(bar) {
        const high = bar.high;
        const low = bar.low;
        const triggered = [];
        const remaining = [];

        for (const order of pendingOrders) {
            let shouldFill = false;
            if (order.type === 'limit') {
                // 限价买：价格下探到触发价及以下 → 成交
                // 限价卖：价格上冲到触发价及以上 → 成交
                if (order.side === 'long' && low <= order.price) shouldFill = true;
                if (order.side === 'short' && high >= order.price) shouldFill = true;
            } else if (order.type === 'stop') {
                // 止损买：价格上冲到触发价及以上 → 成交
                // 止损卖：价格下探到触发价及以下 → 成交
                if (order.side === 'long' && high >= order.price) shouldFill = true;
                if (order.side === 'short' && low <= order.price) shouldFill = true;
            }

            if (shouldFill) {
                triggered.push(order);
            } else {
                remaining.push(order);
            }
        }

        pendingOrders = remaining;

        for (const order of triggered) {
            fillOrder(order);
        }
    }

    /**
     * 执行挂单成交
     */
    function fillOrder(order) {
        const entryPrice = order.price;
        const quantity = order.amount / entryPrice;
        const marginRequired = order.amount / leverage;
        const openFee = order.amount * config.feeRate;

        if (marginRequired > balance) {
            triggerCallback('onOrderCancelled', { order, reason: '保证金不足' });
            return;
        }

        position = {
            side: order.side,
            entryPrice: entryPrice,
            size: order.amount,
            quantity: quantity,
            lots: calcLots(quantity),
            margin: marginRequired,
            stopLoss: order.stopLoss,
            takeProfit: order.takeProfit,
            entryTime: currentTime,
            entryBarIndex: currentBarIndex,
            fees: openFee
        };

        balance -= openFee;
        triggerCallback('onOrderFilled', { order, position });
        triggerCallback('onPositionOpen', position);
        triggerCallback('onBalanceChange', balance);
    }

    /**
     * 下挂单
     */
    function placeOrder(type, side, price, amount, stopLossPercent = null, takeProfitPercent = null) {
        if (position) {
            return { success: false, message: '已有持仓，无法下挂单' };
        }
        if (amount <= 0) {
            return { success: false, message: '金额必须大于0' };
        }
        if (price <= 0) {
            return { success: false, message: '价格必须大于0' };
        }

        let stopLoss = null;
        let takeProfit = null;

        if (stopLossPercent && stopLossPercent > 0) {
            if (side === 'long') {
                stopLoss = price * (1 - stopLossPercent / 100);
            } else {
                stopLoss = price * (1 + stopLossPercent / 100);
            }
        }
        if (takeProfitPercent && takeProfitPercent > 0) {
            if (side === 'long') {
                takeProfit = price * (1 + takeProfitPercent / 100);
            } else {
                takeProfit = price * (1 - takeProfitPercent / 100);
            }
        }

        const order = {
            id: Date.now(),
            type: type,
            side: side,
            price: price,
            amount: amount,
            stopLoss: stopLoss,
            takeProfit: takeProfit,
            createTime: currentTime,
            createBarIndex: currentBarIndex
        };

        pendingOrders.push(order);
        triggerCallback('onOrderPlaced', order);

        return { success: true, order: order };
    }

    /**
     * 取消挂单
     */
    function cancelOrder(orderId) {
        const idx = pendingOrders.findIndex(o => o.id === orderId);
        if (idx >= 0) {
            const order = pendingOrders.splice(idx, 1)[0];
            triggerCallback('onOrderCancelled', { order, reason: '手动取消' });
            return true;
        }
        return false;
    }

    /**
     * 获取所有挂单
     */
    function getPendingOrders() {
        return pendingOrders.slice();
    }

    /**
     * 更新挂单触发价（拖动挂单线）
     */
    function updateOrderPrice(orderId, newPrice, silent) {
        const order = pendingOrders.find(o => o.id === orderId);
        if (!order || !(newPrice > 0)) return false;
        order.price = newPrice;
        if (!silent) triggerCallback('onOrderPlaced', order);
        return true;
    }

    /**
     * 更新挂单的止损/止盈（拖动挂单SL/TP线）
     */
    function updateOrderSltp(orderId, key, newPrice, silent) {
        const order = pendingOrders.find(o => o.id === orderId);
        if (!order) return false;
        if (newPrice === null || newPrice <= 0) {
            order[key] = null;
        } else {
            order[key] = newPrice;
        }
        if (!silent) triggerCallback('onOrderPlaced', order);
        return true;
    }

    /**
     * 开仓
     * @param {string} side - 'long' 或 'short'
     * @param {number} amount - 开仓金额（美元）
     * @param {number} stopLossPercent - 止损百分比（可选）
     * @param {number} takeProfitPercent - 止盈百分比（可选）
     */
    function openPosition(side, amount, stopLossPercent = null, takeProfitPercent = null) {
        // 检查是否已有持仓
        if (position) {
            return { success: false, message: '已有持仓，请先平仓' };
        }

        // 检查金额
        if (amount <= 0) {
            return { success: false, message: '开仓金额必须大于0' };
        }

        // 计算所需保证金
        const marginRequired = amount / leverage;

        // 检查余额是否足够
        if (marginRequired > balance) {
            return { success: false, message: '保证金不足' };
        }

        // 计算滑点后的入场价
        const entryPrice = calculateEntryPrice(side, currentPrice);

        // 计算标的数量
        const quantity = amount / entryPrice;

        // 计算开仓手续费
        const openFee = amount * config.feeRate;

        // 计算止损止盈价
        let stopLoss = null;
        let takeProfit = null;

        if (stopLossPercent && stopLossPercent > 0) {
            if (side === 'long') {
                stopLoss = entryPrice * (1 - stopLossPercent / 100);
            } else {
                stopLoss = entryPrice * (1 + stopLossPercent / 100);
            }
        }

        if (takeProfitPercent && takeProfitPercent > 0) {
            if (side === 'long') {
                takeProfit = entryPrice * (1 + takeProfitPercent / 100);
            } else {
                takeProfit = entryPrice * (1 - takeProfitPercent / 100);
            }
        }

        // 创建持仓
        position = {
            side: side,
            entryPrice: entryPrice,
            size: amount,
            quantity: quantity,
            lots: calcLots(quantity),
            margin: marginRequired,
            stopLoss: stopLoss,
            takeProfit: takeProfit,
            entryTime: currentTime,
            entryBarIndex: currentBarIndex,
            fees: openFee
        };

        // 扣除手续费
        balance -= openFee;

        triggerCallback('onPositionOpen', position);
        triggerCallback('onBalanceChange', balance);

        return { success: true, position: position };
    }

    /**
     * 平仓
     * @param {string} reason 平仓原因
     * @param {number|null} exitPriceOverride 指定成交价（止损/止盈按设定价成交时使用）
     */
    function closePosition(reason = 'manual', exitPriceOverride = null) {
        if (!position) {
            return { success: false, message: '没有持仓' };
        }

        // 止损/止盈按「预先设定的SL/TP价格」成交；手动平仓/强平按当前价
        const exitPrice = (exitPriceOverride > 0) ? exitPriceOverride : currentPrice;

        // 计算盈亏
        const pnl = calculatePnL(position, exitPrice);
        const pnlPercent = (pnl / position.margin) * 100;

        // 计算平仓手续费
        const closeFee = position.size * config.feeRate;

        // 总盈亏（扣除手续费）
        const netPnL = pnl - closeFee;

        // 更新余额
        balance += position.margin + netPnL;

        // 确保余额不为负
        if (balance < 0) balance = 0;

        // 记录交易
        const trade = {
            id: tradeHistory.length + 1,
            side: position.side,
            entryPrice: position.entryPrice,
            exitPrice: exitPrice,
            size: position.size,
            quantity: position.quantity,
            margin: position.margin,
            entryTime: position.entryTime,
            exitTime: currentTime,
            entryBarIndex: position.entryBarIndex,
            exitBarIndex: currentBarIndex,
            pnl: netPnL,
            pnlPercent: pnlPercent,
            fees: position.fees + closeFee,
            reason: reason
        };

        tradeHistory.push(trade);

        // 清除持仓
        const closedPosition = { ...position };
        position = null;

        triggerCallback('onPositionClose', trade, closedPosition);
        triggerCallback('onBalanceChange', balance);

        return { success: true, trade: trade };
    }

    /**
     * 设置止损价
     */
    function setStopLoss(price) {
        if (!position) return false;

        if (price <= 0) {
            position.stopLoss = null;
        } else {
            position.stopLoss = price;
        }

        triggerCallback('onPositionUpdate', position);
        return true;
    }

    /**
     * 设置止盈价
     */
    function setTakeProfit(price) {
        if (!position) return false;

        if (price <= 0) {
            position.takeProfit = null;
        } else {
            position.takeProfit = price;
        }

        triggerCallback('onPositionUpdate', position);
        return true;
    }

    /**
     * 挂起/恢复 止损止盈触发检查（拖动SL/TP标签时调用，防止拖动瞬间误平仓）
     */
    function setSuppressSLTPCheck(flag) {
        suppressSLTPCheck = !!flag;
    }

    /**
     * 计算入场价
     * 市价单：直接以当前K线收盘价成交
     * 限价单：以指定价格成交
     */
    function calculateEntryPrice(side, price, orderType = 'market') {
        if (orderType === 'limit') {
            return price; // 限价单直接用指定价格
        }
        // 市价单：以收盘价成交（点差仅用于显示bid/ask，不影响实际成交价）
        return price;
    }

    /**
     * 计算浮动盈亏
     */
    function calculatePnL(pos, price) {
        if (pos.side === 'long') {
            return (price - pos.entryPrice) * pos.quantity;
        } else {
            return (pos.entryPrice - price) * pos.quantity;
        }
    }

    /**
     * 获取浮动盈亏（以当前收盘价计算）
     */
    function getFloatingPnL() {
        if (!position) return 0;
        return calculatePnL(position, currentPrice);
    }

    /**
     * 计算若在指定价格平仓的盈亏（用于拖动SL/TP时实时显示预期盈亏）
     */
    function calcPnLAt(price) {
        if (!position || !(price > 0)) return 0;
        return calculatePnL(position, price);
    }

    /**
     * 计算若在指定价格平仓的「净盈亏」= 毛盈亏 - 平仓手续费
     * 与 closePosition 实际入账金额一致，用于标签展示
     */
    function calcNetPnLAt(price) {
        if (!position || !(price > 0)) return 0;
        const gross = calculatePnL(position, price);
        const closeFee = position.size * config.feeRate;
        return gross - closeFee;
    }

    /**
     * 计算某个挂单若在指定价格成交并平仓可得的净盈亏
     * （手续费按开仓+平仓双边计）
     */
    function calcOrderNetPnLAt(order, exitPrice) {
        if (!order || !(exitPrice > 0) || !(order.price > 0)) return 0;
        const quantity = order.amount / order.price;
        const gross = order.side === 'long'
            ? (exitPrice - order.price) * quantity
            : (order.price - exitPrice) * quantity;
        const fee = order.amount * config.feeRate * 2;
        return gross - fee;
    }

    /**
     * 获取浮动盈亏百分比
     */
    function getFloatingPnLPercent() {
        if (!position || position.margin === 0) return 0;
        const pnl = getFloatingPnL();
        return (pnl / position.margin) * 100;
    }

    /**
     * 检查止损止盈（按K线最高/最低价判定，触发后按预设SL/TP价成交）
     * 同一根K线内两者都可能被触及，采取「保守假设」：优先判定止损
     */
    function checkStopLossTakeProfit(bar) {
        if (!position) return;
        const high = bar.high;
        const low = bar.low;

        if (position.side === 'long') {
            // 多单：下影线触及止损，上影线触及止盈
            if (position.stopLoss && low <= position.stopLoss) {
                closePosition('stop_loss', position.stopLoss);
                return;
            }
            if (position.takeProfit && high >= position.takeProfit) {
                closePosition('take_profit', position.takeProfit);
                return;
            }
        } else {
            // 空单：上影线触及止损，下影线触及止盈
            if (position.stopLoss && high >= position.stopLoss) {
                closePosition('stop_loss', position.stopLoss);
                return;
            }
            if (position.takeProfit && low <= position.takeProfit) {
                closePosition('take_profit', position.takeProfit);
                return;
            }
        }
    }

    /**
     * 检查强制平仓（按对持仓最不利的极值价判定）
     */
    function checkLiquidation(bar) {
        if (!position) return;

        // 多单取最低价，空单取最高价
        const worstPrice = position.side === 'long' ? bar.low : bar.high;
        const pnl = calculatePnL(position, worstPrice);
        const lossPercent = -pnl / position.margin;

        // 亏损超过保证金的一定比例时强平
        if (lossPercent >= config.liquidationThreshold) {
            closePosition('liquidation');
            triggerCallback('onLiquidation', {
                lossPercent: lossPercent * 100,
                price: worstPrice
            });
        }
    }

    /**
     * 获取账户权益（余额 + 浮动盈亏）
     */
    function getEquity() {
        return balance + getFloatingPnL();
    }

    /**
     * 获取可用保证金
     */
    function getAvailableMargin() {
        if (!position) {
            return balance;
        }
        return balance - position.margin + getFloatingPnL();
    }

    /**
     * 获取已用保证金
     */
    function getUsedMargin() {
        if (!position) return 0;
        return position.margin;
    }

    /**
     * 获取当前持仓
     */
    function getPosition() {
        return position;
    }

    /**
     * 获取账户余额
     */
    function getBalance() {
        return balance;
    }

    /**
     * 获取初始余额
     */
    function getInitialBalance() {
        return initialBalance;
    }

    /**
     * 获取交易历史
     */
    function getTradeHistory() {
        return tradeHistory;
    }

    /**
     * 获取总盈亏
     */
    function getTotalPnL() {
        return balance - initialBalance;
    }

    /**
     * 获取总盈亏百分比
     */
    function getTotalPnLPercent() {
        return ((balance - initialBalance) / initialBalance) * 100;
    }

    /**
     * 注册事件回调
     */
    function on(eventName, callback) {
        if (callbacks.hasOwnProperty(eventName)) {
            callbacks[eventName] = callback;
        }
    }

    /**
     * 触发回调
     */
    function triggerCallback(name, ...args) {
        if (typeof callbacks[name] === 'function') {
            try {
                callbacks[name](...args);
            } catch (e) {
                console.error(`[TradingManager] 回调 ${name} 执行错误:`, e);
            }
        }
    }

    /**
     * 重置账户
     */
    function reset() {
        balance = initialBalance;
        position = null;
        pendingOrders = [];
        tradeHistory = [];
        triggerCallback('onBalanceChange', balance);
        triggerCallback('onPositionClose', null, null);
    }

    // 公开接口
    return {
        init,
        setLeverage,
        getLeverage,
        setContractSize,
        getContractSize,
        calcLots,
        setSpread,
        getSpread,
        getCurrentPrice,
        getBid,
        getAsk,
        updatePrice,
        openPosition,
        closePosition,
        setStopLoss,
        setTakeProfit,
        setSuppressSLTPCheck,
        placeOrder,
        cancelOrder,
        getPendingOrders,
        updateOrderPrice,
        updateOrderSltp,
        getFloatingPnL,
        calcPnLAt,
        calcNetPnLAt,
        calcOrderNetPnLAt,
        getFloatingPnLPercent,
        getEquity,
        getAvailableMargin,
        getUsedMargin,
        getPosition,
        getBalance,
        getInitialBalance,
        getTradeHistory,
        getTotalPnL,
        getTotalPnLPercent,
        on,
        reset
    };
})();
