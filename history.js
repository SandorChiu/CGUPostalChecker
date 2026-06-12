const body = document.getElementById("logBody");

function formatTime(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso || ""; }
}

function typeLabel(type) {
  const map = {
    run_started: "開始查詢",
    run_finished: "查詢完成",
    mail_found: "查到郵件",
    no_mail: "無郵件",
    silent_due_to_daily_limit: "今日已提醒",
    skipped: "略過",
    error: "錯誤",
    monitor_stopped: "停止監控"
  };
  return map[type] || type || "";
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadLogs() {
  const data = await chrome.storage.local.get(["checkLogs"]);
  const logs = data.checkLogs || [];
  body.innerHTML = logs.map(log => `
    <tr>
      <td>${escapeHtml(formatTime(log.time))}</td>
      <td>${escapeHtml(typeLabel(log.type))}</td>
      <td>${escapeHtml(log.recipient || "")}</td>
      <td>${escapeHtml(log.count ?? "")}${log.newCount !== undefined ? ` / 新增 ${escapeHtml(log.newCount)}` : ""}</td>
      <td>${escapeHtml(log.message || log.pageMessage || "")}</td>
    </tr>
  `).join("") || `<tr><td colspan="5">尚無紀錄</td></tr>`;
}

document.getElementById("refresh").addEventListener("click", loadLogs);

document.getElementById("clearLogs").addEventListener("click", async () => {
  if (!confirm("確定清除查詢紀錄？")) return;
  await chrome.storage.local.set({ checkLogs: [] });
  loadLogs();
});

document.getElementById("exportJson").addEventListener("click", async () => {
  const data = await chrome.storage.local.get(["checkLogs"]);
  const blob = new Blob([JSON.stringify(data.checkLogs || [], null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cgu-postal-logs-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

loadLogs();
