#!/usr/bin/env python3
"""
========================================
K线数据服务 (data_service.py)
========================================
职责：
  1. 从金十数据拉取最新 1 分钟 K 线
  2. 与本地累积的历史数据「按时间戳去重合并」（同一根K线用最新值覆盖，处理正在形成的K线）
  3. 缺口检测 + 自动修复（对缺口调用 time 参数回溯补齐）
  4. 持久化到 data/store/，并导出前端可直接读取的 data/{symbol}_{tf}.json
  5. 定时自动更新（默认 5 分钟）
  6. 提供带 CORS 的 HTTP API 供前端调用

启动：
  python3 tools/data_service.py                 # 默认 8090 端口，5 分钟刷新
  python3 tools/data_service.py --port 8090 --interval 300
  python3 tools/data_service.py --once          # 只更新一次后退出（可用于定时任务）
  python3 tools/data_service.py --backfill-td 365   # 回溯 1 年 5 分钟现货金历史（TwelveData）

API：
  GET  /api/health                       健康检查与统计
  GET  /api/info?symbol=XAUUSD           数据元信息（根数/时间范围/缺口/来源）
  GET  /api/klines?symbol=XAUUSD&tf=1m   指定周期K线
  GET  /api/all?symbol=XAUUSD            全部周期一次返回（前端推荐）
  POST /api/refresh?symbol=XAUUSD        立即刷新
  POST /api/backfill?symbol=XAUUSD&hours=24     回溯补齐历史（金十 1m）
  POST /api/backfilltd?symbol=XAUUSD&days=365   回溯 5m 长期历史（TwelveData 现货金）
  POST /api/backfill5m?symbol=XAUUSD&days=90    回溯 5m 长期历史（币安黄金代币，备选）

数据来源优先级：
  1m        ：金十数据（唯一实时源，逐分钟累积）
  5m~4h     ：TwelveData XAU/USD 长期历史为底 + 金十最新聚合覆盖
  1d        ：新浪外盘（黄金 2006 年起，约 20 年）
"""

import argparse
import bisect
import json
import os
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ==================== 配置 ====================
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
STORE_DIR = os.path.join(DATA_DIR, "store")
QUOTA_FILE = os.path.join(STORE_DIR, "_quota.json")


def _find_jin10_dir():
    """定位金十数据 skill 目录（不同机器路径不同，按候选顺序探测；可用 JIN10_SKILL_DIR 指定）"""
    cands = [
        os.environ.get("JIN10_SKILL_DIR", ""),
        os.path.join(BASE_DIR, ".trae", "skills", "jin10-data"),
        os.path.join(os.path.dirname(BASE_DIR), ".trae", "skills", "jin10-data"),
        os.path.expanduser("~/Documents/trae_projects/.trae/skills/jin10-data"),
    ]
    for c in cands:
        if c and os.path.isfile(os.path.join(c, "jin10_mcp_client.py")):
            return c
    return cands[1]


JIN10_DIR = _find_jin10_dir()

SYMBOLS = ["XAUUSD", "USOIL", "USDJPY", "EURUSD"]
# 日内周期：由 1 分钟数据聚合得到
TIMEFRAMES = [("1m", 1), ("5m", 5), ("15m", 15), ("30m", 30), ("1h", 60), ("4h", 240)]

# 长期日线来源：新浪外盘（免费、无需 Key）。
# 黄金 XAU 可回溯到 2006 年（约 20 年，5000+ 根日线）
SINA_DAILY_MAP = {
    "XAUUSD": "XAU",   # 伦敦金现
    "USOIL": "OIL",    # 美原油
    "USDJPY": None,    # 新浪外盘无现货外汇日线，仅靠金十累积
    "EURUSD": None,
}
SINA_DAILY_URL = ("https://stock2.finance.sina.com.cn/futures/api/jsonp.php/"
                  "var%20t=/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol={code}")
DAILY_REFETCH_SEC = 6 * 3600   # 日线最多每 6 小时重取一次

# ===== 5 分钟长期历史：币安黄金背书代币 =====
# 币安 K 线接口免费、无需 Key、单次 1000 根且支持 startTime 分页，可回溯任意久。
# PAXG/XAUT 为 1:1 实物黄金背书代币，实测与金十现货金价差约 +0.03%。
# 注意：它是代币、7×24 连续交易（无每日休市），微观结构与现货金略有差异，仅作历史补全用。
BINANCE_PAIR_MAP = {
    "XAUUSD": "PAXGUSDT",
    "USOIL": None,      # 币安无原油类代币
    "USDJPY": None,
    "EURUSD": None,
}
BINANCE_KLINES_URL = "https://api.binance.com/api/v3/klines"
BINANCE_MAX_CALLS = 400        # 单次回溯最多请求数（1000根/次 → 约 40 万根 5m）

# ===== 5 分钟长期历史（首选来源）：TwelveData 现货黄金 =====
# TwelveData 的 XAU/USD 就是伦敦金现货报价，与金十/新浪的现货金同源。
# 免费 Basic 版：800 次/天、8 次/分钟；单次最多 4999 根；支持 start_date/end_date 分页。
#
# API Key 不写死在代码里（避免提交到公开仓库），按以下顺序读取：
#   1) 环境变量 TWELVEDATA_KEY
#   2) tools/secret.local.json 里的 {"twelvedata_key": "..."}（该文件已被 .gitignore 忽略）
TWELVEDATA_URL = "https://api.twelvedata.com/time_series"


def _load_twelvedata_key():
    key = (os.environ.get("TWELVEDATA_KEY") or "").strip()
    if key:
        return key
    local = os.path.join(os.path.dirname(os.path.abspath(__file__)), "secret.local.json")
    try:
        with open(local) as f:
            return (json.load(f) or {}).get("twelvedata_key", "").strip()
    except Exception:
        return ""


TWELVEDATA_KEY = _load_twelvedata_key()
TWELVEDATA_MAP = {
    "XAUUSD": "XAU/USD",
    "EURUSD": "EUR/USD",
    "USOIL": None,      # 免费版无 WTI 现货
    "USDJPY": None,     # 免费版无现货日元
}
TWELVEDATA_MAX_CALLS = 120      # 单次回溯最多请求数
TWELVEDATA_RATE_SEC = 12.0      # 免费版限制 8 次/分钟，实际放宽间隔以减少限速/超时
# 每页日历天数：实测响应体积超过约 320KB 就会大面积超时，
# 10 天 ≈ 2880 根 ≈ 320KB 是稳定上限；失败时再自动二分拆分。
TWELVEDATA_PAGE_DAYS = 10
TWELVEDATA_MIN_SPLIT_DAYS = 2   # 拆分到小于该跨度仍失败就跳过
TWELVEDATA_PAGE_TRY = 3         # 单页失败重试次数
_td_last_call = [0.0]
_td_key_warned = [False]        # 未配置 Key 的提示只打一次

DAILY_CALL_LIMIT = 1500          # 金十每日调用上限（留安全余量）
DAILY_CALL_SAFE = 1350           # 实际用到这里就停止刷新
ACTIVE_WINDOW_SEC = 1800         # 某品种在此时长内被请求过才自动刷新
BACKFILL_MAX_CALLS = 10          # 单次回溯最大调用次数（防止刷爆额度）

BJ = timezone(timedelta(hours=8))

sys.path.insert(0, JIN10_DIR)
try:
    import jin10_mcp_client as j10
except Exception as e:  # pragma: no cover
    print(f"[FATAL] 无法导入金十客户端: {e}")
    j10 = None

_lock = threading.RLock()
_active = {}          # symbol -> last_request_ts
_quota = {"date": "", "count": 0}
_stats = {"lastRefresh": None, "lastError": None, "refreshes": 0, "calls": 0}


# ==================== 工具函数 ====================
def now_bj():
    return datetime.now(BJ)


def bj_str(ts):
    if not ts:
        return ""
    return datetime.fromtimestamp(ts, BJ).strftime("%Y-%m-%d %H:%M")


def log(msg):
    print(f"[{now_bj().strftime('%H:%M:%S')}] {msg}", flush=True)


def load_quota():
    """加载每日调用计数（跨重启持久化）"""
    global _quota
    today = now_bj().strftime("%Y-%m-%d")
    try:
        with open(QUOTA_FILE) as f:
            q = json.load(f)
        if q.get("date") == today:
            _quota = q
        else:
            _quota = {"date": today, "count": 0}
    except Exception:
        _quota = {"date": today, "count": 0}


def save_quota():
    ensure_dirs()
    tmp = QUOTA_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(_quota, f)
    os.replace(tmp, QUOTA_FILE)


def quota_available():
    today = now_bj().strftime("%Y-%m-%d")
    if _quota.get("date") != today:
        _quota["date"] = today
        _quota["count"] = 0
    return _quota["count"] < DAILY_CALL_SAFE


def ensure_dirs():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(STORE_DIR, exist_ok=True)


def atomic_write_json(path, obj):
    ensure_dirs()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


# ==================== 金十拉取 ====================
def _find_klines(obj, depth=0):
    """递归查找响应中的 klines 数组（金十返回层级为 {structuredContent:{data:{klines}}}）"""
    if obj is None or depth > 6:
        return None
    if isinstance(obj, dict):
        if isinstance(obj.get("klines"), list):
            return obj["klines"]
        for v in obj.values():
            found = _find_klines(v, depth + 1)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for v in obj:
            found = _find_klines(v, depth + 1)
            if found is not None:
                return found
    elif isinstance(obj, str):
        s = obj.strip()
        if s[:1] in "{[":
            try:
                return _find_klines(json.loads(s), depth + 1)
            except Exception:
                return None
    return None


def fetch_klines(symbol, at_time=None, count=100):
    """调用金十 get_kline。at_time 为整数秒时，返回以该时间结尾的 count 根K线。"""
    if j10 is None:
        return None
    if not quota_available():
        _stats["lastError"] = "今日金十调用额度已用尽，暂停刷新"
        return None
    args = {"code": symbol, "count": count}
    if at_time:
        args["time"] = int(at_time)
    try:
        res = j10.call_tool("get_kline", args)
    except Exception as e:
        _stats["lastError"] = f"调用异常: {e}"
        return None
    _quota["count"] += 1
    _stats["calls"] += 1
    save_quota()

    kl = _find_klines(res)
    if not kl:
        _stats["lastError"] = "响应中未找到 klines 数据"
        return None

    bars = []
    for k in kl:
        try:
            bars.append({
                "time": int(k["time"]),
                "open": float(k["open"]),
                "high": float(k["high"]),
                "low": float(k["low"]),
                "close": float(k["close"]),
                "volume": int(float(k.get("volume", 0))),
            })
        except (KeyError, TypeError, ValueError):
            continue
    # 金十返回为倒序（新→旧），统一升序
    bars.sort(key=lambda b: b["time"])
    return bars or None


# ==================== 长期日线（新浪外盘） ====================
_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")
_daily_last_fetch = {}   # symbol -> ts


def http_get(url, referer="https://finance.sina.com.cn/", timeout=25):
    req = urllib.request.Request(url, headers={
        "User-Agent": _UA, "Referer": referer,
        "Accept": "application/json,text/plain,*/*",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", "ignore")
    except Exception as e:
        _stats["lastError"] = f"HTTP 拉取失败: {e}"
        return None


def _extract_jsonp(body):
    """解析 var t=([...]); / var _=({...}); 形式的 JSONP"""
    if not body:
        return None
    m = re.search(r"=\s*\(?\s*(\[.*?\]|\{.*?\}|null)\s*\)?\s*;?\s*$", body.strip(), re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except Exception:
        return None


def daily_store_path(symbol):
    return os.path.join(STORE_DIR, f"{symbol}_1d.json")


def load_daily_store(symbol):
    try:
        with open(daily_store_path(symbol)) as f:
            obj = json.load(f)
        bars = obj.get("bars") if isinstance(obj, dict) else obj
        return bars if isinstance(bars, list) else []
    except Exception:
        return []


def save_daily_store(symbol, bars):
    atomic_write_json(daily_store_path(symbol), {
        "symbol": symbol, "tf": "1d", "source": "sina",
        "updated": int(time.time()),
        "updated_bj": now_bj().strftime("%Y-%m-%d %H:%M:%S"),
        "count": len(bars), "bars": bars,
    })
    # 同时导出前端可直接读取的静态文件
    atomic_write_json(os.path.join(DATA_DIR, f"{symbol}_1d.json"), {
        "symbol": symbol, "tf": "1d", "source": "sina",
        "updated": int(time.time()), "klines": bars,
    })


def fetch_sina_daily(symbol):
    """从新浪外盘获取长期日线历史（黄金可回溯约 20 年）"""
    code = SINA_DAILY_MAP.get(symbol)
    if not code:
        return []
    body = http_get(SINA_DAILY_URL.format(code=code))
    arr = _extract_jsonp(body)
    if not isinstance(arr, list) or not arr:
        return []
    bars = []
    for k in arr:
        try:
            dt = datetime.strptime(str(k["date"])[:10], "%Y-%m-%d").replace(tzinfo=BJ)
            bars.append({
                "time": int(dt.timestamp()),
                "open": float(k["open"]), "high": float(k["high"]),
                "low": float(k["low"]), "close": float(k["close"]),
                "volume": int(float(k.get("volume") or 0)),
            })
        except (KeyError, TypeError, ValueError):
            continue
    bars.sort(key=lambda b: b["time"])
    return bars


def refresh_daily(symbol, force=False):
    """确保日线历史存在（受 DAILY_REFETCH_SEC 节流，不消耗金十额度）"""
    code = SINA_DAILY_MAP.get(symbol)
    if not code:
        return []
    last = _daily_last_fetch.get(symbol, 0)
    existing = load_daily_store(symbol)
    if existing and not force and (time.time() - last) < DAILY_REFETCH_SEC:
        return existing
    if not existing and (time.time() - last) < 60:
        return existing  # 刚失败过，避免频繁重试

    _daily_last_fetch[symbol] = time.time()
    bars = fetch_sina_daily(symbol)
    if not bars:
        log(f"[{symbol}] 日线获取失败（{_stats.get('lastError')}），沿用已有 {len(existing)} 根")
        return existing
    # 与既有日线合并去重（当日K线可能还在形成中）
    merged = merge_bars(existing, bars) if existing else bars
    save_daily_store(symbol, merged)
    log(f"[{symbol}] 日线已更新：{len(merged)} 根 "
        f"({merged[0]['time'] and bj_str(merged[0]['time'])} ~ {bj_str(merged[-1]['time'])}，来源 新浪)")
    return merged


# ==================== 5 分钟长期历史（币安黄金代币） ====================
_ext_cache = {}   # 文件路径 -> (mtime, bars)，长期历史文件很大，避免每次刷新重复解析


def _load_ext_json(path):
    """带 mtime 缓存的长期历史读取"""
    try:
        mt = os.path.getmtime(path)
    except OSError:
        return []
    hit = _ext_cache.get(path)
    if hit is not None and hit[0] == mt:
        return hit[1]
    bars = []
    try:
        with open(path) as f:
            obj = json.load(f)
        b = obj.get("bars") if isinstance(obj, dict) else obj
        if isinstance(b, list):
            bars = b
    except Exception:
        bars = []
    _ext_cache[path] = (mt, bars)
    return bars


def ext5m_store_path(symbol):
    return os.path.join(STORE_DIR, f"{symbol}_5m_ext.json")


def load_ext5m_store(symbol):
    return _load_ext_json(ext5m_store_path(symbol))


def save_ext5m_store(symbol, bars, pair):
    path = ext5m_store_path(symbol)
    atomic_write_json(path, {
        "symbol": symbol, "tf": "5m", "source": f"binance:{pair}",
        "updated": int(time.time()),
        "updated_bj": now_bj().strftime("%Y-%m-%d %H:%M:%S"),
        "count": len(bars), "bars": bars,
    })
    _ext_cache.pop(path, None)


def fetch_binance_5m(symbol, days=90):
    """分页拉取币安 5m K线（1000 根/次，可回溯任意久）"""
    pair = BINANCE_PAIR_MAP.get(symbol)
    if not pair:
        return []
    now_ms = int(time.time() * 1000)
    cursor = now_ms - int(days * 86400 * 1000)
    step_ms = 5 * 60 * 1000
    out = []
    calls = 0
    while cursor < now_ms and calls < BINANCE_MAX_CALLS:
        url = (f"{BINANCE_KLINES_URL}?symbol={pair}&interval=5m"
               f"&startTime={cursor}&limit=1000")
        body = http_get(url, referer="https://www.binance.com/", timeout=20)
        if not body or not body.lstrip().startswith("["):
            _stats["lastError"] = f"币安返回异常: {str(body)[:80]}"
            break
        try:
            arr = json.loads(body)
        except Exception:
            break
        if not arr:
            break
        for k in arr:
            try:
                out.append({
                    "time": int(k[0]) // 1000,
                    "open": float(k[1]), "high": float(k[2]),
                    "low": float(k[3]), "close": float(k[4]),
                    "volume": int(float(k[5])),
                })
            except (IndexError, TypeError, ValueError):
                continue
        calls += 1
        if len(arr) < 1000:
            break
        cursor = int(arr[-1][0]) + step_ms
    log(f"[{symbol}] 币安 5m 拉取：{len(out)} 根（请求 {calls} 次，pair={pair}）")
    return out


def backfill_5m(symbol, days=90):
    """回溯 5 分钟长期历史（币安），与既有数据去重合并"""
    pair = BINANCE_PAIR_MAP.get(symbol)
    if not pair:
        log(f"[{symbol}] 无对应的币安黄金代币标的，跳过 5m 回溯")
        return []
    fresh = fetch_binance_5m(symbol, days=days)
    if not fresh:
        return load_ext5m_store(symbol)
    merged = merge_bars(load_ext5m_store(symbol), fresh)
    save_ext5m_store(symbol, merged, pair)
    export_static(symbol, load_store(symbol))
    log(f"[{symbol}] 5m 长期历史已保存：{len(merged)} 根 "
        f"({bj_str(merged[0]['time'])} ~ {bj_str(merged[-1]['time'])}，来源 币安 {pair})")
    return merged


# ==================== 5 分钟长期历史（首选：TwelveData 现货金） ====================
def td_in_session(ts):
    """
    现货金/外汇的真实交易时段（UTC）：
      周五 21:00 UTC 收盘 → 周日 22:00 UTC 开盘，其间休市。
    实测 TwelveData 在休市时段仍会返回「近乎冻结」的填充K线
    （周末振幅只有工作日的 1/10、成交量为 0），这类假K线在回放里
    就是一大段不动的横线，直接丢弃。
    """
    d = datetime.fromtimestamp(ts, timezone.utc)
    wd, hm = d.weekday(), d.hour * 60 + d.minute
    if wd == 5:                      # 周六全天休市
        return False
    if wd == 6 and hm < 22 * 60:     # 周日 22:00 UTC 前休市
        return False
    if wd == 4 and hm >= 21 * 60:    # 周五 21:00 UTC 后休市
        return False
    return True


def ext5m_td_store_path(symbol):
    return os.path.join(STORE_DIR, f"{symbol}_5m_td.json")


def load_ext5m_td_store(symbol):
    return [b for b in _load_ext_json(ext5m_td_store_path(symbol)) if td_in_session(b["time"])]


def save_ext5m_td_store(symbol, bars, api_symbol):
    bars = [b for b in bars if td_in_session(b["time"])]
    path = ext5m_td_store_path(symbol)
    atomic_write_json(path, {
        "symbol": symbol, "tf": "5m", "source": f"twelvedata:{api_symbol}",
        "updated": int(time.time()),
        "updated_bj": now_bj().strftime("%Y-%m-%d %H:%M:%S"),
        "count": len(bars), "bars": bars,
    })
    _ext_cache.pop(path, None)


def _td_rate_wait():
    """TwelveData 免费版限速 8 次/分钟 —— 所有请求统一排队"""
    gap = TWELVEDATA_RATE_SEC - (time.time() - _td_last_call[0])
    if gap > 0:
        time.sleep(gap)
    _td_last_call[0] = time.time()


def _td_request(params, timeout=60):
    """带限速与重试的 TwelveData 请求；成功返回 dict，失败返回 None"""
    if not TWELVEDATA_KEY:
        _stats["lastError"] = "未配置 TwelveData API Key"
        if not _td_key_warned[0]:
            _td_key_warned[0] = True
            log("未配置 TwelveData API Key，跳过 5m 长期历史（设置环境变量 TWELVEDATA_KEY，"
                "或写入 tools/secret.local.json 的 {\"twelvedata_key\": \"...\"}）")
        return None
    q = dict(params)
    q["apikey"] = TWELVEDATA_KEY
    url = TWELVEDATA_URL + "?" + urllib.parse.urlencode(q)
    for attempt in range(TWELVEDATA_PAGE_TRY):
        _td_rate_wait()
        req = urllib.request.Request(url, headers={"User-Agent": _UA,
                                                   "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                obj = json.loads(r.read().decode("utf-8", "ignore"))
        except Exception as e:
            _stats["lastError"] = f"TwelveData 请求失败: {e}"
            log(f"TwelveData 第 {attempt + 1}/{TWELVEDATA_PAGE_TRY} 次失败：{e}")
            time.sleep(2.0 * (attempt + 1))
            continue
        if str(obj.get("code")) == "429":
            log("TwelveData 触发限速(429)，等 20s 重试")
            time.sleep(20)
            continue
        if obj.get("status") == "error":
            _stats["lastError"] = f"TwelveData: {obj.get('message')}"
            log(f"TwelveData 返回错误：{obj.get('message')}")
            return None
        return obj
    return None


def _td_parse(obj):
    """TwelveData values → 统一 K 线结构（UTC 秒时间戳）"""
    out = []
    for v in obj.get("values") or []:
        try:
            dt = datetime.strptime(v["datetime"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
            out.append({
                "time": int(dt.timestamp()),
                "open": float(v["open"]), "high": float(v["high"]),
                "low": float(v["low"]), "close": float(v["close"]),
                "volume": int(float(v.get("volume") or 0)),
            })
        except (KeyError, TypeError, ValueError):
            continue
    return out


def _td_windows(days):
    """
    把 [now-days, now] 切成连续的抓取窗口（窗口之间留 5 分钟重叠，避免边界丢K线）。
    返回顺序为「从最新往更早」——先拿到最有用的近期历史，中断也不影响可用性。
    """
    now_utc = datetime.now(timezone.utc)
    floor = now_utc - timedelta(days=days)
    windows, cursor = [], floor
    while cursor < now_utc:
        nxt = min(cursor + timedelta(days=TWELVEDATA_PAGE_DAYS), now_utc)
        windows.append((cursor, nxt))
        cursor = nxt
    windows.reverse()
    return windows, floor, now_utc


def _store_covers(times, start, end, tolerance=3600):
    """
    已存K线里是否已经有「真正落在本窗口内」的数据（用于断点续跑跳过）。
    注意：抓取窗口会向前多要 5 分钟做重叠，所以不能用「窗口内有没有K线」直接判断，
    否则上一窗口的预卷K线会落在本窗口右边界前，导致本窗口被误判为已完成而跳空。
    这里要求窗口内部至少有一个超过 tolerance（1小时）的位置有数据。
    """
    if not times:
        return False
    lo, hi = int(start.timestamp()), int(end.timestamp()) - tolerance
    i = bisect.bisect_left(times, lo)
    return i < len(times) and times[i] < hi


def _td_fetch_window(api_symbol, start, end, floor):
    """抓取单个窗口的 5m K线；窗口起点回退 5 分钟与上一窗口重叠"""
    req_start = max(start - timedelta(minutes=5), floor)
    obj = _td_request({
        "symbol": api_symbol, "interval": "5min",
        "start_date": req_start.strftime("%Y-%m-%dT%H:%M:%S"),
        "end_date": end.strftime("%Y-%m-%dT%H:%M:%S"),
        "outputsize": 4999, "timezone": "UTC", "order": "ASC",
    })
    return None if obj is None else _td_parse(obj)


def backfill_td_5m(symbol, days=365, quiet=False):
    """
    回溯 5 分钟长期历史（TwelveData 现货金）。

    逐窗口抓取，每抓完一个窗口就与既有数据去重合并并落盘，
    因此中途中断也不会丢掉已经拉到的历史；再次运行会自动跳过
    已经被既有数据覆盖的窗口（断点续跑），只补更早的部分。
    """
    api_symbol = TWELVEDATA_MAP.get(symbol)
    if not api_symbol:
        log(f"[{symbol}] TwelveData 无对应标的，跳过 5m 回溯")
        return []
    if not TWELVEDATA_KEY:
        log(f"[{symbol}] 未配置 TwelveData API Key，跳过 5m 回溯"
            f"（可改用 --backfill-5m 走币安黄金代币，免费无需 Key）")
        return load_ext5m_td_store(symbol)

    store = load_ext5m_td_store(symbol)
    times = [b["time"] for b in store]

    windows, floor, now_utc = _td_windows(days)
    est = len(windows)
    if not quiet:
        log(f"[{symbol}] 开始 TwelveData 5m 回溯：{days} 天，共 {est} 个窗口，"
            f"既有 {len(store)} 根，预计 {int(est * TWELVEDATA_RATE_SEC / 60)} 分 "
            f"{int(est * TWELVEDATA_RATE_SEC % 60)} 秒（每窗口即时落盘，可中断续跑）")

    # 待抓窗口队列（失败的窗口跨度够大就二分成两个更小的再试）
    queue = list(windows)
    calls, got, skipped = 0, 0, 0
    while queue and calls < TWELVEDATA_MAX_CALLS:
        start, end = queue.pop(0)
        if start >= end:
            continue
        # 断点续跑：该窗口已有数据（上次跑到这里了）就直接跳过
        if _store_covers(times, start, end):
            skipped += 1
            continue
        bars = _td_fetch_window(api_symbol, start, end, floor)
        calls += 1
        if bars is None:
            span = end - start
            if span > timedelta(days=TWELVEDATA_MIN_SPLIT_DAYS):
                mid = start + span / 2
                queue.insert(0, (start, mid))
                queue.insert(1, (mid, end))
                log(f"[{symbol}] 窗口 {start:%Y-%m-%d}~{end:%Y-%m-%d} 失败，拆分为两个更小窗口重试")
            else:
                log(f"[{symbol}] 窗口 {start:%Y-%m-%d}~{end:%Y-%m-%d} 仍失败，跳过")
            continue

        # 立即合并落盘：中断也不丢已拉到的数据
        if bars:
            store = merge_bars(store, bars)
            times = [b["time"] for b in store]
            got += len(bars)
            save_ext5m_td_store(symbol, store, api_symbol)
        log(f"[{symbol}] 窗口 {start:%Y-%m-%d}~{end:%Y-%m-%d} 返回 {len(bars)} 根，"
            f"累计 {len(store)} 根（已存盘）")

    if not store:
        log(f"[{symbol}] TwelveData 拉取失败，无可用 5m 长期历史")
        return []

    export_static(symbol, load_store(symbol))
    log(f"[{symbol}] 5m 长期历史(TwelveData)完成：{len(store)} 根 "
        f"({bj_str(store[0]['time'])} ~ {bj_str(store[-1]['time'])}，来源 {api_symbol}，"
        f"本次请求 {calls} 次共取回 {got} 根，跳过已完成 {skipped} 个窗口)")
    return store


# ==================== 存储与合并 ====================
def store_path(symbol):
    return os.path.join(STORE_DIR, f"{symbol}_1m.json")


def load_store(symbol):
    try:
        with open(store_path(symbol)) as f:
            obj = json.load(f)
        bars = obj.get("bars") if isinstance(obj, dict) else obj
        return bars if isinstance(bars, list) else []
    except Exception:
        return []


def seed_from_static(symbol):
    """首次运行时，从既有的静态文件播种历史数据，避免新数据覆盖旧历史"""
    static_path = os.path.join(DATA_DIR, f"{symbol}_1m.json")
    if not os.path.exists(static_path):
        return []
    try:
        with open(static_path) as f:
            obj = json.load(f)
        kl = obj.get("klines") if isinstance(obj, dict) else obj
        if not isinstance(kl, list):
            return []
        bars = []
        for k in kl:
            try:
                bars.append({
                    "time": int(k["time"]),
                    "open": float(k["open"]), "high": float(k["high"]),
                    "low": float(k["low"]), "close": float(k["close"]),
                    "volume": int(float(k.get("volume", 0))),
                })
            except (KeyError, TypeError, ValueError):
                continue
        bars.sort(key=lambda b: b["time"])
        if bars:
            save_store(symbol, bars)
            log(f"[{symbol}] 已从既有静态文件播种历史：{len(bars)} 根 "
                f"({bj_str(bars[0]['time'])} ~ {bj_str(bars[-1]['time'])})")
        return bars
    except Exception as e:
        log(f"[{symbol}] 播种失败: {e}")
        return []


def ensure_store(symbol):
    """确保 store 存在：不存在则从静态文件播种"""
    with _lock:
        bars = load_store(symbol)
    if bars:
        return bars
    return seed_from_static(symbol)


def save_store(symbol, bars):
    atomic_write_json(store_path(symbol), {
        "symbol": symbol,
        "tf": "1m",
        "source": "jin10",
        "updated": int(time.time()),
        "updated_bj": now_bj().strftime("%Y-%m-%d %H:%M:%S"),
        "count": len(bars),
        "bars": bars,
    })


def merge_bars(old_bars, new_bars):
    """按时间戳去重合并：相同时间以新数据覆盖（正在形成的K线会被更新）"""
    merged = {}
    for b in old_bars or []:
        merged[b["time"]] = b
    for b in new_bars or []:
        merged[b["time"]] = b
    return sorted(merged.values(), key=lambda b: b["time"])


def find_gaps(bars, step=60):
    """检测缺口，返回 [{after, missing, startBj, endBj}]"""
    gaps = []
    for i in range(1, len(bars)):
        d = bars[i]["time"] - bars[i - 1]["time"]
        if d > step:
            gaps.append({
                "after": bars[i - 1]["time"],
                "missing": int(d // step) - 1,
                "startBj": bj_str(bars[i - 1]["time"] + step),
                "endBj": bj_str(bars[i]["time"] - step),
            })
    return gaps


# 每日休市窗口（北京时间）：黄金/原油/外汇普遍在 04:55~06:00 维护休市
BREAK_START_MIN = 4 * 60 + 50   # 04:50
BREAK_END_MIN = 6 * 60 + 5      # 06:05


def _minute_of_day(ts):
    d = datetime.fromtimestamp(ts, BJ)
    return d.hour * 60 + d.minute


def is_market_break(gap):
    """缺口是否完全落在每日休市窗口内（正常休市，不算数据缺失）"""
    s = _minute_of_day(gap["after"] + 60)
    e = _minute_of_day(gap["after"] + 60 + gap["missing"] * 60)
    return BREAK_START_MIN <= s and e <= BREAK_END_MIN


def classify_gaps(bars):
    """区分「正常休市」与「真实缺口」，以及零星的单根无成交"""
    gaps = find_gaps(bars)
    breaks, real, sparse = [], [], []
    for g in gaps:
        if is_market_break(g):
            breaks.append(g)
        elif g["missing"] <= 2:
            sparse.append(g)      # 流动性不足导致的零星无成交，属正常
        else:
            real.append(g)
    return {
        "all": gaps,
        "marketBreaks": breaks,
        "sparse": sparse,
        "real": real,
        "realMissingBars": sum(g["missing"] for g in real),
    }


def aggregate(bars_1m, minutes):
    """1分钟K线聚合为更高周期"""
    if minutes <= 1:
        return list(bars_1m)
    bucket = minutes * 60
    out = []
    cur = None
    cur_key = None
    for b in bars_1m:
        key = (b["time"] // bucket) * bucket
        if key != cur_key:
            if cur:
                out.append(cur)
            cur = {"time": key, "open": b["open"], "high": b["high"],
                   "low": b["low"], "close": b["close"], "volume": b["volume"]}
            cur_key = key
        else:
            cur["high"] = max(cur["high"], b["high"])
            cur["low"] = min(cur["low"], b["low"])
            cur["close"] = b["close"]
            cur["volume"] += b["volume"]
    if cur:
        out.append(cur)
    return out


def pick_ext5m(symbol):
    """
    选择用于派生高周期的「长期 5m 历史」。
    优先 TwelveData 现货金（与金十同源、含真实休市），其次币安黄金代币。
    """
    td = load_ext5m_td_store(symbol)
    if td:
        return td, f"twelvedata:{TWELVEDATA_MAP.get(symbol)}"
    bn = load_ext5m_store(symbol)
    if bn:
        return bn, f"binance:{BINANCE_PAIR_MAP.get(symbol)}"
    return [], None


def build_timeframes(symbol, bars_1m):
    """
    构建各周期数据。
    规则：5 分钟及以上周期，若「长期 5m 历史」派生的根数多于金十 1m 聚合，
    则以长期历史为底，并用金十最新的聚合数据按时间戳覆盖重叠部分
    （既拿到长期数据，又保证最新价格以金十为准），并如实标注来源。
    """
    out = {}
    ext5, ext_src = pick_ext5m(symbol)
    for tf, minutes in TIMEFRAMES:
        from_1m = aggregate(bars_1m, minutes)
        if minutes >= 5 and ext5:
            from_ext = aggregate(ext5, minutes)
            if len(from_ext) > len(from_1m):
                merged_tf = merge_bars(from_ext, from_1m)
                if len(merged_tf) > len(from_1m):
                    out[tf] = (merged_tf, ext_src)
                    continue
        out[tf] = (from_1m, "jin10")
    return out


def export_static(symbol, bars_1m):
    """导出前端可直接读取的静态文件（服务未启动时的兜底）"""
    for tf, (tf_bars, src) in build_timeframes(symbol, bars_1m).items():
        payload = {"symbol": symbol, "tf": tf, "source": src,
                   "updated": int(time.time()), "klines": tf_bars}
        atomic_write_json(os.path.join(DATA_DIR, f"{symbol}_{tf}.json"), payload)


# ==================== 刷新流程 ====================
def refresh_symbol(symbol, do_backfill=False):
    """拉取最新K线 → 合并去重 → 补缺口 → 存盘导出"""
    store = ensure_store(symbol)     # 首次会从既有静态文件播种历史
    with _lock:
        before = len(store)

    fresh = fetch_klines(symbol, count=100)
    if not fresh:
        log(f"[{symbol}] 拉取失败：{_stats.get('lastError')}")
        return None

    merged = merge_bars(store, fresh)
    added = len(merged) - before

    # 从最新一根向历史连续回溯，填补空洞与内部缺口（额度允许时）
    repair_calls = 0
    if do_backfill and quota_available():
        merged, repair_calls = fill_history(symbol, merged, max_calls=BACKFILL_MAX_CALLS)

    cls = classify_gaps(merged)
    with _lock:
        save_store(symbol, merged)
        export_static(symbol, merged)

    _stats["lastRefresh"] = now_bj().strftime("%Y-%m-%d %H:%M:%S")
    log(f"[{symbol}] 合并完成：新增 {added} 根，回溯 {repair_calls} 次，共 {len(merged)} 根，"
        f"范围 {bj_str(merged[0]['time'])} ~ {bj_str(merged[-1]['time'])} | "
        f"正常休市 {len(cls['marketBreaks'])} 段，零星无成交 {len(cls['sparse'])} 处，"
        f"真实缺口 {len(cls['real'])} 处（缺 {cls['realMissingBars']} 根）")
    return merged


def fill_history(symbol, bars, max_calls=8, step=60):
    """
    从「最新一段连续数据的起点」开始向历史连续回溯拉取，逐批合并。
    这样既能填补新旧数据之间的空洞，也能补上历史内部的小缺口。
    返回 (bars, 实际调用次数)
    """
    if not bars:
        return bars, 0
    oldest_known = bars[0]["time"]

    # 从末尾往前找出「最新连续段」的起点（遇到断层即停）
    tail_start = bars[-1]["time"]
    for i in range(len(bars) - 1, 0, -1):
        if bars[i]["time"] - bars[i - 1]["time"] != step:
            tail_start = bars[i]["time"]
            break
        tail_start = bars[i - 1]["time"]

    cursor = tail_start - step
    calls = 0
    while calls < max_calls and quota_available():
        if cursor < oldest_known - step:
            break  # 已回溯到比现有最早数据更早，无需继续
        fetched = fetch_klines(symbol, at_time=cursor, count=100)
        calls += 1
        if not fetched:
            break
        before_len = len(bars)
        bars = merge_bars(bars, fetched)
        # 本批没有产生任何新数据 → 无法再补，停止（避免死循环）
        if len(bars) == before_len:
            break
        cursor = fetched[0]["time"] - step
    return bars, calls


def repair_gaps(symbol, bars, max_calls=8):
    """兼容旧名：改为连续回溯补齐"""
    return fill_history(symbol, bars, max_calls=max_calls)[0]


def backfill_symbol(symbol, hours=24):
    """回溯补齐历史（每次100根=100分钟）"""
    bars = ensure_store(symbol)
    if not bars:
        bars = fetch_klines(symbol, count=100) or []
    target_bars = int(hours * 60)
    calls = 0
    max_calls = max(1, min(BACKFILL_MAX_CALLS * 4, target_bars // 100 + 2))
    while len(bars) < target_bars and calls < max_calls and quota_available():
        oldest = bars[0]["time"] if bars else int(time.time())
        fetched = fetch_klines(symbol, at_time=oldest - 60, count=100)
        calls += 1
        if not fetched:
            break
        new_len = len(bars)
        bars = merge_bars(bars, fetched)
        if len(bars) == new_len:
            break
    with _lock:
        save_store(symbol, bars)
        export_static(symbol, bars)
    log(f"[{symbol}] 回溯完成：共 {len(bars)} 根（调用 {calls} 次）")
    return bars


def refresh_loop(interval):
    """定时刷新（只刷新近期被请求过的品种，避免浪费额度）"""
    while True:
        try:
            now = time.time()
            targets = [s for s, t in list(_active.items()) if now - t < ACTIVE_WINDOW_SEC]
            if targets and quota_available():
                for s in targets:
                    refresh_daily(s)      # 节流：最多 6 小时一次
                    refresh_symbol(s, do_backfill=False)
            elif targets:
                log("额度不足，跳过本轮刷新")
        except Exception as e:
            _stats["lastError"] = str(e)
            log(f"刷新循环异常: {e}")
        time.sleep(interval)


# ==================== HTTP API ====================
def data_info(symbol):
    bars = load_store(symbol)
    if not bars:
        return {"symbol": symbol, "count": 0, "source": None, "realGaps": []}
    cls = classify_gaps(bars)
    last = bars[-1]["time"]
    daily = load_daily_store(symbol)
    ext_td = load_ext5m_td_store(symbol)
    ext_bn = load_ext5m_store(symbol)
    ext5, ext_src = pick_ext5m(symbol)
    return {
        "symbol": symbol,
        "count": len(bars),
        "source": "jin10",
        "dailySource": "sina" if daily else None,
        "dailyCount": len(daily),
        "dailyFirstBj": bj_str(daily[0]["time"]) if daily else None,
        "dailyLastBj": bj_str(daily[-1]["time"]) if daily else None,
        "ext5mSource": ext_src,
        "ext5mCount": len(ext5),
        "ext5mFirstBj": bj_str(ext5[0]["time"]) if ext5 else None,
        "ext5mLastBj": bj_str(ext5[-1]["time"]) if ext5 else None,
        "td5mCount": len(ext_td),
        "td5mFirstBj": bj_str(ext_td[0]["time"]) if ext_td else None,
        "td5mLastBj": bj_str(ext_td[-1]["time"]) if ext_td else None,
        "binance5mCount": len(ext_bn),
        "firstTime": bars[0]["time"],
        "lastTime": last,
        "firstBj": bj_str(bars[0]["time"]),
        "lastBj": bj_str(last),
        "staleMinutes": int((time.time() - last) // 60),
        "marketBreaks": len(cls["marketBreaks"]),
        "sparseGaps": len(cls["sparse"]),
        "realGaps": cls["real"],
        "realGapCount": len(cls["real"]),
        "realMissingBars": cls["realMissingBars"],
        "updatedBj": now_bj().strftime("%Y-%m-%d %H:%M:%S"),
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass  # 静默

    def do_OPTIONS(self):
        self._send({"ok": True})

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        path = u.path
        symbol = (q.get("symbol", ["XAUUSD"])[0] or "XAUUSD").upper()

        if path == "/api/health":
            self._send({"ok": True, "stats": _stats, "quota": _quota,
                        "active": list(_active.keys()),
                        "limit": DAILY_CALL_SAFE, "serverTime": now_bj().strftime("%Y-%m-%d %H:%M:%S")})
            return

        if path == "/api/info":
            _active[symbol] = time.time()
            self._send(data_info(symbol))
            return

        if path == "/api/klines":
            _active[symbol] = time.time()
            tf = q.get("tf", ["1m"])[0]
            limit = int(q.get("limit", ["3000"])[0])
            bars = load_store(symbol)
            minutes = dict(TIMEFRAMES).get(tf, 1)
            out = aggregate(bars, minutes)
            if limit > 0:
                out = out[-limit:]
            self._send({"symbol": symbol, "tf": tf, "bars": out, "meta": data_info(symbol)})
            return

        if path == "/api/all":
            _active[symbol] = time.time()
            bars = load_store(symbol)
            out = {tf: b for tf, (b, _src) in build_timeframes(symbol, bars).items()}
            # 长期日线（来自新浪外盘，不参与 1m 聚合）
            daily = load_daily_store(symbol)
            if daily:
                out["1d"] = daily
            self._send({"symbol": symbol, "timeframes": out, "meta": data_info(symbol)})
            return

        self._send({"error": "not found", "path": path}, 404)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        symbol = (q.get("symbol", ["XAUUSD"])[0] or "XAUUSD").upper()
        if u.path == "/api/refresh":
            _active[symbol] = time.time()
            refresh_daily(symbol)
            bars = refresh_symbol(symbol, do_backfill=True)
            self._send({"ok": bool(bars), "meta": data_info(symbol), "stats": _stats})
            return
        if u.path == "/api/backfill":
            hours = float(q.get("hours", ["24"])[0])
            bars = backfill_symbol(symbol, hours=hours)
            self._send({"ok": bool(bars), "meta": data_info(symbol)})
            return
        if u.path == "/api/backfill5m":
            days = int(float(q.get("days", ["90"])[0]))
            bars = backfill_5m(symbol, days=days)
            self._send({"ok": bool(bars), "count": len(bars), "meta": data_info(symbol)})
            return
        if u.path == "/api/backfilltd":
            days = int(float(q.get("days", ["365"])[0]))
            bars = backfill_td_5m(symbol, days=days)
            self._send({"ok": bool(bars), "count": len(bars), "meta": data_info(symbol)})
            return
        self._send({"error": "not found"}, 404)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8090)
    ap.add_argument("--interval", type=int, default=300, help="自动刷新间隔（秒）")
    ap.add_argument("--once", action="store_true", help="只更新一次后退出")
    ap.add_argument("--symbols", default=",".join(SYMBOLS))
    ap.add_argument("--backfill-5m", type=int, default=0, metavar="DAYS",
                    help="回溯 5 分钟长期历史（币安黄金代币，单位天，如 90；0=不执行）")
    ap.add_argument("--backfill-td", type=int, default=0, metavar="DAYS",
                    help="回溯 5 分钟长期历史（TwelveData 现货金，推荐，单位天，如 365；0=不执行）")
    args = ap.parse_args()

    ensure_dirs()
    load_quota()
    symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]

    if j10 is None:
        log("警告：金十客户端不可用，服务只能读取已有存储")

    # 仅回溯 5m 长期历史
    if args.backfill_td > 0 or args.backfill_5m > 0:
        for s in symbols:
            if args.backfill_td > 0:
                backfill_td_5m(s, days=args.backfill_td)
            if args.backfill_5m > 0:
                backfill_5m(s, days=args.backfill_5m)
        return

    if args.once:
        for s in symbols:
            refresh_daily(s, force=True)
            refresh_symbol(s, do_backfill=True)
        return

    # 启动时后台预热（不阻塞 HTTP 启动）
    def warmup():
        for s in symbols:
            try:
                refresh_daily(s)          # 长期日线（新浪，不消耗金十额度）
                refresh_symbol(s, do_backfill=False)
            except Exception as e:
                log(f"预热失败 {s}: {e}")

    threading.Thread(target=warmup, daemon=True).start()
    threading.Thread(target=refresh_loop, args=(args.interval,), daemon=True).start()

    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    log(f"数据服务已启动: http://127.0.0.1:{args.port}  (自动刷新间隔 {args.interval}s)")
    log(f"品种: {', '.join(symbols)}   每日额度上限: {DAILY_CALL_SAFE}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("已停止")


if __name__ == "__main__":
    main()
