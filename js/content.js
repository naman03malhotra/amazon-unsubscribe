/**
 * Content Script — runs on every amazon.in/auto-deliveries* page.
 *
 * Two roles:
 *  1. SCAN mode  — popup asks for subscription data on the list page
 *  2. AUTO-CANCEL mode — background tells us we're on a cancel page;
 *     we select a reason and click the "Cancel my subscription" button
 *     using real DOM interactions.
 */

(function () {
  'use strict';

  // ── Utilities ──────────────────────────────────────────────────────
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Wait for a DOM element to appear, up to `timeout` ms. */
  function waitForElement(selector, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);

      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timeout waiting for ${selector}`));
      }, timeout);
    });
  }

  /** Find an element by its visible text content. */
  function findByText(tag, text) {
    const els = document.querySelectorAll(tag);
    for (const el of els) {
      if (el.textContent.trim() === text) return el;
    }
    return null;
  }

  // ── SCAN: extract subscriptions from the list page ─────────────────
  function scanSubscriptions() {
    const subscriptions = [];
    const seen = new Set();

    // From the subscription list tab
    const cards = document.querySelectorAll('.subscription-card-item');
    cards.forEach((card) => {
      const editLink = card.querySelector('a[href*="subscriptionId="]');
      if (!editLink) return;
      const match = editLink.href.match(/subscriptionId=([^&]+)/);
      if (!match) return;
      const id = match[1];
      if (seen.has(id)) return;
      seen.add(id);

      const titleEl =
        card.querySelector('.a-truncate-full') ||
        card.querySelector('[class*="product-title"] span') ||
        card.querySelector('[class*="product-title"]');
      const title = titleEl ? titleEl.textContent.trim() : 'Unknown Product';

      subscriptions.push({ id, title: title.substring(0, 120) });
    });

    // Fallback: deliveries tab
    if (subscriptions.length === 0) {
      document.querySelectorAll('a[href*="/auto-deliveries/ajax/subscription"]').forEach((link) => {
        const match = link.href.match(/subscriptionId=([^&]+)/);
        if (!match) return;
        const id = match[1];
        if (seen.has(id)) return;
        seen.add(id);

        const img = link.querySelector('img');
        const title = img ? img.alt : 'Subscription';
        subscriptions.push({ id, title: title.substring(0, 120) });
      });
    }

    return subscriptions;
  }

  // ── AUTO-CANCEL: perform UI clicks on the cancel page ──────────────
  async function performCancel() {
    try {
      showBanner('Preparing to cancel...');

      // Step 1: Wait for the actionPanel to load
      const panel = await waitForElement('.actionPanel', 10000);
      await sleep(800);

      // Step 2: Select a cancellation reason from the dropdown (optional
      //         but some pages may require it)
      try {
        // Amazon uses a custom dropdown (.a-dropdown-container)
        // The native <select> is hidden but we can set its value directly
        const reasonSelect = panel.querySelector('select');
        if (reasonSelect) {
          // Pick "I already have more than I need" (first non-placeholder option)
          const options = reasonSelect.querySelectorAll('option');
          let targetValue = '';
          for (const opt of options) {
            if (opt.value && opt.value !== '' && !opt.disabled) {
              targetValue = opt.value;
              break;
            }
          }
          if (targetValue) {
            // Set native select
            reasonSelect.value = targetValue;
            reasonSelect.dispatchEvent(new Event('change', { bubbles: true }));
            await sleep(300);

            // Also click the Amazon custom dropdown to make it visually update
            const dropdownButton = panel.querySelector('.a-dropdown-container .a-button-dropdown, .a-dropdown-container .a-dropdown-prompt');
            if (dropdownButton) {
              dropdownButton.click();
              await sleep(500);
              // Click the first real option in the dropdown popover
              const popover = document.querySelector('.a-popover-wrapper .a-nostyle a, .a-popover .a-dropdown-item:not(.a-dropdown-prompt-text)');
              if (popover) {
                popover.click();
                await sleep(300);
              } else {
                // Close dropdown if we couldn't pick an option
                dropdownButton.click();
                await sleep(200);
              }
            }
          }
        }
      } catch (e) {
        console.log('[SNS Canceller] Reason selection skipped:', e.message);
      }

      showBanner('Clicking cancel button...');
      await sleep(500);

      // Step 3: Find and click the "Cancel my subscription" submit button
      let cancelClicked = false;

      // Method A: Find the form inside .actionPanel and submit it
      const form = panel.querySelector('form');
      if (form) {
        const submitBtn = form.querySelector('input[type="submit"]');
        if (submitBtn) {
          submitBtn.click();
          cancelClicked = true;
        }
      }

      // Method B: Find span with "Cancel my subscription" and click its parent
      if (!cancelClicked) {
        const cancelSpan = findByText('span', 'Cancel my subscription');
        if (cancelSpan) {
          // Walk up to find a clickable parent
          let clickTarget = cancelSpan.closest('form');
          if (clickTarget) {
            const btn = clickTarget.querySelector('input[type="submit"], button[type="submit"]');
            if (btn) {
              btn.click();
              cancelClicked = true;
            }
          }
          if (!cancelClicked) {
            // Direct click on the span's parent div
            cancelSpan.parentElement.click();
            cancelClicked = true;
          }
        }
      }

      // Method C: Find any submit input near "Cancel my subscription"
      if (!cancelClicked) {
        const allSubmits = document.querySelectorAll('input[type="submit"]');
        for (const btn of allSubmits) {
          const nearby = btn.closest('.actionPanel, [class*="cancel"]');
          if (nearby) {
            btn.click();
            cancelClicked = true;
            break;
          }
        }
      }

      if (!cancelClicked) {
        throw new Error('Could not find cancel button on page');
      }

      showBanner('Cancel submitted! Waiting...');

      // Wait for page navigation (the form submit will cause a redirect)
      await sleep(2000);

      // Tell background we submitted
      chrome.runtime.sendMessage({
        action: 'cancelSubmitted',
        success: true,
      });
    } catch (err) {
      console.error('[SNS Canceller] Cancel failed:', err);
      showBanner('Cancel failed: ' + err.message, true);

      chrome.runtime.sendMessage({
        action: 'cancelSubmitted',
        success: false,
        error: err.message,
      });
    }
  }

  // ── Banner overlay for user feedback ───────────────────────────────
  function showBanner(text, isError = false) {
    let banner = document.getElementById('sns-ext-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'sns-ext-banner';
      banner.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; z-index: 999999;
        padding: 12px 24px; font-size: 14px; font-weight: 600;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        text-align: center; transition: all 0.3s ease;
        display: flex; align-items: center; justify-content: center; gap: 10px;
      `;
      document.body.appendChild(banner);
    }
    banner.style.background = isError
      ? 'linear-gradient(135deg, #da3633, #b62324)'
      : 'linear-gradient(135deg, #ff9900, #e88600)';
    banner.style.color = isError ? '#fff' : '#232f3e';
    banner.innerHTML = `
      <span style="display:inline-block;width:10px;height:10px;border-radius:50%;
        background:${isError ? '#ff6b6b' : '#232f3e'};
        ${isError ? '' : 'animation:snsPulse 1s infinite;'}"></span>
      <style>@keyframes snsPulse{0%,100%{opacity:1}50%{opacity:.3}}</style>
      ${text}
    `;
  }

  function removeBanner() {
    const banner = document.getElementById('sns-ext-banner');
    if (banner) banner.remove();
  }

  // ── Message listener (from popup and background) ───────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'scan') {
      const subs = scanSubscriptions();
      sendResponse({ subscriptions: subs });
      return false;
    }

    if (msg.action === 'ping') {
      sendResponse({ ok: true, url: window.location.href });
      return false;
    }

    // Background tells us to cancel
    if (msg.instruction === 'cancel_now') {
      performCancel();
      sendResponse({ ok: true });
      return false;
    }
  });

  // ── On every page load, ask background "what should I do?" ─────────
  async function checkInWithBackground() {
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'pageReady',
        url: window.location.href,
      });

      if (!response) return;

      if (response.instruction === 'cancel_now') {
        await sleep(1000); // let the page fully settle
        performCancel();
      } else if (response.instruction === 'wait') {
        showBanner(response.message || 'Processing...');
      } else if (response.instruction === 'all_done') {
        showBanner('All subscriptions cancelled!');
        setTimeout(removeBanner, 5000);
      } else {
        removeBanner();
      }
    } catch (e) {
      // Background not available yet, that's fine
    }
  }

  // Run check-in after a short delay to let the page load
  setTimeout(checkInWithBackground, 1500);

  // Expose for debugging
  window.__SNS_CANCELLER = { scanSubscriptions, performCancel };
})();
