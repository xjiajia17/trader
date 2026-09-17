/**
 * ========================================
 * 数据管理层 (DataManager)
 * ========================================
 * 从金十数据 MCP 获取的真实K线数据加载
 * 支持多周期：1m, 5m, 15m, 30m, 1h, 4h
 * 无真实数据时回退到模拟数据
 */

const DataManager = (function() {
    'use strict';

    const TIMEFRAME_MAP = {
        '1m': 1,
        '5m': 5,
        '15m': 15,
        '30m': 30,
        '1h': 60,
        '4h': 240,
        '1d': 1440   // 日线：来自长期历史数据源（新浪外盘），不参与分钟聚合
    };

    // contractSize: 1手对应的标的数量；minLots: 最小手数
    const SYMBOLS = {
        'XAUUSD': { name: '现货黄金', decimals: 2, basePrice: 4300, spread: 0.30, contractSize: 100, minLots: 0.01 },
        'USOIL':  { name: 'WTI原油', decimals: 3, basePrice: 98, spread: 0.03, contractSize: 1000, minLots: 0.01 },
        'USDJPY': { name: '美元/日元', decimals: 3, basePrice: 155, spread: 0.015, contractSize: 100000, minLots: 0.01 },
        'EURUSD': { name: '欧元/美元', decimals: 5, basePrice: 1.15, spread: 0.0001, contractSize: 100000, minLots: 0.01 }
    };

    let dataCache = {};
    let currentSymbol = 'XAUUSD';
    let useMockData = false;

    // 本地数据服务地址（tools/data_service.py）。未启动时自动降级到静态文件。
    const SERVICE_URL = 'http://127.0.0.1:8090';
    // 长期历史接入后 /api/all 的响应可能有好几 MB，超时要放宽
    const SERVICE_TIMEOUT_MS = 15000;
    const INFO_TIMEOUT_MS = 2500;

    // 数据来源与元信息
    let dataSource = 'unknown';   // 'service' | 'static' | 'mock'
    let dataMeta = null;          // { count, firstBj, lastBj, staleMinutes, realGapCount, ... }
    let lastDataSignature = '';   // 用于判断数据是否发生变化

    let autoRefreshTimer = null;
    let autoRefreshCallback = null;

    /**
     * 过滤休市时段的"冻结K线"
     * TwelveData 等数据源在市场休市期间会返回 OHLC 几乎相同的K线（价格冻结），
     * 这些K线不是真实交易，在图表上表现为一条水平线，干扰分析。
     * 检测连续的低波动K线段并移除。
     */
    function filterDeadBars(bars) {
        if (!bars || bars.length < 30) return bars;

        // 用全数据中位数range作为正常波动的参考
        const ranges = bars.map(b => b.high - b.low).sort((a, b) => a - b);
        const medianRange = ranges[Math.floor(ranges.length / 2)];
        if (!(medianRange > 0)) return bars;

        // 冻结阈值：低于中位数range的15%，且绝对值也很小
        // （防止极端行情中正常K线被误删）
        const deadThreshold = Math.max(medianRange * 0.15, 0.0001);
        const MIN_DEAD_STREAK = 8; // 连续8根（40分钟）以上才算休市

        const result = [];
        let i = 0;
        while (i < bars.length) {
            const r = bars[i].high - bars[i].low;
            if (r < deadThreshold) {
                // 找到连续的冻结段
                let j = i;
                while (j < bars.length && (bars[j].high - bars[j].low) < deadThreshold) {
                    j++;
                }
                const streak = j - i;
                if (streak >= MIN_DEAD_STREAK) {
                    // 跳过整段冻结K线，保留前后正常K线
                    i = j;
                    continue;
                }
            }
            result.push(bars[i]);
            i++;
        }
        return result;
    }

    /**
     * 将金十JSON数据解析为lightweight-charts格式
     * 金十返回的OHLC是字符串，需要转为数字
     */
    function parseKlineData(raw) {
        if (!raw || !raw.klines || !Array.isArray(raw.klines)) return [];

        const seen = new Set();
        const bars = [];

        for (const k of raw.klines) {
            const time = parseInt(k.time);
            if (seen.has(time)) continue;
            seen.add(time);

            bars.push({
                time: time,
                open: parseFloat(k.open),
                high: parseFloat(k.high),
                low: parseFloat(k.low),
                close: parseFloat(k.close),
                volume: parseInt(k.volume) || 0
            });
        }

        bars.sort((a, b) => a.time - b.time);
        return filterDeadBars(bars);
    }

    /**
     * 异步加载真实数据文件（静态兜底路径）
     */
    async function loadRealData(symbol) {
        const timeframes = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
        const result = {};
        let latestUpdated = 0;

        for (const tf of timeframes) {
            try {
                const resp = await fetch(`data/${symbol}_${tf}.json?t=${Date.now()}`);
                if (resp.ok) {
                    const raw = await resp.json();
                    const bars = parseKlineData(raw);
                    if (bars.length > 0) {
                        result[tf] = bars;
                        // 只以分钟级文件的时间戳衡量新鲜度（日线每天才更新一次）
                        if (tf !== '1d' && raw && typeof raw.updated === 'number') {
                            latestUpdated = Math.max(latestUpdated, raw.updated);
                        }
                    }
                }
            } catch (e) {
                // 文件不存在或解析失败，跳过
            }
        }

        if (result['1m']) {
            const bars = result['1m'];
            dataMeta = {
                count: bars.length,
                firstBj: formatTime(bars[0].time),
                lastBj: formatTime(bars[bars.length - 1].time),
                staleMinutes: latestUpdated
                    ? Math.max(0, Math.floor((Date.now() / 1000 - latestUpdated) / 60))
                    : null,
                realGapCount: null
            };
        }
        return result;
    }

    // ===== 模拟数据兜底（真实数据不可用时使用）=====
    // 确定性随机：同一品种每次生成完全一致的数据，避免「每次刷新K线都变」的伪造感
    function hashSeed(str) {
        let h = 2166136261 >>> 0;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619) >>> 0;
        }
        return h >>> 0;
    }

    function makeRng(seed) {
        let s = (seed >>> 0) || 1;
        return function () {
            s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
            return s / 4294967296;
        };
    }

    function gaussianRandom(rng, mean = 0, stdev = 1) {
        const r = rng || Math.random;
        const u1 = Math.max(r(), 1e-9);
        const u2 = r();
        const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
        return z0 * stdev + mean;
    }

    function generateMockData(symbol, count = 800, startTime = null, intervalMinutes = 1) {
        const config = SYMBOLS[symbol] || SYMBOLS.XAUUSD;
        const basePrice = config.basePrice;
        const decimals = config.decimals;
        const volFactor = 1;
        const rng = makeRng(hashSeed(symbol + '_mock'));

        const step = intervalMinutes * 60;
        if (!startTime) {
            const nowSec = Math.floor(Date.now() / 1000);
            // 对齐到周期边界：同一周期内重复加载得到完全相同的数据
            startTime = Math.floor(nowSec / step) * step - count * step;
        }

        const bars = [];
        let price = basePrice;
        const phases = generatePhases(count, rng);

        for (let i = 0; i < count; i++) {
            const phase = phases[i];
            const volatility = 0.002 * volFactor * (1 + phase.volatilityBoost);
            const trendComponent = phase.trendStrength * volatility * 0.5;
            const randomComponent = gaussianRandom(rng, 0, volatility);
            const priceChange = trendComponent + randomComponent;

            const open = price;
            let close = price * (1 + priceChange);
            if (close < basePrice * 0.3) close = basePrice * 0.3;
            if (close > basePrice * 3) close = basePrice * 3;

            const wickVolatility = volatility * 0.6 * (0.5 + rng());
            let high = Math.max(open, close) * (1 + Math.abs(gaussianRandom(rng, 0, wickVolatility)));
            let low = Math.min(open, close) * (1 - Math.abs(gaussianRandom(rng, 0, wickVolatility)));
            high = Math.max(high, open, close);
            low = Math.min(low, open, close);

            const baseVolume = 1000;
            const priceMovePct = Math.abs(close - open) / open;
            const volume = Math.round(baseVolume * (0.5 + priceMovePct * 50 + rng() * 0.8) * (1 + phase.volumeBoost));

            const time = startTime + i * intervalMinutes * 60;
            const fmt = (p) => parseFloat(p.toFixed(decimals));

            bars.push({
                time: time,
                open: fmt(open), high: fmt(high), low: fmt(low), close: fmt(close),
                volume: volume
            });
            price = close;
        }
        return bars;
    }

    function generatePhases(totalBars, rng) {
        const r = rng || Math.random;
        const phases = [];
        let i = 0;
        while (i < totalBars) {
            const phaseLength = Math.floor(30 + r() * 120);
            const actualLength = Math.min(phaseLength, totalBars - i);
            const phaseType = r();
            let trendStrength = 0, volatilityBoost = 0, volumeBoost = 0;

            if (phaseType < 0.35) {
                trendStrength = 0.3 + r() * 0.7;
                volatilityBoost = 0.2 + r() * 0.3;
                volumeBoost = 0.3 + r() * 0.5;
            } else if (phaseType < 0.65) {
                trendStrength = -(0.3 + r() * 0.7);
                volatilityBoost = 0.3 + r() * 0.4;
                volumeBoost = 0.4 + r() * 0.6;
            } else if (phaseType < 0.85) {
                trendStrength = (r() - 0.5) * 0.2;
                volatilityBoost = -0.2 + r() * 0.2;
                volumeBoost = -0.3 + r() * 0.2;
            } else {
                trendStrength = (r() - 0.5) * 1.5;
                volatilityBoost = 0.8 + r() * 1.2;
                volumeBoost = 1.0 + r() * 1.5;
            }

            for (let j = 0; j < actualLength; j++) {
                const progress = j / actualLength;
                const fadeIn = Math.min(progress * 3, 1);
                const fadeOut = Math.min((1 - progress) * 3, 1);
                const fadeFactor = Math.min(fadeIn, fadeOut);
                const randomVariation = 1 + gaussianRandom(r, 0, 0.15);
                phases.push({
                    trendStrength: trendStrength * fadeFactor * randomVariation,
                    volatilityBoost: volatilityBoost * fadeFactor * Math.abs(randomVariation),
                    volumeBoost: volumeBoost * fadeFactor * Math.abs(randomVariation)
                });
            }
            i += actualLength;
        }
        return phases;
    }

    function aggregateBars(sourceData, targetMinutes) {
        if (targetMinutes <= 1) return sourceData;
        const result = [];
        let currentBar = null;
        let barStartTime = null;

        for (const bar of sourceData) {
            const barStart = Math.floor(bar.time / (targetMinutes * 60)) * targetMinutes * 60;
            if (barStart !== barStartTime) {
                if (currentBar) result.push(currentBar);
                currentBar = { ...bar, time: barStart };
                barStartTime = barStart;
            } else {
                currentBar.high = Math.max(currentBar.high, bar.high);
                currentBar.low = Math.min(currentBar.low, bar.low);
                currentBar.close = bar.close;
                currentBar.volume += bar.volume;
            }
        }
        if (currentBar) result.push(currentBar);
        return result;
    }

    function generateAllTimeframesMock(symbol) {
        const baseData = generateMockData(symbol, 800, null, 1);
        return {
            '1m': baseData,
            '5m': aggregateBars(baseData, 5),
            '15m': aggregateBars(baseData, 15),
            '30m': aggregateBars(baseData, 30),
            '1h': aggregateBars(baseData, 60),
            '4h': aggregateBars(baseData, 240)
        };
    }

    /**
     * 请求本地数据服务（未启动/超时会快速失败，不影响启动）
     */
    async function fetchService(symbol = currentSymbol, timeoutMs = SERVICE_TIMEOUT_MS) {
        if (typeof fetch !== 'function') return null;
        let timer = null;
        let opts;
        if (typeof AbortController === 'function') {
            const ctrl = new AbortController();
            opts = { signal: ctrl.signal };
            timer = setTimeout(() => ctrl.abort(), timeoutMs);
        }
        try {
            const resp = await fetch(`${SERVICE_URL}/api/all?symbol=${encodeURIComponent(symbol)}`, opts);
            if (!resp.ok) return null;
            const data = await resp.json();
            return (data && data.timeframes) ? data : null;
        } catch (e) {
            return null;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /**
     * 只取元信息（很轻量），用于轮询判断服务端数据是否变化
     */
    async function fetchInfo(symbol = currentSymbol) {
        if (typeof fetch !== 'function') return null;
        let timer = null;
        let opts;
        if (typeof AbortController === 'function') {
            const ctrl = new AbortController();
            opts = { signal: ctrl.signal };
            timer = setTimeout(() => ctrl.abort(), INFO_TIMEOUT_MS);
        }
        try {
            const resp = await fetch(`${SERVICE_URL}/api/info?symbol=${encodeURIComponent(symbol)}`, opts);
            if (!resp.ok) return null;
            const info = await resp.json();
            return (info && typeof info.count === 'number') ? info : null;
        } catch (e) {
            return null;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /**
     * 数据指纹：用于判断数据是否更新（根数 + 最后一根时间）
     */
    function computeSignature() {
        const b1 = dataCache['1m'];
        if (!b1 || !b1.length) return '';
        return `${b1.length}:${b1[b1.length - 1].time}`;
    }

    /**
     * 把服务返回的多周期数据写入缓存
     */
    function applyServicePayload(payload) {
        const tfs = {};
        let total = 0;
        for (const tf of Object.keys(TIMEFRAME_MAP)) {
            let bars = payload.timeframes[tf];
            if (Array.isArray(bars) && bars.length > 0) {
                // 服务端数据可能是 {time,open,high,low,close,volume} 数组，统一过滤冻结K线
                bars = filterDeadBars(bars);
                tfs[tf] = bars;
                total += bars.length;
            }
        }
        if (total === 0) return false;
        dataCache = tfs;
        dataMeta = payload.meta || null;
        lastDataSignature = computeSignature();
        return true;
    }

    /**
     * 初始化（异步）
     * 优先级：本地数据服务（最新+去重合并累积） → 静态文件 → 确定性模拟数据
     */
    async function init(symbol = 'XAUUSD') {
        currentSymbol = symbol;
        dataCache = {};
        useMockData = false;
        dataMeta = null;
        lastDataSignature = '';
        dataSource = 'unknown';

        // 1) 本地数据服务
        const svc = await fetchService(symbol);
        if (svc && applyServicePayload(svc)) {
            dataSource = 'service';
            logSummary('本地数据服务');
            return true;
        }

        // 2) 静态文件
        try {
            const realData = await loadRealData(symbol);
            if (Object.keys(realData).length > 0) {
                dataCache = realData;
                // 补全缺失周期：从1分钟数据聚合
                if (dataCache['1m'] && (!dataCache['5m'] || dataCache['5m'].length < 5)) {
                    dataCache['5m'] = aggregateBars(dataCache['1m'], 5);
                    dataCache['15m'] = aggregateBars(dataCache['1m'], 15);
                    dataCache['30m'] = aggregateBars(dataCache['1m'], 30);
                    dataCache['1h'] = aggregateBars(dataCache['1m'], 60);
                    dataCache['4h'] = aggregateBars(dataCache['1m'], 240);
                }
                dataSource = 'static';
                lastDataSignature = computeSignature();
                logSummary('静态文件');
                return true;
            }
        } catch (e) {
            console.warn('[DataManager] 加载静态数据失败:', e);
        }

        // 3) 确定性模拟数据（最后兜底）
        console.warn(`[DataManager] 无可用真实数据，使用「确定性模拟数据」(symbol=${symbol})`);
        useMockData = true;
        dataSource = 'mock';
        dataCache = generateAllTimeframesMock(symbol);
        lastDataSignature = computeSignature();
        logSummary('模拟数据(不可用于实盘)');
        return false;
    }

    function logSummary(label) {
        console.log(`[DataManager] 数据来源: ${label} (${currentSymbol})`);
        for (const tf of Object.keys(TIMEFRAME_MAP)) {
            console.log(`  ${tf}: ${dataCache[tf] ? dataCache[tf].length : 0} 根`);
        }
        if (dataMeta) {
            console.log(`  最新: ${dataMeta.lastBj || '-'}  ` +
                (dataMeta.staleMinutes !== null && dataMeta.staleMinutes !== undefined
                    ? `滞后 ${dataMeta.staleMinutes} 分钟` : ''));
        }
    }

    /**
     * 数据来源与元信息
     */
    function getDataInfo() {
        return {
            symbol: currentSymbol,
            source: dataSource,
            isMock: useMockData,
            meta: dataMeta,
            counts: Object.keys(TIMEFRAME_MAP).reduce((acc, tf) => {
                acc[tf] = dataCache[tf] ? dataCache[tf].length : 0;
                return acc;
            }, {})
        };
    }

    /**
     * 手动刷新一次（从数据服务拉取并合并到缓存）
     * @returns {boolean} 数据是否有变化
     */
    async function refreshFromService() {
        // 先问一次轻量元信息：服务端数据没变就不拉几 MB 的全量数据
        const info = await fetchInfo(currentSymbol);
        if (info && dataMeta && info.count === dataMeta.count && info.lastTime === dataMeta.lastTime) {
            return false;
        }
        const svc = await fetchService(currentSymbol);
        if (!svc) return false;
        const before = lastDataSignature;
        const ok = applyServicePayload(svc);
        if (!ok) return false;
        const changed = computeSignature() !== before;
        if (changed) {
            console.log(`[DataManager] 数据已更新：${dataMeta ? dataMeta.lastBj : ''}（${dataMeta ? dataMeta.count : ''} 根）`);
        }
        return changed;
    }

    /**
     * 启动自动更新轮询
     * @param {Function} onUpdate 数据变化回调 (info) => void
     * @param {number} intervalMs 轮询间隔（默认 60 秒；服务端每 5 分钟拉一次金十，前端轮询本地服务不消耗额度）
     */
    function startAutoRefresh(onUpdate, intervalMs = 60000) {
        stopAutoRefresh();
        autoRefreshCallback = typeof onUpdate === 'function' ? onUpdate : null;
        autoRefreshTimer = setInterval(async () => {
            const changed = await refreshFromService();
            if (changed && autoRefreshCallback) {
                try {
                    autoRefreshCallback(getDataInfo());
                } catch (e) {
                    console.error('[DataManager] 自动更新回调错误:', e);
                }
            }
        }, intervalMs);
    }

    function stopAutoRefresh() {
        if (autoRefreshTimer) {
            clearInterval(autoRefreshTimer);
            autoRefreshTimer = null;
        }
    }

    function getData(timeframe = '1m') {
        if (!dataCache[timeframe]) {
            console.warn(`[DataManager] 周期 ${timeframe} 数据不存在`);
            return [];
        }
        return dataCache[timeframe];
    }

    function getSymbol() { return currentSymbol; }

    function getSymbolConfig(symbol = currentSymbol) {
        return SYMBOLS[symbol] || SYMBOLS.XAUUSD;
    }

    async function setSymbol(symbol) {
        if (!SYMBOLS[symbol]) return false;
        await init(symbol);
        return true;
    }

    function getSupportedSymbols() {
        return Object.keys(SYMBOLS).map(key => ({
            symbol: key,
            name: SYMBOLS[key].name
        }));
    }

    function getSupportedTimeframes() {
        return Object.keys(TIMEFRAME_MAP);
    }

    function getTimeframeMinutes(timeframe) {
        return TIMEFRAME_MAP[timeframe] || 1;
    }

    function isUsingMockData() {
        return useMockData;
    }

    // 北京时间偏移（秒）：UTC+8
    const BEIJING_OFFSET = 8 * 3600;

    function formatTime(timestamp) {
        const date = new Date((timestamp + BEIJING_OFFSET) * 1000);
        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');
        const hours = String(date.getUTCHours()).padStart(2, '0');
        const minutes = String(date.getUTCMinutes()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}`;
    }

    function formatTimeShort(timestamp) {
        const date = new Date((timestamp + BEIJING_OFFSET) * 1000);
        const hours = String(date.getUTCHours()).padStart(2, '0');
        const minutes = String(date.getUTCMinutes()).padStart(2, '0');
        return `${hours}:${minutes}`;
    }

    return {
        init,
        getData,
        getSymbol,
        getSymbolConfig,
        setSymbol,
        getSupportedSymbols,
        getSupportedTimeframes,
        getTimeframeMinutes,
        isUsingMockData,
        getDataInfo,
        refreshFromService,
        startAutoRefresh,
        stopAutoRefresh,
        formatTime,
        formatTimeShort
    };
})();
