const msgEl = document.getElementById("message");

const POPUP_STORAGE_KEYS = [
  "enabled",
  "recipients",
  "defaultStatus",
  "dateType",
  "dateInterval",
  "lastCountsByRecipient",
  "lastRecipientDetails",
  "lastCheckTime",
  "nextAllowedCheckAt",
  "lastResultText",
  "activeRun"
];

function showMessage(text) {
  msgEl.textContent = text;
}

function formatTime(value, fallback = "尚未查詢") {
  if (!value) return fallback;
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) return String(value);
  try {
    return new Date(timestamp).toLocaleString("zh-TW");
  } catch {
    return String(value);
  }
}

function normalizeSettingValue(value, fallback = "") {
  if (value === undefined || value === null) return String(fallback ?? "");
  return String(value);
}

function recipientBaseKey(recipient) {
  return recipient?.receiverId || recipient?.name || "未命名收件人";
}

function recipientQueryKey(recipient, settings = {}) {
  const base = recipientBaseKey(recipient);
  const status = normalizeSettingValue(recipient?.status, settings.defaultStatus ?? "0");
  const dateType = normalizeSettingValue(recipient?.dateType, settings.dateType ?? "0");
  const dateInterval = normalizeSettingValue(recipient?.dateInterval, settings.dateInterval ?? "1");
  return `${base}::status=${status}::dateType=${dateType}::dateInterval=${dateInterval}`;
}

function statusLabel(status) {
  const normalized = normalizeSettingValue(status, "");
  return ({
    "": "全部",
    "0": "未領取",
    "1": "已領取",
    "2": "退件"
  })[normalized] || "全部";
}

function dateTypeLabel(value) {
  return normalizeSettingValue(value, "0") === "1" ? "退件日期" : "收件日期";
}

function dateIntervalLabel(value) {
  const normalized = normalizeSettingValue(value, "1");
  return ({ "1": "1 個月", "3": "3 個月", "6": "6 個月" })[normalized] || `${normalized} 個月`;
}

function isSameRecipientQuery(a, b, settings) {
  if (!a || !b) return false;
  return recipientQueryKey(a, settings) === recipientQueryKey(b, settings);
}

function createTextElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function renderRecipientResults(data, recipients) {
  const container = document.getElementById("recipientResults");
  const totalEl = document.getElementById("resultTotal");
  container.replaceChildren();

  if (!recipients.length) {
    container.appendChild(createTextElement("div", "recipient-result-empty", "尚未設定啟用中的收件人"));
    totalEl.textContent = "合計 0 件";
    return;
  }

  const counts = data.lastCountsByRecipient || {};
  const details = data.lastRecipientDetails || {};
  const activeRecipient = data.activeRun?.currentRecipient || null;
  let total = 0;

  for (const recipient of recipients) {
    const queryKey = recipientQueryKey(recipient, data);
    const detail = details[queryKey] || {};
    const hasStoredCount = Object.prototype.hasOwnProperty.call(counts, queryKey)
      || Object.prototype.hasOwnProperty.call(detail, "count");
    const count = hasStoredCount ? Number(counts[queryKey] ?? detail.count ?? 0) : null;
    if (Number.isFinite(count)) total += count;

    const statusValue = normalizeSettingValue(recipient.status, detail.status ?? data.defaultStatus ?? "0");
    const dateTypeValue = normalizeSettingValue(recipient.dateType, detail.dateType ?? data.dateType ?? "0");
    const dateIntervalValue = normalizeSettingValue(recipient.dateInterval, detail.dateInterval ?? data.dateInterval ?? "1");
    const checking = isSameRecipientQuery(activeRecipient, recipient, data);

    const card = document.createElement("article");
    card.className = `popup-recipient-result${checking ? " checking" : ""}${Number(count) > 0 ? " has-mail" : ""}`;

    const main = document.createElement("div");
    main.className = "popup-recipient-main";

    const identity = document.createElement("div");
    identity.className = "popup-recipient-identity";
    identity.appendChild(createTextElement("div", "popup-recipient-name", recipient.name));
    identity.appendChild(createTextElement(
      "div",
      "popup-recipient-condition",
      `${statusLabel(statusValue)}｜${dateTypeLabel(dateTypeValue)}｜${dateIntervalLabel(dateIntervalValue)}`
    ));

    const countBox = document.createElement("div");
    countBox.className = "popup-recipient-count";
    countBox.appendChild(createTextElement("strong", "", count === null ? "—" : String(count)));
    countBox.appendChild(createTextElement("span", "", "件"));

    main.append(identity, countBox);
    card.appendChild(main);

    const meta = document.createElement("div");
    meta.className = "popup-recipient-meta";
    if (checking) {
      meta.appendChild(createTextElement("span", "popup-querying-label", "查詢中"));
    } else if (detail.checkedAt) {
      meta.textContent = `最後查詢：${formatTime(detail.checkedAt)}`;
    } else {
      meta.textContent = "尚未依此條件完成查詢";
    }
    card.appendChild(meta);

    container.appendChild(card);
  }

  totalEl.textContent = `合計 ${total} 件`;
}

async function loadStatus() {
  const data = await chrome.storage.local.get(POPUP_STORAGE_KEYS);

  const enabledBadge = document.getElementById("enabledBadge");
  if (data.enabled) {
    enabledBadge.textContent = data.activeRun ? "查詢中" : "監控中";
    enabledBadge.className = "badge on";
  } else {
    enabledBadge.textContent = data.activeRun ? "查詢中" : "已停止";
    enabledBadge.className = data.activeRun ? "badge on" : "badge off";
  }

  const recipients = (data.recipients || []).filter(r => r && r.enabled && r.name);
  document.getElementById("recipientCount").textContent = `${recipients.length} 人`;
  document.getElementById("lastCheckTime").textContent = formatTime(data.lastCheckTime);
  document.getElementById("nextAllowedCheckAt").textContent = data.nextAllowedCheckAt
    ? formatTime(Number(data.nextAllowedCheckAt), "尚未排定")
    : "尚未排定";
  document.getElementById("lastResultText").textContent = data.lastResultText || "尚未查詢";

  renderRecipientResults(data, recipients);
}

function send(type) {
  showMessage("處理中…");
  chrome.runtime.sendMessage({ type }, res => {
    if (chrome.runtime.lastError) {
      showMessage(`操作失敗：${chrome.runtime.lastError.message}`);
      return;
    }
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

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (POPUP_STORAGE_KEYS.some(key => Object.prototype.hasOwnProperty.call(changes, key))) {
    loadStatus();
  }
});

loadStatus().catch(err => showMessage(`讀取失敗：${err.message || err}`));
