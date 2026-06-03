"""SQLite → 前端用的所有 JSON。一次算完 TOP/暴衝/歸零/日報/預估/疑似刷票。"""
import os, sqlite3, json, datetime, statistics, pathlib
from collections import defaultdict

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

DB = "votes.db"
OUT = pathlib.Path("docs/data")
OUT.mkdir(parents=True, exist_ok=True)

END_DATE = datetime.date(2026, 7, 31)
SPIKE_HOURS = 12
SPIKE_THRESHOLD = 10
ZERO_FROM = 20
DROP_THRESHOLD = -10


def dump(name, obj):
    (OUT / name).write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")


def main():
    c = sqlite3.connect(DB)
    now_ts = c.execute("SELECT MAX(ts) FROM snapshot").fetchone()[0]
    if not now_ts:
        print("無資料"); return

    try:
        import zoneinfo
        TW = zoneinfo.ZoneInfo("Asia/Taipei")
        now_tw = datetime.datetime.now(TW)
        ts_iso = now_tw.isoformat(timespec="seconds")
        today = now_tw.date()
    except Exception:
        ts_iso = now_ts
        today = datetime.date.today()
    yest = today - datetime.timedelta(days=1)

    # 上一筆 ts 用來算排名變化
    prev_ts_row = c.execute(
        "SELECT ts FROM snapshot WHERE ts<? GROUP BY ts ORDER BY ts DESC LIMIT 1",
        (now_ts,)).fetchone()
    prev_rank = {}
    if prev_ts_row:
        for i, (rid,) in enumerate(c.execute("""
            SELECT retailerId FROM snapshot WHERE ts=? ORDER BY votes DESC, retailerId
        """, (prev_ts_row[0],))):
            prev_rank[rid] = i + 1

    latest = []
    for i, (rid, n, city, addr, v) in enumerate(c.execute("""
            SELECT r.retailerId,r.name,r.city,r.address,s.votes FROM snapshot s
            JOIN retailer r ON r.retailerId=s.retailerId
            WHERE s.ts=? ORDER BY s.votes DESC, r.retailerId""", (now_ts,))):
        cur = i + 1
        pr = prev_rank.get(rid)
        if pr is None:
            change, delta = "new", 0
        elif pr > cur:
            change, delta = "up", pr - cur
        elif pr < cur:
            change, delta = "down", pr - cur
        else:
            change, delta = "flat", 0
        latest.append({"rid": rid, "name": n, "city": city, "address": addr,
                       "votes": v, "rank_change": change, "rank_delta": delta})

    # series for top 50
    top_rids = [r["rid"] for r in latest[:50]]
    series = defaultdict(list)
    if top_rids:
        ph = ",".join("?" * len(top_rids))
        for rid, ts, v in c.execute(
                f"""SELECT retailerId,ts,votes FROM snapshot
                    WHERE retailerId IN ({ph}) ORDER BY retailerId,ts""", top_rids):
            series[rid].append([ts, v])
    name_map = {r["rid"]: f"{r['name']}（{r['city']}）" for r in latest[:50]}

    # alerts: vs SPIKE_HOURS 前最後一筆
    cutoff = (datetime.datetime.strptime(now_ts, "%Y-%m-%d %H:%M:%S")
              - datetime.timedelta(hours=SPIKE_HOURS)).strftime("%Y-%m-%d %H:%M:%S")
    diff_rows = c.execute("""
        WITH latest AS (SELECT retailerId,votes FROM snapshot WHERE ts=?),
        baseline AS (SELECT s.retailerId,s.votes FROM snapshot s
            JOIN (SELECT retailerId,MAX(ts) mt FROM snapshot WHERE ts<=? GROUP BY retailerId) b
            ON b.retailerId=s.retailerId AND b.mt=s.ts)
        SELECT r.name,r.city,r.address,l.votes,COALESCE(b.votes,0),
               l.votes-COALESCE(b.votes,0) d
        FROM latest l JOIN retailer r ON r.retailerId=l.retailerId
        LEFT JOIN baseline b ON b.retailerId=l.retailerId
        ORDER BY d DESC""", (now_ts, cutoff)).fetchall()

    def row(name, city, addr, v, b, d):
        return {"name": name, "city": city, "address": addr,
                "now": v, "prev": b, "delta": d}

    spikes = [row(*r) for r in diff_rows if r[5] >= SPIKE_THRESHOLD][:20]
    zeros = [row(*r) for r in diff_rows if r[4] >= ZERO_FROM and r[3] == 0]
    drops = [row(*r) for r in diff_rows if r[5] <= DROP_THRESHOLD][:20]

    # summary
    city_rows = [
        {"city": city, "votes": v, "shops": n}
        for city, v, n in c.execute("""
            SELECT r.city,SUM(s.votes),COUNT(*) FROM snapshot s
            JOIN retailer r ON r.retailerId=s.retailerId
            WHERE s.ts=? GROUP BY r.city ORDER BY SUM(s.votes) DESC""", (now_ts,))
    ]
    total_history = c.execute(
        "SELECT ts, SUM(votes) FROM snapshot GROUP BY ts ORDER BY ts").fetchall()

    # daily (today/yest 已在上方用 TW 算出)
    end_ts = c.execute("SELECT MAX(ts) FROM snapshot WHERE ts<?",
                       (f"{today} 00:00:00",)).fetchone()[0]
    start_ts = c.execute("SELECT MIN(ts) FROM snapshot WHERE ts>=?",
                         (f"{yest} 00:00:00",)).fetchone()[0]
    daily = None
    if end_ts and start_ts and end_ts != start_ts:
        # 計算「昨日結束 vs 前日結束」的排名變化
        # 前日基準 = yest 00:00 之前最後一筆
        ref_ts = c.execute("SELECT MAX(ts) FROM snapshot WHERE ts<?",
                           (f"{yest} 00:00:00",)).fetchone()[0]
        end_rank = {rid: i+1 for i,(rid,) in enumerate(c.execute(
            "SELECT retailerId FROM snapshot WHERE ts=? ORDER BY votes DESC, retailerId",
            (end_ts,)))}
        ref_rank = {rid: i+1 for i,(rid,) in enumerate(c.execute(
            "SELECT retailerId FROM snapshot WHERE ts=? ORDER BY votes DESC, retailerId",
            (ref_ts,)))} if ref_ts else {}
        def rchange(rid):
            cur = end_rank.get(rid); pr = ref_rank.get(rid)
            if cur is None: return ("flat", 0)
            if pr is None:  return ("new", 0)
            if pr > cur:    return ("up", pr-cur)
            if pr < cur:    return ("down", pr-cur)
            return ("flat", 0)

        drows = c.execute("""
            WITH e AS (SELECT retailerId,votes FROM snapshot WHERE ts=?),
                 s AS (SELECT retailerId,votes FROM snapshot WHERE ts=?)
            SELECT r.retailerId,r.name,r.city,e.votes,COALESCE(s.votes,0),e.votes-COALESCE(s.votes,0) d
            FROM e JOIN retailer r ON r.retailerId=e.retailerId
            LEFT JOIN s ON s.retailerId=e.retailerId ORDER BY e.votes DESC
        """, (end_ts, start_ts)).fetchall()

        def with_rank(d):
            ch, dl = rchange(d["rid"])
            return {**d, "rank_change": ch, "rank_delta": dl}

        daily = {
            "date": str(yest),
            "total_now": sum(r[3] for r in drows),
            "total_start": sum(r[4] for r in drows),
            "top_now": [with_rank({"rid": rid, "name": n, "city": c1, "votes": v})
                        for rid, n, c1, v, _, _ in drows[:10]],
            "top_gain": sorted(
                [with_rank({"rid": rid, "name": n, "city": c1, "delta": d, "votes": v})
                 for rid, n, c1, v, _, d in drows],
                key=lambda x: -x["delta"])[:10],
            "zeroed": [{"name": n, "city": c1, "prev": b}
                       for rid, n, c1, v, b, _ in drows if b >= ZERO_FROM and v == 0][:20],
        }

    # forecast
    first_ts = c.execute("SELECT MIN(ts) FROM snapshot").fetchone()[0]
    forecast = []
    if first_ts and first_ts != now_ts:
        t1 = datetime.datetime.strptime(first_ts, "%Y-%m-%d %H:%M:%S")
        t2 = datetime.datetime.strptime(now_ts, "%Y-%m-%d %H:%M:%S")
        end = datetime.datetime.combine(END_DATE, datetime.time(23, 59))
        elapsed = max((t2 - t1).total_seconds() / 86400, 0.5)
        remain = max((end - t2).total_seconds() / 86400, 0)
        frows = c.execute("""
            WITH e AS (SELECT retailerId,votes FROM snapshot WHERE ts=?),
                 s AS (SELECT retailerId,votes FROM snapshot WHERE ts=?)
            SELECT r.name,r.city,e.votes,(e.votes-COALESCE(s.votes,0))*1.0/? per_day
            FROM e JOIN retailer r ON r.retailerId=e.retailerId
            LEFT JOIN s ON s.retailerId=e.retailerId
        """, (now_ts, first_ts, elapsed)).fetchall()
        forecast = sorted([
            {"name": n, "city": city, "now": v, "per_day": round(pd, 2),
             "projected": round(v + pd * remain)}
            for n, city, v, pd in frows], key=lambda x: -x["projected"])[:20]

    # suspects (Z-score)
    day_rows = c.execute("""SELECT retailerId, substr(ts,1,10) d, MAX(votes) v
        FROM snapshot GROUP BY retailerId, substr(ts,1,10)""").fetchall()
    by_rid = defaultdict(list)
    for rid, d, v in sorted(day_rows, key=lambda x: (x[0], x[1])):
        by_rid[rid].append((d, v))
    nm = dict(c.execute("SELECT retailerId, name||'（'||city||'）' FROM retailer"))
    suspects = []
    for rid, ser in by_rid.items():
        if len(ser) < 4:
            continue
        delt = [ser[i][1] - ser[i-1][1] for i in range(1, len(ser))]
        if len(delt) < 3:
            continue
        mu = statistics.mean(delt[:-1])
        sd = statistics.pstdev(delt[:-1]) or 1
        last = delt[-1]
        z = (last - mu) / sd
        if z >= 3 and last >= 30:
            suspects.append({"name": nm.get(rid, rid), "delta": last,
                             "avg": round(mu, 1), "z": round(z, 1)})
    suspects.sort(key=lambda x: -x["z"])
    suspects = suspects[:15]

    # watch list（從 watch.txt 讀關注店家）
    wf = pathlib.Path("watch.txt")
    watch_rids = []
    if wf.exists():
        for line in wf.read_text(encoding="utf-8").splitlines():
            line = line.split("#")[0].strip()
            if line:
                watch_rids.append(line)
    watch_rows = []
    if watch_rids:
        ph = ",".join("?" * len(watch_rids))
        for rid, n, city, addr, v in c.execute(
                f"""SELECT r.retailerId,r.name,r.city,r.address,s.votes
                    FROM snapshot s JOIN retailer r ON r.retailerId=s.retailerId
                    WHERE s.ts=? AND s.retailerId IN ({ph})
                    ORDER BY s.votes DESC""",
                (now_ts, *watch_rids)):
            prev = c.execute(
                "SELECT votes FROM snapshot WHERE retailerId=? AND ts<? ORDER BY ts DESC LIMIT 1",
                (rid, now_ts)).fetchone()
            watch_rows.append({
                "rid": rid, "name": n, "city": city, "address": addr,
                "votes": v, "prev": prev[0] if prev else None,
            })

    dump("watch.json", {"rids": watch_rids, "rows": watch_rows})
    dump("latest.json", {"ts": now_ts, "ts_iso": ts_iso, "rows": latest})
    dump("series.json", {"names": name_map, "series": dict(series)})
    dump("summary.json", {"ts": now_ts, "cities": city_rows,
                          "total_history": total_history})
    dump("alerts.json", {"ts": now_ts, "window_h": SPIKE_HOURS,
                         "spikes": spikes, "zeros": zeros, "drops": drops})
    dump("daily.json", daily or {})
    dump("forecast.json", {"end_date": str(END_DATE), "rows": forecast})
    dump("suspects.json", {"rows": suspects})

    c.close()
    print(f"匯出完成 @ {now_ts}  ({len(latest)} 店)")


if __name__ == "__main__":
    main()
