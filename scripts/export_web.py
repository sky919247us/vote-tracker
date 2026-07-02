"""SQLite → 前端用的所有 JSON。一次算完 TOP/暴衝/歸零/日報/預估/疑似刷票。"""
import os, sqlite3, json, datetime, statistics, pathlib
from collections import defaultdict

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

DB = "votes.db"
OUT = pathlib.Path("docs/data")
OUT.mkdir(parents=True, exist_ok=True)

END_DATE = datetime.date(2026, 7, 31)
SPIKE_HOURS = 12
SPIKE_THRESHOLD = 100
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
    except Exception:
        ts_iso = now_ts
    # 「今天」以 DB 最新 snapshot 的日期為準（避免系統時鐘與 DB 不同步時誤判）
    today = datetime.date.fromisoformat(now_ts[:10])
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

    # series for top 50 — 每天只取一個點（當日最後一筆）
    top_rids = [r["rid"] for r in latest[:50]]
    raw_series = defaultdict(list)
    if top_rids:
        ph = ",".join("?" * len(top_rids))
        for rid, ts, v in c.execute(
                f"""SELECT retailerId,ts,votes FROM snapshot
                    WHERE retailerId IN ({ph}) ORDER BY retailerId,ts""", top_rids):
            raw_series[rid].append([ts, v])
    # 降採樣：每一天只留當日最後一筆
    series = {}
    for rid, pts in raw_series.items():
        bucket = {}
        for ts, v in pts:
            bucket[ts[:10]] = [ts, v]    # 同日後寫蓋前
        series[rid] = [bucket[k] for k in sorted(bucket)]
    name_map = {r["rid"]: f"{r['name']}（{r['city']}）" for r in latest[:50]}

    # alerts：與「前一日」那筆比較（資料一天一筆）
    prev_day_ts = c.execute(
        "SELECT MAX(ts) FROM snapshot WHERE date(ts) < date(?)", (now_ts,)).fetchone()[0]
    if prev_day_ts:
        diff_rows = c.execute("""
            WITH latest AS (SELECT retailerId,votes FROM snapshot WHERE ts=?),
            baseline AS (SELECT retailerId,votes FROM snapshot WHERE ts=?)
            SELECT r.name,r.city,r.address,l.votes,COALESCE(b.votes,0),
                   l.votes-COALESCE(b.votes,0) d
            FROM latest l JOIN retailer r ON r.retailerId=l.retailerId
            LEFT JOIN baseline b ON b.retailerId=l.retailerId
            ORDER BY d DESC""", (now_ts, prev_day_ts)).fetchall()
    else:
        diff_rows = []

    def row(name, city, addr, v, b, d):
        return {"name": name, "city": city, "address": addr,
                "now": v, "prev": b, "delta": d}

    spikes = [row(*r) for r in diff_rows if r[5] >= SPIKE_THRESHOLD][:100]
    zeros = [row(*r) for r in diff_rows if r[4] >= ZERO_FROM and r[3] == 0]
    drops = [row(*r) for r in diff_rows if r[5] <= DROP_THRESHOLD][:100]

    # summary
    city_rows = [
        {"city": city, "votes": v, "shops": n}
        for city, v, n in c.execute("""
            SELECT r.city,SUM(s.votes),COUNT(*) FROM snapshot s
            JOIN retailer r ON r.retailerId=s.retailerId
            WHERE s.ts=? GROUP BY r.city ORDER BY SUM(s.votes) DESC""", (now_ts,))
    ]
    # 全國總票數趨勢：每天只取一個點（當日最後一筆快照的全國加總）
    _th_bucket = {}
    for ts, tot in c.execute(
            "SELECT ts, SUM(votes) FROM snapshot GROUP BY ts ORDER BY ts"):
        _th_bucket[ts[:10]] = [ts, tot]   # 同日後寫蓋前
    total_history = [_th_bucket[d] for d in sorted(_th_bucket)]

    # daily：資料已改為「一天一筆」（每日約 23:00 一筆），用連續每日快照算日增
    # delta_today = 最近一日增票、delta_yest = 前一日、delta_db = 再前一日
    day_ts = [r[0] for r in c.execute(
        "SELECT MAX(ts) FROM snapshot GROUP BY date(ts) ORDER BY date(ts)")]
    daily = None
    if len(day_ts) >= 2:
        t_today = day_ts[-1]
        t_yest  = day_ts[-2]
        t_dbef  = day_ts[-3] if len(day_ts) >= 3 else None
        t_ref   = day_ts[-4] if len(day_ts) >= 4 else None

        def vmap(ts):
            return dict(c.execute("SELECT retailerId,votes FROM snapshot WHERE ts=?",
                                  (ts,))) if ts else {}
        m_today, m_yest = vmap(t_today), vmap(t_yest)
        m_dbef,  m_ref  = vmap(t_dbef),  vmap(t_ref)

        def rankmap(ts):
            return {rid: i+1 for i, (rid,) in enumerate(c.execute(
                "SELECT retailerId FROM snapshot WHERE ts=? ORDER BY votes DESC, retailerId",
                (ts,)))} if ts else {}
        rk_today, rk_yest = rankmap(t_today), rankmap(t_yest)

        def rchange(rid):
            cur, pr = rk_today.get(rid), rk_yest.get(rid)
            if cur is None: return ("flat", 0)
            if pr is None:  return ("new", 0)
            if pr > cur:    return ("up", pr - cur)
            if pr < cur:    return ("down", pr - cur)
            return ("flat", 0)

        retailer_info = dict(c.execute(
            "SELECT retailerId, name||'|'||city FROM retailer"))
        gain_rows = []
        for rid, namecity in retailer_info.items():
            if rid not in m_today and rid not in m_yest:
                continue
            name, city = namecity.split("|", 1)
            vt = m_today.get(rid, 0)
            today_g = vt - m_yest.get(rid, 0)
            yest_g = (m_yest.get(rid, 0) - m_dbef.get(rid, 0)) if t_dbef else None
            db_g   = (m_dbef.get(rid, 0) - m_ref.get(rid, 0)) if t_ref else None
            ch, dl = rchange(rid)
            gain_rows.append({
                "rid": rid, "name": name, "city": city, "votes": vt,
                "delta_db": db_g, "delta_yest": yest_g, "delta_today": today_g,
                "delta": today_g, "rank_change": ch, "rank_delta": dl,
            })
        gain_rows.sort(key=lambda x: (-(x["delta_today"] or 0),
                                      -(x["delta_yest"] or 0),
                                      -(x["votes"] or 0)))

        top_now = []
        for rid, n, c1, v in c.execute("""
                SELECT r.retailerId, r.name, r.city, s.votes FROM snapshot s
                JOIN retailer r ON r.retailerId=s.retailerId
                WHERE s.ts=? ORDER BY s.votes DESC, r.retailerId LIMIT 10""", (t_today,)):
            ch, dl = rchange(rid)
            top_now.append({"rid": rid, "name": n, "city": c1, "votes": v,
                            "rank_change": ch, "rank_delta": dl})

        zeroed = []
        for rid in m_yest:
            if m_yest.get(rid, 0) >= ZERO_FROM and m_today.get(rid, 0) == 0:
                name, city = retailer_info.get(rid, "|").split("|", 1)
                zeroed.append({"name": name, "city": city, "prev": m_yest[rid]})
        zeroed = zeroed[:20]

        daily = {
            "date": t_yest[:10],
            "dates": {
                "day_before": (t_dbef[:10] if t_dbef else t_yest[:10]),
                "yesterday":  t_yest[:10],
                "today":      t_today[:10],
            },
            "total_now": sum(m_today.values()),
            "total_start": sum(m_yest.get(rid, 0) for rid in m_today),
            "top_now": top_now,
            "top_gain": gain_rows[:20],
            "zeroed": zeroed,
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
                         "threshold": SPIKE_THRESHOLD,
                         "spikes": spikes, "zeros": zeros, "drops": drops})
    dump("daily.json", daily or {})
    dump("forecast.json", {"end_date": str(END_DATE), "rows": forecast})
    dump("suspects.json", {"rows": suspects})

    c.close()
    print(f"匯出完成 @ {now_ts}  ({len(latest)} 店)")


if __name__ == "__main__":
    main()
