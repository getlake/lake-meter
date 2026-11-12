# GIF shot list (real Claude Code session, ~25 s)

Setup: a small real repo, `npx lake-meter init --cap 2`, terminal 120×34.

1. (0–3 s) `npx lake-meter init --cap 2`: show the ✓ lines.
2. (3–10 s) `claude`, Shift+Tab to plan mode, prompt "Add retries to webhook delivery". Cut while Claude explores.
3. (10–16 s) The "Ready to code?" dialog: the "Lake Meter estimate: …" line on top, then scroll to the per-step table.
4. (16–21 s) Approve. Cut ahead to the cap prompt ("Lake Meter: this run has used about $2.1x (cap $2.00)…"). Press 1.
5. (21–25 s) End of turn: "Stop says: Lake Meter · run $… · Since plan approved: … vs … estimated", plus the statusline.

Needs a real Claude account (yours). No-account preview: `npm run demo` (simulated).
