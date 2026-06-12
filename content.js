(() => {
  if (window.__CGU_POSTAL_CHECKER_LOADED__) return;
  window.__CGU_POSTAL_CHECKER_LOADED__ = true;

  const SELECTORS = {
    receiverName: "#ContentPlaceHolder1_txt1_receivename",
    receiverId: "#ContentPlaceHolder1_stu_receiveid",
    status: "#ContentPlaceHolder1_drop1_lecondition",
    dateType: "#ContentPlaceHolder1_drop2_datetype",
    dateInterval: "#ContentPlaceHolder1_drop3_dateinterval",
    queryButton: "#ContentPlaceHolder1_btnquery",
    message: "#ContentPlaceHolder1_lb1_msg"
  };

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function cleanText(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && descriptor.set) descriptor.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function selectValue(selector, value) {
    const el = document.querySelector(selector);
    if (!el) return false;
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function isQueryPageReady() {
    return Boolean(document.querySelector(SELECTORS.receiverName) && document.querySelector(SELECTORS.queryButton));
  }

  async function resolveReceiverByAjax(name) {
    try {
      const res = await fetch(new URL("/postal/studentletter.aspx/GetCustomers", location.origin).href, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ prefix: name })
      });
      if (!res.ok) return null;
      const data = await res.json();
      const list = Array.isArray(data.d) ? data.d : [];
      const items = list.map(item => {
        const parts = String(item).split("-");
        return {
          label: cleanText(parts[0] || ""),
          val: cleanText(parts.slice(1).join("-") || "")
        };
      }).filter(item => item.label || item.val);

      if (!items.length) return null;
      return items.find(item => item.label === name) || items.find(item => item.label.includes(name)) || items[0];
    } catch (err) {
      console.warn("Autocomplete AJAX failed", err);
      return null;
    }
  }

  async function fillReceiver(recipient) {
    const nameEl = document.querySelector(SELECTORS.receiverName);
    const idEl = document.querySelector(SELECTORS.receiverId);
    if (!nameEl) return false;

    setNativeValue(nameEl, "");
    nameEl.focus();
    setNativeValue(nameEl, recipient.name || "");

    if (idEl) {
      if (recipient.receiverId) {
        setNativeValue(idEl, recipient.receiverId);
      } else {
        setNativeValue(idEl, "");
      }
    }

    if (!recipient.receiverId) {
      const resolved = await resolveReceiverByAjax(recipient.name || "");
      if (resolved) {
        setNativeValue(nameEl, resolved.label || recipient.name || "");
        if (idEl && resolved.val) setNativeValue(idEl, resolved.val);
        return true;
      }
    }

    return true;
  }

  function findResultGrid() {
    const byId = Array.from(document.querySelectorAll("table[id]")).find(table => table.id && table.id.endsWith("grid"));
    if (byId) return byId;

    // 後備：找出第一個看起來像查詢結果、且不是查詢條件表單的表格。
    return Array.from(document.querySelectorAll("table")).find(table => {
      const text = cleanText(table.innerText);
      if (!text) return false;
      if (text.includes("收件人(請輸入兩個字以上)")) return false;
      return table.querySelectorAll("tr").length >= 2;
    }) || null;
  }

  function parseGridRows() {
    const grid = findResultGrid();
    if (!grid) return [];

    const rows = Array.from(grid.querySelectorAll("tr"))
      .map(tr => Array.from(tr.querySelectorAll("th, td"))
        .map(td => cleanText(td.innerText))
        .filter(Boolean))
      .filter(row => row.length > 0);

    if (rows.length <= 1) return [];

    const header = rows[0];
    const dataRows = rows.slice(1);

    return dataRows.map(row => {
      const obj = {};
      row.forEach((value, index) => {
        obj[header[index] || `欄位${index + 1}`] = value;
      });
      return obj;
    });
  }

  function getPageMessage() {
    const msg = document.querySelector(SELECTORS.message);
    return msg ? cleanText(msg.innerText) : "";
  }

  async function runRecipient(message) {
    const { runId, index, recipient } = message;

    if (!isQueryPageReady()) {
      chrome.runtime.sendMessage({
        type: "CGU_LOGIN_REQUIRED",
        runId,
        index,
        recipient,
        message: "找不到查詢欄位，可能尚未登入或頁面不是郵件查詢頁"
      });
      return { ok: false, message: "找不到查詢欄位" };
    }

    await fillReceiver(recipient);
    selectValue(SELECTORS.status, recipient.status ?? "0");
    selectValue(SELECTORS.dateType, recipient.dateType ?? "0");
    selectValue(SELECTORS.dateInterval, recipient.dateInterval ?? "1");

    await chrome.storage.local.set({
      pendingParse: {
        runId,
        index,
        recipient,
        submittedAt: Date.now()
      }
    });

    const btn = document.querySelector(SELECTORS.queryButton);
    if (!btn) return { ok: false, message: "找不到查詢按鈕" };

    // 先回覆 background，再延遲送出表單；避免表單導頁太快造成訊息通道中斷。
    setTimeout(() => btn.click(), 150);
    return { ok: true };
  }

  async function maybeParsePendingResult() {
    const data = await chrome.storage.local.get(["pendingParse"]);
    const pending = data.pendingParse;
    if (!pending || !pending.runId) return;

    // 避免在送出後太快解析到舊畫面。
    if (Date.now() - Number(pending.submittedAt || 0) < 700) {
      await sleep(700);
    }

    if (!isQueryPageReady()) {
      chrome.runtime.sendMessage({
        type: "CGU_LOGIN_REQUIRED",
        runId: pending.runId,
        index: pending.index,
        recipient: pending.recipient,
        message: "查詢後找不到表單，可能登入失效"
      });
      await chrome.storage.local.set({ pendingParse: null });
      return;
    }

    await sleep(500);
    const rows = parseGridRows();
    const pageMessage = getPageMessage();

    await chrome.storage.local.set({ pendingParse: null });
    chrome.runtime.sendMessage({
      type: "CGU_QUERY_RESULT",
      runId: pending.runId,
      index: pending.index,
      recipient: pending.recipient,
      rows,
      pageMessage
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      if (message.type === "CGU_RUN_RECIPIENT") {
        const result = await runRecipient(message);
        sendResponse(result);
        return;
      }
      sendResponse({ ok: false, message: "Unknown content message" });
    })().catch(err => {
      console.error(err);
      sendResponse({ ok: false, message: String(err && err.message ? err.message : err) });
    });
    return true;
  });

  maybeParsePendingResult().catch(err => console.error("CGU parse result error", err));
})();
