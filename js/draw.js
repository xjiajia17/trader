/**
 * ========================================
 * 画图引擎 (DrawManager)
 * ========================================
 * 在主图上叠加 canvas，绘制趋势线/水平线/垂直线/矩形/斐波那契回撤
 * 点的水平位置用逻辑索引(logical)存储，垂直用价格存储，图表缩放/滚动时自动跟随
 */

const DrawManager = (function() {
    'use strict';

    let overlay = null;      // canvas 叠加层
    let ctx = null;
    let container = null;    // mainChart 容器
    let tool = 'cursor';     // 当前工具
    let drawings = [];       // 所有图形
    let selectedId = null;
    let nextId = 1;

    // 交互状态
    let drawing = null;      // 正在绘制中的图形（已确定第一个点）
    let dragTarget = null;   // 正在拖动的图形 { id, mode, dx, dyPrice, dLogical }
    let hoverId = null;
    let onToolChangeCallback = null; // 工具切换通知（画完自动切回光标时同步工具栏）
    let redrawCount = 0;             // 重绘次数（用于诊断图表滚动/缩放时画线是否跟随）

    const COLORS = {
        line: '#2962ff',
        selected: '#f0b90b',
        fib: '#f5a623',
        text: '#d1d4dc'
    };

    const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

    function init() {
        container = ChartManager.getMainChartEl();
        if (!container) return false;

        overlay = document.createElement('canvas');
        overlay.className = 'draw-overlay';
        container.appendChild(overlay);
        ctx = overlay.getContext('2d');

        bindEvents();
        setupResize();

        // 图表滚动/缩放时重绘
        ChartManager.onRangeChange(() => redraw());
        return true;
    }

    // overlay 是否拦截鼠标：绘图工具或悬停在已有图形上时才拦截
    function updatePointerEvents() {
        const active = tool !== 'cursor' || hoverId !== null;
        overlay.style.pointerEvents = active ? 'auto' : 'none';
    }

    function setupResize() {
        const ro = new ResizeObserver(() => {
            syncCanvasSize();
            redraw();
        });
        ro.observe(container);
        syncCanvasSize();
    }

    function syncCanvasSize() {
        const dpr = window.devicePixelRatio || 1;
        const w = container.clientWidth;
        const h = container.clientHeight;
        overlay.width = w * dpr;
        overlay.height = h * dpr;
        overlay.style.width = w + 'px';
        overlay.style.height = h + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function setTool(t) {
        tool = t;
        drawing = null;
        container.style.cursor = t === 'cursor' ? '' : 'crosshair';
        updatePointerEvents();
        redraw();
    }

    function getTool() { return tool; }

    function onToolChange(cb) {
        onToolChangeCallback = typeof cb === 'function' ? cb : null;
    }

    // ===== 坐标转换 =====
    function toLogical(x) { return ChartManager.xToLogical(x); }
    function toPrice(y) { return ChartManager.yToPrice(y); }
    function toX(logical) { return ChartManager.logicalToX(logical); }
    function toY(price) { return ChartManager.priceToY(price); }

    function localPos(e) {
        const rect = container.getBoundingClientRect();
        const src = (e.touches && e.touches[0]) ? e.touches[0] : e;
        return { x: src.clientX - rect.left, y: src.clientY - rect.top };
    }

    // ===== 命中检测 =====
    function distToSeg(px, py, x1, y1, x2, y2) {
        const dx = x2 - x1, dy = y2 - y1;
        const len2 = dx * dx + dy * dy;
        let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const cx = x1 + t * dx, cy = y1 + t * dy;
        return Math.hypot(px - cx, py - cy);
    }

    function hitTest(x, y) {
        const tol = 8;
        for (let i = drawings.length - 1; i >= 0; i--) {
            const d = drawings[i];
            const g = geometry(d);
            if (!g) continue;
            if (d.type === 'hline') {
                if (Math.abs(y - g.y1) < tol) return d;
            } else if (d.type === 'vline') {
                if (Math.abs(x - g.x1) < tol) return d;
            } else if (d.type === 'trendline') {
                if (distToSeg(x, y, g.x1, g.y1, g.x2, g.y2) < tol) return d;
            } else if (d.type === 'rect') {
                const inX = x >= Math.min(g.x1, g.x2) - tol && x <= Math.max(g.x1, g.x2) + tol;
                const inY = y >= Math.min(g.y1, g.y2) - tol && y <= Math.max(g.y1, g.y2) + tol;
                if (inX && inY) return d;
            } else if (d.type === 'fib') {
                // 命中任意一条水平比例线
                for (const lv of FIB_LEVELS) {
                    const yy = g.y1 + (g.y2 - g.y1) * lv;
                    if (Math.abs(y - yy) < tol && x >= Math.min(g.x1, g.x2) - tol && x <= Math.max(g.x1, g.x2) + tol) return d;
                }
            }
        }
        return null;
    }

    // 把存储点转成像素几何
    function geometry(d) {
        const x1 = toX(d.p1.logical), y1 = toY(d.p1.price);
        if (x1 === null || y1 === null) return null;
        if (d.type === 'hline') return { x1: 0, y1, x2: container.clientWidth, y2: y1 };
        if (d.type === 'vline') return { x1, y1: 0, x2: x1, y2: container.clientHeight };
        const x2 = toX(d.p2.logical), y2 = toY(d.p2.price);
        if (x2 === null || y2 === null) return null;
        return { x1, y1, x2, y2 };
    }

    // ===== 事件 =====
    function bindEvents() {
        // overlay 仅在拦截时接收 down；hover 检测走 container（cursor 模式下 overlay 不拦截）
        overlay.addEventListener('mousedown', onDown);
        overlay.addEventListener('touchstart', onDown, { passive: false });
        container.addEventListener('mousemove', onContainerHover);
        container.addEventListener('mousedown', onContainerDown);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', onUp);
    }

    // cursor 模式下在容器上检测悬停（overlay 此时 pointer-events:none，收不到事件）
    function onContainerHover(e) {
        if (tool !== 'cursor' || dragTarget) return;
        const pos = localPos(e);
        const hit = hitTest(pos.x, pos.y);
        const newHover = hit ? hit.id : null;
        if (newHover !== hoverId) {
            hoverId = newHover;
            updatePointerEvents();
            redraw();
        }
    }

    // cursor 模式下，在容器上按下且命中图形 → 开始拖动（overlay 不拦截时需从这里启动）
    function onContainerDown(e) {
        if (tool !== 'cursor') return;
        const pos = localPos(e);
        const hit = hitTest(pos.x, pos.y);
        selectedId = hit ? hit.id : null;
        if (hit) {
            const logical = toLogical(pos.x);
            const price = toPrice(pos.y);
            if (logical !== null && price !== null) {
                dragTarget = {
                    id: hit.id,
                    startLogical: logical,
                    startPrice: price,
                    orig: JSON.parse(JSON.stringify({ p1: hit.p1, p2: hit.p2 }))
                };
            }
            redraw();
        }
    }

    function onDown(e) {
        const pos = localPos(e);
        const logical = toLogical(pos.x);
        const price = toPrice(pos.y);

        if (tool === 'cursor') {
            const hit = hitTest(pos.x, pos.y);
            selectedId = hit ? hit.id : null;
            if (hit && logical !== null && price !== null) {
                dragTarget = {
                    id: hit.id,
                    startLogical: logical,
                    startPrice: price,
                    orig: JSON.parse(JSON.stringify({ p1: hit.p1, p2: hit.p2 }))
                };
            }
            redraw();
            return;
        }

        // 绘图工具
        if (logical === null || price === null) return;
        e.preventDefault();
        e.stopPropagation();

        const pt = { logical, price };
        if (tool === 'hline' || tool === 'vline') {
            drawings.push({ id: nextId++, type: tool, p1: pt });
            selectedId = drawings[drawings.length - 1].id;
            finishDraw();
            switchToCursor(); // 画完自动切回光标
            return;
        }
        // 两点图形
        if (!drawing) {
            drawing = { type: tool, p1: pt, p2: pt };
        }
    }

    function onMove(e) {
        const pos = localPos(e);

        // 拖动已有图形
        if (dragTarget) {
            const logical = toLogical(pos.x);
            const price = toPrice(pos.y);
            if (logical === null || price === null) return;
            const d = drawings.find(x => x.id === dragTarget.id);
            if (!d) { dragTarget = null; return; }
            const dLogical = logical - dragTarget.startLogical;
            const dPrice = price - dragTarget.startPrice;
            d.p1.logical = dragTarget.orig.p1.logical + dLogical;
            d.p1.price = dragTarget.orig.p1.price + dPrice;
            if (d.p2) {
                d.p2.logical = dragTarget.orig.p2.logical + dLogical;
                d.p2.price = dragTarget.orig.p2.price + dPrice;
            }
            redraw();
            return;
        }

        // 绘制中：更新第二个点
        if (drawing) {
            const logical = toLogical(pos.x);
            const price = toPrice(pos.y);
            if (logical !== null && price !== null) {
                drawing.p2 = { logical, price };
                redraw();
            }
            return;
        }

        // 悬停高亮（cursor 模式主要由 onContainerHover 处理，这里仅兜底）
        if (tool === 'cursor') {
            const hit = hitTest(pos.x, pos.y);
            const newHover = hit ? hit.id : null;
            if (newHover !== hoverId) {
                hoverId = newHover;
                updatePointerEvents();
                redraw();
            }
        }
    }

    function onUp() {
        if (dragTarget) { dragTarget = null; return; }
        if (drawing) {
            // 完成两点图形
            drawings.push({ id: nextId++, type: drawing.type, p1: drawing.p1, p2: drawing.p2 });
            selectedId = drawings[drawings.length - 1].id;
            finishDraw();
            switchToCursor(); // 画完自动切回十字光标
        }
    }

    function finishDraw() {
        drawing = null;
        redraw();
    }

    /**
     * 切回光标（选择）工具，并通知外部同步工具栏高亮
     */
    function switchToCursor() {
        tool = 'cursor';
        drawing = null;
        if (container) container.style.cursor = '';
        updatePointerEvents();
        redraw();
        if (onToolChangeCallback) onToolChangeCallback('cursor');
    }

    /**
     * 删除指定坐标下的图形（用于图表右键删除）
     * @param {number} x 相对图表容器的CSS像素X
     * @param {number} y 相对图表容器的CSS像素Y
     * @returns {boolean} 是否删除了图形
     */
    function deleteUnderPoint(x, y) {
        const hit = hitTest(x, y);
        if (!hit) return false;
        drawings = drawings.filter(d => d.id !== hit.id);
        if (selectedId === hit.id) selectedId = null;
        redraw();
        return true;
    }

    function deleteSelected() {
        if (selectedId === null) return;
        drawings = drawings.filter(d => d.id !== selectedId);
        selectedId = null;
        redraw();
    }

    function clearAll() {
        drawings = [];
        selectedId = null;
        drawing = null;
        redraw();
    }

    function getSelectedId() { return selectedId; }

    // ===== 绘制 =====
    function redraw() {
        if (!ctx) return;
        redrawCount++;
        ctx.clearRect(0, 0, container.clientWidth, container.clientHeight);
        for (const d of drawings) drawShape(d, d.id === selectedId);
        if (drawing) drawShape(drawing, true);
    }

    function drawShape(d, isSelected) {
        const g = geometry(d);
        if (!g) return;
        const color = isSelected ? COLORS.selected : COLORS.line;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = isSelected ? 2 : 1.5;

        if (d.type === 'hline') {
            line(0, g.y1, container.clientWidth, g.y1);
            label(formatP(d.p1.price), 6, g.y1 - 4, color);
        } else if (d.type === 'vline') {
            line(g.x1, 0, g.x1, container.clientHeight);
        } else if (d.type === 'trendline') {
            line(g.x1, g.y1, g.x2, g.y2);
            anchor(g.x1, g.y1); anchor(g.x2, g.y2);
        } else if (d.type === 'rect') {
            const x = Math.min(g.x1, g.x2), y = Math.min(g.y1, g.y2);
            const w = Math.abs(g.x2 - g.x1), h = Math.abs(g.y2 - g.y1);
            ctx.globalAlpha = 0.12;
            ctx.fillRect(x, y, w, h);
            ctx.globalAlpha = 1;
            ctx.strokeRect(x, y, w, h);
        } else if (d.type === 'fib') {
            drawFib(g, isSelected);
        }
        ctx.restore();
    }

    function drawFib(g, isSelected) {
        const x = Math.min(g.x1, g.x2), w = Math.abs(g.x2 - g.x1);
        const base = d_priceOf(g.y1); // 起点价格
        const top = d_priceOf(g.y2);
        ctx.font = '10px sans-serif';
        FIB_LEVELS.forEach((lv, idx) => {
            const yy = g.y1 + (g.y2 - g.y1) * lv;
            const price = base + (top - base) * lv;
            ctx.strokeStyle = isSelected ? COLORS.selected : COLORS.fib;
            ctx.lineWidth = idx === 0 || idx === FIB_LEVELS.length - 1 ? 1.5 : 1;
            ctx.setLineDash(idx === 0 || idx === FIB_LEVELS.length - 1 ? [] : [4, 3]);
            line(x, yy, x + w, yy);
            ctx.setLineDash([]);
            label(`${lv.toFixed(3)}  ${formatP(price)}`, x + w + 4, yy + 3, COLORS.text);
        });
        anchor(g.x1, g.y1); anchor(g.x2, g.y2);
    }

    function d_priceOf(y) {
        const p = toPrice(y);
        return p === null ? 0 : p;
    }

    function line(x1, y1, x2, y2) {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
    }

    function anchor(x, y) {
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
    }

    function label(text, x, y, color) {
        ctx.font = '10px sans-serif';
        ctx.fillStyle = color;
        ctx.fillText(text, x, y);
    }

    function formatP(p) {
        return typeof p === 'number' ? p.toFixed(2) : '--';
    }

    // 数据/视图变化时重绘（供外部调用）
    function refresh() { redraw(); }

    return {
        init, setTool, getTool, onToolChange, switchToCursor,
        deleteSelected, deleteUnderPoint, clearAll, getSelectedId,
        getCount: () => drawings.length,
        getRedrawCount: () => redrawCount,
        refresh
    };
})();
