const POSTAL_URL = "https://www4.is.cgu.edu.tw/postal/studentletter.aspx";
const POSTAL_URL_PATTERN = "https://www4.is.cgu.edu.tw/postal/*";
const AUTO_CHECK_ALARM = "cgu_postal_auto_check";
const STARTUP_DELAY_ALARM = "cgu_postal_startup_delayed_check";
const MAX_LOGS = 500;
const MAX_SEEN_KEYS = 3000;
const RUN_TIMEOUT_MS = 3 * 60 * 1000;

const DEFAULT_SETTINGS = {
  enabled: false,
  checkOnStartup: true,
  intervalEnabled: true,
  intervalMinutes: 360,
  minAutoIntervalMinutes: 120,
  startupDelayMinMinutes: 5,
  startupDelayMaxMinutes: 30,
  scheduleJitterMaxMinutes: 30,
  manualCooldownMinutes: 5,
  recipientDelayMinSeconds: 5,
  recipientDelayMaxSeconds: 15,
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
  lastResultText: "尚未查詢",
  lastManualCheckAt: 0,
  lastAutoCheckAt: 0,
  nextAllowedCheckAt: 0,
  activeRun: null
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  const a = Math.ceil(Number(min));
  const b = Math.floor(Number(max));
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return Math.max(0, a || 0);
  return Math.floor(Math.random() * (b - a + 1)) + a;
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

function formatDateTimeForUi(timestamp) {
  const ts = Number(timestamp || 0);
  if (!ts) return "尚未排定";
  try {
    return new Date(ts).toLocaleString("zh-TW");
  } catch {
    return String(timestamp);
  }
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

  // 1.0.6 之後為避免伺服器負擔，自動查詢最低間隔強制為 120 分鐘。
  // 若舊版曾儲存 30 分鐘等較短間隔，升級後自動改成建議值 360 分鐘。
  if (data.intervalMinutes !== undefined && Number(data.intervalMinutes) < 120) {
    patch.intervalMinutes = 360;
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

  if (start <= end) return current >= start && current <= end;
  return current >= start || current <= end;
}

function effectiveAutoIntervalMinutes(settings) {
  const configured = Number(settings.intervalMinutes || DEFAULT_SETTINGS.intervalMinutes);
  const minimum = Number(settings.minAutoIntervalMinutes || DEFAULT_SETTINGS.minAutoIntervalMinutes);
  return Math.max(configured, minimum, 120);
}

function calculateNextAllowedCheckAt(settings, from = Date.now()) {
  const intervalMin = effectiveAutoIntervalMinutes(settings);
  const jitterMax = Math.max(0, Number(settings.scheduleJitterMaxMinutes ?? DEFAULT_SETTINGS.scheduleJitterMaxMinutes));
  const jitterMin = jitterMax > 0 ? randomInt(0, jitterMax) : 0;
  return from + (intervalMin + jitterMin) * 60 * 1000;
}

async function scheduleAutoAlarm(settings = null, options = {}) {
  const cfg = settings || await getSettings();
  await chrome.alarms.clear(AUTO_CHECK_ALARM);

  if (!cfg.enabled || !cfg.intervalEnabled) return;

  const now = Date.now();
  let nextAllowed = Number(cfg.nextAllowedCheckAt || 0);

  if (options.forceNew || !nextAllowed) {
    nextAllowed = calculateNextAllowedCheckAt(cfg, now);
    await chrome.storage.local.set({ nextAllowedCheckAt: nextAllowed });
  }

  const when = Math.max(nextAllowed, now + 60 * 1000);
  await chrome.alarms.create(AUTO_CHECK_ALARM, { when });
}

async function scheduleRetryAutoAlarm(minutes = 60) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.intervalEnabled) return;
  const when = Date.now() + Math.max(10, Number(minutes || 60)) * 60 * 1000;
  await chrome.alarms.clear(AUTO_CHECK_ALARM);
  await chrome.alarms.create(AUTO_CHECK_ALARM, { when });
  await appendLog({ type: "auto_retry_scheduled", message: `自動查詢暫緩，約 ${minutes} 分鐘後再檢查` });
}

async function clearRunIfStale() {
  const data = await chrome.storage.local.get(["activeRun"]);
  const activeRun = data.activeRun;
  if (!activeRun || !activeRun.startedAtMs) return false;
  const age = Date.now() - Number(activeRun.startedAtMs || 0);
  if (age <= RUN_TIMEOUT_MS) return false;

  await chrome.storage.local.set({ activeRun: null, pendingParse: null });
  await appendLog({ type: "stale_run_cleared", message: "前一次查詢超過 3 分鐘未完成，已自動解除查詢鎖" });
  return true;
}

async function hasActiveRun() {
  await clearRunIfStale();
  const data = await chrome.storage.local.get(["activeRun"]);
  return Boolean(data.activeRun && data.activeRun.status && data.activeRun.status !== "done");
}

async function canRunManual(settings) {
  const now = Date.now();
  const cooldownMs = Math.max(1, Number(settings.manualCooldownMinutes || DEFAULT_SETTINGS.manualCooldownMinutes)) * 60 * 1000;
  const last = Number(settings.lastManualCheckAt || 0);
  if (last && now - last < cooldownMs) {
    const remainSec = Math.ceil((cooldownMs - (now - last)) / 1000);
    const remainMin = Math.ceil(remainSec / 60);
    return { ok: false, message: `剛剛已手動查詢過，請約 ${remainMin} 分鐘後再試。` };
  }
  return { ok: true };
}

async function canRunAuto(settings, reason) {
  if (!settings.enabled) return { ok: false, message: "自動監控尚未啟用" };
  if (!isWithinAllowedTime(settings)) return { ok: false, message: "目前不在允許查詢時段" };

  const now = Date.now();
  const nextAllowed = Number(settings.nextAllowedCheckAt || 0);
  if (nextAllowed && now < nextAllowed) {
    return { ok: false, message: `尚未到下次允許查詢時間：${formatDateTimeForUi(nextAllowed)}` };
  }
  return { ok: true };
}

async function scheduleStartupDelayedCheck(settings) {
  await chrome.alarms.clear(STARTUP_DELAY_ALARM);
  if (!settings.enabled || !settings.checkOnStartup) return;

  const canAuto = await canRunAuto(settings, "startup");
  if (!canAuto.ok) {
    await appendLog({ type: "startup_skipped", message: canAuto.message });
    await scheduleAutoAlarm(settings);
    return;
  }

  const minDelay = Math.max(1, Number(settings.startupDelayMinMinutes || DEFAULT_SETTINGS.startupDelayMinMinutes));
  const maxDelay = Math.max(minDelay, Number(settings.startupDelayMaxMinutes || DEFAULT_SETTINGS.startupDelayMaxMinutes));
  const delayMin = randomInt(minDelay, maxDelay);
  await chrome.alarms.create(STARTUP_DELAY_ALARM, { when: Date.now() + delayMin * 60 * 1000 });
  await appendLog({ type: "startup_delayed", message: `Chrome 啟動後不立即查詢，已隨機延遲約 ${delayMin} 分鐘` });
}

async function markRunStartedByReason(reason, settings) {
  const now = Date.now();
  const patch = {};
  if (["manual", "start_button"].includes(reason)) {
    patch.lastManualCheckAt = now;
  }
  if (["interval", "startup", "startup_delayed"].includes(reason)) {
    patch.lastAutoCheckAt = now;
  }

  // 不論自動或手動，只要真的開始查詢，都重新排定下一次自動允許時間，避免手動剛查完又立刻自動查。
  const nextAllowed = calculateNextAllowedCheckAt(settings, now);
  patch.nextAllowedCheckAt = nextAllowed;
  await chrome.storage.local.set(patch);
  const updated = { ...settings, ...patch };
  await scheduleAutoAlarm(updated);
}

async function findOrOpenPostalTab(settings) {
  const tabs = await chrome.tabs.query({ url: POSTAL_URL_PATTERN });
  const preferred = tabs.find(t => t.url && t.url.startsWith(POSTAL_URL)) || tabs[0];
  if (preferred) return preferred;

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
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (err) {
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

  if (await hasActiveRun()) {
    await appendLog({ type: "skipped", reason, message: "已有查詢流程進行中，略過本次查詢" });
    return { ok: false, message: "已有查詢流程進行中，請稍後再試" };
  }

  const isManualReason = ["manual", "start_button"].includes(reason);
  const isAutoReason = ["interval", "startup", "startup_delayed"].includes(reason);

  if (isManualReason) {
    const manualAllowed = await canRunManual(settings);
    if (!manualAllowed.ok) {
      await appendLog({ type: "skipped", reason, message: manualAllowed.message });
      return manualAllowed;
    }
  }

  if (isAutoReason) {
    const autoAllowed = await canRunAuto(settings, reason);
    if (!autoAllowed.ok) {
      await appendLog({ type: "skipped", reason, message: autoAllowed.message });
      await scheduleAutoAlarm(settings);
      return autoAllowed;
    }
  } else if (!isWithinAllowedTime(settings)) {
    await appendLog({ type: "skipped", reason, message: "目前不在允許查詢時段" });
    return { ok: false, message: "目前不在允許查詢時段" };
  }

  const recipients = (settings.recipients || []).filter(r => r && r.enabled && r.name);
  if (!recipients.length) {
    await appendLog({ type: "skipped", reason, message: "尚未設定啟用中的收件人" });
    return { ok: false, message: "尚未設定啟用中的收件人" };
  }

  const runId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const activeRun = {
    runId,
    tabId: null,
    recipients,
    index: 0,
    reason,
    startedAt: nowIso(),
    startedAtMs: Date.now(),
    status: "preparing"
  };
  await chrome.storage.local.set({ activeRun });

  try {
    await markRunStartedByReason(reason, settings);

    const tab = await findOrOpenPostalTab(settings);
    if (!tab || !tab.id) {
      await chrome.storage.local.set({ activeRun: null });
      await appendLog({ type: "error", reason, message: "找不到郵件查詢頁面" });
      return { ok: false, message: "找不到郵件查詢頁面" };
    }

    activeRun.tabId = tab.id;
    activeRun.status = "running";
    await chrome.storage.local.set({ activeRun });

    await waitForTabComplete(tab.id);
    await ensureContentScript(tab.id);

    await appendLog({ type: "run_started", reason, message: `開始查詢 ${recipients.length} 位收件人` });
    await runRecipient(tab.id, activeRun, 0);
    return { ok: true, message: "已開始查詢" };
  } catch (err) {
    await chrome.storage.local.set({ activeRun: null, pendingParse: null });
    await appendLog({ type: "error", reason, message: String(err && err.message ? err.message : err) });
    return { ok: false, message: String(err && err.message ? err.message : err) };
  }
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
  activeRun.startedAtMs = Number(activeRun.startedAtMs || Date.now());
  activeRun.currentRecipientStartedAtMs = Date.now();
  await chrome.storage.local.set({ activeRun });

  const response = await sendToTab(tabId, {
    type: "CGU_RUN_RECIPIENT",
    runId: activeRun.runId,
    tabId,
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
    pendingParse: null,
    lastCheckTime: nowIso(),
    lastResultText: status === "done" ? "查詢完成" : status
  });
  const updated = await getSettings();
  await setBadgeFromCounts(updated);
  await scheduleAutoAlarm(updated);
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

  const settings = await getSettings();
  const minSec = Math.max(1, Number(settings.recipientDelayMinSeconds || DEFAULT_SETTINGS.recipientDelayMinSeconds));
  const maxSec = Math.max(minSec, Number(settings.recipientDelayMaxSeconds || DEFAULT_SETTINGS.recipientDelayMaxSeconds));
  const delaySec = randomInt(minSec, maxSec);
  await appendLog({ type: "recipient_delay", message: `下一位收件人查詢將延遲約 ${delaySec} 秒` });
  await sleep(delaySec * 1000);

  const fresh = (await chrome.storage.local.get(["activeRun"])).activeRun;
  if (!fresh || fresh.runId !== runId) return;
  await runRecipient(fresh.tabId, fresh, nextIndex);
}

async function processResult(message) {
  const { runId, tabId, index, recipient, rows, pageMessage } = message;
  const data = await chrome.storage.local.get(["activeRun"]);
  const activeRun = data.activeRun;
  if (!activeRun || activeRun.runId !== runId) return;
  if (activeRun.tabId && tabId && activeRun.tabId !== tabId) {
    await appendLog({ type: "ignored_result", message: "收到非本次查詢分頁的結果，已忽略" });
    return;
  }
  if (Number(activeRun.index) !== Number(index)) {
    await appendLog({ type: "ignored_result", message: "收到非目前收件人的結果，已忽略" });
    return;
  }

  const settings = await getSettings();
  const rowList = Array.isArray(rows) ? rows : [];
  const seen = new Set(settings.seenKeys || []);
  const allKeys = rowList.map(row => signatureForRow(recipient, row));
  const newRows = rowList.filter((row, i) => !seen.has(allKeys[i]));

  for (const key of allKeys) seen.add(key);
  const seenKeys = Array.from(seen).slice(-MAX_SEEN_KEYS);

  const queryKey = recipientQueryKey(recipient, settings);
  const statusValue = normalizeSettingValue(recipient.status, settings.defaultStatus ?? "0");
  const lastCountsByRecipient = settings.lastCountsByRecipient || {};
  lastCountsByRecipient[queryKey] = rowList.length;

  const lastRecipientDetails = settings.lastRecipientDetails || {};
  lastRecipientDetails[queryKey] = {
    name: recipient.name,
    receiverId: recipient.receiverId || "",
    status: statusValue,
    statusLabel: statusLabel(statusValue),
    dateType: normalizeSettingValue(recipient.dateType, settings.dateType ?? "0"),
    dateInterval: normalizeSettingValue(recipient.dateInterval, settings.dateInterval ?? "1"),
    count: rowList.length,
    checkedAt: nowIso()
  };

  await chrome.storage.local.set({
    seenKeys,
    lastCountsByRecipient,
    lastRecipientDetails,
    lastCheckTime: nowIso(),
    lastResultText: `${recipient.name}：${rowList.length} 筆，新增 ${newRows.length} 筆`
  });

  await appendLog({
    type: rowList.length ? "mail_found" : "no_mail",
    recipient: recipient.name,
    status: statusLabel(statusValue),
    count: rowList.length,
    newCount: newRows.length,
    pageMessage: pageMessage || "",
    rows: rowList.slice(0, 20),
    message: rowList.length ? `查到 ${rowList.length} 筆，新增 ${newRows.length} 筆` : "沒有查到郵件"
  });

  await maybeNotify(settings, recipient, rowList, newRows);

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

  if (!settings.notifyOncePerDay && newRows.length === 0) return;

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
  await scheduleAutoAlarm(settings);
  await setBadgeFromCounts(settings);
});

chrome.runtime.onStartup.addListener(async () => {
  await setDefaultsIfNeeded();
  const settings = await getSettings();
  await setBadgeFromCounts(settings);
  await scheduleAutoAlarm(settings);
  await scheduleStartupDelayedCheck(settings);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === AUTO_CHECK_ALARM) {
    await startRun("interval");
    return;
  }
  if (alarm.name === STARTUP_DELAY_ALARM) {
    await startRun("startup_delayed");
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === "CGU_START_MONITOR") {
      await chrome.storage.local.set({ enabled: true });
      const settings = await getSettings();
      await scheduleAutoAlarm(settings);
      sendResponse(await startRun("start_button"));
      return;
    }

    if (message.type === "CGU_STOP_MONITOR") {
      await chrome.storage.local.set({ enabled: false, activeRun: null, pendingParse: null });
      await chrome.alarms.clear(AUTO_CHECK_ALARM);
      await chrome.alarms.clear(STARTUP_DELAY_ALARM);
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
      const interval = effectiveAutoIntervalMinutes(settings);
      const patch = { intervalMinutes: interval };
      if (settings.enabled && settings.intervalEnabled && !settings.nextAllowedCheckAt) {
        patch.nextAllowedCheckAt = calculateNextAllowedCheckAt({ ...settings, intervalMinutes: interval });
      }
      if (Object.keys(patch).length) await chrome.storage.local.set(patch);
      const updated = await getSettings();
      await scheduleAutoAlarm(updated);
      await setBadgeFromCounts(updated);
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
