const j = p => fetch("data/" + p + "?t=" + Date.now()).then(r => r.json());
const $ = id => document.getElementById(id);

// ───── Tabs ─────
document.querySelectorAll(".tab").forEach(t => t.onclick = () => {
  document.querySelectorAll(".tab,.panel").forEach(e => e.classList.remove("active"));
  t.classList.add("active");
  document.querySelector(`.panel[data-p="${t.dataset.p}"]`).classList.add("active");
});

// ───── 手動刷新按鈕 ─────
const btn = $("refresh");
const hint = $("refreshHint");
const COOL = (window.CONFIG && window.CONFIG.cooldownMs) || 3600 * 1000;

function updateBtnState(latestTsIso) {
  const lastUpdate = latestTsIso ? new Date(latestTsIso).getTime() : 0;
  const local = +localStorage.getItem("manualClick") || 0;
  const last = Math.max(lastUpdate, local);
  const wait = COOL - (Date.now() - last);
  if (wait > 0) {
    btn.disabled = true;
    const m = Math.ceil(wait / 60000);
    hint.textContent = `（${m} 分鐘後可再次更新）`;
    setTimeout(() => updateBtnState(latestTsIso), Math.min(wait, 60000));
  } else {
    btn.disabled = false;
    hint.textContent = "";
  }
}

btn.onclick = async () => {
  if (!window.CONFIG || !CONFIG.pat_b64 || CONFIG.pat_b64 === "PASTE_YOUR_BASE64_PAT_HERE") {
    alert("尚未設定 PAT，請編輯 docs/config.js");
    return;
  }
  btn.disabled = true; btn.textContent = "觸發中…";
  try {
    const pat = atob(CONFIG.pat_b64);
    const url = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/actions/workflows/${CONFIG.workflow}/dispatches`;
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + pat,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: "main" }),
    });
    if (r.status === 204) {
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
Promise.all(["latest", "series", "summary", "alerts", "daily", "forecast", "suspects"]
  .map(n => j(n + ".json").catch(() => ({}))))
.then(([latest, series, summary, alerts, daily, forecast, suspects]) => {

  if (!latest.rows) {
    $("ts").innerHTML = "<span class='tag'>還沒有資料</span> 等 Action 第一次跑完";
    return;
  }

  $("ts").innerHTML = `<span class="tag">更新於 ${latest.ts}</span>共 ${latest.rows.length} 家店`;
  updateBtnState(latest.ts_iso);

  // ── 總覽 ──
  $("top5").innerHTML = tbl(
    [["#", (_, i) => i + 1], ["店家", r => r.name], ["縣市", r => r.city],
     ["票數", r => `<b>${r.votes}</b>`]],
    latest.rows.slice(0, 5));

  const h = summary.total_history || [];
  Plotly.newPlot("total",
    [{ x: h.map(r => r[0]), y: h.map(r => r[1]), type: "scatter", mode: "lines",
       fill: "tozeroy", line: { color: "#3b82f6" } }],
    { margin: { t: 20 }, yaxis: { title: "票數" } },
    { responsive: true });

  Plotly.newPlot("top10", latest.rows.slice(0, 10).map(r => {
    const s = (series.series && series.series[r.rid]) || [];
    return { x: s.map(p => p[0]), y: s.map(p => p[1]),
             name: series.names ? series.names[r.rid] : r.name,
             type: "scatter", mode: "lines+markers" };
  }), { margin: { t: 20 }, legend: { orientation: "h", y: -0.3 } },
     { responsive: true });

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
      ${tbl([["#", (_, i) => i + 1], ["店家", r => r.name],
             ["縣市", r => r.city], ["票數", r => r.votes]], d.top_now || [])}
      <h4>單日增幅 TOP 10</h4>
      ${tbl([["#", (_, i) => i + 1], ["店家", r => r.name], ["縣市", r => r.city],
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
  const renderRows = rs => $("rows").innerHTML = rs.map((r, i) =>
    `<tr><td>${i + 1}</td><td>${r.name}</td><td>${r.city}</td>
     <td>${r.address}</td><td class="v">${r.votes}</td></tr>`).join("");
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
