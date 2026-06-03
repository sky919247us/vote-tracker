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

// 規則：當小時內已更新過 → 鎖到下個整點才能再按
function updateBtnState(latestTsIso) {
  const lastUpdate = latestTsIso ? new Date(latestTsIso).getTime() : 0;
  const local = +localStorage.getItem("manualClick") || 0;
  const last = Math.max(lastUpdate, local);
  const nextAllowed = last > 0 ? (Math.floor(last / 3600000) + 1) * 3600000 : 0;
  const wait = nextAllowed - Date.now();
  if (wait > 0) {
    btn.disabled = true;
    const m = Math.ceil(wait / 60000);
    const nextTime = new Date(nextAllowed).toLocaleTimeString("zh-TW",
      { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false });
    hint.textContent = `（本小時已更新過，${nextTime} 後可再按；剩 ${m} 分）`;
    setTimeout(() => updateBtnState(latestTsIso), Math.min(wait, 60000));
  } else {
    btn.disabled = false;
    hint.textContent = "";
  }
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
  ? `<table><thead><tr>${cols.map(c => `<th>${c[0]}</th>`).join("")}</tr></thead>
     <tbody>${rows.map((r, i) => `<tr>${cols.map(c => `<td>${c[1](r, i)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
  : `<div class="empty">${empty}</div>`;

// ───── 載入並渲染 ─────
Promise.all(["latest", "series", "summary", "alerts", "daily", "forecast", "suspects", "watch"]
  .map(n => j(n + ".json").catch(() => ({}))))
.then(([latest, series, summary, alerts, daily, forecast, suspects, watch]) => {

  const watchSet = new Set((watch && watch.rids) || []);
  const star = rid => watchSet.has(rid) ? "⭐ " : "";

  if (!latest.rows) {
    $("ts").innerHTML = "<span class='tag'>還沒有資料</span> 等 Action 第一次跑完";
    return;
  }

  $("ts").innerHTML = `<span class="tag">更新於 ${fmtTW(latest.ts_iso || latest.ts)} (UTC+8)</span>共 ${latest.rows.length} 家店`;
  updateBtnState(latest.ts_iso);

  // 關注清單卡片
  if (watch && watch.rows && watch.rows.length) {
    $("watchCard").style.display = "";
    $("watchBox").innerHTML = tbl(
      [["店家", r => "⭐ " + r.name],
       ["縣市", r => r.city],
       ["地址", r => r.address],
       ["票數", r => {
          const d = r.prev == null ? null : (r.votes - r.prev);
          const tag = d == null ? "" :
            ` <span class="v ${d>=0?'up':'down'}">${d>=0?'+':''}${d}</span>`;
          return `<b>${r.votes}</b>${tag}`;
       }]],
      watch.rows);
  }

  // ── 總覽 ──
  $("top5").innerHTML = tbl(
    [["#", (r, i) => `${i + 1} ${rankCell(r)}`],
     ["店家", r => star(r.rid) + r.name], ["縣市", r => r.city],
     ["票數", r => `<b>${r.votes}</b>`]],
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
  $("winH").textContent = alerts.window_h || 12;
  const deltaCell = r =>
    `<span class="v ${r.delta >= 0 ? 'up' : 'down'}">${r.prev} → <b>${r.now}</b> (${r.delta >= 0 ? '+' : ''}${r.delta})</span>`;
  $("spikes").innerHTML = tbl(
    [["店家", r => r.name], ["縣市", r => r.city], ["地址", r => r.address],
     ["變化", deltaCell]],
    alerts.spikes || [], "無暴衝");
  $("zeros").innerHTML = tbl(
    [["店家", r => r.name], ["縣市", r => r.city], ["地址", r => r.address],
     ["變化", r => `<span class="v down">${r.prev} → <b>0</b></span>`]],
    alerts.zeros || [], "無歸零事件");
  $("drops").innerHTML = tbl(
    [["店家", r => r.name], ["縣市", r => r.city], ["地址", r => r.address],
     ["變化", deltaCell]],
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
             ["縣市", r => r.city], ["票數", r => r.votes]], d.top_now || [])}
      <h4>單日增幅 TOP 10</h4>
      ${tbl([["#", (r, i) => `${i + 1} ${rankCell(r)}`],
             ["店家", r => star(r.rid) + r.name], ["縣市", r => r.city],
             ["增票", r => `+${r.delta}`], ["當下", r => r.votes]],
            d.top_gain || [])}
      <h4>歸零店家</h4>
      ${tbl([["店家", r => r.name], ["縣市", r => r.city], ["原票數", r => r.prev]],
            d.zeroed || [], "今日無歸零")}`;
  } else {
    $("dailyBox").innerHTML = `<div class="empty">資料不足（明天起會有日報）</div>`;
  }

  // ── 預估 ──
  $("endDate").textContent = (forecast && forecast.end_date) || "—";
  $("forecastBox").innerHTML = tbl(
    [["#", (_, i) => i + 1], ["店家", r => r.name], ["縣市", r => r.city],
     ["當下", r => r.now], ["日均", r => r.per_day],
     ["預估最終", r => `<b>${r.projected}</b>`]],
    (forecast && forecast.rows) || [], "資料不足");

  // ── 排行 ──
  // 台股慣例: 紅=上漲, 綠=下跌
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
  const renderRows = rs => $("rows").innerHTML = rs.map((r, i) =>
    `<tr${watchSet.has(r.rid)?' style="background:#fffbea"':''}>
     <td>${i + 1} ${rankCell(r)}</td><td>${star(r.rid)}${r.name}</td>
     <td>${r.city}</td><td>${r.address}</td><td class="v">${r.votes}</td></tr>`).join("");
  renderRows(latest.rows.slice(0, 200));
  $("q").oninput = e => {
    const q = e.target.value.trim().toLowerCase();
    renderRows(q
      ? latest.rows.filter(r =>
          r.name.toLowerCase().includes(q) ||
          r.address.toLowerCase().includes(q)
        ).slice(0, 200)
      : latest.rows.slice(0, 200));
  };
});
