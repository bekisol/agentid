# Group Orchestration Feature — Build Log

This file tracks every change made during the group orchestration system build.
Format: date · file(s) · what changed · why · what it does.

---

## Phase 1 — Backend Foundation

### 2026-05-13 · `llm_client.py` (new)
**What**: Shared LLM utility module — key decryption, owner AI config lookup, unified LLM call.
**Why**: `_decrypt_api_key` and LLM call logic live in `server_pro.py` which can't be imported by new modules (circular). Extracting to a shared module lets `group_orchestrator.py` and future modules call LLMs without duplicating 100 lines of setup code.
**Does**: `decrypt_api_key(stored)` decrypts Fernet-encrypted keys from DB. `get_owner_ai_config(owner)` loads the first enabled AI config for a given account owner. `call_llm(provider, key, model, messages, max_tokens)` makes a unified Anthropic or OpenAI chat call and returns the text response.

### 2026-05-13 · `group_orchestrator.py` (new)
**What**: Core group orchestration engine — plan, dispatch, quality-check, retry/reassign, synthesize.
**Why**: Groups currently have no execution capability. This module is the brain of the group system.
**Does**: 
- `init_group_orchestration_schema()` — creates 5 new DB tables: `group_runs`, `group_run_assignments`, `group_run_events`, `group_shared_context`, `group_agent_performance`.
- `start_group_run(group_id, owner, user_task)` — entry point. Loads group members + capabilities + performance history + team notes. Makes an LLM call to decompose the task. Creates DB records. Dispatches subtasks to agents via existing `_dispatch_task`. Returns `run_id`.
- `on_agent_task_completed(task_id, output, success)` — called when an agent finishes. Quality-checks the output via LLM (0–1 score). If < 0.6: rejects and reassigns (up to 2 retries). If max retries hit: either accepts with low-quality flag or pauses for user clarification. If all assignments done: triggers synthesis.
- `submit_user_clarification(run_id, clarification)` — unpauses a run that asked for user input, re-evaluates failed assignments with new context.
- `_synthesize_run(run_id)` — merges all agent outputs into one final answer via LLM. Generates run summary. Updates performance metrics. Saves to group_memory.
- `_log_event(run_id, event_type, agent_did, data, conn)` — appends to `group_run_events` with full context snapshot.

### 2026-05-13 · `group_runs.py` (new)
**What**: FastAPI router for all group run HTTP endpoints.
**Why**: Exposes orchestration to frontend and external callers.
**Does**: 10 endpoints:
- `POST /pro/groups/{group_id}/runs` — start group run (kicks off `start_group_run` in background thread)
- `GET /pro/groups/{group_id}/runs` — list runs for a group (paginated, newest first)
- `GET /pro/groups/runs/{run_id}` — full run detail: metadata + all assignments + last 200 events
- `GET /pro/groups/runs/{run_id}/stream` — SSE stream; polls DB every second, pushes new events; closes when run reaches terminal state
- `POST /pro/groups/runs/{run_id}/clarify` — submit user clarification to unpause a paused run
- `POST /pro/groups/runs/{run_id}/cancel` — cancel a non-terminal run, marks pending assignments failed
- `GET /pro/groups/{group_id}/performance` — per-agent stats (assigned/completed/rejected + quality score + completion rate)
- `GET /pro/groups/{group_id}/memory` — list active team notes + last 10 run summaries
- `POST /pro/groups/{group_id}/memory` — add a user-created team note
- `DELETE /pro/groups/{group_id}/memory/{mem_id}` — soft-delete a team note
- Static run paths registered BEFORE `/{group_id}/runs` to avoid FastAPI route matching "runs" as a group_id.

### 2026-05-13 · `group_memory.py` (new)
**What**: Team notes + run summaries CRUD module.
**Why**: Persistent memory layer for groups — orchestrator reads these when planning future runs. Separated from the router so the orchestrator can call `save_run_summary` directly after synthesis.
**Does**: 
- `get_group_memory(group_id, owner)` — returns `{team_notes: [...], run_summaries: [...last 10]}`. Notes sorted before summaries; both newest-first.
- `save_run_summary(group_id, owner, group_run_id, summary_text)` — inserts a run_summary record; called automatically by `_synthesize_run`.
- `add_team_note(group_id, owner, created_by, content)` — inserts user-editable team note.
- `update_team_note(mem_id, group_id, owner, content)` — updates note content.
- `delete_team_note(mem_id, group_id, owner)` — soft-deletes (sets `is_active=FALSE`).

### 2026-05-13 · `server_pro.py` (modified)
**What**: Registered new router + schema init + task completion hooks (success + failure).
**Why**: New modules must be wired into the FastAPI app; schema must initialize on startup; orchestrator must receive task completion events.
**Does**: 
- Imports `group_runs_router`, `init_group_orchestration_schema`, `on_agent_task_completed` at module top.
- Calls `init_group_orchestration_schema()` in `@app.on_event("startup")` alongside other schema inits.
- Adds `init_group_orchestration_schema()` to `_run_all_schema_inits()` (admin re-init endpoint).
- Includes `group_runs_router` after `group_chat_router`.
- In task execution success path: calls `on_agent_task_completed(task_id, result_output, success=True)` — orchestrator quality-checks output, continues run.
- In task execution failure path: calls `on_agent_task_completed(task_id, {"error": ...}, success=False)` — orchestrator handles failure/retry.

---

## Phase 2 — Messages Integration

### 2026-05-13 · `docs/messages.html` (modified)
**What**: Added Teams channel — full orchestration thread view with live SSE rendering.
**Why**: Users need a way to send tasks to groups and watch agents work in real time from the messages page.
**Does**:
- **CSS** — 25+ new rules for: run status badges (planning/running/synthesizing/completed/failed/paused), orchestration card types (user-task, plan, agent-assigned/completed/rejected, synthesis, final-answer, clarification), animated planning pulse dots, Teams task input bar, clarification answer bar.
- **"Teams ⚡" channel button** — added to channels section in sidebar; shows agent count badge.
- **Task input bar** (`#teams-task-bar`) — shown when a team is selected; Ctrl/Cmd+Enter to submit; calls `POST /pro/groups/{id}/runs`.
- **Clarification bar** (`#clarify-bar`) — appears when a run pauses for user input; shows orchestrator's question; calls `POST /pro/groups/runs/{id}/clarify` or cancels the run.
- **`showTeamsListView()`** — channel click handler; sets state, clears other views, loads agent groups.
- **`_loadAgentGroups()`** — `GET /pro/groups` fire-and-forget; called from `loadAll()` on boot and on channel open.
- **`_renderTeamsInThreadPanel()`** — renders agent groups in sidebar thread panel.
- **`showTeamGroupView(groupId)`** — opens a group's run list; fetches `GET /pro/groups/{id}/runs`.
- **`openRunThread(runId, groupId)`** — loads full run detail, replays past events, then opens SSE stream for live updates.
- **`_openTeamRunSSE(runId)`** — uses `fetch` + `ReadableStream` (not `EventSource`) so the `x-api-key` header can be sent; parses `data: {...}` chunks, handles stream_end.
- **`_handleRunEvent(ev, isReplay)`** — dispatches all 10 event types to typed card renderers: `orchestrator_plan` (subtask list), `agent_assigned`, `agent_completed` (with quality bar), `orchestrator_rejected`, `agent_reassigned`, `clarification_requested`, `clarification_received`, `synthesis_started`, `synthesis_completed`/`run_completed` (final answer card), `run_failed`, `run_cancelled`.
- **`_clearChannelActive()`** — extended to reset `_teamsListView` and close SSE stream when user navigates away.
- **`_loadAgentGroups()` wired into `loadAll()`** — groups badge and list update every 30s refresh.

## Phase 3 — Dashboard Tracking

### 2026-05-13 · `docs/dashboard.html` (modified)
**What**: Added "Group Runs" card and slide-in drilldown panel.
**Why**: Users need visibility into orchestration run history without leaving the dashboard.
**Does**:
- `#group-runs-card` — new card section with "↻ Refresh" button; sits below Agent Groups card.
- `#group-runs-list` — populated by `loadGroupRuns()`; shows table of recent runs across all groups (team name, task preview, status badge, started timestamp, duration).
- `#group-run-drilldown` — fixed overlay panel slides in from right on row click; shows: final answer block (green), assignments table (agent / subtask / status / quality score / retries), event timeline (colour-coded dots by event type), all-runs performance table per agent (assigned / done / rejected / avg quality).

### 2026-05-13 · `docs/dashboard.js` (modified)
**What**: `loadGroupRuns()`, `openRunDrilldown()`, `_closeRunDrilldown()`, `_runStatusBadge()`.
**Why**: Wire the new dashboard card to the group runs API.
**Does**:
- `loadGroupRuns()` — fetches `GET /pro/groups?limit=50`, then parallel-fetches `GET /pro/groups/{id}/runs?limit=5` for each group, merges and sorts newest-first, renders table with click-to-drilldown rows. Called on page load and on refresh button click.
- `openRunDrilldown(runId, groupId)` — fetches `GET /pro/groups/runs/{run_id}` (full detail + assignments + events) and `GET /pro/groups/{id}/performance` in sequence; renders all three panels inside the drilldown panel. Click outside or ✕ closes it.
- `_runStatusBadge(status)` — returns coloured pill HTML for all 7 run statuses.
- Status colour map: planning=purple, running=blue, synthesizing=amber, completed=green, failed=red, cancelled=grey, paused_for_user=orange.

## Phase 4 — Team Memory UI

### 2026-05-13 · `docs/messages.html` (modified)
**What**: Team Memory slide-in panel with editable notes and auto run summaries.
**Why**: The orchestrator reads team notes when planning — users need a way to add/remove them without leaving the messages view. Run summaries give a quick "what happened last time" reference.
**Does**:
- `#team-memory-panel` — 280px panel that slides in from the right alongside the group command panel; hidden at width:0 by default; transition on open/close.
- **Team Notes section** — lists all active notes (content + author + relative time); each note has a ✕ delete button that calls `DELETE /pro/groups/{id}/memory/{mem_id}`. "+ Note" button reveals inline textarea form; save calls `POST /pro/groups/{id}/memory`; Ctrl/Cmd+Enter shortcut.
- **Run Summaries section** — lists last 10 auto-generated summaries (orchestrator-written after each completed run); read-only; shows relative timestamp.
- `_toggleMemoryPanel()` / `_openMemoryPanel()` / `_closeMemoryPanel()` — width toggle with CSS transition.
- `_loadTeamMemory(groupId)` — `GET /pro/groups/{id}/memory`; populates both sections.
- `_renderTeamNotes(groupId, notes)` — renders note cards with delete handlers wired via event listeners.
- `_renderTeamSummaries(summaries)` — renders read-only summary cards.
- **"📋 Memory" button** added to team header actions (alongside "↻ Runs"); toggles panel.
- All note form buttons and panel close wired in DOMContentLoaded (no inline onclick).
