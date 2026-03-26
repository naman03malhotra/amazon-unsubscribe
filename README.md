# Amazon Unsubscribe - Bulk Cancel Subscribe & Save

> Cancel all your Amazon Subscribe & Save subscriptions in one click. No more clicking through 50 cancellation pages.

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)](https://github.com/naman03malhotra/amazon-unsubscribe)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)](https://developer.chrome.com/docs/extensions/mv3/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## The Problem

Amazon makes it painfully easy to **subscribe** but deliberately tedious to **unsubscribe**. Each Subscribe & Save cancellation requires:

1. Navigate to the subscription
2. Click cancel
3. Select a reason
4. Confirm cancellation
5. Wait for redirect
6. Repeat for the next one...

Got 20 subscriptions? That's **100+ clicks** and 15 minutes of your life you're never getting back.

## The Solution

This Chrome extension **automates the entire cancellation flow**. Scan, select, cancel - done.

## Features

- **One-Click Scan** - Instantly detects all active Subscribe & Save subscriptions
- **Bulk Cancel** - Cancel all subscriptions at once, or pick specific ones
- **Live Progress** - Real-time status updates with progress bar and activity log
- **Abort Anytime** - Stop the cancellation mid-way if you change your mind
- **Smart Automation** - Handles Amazon's dynamic UI, custom dropdowns, and page navigation
- **Persistent State** - Close and reopen the popup without losing progress
- **Zero Dependencies** - Pure vanilla JS, no frameworks, no bloat

## How It Works

```
Scan Subscriptions → Select (or Select All) → Cancel → Done
```

The extension navigates through each subscription's cancel page automatically - selecting the cancellation reason, clicking confirm, and moving to the next one. You just watch it go.

## Installation

1. **Download** this repo ([ZIP](https://github.com/naman03malhotra/amazon-unsubscribe/archive/refs/heads/main.zip)) or clone it:
   ```bash
   git clone https://github.com/naman03malhotra/amazon-unsubscribe.git
   ```

2. Open **Chrome** and go to `chrome://extensions/`

3. Enable **Developer mode** (top right toggle)

4. Click **Load unpacked** and select the extension folder

5. Pin the extension from the toolbar for easy access

## Usage

1. Go to [Amazon Subscribe & Save](https://www.amazon.in/auto-deliveries/subscriptionList)
2. Click the extension icon
3. Click **Scan Subscriptions**
4. Review the list - check/uncheck items as needed
5. Click **Cancel Selected** or **Cancel ALL**
6. Confirm and let it run - keep the tab open
7. Done! Check the activity log for a summary

> **Note:** Currently supports **amazon.in**. Support for other regions can be added by modifying the URL patterns in `manifest.json`.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Extension API | Chrome Manifest V3 |
| Language | Vanilla JavaScript |
| State Management | `chrome.storage.local` |
| DOM Automation | MutationObserver + Native APIs |
| Styling | CSS (dark theme) |

## Architecture

```
popup.js          ←→  background.js  ←→  content.js
(UI & controls)       (orchestrator)      (page automation)
     ↕                      ↕                    ↕
  User clicks         chrome.storage        Amazon DOM
  & displays          (persistent state)    (scan & cancel)
```

- **Popup** - The UI you interact with. Polls background for progress updates every 1.5s.
- **Background Service Worker** - Orchestrates the cancel flow, manages state machine, handles tab navigation.
- **Content Script** - Injected into Amazon pages. Scans subscriptions and performs the actual cancel automation.

## Project Structure

```
amazon-unsubscribe/
├── manifest.json        # Extension config & permissions
├── popup.html           # Extension popup UI
├── js/
│   ├── popup.js         # Popup controller & rendering
│   ├── content.js       # DOM automation & scanning
│   └── background.js    # State machine & orchestration
├── css/
│   └── content.css      # Injected page styles
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Contributing

Contributions are welcome! Some ideas:

- [ ] Support for amazon.com, amazon.co.uk, and other regions
- [ ] Chrome Web Store publishing
- [ ] Firefox/Edge port
- [ ] Subscription analytics (total savings, subscription history)
- [ ] Schedule cancellations for a future date

## FAQ

**Is this safe?**
Yes. The extension only runs on Amazon subscription pages. It performs the exact same clicks you would manually - just faster. No data is collected or sent anywhere.

**Will Amazon ban my account?**
No. The extension simulates normal user interactions at human-like speed. It's no different from clicking the buttons yourself.

**Does it work on amazon.com?**
Currently built for amazon.in. Adding other regions requires updating the URL match patterns in `manifest.json` - PRs welcome!

**Can I undo a cancellation?**
Amazon allows you to re-subscribe to items. The extension only cancels - it doesn't delete your subscription history.

## License

MIT - do whatever you want with it.

---

**If this saved you time, consider giving it a star!**
