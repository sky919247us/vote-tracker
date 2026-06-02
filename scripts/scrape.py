"""抓 22 縣市投注站票數 → SQLite。"""
import os, re, time, sqlite3, datetime, sys, pathlib
import requests
from bs4 import BeautifulSoup

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

CITIES = [
    ("基隆市","KeelungCity"),("台北市","TaipeiCity"),("新北市","NewTaipeiCity"),
    ("桃園市","TaoyuanCounty"),("新竹市","HsinchuCity"),("新竹縣","HsinchuCounty"),
    ("苗栗縣","MiaoliCounty"),("台中市","TaichungCity"),("彰化縣","ChanghuaCounty"),
    ("南投縣","NantouCounty"),("雲林縣","YunlinCounty"),("嘉義市","ChiayiCity"),
    ("嘉義縣","ChiayiCounty"),("台南市","TainanCity"),("高雄市","KaohsiungCity"),
    ("屏東縣","PingtungCounty"),("台東縣","TaitungCounty"),("花蓮縣","HualienCounty"),
    ("宜蘭縣","YilanCounty"),("澎湖縣","PenghuCounty"),("金門縣","KinmenCounty"),
    ("連江縣","LienchiangCounty"),
]
URL = "https://blob.sportslottery.com.tw/static/map2/iframe/{}.html"
RID_RE = re.compile(r"retailerId=(\d+)")
DB = "votes.db"
FAIL_LOG = pathlib.Path("fail_count.txt")


def init_db():
    c = sqlite3.connect(DB)
    c.executescript("""
      CREATE TABLE IF NOT EXISTS retailer(
        retailerId TEXT PRIMARY KEY, name TEXT, address TEXT, city TEXT);
      CREATE TABLE IF NOT EXISTS snapshot(
        ts TEXT, retailerId TEXT, votes INTEGER,
        PRIMARY KEY(ts, retailerId));
      CREATE INDEX IF NOT EXISTS idx_snap_rid ON snapshot(retailerId);
    """)
    return c


def parse(city, slug):
    r = requests.get(URL.format(slug), timeout=15)
    r.raise_for_status()
    r.encoding = r.apparent_encoding
    soup = BeautifulSoup(r.text, "html.parser")
    out = []
    for tr in soup.select("tr"):
        tds = tr.find_all("td")
        if len(tds) < 5:
            continue
        a = tds[3].find("a", href=RID_RE)
        if not a:
            continue
        rid = RID_RE.search(a["href"]).group(1)
        name = tds[0].get_text(strip=True)
        addr = tds[1].get_text(strip=True)
        votes = int(re.sub(r"\D", "", tds[4].get_text(strip=True)) or 0)
        out.append((rid, name, addr, city, votes))
    return out


def load_fails():
    if not FAIL_LOG.exists():
        return {}
    return dict(l.split("\t") for l in FAIL_LOG.read_text(encoding="utf-8").splitlines() if l)


def save_fails(d):
    FAIL_LOG.write_text("\n".join(f"{k}\t{v}" for k, v in d.items()), encoding="utf-8")


def main():
    # 用台灣時間
    try:
        import zoneinfo
        ts = datetime.datetime.now(zoneinfo.ZoneInfo("Asia/Taipei")).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        ts = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

    c = init_db()
    fails = load_fails()
    total = 0
    for tw, slug in CITIES:
        try:
            rows = parse(tw, slug)
            # 連江縣可能 0 站，不算錯
            for rid, name, addr, city, v in rows:
                c.execute("INSERT OR REPLACE INTO retailer VALUES(?,?,?,?)",
                          (rid, name, addr, city))
                c.execute("INSERT OR IGNORE INTO snapshot VALUES(?,?,?)",
                          (ts, rid, v))
                total += 1
            fails[slug] = "0"
        except Exception as e:
            n = int(fails.get(slug, "0")) + 1
            fails[slug] = str(n)
            print(f"!! {tw}: {e}", file=sys.stderr)
        time.sleep(0.4)
    c.commit()
    c.close()
    save_fails(fails)
    print(f"{ts}  寫入 {total} 筆")


if __name__ == "__main__":
    main()
