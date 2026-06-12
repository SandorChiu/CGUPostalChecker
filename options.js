const DEFAULT_SETTINGS = {
  enabled: false,
  checkOnStartup: true,
  intervalEnabled: true,
  intervalMinutes: 30,
  onlyWithinHours: false,
  activeStartTime: "08:00",
  activeEndTime: "18:00",
  skipWeekends: false,
  notifyOnlyWhenMailExists: true,
  notifyOncePerDay: true,
  notifyLoginIssue: true,
  showBadge: true,
  openTabIfMissing: true,
  recipients: []
};

const recipientsEl = document.getElementById("recipients");
const template = document.getElementById("recipientTemplate");
const msgEl = document.getElementById("message");

function showMessage(text) {
  msgEl.textContent = text;
  setTimeout(() => {
    if (msgEl.textContent === text) msgEl.textContent = "";
  }, 4000);
}

function addRecipientCard(recipient = {}) {
  const node = template.content.firstElementChild.cloneNode(true);
  node.querySelector(".r-enabled").checked = recipient.enabled ?? true;
  node.querySelector(".r-name").value = recipient.name || "";
  node.querySelector(".r-id").value = recipient.receiverId || "";
  node.querySelector(".r-status").value = recipient.status ?? "0";
  node.querySelector(".r-dateType").value = recipient.dateType ?? "0";
  node.querySelector(".r-dateInterval").value = recipient.dateInterval ?? "1";
  node.querySelector(".remove").addEventListener("click", () => node.remove());
  recipientsEl.appendChild(node);
}

function collectRecipients() {
  return Array.from(recipientsEl.querySelectorAll(".recipient-card")).map(card => ({
    enabled: card.querySelector(".r-enabled").checked,
    name: card.querySelector(".r-name").value.trim(),
    receiverId: card.querySelector(".r-id").value.trim(),
    status: card.querySelector(".r-status").value,
    dateType: card.querySelector(".r-dateType").value,
    dateInterval: card.querySelector(".r-dateInterval").value
  })).filter(r => r.name);
}

async function loadSettings() {
  const data = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const settings = { ...DEFAULT_SETTINGS, ...data };

  for (const key of [
    "enabled",
    "checkOnStartup",
    "intervalEnabled",
    "onlyWithinHours",
    "skipWeekends",
    "notifyOnlyWhenMailExists",
    "notifyOncePerDay",
    "notifyLoginIssue",
    "showBadge",
    "openTabIfMissing"
  ]) {
    document.getElementById(key).checked = Boolean(settings[key]);
  }

  document.getElementById("intervalMinutes").value = settings.intervalMinutes || 30;
  document.getElementById("activeStartTime").value = settings.activeStartTime || "08:00";
  document.getElementById("activeEndTime").value = settings.activeEndTime || "18:00";

  recipientsEl.innerHTML = "";
  if (settings.recipients && settings.recipients.length) {
    settings.recipients.forEach(addRecipientCard);
  } else {
    addRecipientCard({ enabled: true, name: "", status: "0", dateType: "0", dateInterval: "1" });
  }
}

async function saveSettings() {
  const interval = Math.max(Number(document.getElementById("intervalMinutes").value || 30), 5);
  const settings = {
    enabled: document.getElementById("enabled").checked,
    checkOnStartup: document.getElementById("checkOnStartup").checked,
    intervalEnabled: document.getElementById("intervalEnabled").checked,
    intervalMinutes: interval,
    onlyWithinHours: document.getElementById("onlyWithinHours").checked,
    activeStartTime: document.getElementById("activeStartTime").value || "08:00",
    activeEndTime: document.getElementById("activeEndTime").value || "18:00",
    skipWeekends: document.getElementById("skipWeekends").checked,
    notifyOnlyWhenMailExists: document.getElementById("notifyOnlyWhenMailExists").checked,
    notifyOncePerDay: document.getElementById("notifyOncePerDay").checked,
    notifyLoginIssue: document.getElementById("notifyLoginIssue").checked,
    showBadge: document.getElementById("showBadge").checked,
    openTabIfMissing: document.getElementById("openTabIfMissing").checked,
    recipients: collectRecipients()
  };

  await chrome.storage.local.set(settings);
  chrome.runtime.sendMessage({ type: "CGU_SETTINGS_UPDATED" });
  showMessage("設定已儲存");
}

document.getElementById("addRecipient").addEventListener("click", () => addRecipientCard());
document.getElementById("save").addEventListener("click", saveSettings);

document.getElementById("checkNow").addEventListener("click", async () => {
  await saveSettings();
  chrome.runtime.sendMessage({ type: "CGU_CHECK_NOW" }, res => showMessage(res?.message || "已送出查詢"));
});

document.getElementById("openPostal").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CGU_OPEN_POSTAL" });
});

document.getElementById("openHistory").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("history.html") });
});

document.getElementById("openTutorial").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("使用教學.html") });
});

document.getElementById("clearSeen").addEventListener("click", async () => {
  if (!confirm("確定清除已看過郵件紀錄？清除後，既有郵件可能會再次被視為新資料。")) return;
  await chrome.storage.local.set({ seenKeys: [], lastCountsByRecipient: {}, lastRecipientDetails: {}, lastNotifyDateByRecipient: {} });
  chrome.runtime.sendMessage({ type: "CGU_SETTINGS_UPDATED" });
  showMessage("已清除已看過郵件紀錄");
});

document.getElementById("clearLogs").addEventListener("click", async () => {
  if (!confirm("確定清除查詢紀錄？")) return;
  await chrome.storage.local.set({ checkLogs: [] });
  showMessage("已清除查詢紀錄");
});

document.getElementById("resetDailyNotify").addEventListener("click", async () => {
  await chrome.storage.local.set({ lastNotifyDateByRecipient: {} });
  showMessage("已重置今日提醒紀錄");
});

document.getElementById("testNotification").addEventListener("click", async () => {
  await chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "長庚大學自動查詢郵件",
    message: "這是一則測試通知。"
  });
});

loadSettings();
