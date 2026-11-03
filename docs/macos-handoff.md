# macOS handoff: Claude Session Monitor 2.0

Version 2.0 was built and verified on Windows 11 (WebView2, NVIDIA GPU). It has not yet been compiled or run on macOS. This guide covers getting it running on a Mac and what is likely to need work there.

The code is cross-platform, and the macOS branches already exist. They have simply never run.

## 1. Get it running

**Prerequisites:**

- Xcode Command Line Tools (`xcode-select --install`).
- Rust 1.77 or later.
- Node 18 or later.
- Claude Code on your `PATH`, with a few sessions in `~/.claude/projects/` so there's something to see.

```bash
git checkout feat/v2-command-center
npm install
npm run tauri:dev        # desktop app, real sessions
npm run dev              # browser only, simulated data, shows "Demo data" in the status bar
```

**Checks to run before and after changes:**

```bash
npx tsc --noEmit -p tsconfig.app.json   # types
npm run lint                            # eslint
npm run check:css                       # no class styled by two views (see Lessons)
cd src-tauri && cargo test              # settings.json installer and transcript parser tests
npm run tauri:build                     # .app and .dmg in src-tauri/target/release/bundle/
```

## 2. How it's put together

| Layer | Where | What it does |
|:---|:---|:---|
| Transcript engine | `src-tauri/src/transcript.rs` | Incremental JSONL parser. It reads only appended bytes and skips tool output without allocating it. |
| Live registry | `src-tauri/src/registry.rs` | Joins `~/.claude/sessions/<pid>.json` with the process table to name the host app (VS Code, Terminal…). |
| Engine | `src-tauri/src/engine.rs` | Builds `Session` views, works out status, and emits `sessions-delta` with only the changed sessions. |
| Control | `src-tauri/src/control.rs` | Local HTTP hook server (127.0.0.1:47821, `X-CSM-Token` header) and the `settings.json` hook installer. |
| Managed sessions | `src-tauri/src/managed.rs` | Runs `claude -p` in stream-json mode, plus `claude --bg`, opening a terminal, folder or editor. |
| Commands | `src-tauri/src/main.rs` | Tauri commands, tray, notifications, and the debug flags below. |
| Data contract | `src/types.ts` | Mirrors `src-tauri/src/model.rs`. Change both together. |
| Backend bridge | `src/lib/bridge.ts`, `src/lib/mock.ts` | Tauri in the app; the simulator (or `?replay=`) in a browser. |
| Store | `src/lib/store.ts` | zustand: sessions, feed, pulses, control actions with toasts. |
| Shell and control UI | `src/components/` | Top bar, rail, session drawer, composer, approval dock, palette, dialogs. |
| Views | `src/views/<name>/` | Nine views, each self-contained with its own CSS. |
| 3D kit | `src/three/kit.tsx`, `src/three/motion.ts` | Shared stage (tone mapping, bloom, adaptive DPR), labels, easing. |

**Control channels.** These were tested against real `claude -p` sessions.

| Action | Mechanism |
|:---|:---|
| Approve or deny | Hold the `PermissionRequest` hook, then answer with `decision.behavior` |
| Pause | Hold the `PreToolUse` hook until resumed |
| Stop | `{"continue": false}` from the next `PreToolUse` or `PostToolUse` |
| Message at turn end | `Stop` hook returns `{"decision":"block","reason": msg}` |
| Steer now | Deny the next `PreToolUse` with the message as the reason |
| Interrupt a managed session | stream-json `{"type":"control_request","request":{"subtype":"interrupt"}}` |

## 3. macOS work, in priority order

### Must do

1. **The `PATH` seen by the app when launched from Finder.**
   - Apps started from Finder or the Dock get a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`). `claude` is usually in `~/.local/bin`, `/opt/homebrew/bin` or `~/.claude/local`, so `Command::new("claude")` in `managed.rs` will fail.
   - That breaks New session, Resume here, and background sessions. `tauri:dev` won't show the problem, because it inherits your shell.
   - Fix it once at startup: read the login shell's `PATH` (`$SHELL -ilc 'printf %s "$PATH"'`), or use the `fix-path-env` crate, and add the common install directories as a fallback.
   - Same for `code` in `open_editor`. Prefer `open -a "Visual Studio Code" <path>` on macOS.
2. **Compile and smoke-test.**
   - The macOS code paths are in `managed.rs`: `open_terminal` uses `osascript` with Terminal.app, `open_shell` uses `open -a Terminal`, and `open_folder` uses `open`.
   - Running `osascript` against Terminal triggers macOS's Automation prompt ("…wants to control Terminal"). Confirm it appears once and works afterwards.
3. **Name the host apps correctly.** `registry.rs` (`app_label`) maps process names to app names, and the macOS names are untested.
   - Check what `sysinfo` reports as the parent chain for a session in Terminal, iTerm2, Ghostty, Warp, VS Code and Cursor.
   - VS Code's extension host shows up as `Code Helper (Plugin)`, so VS Code sessions currently get their label from the `claude-vscode` entrypoint instead.
   - The quickest check is `./src-tauri/target/debug/claude-session-monitor --dump | jq '.upserts[] | {projectName, host: .process.host, chain: .process.hostChain}'`.
4. **WebKit CSS.**
   - macOS uses WKWebView (Safari's engine), not Chromium. 29 rules use `backdrop-filter` or `mask-image`, and Safari before 18 needs the `-webkit-` prefix for `backdrop-filter`.
   - Set `build.cssTarget` (for example `['safari16']`) in `vite.config.ts` so the build adds prefixes, and check the glass panels, drawer and palette.
   - `color-mix()` needs Safari 16.2 or later.
5. **3D views on Metal.**
   - Check that Office, City and Galaxy all render, not black.
   - On Windows, City was black because a shader `pow()` got a slightly negative base, which became NaN, and bloom spread it across the frame. All bases are now clamped. Keep that rule (see Lessons).
   - Also check frame rate on Retina displays. `Stage` starts at DPR 1.5 and adapts.

### Should do

6. **Open sessions in the right terminal.** `open_terminal` always uses Terminal.app. Use the session's own host (iTerm2 via AppleScript, Ghostty or WezTerm via their CLIs) when the user started it there.
7. **Menu bar icon.** The tray uses the full-colour app icon. On macOS, use a monochrome template icon (`icon_as_template(true)`) so it suits light and dark menu bars.
8. **Shortcut hints.** Shortcuts already accept ⌘ (`metaKey`), but the UI says "Ctrl K" (`src/components/Shell.tsx`). Show ⌘K on macOS.
9. **Notifications.** `tauri-plugin-notification` needs the user's permission on macOS and may not show from an unsigned dev build. Test with a built `.app`.
10. **Window chrome (optional).** `titleBarStyle: "Overlay"` in `tauri.conf.json` gives a native look. The top bar then needs about 80px of left padding for the window buttons.
11. **Distribution.** Builds are unsigned. Public `.dmg` releases need a Developer ID certificate and notarization (`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` in the tauri-action workflow).
12. **CI.**
    - `.github/workflows/build.yml` builds macOS only for tags or a manual run, and pushes to `main` run a build check.
    - Adding `pull_request` to the check job would compile macOS on every PR.
    - Don't start the release workflow manually from a branch: it creates a draft release named after the branch.

## 4. Verifying control on a Mac

These debug flags exist on the app binary (`src-tauri/target/debug/claude-session-monitor`).

| Flag | What it does |
|:---|:---|
| `--dump` | Prints one engine pass as JSON. |
| `--serve [--auto-allow] [--inject "<text>"] [--steer]` | Runs only the hook server and prints events. It prints a `READY … settings=<json>` line. |
| `--managed-test <dir>` | Sends a message, interrupts mid-answer, then sends a second message on the same process. |

Pass the `READY` line's settings JSON to a test session. `--setting-sources project` keeps your own hooks out of the test:

```bash
claude -p --model haiku --setting-sources project --permission-mode default \
  --settings '<json from READY>' "Use the Write tool to create a file named csm.txt containing ok."
```

**Expected results.** These match the Windows runs.

| Test | What you should see |
|:---|:---|
| Approval | `PermissionRequest` → `AUTO-ALLOW` → file written |
| `--inject` | Claude acts on the message when its turn ends |
| `--inject --steer` | Claude acts on the message at the next tool call |
| `--managed-test` | An interrupt `control_response` with `subtype: success`, then a reply to the second message |

`cargo test` covers the `settings.json` installer against a temporary `CLAUDE_CONFIG_DIR`, so your real file is never touched.

**Real data in a browser:**

```bash
./src-tauri/target/debug/claude-session-monitor --dump > public/__replay.json
npm run dev    # open http://localhost:5173/?replay=/__replay.json
```

`public/__replay.json` is gitignored because it contains real transcript text. Delete it when you're done.

## 5. Lessons from the Windows build

- **Clamp every shader `pow()` base to ≥ 0.** Interpolated varyings dip just below zero. GPU drivers return NaN for that, software GL usually doesn't, and bloom turns one NaN pixel into a black frame. Test 3D views on a real GPU, not only in headless or software rendering.
- **CSS is global across views.** A lazily loaded view's stylesheet stays loaded after you leave the view, so two views styling the same class name break each other. That's how Timeline went empty after visiting Command. Prefix classes per view and run `npm run check:css`. Test by visiting every view in one window, not one view per page load.
- **Message delivery.** Text added to a tool result (`PostToolUse` `additionalContext`) is treated by Claude as untrusted tool output and ignored. Use the `Stop` block reason or a `PreToolUse` deny reason, which Claude treats as coming from the user.
- **`settings.json` safety.** The installer backs up the file, keeps key order (`serde_json` `preserve_order`), only removes hooks whose URL contains `/csm/hook/`, and restores the original exactly on uninstall. Keep the round-trip test passing.
- **Transcripts are large.** A busy day can be over 500 MB. The parser decodes typed structs and skips bookkeeping lines before parsing. Keep dev builds optimized (`[profile.dev] opt-level = 3`), or the first scan takes minutes.

## 6. Known limits (not macOS-specific)

- An interactive session sitting idle in another window can't be woken from outside. Messages wait for the next prompt typed there, and the UI says so.
- "Focus that session's window" isn't implemented.
- Smoothness of the 3D views with about 30 live sessions hasn't been profiled.
- Costs are API-equivalent estimates from list prices in `src/lib/pricing.ts`.
