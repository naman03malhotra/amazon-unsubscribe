/**
 * Popup Script — shows subscription list and controls the cancel flow.
 *
 * The popup talks to:
 *  - content script (via chrome.tabs.sendMessage) for scanning
 *  - background worker (via chrome.runtime.sendMessage) for orchestration
 *
 * Since the popup closes when the user clicks away, we poll the background
 * for progress state and rebuild UI from that.
 */

document.addEventListener('DOMContentLoaded', async () => {
  const DOM = {
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    totalCount: document.getElementById('totalCount'),
    selectedCount: document.getElementById('selectedCount'),
    cancelledCount: document.getElementById('cancelledCount'),
    btnScan: document.getElementById('btnScan'),
    btnCancelSelected: document.getElementById('btnCancelSelected'),
    btnCancelAll: document.getElementById('btnCancelAll'),
    btnAbort: document.getElementById('btnAbort'),
    listContainer: document.getElementById('listContainer'),
    subList: document.getElementById('subList'),
    selectAll: document.getElementById('selectAll'),
    selectCountText: document.getElementById('selectCountText'),
    progressBar: document.getElementById('progressBar'),
    progressFill: document.getElementById('progressFill'),
    logBox: document.getElementById('logBox'),
  };

  let subscriptions = [];
  let isCancelling = false;
  let pollTimer = null;

  // ── Helpers ────────────────────────────────────────────────────────
  function setStatus(type, html) {
    DOM.statusDot.className = 'status-dot ' + type;
    DOM.statusText.innerHTML = html;
  }

  function log(msg, type = '') {
    DOM.logBox.classList.add('visible');
    const entry = document.createElement('div');
    entry.className = 'log-entry ' + type;
    const ts = new Date().toLocaleTimeString();
    entry.textContent = `[${ts}] ${msg}`;
    DOM.logBox.appendChild(entry);
    DOM.logBox.scrollTop = DOM.logBox.scrollHeight;
  }

  function updateSelectedCount() {
    const checked = DOM.subList.querySelectorAll('input[type="checkbox"]:checked');
    DOM.selectedCount.textContent = checked.length;
    DOM.selectCountText.textContent = `${checked.length} selected`;
    DOM.btnCancelSelected.disabled = checked.length === 0 || isCancelling;
    DOM.btnCancelAll.disabled = subscriptions.length === 0 || isCancelling;
  }

  function getSelectedIds() {
    return [...DOM.subList.querySelectorAll('input[type="checkbox"]:checked')]
      .map((cb) => cb.dataset.id);
  }

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function sendToContent(msg) {
    const tab = await getActiveTab();
    if (!tab) throw new Error('No active tab');
    if (!tab.url?.includes('amazon.in/auto-deliveries')) {
      throw new Error('NOT_ON_PAGE');
    }
    return chrome.tabs.sendMessage(tab.id, msg);
  }

  async function sendToBackground(msg) {
    return chrome.runtime.sendMessage(msg);
  }

  // ── Render subscription list ───────────────────────────────────────
  function renderList(queue) {
    DOM.subList.innerHTML = '';
    const items = queue || subscriptions;

    items.forEach((sub) => {
      const item = document.createElement('div');
      item.className = 'sub-item';
      item.dataset.id = sub.id;

      const status = sub.status || 'pending';
      const isDone = status === 'done';
      const isFailed = status === 'failed';

      const statusLabels = {
        pending: 'Active',
        cancelling: 'Cancelling...',
        done: 'Cancelled',
        failed: 'Failed',
        aborted: 'Skipped',
      };

      item.innerHTML = `
        <input type="checkbox" data-id="${sub.id}" ${isDone || isCancelling ? 'disabled' : ''}>
        <div class="sub-item-info">
          <div class="sub-item-name" title="${sub.title}">${sub.title}</div>
          <div class="sub-item-meta">${sub.id.substring(0, 24)}</div>
        </div>
        <span class="sub-item-status ${status}">${statusLabels[status] || status}</span>
      `;

      const checkbox = item.querySelector('input[type="checkbox"]');
      checkbox.addEventListener('change', updateSelectedCount);
      DOM.subList.appendChild(item);
    });

    DOM.listContainer.style.display = 'block';
    updateSelectedCount();
  }

  // ── Check if a cancellation is in progress (restore state) ─────────
  async function checkExistingProgress() {
    try {
      const progress = await sendToBackground({ action: 'getProgress' });
      if (!progress) return;

      if (progress.phase === 'done') {
        // Show completed state
        const q = progress.cancelQueue || [];
        subscriptions = q;
        const doneCount = q.filter((s) => s.status === 'done').length;
        const failCount = q.filter((s) => s.status === 'failed').length;

        DOM.totalCount.textContent = q.length;
        DOM.cancelledCount.textContent = doneCount;
        renderList(q);
        setStatus('active', `Done! <strong>${doneCount}</strong> cancelled, <strong>${failCount}</strong> failed`);
        log(`Completed: ${doneCount} cancelled, ${failCount} failed`, doneCount > 0 ? 'success' : 'error');

        DOM.btnScan.textContent = 'Re-scan';
        DOM.btnScan.disabled = false;
        DOM.btnAbort.style.display = 'none';
        // Reset background state so next scan is clean
        await sendToBackground({ action: 'reset' });
        return;
      }

      if (
        progress.phase === 'navigating_to_cancel' ||
        progress.phase === 'on_cancel_page'
      ) {
        // Cancellation in progress — show live state
        isCancelling = true;
        const q = progress.cancelQueue || [];
        subscriptions = q;
        const idx = progress.currentIndex;
        const doneCount = q.filter((s) => s.status === 'done').length;

        DOM.totalCount.textContent = q.length;
        DOM.cancelledCount.textContent = doneCount;
        renderList(q);

        setStatus('working', `Cancelling <strong>${idx + 1}/${q.length}</strong>...`);
        DOM.progressBar.classList.add('visible');
        DOM.progressFill.style.width = Math.round(((idx) / q.length) * 100) + '%';

        DOM.btnScan.disabled = true;
        DOM.btnCancelSelected.disabled = true;
        DOM.btnCancelAll.disabled = true;
        DOM.btnAbort.style.display = 'block';

        // Start polling for updates
        startPolling();
        return;
      }
    } catch (e) {
      // No progress, that's fine
    }
  }

  // ── Poll background for live progress ──────────────────────────────
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const p = await sendToBackground({ action: 'getProgress' });
        if (!p) return;

        const q = p.cancelQueue || [];
        const doneCount = q.filter((s) => s.status === 'done').length;
        const failCount = q.filter((s) => s.status === 'failed').length;

        DOM.cancelledCount.textContent = doneCount;
        DOM.progressFill.style.width =
          Math.round(((doneCount + failCount) / q.length) * 100) + '%';

        // Update item statuses in the list
        q.forEach((item) => {
          const el = DOM.subList.querySelector(`.sub-item[data-id="${item.id}"]`);
          if (!el) return;
          const badge = el.querySelector('.sub-item-status');
          if (badge.className.includes(item.status)) return; // no change
          badge.className = 'sub-item-status ' + item.status;
          const labels = { pending: 'Active', cancelling: 'Cancelling...', done: 'Cancelled', failed: 'Failed', aborted: 'Skipped' };
          badge.textContent = labels[item.status] || item.status;
        });

        if (p.currentIndex >= 0) {
          setStatus('working', `Cancelling <strong>${p.currentIndex + 1}/${q.length}</strong>...`);
        }

        if (p.phase === 'done' || p.phase === 'idle') {
          clearInterval(pollTimer);
          isCancelling = false;
          DOM.btnScan.disabled = false;
          DOM.btnScan.textContent = 'Re-scan';
          DOM.btnAbort.style.display = 'none';

          if (doneCount + failCount === q.length) {
            setStatus(
              failCount === 0 ? 'active' : 'error',
              `Done! <strong>${doneCount}</strong> cancelled` +
                (failCount > 0 ? `, <strong>${failCount}</strong> failed` : '')
            );
            log(`Completed: ${doneCount} cancelled, ${failCount} failed`, 'success');
          }
          await sendToBackground({ action: 'reset' });
        }
      } catch (e) {
        // popup might close, that's ok
      }
    }, 1500);
  }

  // ── SCAN button ────────────────────────────────────────────────────
  DOM.btnScan.addEventListener('click', async () => {
    DOM.btnScan.disabled = true;
    setStatus('working', 'Scanning subscriptions...');
    log('Scanning page for subscriptions...', 'info');

    try {
      // Ensure content script is injected
      const tab = await getActiveTab();
      if (!tab?.url?.includes('amazon.in')) {
        setStatus('error', 'Open <strong>amazon.in/auto-deliveries</strong> first');
        log('Navigate to Amazon Subscribe & Save page first', 'error');
        DOM.btnScan.disabled = false;
        return;
      }

      // Try pinging content script; inject if needed
      let ping = null;
      try {
        ping = await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
      } catch (e) {
        // Inject content script
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['js/content.js'],
        });
        await new Promise((r) => setTimeout(r, 800));
        ping = await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
      }

      // If not on subscription list tab, navigate there
      if (ping?.url && !ping.url.includes('subscriptionList')) {
        const listUrl = ping.url.replace(/\/auto-deliveries.*/, '/auto-deliveries/subscriptionList');
        await chrome.tabs.update(tab.id, { url: listUrl });
        setStatus('working', 'Navigating to subscriptions tab... <strong>Click Scan again in 3s</strong>');
        log('Switched to Subscriptions tab — click Scan again once loaded.', 'info');
        DOM.btnScan.disabled = false;
        DOM.btnScan.textContent = 'Re-scan';
        return;
      }

      // Scan!
      const result = await chrome.tabs.sendMessage(tab.id, { action: 'scan' });

      if (result?.subscriptions?.length > 0) {
        subscriptions = result.subscriptions;
        DOM.totalCount.textContent = subscriptions.length;
        setStatus('active', `Found <strong>${subscriptions.length}</strong> subscriptions`);
        log(`Found ${subscriptions.length} active subscriptions`, 'success');
        renderList();
      } else {
        DOM.totalCount.textContent = '0';
        setStatus('error', 'No subscriptions found');
        log('No subscriptions detected. Ensure you are on the SUBSCRIPTIONS tab.', 'error');
      }
    } catch (err) {
      setStatus('error', 'Scan failed — try refreshing the page');
      log('Error: ' + err.message, 'error');
    }

    DOM.btnScan.disabled = false;
  });

  // ── CANCEL SELECTED button ─────────────────────────────────────────
  DOM.btnCancelSelected.addEventListener('click', () => {
    const ids = getSelectedIds();
    if (ids.length === 0) return;
    beginCancel(ids);
  });

  // ── CANCEL ALL button ──────────────────────────────────────────────
  DOM.btnCancelAll.addEventListener('click', () => {
    const allIds = subscriptions.map((s) => s.id);
    if (allIds.length === 0) return;
    beginCancel(allIds);
  });

  // ── ABORT button ───────────────────────────────────────────────────
  DOM.btnAbort.addEventListener('click', async () => {
    await sendToBackground({ action: 'abort' });
    isCancelling = false;
    clearInterval(pollTimer);
    setStatus('error', 'Cancelled by user');
    log('Abort requested — stopping...', 'error');
    DOM.btnScan.disabled = false;
    DOM.btnScan.textContent = 'Re-scan';
    DOM.btnAbort.style.display = 'none';
    DOM.btnCancelSelected.disabled = true;
    DOM.btnCancelAll.disabled = true;
  });

  // ── Begin cancel flow ──────────────────────────────────────────────
  async function beginCancel(ids) {
    const count = ids.length;
    if (!confirm(`Cancel ${count} subscription(s)?\n\nThe extension will navigate through each cancel page automatically. Do NOT close the tab while this runs.`)) {
      return;
    }

    isCancelling = true;
    DOM.btnScan.disabled = true;
    DOM.btnCancelSelected.disabled = true;
    DOM.btnCancelAll.disabled = true;
    DOM.btnAbort.style.display = 'block';
    DOM.progressBar.classList.add('visible');
    DOM.progressFill.style.width = '0%';

    setStatus('working', `Starting cancellation of <strong>${count}</strong> subscriptions...`);
    log(`Initiating cancel for ${count} subscriptions...`, 'info');

    const toCancel = subscriptions
      .filter((s) => ids.includes(s.id))
      .map((s) => ({ id: s.id, title: s.title }));

    const tab = await getActiveTab();
    const returnUrl = tab.url;

    try {
      await sendToBackground({
        action: 'startCancel',
        subscriptions: toCancel,
        returnUrl,
        tabId: tab.id,
      });

      // Start polling for progress
      startPolling();
    } catch (err) {
      setStatus('error', 'Failed to start: ' + err.message);
      log('Error: ' + err.message, 'error');
      isCancelling = false;
      DOM.btnScan.disabled = false;
    }
  }

  // ── Select All checkbox ────────────────────────────────────────────
  DOM.selectAll.addEventListener('change', (e) => {
    DOM.subList.querySelectorAll('input[type="checkbox"]:not(:disabled)')
      .forEach((cb) => (cb.checked = e.target.checked));
    updateSelectedCount();
  });

  // ── On popup open, check for existing progress ─────────────────────
  await checkExistingProgress();
});
