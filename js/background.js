/**
 * Background Service Worker — Orchestrates the cancel flow.
 *
 * The key insight: content scripts die on every page navigation, but the
 * background worker survives.  So we store the cancel queue in
 * chrome.storage.local and let the content script on each page ask
 * "what should I do now?" via messaging.
 *
 * State machine stored in chrome.storage.local:
 *   cancelQueue   – array of { id, title, status }
 *   currentIndex  – index into cancelQueue we're working on (-1 = idle)
 *   phase         – 'idle' | 'navigating_to_cancel' | 'on_cancel_page' | 'done'
 *   returnUrl     – the subscription list URL to go back to after each cancel
 *   tabId         – the tab we're operating on
 */

// ── helpers ─────────────────────────────────────────────────────────
async function getState() {
  const s = await chrome.storage.local.get([
    'cancelQueue', 'currentIndex', 'phase', 'returnUrl', 'tabId',
  ]);
  return {
    cancelQueue: s.cancelQueue || [],
    currentIndex: s.currentIndex ?? -1,
    phase: s.phase || 'idle',
    returnUrl: s.returnUrl || '',
    tabId: s.tabId ?? -1,
  };
}

function setState(patch) {
  return chrome.storage.local.set(patch);
}

async function resetState() {
  await chrome.storage.local.set({
    cancelQueue: [],
    currentIndex: -1,
    phase: 'idle',
    returnUrl: '',
    tabId: -1,
  });
}

// ── message handler (from popup + content scripts) ──────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse);
  return true; // keep channel open for async response
});

async function handleMessage(msg, sender) {
  const state = await getState();

  // ── Popup asks: start cancellation ──
  if (msg.action === 'startCancel') {
    const queue = msg.subscriptions.map((s) => ({
      id: s.id,
      title: s.title,
      status: 'pending',
    }));
    await setState({
      cancelQueue: queue,
      currentIndex: 0,
      phase: 'navigating_to_cancel',
      returnUrl: msg.returnUrl,
      tabId: msg.tabId,
    });
    // Navigate the tab to the first cancel page
    const first = queue[0];
    const cancelUrl = buildCancelUrl(first.id);
    chrome.tabs.update(msg.tabId, { url: cancelUrl });
    return { started: true, total: queue.length };
  }

  // ── Popup asks: get current progress ──
  if (msg.action === 'getProgress') {
    return {
      cancelQueue: state.cancelQueue,
      currentIndex: state.currentIndex,
      phase: state.phase,
    };
  }

  // ── Popup asks: abort ──
  if (msg.action === 'abort') {
    const q = state.cancelQueue;
    q.forEach((item) => {
      if (item.status === 'pending') item.status = 'aborted';
    });
    await setState({ cancelQueue: q, phase: 'idle', currentIndex: -1 });
    // Navigate back to list
    if (state.returnUrl && state.tabId > 0) {
      chrome.tabs.update(state.tabId, { url: state.returnUrl });
    }
    return { aborted: true };
  }

  // ── Popup asks: reset ──
  if (msg.action === 'reset') {
    await resetState();
    return { ok: true };
  }

  // ── Content script says: "I'm on a page, what do I do?" ──
  if (msg.action === 'pageReady') {
    const url = msg.url || '';

    // If we're idle, nothing to do
    if (state.phase === 'idle' || state.currentIndex < 0) {
      return { instruction: 'none' };
    }

    const currentItem = state.cancelQueue[state.currentIndex];
    if (!currentItem) {
      await setState({ phase: 'idle', currentIndex: -1 });
      return { instruction: 'none' };
    }

    // ── We're on the cancel page ──
    if (url.includes('/auto-deliveries/cancelSubscription')) {
      await setState({ phase: 'on_cancel_page' });
      return { instruction: 'cancel_now', subscriptionId: currentItem.id };
    }

    // ── We've landed back on the subscription list (cancel completed) ──
    if (
      url.includes('/auto-deliveries/subscriptionList') ||
      (url.includes('/auto-deliveries') && !url.includes('cancelSubscription'))
    ) {
      // The previous cancel succeeded if we ended up here
      if (state.phase === 'on_cancel_page') {
        currentItem.status = 'done';
        const nextIndex = state.currentIndex + 1;

        if (nextIndex < state.cancelQueue.length) {
          // Move to next
          await setState({
            cancelQueue: state.cancelQueue,
            currentIndex: nextIndex,
            phase: 'navigating_to_cancel',
          });
          const next = state.cancelQueue[nextIndex];
          const cancelUrl = buildCancelUrl(next.id);
          chrome.tabs.update(state.tabId, { url: cancelUrl });
          return { instruction: 'wait', message: 'Navigating to next...' };
        } else {
          // All done!
          await setState({
            cancelQueue: state.cancelQueue,
            currentIndex: -1,
            phase: 'done',
          });
          return { instruction: 'all_done' };
        }
      }

      return { instruction: 'none' };
    }

    return { instruction: 'none' };
  }

  // ── Content script says: cancel form was submitted ──
  if (msg.action === 'cancelSubmitted') {
    const q = state.cancelQueue;
    if (q[state.currentIndex]) {
      q[state.currentIndex].status = msg.success ? 'done' : 'failed';
    }
    await setState({ cancelQueue: q });

    if (msg.success) {
      // Wait a moment, then move on
      const nextIndex = state.currentIndex + 1;
      if (nextIndex < q.length) {
        await setState({
          currentIndex: nextIndex,
          phase: 'navigating_to_cancel',
        });
        // Small delay before navigating to next
        setTimeout(() => {
          const next = q[nextIndex];
          const cancelUrl = buildCancelUrl(next.id);
          chrome.tabs.update(state.tabId, { url: cancelUrl });
        }, 2000);
        return { next: true };
      } else {
        await setState({ phase: 'done', currentIndex: -1 });
        // Go back to list
        setTimeout(() => {
          chrome.tabs.update(state.tabId, { url: state.returnUrl });
        }, 1500);
        return { allDone: true };
      }
    } else {
      // Failed — skip to next
      const nextIndex = state.currentIndex + 1;
      if (nextIndex < q.length) {
        await setState({
          currentIndex: nextIndex,
          phase: 'navigating_to_cancel',
        });
        setTimeout(() => {
          const next = q[nextIndex];
          chrome.tabs.update(state.tabId, { url: buildCancelUrl(next.id) });
        }, 2000);
        return { next: true };
      } else {
        await setState({ phase: 'done', currentIndex: -1 });
        setTimeout(() => {
          chrome.tabs.update(state.tabId, { url: state.returnUrl });
        }, 1500);
        return { allDone: true };
      }
    }
  }

  return { error: 'unknown action' };
}

function buildCancelUrl(subscriptionId) {
  return `https://www.amazon.in/auto-deliveries/cancelSubscription?subscriptionId=${subscriptionId}&sourcePage=subscriptionList`;
}
