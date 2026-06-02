# 台彩投票看板

抓 [台彩投注站票選活動](https://vote.sportslottery.com.tw/) 每日 2 次（TW 09:00 / 21:00），用 GitHub Pages 顯示即時看板。

## 功能

- **總覽**：TOP 5、全國總票數趨勢、TOP 10 走勢、縣市排行
- **🚨 異常**：暴衝（12h ≥10 票）、票數歸零、大幅倒退、Z-score 疑似刷票
- **📅 每日**：昨日全國變化、TOP 10、單日增幅、歸零店家
- **🔮 預估**：線性外推到 2026-07-31 的最終排名
- **店家排行**：3,500+ 店全文搜尋
- **🔄 手動更新**：網頁按鈕觸發 GitHub Action，限 1 小時 1 次

## 架構

```
GitHub Actions (cron 2x/day) ─→ scrape.py ─→ votes.db ─→ export_web.py ─→ docs/data/*.json
                                                                              ↓
                                                                      GitHub Pages
```

## 部署步驟

### 1. 在 GitHub 建立 repo

到 https://github.com/new
- Name: `vote-tracker`（或任何你喜歡的名稱）
- **Public**（GitHub Pages 免費版需公開）
- 不要勾任何初始檔

### 2. push 本地專案

```powershell
cd D:\投注站投票
git remote add origin https://github.com/YOUR_USERNAME/vote-tracker.git
git branch -M main
git push -u origin main
```

### 3. 開啟 GitHub Pages

repo 頁面 → **Settings** → **Pages**
- Source: **Deploy from a branch**
- Branch: `main` / folder: `/docs`
- Save

### 4. 手動觸發第一次抓取

repo 頁面 → **Actions** → 左邊選 `scrape` → 右上 **Run workflow** → 綠勾

等約 1 分鐘跑完，Actions 會 commit 一筆 snapshot。

### 5. 開網頁

`https://YOUR_USERNAME.github.io/vote-tracker/`

第一次看到的會是「等 Action 第一次跑完」。重新整理就有資料。

---

## 設定手動更新按鈕（選用）

按鈕需要 GitHub PAT 才能觸發 workflow。

### 取得 PAT

1. https://github.com/settings/personal-access-tokens/new
2. Token name: `vote-tracker-dispatch`
3. **Repository access**: Only select repositories → 選 `vote-tracker`
4. **Repository permissions**:
   - **Actions**: Read and write
   - Metadata: Read（自動）
   - 其他全不勾
5. Generate token → **複製**（只看得到一次）

### Base64 編碼

PowerShell：

```powershell
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("github_pat_貼這裡"))
```

### 編輯 `docs/config.js`

```javascript
window.CONFIG = {
  owner: "你的github帳號",
  repo:  "vote-tracker",
  workflow: "scrape.yml",
  pat_b64: "上面 base64 的結果",
  cooldownMs: 3600 * 1000,
};
```

commit & push：

```powershell
git add docs/config.js
git commit -m "config: set PAT"
git push
```

### 風險說明

PAT 會出現在公開 JS 裡。**最壞情況**：別人可以觸發你的 workflow_dispatch。但：
- workflow 自己限制 1 小時 1 次（看 `votes.db` 上次 commit 時間）
- public repo Actions 免費無限額度
- PAT 只能對這個 repo 做 Actions 操作，不能改 code、不能存取其他 repo

如果完全不想暴露 PAT → 改用 Cloudflare Worker proxy（5 分鐘設定，README 暫不展開）。

---

## 本地測試

```powershell
pip install -r requirements.txt
python scripts/scrape.py
python scripts/export_web.py
```

然後用瀏覽器開 `docs/index.html`（或起個本機 server）：

```powershell
cd docs
python -m http.server 8000
# 開 http://localhost:8000
```

## 檔案結構

```
.
├── .github/workflows/scrape.yml   # 每日 2 次 cron
├── scripts/
│   ├── scrape.py                  # 抓 22 縣市 → SQLite
│   └── export_web.py              # SQLite → JSON
├── docs/                          # GitHub Pages 根目錄
│   ├── index.html
│   ├── app.js
│   ├── config.js                  # ← 編輯 PAT
│   └── data/                      # Actions 自動產生
├── watch.txt                      # （備用）關注清單
├── votes.db                       # SQLite，會被 Actions commit
├── requirements.txt
└── README.md
```

## 調整參數

`scripts/export_web.py` 頂部：

```python
END_DATE = datetime.date(2026, 7, 31)   # 活動結束日
SPIKE_HOURS = 12                        # 暴衝偵測視窗
SPIKE_THRESHOLD = 10                    # 暴衝門檻
ZERO_FROM = 20                          # 歸零定義（從 ≥N 票掉到 0）
DROP_THRESHOLD = -10                    # 倒退門檻
```

## 資料來源

- 投注站票數頁面：`https://blob.sportslottery.com.tw/static/map2/iframe/{CityName}.html`
- 每小時官方更新一次，本系統取 2 次/天
