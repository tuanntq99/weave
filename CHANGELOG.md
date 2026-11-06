# Changelog

All notable changes to Weave are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-11-06

The first release of **Weave**: a workspace of pages, blocks and databases
that works offline, syncs across your devices, and runs on Cloudflare's
free tier.

### Highlights

- **Write anywhere, offline first.** Every page and edit is saved in the
  browser at once. Weave opens and works with no network and catches up
  by itself when you are back online.
- **Your devices stay in step.** Edits reach your other devices in about a
  second. If two of them change the same paragraph at the same time, the
  edits are merged character by character and nothing is lost.
- **Pages, blocks and databases** in one place, with a fast keyboard-first
  editor.
- **Private by default.** Only the people you allow can sign in (Cloudflare
  Access). Your data lives in your own Cloudflare account.
- **Nightly backups** and 30 days of point-in-time restore.

### Editor

- Block types: text, three heading levels, to-do lists, bulleted and
  numbered lists (nested numbering), quotes, callouts, dividers, code with
  syntax highlighting, simple tables, files and images, and embeds
  (YouTube, X and other links as cards).
- Markdown shortcuts as you type (`#`, `-`, `1.`, `[]`, `>`, ```` ``` ````,
  `**bold**`, `` `code` `` …) and a formatting toolbar: bold, italic,
  underline, strikethrough, inline code, links, text and background colours.
- Mentions of pages and dates, and inline pictures; backlinks show which
  pages point to the one you are reading.
- Drag and drop blocks, move them to another page, group, fold and duplicate
  them; copy and paste keeps formatting.
- Page covers and icons (emoji or your own picture), page fonts, and a
  read-only lock per page.
- Undo and redo, and a **page history** to look at and restore earlier
  versions.

### Databases

- Database pages and inline databases.
- Five views: **Table, Board, List, Gallery and Calendar**, with sorting and
  filtering.
- Property types: text, select, status, date, person and image.
- Open any row as a page in a side peek.

### Organising and finding

- A sidebar page tree with nesting, drag-and-drop ordering and a trash
  (restore or delete for good).
- **Quick Find** across every page.
- A **graph view** of how pages link to each other.
- Light and dark themes: follow the system, or choose one.

### Sync and storage

- Each person's data is kept on the server in their own Durable Object
  (SQLite) and in the browser's IndexedDB. Writes wait in a durable outbox
  and are sent again until the server confirms them, each applied exactly
  once.
- Typing is batched before it is sent (one write per pause instead of one
  per key). This keeps a heavy writer far inside the free tier's daily
  limits.
- Pictures are resized in the browser before upload (up to 2560 px, WebP),
  and a lighter copy is made for display. Files are stored in R2.
- A save indicator shows Saved, Saving or Offline. Closing a tab never
  loses what was typed.

### Install and offline app

- Installable as an app (web manifest) on desktop and phone.
- A service worker keeps the whole app, so it opens with no network,
  including parts loaded on demand such as the picture picker.

### Your data

- **Export** everything to one backup file and **Import** it with a merge
  or a full replace.
- **Clear this device** removes the local copy safely. It is refused while
  changes are still waiting to be sent.
- Every night the server writes a backup of each person's data to R2 and
  keeps the last 30. The owner can roll the data back to any moment in the
  last 30 days.

### Security

- Every request is checked against Cloudflare Access (signed JWT, issuer
  and audience). Requests from other sites are refused, even with a valid
  sign-in.
- When a sign-in runs out, Weave stops syncing and asks you to sign in
  again. Nothing written is lost.

### Sharing (prepared, switched off)

- Shared spaces with roles (owner, full access, editor, viewer), live
  presence and per-role access on the server are built and tested but
  switched **off** in this release. In 1.0.0 Weave is a single person's.
  See *Sharing with other people* in the README to turn sharing on.

### Under the hood

- React 19, TypeScript, Vite. A small SDK of its own (`@notes/sdk`) and a
  protocol package shared by client and server (`@notes/sync-protocol`).
- Cloudflare Workers with static assets, Durable Objects (SQLite, WebSocket
  hibernation), R2 and a nightly cron.
- Tested with unit tests (Vitest), server tests that run on the Workers
  runtime, and end-to-end browser tests that cover two devices syncing and
  opening the app offline.

### Known limitations

- Sharing with other people is off (see above).
- Cards for YouTube and X show only their link, with no title or author.
  Pictures from other sites load only where the site allows it (CORS).
- Point-in-time restore works on Cloudflare only, not in local development.

[1.0.0]: https://github.com/tuanntq99/weave/releases/tag/v1.0.0
