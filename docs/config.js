// Worker 代理 URL（PAT 藏在 Cloudflare，不會曝露在公開頁面）
// 建立 Worker 步驟見 README「Cloudflare Worker 部署」一節。
window.CONFIG = {
  workerUrl: "PASTE_YOUR_WORKER_URL_HERE",  // 例: https://vote-tracker.your-name.workers.dev
  cooldownMs: 3600 * 1000,
};
