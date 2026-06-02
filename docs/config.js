// ⚠️ 這個檔會被公開。請確認 PAT 只有此 repo 的 Actions: read+write 權限。
// 步驟見 README.md「設定手動更新按鈕」一節。
window.CONFIG = {
  owner: "YOUR_GITHUB_USERNAME",
  repo:  "vote-tracker",
  workflow: "scrape.yml",
  // 把 PAT 經 base64 編碼後貼這（防爬蟲掃，非加密）：
  //   PowerShell: [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("github_pat_XXX"))
  pat_b64: "PASTE_YOUR_BASE64_PAT_HERE",
  cooldownMs: 3600 * 1000,
};
