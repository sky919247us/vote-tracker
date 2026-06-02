// Worker 代理 URL（PAT 藏在 Cloudflare，不會曝露在公開頁面）
window.CONFIG = {
  workerUrl: "https://vote-tracker.sky919247us.workers.dev",
  cooldownMs: 3600 * 1000,
};
