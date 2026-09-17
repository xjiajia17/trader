/**
 * ========================================
 * 回放控制引擎 (ReplayManager)
 * ========================================
 * 按时间间隔逐根弹出完整K线，不做形成动画
 * 支持播放/暂停、单步、进度跳转、间隔调节
 */

const ReplayManager = (function() {
    'use strict';

    let isPlaying = false;
    let currentIndex = 0;
    let totalBars = 0;
    let intervalMs = 500; // 每根K线弹出的间隔（毫秒）
    let data = [];
    let timerId = null;

    let callbacks = {
        onPlay: null,
        onPause: null,
        onReset: null,
        onIndexChange: null,
        onBarReveal: null,
        onFinish: null
    };

    function init(klineData) {
        data = klineData;
        totalBars = data.length;
        currentIndex = 0;
        isPlaying = false;
        stopTimer();
        console.log(`[ReplayManager] 初始化完成，共 ${totalBars} 根K线，间隔 ${intervalMs}ms`);
    }

    function play() {
        if (isPlaying) return;
        if (currentIndex >= totalBars) {
            reset();
        }

        isPlaying = true;

        if (currentIndex === 0) {
            revealNextBar();
        }

        if (currentIndex < totalBars) {
            startTimer();
        }

        triggerCallback('onPlay');
    }

    function pause() {
        if (!isPlaying) return;
        isPlaying = false;
        stopTimer();
        triggerCallback('onPause');
    }

    function togglePlay() {
        if (isPlaying) pause();
        else play();
    }

    function reset() {
        pause();
        currentIndex = 0;
        triggerCallback('onReset');
        triggerCallback('onIndexChange', currentIndex);
    }

    function nextBar() {
        if (currentIndex >= totalBars) return;
        pause();
        revealNextBar();
    }

    function prevBar() {
        if (currentIndex <= 1) return;
        pause();
        currentIndex--;
        triggerCallback('onIndexChange', currentIndex);
    }

    function seekTo(index) {
        if (index < 0) index = 0;
        if (index > totalBars) index = totalBars;
        pause();
        currentIndex = index;
        triggerCallback('onIndexChange', currentIndex);
    }

    function setReplayInterval(ms) {
        intervalMs = ms;
        if (isPlaying) {
            stopTimer();
            startTimer();
        }
    }

    function getInterval() {
        return intervalMs;
    }

    function startTimer() {
        stopTimer();
        timerId = setTimeout(function tick() {
            if (!isPlaying) return;
            if (currentIndex >= totalBars) {
                pause();
                triggerCallback('onFinish');
                return;
            }
            revealNextBar();
            if (isPlaying && currentIndex < totalBars) {
                timerId = setTimeout(tick, intervalMs);
            } else if (currentIndex >= totalBars) {
                pause();
                triggerCallback('onFinish');
            }
        }, intervalMs);
    }

    function stopTimer() {
        if (timerId) {
            clearTimeout(timerId);
            timerId = null;
        }
    }

    function revealNextBar() {
        if (currentIndex >= totalBars) return;
        const barIndex = currentIndex;
        const bar = data[barIndex];
        currentIndex++;

        triggerCallback('onBarReveal', barIndex, bar);
        triggerCallback('onIndexChange', currentIndex);
    }

    function triggerCallback(name, ...args) {
        if (typeof callbacks[name] === 'function') {
            try {
                callbacks[name](...args);
            } catch (e) {
                console.error(`[ReplayManager] 回调 ${name} 执行错误:`, e);
            }
        }
    }

    function on(eventName, callback) {
        if (callbacks.hasOwnProperty(eventName)) {
            callbacks[eventName] = callback;
        }
    }

    function getCurrentIndex() { return currentIndex; }
    function getTotalBars() { return totalBars; }
    function getProgress() { return totalBars === 0 ? 0 : currentIndex / totalBars; }
    function getIsPlaying() { return isPlaying; }

    return {
        init,
        play,
        pause,
        togglePlay,
        reset,
        nextBar,
        prevBar,
        seekTo,
        setReplayInterval,
        getInterval,
        on,
        getCurrentIndex,
        getTotalBars,
        getProgress,
        getIsPlaying
    };
})();
