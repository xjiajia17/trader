#!/usr/bin/env python3
"""
K线数据获取与缓存工具
从金十数据 MCP 获取分钟级 K 线，支持聚合多周期数据
"""

import json
import sys
import os
import time
import urllib.request
import urllib.error

MCP_SERVER_URL = "https://mcp.jin10.com/mcp"
BEARER_TOKEN = "sk-fAQeHEWuW45MNO4rFABz6AKReBT-I4WqERAUVGff5Qk"
PROTOCOL_VERSION = "2025-11-25"
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

_initialized = False
_request_id = 0


def _next_id():
    global _request_id
    _request_id += 1
    return _request_id


def _call_mcp(method, params=None):
    """调用 MCP 服务"""
    global _initialized

    if not _initialized and method != "initialize":
        _initialize()

    payload = {
        "jsonrpc": "2.0",
        "id": _next_id(),
        "method": method,
        "params": params or {}
    }

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        MCP_SERVER_URL,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": f"Bearer {BEARER_TOKEN}"
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(req) as resp:
            result = None
            for line in resp:
                line = line.decode("utf-8").strip()
                if line.startswith("data: "):
                    data_str = line[6:]
                    try:
                        msg = json.loads(data_str)
                        if "result" in msg:
                            result = msg["result"]
                        elif "error" in msg:
                            print(f"MCP Error: {msg['error']}", file=sys.stderr)
                            return None
                    except json.JSONDecodeError:
                        pass
            return result
    except urllib.error.HTTPError as e:
        print(f"HTTP Error {e.code}: {e.read().decode()}", file=sys.stderr)
        return None
    except urllib.error.URLError as e:
        print(f"URL Error: {e.reason}", file=sys.stderr)
        return None


def _initialize():
    """执行 MCP initialize 握手"""
    global _initialized
    result = _call_mcp("initialize", {
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": {
            "name": "kline-replay",
            "version": "1.0.0"
        }
    })
    if result:
        _initialized = True
        payload = {
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        }
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            MCP_SERVER_URL,
            data=data,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "Authorization": f"Bearer {BEARER_TOKEN}"
            },
            method="POST"
        )
        try:
            urllib.request.urlopen(req).read()
        except Exception:
            pass
    return result


def get_kline(code, start_time=None, count=100):
    """获取 K 线数据"""
    params = {"code": code, "count": count}
    if start_time:
        params["time"] = start_time
    result = _call_mcp("tools/call", {
        "name": "get_kline",
        "arguments": params
    })
    if result and "content" in result:
        for item in result["content"]:
            if item.get("type") == "text":
                try:
                    parsed = json.loads(item["text"])
                    if parsed.get("status") == 200 and parsed.get("data"):
                        return parsed["data"]
                except json.JSONDecodeError:
                    pass
    return None


def fetch_full_day_klines(code):
    """获取完整的 24 小时分钟 K 线数据
    金十接口每次最多 100 根，time参数表示"返回此时间之前的100根"
    正确分页方式：用最旧bar的时间作为下一次的time参数
    """
    all_klines = []

    # 批次1: 获取最新100根（不带time参数）
    data = get_kline(code, count=100)
    if not data or "klines" not in data or len(data["klines"]) == 0:
        print(f"  无数据")
        return []

    k1 = sorted(data["klines"], key=lambda x: x["time"])
    all_klines.extend(k1)
    oldest = all_klines[0]["time"]
    print(f"  批次 1: {len(k1)} 根")

    # 后续批次: 用oldest作为time参数，获取oldest之前的100根
    max_batches = 20
    for i in range(1, max_batches):
        time.sleep(0.3)
        data = get_kline(code, start_time=oldest, count=100)
        if not data or "klines" not in data or len(data["klines"]) == 0:
            print(f"  批次 {i+1}: 无数据，停止")
            break

        k = sorted(data["klines"], key=lambda x: x["time"])
        existing_times = {kk["time"] for kk in all_klines}
        new_klines = [kk for kk in k if kk["time"] not in existing_times]

        if len(new_klines) == 0:
            print(f"  批次 {i+1}: 全部重复，停止")
            break

        all_klines.extend(new_klines)
        all_klines.sort(key=lambda x: x["time"])
        oldest = all_klines[0]["time"]
        print(f"  批次 {i+1}: +{len(new_klines)} 根，累计 {len(all_klines)} 根")

    all_klines.sort(key=lambda x: x["time"])
    return all_klines


def aggregate_klines(klines, period_minutes):
    """将分钟 K 线聚合为指定周期
    period_minutes: 5, 15, 30, 60, 240, 1440 等
    """
    if not klines:
        return []

    aggregated = []
    period_seconds = period_minutes * 60

    current_bars = []
    current_period_start = None

    for bar in klines:
        bar_time = bar["time"]
        # 计算该 bar 所属的周期起始时间
        period_start = (bar_time // period_seconds) * period_seconds

        if current_period_start is None:
            current_period_start = period_start

        if period_start != current_period_start:
            # 结算当前周期
            if current_bars:
                agg_bar = {
                    "time": current_period_start,
                    "open": float(current_bars[0]["open"]),
                    "high": max(float(b["high"]) for b in current_bars),
                    "low": min(float(b["low"]) for b in current_bars),
                    "close": float(current_bars[-1]["close"]),
                    "volume": sum(b.get("volume", 0) for b in current_bars)
                }
                aggregated.append(agg_bar)
            current_bars = [bar]
            current_period_start = period_start
        else:
            current_bars.append(bar)

    # 处理最后一个周期
    if current_bars:
        agg_bar = {
            "time": current_period_start,
            "open": float(current_bars[0]["open"]),
            "high": max(float(b["high"]) for b in current_bars),
            "low": min(float(b["low"]) for b in current_bars),
            "close": float(current_bars[-1]["close"]),
            "volume": sum(b.get("volume", 0) for b in current_bars)
        }
        aggregated.append(agg_bar)

    return aggregated


def save_data(code, klines, name=""):
    """保存数据到文件"""
    os.makedirs(DATA_DIR, exist_ok=True)

    # 保存分钟线
    filename = f"{code}_1m.json"
    filepath = os.path.join(DATA_DIR, filename)

    output = {
        "code": code,
        "name": name,
        "timeframe": "1m",
        "updated_at": int(time.time()),
        "klines": klines
    }

    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"已保存 {len(klines)} 根 1 分钟 K 线到 {filepath}")

    # 聚合并保存其他周期
    periods = [
        (5, "5m"),
        (15, "15m"),
        (30, "30m"),
        (60, "1h"),
        (240, "4h"),
    ]

    for period_minutes, period_name in periods:
        agg = aggregate_klines(klines, period_minutes)
        if len(agg) < 2:
            continue

        agg_filename = f"{code}_{period_name}.json"
        agg_filepath = os.path.join(DATA_DIR, agg_filename)

        agg_output = {
            "code": code,
            "name": name,
            "timeframe": period_name,
            "updated_at": int(time.time()),
            "klines": agg
        }

        with open(agg_filepath, "w", encoding="utf-8") as f:
            json.dump(agg_output, f, ensure_ascii=False, indent=2)

        print(f"已保存 {len(agg)} 根 {period_name} K 线到 {agg_filepath}")


def main():
    if len(sys.argv) < 2:
        print("Usage: fetch_data.py <code> [code2 ...]")
        print("Example: fetch_data.py XAUUSD USOIL USDJPY")
        sys.exit(1)

    codes = sys.argv[1:]

    for code in codes:
        print(f"\n{'='*50}")
        print(f"正在获取 {code} 的 K 线数据...")
        print(f"{'='*50}")

        klines = fetch_full_day_klines(code)

        if klines:
            # 获取名称
            quote_data = get_kline(code, count=1)
            name = quote_data.get("name", code) if quote_data else code
            save_data(code, klines, name)
            print(f"\n✅ {code} 数据获取完成，共 {len(klines)} 根分钟线")
        else:
            print(f"\n❌ {code} 数据获取失败")


if __name__ == "__main__":
    main()
