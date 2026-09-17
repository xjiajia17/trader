#!/usr/bin/env python3
"""
========================================
CI 数据更新脚本（GitHub Actions 专用）
========================================
在 CI 环境中独立运行，不依赖本地 jin10_mcp_client。
从环境变量读取 API Token，拉取最新 K 线数据并合并到仓库。

环境变量：
  JIN10_TOKEN       - 金十数据 Bearer Token（必需）
  TWELVEDATA_KEY    - TwelveData API Key（可选，用于日线更新）

用法：
  python3 tools/ci_update.py
"""

import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
STORE_DIR = os.path.join(DATA_DIR, "store")

SYMBOLS = ["XAUUSD", "USOIL", "USDJPY", "EURUSD"]
TIMEFRAMES = [("1m", 1), ("5m", 5), ("15m", 15), ("30m", 30), ("1h", 60), ("4h", 240)]

BJ = timezone(timedelta(hours=8))

# ===== 金十 MCP API =====
MCP_URL = "https://mcp.jin10.com/mcp"
JIN10_TOKEN = os.environ.get("JIN10_TOKEN", "").strip()
MCP_PROTOCOL = "2025-11-25"

_mcp_initialized = False
_mcp_req_id = 0


def _mcp_next_id():
    global _mcp_req_id
    _mcp_req_id += 1
    return _mcp_req_id


def _mcp_post(method, params=None):
    """发送 MCP JSON-RPC 请求（SSE 响应）"""
    global _mcp_initialized
    if not _mcp_initialized and method != "initialize":
        _mcp_initialize()

    payload = {
        "jsonrpc": "2.0",
        "id": _mcp_next_id(),
        "method": method,
        "params": params or {}
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(MCP_URL, data=data, headers={
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": f"Bearer {JIN10_TOKEN}"
    }, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            for line in resp:
                line = line.decode("utf-8").strip()
                if line.startswith("data: "):
                    try:
                        msg = json.loads(line[6:])
                        if "result" in msg:
                            return msg["result"]
                        elif "error" in msg:
                            print(f"[金十] MCP error: {msg['error']}", file=sys.stderr)
                            return None
                    except json.JSONDecodeError:
                        pass
    except Exception as e:
        print(f"[金十] 请求失败: {e}", file=sys.stderr)
    return None


def _mcp_initialize():
    result = _mcp_post("initialize", {
        "protocolVersion": MCP_PROTOCOL,
        "capabilities": {},
        "clientInfo": {"name": "ci-update", "version": "1.0.0"}
    })
    if result:
        global _mcp_initialized
        _mcp_initialized = True
        # 发送 initialized 通知
        payload = {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(MCP_URL, data=data, headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": f"Bearer {JIN10_TOKEN}"
        }, method="POST")
        try:
            urllib.request.urlopen(req, timeout=10).read()
        except Exception:
            pass


def fetch_jin10_klines(symbol, count=100):
    """从金十拉取最新 K 线"""
    result = _mcp_post("tools/call", {
        "name": "get_kline",
        "arguments": {"code": symbol, "count": count}
    })
    if not result:
        return None

    # 递归查找 klines 数组
    def find_klines(obj, depth=0):
        if obj is None or depth > 6:
            return None
        if isinstance(obj, dict):
            if isinstance(obj.get("klines"), list):
                return obj["klines"]
            for v in obj.values():
                r = find_klines(v, depth + 1)
                if r:
                    return r
        elif isinstance(obj, list):
            for v in obj:
                r = find_klines(v, depth + 1)
                if r:
                    return r
        elif isinstance(obj, str):
            s = obj.strip()
            if s[:1] in "{[":
                try:
                    return find_klines(json.loads(s), depth + 1)
                except Exception:
                    pass
        return None

    kl = find_klines(result)
    if not kl:
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
    bars.sort(key=lambda b: b["time"])
    return bars or None


# ===== 存储 =====
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


def atomic_write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def save_store(symbol, bars):
    atomic_write_json(store_path(symbol), {
        "symbol": symbol, "tf": "1m", "source": "jin10",
        "updated": int(time.time()),
        "updated_bj": datetime.now(BJ).strftime("%Y-%m-%d %H:%M:%S"),
        "count": len(bars), "bars": bars,
    })


def merge_bars(old_bars, new_bars):
    merged = {}
    for b in old_bars or []:
        merged[b["time"]] = b
    for b in new_bars or []:
        merged[b["time"]] = b
    return sorted(merged.values(), key=lambda b: b["time"])


def aggregate(bars_1m, minutes):
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


def load_ext5m_td(symbol):
    """加载 TwelveData 长期 5m 历史"""
    path = os.path.join(STORE_DIR, f"{symbol}_5m_td.json")
    try:
        with open(path) as f:
            obj = json.load(f)
        bars = obj.get("bars") if isinstance(obj, dict) else obj
        return bars if isinstance(bars, list) else []
    except Exception:
        return []


def pick_ext5m(symbol):
    td = load_ext5m_td(symbol)
    if td:
        return td, "twelvedata"
    return [], None


def build_timeframes(symbol, bars_1m):
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


def load_daily_store(symbol):
    path = os.path.join(STORE_DIR, f"{symbol}_1d.json")
    try:
        with open(path) as f:
            obj = json.load(f)
        bars = obj.get("bars") if isinstance(obj, dict) else obj
        return bars if isinstance(bars, list) else []
    except Exception:
        return []


def save_daily_store(symbol, bars):
    atomic_write_json(os.path.join(STORE_DIR, f"{symbol}_1d.json"), {
        "symbol": symbol, "tf": "1d", "source": "sina",
        "updated": int(time.time()),
        "updated_bj": datetime.now(BJ).strftime("%Y-%m-%d %H:%M:%S"),
        "count": len(bars), "bars": bars,
    })
    atomic_write_json(os.path.join(DATA_DIR, f"{symbol}_1d.json"), {
        "symbol": symbol, "tf": "1d", "source": "sina",
        "updated": int(time.time()), "klines": bars,
    })


# ===== 新浪日线（免费，不消耗金十额度）=====
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")
SINA_DAILY_MAP = {"XAUUSD": "XAU", "USOIL": "OIL", "USDJPY": None, "EURUSD": None}
SINA_DAILY_URL = ("https://stock2.finance.sina.com.cn/futures/api/jsonp.php/"
                  "var%20t=/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol={code}")


def http_get(url, referer="https://finance.sina.com.cn/", timeout=15):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Referer": referer,
        "Accept": "application/json,text/plain,*/*",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", "ignore")
    except Exception:
        return None


def fetch_sina_daily(symbol):
    code = SINA_DAILY_MAP.get(symbol)
    if not code:
        return []
    body = http_get(SINA_DAILY_URL.format(code=code))
    if not body:
        return []
    m = re.search(r"=\s*\(?\s*(\[.*?\]|\{.*?\}|null)\s*\)?\s*;?\s*$", body.strip(), re.S)
    if not m:
        return []
    try:
        arr = json.loads(m.group(1))
    except Exception:
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


# ===== 导出静态文件 =====
def export_static(symbol, bars_1m):
    for tf, (tf_bars, src) in build_timeframes(symbol, bars_1m).items():
        payload = {"symbol": symbol, "tf": tf, "source": src,
                   "updated": int(time.time()), "klines": tf_bars}
        atomic_write_json(os.path.join(DATA_DIR, f"{symbol}_{tf}.json"), payload)


# ===== 主流程 =====
def main():
    if not JIN10_TOKEN:
        print("ERROR: JIN10_TOKEN 环境变量未设置", file=sys.stderr)
        sys.exit(1)

    os.makedirs(STORE_DIR, exist_ok=True)
    updated_any = False

    for symbol in SYMBOLS:
        print(f"\n[{symbol}] 开始更新...")

        # 1. 读取已有 1m 数据
        store = load_store(symbol)
        before = len(store)

        # 2. 从金十拉最新 100 根
        fresh = fetch_jin10_klines(symbol, count=100)
        if not fresh:
            print(f"[{symbol}] 金十拉取失败，跳过")
            continue

        merged = merge_bars(store, fresh)
        added = len(merged) - before

        # 3. 保存 store + 导出静态
        save_store(symbol, merged)
        export_static(symbol, merged)

        last_bj = datetime.fromtimestamp(merged[-1]["time"], BJ).strftime("%Y-%m-%d %H:%M") if merged else "-"
        print(f"[{symbol}] 新增 {added} 根，共 {len(merged)} 根，最新 {last_bj}")

        if added > 0:
            updated_any = True

        # 4. 日线（新浪，不消耗金十额度）
        daily_bars = fetch_sina_daily(symbol)
        if daily_bars:
            old_daily = load_daily_store(symbol)
            merged_daily = merge_bars(old_daily, daily_bars)
            save_daily_store(symbol, merged_daily)
            print(f"[{symbol}] 日线更新：{len(merged_daily)} 根")

    if not updated_any:
        print("\n无数据变化，不提交")
    else:
        print("\n数据已更新")


if __name__ == "__main__":
    main()
