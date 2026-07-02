const j = p => fetch("data/" + p + "?t=" + Date.now()).then(r => r.json());
const $ = id => document.getElementById(id);

// ───── 時間格式（一律顯示台灣時區） ─────
const TW_FMT = new Intl.DateTimeFormat("zh-TW", {
  timeZone: "Asia/Taipei", hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});
const TW_SHORT = new Intl.DateTimeFormat("zh-TW", {
  timeZone: "Asia/Taipei", hour12: false,
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
function fmtTW(s, short = false) {
  if (!s) return "";
  // 後端送來的 ts 可能是 "YYYY-MM-DD HH:MM:SS"（已是 TW 時間，無 TZ）
  // 或 ts_iso "YYYY-MM-DDTHH:MM:SS+08:00"（有 TZ）
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "+08:00");
  if (isNaN(d)) return s;
  return (short ? TW_SHORT : TW_FMT).format(d).replace(/\//g, "-");
}

// ───── Tabs ─────
document.querySelectorAll(".tab").forEach(t => t.onclick = () => {
  document.querySelectorAll(".tab,.panel").forEach(e => e.classList.remove("active"));
  t.classList.add("active");
  document.querySelector(`.panel[data-p="${t.dataset.p}"]`).classList.add("active");
});

// ───── 手動刷新按鈕 ─────
const btn = $("refresh");
const hint = $("refreshHint");

// 台北時間的時鐘（回傳 {date:"YYYY-MM-DD", hour, min}）
function twNow() {
  const s = new Date().toLocaleString("en-CA", {
    timeZone: "Asia/Taipei", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }); // "2026-07-02, 23:04"
  const [date, time] = s.split(", ");
  const [hour, min] = time.split(":").map(Number);
  return { date, hour: hour % 24, min };
}
function twDate(iso) {
  return iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" }) : "";
}

// 自動每日更新（台北約 23:00 一次）→ 顯示下次更新倒數
function updateBtnState(latestTsIso) {
  const t = twNow();
  // 距離下一個台北 23:00 還有多久
  let mins = (23 - t.hour) * 60 - t.min;
  if (mins <= 0) mins += 24 * 60;         // 已過今天 23:00 → 算到明天
  const h = Math.floor(mins / 60), m = mins % 60;
  hint.textContent = `下次自動更新：每日約 23:00（約 ${h} 小時 ${m} 分後）`;
  setTimeout(() => updateBtnState(latestTsIso), 60000);
}

// 台北 23 點更新窗口：若「今天」的資料還沒進來就顯示提示 + 輪詢
function watchForUpdate(latestTsIso) {
  const t = twNow();
  const haveToday = twDate(latestTsIso) === t.date;
  if (t.hour === 23 && !haveToday) {
    $("ts").innerHTML =
      `<span class="tag" style="background:#fef3c7;color:#92400e">🔄 數據更新中…</span>` +
      `今日資料稍後更新`;
    // 30 秒後拉一次 latest.json 看今天的新資料來了沒
    setTimeout(async () => {
      try {
        const d = await fetch("data/latest.json?t=" + Date.now()).then(r => r.json());
        if (twDate(d.ts_iso || d.ts) === t.date) {
          location.reload();
        } else {
          watchForUpdate(latestTsIso);
        }
      } catch (e) {
        watchForUpdate(latestTsIso);
      }
    }, 30000);
    return true;
  }
  return false;
}

btn.onclick = async () => {
  if (!window.CONFIG || !CONFIG.workerUrl || CONFIG.workerUrl === "PASTE_YOUR_WORKER_URL_HERE") {
    alert("尚未設定 Worker 網址，請編輯 docs/config.js");
    return;
  }
  btn.disabled = true; btn.textContent = "觸發中…";
  try {
    const r = await fetch(CONFIG.workerUrl, { method: "POST" });
    if (r.ok) {
      localStorage.setItem("manualClick", Date.now());
      btn.textContent = "✓ 已觸發，約 1-2 分後完成";
      setTimeout(() => location.reload(), 90000);
    } else {
      const t = await r.text();
      alert(`觸發失敗 ${r.status}: ${t}`);
      btn.textContent = "🔄 立即更新"; btn.disabled = false;
    }
  } catch (e) {
    alert("錯誤: " + e.message);
    btn.textContent = "🔄 立即更新"; btn.disabled = false;
  }
};

// ───── 表格 helper ─────
const tbl = (cols, rows, empty = "無資料") => rows.length
  ? `<div class="tableWrap"><table><thead><tr>${cols.map(c => `<th>${c[0]}</th>`).join("")}</tr></thead>
     <tbody>${rows.map((r, i) => `<tr>${cols.map(c => `<td>${c[1](r, i)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
  : `<div class="empty">${empty}</div>`;

// ───── 載入並渲染 ─────
Promise.all(["latest", "series", "summary", "alerts", "daily", "forecast", "suspects", "watch"]
  .map(n => j(n + ".json").catch(() => ({}))))
.then(([latest, series, summary, alerts, daily, forecast, suspects, watch]) => {

  const watchSet = new Set((watch && watch.rids) || []);
  const star = rid => watchSet.has(rid) ? "⭐ " : "";

  // 排名變化 icon (台股慣例: 紅升綠跌)
  const RANK_HTML = {
    up:   '<span style="color:#dc2626;font-weight:bold">▲</span>',
    down: '<span style="color:#16a34a;font-weight:bold">▼</span>',
    flat: '<span style="color:#999">─</span>',
    "new": '<span style="color:#f59e0b">✦</span>',
  };
  const rankCell = r => {
    const ic = RANK_HTML[r.rank_change] || "";
    const d = r.rank_delta;
    const tip = r.rank_change === "up"   ? `↑${d}`
              : r.rank_change === "down" ? `↓${-d}`
              : r.rank_change === "new"  ? "新進"
              : "";
    return `<span title="${tip}">${ic}</span>`;
  };

  if (!latest.rows) {
    $("ts").innerHTML = "<span class='tag'>還沒有資料</span> 等 Action 第一次跑完";
    return;
  }

  $("ts").innerHTML = `<span class="tag">更新於 ${fmtTW(latest.ts_iso || latest.ts)} (UTC+8)</span>共 ${latest.rows.length} 家店`;
  updateBtnState(latest.ts_iso);
  watchForUpdate(latest.ts_iso);

  // 全國排名（從 latest.rows 算）
  const rankMap = {};
  latest.rows.forEach((r, i) => { rankMap[r.rid] = i + 1; });

  // 關注清單卡片 + 隱藏切換
  if (watch && watch.rows && watch.rows.length) {
    $("watchCard").style.display = "";
    const box = $("watchBox"), tg = $("watchToggle");
    const apply = (hidden) => {
      box.style.display = hidden ? "none" : "";
      tg.textContent = hidden ? "顯示" : "隱藏";
    };
    apply(localStorage.getItem("watchHidden") === "1");
    tg.onclick = () => {
      const h = box.style.display !== "none";
      localStorage.setItem("watchHidden", h ? "1" : "0");
      apply(h);
    };
    $("watchBox").innerHTML = tbl(
      [["#", r => rankMap[r.rid] || "-"],
       ["店家", r => "⭐ " + r.name],
       ["票數", r => {
          const d = r.prev == null ? null : (r.votes - r.prev);
          const tag = d == null ? "" :
            ` <span class="v ${d>=0?'up':'down'}">${d>=0?'+':''}${d}</span>`;
          return `<b>${r.votes}</b>${tag}`;
       }],
       ["縣市", r => r.city],
       ["地址", r => r.address]],
      watch.rows);
  }

  // ── 總覽 ──
  $("top5").innerHTML = tbl(
    [["#", (r, i) => `${i + 1} ${rankCell(r)}`],
     ["店家", r => star(r.rid) + r.name],
     ["票數", r => `<b>${r.votes}</b>`],
     ["縣市", r => r.city]],
    latest.rows.slice(0, 5));

  const h = summary.total_history || [];
  Plotly.newPlot("total",
    [{ x: h.map(r => fmtTW(r[0], true)), y: h.map(r => r[1]),
       type: "scatter", mode: "lines",
       fill: "tozeroy", line: { color: "#3b82f6" } }],
    { margin: { t: 20 }, yaxis: { title: "票數" },
      xaxis: { title: "台灣時間" } },
    { responsive: true });

  const renderTopChart = (n) => {
    Plotly.newPlot("top10", latest.rows.slice(0, n).map(r => {
      const s = (series.series && series.series[r.rid]) || [];
      return { x: s.map(p => fmtTW(p[0], true)), y: s.map(p => p[1]),
               name: series.names ? series.names[r.rid] : r.name,
               type: "scatter", mode: "lines+markers" };
    }), { margin: { t: 20 }, legend: { orientation: "h", y: -0.3 },
          xaxis: { title: "台灣時間" } },
       { responsive: true });
  };
  const topSel = $("topN");
  const savedN = +localStorage.getItem("topN") || 10;
  topSel.value = String(savedN);
  renderTopChart(savedN);
  topSel.onchange = () => {
    const n = +topSel.value;
    localStorage.setItem("topN", n);
    renderTopChart(n);
  };

  Plotly.newPlot("cities",
    [{ x: (summary.cities || []).map(c => c.city),
       y: (summary.cities || []).map(c => c.votes),
       type: "bar", marker: { color: "#10b981" },
       text: (summary.cities || []).map(c => `${c.shops}店`),
       textposition: "outside" }],
    { margin: { t: 20, b: 80 }, yaxis: { title: "票數" } },
    { responsive: true });

  // ── 異常 ──
  $("winT").textContent = alerts.threshold || 100;
  const deltaCell = r =>
    `<span class="v ${r.delta >= 0 ? 'up' : 'down'}">${r.prev} → <b>${r.now}</b> (${r.delta >= 0 ? '+' : ''}${r.delta})</span>`;
  $("spikes").innerHTML = tbl(
    [["店家", r => r.name], ["變化", deltaCell],
     ["縣市", r => r.city], ["地址", r => r.address]],
    alerts.spikes || [], "無暴衝");
  $("zeros").innerHTML = tbl(
    [["店家", r => r.name],
     ["變化", r => `<span class="v down">${r.prev} → <b>0</b></span>`],
     ["縣市", r => r.city], ["地址", r => r.address]],
    alerts.zeros || [], "無歸零事件");
  $("drops").innerHTML = tbl(
    [["店家", r => r.name], ["變化", deltaCell],
     ["縣市", r => r.city], ["地址", r => r.address]],
    alerts.drops || [], "無倒退");
  $("suspects").innerHTML = tbl(
    [["店家", r => r.name], ["當日增票", r => `+${r.delta}`],
     ["歷史平均", r => r.avg], ["Z 分數", r => `<b>${r.z}</b>`]],
    (suspects && suspects.rows) || [], "資料不足（需 ≥4 天）");

  // ── 每日 ──
  if (daily && daily.date) {
    const d = daily;
    $("dailyBox").innerHTML = `
      <h3>📅 ${d.date} 報表</h3>
      <p>全國 ${d.total_start} → <b>${d.total_now}</b>
         <span class="v up">(+${d.total_now - d.total_start})</span></p>
      <h4>票數 TOP 10</h4>
      ${tbl([["#", (r, i) => `${i + 1} ${rankCell(r)}`],
             ["店家", r => star(r.rid) + r.name],
             ["票數", r => r.votes],
             ["縣市", r => r.city]], d.top_now || [])}
      <h4>單日增幅 TOP 20（依最近一日增票排序）</h4>
      ${tbl([["#", (r, i) => `${i + 1} ${rankCell(r)}`],
             ["店家", r => star(r.rid) + r.name],
             [`${(d.dates && d.dates.day_before) || "前天"}`,
              r => r.delta_db == null ? "-" : `+${r.delta_db}`],
             [`${(d.dates && d.dates.yesterday) || "昨天"}`,
              r => r.delta_yest == null ? "-" : `+${r.delta_yest}`],
             [`${(d.dates && d.dates.today) || "今天"}`,
              r => r.delta_today == null ? "-" :
                `<b style="color:#2563eb">+${r.delta_today}</b>`],
             ["現票", r => r.votes],
             ["縣市", r => r.city]],
            d.top_gain || [])}
      <h4>歸零店家</h4>
      ${tbl([["店家", r => r.name],
             ["原票數", r => r.prev],
             ["縣市", r => r.city]],
            d.zeroed || [], "今日無歸零")}`;
  } else {
    $("dailyBox").innerHTML = `<div class="empty">資料不足（明天起會有日報）</div>`;
  }

  // ── 預估 ──
  $("endDate").textContent = (forecast && forecast.end_date) || "—";
  $("forecastBox").innerHTML = tbl(
    [["#", (_, i) => i + 1], ["店家", r => r.name],
     ["預估最終", r => `<b>${r.projected}</b>`],
     ["當下", r => r.now], ["日均", r => r.per_day],
     ["縣市", r => r.city]],
    (forecast && forecast.rows) || [], "資料不足");

  // ── 排行 ──
  const renderRows = rs => $("rows").innerHTML = rs.map((r, i) =>
    `<tr${watchSet.has(r.rid)?' style="background:#fffbea"':''}>
     <td>${i + 1} ${rankCell(r)}</td><td>${star(r.rid)}${r.name}</td>
     <td class="v">${r.votes}</td><td>${r.city}</td><td>${r.address}</td></tr>`).join("");
  renderRows(latest.rows.slice(0, 100));
  $("q").oninput = e => {
    const q = e.target.value.trim().toLowerCase();
    renderRows(q
      ? latest.rows.filter(r =>
          r.name.toLowerCase().includes(q) ||
          r.address.toLowerCase().includes(q)
        ).slice(0, 100)
      : latest.rows.slice(0, 100));
  };
});
