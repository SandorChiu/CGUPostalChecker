const msgEl = document.getElementById("message");

function showMessage(text) {
  msgEl.textContent = text;
}

function formatTime(iso) {
  if (!iso) return "尚未查詢";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

async function loadStatus() {
  const data = await chrome.storage.local.get([
    "enabled",
    "recipients",
    "lastCheckTime",
    "nextAllowedCheckAt",
    "lastResultText"
  ]);

  const enabledBadge = document.getElementById("enabledBadge");
  if (data.enabled) {
    enabledBadge.textContent = "監控中";
    enabledBadge.className = "badge on";
  } else {
    enabledBadge.textContent = "已停止";
    enabledBadge.className = "badge off";
  }

  const recipients = (data.recipients || []).filter(r => r.enabled && r.name);
  document.getElementById("recipientCount").textContent = `${recipients.length} 人`;
  document.getElementById("lastCheckTime").textContent = formatTime(data.lastCheckTime);
  document.getElementById("nextAllowedCheckAt").textContent = data.nextAllowedCheckAt ? new Date(Number(data.nextAllowedCheckAt)).toLocaleString() : "尚未排定";
  document.getElementById("lastResultText").textContent = data.lastResultText || "尚未查詢";
}

function send(type) {
  chrome.runtime.sendMessage({ type }, res => {
    showMessage(res?.message || "完成");
    loadStatus();
  });
}

document.getElementById("checkNow").addEventListener("click", () => send("CGU_CHECK_NOW"));
document.getElementById("start").addEventListener("click", () => send("CGU_START_MONITOR"));
document.getElementById("stop").addEventListener("click", () => send("CGU_STOP_MONITOR"));
document.getElementById("openPostal").addEventListener("click", () => send("CGU_OPEN_POSTAL"));
document.getElementById("options").addEventListener("click", () => send("CGU_OPEN_OPTIONS"));
document.getElementById("history").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("history.html") });
});

document.getElementById("tutorial").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("使用教學.html") });
});

loadStatus();
