const POSTAL_URL = "https://www4.is.cgu.edu.tw/postal/studentletter.aspx";
const ALARM_NAME = "cgu_postal_periodic_check";
const MAX_LOGS = 500;
const MAX_SEEN_KEYS = 3000;

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
  dateType: "0",
  dateInterval: "1",
  defaultStatus: "0",
  recipients: [],
  seenKeys: [],
  checkLogs: [],
  lastNotifyDateByRecipient: {},
  lastCountsByRecipient: {},
  lastRecipientDetails: {},
  lastCheckTime: "",
  lastResultText: "尚未查詢"
};

function nowIso() {
  return new Date().toISOString();
}

function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function localTimeHHMM(date = new Date()) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function recipientKey(recipient) {
  return recipient.receiverId || recipient.name || "未命名收件人";
}

function normalizeSettingValue(value, fallback = "") {
  if (value === undefined || value === null) return String(fallback ?? "");
  return String(value);
}

function recipientQueryKey(recipient, settings = {}) {
  const base = recipientKey(recipient);
  const status = normalizeSettingValue(recipient.status, settings.defaultStatus ?? "0");
  const dateType = normalizeSettingValue(recipient.dateType, settings.dateType ?? "0");
  const dateInterval = normalizeSettingValue(recipient.dateInterval, settings.dateInterval ?? "1");
  return `${base}::status=${status}::dateType=${dateType}::dateInterval=${dateInterval}`;
}

function statusLabel(status) {
  const normalized = status === undefined || status === null ? "" : String(status);
  return ({
    "": "全部",
    "0": "未領取",
    "1": "已領取",
    "2": "退件"
  })[normalized] || "全部";
}

function buildActionTitle(settings) {
  const baseTitle = "長庚大學自動查詢郵件";
  const recipients = (settings.recipients || []).filter(r => r && r.enabled && r.name);
  if (!recipients.length) return `${baseTitle}｜尚未設定啟用中的收件人`;

  const counts = settings.lastCountsByRecipient || {};
  const detail = settings.lastRecipientDetails || {};

  const lines = recipients.map(recipient => {
    const queryKey = recipientQueryKey(recipient, settings);
    const saved = detail[queryKey] || {};
    const count = Number(counts[queryKey] ?? saved.count ?? 0);
    const statusValue = normalizeSettingValue(recipient.status, saved.status ?? settings.defaultStatus ?? "0");
    const label = statusLabel(statusValue);
    return `${recipient.name} ${label} ${count}件`;
  });

  // Windows / Chrome 工具列 tooltip 常只顯示第一行，所以必須用單行呈現。
  return [baseTitle, ...lines].join("｜");
}

function signatureForRow(recipient, row) {
  const queryKey = recipientQueryKey(recipient);
  const raw = JSON.stringify({ recipient: queryKey, row });
  return `${queryKey}::${hashString(raw)}`;
}

async function getSettings() {
  const data = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...data };
}

async function setDefaultsIfNeeded() {
  const data = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const patch = {};
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (data[key] === undefined) patch[key] = value;
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

async function appendLog(entry) {
  const data = await chrome.storage.local.get(["checkLogs"]);
  const logs = data.checkLogs || [];
  logs.unshift({ time: nowIso(), ...entry });
  await chrome.storage.local.set({ checkLogs: logs.slice(0, MAX_LOGS) });
}

async function setBadgeFromCounts(settings) {
  const counts = settings.lastCountsByRecipient || {};
  const recipients = (settings.recipients || []).filter(r => r && r.enabled && r.name);

  let total = 0;
  if (recipients.length) {
    total = recipients.reduce((sum, recipient) => {
      const queryKey = recipientQueryKey(recipient, settings);
      return sum + Number(counts[queryKey] || 0);
    }, 0);
  }

  if (!settings.showBadge) {
    await chrome.action.setBadgeText({ text: "" });
  } else {
    await chrome.action.setBadgeText({ text: total > 0 ? String(total) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#0d6efd" });
  }

  await chrome.action.setTitle({ title: buildActionTitle(settings) });
}

function isWithinAllowedTime(settings) {
  const now = new Date();
  const day = now.getDay();
  if (settings.skipWeekends && (day === 0 || day === 6)) return false;
  if (!settings.onlyWithinHours) return true;

  const current = localTimeHHMM(now);
  const start = settings.activeStartTime || "00:00";
  const end = settings.activeEndTime || "23:59";

  if (start <= end) {
    return current >= start && current <= end;
  }

  // 支援跨午夜，例如 22:00 到 08:00
  return current >= start || current <= end;
}

async function createOrUpdateAlarm(settings) {
  await chrome.alarms.clear(ALARM_NAME);
  if (!settings.enabled || !settings.intervalEnabled) return;

  const minutes = Math.max(Number(settings.intervalMinutes || 30), 5);
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: minutes });
}

async function findOrOpenPostalTab(settings) {
  const tabs = await chrome.tabs.query({ url: `${POSTAL_URL}*` });
  if (tabs.length > 0) return tabs[0];

  if (!settings.openTabIfMissing) return null;

  return await chrome.tabs.create({ url: POSTAL_URL, active: false });
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && tab.status === "complete") return true;

  return await new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === "complete") {
        if (done) return;
        done = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  } catch (err) {
    // content script 可能已經由 manifest 載入；這裡失敗不一定代表不能送訊息。
    console.warn("executeScript warning", err);
  }
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    console.warn("sendToTab failed", err);
    return null;
  }
}

async function notify(title, message) {
  await chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message
  });
}

async function startRun(reason = "manual") {
  const settings = await getSettings();

  if (!isWithinAllowedTime(settings)) {
    await appendLog({ type: "skipped", reason, message: "目前不在允許查詢時段" });
    return { ok: false, message: "目前不在允許查詢時段" };
  }

  const recipients = (settings.recipients || []).filter(r => r && r.enabled && r.name);
  if (!recipients.length) {
    await appendLog({ type: "skipped", reason, message: "尚未設定啟用中的收件人" });
    return { ok: false, message: "尚未設定啟用中的收件人" };
  }

  const tab = await findOrOpenPostalTab(settings);
  if (!tab || !tab.id) {
    await appendLog({ type: "error", reason, message: "找不到郵件查詢頁面" });
    return { ok: false, message: "找不到郵件查詢頁面" };
  }

  await waitForTabComplete(tab.id);
  await ensureContentScript(tab.id);

  const runId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const activeRun = {
    runId,
    tabId: tab.id,
    recipients,
    index: 0,
    reason,
    startedAt: nowIso(),
    status: "running"
  };
  await chrome.storage.local.set({ activeRun });

  await appendLog({ type: "run_started", reason, message: `開始查詢 ${recipients.length} 位收件人` });
  await runRecipient(tab.id, activeRun, 0);
  return { ok: true, message: "已開始查詢" };
}

async function runRecipient(tabId, activeRun, index) {
  const recipient = activeRun.recipients[index];
  if (!recipient) {
    await finishRun(activeRun, "done");
    return;
  }

  activeRun.index = index;
  activeRun.status = "filling";
  activeRun.currentRecipient = recipient;
  await chrome.storage.local.set({ activeRun });

  const response = await sendToTab(tabId, {
    type: "CGU_RUN_RECIPIENT",
    runId: activeRun.runId,
    index,
    recipient,
    defaults: {
      dateType: activeRun.dateType,
      dateInterval: activeRun.dateInterval,
      defaultStatus: activeRun.defaultStatus
    }
  });

  if (!response || !response.ok) {
    await appendLog({
      type: "error",
      recipient: recipient.name,
      message: response?.message || "無法操作查詢頁面，可能尚未登入或分頁未準備好"
    });
    await handleLoginOrTabIssue(recipient, response?.message || "無法操作查詢頁面");
    await continueNext(activeRun.runId, index);
  }
}

async function handleLoginOrTabIssue(recipient, message) {
  const settings = await getSettings();
  if (settings.notifyLoginIssue) {
    const today = localDateKey();
    const key = `login_issue_${today}`;
    const data = await chrome.storage.local.get([key]);
    if (!data[key]) {
      await chrome.storage.local.set({ [key]: true });
      await notify("長庚大學自動查詢郵件", `需要重新登入或開啟查詢頁面：${message}`);
    }
  }
}

async function finishRun(activeRun, status = "done") {
  const settings = await getSettings();
  await chrome.storage.local.set({
    activeRun: null,
    lastCheckTime: nowIso(),
    lastResultText: status === "done" ? "查詢完成" : status
  });
  await setBadgeFromCounts(settings);
  await appendLog({ type: "run_finished", message: "本輪查詢完成" });
}

async function continueNext(runId, currentIndex) {
  const data = await chrome.storage.local.get(["activeRun"]);
  const activeRun = data.activeRun;
  if (!activeRun || activeRun.runId !== runId) return;

  const nextIndex = currentIndex + 1;
  if (nextIndex >= activeRun.recipients.length) {
    await finishRun(activeRun, "done");
    return;
  }

  // 給頁面一點時間穩定，再跑下一位。
  setTimeout(async () => {
    const fresh = (await chrome.storage.local.get(["activeRun"])).activeRun;
    if (!fresh || fresh.runId !== runId) return;
    await runRecipient(fresh.tabId, fresh, nextIndex);
  }, 1000);
}

async function processResult(message) {
  const { runId, index, recipient, rows, pageMessage } = message;
  const data = await chrome.storage.local.get(["activeRun"]);
  const activeRun = data.activeRun;
  if (!activeRun || activeRun.runId !== runId) return;

  const settings = await getSettings();
  const seen = new Set(settings.seenKeys || []);
  const allKeys = (rows || []).map(row => signatureForRow(recipient, row));
  const newRows = (rows || []).filter((row, i) => !seen.has(allKeys[i]));

  for (const key of allKeys) seen.add(key);
  const seenKeys = Array.from(seen).slice(-MAX_SEEN_KEYS);

  const queryKey = recipientQueryKey(recipient, settings);
  const statusValue = normalizeSettingValue(recipient.status, settings.defaultStatus ?? "0");
  const lastCountsByRecipient = settings.lastCountsByRecipient || {};
  lastCountsByRecipient[queryKey] = rows.length;

  const lastRecipientDetails = settings.lastRecipientDetails || {};
  lastRecipientDetails[queryKey] = {
    name: recipient.name,
    receiverId: recipient.receiverId || "",
    status: statusValue,
    statusLabel: statusLabel(statusValue),
    dateType: normalizeSettingValue(recipient.dateType, settings.dateType ?? "0"),
    dateInterval: normalizeSettingValue(recipient.dateInterval, settings.dateInterval ?? "1"),
    count: rows.length,
    checkedAt: nowIso()
  };

  await chrome.storage.local.set({
    seenKeys,
    lastCountsByRecipient,
    lastRecipientDetails,
    lastCheckTime: nowIso(),
    lastResultText: `${recipient.name}：${rows.length} 筆，新增 ${newRows.length} 筆`
  });

  await appendLog({
    type: rows.length ? "mail_found" : "no_mail",
    recipient: recipient.name,
    status: statusLabel(statusValue),
    count: rows.length,
    newCount: newRows.length,
    pageMessage: pageMessage || "",
    rows: rows.slice(0, 20),
    message: rows.length ? `查到 ${rows.length} 筆，新增 ${newRows.length} 筆` : "沒有查到郵件"
  });

  await maybeNotify(settings, recipient, rows, newRows);

  const updatedSettings = await getSettings();
  await setBadgeFromCounts(updatedSettings);
  await continueNext(runId, index);
}

async function maybeNotify(settings, recipient, rows, newRows) {
  if (!rows || rows.length === 0) return;
  if (!settings.notifyOnlyWhenMailExists) return;

  const today = localDateKey();
  const key = recipientQueryKey(recipient, settings);
  const lastNotifyDateByRecipient = settings.lastNotifyDateByRecipient || {};

  if (settings.notifyOncePerDay && lastNotifyDateByRecipient[key] === today) {
    await appendLog({
      type: "silent_due_to_daily_limit",
      recipient: recipient.name,
      count: rows.length,
      newCount: newRows.length,
      message: "今天已提醒過，因此本次不再跳通知"
    });
    return;
  }

  if (!settings.notifyOncePerDay && newRows.length === 0) {
    return;
  }

  lastNotifyDateByRecipient[key] = today;
  await chrome.storage.local.set({ lastNotifyDateByRecipient });

  const title = "長庚大學自動查詢郵件";
  const previewRows = (newRows.length ? newRows : rows).slice(0, 3);
  const preview = previewRows.map(row => Object.values(row).join(" / ")).join("\n");
  const newPart = newRows.length ? `，其中新增 ${newRows.length} 筆` : "";
  const message = `${recipient.name} 目前有 ${rows.length} 筆郵件${newPart}\n${preview}`.slice(0, 900);
  await notify(title, message);
}

chrome.runtime.onInstalled.addListener(async () => {
  await setDefaultsIfNeeded();
  const settings = await getSettings();
  await createOrUpdateAlarm(settings);
  await setBadgeFromCounts(settings);
});

chrome.runtime.onStartup.addListener(async () => {
  await setDefaultsIfNeeded();
  const settings = await getSettings();
  await createOrUpdateAlarm(settings);
  await setBadgeFromCounts(settings);
  if (settings.enabled && settings.checkOnStartup) {
    await startRun("startup");
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  await startRun("interval");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === "CGU_START_MONITOR") {
      const settings = await getSettings();
      settings.enabled = true;
      await chrome.storage.local.set({ enabled: true });
      await createOrUpdateAlarm(settings);
      sendResponse(await startRun("start_button"));
      return;
    }

    if (message.type === "CGU_STOP_MONITOR") {
      await chrome.storage.local.set({ enabled: false, activeRun: null });
      await chrome.alarms.clear(ALARM_NAME);
      await chrome.action.setBadgeText({ text: "" });
      const stoppedSettings = await getSettings();
      await chrome.action.setTitle({ title: buildActionTitle(stoppedSettings) });
      await appendLog({ type: "monitor_stopped", message: "已停止監控" });
      sendResponse({ ok: true, message: "已停止監控" });
      return;
    }

    if (message.type === "CGU_CHECK_NOW") {
      sendResponse(await startRun("manual"));
      return;
    }

    if (message.type === "CGU_OPEN_OPTIONS") {
      await chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "CGU_OPEN_POSTAL") {
      await chrome.tabs.create({ url: POSTAL_URL, active: true });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "CGU_OPEN_TUTORIAL") {
      await chrome.tabs.create({ url: chrome.runtime.getURL("使用教學.html"), active: true });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "CGU_SETTINGS_UPDATED") {
      const settings = await getSettings();
      await createOrUpdateAlarm(settings);
      await setBadgeFromCounts(settings);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "CGU_QUERY_RESULT") {
      await processResult(message);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "CGU_LOGIN_REQUIRED") {
      await handleLoginOrTabIssue(message.recipient || {}, message.message || "尚未登入");
      await continueNext(message.runId, message.index || 0);
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, message: "Unknown message" });
  })().catch(async (err) => {
    console.error(err);
    await appendLog({ type: "error", message: String(err && err.message ? err.message : err) });
    sendResponse({ ok: false, message: String(err && err.message ? err.message : err) });
  });

  return true;
});
