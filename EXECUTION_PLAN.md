# Logbook Advanced Features — Detailed Step-by-Step Execution Plan

This document breaks down every phase into concrete, atomic engineering tasks, exact file touchpoints, and verification steps so implementation can proceed flawlessly.

---

## Step 1: AI-Powered Release Note & Weekly Digest Generator

### 1.1 Backend Engine (`release-notes-engine.js`)
- [ ] **Create `release-notes-engine.js`**:
  - Write helper function `categorizeCommits(commits)` to group commit messages by conventional commit prefixes (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`).
  - Implement `generateMarkdownDigest(groupedCommits, options)` to format clean, professional Markdown release notes or executive weekly digests.
  - Add optional LLM proxy connector (`callLocalLLM(prompt)`) supporting local Ollama (`http://127.0.0.1:11434/api/generate`) for offline AI synthesis.
- [ ] **Expose API Endpoint in `server.js`**:
  - Add `POST /api/release-notes` protected by session guard and rate limiter.
  - Return generated markdown and JSON summary.

### 1.2 Frontend Integration (`index.html`)
- [ ] **Add Release Notes Modal HTML**:
  - Create a modal (`release-notes-modal`) with date range picker, repo filter checkboxes, tone selector (Professional / Bulleted / Executive), and a copy-to-clipboard button.
- [ ] **Register ⌘K Command**:
  - Add "Generate Release Notes / Weekly Digest" to `commandItems()`.
- [ ] **Wire Event Listeners**:
  - Connect fetch request to `POST /api/release-notes` and render Markdown output live.

---

## Step 2: Multi-Repository Dependency & Vulnerability Radar

### 2.1 Scanner Backend (`dependency-scanner.js`)
- [ ] **Create `dependency-scanner.js`**:
  - Implement manifest detection for `package.json` (Node), `requirements.txt` (Python), `Cargo.toml` (Rust), `go.mod` (Go).
  - Implement repository hygiene check: inspect root for `LICENSE`, `README.md`, `.gitignore`, and `.github/workflows`.
- [ ] **Expose API Endpoint in `server.js`**:
  - Add `POST /api/dependencies/scan` accepting project root path.

### 2.2 Frontend Radar Tab (`index.html`)
- [ ] **Add Navigation Item**:
  - Add "Radar" section (`section-radar`) to main navigation and DOM.
- [ ] **Render Radar Table**:
  - Display repositories in a tabular ledger showing dependency status, outdated package counts, and hygiene scorecards.

---

## Step 3: Interactive Code Heatmap & Productivity Clock Radial View

### 3.1 Analytics Enhancements (`analytics-engine.js` / `index.html`)
- [ ] **Compute Diurnal Metrics**:
  - Process commit timestamps into 24-hour hour-of-day frequency bins and 7-day weekday bins.
- [ ] **Render SVG Radial Clock & Churn Treemap**:
  - Create SVG generator functions for a 24-hour radial clock showing peak productivity hours.
  - Add UI cards in the **Matrix** (`section-rhythm`) section.

---

## Step 4: Encrypted Peer-to-Peer Code Sync & Backup Checkpoints

### 4.1 Backup Module (`snapshot-export.js` / `server.js`)
- [ ] **Implement AES-256-GCM Backup Export/Import**:
  - Encrypt active account snapshot and preferences using user passphrase via Node.js `crypto`.
  - Add `POST /api/backup/export` and `POST /api/backup/import` endpoints.
- [ ] **Settings Modal Controls**:
  - Add "Export Encrypted Backup" and "Restore Backup" buttons in the account settings modal.

---

## Step 5: Smart Stash & Branch Switcher Command Palette (⌘K)

### 5.1 Git Multi-Repo Operations (`commit-engine.js` / `server.js`)
- [ ] **Add Git Stash & Checkout Handlers**:
  - Implement `git stash save`, `git checkout <branch>`, and `git pull --ff-only` safety wrappers using `execFile`.
  - Expose `POST /api/commit/stash` and `POST /api/commit/checkout`.
- [ ] **Command Palette Actions**:
  - Add "Stash all changes across workspace", "Switch branch across repositories", and "Pull latest updates" to ⌘K.
