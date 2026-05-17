"""
AgentID Documentation Generator
Generates all technical PDFs into /Users/bereket/Documents/AgentID_Docs/
Run: python3 generate_docs.py

Changelog
---------
v0.5.0  2026-05-06  MCP bridge (MCPSession + MCPProxyTool), multi-provider layer
                    (AnthropicProvider, OpenAIProvider, GeminiProvider), agentic
                    ReAct judgment loop (8 rounds), WebSearchTool, FetchURLTool,
                    AgentBrain orchestrator, OnChangeTrigger, MCPSession tests.
v0.4.0  2026-04-xx  AgentBrain core — Perception, Judgment, Actions, BrainMemory,
                    IntervalTrigger, DailyTrigger, GitPerception, FilePerception,
                    APIPerception.
v0.3.0  2026-03-xx  Runtime SDK — AgentRuntime long-polling, WebhookTransport,
                    CLI (agentid-runtime).
v0.2.0  2026-02-xx  Auto-reply multi-provider — Anthropic + OpenAI + MCP sampling
                    (Claude Desktop as reply brain).
v0.1.0  2026-01-xx  Initial scaffold — server, auth, messaging, MCP server,
                    agent registration.
"""

from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, PageBreak, KeepTogether
)
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT
from datetime import datetime
import os

OUT = "/Users/bereket/Documents/AgentID_Docs"
NOW = datetime.now()
DATE = NOW.strftime("%B %Y")          # e.g. "May 2026"
GENERATED = NOW.strftime("%Y-%m-%d %H:%M")   # e.g. "2026-05-06 14:32"

# ── Version changelog (newest first) ──────────────────────────────────────────
CHANGELOG = [
    ("v1.7.0", "2026-05-17",
     "Security: Per-API-key rate limiting (5 changes). "
     "1. auth.py: key_hash now returned in get_key_info() dict (was computed internally but not exposed). "
     "_rate_limit_hook module-level callable (None by default); require_api_key() calls it after key "
     "resolution — on 429, raises HTTPException with Retry-After:60 header. "
     "Session-cookie callers (no key_hash) skip rate limiting. "
     "2. server_pro.py: startup wires auth._rate_limit_hook = ratelimits.check_rate_limit after "
     "init_ratelimits_schema(). Hook pattern avoids circular import (auth→ratelimits is safe; "
     "ratelimits must not import auth). Graceful: ImportError does not crash startup. "
     "3. rate_limit.py: _get_rate_limit_key() replaces get_remote_address as slowapi key function. "
     "Extracts raw API key from x-api-key / X-Api-Key / Authorization:Bearer, hashes it "
     "(sha256 hex[:16] with 'key:' prefix), falls back to IP for unauthed requests. "
     "Each tenant now gets its own bucket regardless of shared IPs. "
     "4. group_runs.py: SSE stream endpoint gains @limiter.limit('10/minute') — was the only "
     "endpoint without a rate limit (open DoS vector). "
     "5. db.py: ThreadedConnectionPool size now configurable via DB_POOL_MIN/DB_POOL_MAX env vars "
     "(default 3/20). idle_in_transaction_session_timeout='30s' set on every connection checkout — "
     "prevents hung background threads from holding pool slots indefinitely. "
     "Tests: 46/46 passing. "
     "Files: agentid-pro/auth.py, agentid-pro/server_pro.py, agentid-pro/rate_limit.py, "
     "agentid-pro/group_runs.py, agentid-pro/db.py."),
    ("v1.6.5", "2026-05-17",
     "Refactor: route review_queue insertions through enqueue_sync() shared helper. "
     "review_queue.py: enqueue_sync(owner, agent_did, operation, payload_summary, risk_level, "
     "reason, source, expires_hours, agent_name) — same INSERT logic as the enqueue() HTTP "
     "endpoint, callable from background threads without a Request object. Returns review_id. "
     "group_orchestrator.py: direct INSERT INTO review_queue in _run_policy_gate() replaced "
     "with review_queue.enqueue_sync(..., source=SOURCE_ORCHESTRATOR). "
     "Orchestrator now contains zero direct review_queue SQL. "
     "All four control-plane modules (policy, budget, delegation, review_queue) fully routed "
     "through shared helpers. 46/46 tests passing."),
    ("v1.6.4", "2026-05-17",
     "Refactor: full control-plane module delegation — no duplicated logic in orchestrator. "
     "budget.py: record_spend_sync() + cancel_budget_sync() extracted from async HTTP endpoints "
     "(full risk-cap enforcement, exhausted/warning webhooks, sync-callable from threads). "
     "delegation.py: check_delegation_for_capability() public sync function (queries "
     "delegation_tokens, returns {has_any,has_valid,count,reason}, never raises). "
     "group_orchestrator.py: _check_delegation_tokens/record_spend/cancel_hold wrappers now "
     "delegate to shared modules — no bespoke SQL; _set_run_status cancel is one-liner via "
     "wrapper; review_queue INSERT uses SOURCE_ORCHESTRATOR constant; file header fixed "
     "(no longer claims dispatch via _dispatch_task). "
     "review_queue.py: SOURCE_ORCHESTRATOR constant + MERGED DESIGN docstring entry. "
     "Tests: 46/46. test_control_plane_wiring.py mocks at shared-module boundaries. "
     "Files: budget.py, delegation.py, group_orchestrator.py, review_queue.py, "
     "tests/test_control_plane_wiring.py."),
    ("v1.6.3", "2026-05-17",
     "Complete control-plane wiring — budget lifecycle + delegation verification. "
     "Budget cancel: _set_run_status() fires UPDATE budget_holds SET status='cancelled' for "
     "completed/failed/cancelled runs; no-op when no hold exists. "
     "Budget spend: _budget_record_spend_direct() writes to budget_spends and increments hold "
     "spent counter after each accepted subtask (_SUBTASK_ESTIMATED_SPEND=0.01); no-op when "
     "no hold exists so budget enforcement is fully opt-in. "
     "Delegation verification: _check_delegation_tokens() queries delegation_tokens for "
     "non-expired non-revoked tokens covering (agent_did, owner, capability). Integrated into "
     "_run_policy_gate(): require_verifier + no valid token → deny; require_verifier + valid "
     "token → allow; tokens exist but all expired/revoked → warn only; no tokens → pass "
     "(owner-direct). "
     "Tests: 9 new tests in test_control_plane_wiring.py. Total: 48/48 passing. "
     "Files: agentid-pro/group_orchestrator.py, agentid-pro/tests/test_control_plane_wiring.py."),
    ("v1.6.2", "2026-05-17",
     "P1/P2 remediation (Codex audit findings). "
     "P1a: required_capability and resolved_permission_level added to both SELECT lists in "
     "GET /pro/groups/runs/{run_id} and the report endpoint — workspace was falling back to "
     "'general'/'contribute' even when richer data was stored. "
     "P1b: _run_policy_gate() wires the full unified policy engine (identity, capability "
     "contract, scope, budget, trust, ACP, region) into the group dispatch loop. Called after "
     "profile resolution, before _execute_subtask. Deny → assignment failed + policy_denied "
     "event. require_approval → review_queue row inserted directly (no HTTP round-trip), "
     "assignment failed. All policy errors degrade gracefully. "
     "P2: workspace team-workspace.html now shows 'suit. X%' suitability chip in plan-row meta "
     "and output-item pill-row; falls back gracefully when value is null. "
     "P3 (deferred): stale parallel copies under mock-docs/ flagged for cleanup. "
     "tests/test_group_orchestrator_xalgo.py (5 tests) now tracked in git. "
     "Files: agentid-pro/group_orchestrator.py, agentid-pro/group_runs.py, "
     "agentid-pro/tests/test_group_orchestrator_xalgo.py, agentid/docs/team-workspace.html."),
    ("v1.6.1", "2026-05-17",
     "Fix: expose candidate_score in run-detail and report endpoints. "
     "candidate_score was stored on every group_run_assignments row by the X-algo scorer "
     "but the GET /pro/groups/runs/{run_id} and GET /pro/groups/runs/{run_id}/report endpoints "
     "did not SELECT it. Added column to both SELECT lists and response dicts. "
     "Files: agentid-pro/group_runs.py."),
    ("v1.6.0", "2026-05-16",
     "X-Algorithm Phase 4 — Two-Tower Semantic Retrieval. "
     "NEW FILE: capability_embeddings.py. "
     "TWO-STEP PIPELINE: Step 1 = cheap LLM intent extraction (gpt-4o-mini / ANTHROPIC_DEFAULT, "
     "max_tokens=150) extracts required capability slugs from task; falls back to raw task text. "
     "Step 2 = each intent embedded with text-embedding-3-small, queried against "
     "agent_capability_embeddings via cosine similarity; per-agent score = max sim across intents. "
     "Members sorted by score; top TOP_K_SEMANTIC=20 sent to LLM planner. "
     "Planning prompt gains semantic_fit:X% per member. "
     "SCHEMA: agent_capability_embeddings(agent_did, capability, embedding vector(1536), model, "
     "updated_at) PRIMARY KEY (agent_did, capability). HNSW index. "
     "capability_profiles gains description TEXT column (embedding source; raw slug fallback). "
     "INDEXING: capability_profiles POST/PATCH with description → daemon thread calls "
     "reindex_capability_for_all_agents(). quick_register_agent → per-capability background tasks. "
     "GRACEFUL DEGRADATION: SEMANTIC_ROUTING_ENABLED=False when pgvector unavailable or "
     "OPENAI_API_KEY unset; {} returned on any error so all members pass through unchanged. "
     "TESTS: TestSemanticRetrieval (10 tests) — disabled flag, intent parsing/fallbacks, "
     "max-similarity aggregation, empty embeddings, DB error isolation, raw-task fallback. "
     "Total test count: 34/34 passing. "
     "Files: capability_embeddings.py (new), capability_profiles.py, group_orchestrator.py, "
     "server_pro.py, tests/test_xalgo_pipeline.py."),
    ("v1.5.0", "2026-05-16",
     "X-Algorithm Adaptations (Phases 1-3) + RLS + Tight Test Suite. "
     "DATABASE RLS: rls_migration.py applies ENABLE/FORCE ROW LEVEL SECURITY + per-owner "
     "policy to 65+ tables. Policy: current_setting('app.current_owner',true)='' OR "
     "owner=current_setting('app.current_owner',true). Child tables (group_run_assignments, "
     "group_run_events, group_shared_context) use subquery via group_run_id FK. "
     "db.py: ContextVar _rls_owner + set_rls_owner(); get_conn() injects SET app.current_owner "
     "on checkout, RESET before pool return. auth.py: require_api_key() calls set_rls_owner(). "
     "X-ALGO PHASE 1 (Pre-filter / Post-plan trust gate): _filter_eligible_candidates() filters "
     "members by trust threshold for high-risk hint. _enforce_plan_trust_gate() is a pure function "
     "that enforces the trust gate post-LLM — replaces any high-risk assignment to a below-threshold "
     "agent with the highest-suitability qualifying agent; falls back to highest-trust if none qualify. "
     "Logs orchestrator_plan_corrected event with full corrections list. "
     "X-ALGO PHASE 2 (Weighted scorer): _compute_candidate_score() produces [0,1] composite from "
     "quality(0.35) + completion_rate(0.25) + trust/100(0.25) - rejection_rate(0.15). "
     "Planning prompt shows suitability:X/100 instead of raw numbers. _get_best_alternative_agent() "
     "ranks by composite score; applies trust gate on high-risk retries. candidate_score column "
     "stored per assignment. _handle_failed_output() reads risk_level from assignment and passes "
     "to _get_best_alternative_agent(). "
     "X-ALGO PHASE 3 (Quality rubric): _process_completion() loads capability profile; injects "
     "quality_rubric into scoring prompt when present; zero regression when no profile exists. "
     "TIGHT TESTS: tests/test_xalgo_pipeline.py — 24 tests, 5 classes: "
     "TestHighRiskPlanCorrection (6), TestHighRiskFallbackPath (3), TestRetryTrustEnforcement (3), "
     "TestCandidateScoreSanity (6), TestMediumRiskRegression (6). All 24 pass. "
     "Files: agentid-pro/rls_migration.py (new), agentid-pro/db.py, agentid-pro/auth.py, "
     "agentid-pro/group_orchestrator.py, agentid-pro/tests/test_xalgo_pipeline.py (new)."),
    ("v1.4.0", "2026-05-13",
     "Phase 3 — Enterprise Agent Operations. "
     "Goal: observable, controlled, auditable team runs for enterprise users. "
     "PLAN APPROVAL GATE: group_settings table (require_plan_approval BOOLEAN, "
     "high_risk_trust_threshold INT, max_retries_per_slot INT, synthesis_model TEXT). "
     "_get_group_settings() helper reads per-group config. _orchestrate() checks "
     "require_plan_approval after planning: if true, sets status='paused_for_approval', "
     "logs approval_requested event with full plan summary (agent_did, subtask, risk_level, "
     "rationale per slot), and returns without dispatching. _dispatch_pending_assignments() "
     "dispatches all pending assignments for an approved run. approve_group_run_plan() sets "
     "status back to 'running' and calls _dispatch_pending_assignments(). "
     "POST /pro/groups/runs/{run_id}/approve-plan endpoint requires owner auth. "
     "GET/PATCH /pro/groups/{group_id}/settings endpoints for reading and updating group config. "
     "EXPORTABLE RUN REPORT: GET /pro/groups/runs/{run_id}/report returns full markdown "
     "with owner auth. Report includes: run header (status, task, date, duration), "
     "per-agent contribution sections with subtask, risk, trust score, quality, output (decrypted), "
     "rejection/retry notes, and orchestrator rationale; full event timeline table (type, agent, "
     "timestamp, detail); and run summary (decrypted). Content-Disposition: attachment header "
     "triggers browser download as agentid_run_{id}.md. "
     "CROSS-RUN ANALYTICS: GET /pro/groups/{group_id}/analytics endpoint aggregates across "
     "all completed/failed runs: total runs, completion rate, avg duration, avg quality, "
     "clarification rate; acceptance/rejection rate, risk distribution (low/medium/high counts), "
     "trust-influenced routing count; per-agent breakdown (assigned, completed, rejected, "
     "avg quality, avg trust). Dashboard shows 5-stat grid at top of drilldown panel + link to "
     "download run report as .md. "
     "FRONTEND: approval_requested event renders plan summary with risk badges and Approve button "
     "in #approval-bar (blue sticky bar); Approve calls _teamsApprovePlan(); approval_granted clears "
     "bar; run_completed card gains '📄 Download Report (.md)' anchor. "
     "Files: agentid-pro/group_orchestrator.py, agentid-pro/group_runs.py, "
     "agentid/docs/messages.html, agentid/docs/dashboard.js."),
    ("v1.3.0", "2026-05-13",
     "Phase 2 — Trust-Aware Coordination. "
     "Goal: trust scores reach the orchestrator and shape runtime routing decisions. "
     "TRUST IN PLANNING: _fetch_trust_info() lazy-imports get_trust_score() per member. "
     "Planning prompt now includes trust score (0-100) and level (low/moderate/good/excellent) "
     "per agent so the LLM orchestrator can route subtasks to the most trustworthy agent. "
     "RISK LEVELS: plan JSON format expanded with risk_level (low/medium/high) and rationale. "
     "High-risk subtasks require agent trust ≥ 70; orchestrator instructed to note when no "
     "qualifying agent is available. "
     "ATTRIBUTION: group_run_assignments gains rationale, risk_level, trust_score_at_assignment "
     "columns (idempotent ALTER TABLE IF NOT EXISTS). All three saved per assignment. "
     "agent_assigned event carries rationale, risk_level, trust_score, trust_level. "
     "VISIBLE REASONING (messages.html): agent_assigned card shows risk badge, trust score/level, "
     "and orchestrator rationale; orchestrator_plan card shows risk badge per subtask. "
     "DASHBOARD DRILLDOWN: assignments table adds Risk and Trust columns; rationale shown as "
     "italic sub-row beneath each assignment row. "
     "Files: agentid-pro/group_orchestrator.py, agentid-pro/group_runs.py, "
     "agentid/docs/messages.html, agentid/docs/dashboard.js."),
    ("v1.2.0", "2026-05-13",
     "Phase 1 Hardening — Trusted Team Runs. "
     "Goal: a customer can complete one end-to-end team run and understand what happened "
     "without reading server logs. "
     "CLARIFICATION PROPAGATION: _execute_subtask() now accepts clarification param; "
     "user's guidance injected into retrying agent's prompt between subtask and context. "
     "_handle_failed_output() queries user_clarification from run row and passes it through. "
     "submit_user_clarification() passes clarification directly to _execute_subtask(). "
     "LEASE/HEARTBEAT ORPHAN RECOVERY: active runs write updated_at = NOW() every 30s via "
     "daemon thread. Background sweeper (60s interval, singleton guard) marks runs with "
     "updated_at < NOW() - INTERVAL '10 minutes' as failed — safe across Railway deploys "
     "(new container waits 60s before first check, old container's runs are either done or "
     "truly stopped). "
     "SSE HEARTBEAT: emit ': heartbeat' SSE comment every 15s of no events — keeps TCP "
     "connection alive through browsers and Railway proxies during long LLM calls (up to 150s). "
     "No frontend change needed (browsers ignore SSE comment lines). "
     "SSE CURSOR/RESUME: ?since_id= query param on stream endpoint; poll query starts at "
     "id > since_id; frontend tracks _teamRunLastEventId, passes cursor on open. "
     "Auto-reconnect after 2s on drop if run is non-terminal — no event gap, no out-of-order replay. "
     "'Connecting...' state shown when no events exist yet. "
     "SYNTHESIS CANCEL GUARD: cancel_group_run() raises 409 when status=synthesizing — "
     "prevents race that could corrupt final_output. "
     "EVENT HISTORY: LIMIT 200 → 1000 in GET /pro/groups/runs/{run_id} (~200–500KB, acceptable). "
     "ACTIVE RUN RECOVERY: _selectTeam() checks for exactly one non-terminal run; if found, "
     "auto-opens run thread (transparent page-reload recovery). Stays on runs list if ambiguous. "
     "Files: agentid-pro/group_orchestrator.py, agentid-pro/group_runs.py, agentid/docs/messages.html."),
    ("v1.1.0", "2026-05-13",
     "At-rest content encryption for all customer data fields. "
     "NEW MODULE content_crypto.py: per-owner envelope encryption using HKDF-SHA256 "
     "(master key → per-owner derived key) + Fernet (AES-128-CBC + HMAC-SHA256). "
     "Storage format: 'enc:v1:<fernet_token>' with backward-compat plaintext passthrough. "
     "Master key: AGENTID_KEY_ENCRYPTION_KEY env var (already set in production). "
     "Key derivation: HKDF(master, info=b'agentid-content:<owner>') — blast radius bounded "
     "per owner. LRU-cached Fernet instances (maxsize=2048) for zero overhead after first "
     "call per owner. Fail-open design: enc() returns plaintext on error so data is never lost. "
     "ENCRYPTED FIELDS: agent_messages.body, agent_tasks.context (JSONB), "
     "task_delegations.result (JSONB), agent_brain_notes.value, "
     "agent_thread_summaries.summary + key_facts (JSONB), group_memory.content, "
     "group_shared_context.context_value (JSONB), group_runs.user_task + final_output + "
     "run_summary + pause_question + user_clarification. "
     "NOT ENCRYPTED (operational metadata): IDs, timestamps, owner, status, agent_did, "
     "trust scores, message subject, task description, orchestrator_plan, audit_log.*. "
     "JSONB COLUMNS: encrypted string wrapped in json.dumps() for valid JSON string literal; "
     "read path handles both dict (legacy) and string (encrypted) via isinstance guard. "
     "MIGRATION: migrate_encrypt_content.py — idempotent (skips rows with enc:v1: prefix), "
     "deadlock-aware batches (100 rows, 50ms sleep, 5x exponential retry), "
     "1928 rows encrypted across 11 columns in production in one run. "
     "Files: agentid-pro/content_crypto.py (new), agentid-pro/migrate_encrypt_content.py (new), "
     "agentid-pro/server_pro.py (all write/read sites), agentid-pro/group_orchestrator.py."),
    ("v1.0.1", "2026-05-11",
     "Dashboard + Messages UX rework. "
     "dashboard.html: sidebar reorganised into labeled groups — Activity (Messages, Tasks, Approvals), "
     "Agents (My Agents, Contracts, Network), Insights (Analytics, Audit Log, Signing), Tools (API Playground); "
     "Settings pinned at bottom (always accessible, no scrolling required); "
     "Approvals promoted to 3rd position in Activity group (was 7th in flat list). "
     "messages.html: horizontal conversation filter chips replaced with a proper Conversations "
     "sub-panel in the sidebar — shown automatically when an agent is selected, lists each "
     "conversation partner with unread badge, message count, and last-message preview; "
     "partners sorted by unread count then volume; 'All threads' item at top to reset filter; "
     "sidebar width 208→220px to accommodate partner names; topbar nav updated with "
     "'← Dashboard' back link, bold current-page highlight, Tasks link for loop navigation."),
    ("v1.0.0", "2026-05-11",
     "OpenClaw Execution Bias integration — 6 blocks to eliminate 'I have a plan, can I go ahead?' "
     "agent behaviour. "
     "BLOCK 0: ACP gap fixed in _brain_send_reply() (bypassed approval gate); "
     "Execution Bias prompt rewrite (act now, no hedge); ask_clarification forced to reply on task_notification. "
     "BLOCK 2: agent_clarification_log table; rate limit max 2 asks/hr per (agent, partner); "
     "fallback to best-effort reply when over limit; questions[:1] enforced. "
     "BLOCK 3: Decision trace — brain_cycle trajectory expanded with decisions[], cycle_ms, provider. "
     "BLOCK 4: agent_bootstrap table (SOUL/MISSION/STYLE/TOOLS slots, 4096B cap); "
     "get_bootstrap_prefix() injected at top of system_prompt; 4 CRUD endpoints. "
     "BLOCK 5: agent_missions table (every:Ns/m/h/d schedule); fire_due_missions() SELECT FOR UPDATE "
     "SKIP LOCKED (race-safe); mission_tick brain handling (no ask_clarification, no ignore, retryable); "
     "5 CRUD endpoints + manual fire. "
     "BLOCK 6: flow_id TEXT column on agent_messages/acp_approval_queue/agent_task_requests/"
     "capability_call_logs; brain propagates flow_id per message; _brain_execute_task stamps flow_id "
     "on task row; GET /pro/flows/{flow_id} reconstruction endpoint with pre-query ownership check."),
    ("v0.9.0", "2026-05-11",
     "Phase 0 — 8 bug fixes + Phase 1–5 new features (Trajectory, Dreaming, Task Flow Registry, "
     "Commitments, ACP Action Approvals). "
     "BUG FIXES: B1=capability_contracts row slice fixed (row[:20]→[:22], agent_name was returning "
     "challenge_mode field); B2=trust_score datetime vs string (psycopg2 returns datetime objects, "
     "not strings — isinstance guard added); B3=_SCORE_CACHE unbounded memory leak fixed with "
     "_cache_get/_cache_set helpers, eviction at 2000 entries; B4=queue depth check made atomic with "
     "INSERT via CTE+FOR UPDATE (race condition closed); B5=POLP reversed prefix condition removed "
     "(s.startswith(capability+'-') allowed narrower-scope callers to invoke broader capabilities); "
     "B6=total_score now derived from weighted D1-D5 dimension scores (0.20+0.25+0.20+0.20+0.15) "
     "instead of raw signals with inconsistent max values; B7=all conn.rollback() calls in "
     "_compute_trust_score replaced with named SAVEPOINTs so partial failures don't abort the whole "
     "transaction; B8=unconditional 6s retry in _notify_task_via_message now checks task status "
     "before firing (_get_task, only retries if still pending). "
     "TRAJECTORY (trajectory.py): trajectory_events table + indexes; record_trajectory() helper "
     "records message_sent/task_received/task_completed/task_failed/scope_violation events; "
     "_record_traj() shorthand in server_pro.py; GET /pro/agents/{did}/trajectory (paginated, "
     "filterable by action_type/outcome/peer_did/session_id); "
     "GET /pro/agents/{did}/trajectory/summary (per-action-type counts); "
     "GET /pro/agents/{did}/trajectory/export (NDJSON download, EU AI Act Article 12). "
     "DREAMING (dreaming.py): run_dreaming_cycle() groups thread summaries into recent/mid/old "
     "buckets; old entries (30+ days, ≥2 partners) compressed into single row via LLM; "
     "consolidated row keyed partner_did='__dreaming_consolidated__' with _consolidated metadata; "
     "runs every 6h in scheduler; POST /internal/dreaming/run; "
     "GET /pro/agents/{did}/dream-status. "
     "TASK FLOW REGISTRY (task_workflows.py): workflow_definitions + workflow_runs + "
     "workflow_run_tasks tables; advance_run() called automatically on task completion/failure; "
     "input_map uses JSONPath-style $.step_index.field expressions; "
     "POST /pro/workflows (create); GET/PATCH/DELETE /pro/workflows/{id}; "
     "POST /pro/workflows/{id}/runs (start); GET /pro/workflows/{id}/runs; "
     "GET /pro/workflows/runs/{run_id}; POST runs/{id}/advance + cancel. "
     "COMMITMENTS (commitments.py): agent_commitments table; extract_commitments_from_text() "
     "heuristic extraction on outbound messages (no LLM needed); save_commitments() async "
     "background save; sweep_broken_commitments() runs every 30min, applies -2.0 D3 penalty per "
     "broken commitment; fulfill_commitment_by_task() auto-fulfills on task completion; "
     "+0.5 D4 bonus on fulfillment; POST/GET /pro/agents/{did}/commitments; "
     "PATCH .../fulfill + cancel; GET .../summary. "
     "ACP ACTION APPROVALS (action_approvals.py): acp_policies + acp_approval_queue tables; "
     "check_action_policy() returns {proceed:False, approval_id, reason} when a policy matches; "
     "message_broadcast policy checked on every send_message call; owner notified via agent_messages; "
     "sweep_expired_approvals() runs every 30min; POST /pro/agents/{did}/acp-policies; "
     "GET/PATCH/DELETE policies; GET /pro/agents/{did}/approvals; "
     "POST /pro/approvals/{id}/approve + reject."),
    ("v0.8.3", "2026-05-11",
     "Network page trust dimension fix — eliminated '??' and cross-page inconsistency. "
     "Root causes: (1) network.js fetched /agents/{did}/trust-score without ?detailed=true so "
     "dimensions were absent in every response; (2) cache stored dimensions=null but re-fetch guard "
     "checked ===undefined (never matched null) so retry never fired; (3) N individual API calls at "
     "boot (one per agent) instead of one bulk call. "
     "Fixes: prefetch loop replaced with single /pro/trust-scores call (all owned agents, "
     "dimensions included, one round-trip); panel-open re-fetch now uses ?detailed=true for external "
     "agents and /pro/agents/{did}/trust-score for owned agents; guard changed to ==null plus "
     "_detailFetched flag to prevent re-fetch loops; node colors re-drawn after bulk load returns."),
    ("v0.8.2", "2026-05-10",
     "Tasks UI — contract-first agent discovery. "
     "tasks.html: replaced manual 'To Agent DID' text input + hidden discover panel with a unified "
     "capability contract search flow. "
     "Users now type a capability keyword (e.g. web_search, summarize) → results come from "
     "GET /capability-contracts/search?capability=X (public, no auth needed) which returns agents with "
     "verified/challenge_passed contracts sorted by status → click Select → agent chip auto-fills DID + "
     "capability + SLA/pricing from the contract. "
     "Trust scores loaded async per agent (GET /agents/{did}/trust-score) and shown inline in results. "
     "If contract has input_schema, task-inputs textarea pre-populated with required fields and schema "
     "field hints shown below. "
     "On Send, capability comes from selected contract (not a manual field). "
     "Fallback: if no results with status filter, retries without it to show challenge_passed/pending agents. "
     "No more manual DID entry anywhere in the send flow."),
    ("v0.8.1", "2026-05-09",
     "Codex security review — 4 findings fixed. "
     "P3/multibase: identity.py public_key_to_multibase() added (z + base58btc + varint 0xED01); "
     "Agent.create() now emits correct publicKeyMultibase; Agent.load() corrects legacy base64 values on read; "
     "did_document.py detects non-z-prefix values in stored_vms and re-derives from authoritative public_key; "
     "register_agent() INSERT now populates verification_methods column with correct multibase on every new registration. "
     "P2/status drift: eu_compliance.py lines 274/408/477 updated from status='active' (non-existent) to "
     "status IN ('challenge_passed','pending_verification','verified'); "
     "server_pro.py MCP tool _chat_search_contracts: status enum updated, default changed 'active'→'verified', "
     "legacy 'active' alias maps to all published statuses; capability_type→capability column fix in SQL queries "
     "and tool schemas; backward-compat kwarg aliases on _chat_get_contract/_chat_log_capability_call/_chat_submit_attestation. "
     "P1/federation: federation.py PeerRequest.public_key made required (was Optional); "
     "add_peer validates key is 32-byte Ed25519 before storing; "
     "_verify_peer_response() new helper performs Ed25519 sig verification; "
     "_fetch_from_peer now REQUIRES signature — unsigned responses rejected (not passed through). "
     "P1/encryption: server_pro.py _encrypt_api_key()/_decrypt_api_key() using Fernet (AES-128-CBC+HMAC) "
     "with 'fernet:' prefix sentinel for backward compat; "
     "AGENTID_KEY_ENCRYPTION_KEY env var; all 6 write paths encrypt on save; all 6 read paths decrypt before use; "
     "existing plaintext records read correctly without key rotation event."),
    ("v0.8.0", "2026-05-09",
     "Week 1 implementation — security hardening, crypto-agility, canonical SDK API, mcp-agentid wedge. "
     "SECURITY (Block 1): crypto-agility envelope on all sign() functions (algSuite/version/params/signature dict); "
     "TypeScript timestamp fix (Date.now() → Math.floor/1000); signer field standardised to 'signer' across Python/TS/Go/internal SDKs; "
     "path traversal fix in registry._key_path() (re.sub sanitisation + containment assertion); "
     "nonce+issued_at added to capability contract signed body; "
     "internal agentid-pro Node/Python SDKs updated with envelope + signer field. "
     "MULTI-KEY DID (Block 2): AgentDocument.verification_methods list[] per W3C DID Core; "
     "did_document.py accepts list[public_keys] and emits multiple verificationMethod entries; "
     "DB migration adds verification_methods JSONB column + GIN index. "
     "CANONICAL API (Block 3): public_api.py adds 5 missing symbols: Receipt (signed result envelope), "
     "TrustScore (typed trust response with .fetch()), RemoteAgent (read-only discovered agent handle), "
     "signed() (decorator factory), verify() (top-level shorthand with trust_min + max_age_seconds), "
     "find() (capability discovery with trust filter), attest() (peer attestation); "
     "__init__.py rewritten to export exactly 8 symbols: Agent, signed, verify, find, attest, RemoteAgent, Receipt, TrustScore. "
     "TEACHING ERRORS (Block 4): http_registry.py _raise_with_context() wraps all raise_for_status() calls with URL, "
     "operation, and actionable remediation hints; 409 conflict raises ValueError with load() guidance; "
     "agent.py missing-key messages include Agent.load() and Agent.create() instructions. "
     "TRUST SCORE API (Block 5): public_trust_score() accepts ?detailed=true; default response includes "
     "score/level/top_3_issues/trust_brief; _compute_top_3_issues() scans breakdown for biggest penalty gaps "
     "across D1-D5, sorts by impact, returns top 3 as human-readable strings with D-dimension labels. "
     "CI (Block 6): agentid/.github/workflows/ci.yml runs pytest on push/PR; 16 tests in test_cross_sdk.py cover "
     "envelope format, timestamp seconds, path traversal containment, 8-symbol API, backward-compat bare strings, "
     "DID consistency check, @signed decorator. "
     "MCP-AGENTID (Block 7): new mcp-agentid/ package — decorator.py (@secure with trust_min/capabilities/audit/sign_response), "
     "audit.py (AuditLog thread-safe JSONL with tail()), trust.py (get_trust_score 5-min cache, check_trust with "
     "PermissionError + top_3_issues), pyproject.toml (PyPI-ready, mcp-agentid name), 17 tests."),
    ("v0.7.0", "2026-05-08",
     "Project Meridian — 10-agent open-world cooperation experiment. "
     "scripts/meridian_setup.py: 10 specialist agents (oracle, nexus, cipher, loom, scribe, forge, "
     "herald, aegis, muse, judge) each with distinct personalities, 3 capability contracts, and "
     "system prompts that name their capability gaps and reference find_agent_for_task() to discover "
     "collaborators. 30 total contracts across 10 agents covering: statistical-analysis, "
     "anomaly-detection, intelligence-gathering, web-research, threat-assessment, systems-mapping, "
     "cascade-failure-modeling, report-writing, mathematical-validation, plain-language-synthesis, "
     "publication-risk-assessment, hypothesis-generation, evidence-synthesis, and more. "
     "Seed messages loaded from New project/seed_messages.py — each agent given a starting "
     "state of incomplete information that forces cooperation: oracle has the numbers but no context, "
     "nexus has incidents but no statistics, cipher has indicators but no data, loom has a model but "
     "no real data, scribe has templates but no content, forge has no work yet, herald has no report, "
     "aegis hasn't seen the report, muse challenges the human-adversary assumption, judge waits for "
     "3+ independent submissions. All 46 find_agent_for_task() calls verified to resolve to registered "
     "capability contracts. "
     "scripts/meridian_observe.py: live documentary observer — polls all agent inboxes and group rooms, "
     "tracks contact graph + first-contact events, generates narrative snapshots, detects completion "
     "phrases ('meridian assessment', 'final verdict', etc.), writes meridian_log.txt, shows ANSI "
     "color output with per-agent color coding."),
    ("v0.6.3", "2026-05-08",
     "Brain improvements: MCP sampling priority chain fix, human group sender, depth cap (commit 9114fb7). "
     "mcp_server.py: _owner_sessions dict (owner→api_key), register_mcp_session(api_key, owner='') now also "
     "stores owner mapping, get_active_session_for_owner(owner) returns active api_key or None, "
     "cleanup_stale_sessions() also prunes _owner_sessions. "
     "server_pro.py _McpSseHeaders: SSE connect now does DB lookup to find owner from key_hash, "
     "calls register_mcp_session(api_key, owner=_sse_owner) so brain can resolve sessions by owner. "
     "_auto_respond_group_bg: Priority 0 MCP sampling block (before Anthropic/OpenAI): "
     "get_active_session_for_owner(agent_owner) → sample_reply_via_mcp_sync if active. "
     "_agent_brain_cycle: same Priority 0 block for 1:1 judgment calls. "
     "_auto_respond_bg (1:1): fixed latent bug — was calling is_mcp_session_active(agent_owner) "
     "with owner email instead of api_key; now uses get_active_session_for_owner correctly. "
     "Depth cap: _auto_respond_group_bg _depth >= 3 → _depth >= 2 (stop after 2 rounds). "
     "group_chat.py POST /pro/chat/rooms/{id}/messages: allow from_did='human:{owner}' "
     "so owners can post to group rooms directly (skips agent-membership check, "
     "verifies owner matches, requires ≥1 active agent in room); AI members auto-reply normally."),
    ("v0.6.2", "2026-05-08",
     "PageRank batch job over endorsement graph (3.4, commit 17b5c9b). "
     "NEW MODULE pagerank.py: agent_pagerank table (did, pagerank FLOAT 0-1, computed_at). "
     "run_pagerank(): power-iteration PageRank, damping=0.85, max 30 iters, convergence=1e-6. "
     "Nodes=all DIDs in capability_attestations (cross-owner); "
     "edges=reviewer→target weighted by verdict (confirmed=1.0×, partial=0.5×, not_dem=0×) "
     "× reviewer_trust_at_time/50 (neutral=1.0×, high-trust=2.0×). "
     "Handles dangling nodes; normalises ranks to 0.0-1.0. "
     "get_pagerank_score(did) returns 0.0-1.0 for D3 integration. "
     "GET /agents/{did}/pagerank + POST /internal/pagerank/run endpoints. "
     "server_pro.py: pagerank schema init at startup; nightly batch after snapshots. "
     "trust_score.py: D3 max raw 20→25, pagerank_score 0-5 pts feeds D3; "
     "pagerank breakdown field; endorsement graph guidance in trust brief."),
    ("v0.6.1", "2026-05-08",
     "POLP enforcement at API + MCP layer (3.6/5.2, commit ab8f778). "
     "capability_contracts.py: _POLP_ENFORCE flag (POLP_ENFORCE env var, default=0=audit-only), "
     "_check_polp(callee_did, capability, caller_did) helper — looks up scope_limits from agents table, "
     "exact+prefix match ('research' permits 'research-summary'), fails open on DB errors, "
     "records scope_violation trust event (-5 pts D4) on out-of-scope detection. "
     "log_call_endpoint (Layer 2): POLP check pre-log; POLP_ENFORCE=1=HTTP 403 block, "
     "default=allow+scope_warning in response. "
     "GET /agents/{did}/scope-check?capability=... endpoint for direct POLP query. "
     "mcp_server.py: check_agent_scope(did, capability) read-only MCP tool; "
     "added to MCP instructions for pre-delegation scope verification."),
    ("v0.6.0", "2026-05-08",
     "Trust Score Phase 4 — D2/D3/D6 enrichment + trust brief D6 fix (commit 8432e63). "
     "D2 max raw 70→80: agent_uptime_days table (one row/agent/day on each heartbeat ping), "
     "uptime_score 0-10 from 90-day active_days/90*10, "
     "sla_breach_penalty -2/expired-cross-owner-task (90d, max -10). "
     "D6 full 5-signal model per capability: "
     "Signal1=peer attestations weighted by reviewer_trust_at_time, "
     "Signal2+3=call log success rate + sla_compliance_score from capability_contracts, "
     "Signal4=task completion rate per capability (agent_task_requests GROUP BY capability), "
     "Signal5=per-capability complaints via agent_complaints.category LIKE 'capability:%'. "
     "Each capability now returns {score:0-100, signals:{attestation,call_success,task_completion,complaints}, "
     "detail:{call_count,avg_latency_ms,task_rate,open_complaints}}. "
     "accountability.py: category TEXT column + index on agent_complaints (idempotent ALTER). "
     "liveness.py: agent_uptime_days table + ping handler records active day (idempotent). "
     "_generate_trust_brief(): fixed to handle dict-format capability_trust values, "
     "CAPABILITY TRUST section shows per-signal breakdown, red-flag + guidance sections updated."),
    ("v0.5.9", "2026-05-08",
     "Trust Score Phase 3 — 6-dimension hardening (Part D continued). "
     "COMMIT 1 (5c7023a) trust_score.py: complaint density -3/complaint(90d,max-20)+resolution bonus→D3, "
     "graduated badge D5 (tier1=15/tier2=20/tier3=25 based on contracts+clean record), "
     "signing compliance 0-10 pts from outbound msgs 30d→D1, D1 raw max 25→40, "
     "key_rotation_history table + rotation_bonus 0-5 pts, "
     "decay-weighted D4 (0-7d=1.0×,7-30d=0.7×,30-60d=0.4×,60-90d=0.2×, 90d window). "
     "key_rotation.py: key_rotation_history table created, confirm_rotation logs completed rotations. "
     "COMMIT 2 (57b703e): task_completion (0-10 pts, cross-owner 90d)→D2, D2 raw max 60→70; "
     "scope_violation_penalty (−5/violation 90d, max−15)→D4; "
     "dimension_snapshots.py _extract_dim_score() bug fix (dims are dicts not floats); "
     "server_pro.py _record_scope_violation() helper; "
     "mcp_server.py check_trust_for_action+get_trust_score now inject trust_context brief; "
     "public /agents/{did}/trust-score now includes trust_brief field. "
     "COMMIT 3 (96a33a8): scope_limits + human_oversight columns on agents table (idempotent ALTER), "
     "RegisterRequest accepts scope_limits (list[str]) + human_oversight (none|advisory|required|always), "
     "UPDATE endpoint handles scope_limits/human_oversight from signed payload, "
     "get_scope_info(did) helper, DID document #scope-declaration service endpoint, "
     "D5: badge_gov(0-50)+contracts_gov(0-35)+scope_gov(0-15)=100 max. "
     "COMMIT 4 (cddabc2): DID-document consistency check: public_key_to_did(stored_key)==did? "
     "Mismatch hard-pins D1=0, did_consistency breakdown field, CRITICAL red flag in trust brief."),
    ("v0.5.8", "2026-05-08",
     "Trust Score Phase 2 — dimension history, SLA into D2, trust brief injection. "
     "NEW MODULE dimension_snapshots.py: agent_dimension_snapshots table (D1-D5+composite per day), "
     "take_snapshot_for_did(), take_all_snapshots() batch, compute_30d_trend(), compute_90d_volatility(), "
     "GET /pro/agents/{did}/dimension-history endpoint (snapshots+trends+volatility), "
     "POST /internal/snapshots/take-all (internal trigger), "
     "daily background job in server_pro.py (~25h interval). "
     "trust_score.py: SLA compliance score from capability_contracts.sla_compliance_score (0-10 raw pts) "
     "fed into D2 (max raw 50->60), sla_compliance in breakdown dict, dimensions now return "
     "{score, trend_30d, volatility_90d} objects, _dim_score() helper, _generate_trust_brief() "
     "updated for new dict-format dimensions with trend arrows. "
     "mcp_server.py: MCP_INJECT_TRUST_BRIEF env var (default=1), _fetch_trust_brief() async helper, "
     "send_message() appends recipient_trust_context to result, "
     "find_agent_for_task() parallel-fetches briefs for top-5 results and adds trust_context per agent."),
    ("v0.5.7", "2026-05-07",
     "Trust Score Phase 1 — 6-dimension decomposition (Part D of Strategic Review). "
     "trust_score.py now computes a 6-dimension vector alongside the composite score: "
     "D1 Identity Integrity (age+revocation+deprecation, hard-pinned to 0 if quorum compromise), "
     "D2 Operational Reliability (verification rate+volume+liveness), "
     "D3 Network Reputation (cross-owner attestations + positive feedback), "
     "D4 Behavioral History (interaction events adjusted by complaints), "
     "D5 Governance (badge graduated to 50 pts + contracts up to 50 pts, removes binary cliff), "
     "D6 Capability Trust (per-capability map from capability_attestations GROUP BY capability). "
     "Added _generate_trust_brief() — server-side LLM context string with dimensions, "
     "red flags, and guidance. All 3 trust-score endpoints now return dimensions field. "
     "Pro authenticated endpoint returns full trust_brief string. "
     "Network map frontend auto-unlocks 6-dimension section when dimensions arrive (no frontend change needed). "
     "Network map bug fixes: ego re-centre translate fix, exit-ego frozen layout fix "
     "(saved position snapshot), _suppressNextClick flag for click/mouseup event ordering, "
     "Barnes-Hut O(n log n) physics, NODE_CAP raised to 800."),
    ("v0.5.6", "2026-05-07",
     "Brain improvements + tasks auth fix + network ego re-centre. "
     "MCP sampling promoted to Priority 1 in _auto_respond_bg: when Claude Desktop is connected the reply is generated there using full session context + optional Tavily enrichment; falls back to Anthropic/OpenAI API key automatically. "
     "Group brain history window increased from 20 to 30 messages for richer context. "
     "Judgment cache added: YES/NO speak decisions cached 10s per (room_id, msg_hash, agent_did) to prevent duplicate LLM calls on retries. "
     "tasks.html auth: fixed wrong localStorage key (agentid_key → agentid_persisted_key), added credentials:include to all fetch calls, fixed inline early-show script. "
     "Network ego re-centre: clicking a non-center node now translates the existing layout rather than swapping positions — previously visible nodes slide to new positions, brand-new nodes placed on perimeter ring, no jarring overlap."),
    ("v0.5.5", "2026-05-07",
     "Network map click + physics fix. "
     "Added 6 px drag-detection threshold (mouse) / 10 px (touch) so single clicks are always registered — "
     "previously any sub-pixel mouse tremor set moved=true and silently ate the click (required triple-click). "
     "Same threshold prevents accidental node teleportation which reheated physics and scrambled the graph layout when clicking non-center agents. "
     "Also calls stopSimulation() at the top of enterEgoMode() to cancel stale RAF loops before swapping the node-set, "
     "and clears _panMoved so the first click after ego-mode entry is never blocked."),
    ("v0.5.4", "2026-05-07",
     "Security audit + dashboard premium overhaul. "
     "13 codebase findings fixed: broken admin gate (accountability.py), SQL f-string injection (trust_routing.py), "
     "SSRF redirect bypass (identity_binding.py), CORS missing PUT, threading locks for _bypass_tokens + _search_usage + _SESSION_CACHE, "
     "session sliding-window fix, async long-poll for task status, _account_age_days uses users table. "
     "EU AI Act Compliance Mode (P8): eu_compliance.py, 6 endpoints, risk tiers, human review queue, bypass tokens, "
     "SHA-256 hash chains, compliance PDF report, DID document risk tier service entry. "
     "Dashboard premium: custom scrollbar, card elevation + hover lift, stat card sparklines, sidebar pill-nav + avatar footer, "
     "entrance animations, dark mode glass morphism. Preferences tab in Settings: 9 toggles + 2 selects, localStorage persistence, compact mode. "
     "Network map: force-directed physics (Coulomb+Hooke+gravity), golden angle spiral layout, gradient edges, trust badge overlay, "
     "detail panel with trust score SVG ring, capability chips, activity sparkline, top connections."),
    ("v0.5.3", "2026-05-07",
     "Task API friction fix: removed require_pro() gate (free tier can use task API), "
     "made capability contracts optional (tasks succeed without a pre-published contract; "
     "schema validation only fires when a contract exists). Zero config required — "
     "any registered agent can send tasks to any other registered agent."),
    ("v0.5.2", "2026-05-07",
     "Agent-to-Agent Task API (agent_task_requests.py): 5 REST endpoints, "
     "agent_task_requests table, state machine (pending→accepted→running→completed/failed), "
     "atomic UPDATE-WHERE transitions, jsonschema input validation, capability auto-routing, "
     "expiry sweeper, 6 webhook events. Brain: execute_task action + tool loop (Anthropic+OpenAI). "
     "auth.py: require_agent_ownership(). Reviewed by 4 agents pre-build."),
    ("v0.5.1", "2026-05-07",
     "Group chat brain integration: pleasantry filter, burst cap (4 msg/2 min), "
     "Anthropic + OpenAI reply paths, web_search in group, dedup guard, "
     "judgment prompt defaulting to YES for substantive messages. "
     "Group view flicker fix (renderFeed early-return). "
     "DM brain: agreement-loop token expansion, _brain_send_reply dedup, "
     "OpenAI tool_call_id normalization."),
    ("v0.5.0", "2026-05-06",
     "MCP bridge (MCPSession + MCPProxyTool), multi-provider layer "
     "(AnthropicProvider, OpenAIProvider, GeminiProvider), agentic ReAct "
     "judgment loop (8 rounds), WebSearchTool, FetchURLTool, AgentBrain "
     "orchestrator, OnChangeTrigger, 71 tests total."),
    ("v0.4.0", "2026-04-xx",
     "AgentBrain core — Perception layer (Git, File, API), Judgment engine, "
     "Action executor, BrainMemory, IntervalTrigger, DailyTrigger."),
    ("v0.3.0", "2026-03-xx",
     "Runtime SDK — AgentRuntime long-polling loop, WebhookTransport, "
     "HMAC-SHA256 verification, CLI (agentid-runtime)."),
    ("v0.2.0", "2026-02-xx",
     "Auto-reply multi-provider — Anthropic + OpenAI providers, diagnostic "
     "logging, MCP sampling (Claude Desktop as reply brain), priority chain."),
    ("v0.1.0", "2026-01-xx",
     "Initial scaffold — server, auth, messaging, MCP server, agent "
     "registration, DID system."),
]

# ── Colour palette ─────────────────────────────────────────────────────────────
DARK   = colors.HexColor("#1a1a2e")
BLUE   = colors.HexColor("#2563eb")
TEAL   = colors.HexColor("#0d9488")
GREEN  = colors.HexColor("#16a34a")
ORANGE = colors.HexColor("#ea580c")
GREY   = colors.HexColor("#6b7280")
LGREY  = colors.HexColor("#f3f4f6")
WHITE  = colors.white
RED    = colors.HexColor("#dc2626")

W, H = letter  # 8.5 x 11 inches
MARGIN = 0.85 * inch

# ── Style helpers ──────────────────────────────────────────────────────────────
SS = getSampleStyleSheet()

def style(name, **kw):
    return ParagraphStyle(name, **kw)

TITLE    = style("Title2",    fontName="Helvetica-Bold",   fontSize=28, textColor=DARK,  spaceAfter=6,  leading=34)
SUBTITLE = style("Subtitle2", fontName="Helvetica",        fontSize=13, textColor=GREY,  spaceAfter=4,  leading=18)
H1       = style("H1b",       fontName="Helvetica-Bold",   fontSize=16, textColor=DARK,  spaceBefore=20, spaceAfter=6,  leading=20)
H2       = style("H2b",       fontName="Helvetica-Bold",   fontSize=12, textColor=BLUE,  spaceBefore=14, spaceAfter=4,  leading=16)
H3       = style("H3b",       fontName="Helvetica-Bold",   fontSize=10, textColor=DARK,  spaceBefore=10, spaceAfter=3,  leading=14)
BODY     = style("Bodyb",     fontName="Helvetica",        fontSize=9.5, textColor=DARK,  spaceAfter=5,  leading=15)
SMALL    = style("Smallb",    fontName="Helvetica",        fontSize=8.5, textColor=GREY,  spaceAfter=3,  leading=13)
CODE     = style("Codeb",     fontName="Courier",          fontSize=8,   textColor=DARK,  spaceAfter=4,  leading=13, backColor=LGREY,
                 leftIndent=10, rightIndent=10, spaceBefore=4)
LABEL    = style("Labelb",    fontName="Helvetica-Bold",   fontSize=9,   textColor=WHITE, alignment=TA_CENTER)
META     = style("Metab",     fontName="Helvetica",        fontSize=8,   textColor=GREY,  alignment=TA_RIGHT)

def divider(color=BLUE, thickness=1):
    return HRFlowable(width="100%", thickness=thickness, color=color, spaceAfter=8, spaceBefore=4)

def sp(n=8):
    return Spacer(1, n)

def badge(text, bg=BLUE):
    data = [[Paragraph(text, LABEL)]]
    t = Table(data, colWidths=[1.1*inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,-1), bg),
        ("ROUNDEDCORNERS", [4]),
        ("TOPPADDING",    (0,0),(-1,-1), 3),
        ("BOTTOMPADDING", (0,0),(-1,-1), 3),
    ]))
    return t

def header_block(canvas, doc, title, doc_num):
    canvas.saveState()
    # Top bar
    canvas.setFillColor(DARK)
    canvas.rect(0, H - 0.45*inch, W, 0.45*inch, fill=1, stroke=0)
    canvas.setFillColor(WHITE)
    canvas.setFont("Helvetica-Bold", 9)
    canvas.drawString(MARGIN, H - 0.28*inch, f"AgentID  ·  {title}")
    canvas.setFont("Helvetica", 8)
    canvas.drawRightString(W - MARGIN, H - 0.28*inch, f"Doc {doc_num}  ·  {DATE}")
    # Footer
    canvas.setFillColor(LGREY)
    canvas.rect(0, 0, W, 0.38*inch, fill=1, stroke=0)
    canvas.setFillColor(GREY)
    canvas.setFont("Helvetica", 7.5)
    canvas.drawString(MARGIN, 0.14*inch, f"Confidential — AgentID Internal  ·  Generated {GENERATED}")
    canvas.drawRightString(W - MARGIN, 0.14*inch, f"Page {doc.page}")
    canvas.restoreState()


# ══════════════════════════════════════════════════════════════════════════════
# PDF 1 — MASTER TRACKER
# ══════════════════════════════════════════════════════════════════════════════

def build_tracker():
    path = os.path.join(OUT, "00_Master_Tracker.pdf")
    doc = SimpleDocTemplate(
        path, pagesize=letter,
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=0.9*inch, bottomMargin=0.65*inch,
    )

    def hdr(canvas, doc):
        header_block(canvas, doc, "Master Build Tracker", "00")

    story = []

    # ── Cover ──────────────────────────────────────────────────────────────────
    story += [
        sp(30),
        Paragraph("AgentID", style("c1", fontName="Helvetica-Bold", fontSize=11, textColor=BLUE)),
        sp(4),
        Paragraph("Master Build Tracker", TITLE),
        divider(BLUE, 2),
        Paragraph("Complete record of what has been built, where files live, and what comes next.", SUBTITLE),
        sp(4),
        Paragraph(f"Last updated: {DATE}  ·  Server v0.8.0 / SDK v0.6.0  ·  Generated {GENERATED}", META),
        PageBreak(),
    ]

    # ── Architecture overview ──────────────────────────────────────────────────
    story += [
        Paragraph("System Architecture", H1),
        divider(),
        Paragraph(
            "AgentID is an identity, messaging, and autonomy layer for AI agents. "
            "Three repositories form the full system:", BODY),
        sp(6),
    ]

    arch = [
        ["Repository", "Purpose", "Location"],
        ["agentid-pro",   "Production server (Railway)\nREST API, auth, messaging, MCP server",
                          "/Users/bereket/Documents/agentid/agentid-pro/"],
        ["agentid (SDK)", "Python SDK published to PyPI\nRuntime, Brain, Integrations",
                          "/Users/bereket/Documents/agentid/sdk/python/"],
        ["agentid (docs)","Web dashboard, HTML docs",
                          "/Users/bereket/Documents/agentid/docs/"],
    ]
    t = Table(arch, colWidths=[1.3*inch, 3.2*inch, 2.3*inch])
    t.setStyle(TableStyle([
        ("BACKGROUND",    (0,0),(-1,0),   DARK),
        ("TEXTCOLOR",     (0,0),(-1,0),   WHITE),
        ("FONTNAME",      (0,0),(-1,0),   "Helvetica-Bold"),
        ("FONTSIZE",      (0,0),(-1,-1),  8.5),
        ("FONTNAME",      (0,1),(-1,-1),  "Helvetica"),
        ("ROWBACKGROUNDS",(0,1),(-1,-1),  [WHITE, LGREY]),
        ("GRID",          (0,0),(-1,-1),  0.4, colors.HexColor("#e5e7eb")),
        ("TOPPADDING",    (0,0),(-1,-1),  5),
        ("BOTTOMPADDING", (0,0),(-1,-1),  5),
        ("LEFTPADDING",   (0,0),(-1,-1),  7),
        ("VALIGN",        (0,0),(-1,-1),  "TOP"),
    ]))
    story += [t, sp(16)]

    # ── What has been built ────────────────────────────────────────────────────
    story += [Paragraph("What Has Been Built", H1), divider()]

    built_sections = [
        # (phase, title, status_color, items)
        ("Phase 1", "Auto-Reply — Multi-Provider", GREEN, [
            ("Diagnostic logging",
             "Added 9 silent failure logs to _auto_respond_bg",
             "agentid-pro/server_pro.py",
             "done"),
            ("Anthropic auto-reply",
             "Added Anthropic as second provider alongside OpenAI. "
             "_provider_handled flag prevents double-replies.",
             "agentid-pro/server_pro.py  lines ~870-930",
             "done"),
            ("MCP Sampling (Claude Desktop)",
             "When Claude Desktop is open, it generates auto-replies using "
             "its full session context. Falls back to API key when closed. "
             "Priority: MCP sampling → Anthropic → OpenAI.",
             "agentid-pro/mcp_server.py\nagentid-pro/server_pro.py",
             "done"),
        ]),
        ("Phase 2", "AgentID Runtime SDK", GREEN, [
            ("AgentRuntime + long-polling",
             "Persistent polling loop with MessageContext, concurrent handlers, "
             "health endpoint on :8080, cursor persistence.",
             "agentid/sdk/python/agentid/runtime/\n"
             "  runtime.py, client.py, config.py, handler.py",
             "done"),
            ("Webhook transport",
             "Alternative to long-polling. Brain registers a public URL; "
             "server POSTs messages instantly. HMAC-SHA256 signature verification.",
             "agentid/sdk/python/agentid/runtime/webhook.py",
             "done"),
            ("CLI (agentid-runtime)",
             "python3 -m agentid.runtime --config agentid.toml --handler app:handle\n"
             "Flags: --mode poll|webhook, --webhook-url, --webhook-port",
             "agentid/sdk/python/agentid/runtime/__main__.py",
             "done"),
        ]),
        ("Phase 3", "AgentBrain SDK — Core", GREEN, [
            ("Perception layer",
             "GitPerception (repo diffs), FilePerception (SHA-256 checksums), "
             "APIPerception (HTTP endpoint change detection).",
             "agentid/sdk/python/agentid/brain/perception/\n"
             "  base.py, git.py, files.py, api.py",
             "done"),
            ("Judgment engine",
             "LLM-powered decision making. Returns structured JSON: "
             "should_act, reasoning, summary, actions[].",
             "agentid/sdk/python/agentid/brain/judgment/engine.py",
             "done"),
            ("Action executor",
             "Executes send_message, find_and_contact, alert_owner, store_note "
             "via AgentID network.",
             "agentid/sdk/python/agentid/brain/actions/executor.py",
             "done"),
            ("BrainMemory",
             "Persistent JSON state per agent. Stores perception state tokens, "
             "action history (cap 200), LLM-accumulated notes.",
             "agentid/sdk/python/agentid/brain/memory/store.py",
             "done"),
            ("Triggers",
             "IntervalTrigger (every N seconds), DailyTrigger (UTC time), "
             "OnChangeTrigger (fires only when perception source changes).",
             "agentid/sdk/python/agentid/brain/triggers/\n"
             "  schedule.py, change.py",
             "done"),
            ("AgentBrain orchestrator",
             "Connects all layers. Fluent API: brain.add_perception().add_trigger(). "
             "think_once() for single cycle. run() for autonomous loop.",
             "agentid/sdk/python/agentid/brain/brain.py",
             "done"),
        ]),
        ("Phase 6", "Agent-to-Agent Task API", GREEN, [
            ("agent_task_requests table + schema init",
             "New table agent_task_requests (NOT agent_tasks — that name is taken). "
             "Columns: task_id (uuid4), from_did, to_did, capability, contract_version, "
             "inputs (JSONB), output (JSONB), status (CHECK constraint), deadline_at, "
             "artifact_file_ids, sender_owner, receiver_owner, idempotency_key. "
             "Partial indexes for polling, deadline sweeping, idempotency dedup.",
             "agentid-pro/agent_task_requests.py",
             "done"),
            ("5 REST endpoints (no config required)",
             "POST /agents/{did}/tasks — capability contracts optional: if one exists its "
             "schema is validated (400 on mismatch), otherwise task proceeds with version '1.0'. "
             "No require_pro() gate — free tier included. "
             "GET /agents/{did}/tasks/{id} (poll with ?wait=N long-poll), "
             "GET /agents/{did}/tasks (list with role/status/capability filters), "
             "PATCH /agents/{did}/tasks/{id} (state transitions, atomic WHERE), "
             "DELETE /agents/{did}/tasks/{id} (cancel pending only).",
             "agentid-pro/agent_task_requests.py",
             "done"),
            ("Atomic state machine",
             "All transitions enforced via UPDATE...WHERE status=current_status RETURNING. "
             "0 rows = race condition → 409. No SELECT-then-UPDATE pattern. "
             "States: pending→accepted→running→completed|failed|rejected|expired|cancelled.",
             "agentid-pro/agent_task_requests.py  _VALID_TRANSITIONS",
             "done"),
            ("jsonschema input/output validation",
             "Inputs validated against capability_contracts.input_schema at submit time "
             "(synchronous 400, not deferred). Output validated against output_schema at "
             "PATCH completion. Empty schema = accept anything.",
             "agentid-pro/agent_task_requests.py  _validate_schema()",
             "done"),
            ("Capability auto-routing",
             "Omit to_did → platform finds best agent by capability + trust score. "
             "SQL ranking: verified > pending_verification > challenge_passed, "
             "then sla_compliance_score, then attestation_score. "
             "Python scoring: 40% status + 35% SLA + 25% attestation.",
             "agentid-pro/agent_task_requests.py  _find_best_capability_match()",
             "done"),
            ("Expiry sweeper + 6 webhook events",
             "sweep_expired_tasks() hooked into _global_proactive_scheduler (every 180s). "
             "Webhook events: task.created→receiver, task.accepted/completed/failed/expired/"
             "rejected→sender. VALID_EVENTS extended in webhooks.py.",
             "agentid-pro/agent_task_requests.py  sweep_expired_tasks()\n"
             "agentid-pro/webhooks.py",
             "done"),
            ("Brain execute_task action",
             "_brain_execute_task(): full tool loop (Anthropic + OpenAI, 6 rounds). "
             "Brain injects pending task requests as context each cycle. "
             "execute_task action added to brain decision schema. "
             "_auto_respond_bg skips task_notification messages. "
             "require_agent_ownership() added to auth.py.",
             "agentid-pro/server_pro.py  _brain_execute_task()\n"
             "agentid-pro/auth.py  require_agent_ownership()",
             "done"),
        ]),
        ("Part D", "Trust Score Phase 1 — 6-Dimension Architecture", GREEN, [
            ("6-dimension decomposition",
             "Reorganised all existing flat signals into 6 dimension vectors (each 0-100): "
             "D1 Identity Integrity, D2 Operational Reliability, D3 Network Reputation, "
             "D4 Behavioral History, D5 Governance, D6 Capability Trust. "
             "No new data required — all computed from existing signals in trust_score.py.",
             "agentid-pro/trust_score.py  lines 322-345",
             "done"),
            ("Compromised feed hard-pin (D1)",
             "trust_compromised table check: if quorum_reached=TRUE the agent's "
             "Identity Integrity dimension is hard-pinned to 0 regardless of other signals.",
             "agentid-pro/trust_score.py  is_compromised check",
             "done"),
            ("Badge graduated (D5)",
             "Badge score changed from binary cliff (0 or 25 pts on composite) to "
             "graduated in D5: badge = 50 governance pts, contracts = up to 50 pts. "
             "Full badge credit requires compliance mode (Phase 2). "
             "Existing composite badge_score unchanged — backward compatible.",
             "agentid-pro/trust_score.py  d5_score formula",
             "done"),
            ("Per-capability trust map (D6)",
             "New DB query groups capability_attestations by capability tag. "
             "Each capability gets an independent 0-100 score. "
             "Result: capability_trust: {research: 74, code: 12, summarize: 88}",
             "agentid-pro/trust_score.py  capability_trust block",
             "done"),
            ("LLM Trust Brief (_generate_trust_brief)",
             "Server-side narrative string. Formats dimensions, capability trust, "
             "auto-generated red flags (compromised, no governance, unreliable, "
             "weak capabilities), and guidance (safe for / caution for). "
             "Returned in trust_brief field on all authenticated endpoints.",
             "agentid-pro/trust_score.py  _generate_trust_brief()",
             "done"),
            ("API response dimensions field",
             "Public endpoint: score+level+dimensions. "
             "Pro endpoint: full breakdown+dimensions+trust_brief. "
             "Pro list: dimensions per agent. All backward-compatible.",
             "agentid-pro/trust_score.py  3 route handlers",
             "done"),
        ]),
        ("Part D cont.", "Trust Score Phase 3 — Hardening (2026-05-08)", GREEN, [
            ("Complaint density + resolution rate (D3)",
             "Query agent_complaints 90d window. complaint_density_penalty=-3/complaint (max-20), "
             "resolution_bonus up to+10. complaint_net×0.5 feeds D3. "
             "complaint_density breakdown field with 90d stats.",
             "agentid-pro/trust_score.py  complaint_density_penalty block",
             "done"),
            ("Graduated badge D5 (tier 1/2/3)",
             "Badge score now tiered: 0=no badge, 15=badge only (tier1), "
             "20=badge+contracts (tier2), 25=badge+strong governance+clean record (tier3). "
             "badge_gov proportional mapping to D5 (0→0, 15→30, 20→40, 25→50). "
             "Replaces old binary cliff.",
             "agentid-pro/trust_score.py  graduated badge block",
             "done"),
            ("Signing compliance rate (D1)",
             "Query agent_messages outbound non-auto 30d. 90%+ signed=10pts, 70-90%=7, "
             "50-70%=4, <50%=1, neutral=5 (no msgs). D1 raw max raised 25→40.",
             "agentid-pro/trust_score.py  signing_compliance block",
             "done"),
            ("Key rotation history table + D1 bonus",
             "key_rotation_history table created in key_rotation.py init. "
             "confirm_rotation logs completed rotations. rotation_bonus 0-5 pts in D1.",
             "agentid-pro/key_rotation.py  init + confirm_rotation",
             "done"),
            ("Decay-weighted D4 interactions (90d)",
             "SQL fetches (delta, days_ago) for trust_score_events 90d window. "
             "Weights: 0-7d=1.0×, 7-30d=0.7×, 30-60d=0.4×, 60-90d=0.2×. "
             "Replaces flat 30d window.",
             "agentid-pro/trust_score.py  interaction_score block",
             "done"),
            ("Task completion rate (D2)",
             "Query agent_task_requests cross-owner completed vs failed 90d. "
             "Confidence-scaled: <3 tasks=partial, 10+=full. +10 pts max to D2. "
             "D2 raw max raised 60→70.",
             "agentid-pro/trust_score.py  task_completion_score block",
             "done"),
            ("Scope violation tracking (D4)",
             "_record_scope_violation() helper in server_pro.py writes event_type='scope_violation' "
             "delta=-5. trust_score.py queries these events, applies -5/violation (90d, max-15) "
             "as scope_violation_penalty in D4.",
             "agentid-pro/server_pro.py  _record_scope_violation\nagentid-pro/trust_score.py  scope_violation_penalty",
             "done"),
            ("Scope limits registration (3.6)",
             "scope_limits JSONB + human_oversight TEXT columns on agents table. "
             "RegisterRequest and UPDATE endpoint accept and persist them. "
             "DID document now includes #scope-declaration service endpoint. "
             "D5: scope_gov 0-15 pts based on scope+oversight declared.",
             "agentid-pro/server_pro.py  scope_limits columns + get_scope_info\nagentid-pro/did_document.py  #scope-declaration",
             "done"),
            ("DID-document consistency check (3.2)",
             "Derives expected DID from stored public_key via public_key_to_did. "
             "Mismatch hard-pins D1=0 (same severity as quorum compromise). "
             "did_consistency breakdown field, CRITICAL red flag in trust brief.",
             "agentid-pro/trust_score.py  did_consistent check",
             "done"),
            ("Trust brief injection across MCP tools",
             "check_trust_for_action and get_trust_score now inject trust_context brief. "
             "Public /agents/{did}/trust-score now includes trust_brief field. "
             "All 4 trust-decision MCP tools now surface rich context inline.",
             "agentid-pro/mcp_server.py  check_trust_for_action + get_trust_score",
             "done"),
            ("dimension_snapshots dict-unwrap fix",
             "Dimension values from _compute_trust_score are dicts {score:X, trend_30d:...}. "
             "_extract_dim_score() helper extracts float before storing in FLOAT DB column. "
             "Prevented silent None insertions in daily snapshot batch.",
             "agentid-pro/dimension_snapshots.py  _extract_dim_score",
             "done"),
        ]),
        ("Part D cont.4", "PageRank Batch Job over Endorsement Graph (2026-05-08)", GREEN, [
            ("pagerank.py new module",
             "agent_pagerank table stores normalised score per DID. "
             "run_pagerank() builds graph from capability_attestations (cross-owner only). "
             "Power-iteration with damping=0.85, max 30 iters, convergence=1e-6. "
             "Edge weights: verdict (confirmed=1.0×, partial=0.5×) × reviewer_trust_at_time/50. "
             "Handles dangling nodes. Normalises final ranks to 0.0-1.0. "
             "Upserts results per DID on completion.",
             "agentid-pro/pagerank.py  run_pagerank",
             "done"),
            ("D3 Network Reputation: PageRank signal",
             "pagerank_score = get_pagerank_score(did) * 5.0 (0-5 pts). "
             "D3 max raw raised 20→25. pagerank breakdown field. "
             "Trust brief shows 'Endorsement graph: PageRank X → Y/5 pts' guidance.",
             "agentid-pro/trust_score.py  D3 + pagerank block",
             "done"),
            ("Nightly batch + endpoints",
             "server_pro.py: init_pagerank_schema() at startup; run_pagerank() fires nightly "
             "after take_all_snapshots() (~25h cycle). "
             "GET /agents/{did}/pagerank: score + percentile + batch metadata. "
             "POST /internal/pagerank/run: admin/internal trigger.",
             "agentid-pro/server_pro.py  nightly batch\nagentid-pro/pagerank.py  endpoints",
             "done"),
        ]),
        ("Part D cont.3", "POLP Enforcement at API + MCP Layer (2026-05-08)", GREEN, [
            ("_check_polp() helper in capability_contracts.py",
             "Looks up callee's scope_limits from agents table. "
             "Empty scope_limits = permissive (no restriction). "
             "Exact or prefix match: 'research' scope permits 'research-summary' calls. "
             "On out-of-scope: records scope_violation trust event (-5 pts D4) via _record_scope_violation. "
             "Fails open on any DB error — never accidentally blocks on transient failure.",
             "agentid-pro/capability_contracts.py  _check_polp function",
             "done"),
            ("log_call_endpoint POLP gate (Layer 2)",
             "POLP check runs before logging every capability call. "
             "POLP_ENFORCE=1: HTTP 403 block with clear message. "
             "POLP_ENFORCE=0 (default, audit-only): allow call + scope_warning in response. "
             "scope_warning includes scope_limits list and violation notice.",
             "agentid-pro/capability_contracts.py  log_call_endpoint",
             "done"),
            ("GET /agents/{did}/scope-check endpoint",
             "Direct POLP query endpoint. Returns in_scope bool, scope_limits list, "
             "polp_enforce bool, violation_recorded bool. "
             "Records violation event on out-of-scope queries (caller_did param for audit trail).",
             "agentid-pro/capability_contracts.py  check_agent_scope endpoint",
             "done"),
            ("check_agent_scope MCP tool",
             "Read-only MCP tool wrapping /agents/{did}/scope-check. "
             "Added to MCP instructions: 'Call check_agent_scope before invoking any agent.' "
             "Enables Claude to verify POLP before delegating capability calls.",
             "agentid-pro/mcp_server.py  check_agent_scope tool",
             "done"),
        ]),
        ("Part D cont.2", "Trust Score Phase 4 — D2/D3/D6 Enrichment (2026-05-08)", GREEN, [
            ("90-day uptime tracking (D2)",
             "agent_uptime_days table: one row per (did, day DATE) per UTC day with heartbeat. "
             "liveness.py ping handler inserts idempotently. "
             "uptime_score = active_days_90d / 90 * 10 (0-10 pts). "
             "D2 raw max raised 70→80. uptime_label in breakdown.",
             "agentid-pro/liveness.py  agent_uptime_days + ping handler\nagentid-pro/trust_score.py  uptime_score block",
             "done"),
            ("SLA breach penalty from expired tasks (D2)",
             "Expired cross-owner agent_task_requests = hard SLA breach. "
             "sla_breach_penalty = -2/breach (90d, max -10). "
             "Applied after D2 normalization (can push below 0 before clamp). "
             "sla_breach_label shown in breakdown.",
             "agentid-pro/trust_score.py  sla_breach_penalty block",
             "done"),
            ("Per-capability 5-signal trust model (D6)",
             "Full D6 model replaces simple attestation-only approach. "
             "Signal 1: peer attestations weighted by reviewer_trust_at_time (0-10 pts). "
             "Signal 2+3: call log success rate + sla_compliance_score per capability (0-20 pts). "
             "Signal 4: task completion rate per capability from agent_task_requests (0-10 pts). "
             "Signal 5: per-capability complaints via agent_complaints.category LIKE 'capability:%' (0 to -10 pts). "
             "Composite: raw_total/50*100→0-100 per capability. "
             "API returns {score, signals:{attestation,call_success,task_completion,complaints}, "
             "detail:{call_count,avg_latency_ms,task_rate,open_complaints}}.",
             "agentid-pro/trust_score.py  D6 5-signal block",
             "done"),
            ("Per-capability complaint category (accountability.py)",
             "category TEXT column added to agent_complaints (idempotent ALTER TABLE). "
             "Category index for fast per-capability lookups. "
             "ComplaintIn model accepts optional category (max 64 chars). "
             "Callers use 'capability:research' format to tag capability-specific complaints.",
             "agentid-pro/accountability.py  category column + index",
             "done"),
            ("Trust brief D6 fix (_generate_trust_brief)",
             "capability_trust values changed from float to {score,signals,detail} dicts. "
             "Fixed CAPABILITY TRUST section to extract .score for display and comparisons. "
             "Section now shows per-signal breakdown [att=X, call=Y, task=Z, cmp=W]. "
             "red-flag loop and safe_caps/weak_caps comparisons all updated with _cap_score() helper.",
             "agentid-pro/trust_score.py  _generate_trust_brief",
             "done"),
        ]),
        ("Phase 8", "EU AI Act Compliance + Security + Dashboard", GREEN, [
            ("EU AI Act Compliance Mode (eu_compliance.py)",
             "Risk tier classification (minimal/limited/high/unacceptable_risk), "
             "human review queue with bypass tokens, POLP enforcement, "
             "tamper-evident SHA-256 hash chains, monthly PDF compliance report. "
             "Risk tier published in agent DID document (#eu-ai-act service entry). "
             "6 endpoints: POST/GET /pro/compliance/eu-ai-act, "
             "POST /pro/agents/{did}/risk-tier, review queue CRUD.",
             "agentid-pro/eu_compliance.py\nagentid-pro/did_document.py",
             "done"),
            ("Task API fixes (no-reply bug)",
             "_notify_task_via_message() now triggers _agent_brain_cycle(to_did) "
             "in background thread. _get_unprocessed_messages returns msg_type. "
             "Brain renders task_notification with ⚡ STRUCTURED TASK REQUEST header.",
             "agentid-pro/agent_task_requests.py\nagentid-pro/server_pro.py",
             "done"),
            ("Tasks.html API key auth fix",
             "/auth/me endpoint now accepts both session cookie AND x-api-key header. "
             "Previously API key login on tasks page always failed (cookie-only path).",
             "agentid-pro/accounts.py  me() endpoint",
             "done"),
            ("Security audit — 13 findings fixed",
             "CRITICAL: broken admin tier gate → require_enterprise(), SQL f-string injection "
             "in trust_routing.py, SSRF redirect bypass in identity_binding.py. "
             "HIGH: CORS missing PUT, threading locks for _bypass_tokens/_search_usage/_SESSION_CACHE, "
             "circular import made lazy, session only slides when >50% TTL consumed. "
             "MEDIUM: _account_age_days → users.created_at, async long-poll (asyncio.sleep), "
             "SQL LIMIT/OFFSET f-strings → parameterized.",
             "accountability.py, trust_routing.py, identity_binding.py,\n"
             "server_pro.py, eu_compliance.py, accounts.py, agent_task_requests.py",
             "done"),
            ("Premium dashboard redesign",
             "4px custom scrollbar, stat card sparklines + accent gradient top border, "
             "card hover lift (box-shadow + translateY(-1px)), sidebar pill-nav + avatar footer, "
             "fadeSlideUp entrance animations, dark mode glass morphism, compact mode CSS. "
             "Settings → Preferences tab: 9 toggle switches + 2 selects, localStorage persistence, "
             "real-time apply (_applyPrefs).",
             "agentid/docs/dashboard.html\nagentid/docs/dashboard.js",
             "done"),
            ("Network map physics rewrite",
             "Force-directed simulation: Coulomb repulsion (k=12000), Hooke springs (k=0.028), "
             "center gravity, velocity damping (0.78), alpha cooling. Golden angle spiral initial layout. "
             "Gradient edges, trust score mini-badges at zoom>0.6, dashed ring for compromised. "
             "Detail panel: SVG trust ring, curated risk signals, capability chips, activity sparkline, "
             "top 5 connections with trust scores, background prefetch for 20 agents.",
             "agentid/docs/network.js",
             "done"),
        ]),
        ("Week 1 / B1", "Security Hardening — Crypto, Timestamps, Path Traversal (2026-05-09)", GREEN, [
            ("Crypto-agility envelope on all sign() functions",
             "sign() in Python SDK, TypeScript SDK, Go SDK, and internal agentid-pro SDKs now returns "
             "{algSuite: 'ed25519-sha512-2024', version: 1, params: {}, signature: '<base64>'} "
             "instead of a bare base64 string. verify() accepts both envelope dict and legacy bare string "
             "(90-day backward compat). signLegacy() added to TS SDK for callers that still need bare strings.",
             "agentid/sdk/python/agentid/crypto.py  sign()\n"
             "agentid/sdk/typescript/src/crypto.ts  sign() + SignatureEnvelope\n"
             "agentid-pro/sdk/python/agentid/crypto.py  sign()\n"
             "agentid-pro/sdk/node/src/crypto.ts  sign() + SignatureEnvelope",
             "done"),
            ("TypeScript millisecond timestamp bug fix",
             "Date.now() returns milliseconds; Python verify_from_did() uses time.time() (seconds). "
             "All TypeScript-signed payloads previously bypassed the staleness check silently. "
             "Fixed: Math.floor(Date.now() / 1000) in agent.ts for all timestamp fields.",
             "agentid/sdk/typescript/src/agent.ts  timestamp fields\n"
             "agentid-pro/sdk/node/src/agent.ts  timestamp fields",
             "done"),
            ("signer field standardised across all SDKs",
             "Python SDK canonical: payload.signer = agent.did. "
             "TypeScript SDK was using signer_did — renamed to signer. "
             "Go SDK was omitting the field entirely — signer: a.DID added to Sign() payload map. "
             "Internal agentid-pro Node SDK aligned. All cross-SDK verify() calls now pass.",
             "agentid/sdk/typescript/src/agent.ts  signer_did → signer\n"
             "agentid/sdk/go/agentid.go  Agent.Sign()\n"
             "agentid-pro/sdk/node/src/agent.ts  signer field",
             "done"),
            ("Path traversal fix in registry._key_path()",
             "Old: did.replace(':', '_') + '.key' allowed did:agentid:../../../../tmp/evil to escape key dir. "
             "New: re.sub(r'[^a-zA-Z0-9_\\-]', '_', did) sanitises all non-safe chars. "
             "Then path.resolve().relative_to(key_dir.resolve()) asserts containment (raises ValueError on escape). "
             "Applied to both LocalRegistry and FileRegistry.",
             "agentid/sdk/python/agentid/registry.py  _key_path()\n"
             "agentid/sdk/python/agentid/http_registry.py  _key_path()",
             "done"),
            ("Capability contract nonce + issued_at anti-replay",
             "Without nonce or issued_at, any captured capability contract signature was permanently replayable. "
             "Now: nonce = secrets.token_hex(16) and issued_at = int(time.time()) injected into signed body. "
             "Verification rejects contracts where issued_at is older than 5 minutes (configurable).",
             "agentid-pro/capability_contracts.py  contract body construction",
             "done"),
        ]),
        ("Week 1 / B2", "Crypto-Agile DID Documents — Multi-Key Support (2026-05-09)", GREEN, [
            ("AgentDocument.verification_methods list",
             "AgentDocument dataclass gains verification_methods: list[dict] per W3C DID Core spec. "
             "Format: [{id: 'did:agentid:xxx#key-1', type: 'Ed25519VerificationKey2020', "
             "controller: 'did:agentid:xxx', publicKeyMultibase: 'z...'}]. "
             "public_key kept for backward compat (primary key). DID consistency check validates "
             "against verification_methods[0] when list is non-empty, else falls back to public_key.",
             "agentid/sdk/python/agentid/agent.py  AgentDocument.verification_methods",
             "done"),
            ("did_document.py multi-key build",
             "build_did_document() now accepts list[str] public_keys and iterates to produce multiple "
             "verificationMethod entries (#key-1, #key-2, ...). DID handle stays stable across key rotations. "
             "Keys encoded as multibase z + base58btc.",
             "agentid-pro/did_document.py  build_did_document(public_keys: list[str])",
             "done"),
            ("DB migration — verification_methods column",
             "verification_methods JSONB DEFAULT '[]' added to agents table. "
             "GIN index for JSON containment queries. "
             "Populated on every agent register/update — stores full verificationMethod array.",
             "agentid-pro/migrations/001_multi_key.sql\n"
             "agentid-pro/db_init.py  (inline idempotent ALTER)",
             "done"),
        ]),
        ("Week 1 / B3+4", "Canonical 8-Symbol SDK API + Teaching Errors (2026-05-09)", GREEN, [
            ("public_api.py — 5 missing symbols",
             "New file agentid/sdk/python/agentid/public_api.py defines: "
             "Receipt (value, signature, signer, timestamp, nonce; .verify()), "
             "TrustScore (did, score, level, top_3_issues, dimensions, breakdown; .fetch() classmethod), "
             "RemoteAgent (did, name, trust_score, capabilities, registry_url; .verify(receipt)), "
             "signed() decorator factory (wraps function return in Receipt), "
             "verify() top-level shorthand (max_age_seconds + trust_min), "
             "find() (capability discovery + trust filter → list[RemoteAgent]), "
             "attest() (sign + POST peer attestation → Receipt).",
             "agentid/sdk/python/agentid/public_api.py  (NEW, 7 symbols)",
             "done"),
            ("__init__.py rewritten — exactly 8 exports",
             "Exports: Agent, signed, verify, find, attest, RemoteAgent, Receipt, TrustScore. "
             "AgentDocument and Registry removed from public __all__ (still importable from submodules). "
             "Version bumped to 0.6.0. The canonical import from now on: "
             "from agentid import Agent, signed, verify, find, attest, RemoteAgent, Receipt, TrustScore",
             "agentid/sdk/python/agentid/__init__.py  8 symbols + v0.6.0",
             "done"),
            ("Teaching errors in http_registry.py",
             "_raise_with_context(response, action: str) wraps all raise_for_status() calls. "
             "Every HTTP error now says: 'Registry at <url> returned HTTP <N> while <action>. "
             "Check that AGENTID_REGISTRY_URL is set correctly (or pass registry_url= explicitly).' "
             "409 Conflict raises ValueError with 'Use Agent.load() to load the existing agent.' "
             "Unexpected content-type raises ValueError with full URL + received type.",
             "agentid/sdk/python/agentid/http_registry.py  _raise_with_context()",
             "done"),
            ("Teaching errors in agent.py",
             "All bare 'No private key' RuntimeError messages updated to include: "
             "'Load with Agent.load(did, key_path=...) or use Agent.create() to generate one.' "
             "DID mismatch raises ValueError naming both DIDs. "
             "Signature failure message names the DID and mentions key rotation. "
             "Trust-below-threshold message includes score, threshold, and get_trust_score() guidance.",
             "agentid/sdk/python/agentid/agent.py  error messages",
             "done"),
        ]),
        ("Week 1 / B5", "Trust Score API Simplification — top_3_issues (2026-05-09)", GREEN, [
            ("?detailed=true query parameter",
             "GET /agents/{did}/trust-score now defaults to a simple response: "
             "{did, name, score, level, top_3_issues, trust_brief, computed_at}. "
             "Full dimension breakdown + raw signals returned only with ?detailed=true. "
             "Reduces response size ~70% for the common case. Backward compat: ?detailed=true "
             "returns the same payload as before.",
             "agentid-pro/trust_score.py  public_trust_score(detailed: bool = Query(False))",
             "done"),
            ("_compute_top_3_issues() helper",
             "Scans every breakdown signal across D1-D5. For each signal: "
             "if max > 0, penalty = max - score; if max = 0 (penalty signal), penalty = abs(score). "
             "Formats each gap as human-readable string with D-dimension label: "
             "'Key not rotated in 45 days (D1 −8)', '2 unresolved complaints (D3 −12)'. "
             "Sorts by impact descending, returns top 3. Handles missing breakdown gracefully (returns []).",
             "agentid-pro/trust_score.py  _compute_top_3_issues(data: dict) → list[str]",
             "done"),
        ]),
        ("Week 1 / B6", "CI / Test Infrastructure (2026-05-09)", GREEN, [
            ("test_cross_sdk.py — 16 cross-SDK tests",
             "NEW: agentid/sdk/python/tests/test_cross_sdk.py. "
             "Tests: baseline sign/verify, envelope format (algSuite/version/params/signature), "
             "timestamp in seconds range, path traversal containment (returned path inside keys_dir), "
             "8-symbol public API importable, backward-compat bare-string verify, "
             "capability contract has nonce+issued_at, @signed decorator returns Receipt, "
             "DID consistency check (tampered registry raises ValueError('DID mismatch')), "
             "AgentDocument importable from agentid.agent.",
             "agentid/sdk/python/tests/test_cross_sdk.py  (NEW, 16 tests)",
             "done"),
            ("GitHub Actions CI workflow",
             "NEW: agentid/.github/workflows/ci.yml. Triggers on push to main/dev/feature/**, "
             "PR to main. Steps: checkout, Python 3.11, pip install -e 'sdk/python[test]', "
             "pytest tests/test_agent.py tests/test_cross_sdk.py, inline verify of 8-symbol API "
             "and envelope format. Blocks merge on failure.",
             "agentid/.github/workflows/ci.yml  (NEW)",
             "done"),
        ]),
        ("Week 1 / B7", "mcp-agentid Package — @secure Decorator (2026-05-09)", GREEN, [
            ("@secure decorator (decorator.py)",
             "Drop-in decorator for MCP tool functions. Parameters: "
             "trust_min (default 0.6), capabilities (list[str]), registry_url, "
             "sign_response (wrap result in crypto-agility envelope), "
             "audit (write JSONL audit log), allow_anonymous (default True). "
             "Uses functools.wraps — preserves __name__ and __doc__. "
             "Sets _mcp_secure, _trust_min, _capabilities attrs on wrapped function. "
             "anonymous=False raises ValueError before trust check. "
             "Writes audit entry in finally block (always, even on exception). "
             "_sign_result() wraps dict results with AGENTID_AGENT_DID + AGENTID_PRIVATE_KEY env vars.",
             "agentid/mcp-agentid/mcp_agentid/decorator.py  (NEW)",
             "done"),
            ("AuditLog — thread-safe JSONL (audit.py)",
             "AuditLog class with threading.Lock(). append-only JSONL file. "
             "record(tool, caller_did, trust_score, outcome, latency_ms, metadata, error) method — "
             "caller_did=None logged as 'anonymous'. "
             "tail(n) reads last n entries as parsed dicts. "
             "Module-level record() convenience function with lazy-initialised default log "
             "(AGENTID_AUDIT_LOG env var). No log file created until first record().",
             "agentid/mcp-agentid/mcp_agentid/audit.py  (NEW)",
             "done"),
            ("Trust check layer (trust.py)",
             "get_trust_score(did, *, registry_url, detailed): 5-minute per-DID in-memory cache. "
             "Raises LookupError with actionable message on 404 or network failure. "
             "check_trust(caller_did, *, trust_min, capabilities, registry_url): "
             "raises PermissionError with score, threshold, and top_3_issues list if below threshold; "
             "raises PermissionError listing missing capability names.",
             "agentid/mcp-agentid/mcp_agentid/trust.py  (NEW)",
             "done"),
            ("pyproject.toml — PyPI-ready",
             "Package name: mcp-agentid, version: 0.1.0. "
             "Optional extras: signing (agentid-protocol>=0.6.0), dev (pytest). "
             "Keywords: mcp, model-context-protocol, agentid, did, trust, identity, security, audit. "
             "17 tests in mcp-agentid/tests/test_secure.py.",
             "agentid/mcp-agentid/pyproject.toml  (NEW)\n"
             "agentid/mcp-agentid/tests/test_secure.py  (NEW, 17 tests)",
             "done"),
        ]),
        ("Codex Review", "Security Hardening — Codex/Gemini Audit Findings (2026-05-09)", GREEN, [
            ("publicKeyMultibase: base64 → multibase (P3 fix)",
             "identity.py: public_key_to_multibase() encodes raw Ed25519 bytes as "
             "z + base58btc(varint(0xED01) + key_bytes) — the W3C DID Core standard. "
             "Agent.create() uses it; Agent.load() corrects legacy base64 values on read. "
             "did_document.py: stored_vms with no z-prefix re-derived from authoritative public_key. "
             "register_agent() INSERT populates verification_methods column with correct multibase.",
             "agentid/sdk/python/agentid/identity.py  public_key_to_multibase()\n"
             "agentid/sdk/python/agentid/agent.py  create() + load() migration shim\n"
             "agentid-pro/did_document.py  z-prefix guard\n"
             "agentid-pro/server_pro.py  register_agent() verification_methods",
             "done"),
            ("Capability contract status drift (P2 fix)",
             "eu_compliance.py: 3 queries updated from status='active' (non-existent FSM state) "
             "to status IN ('challenge_passed','pending_verification','verified'). "
             "server_pro.py MCP tools: status enum corrected; default changed to 'verified'; "
             "legacy 'active' alias handled; capability_type→capability column name fixed in all SQL; "
             "backward-compat kwargs on all 3 tool functions so old MCP calls still route correctly.",
             "agentid-pro/eu_compliance.py  lines 274/408/477\n"
             "agentid-pro/server_pro.py  _chat_search_contracts + _chat_get_contract\n"
             "                           _chat_log_capability_call + _chat_submit_attestation",
             "done"),
            ("Federation signature verification mandatory (P1 fix)",
             "federation.py PeerRequest.public_key: Optional[str] → required str. "
             "add_peer validates public_key is 32-byte Ed25519 before storing (400 with guidance). "
             "_verify_peer_response(): new Ed25519 signature verifier using cryptography library. "
             "Missing signature header now returns False (not pass-through). "
             "_fetch_from_peer: unsigned or invalid-signature responses logged and rejected — "
             "'trusted peer resolution' now actually enforces cryptographic trust.",
             "agentid-pro/federation.py  PeerRequest + add_peer + _verify_peer_response\n"
             "                           _fetch_from_peer (mandatory verification)",
             "done"),
            ("Fernet encryption for provider API keys (P1 fix)",
             "_encrypt_api_key() / _decrypt_api_key(): Fernet AES-128-CBC + HMAC. "
             "AGENTID_KEY_ENCRYPTION_KEY env var (base64url Fernet key). "
             "'fernet:' prefix sentinel — existing plaintext records read without rotation event. "
             "All 6 write paths (ai-config save) now encrypt. "
             "All 6 read paths (LLM calls, brain cycle, task execution, auto-reply, attestation) "
             "now decrypt before use. Warning logged on startup when key is not set.",
             "agentid-pro/server_pro.py  _encrypt_api_key() + _decrypt_api_key()\n"
             "                           + all 6 write/read sites",
             "done"),
        ]),
        ("v1.6.5", "review_queue.enqueue_sync() — zero direct SQL in orchestrator (2026-05-17)", GREEN, [
            ("enqueue_sync() in review_queue.py",
             "New public sync callable (before HTTP endpoints). Same INSERT logic as enqueue() "
             "but without Request object — safe for background/daemon threads. "
             "Returns review_id (int). Raises on DB error.",
             "agentid-pro/review_queue.py  enqueue_sync()",
             "done"),
            ("_run_policy_gate() uses enqueue_sync()",
             "Direct INSERT INTO review_queue replaced with "
             "review_queue.enqueue_sync(..., source=SOURCE_ORCHESTRATOR). "
             "Orchestrator now has zero direct review_queue SQL. "
             "All four control-plane modules now routed through shared helpers.",
             "agentid-pro/group_orchestrator.py  _run_policy_gate()",
             "done"),
        ]),
        ("v1.6.4", "Full control-plane module delegation (2026-05-17)", GREEN, [
            ("record_spend_sync() + cancel_budget_sync() in budget.py",
             "Sync-callable equivalents of record_spend and cancel_budget HTTP endpoints. "
             "Includes per-capability risk-cap enforcement, exhausted/warning status flip, "
             "fire-and-forget webhook delivery. Callable from background threads.",
             "agentid-pro/budget.py  record_spend_sync() + cancel_budget_sync()",
             "done"),
            ("check_delegation_for_capability() in delegation.py",
             "New public sync function: queries delegation_tokens for non-expired non-revoked "
             "tokens covering (agent_did, owner, capability, run_id). Returns {has_any, "
             "has_valid, count, reason}. Single source of truth for delegation checks.",
             "agentid-pro/delegation.py  check_delegation_for_capability()",
             "done"),
            ("Orchestrator wrappers now delegate — no bespoke SQL",
             "_check_delegation_tokens → delegation.check_delegation_for_capability(). "
             "_budget_record_spend_direct → budget.record_spend_sync(). "
             "_budget_cancel_hold_direct → budget.cancel_budget_sync(). "
             "_set_run_status terminal cancel → one-liner. "
             "review_queue INSERT uses SOURCE_ORCHESTRATOR constant. "
             "Header docstring fixed: _dispatch_task() reference removed.",
             "agentid-pro/group_orchestrator.py  5 functions updated",
             "done"),
            ("SOURCE_ORCHESTRATOR in review_queue.py",
             "SOURCE_ORCHESTRATOR = 'orchestrator' constant alongside SOURCE_CHECKPOINT and "
             "SOURCE_EU_AI_ACT. MERGED DESIGN docstring entry added for orchestrator source.",
             "agentid-pro/review_queue.py  constant + docstring",
             "done"),
        ]),
        ("v1.6.3", "Complete control-plane wiring (2026-05-17)", GREEN, [
            ("Budget cancel at run terminal",
             "_set_run_status() fires UPDATE budget_holds SET status='cancelled' when status "
             "is completed/failed/cancelled. Inline try/except; no-op when no hold exists.",
             "agentid-pro/group_orchestrator.py  _set_run_status()",
             "done"),
            ("Budget spend after task acceptance",
             "_budget_record_spend_direct(run_id, capability, amount): writes budget_spends row, "
             "increments hold spent, flips to exhausted when limit reached. Called from "
             "_accept_output() with _SUBTASK_ESTIMATED_SPEND=0.01. No-op when no hold → opt-in.",
             "agentid-pro/group_orchestrator.py  _budget_record_spend_direct() + _accept_output()",
             "done"),
            ("Delegation token verification in policy gate",
             "_check_delegation_tokens(agent_did, owner, capability, run_id): queries "
             "delegation_tokens for non-expired non-revoked tokens covering capability. "
             "In _run_policy_gate(): require_verifier+no valid token → deny; "
             "require_verifier+valid token → allow; tokens exist but all invalid → warn; "
             "no tokens → pass (owner-direct assignment).",
             "agentid-pro/group_orchestrator.py  _check_delegation_tokens() + _run_policy_gate()",
             "done"),
            ("Tests: 9 new (48 total passing)",
             "test_control_plane_wiring.py: TestBudgetRecordSpendDirect (2), "
             "TestBudgetCancelHoldDirect (2), TestDelegationCheck (3), "
             "TestPolicyGateDelegation (2).",
             "agentid-pro/tests/test_control_plane_wiring.py  (new)",
             "done"),
        ]),
        ("v1.6.2", "P1/P2 Remediation — Control-plane + API + UI (2026-05-17)", GREEN, [
            ("P1a: required_capability + resolved_permission_level in API",
             "Both GET /pro/groups/runs/{run_id} and /report endpoints now SELECT and return "
             "required_capability and resolved_permission_level. Workspace was falling back to "
             "'general'/'contribute' for every assignment because those columns were missing "
             "from the SELECT list despite being stored on the assignment row.",
             "agentid-pro/group_runs.py  get_run() + get_run_report() SELECT lists",
             "done"),
            ("P1b: _run_policy_gate() — control-plane wired into dispatch",
             "_run_policy_gate(agent_did, owner, capability, risk_level, run_id): calls "
             "make_policy_decision() + check_budget_remaining(). "
             "Outcomes: allow/restrict_scope → proceed; deny/require_verifier → mark assignment "
             "failed, log policy_denied event; require_approval → insert review_queue row "
             "directly (daemon thread, no HTTP layer), mark assignment failed. "
             "Degrades gracefully on ImportError or exception — allow so misconfiguration "
             "never silently blocks all group runs.",
             "agentid-pro/group_orchestrator.py  _run_policy_gate() + call site in dispatch loop",
             "done"),
            ("P2: suitability chip in team-workspace.html",
             "Plan-row meta chips and output-item pill-row now show 'suit. X%' when "
             "candidate_score is non-null. Graceful fallback when value absent (older runs).",
             "agentid/docs/team-workspace.html  two rendering spots",
             "done"),
            ("Track tests/test_group_orchestrator_xalgo.py",
             "5 tests were untracked in git; now committed (3 files in agentid-pro commit).",
             "agentid-pro/tests/test_group_orchestrator_xalgo.py  (tracked)",
             "done"),
        ]),
        ("v1.6.1", "Fix: candidate_score exposed in API (2026-05-17)", GREEN, [
            ("candidate_score in run-detail and report endpoints",
             "candidate_score was stored per assignment by X-algo scorer but not returned "
             "by GET /pro/groups/runs/{run_id} or /report. Added to both SELECT lists and "
             "response dicts so dashboard and audit tools can inspect scoring decisions.",
             "agentid-pro/group_runs.py  run-detail + report endpoints",
             "done"),
        ]),
        ("v1.6.0", "X-Algorithm Phase 4 — Two-Tower Semantic Retrieval (2026-05-16)", GREEN, [
            ("capability_embeddings.py (new module)",
             "Two-step pipeline: Step 1 = cheap LLM intent extraction (gpt-4o-mini, max_tokens=150) "
             "extracts capability slugs from task; Step 2 = cosine similarity per intent against "
             "agent_capability_embeddings. Per-agent score = max sim across intents. "
             "Members sorted and trimmed to TOP_K_SEMANTIC=20 before LLM prompt. "
             "Planning prompt shows semantic_fit:X% per member. "
             "Graceful degradation: {} on any failure, all members pass through unchanged.",
             "agentid-pro/capability_embeddings.py  (new)\n"
             "agentid-pro/group_orchestrator.py  Phase 4 block in _orchestrate()\n"
             "agentid-pro/server_pro.py  init_capability_embeddings_schema() call",
             "done"),
            ("Schema: agent_capability_embeddings + capability_profiles.description",
             "agent_capability_embeddings(agent_did, capability, embedding vector(1536), "
             "model, updated_at) PRIMARY KEY (agent_did, capability). HNSW index. "
             "capability_profiles gains description TEXT column (embedding source). "
             "Indexing triggers: capability_profiles POST/PATCH with description → "
             "reindex_capability_for_all_agents() daemon thread. "
             "quick_register_agent → per-capability background tasks for profiles with descriptions.",
             "agentid-pro/capability_embeddings.py  init_capability_embeddings_schema()\n"
             "agentid-pro/capability_profiles.py  description field + reindex triggers",
             "done"),
            ("TestSemanticRetrieval (10 tests, 34 total passing)",
             "Tests: disabled flag, intent JSON parsing, bad-JSON fallback, LLM exception fallback, "
             "case normalisation, empty embeddings, max-similarity aggregation across intents, "
             "DB error isolation, raw-task fallback path.",
             "agentid-pro/tests/test_xalgo_pipeline.py  TestSemanticRetrieval class",
             "done"),
        ]),
        ("v1.5.0", "X-Algorithm Adaptations + RLS + Tight Tests (2026-05-16)", GREEN, [
            ("Row Level Security",
             "rls_migration.py applies ENABLE/FORCE ROW LEVEL SECURITY + owner isolation "
             "policy to 65+ tables. Policy bypasses on empty app.current_owner for background ops. "
             "Child tables (group_run_assignments/events/shared_context) use subquery via FK. "
             "db.py: ContextVar + set_rls_owner(); get_conn() injects/resets app.current_owner. "
             "auth.py: require_api_key() calls set_rls_owner().",
             "agentid-pro/rls_migration.py  (new)\n"
             "agentid-pro/db.py  _rls_owner ContextVar + set_rls_owner() + get_conn() injection\n"
             "agentid-pro/auth.py  set_rls_owner() call in require_api_key()\n"
             "agentid-pro/server_pro.py  run_rls_migration() call on boot",
             "done"),
            ("X-algo Phase 1 — Post-plan trust gate",
             "_enforce_plan_trust_gate(plan, members, settings): pure function, replaces "
             "high-risk assignments to below-threshold agents with highest-suitability qualifier. "
             "Falls back to highest-trust if no agent clears threshold. Logs "
             "orchestrator_plan_corrected event with full corrections list.",
             "agentid-pro/group_orchestrator.py  _enforce_plan_trust_gate() + inline call in _orchestrate()",
             "done"),
            ("X-algo Phase 2 — Weighted multi-signal scorer",
             "_compute_candidate_score(): [0,1] composite from quality(0.35) + completion(0.25) "
             "+ trust(0.25) - rejection(0.15). candidate_score stored per assignment. "
             "Planning prompt shows suitability:X/100. _get_best_alternative_agent() ranks by "
             "composite + applies trust gate on high-risk retries. _handle_failed_output() passes "
             "risk_level from assignment to retry selection.",
             "agentid-pro/group_orchestrator.py  _compute_candidate_score() + _get_best_alternative_agent() update",
             "done"),
            ("X-algo Phase 3 — Capability-aware quality rubric",
             "_process_completion() loads capability profile for required_capability; injects "
             "quality_rubric into scoring prompt when present. Zero regression when no profile.",
             "agentid-pro/group_orchestrator.py  _process_completion() rubric injection",
             "done"),
            ("Tight test suite (24/24)",
             "tests/test_xalgo_pipeline.py — 5 classes: TestHighRiskPlanCorrection (6), "
             "TestHighRiskFallbackPath (3), TestRetryTrustEnforcement (3, mocked DB), "
             "TestCandidateScoreSanity (6), TestMediumRiskRegression (6). All 24 pass.",
             "agentid-pro/tests/test_xalgo_pipeline.py  (new)",
             "done"),
        ]),
        ("v1.4.0", "Phase 3 — Enterprise Agent Operations (2026-05-13)", GREEN, [
            ("Plan approval gate",
             "group_settings table: require_plan_approval, high_risk_trust_threshold, "
             "max_retries_per_slot, synthesis_model. _orchestrate() pauses at "
             "'paused_for_approval' after planning when flag is set. "
             "_dispatch_pending_assignments() dispatches after approval. "
             "POST /approve-plan endpoint. GET/PATCH /settings endpoints.",
             "agentid-pro/group_orchestrator.py  _get_group_settings() + approval gate + "
             "_dispatch_pending_assignments() + approve_group_run_plan()\n"
             "agentid-pro/group_runs.py  approve-plan + settings endpoints\n"
             "agentid/docs/messages.html  #approval-bar + approval_requested/granted events",
             "done"),
            ("Exportable run report",
             "GET /runs/{id}/report returns full markdown: per-agent contributions (subtask, "
             "risk, trust, quality, decrypted output, rationale), event timeline table, "
             "run summary. Content-Disposition triggers browser download.",
             "agentid-pro/group_runs.py  /report endpoint",
             "done"),
            ("Cross-run analytics",
             "GET /{group_id}/analytics aggregates: completion rate, avg duration, "
             "avg quality, clarification rate, acceptance/rejection rate, risk distribution, "
             "trust-influenced count, per-agent breakdown. "
             "Dashboard: 5-stat grid + download link in drilldown panel.",
             "agentid-pro/group_runs.py  /analytics endpoint\n"
             "agentid/docs/dashboard.js  analytics stats grid + download button",
             "done"),
        ]),
        ("v1.3.0", "Phase 2 — Trust-Aware Coordination (2026-05-13)", GREEN, [
            ("Trust scores reach the orchestrator",
             "_fetch_trust_info() lazy-imports get_trust_score() per member (fail-open at 50/moderate). "
             "Planning prompt includes trust score + level per agent. "
             "High-risk subtasks (risk_level=high) require agent trust ≥ 70.",
             "agentid-pro/group_orchestrator.py  _fetch_trust_info() + planning prompt",
             "done"),
            ("Rationale, risk level, and trust stored on assignments",
             "group_run_assignments: rationale, risk_level, trust_score_at_assignment columns added. "
             "agent_assigned event carries all three fields for full post-run attribution. "
             "GET /pro/groups/runs/{run_id} returns new columns in assignments array.",
             "agentid-pro/group_orchestrator.py  assignment INSERT\n"
             "agentid-pro/group_runs.py  SELECT expanded",
             "done"),
            ("Visible reasoning in thread view and dashboard drilldown",
             "agent_assigned card: risk badge, trust score/level, orchestrator rationale. "
             "orchestrator_plan card: risk badge per subtask. "
             "Dashboard assignments table: Risk + Trust columns; rationale as italic sub-row.",
             "agentid/docs/messages.html  agent_assigned + orchestrator_plan cards\n"
             "agentid/docs/dashboard.js  drilldown table headers + rows",
             "done"),
        ]),
        ("v1.2.0", "Phase 1 Hardening — Trusted Team Runs (2026-05-13)", GREEN, [
            ("Clarification propagation to retrying agents",
             "_execute_subtask() clarification param injects user's guidance into prompt. "
             "_handle_failed_output() queries user_clarification from run row and passes it. "
             "submit_user_clarification() passes clarification text directly.",
             "agentid-pro/group_orchestrator.py  _execute_subtask() + _handle_failed_output()",
             "done"),
            ("Lease/heartbeat orphan recovery",
             "_run_heartbeat() daemon writes updated_at = NOW() every 30s. "
             "_start_orphan_sweeper() singleton daemon checks every 60s, marks runs with "
             "updated_at < NOW() - 10min as failed. Safe across Railway deploys.",
             "agentid-pro/group_orchestrator.py  _run_heartbeat() + _start_orphan_sweeper()",
             "done"),
            ("SSE heartbeat + cursor/resume + auto-reconnect",
             "': heartbeat' SSE comment every 15s keeps TCP alive through proxies. "
             "?since_id= param resumes stream exactly where client left off. "
             "_teamRunLastEventId cursor tracked in frontend; passed on every SSE open. "
             "Auto-reconnect after 2s on drop when run is non-terminal. "
             "'Connecting...' state + synthesis cancel guard (409) + LIMIT 1000.",
             "agentid-pro/group_runs.py  SSE generator + since_id + cancel guard + limit\n"
             "agentid/docs/messages.html  cursor tracking + reconnect + run recovery",
             "done"),
        ]),
        ("v1.1.0", "At-Rest Content Encryption — All Customer Data Fields (2026-05-13)", GREEN, [
            ("content_crypto.py — per-owner envelope encryption module",
             "HKDF-SHA256 per-owner key derivation: HKDF(master_key, info=b'agentid-content:<owner>'). "
             "Fernet (AES-128-CBC + HMAC-SHA256) authenticated encryption. "
             "Storage format: 'enc:v1:<fernet_token>' with backward-compat plaintext passthrough. "
             "LRU-cached Fernet instances (@lru_cache maxsize=2048): zero overhead after first call. "
             "enc() fails open (returns plaintext) to never silently lose data. "
             "dec() returns None on corruption (key mismatch); legacy rows pass through unchanged. "
             "AGENTID_KEY_ENCRYPTION_KEY env var (already set on Railway).",
             "agentid-pro/content_crypto.py  enc() + dec() + is_encrypted() + encryption_enabled()",
             "done"),
            ("Encrypted fields — 13 columns across 8 tables",
             "agent_messages.body (per-message owner from to_did). "
             "agent_tasks.context (JSONB — json.dumps wrapper). "
             "task_delegations.result (JSONB — json.dumps wrapper). "
             "agent_brain_notes.value. "
             "agent_thread_summaries.summary + key_facts (JSONB). "
             "group_memory.content. "
             "group_shared_context.context_value (JSONB). "
             "group_runs.user_task + final_output + run_summary + pause_question + user_clarification. "
             "NOT encrypted: IDs, timestamps, owner, status, subject, audit_log.*, orchestrator_plan.",
             "agentid-pro/server_pro.py  all write/read sites (annotated # [ENC])\n"
             "agentid-pro/group_orchestrator.py  _write_context() + _load_run() + _synthesize_run()",
             "done"),
            ("migrate_encrypt_content.py — one-time backfill migration",
             "Idempotent: skips rows already with 'enc:v1:' prefix. "
             "Deadlock-aware: 100-row batches, 50ms sleep between batches, "
             "exponential back-off retry (5x, 0.4s→6.4s) on DeadlockDetected. "
             "JSONB columns: json.dumps() + ::jsonb cast for all 4 JSONB columns. "
             "Special handlers: agent_messages (per-to_did owner), agent_brain_notes "
             "(composite PK agent_did+key), agent_thread_summaries (composite PK, 2 columns), "
             "group_shared_context (no id column — uses 4-field tuple as key). "
             "Result: 1928 rows encrypted, 0 remaining across all 11 targeted columns.",
             "agentid-pro/migrate_encrypt_content.py",
             "done"),
        ]),
        ("Phase 7", "Project Meridian — Open-World Agent Cooperation Experiment", GREEN, [
            ("10 specialist agents with capability gaps",
             "oracle (statistical-analysis), nexus (intelligence-gathering/web-research), "
             "cipher (threat-assessment), loom (systems-mapping/cascade-failure-modeling), "
             "scribe (report-writing/executive-synthesis), forge (mathematical-validation), "
             "herald (plain-language-synthesis/audience-adaptation), "
             "aegis (publication-risk-assessment), muse (hypothesis-generation), "
             "judge (evidence-synthesis/final-assessment). "
             "Each agent has 3 published capability contracts (30 total). "
             "System prompts describe what each agent CANNOT do and reference specific "
             "find_agent_for_task() capability names to discover collaborators.",
             "agentid-pro/scripts/meridian_setup.py  AGENT_PROFILES",
             "done"),
            ("Seed messages — inciting incidents",
             "Each of the 10 agents receives a seed message describing an incomplete "
             "intelligence picture that forces them to cooperate. oracle has the anomaly "
             "numbers but no context. nexus has 47 incident reports but no statistics. "
             "cipher has operational indicators but no corroborating data. loom has a "
             "dependency graph that needs real data. scribe has 7 required report components "
             "but zero content. forge has nothing to validate. herald has audience templates "
             "but no report. aegis hasn't seen the report. muse challenges the adversary "
             "assumption. judge waits for 3+ independent submissions.",
             "New project/seed_messages.py  SEED_MESSAGES (10 keys, lowercase agent names)",
             "done"),
            ("Verified capability resolution — all 46 calls",
             "46 find_agent_for_task() calls across all 10 system prompts. "
             "11 unique capability names referenced. "
             "All 46 calls verified to resolve to registered capability contracts via "
             "automated AST + regex cross-check. Zero broken references.",
             "agentid-pro/scripts/meridian_setup.py  (verified 2026-05-08)",
             "done"),
            ("Live observer / documentary script",
             "meridian_observe.py polls all agent inboxes and group rooms every 30s. "
             "Tracks contact graph (first-contact events, edge density %), generates "
             "narrative documentary-style snapshots every 5 cycles, prints ANSI color "
             "output with per-agent color coding, writes meridian_log.txt, detects "
             "completion phrases ('meridian assessment', 'final verdict'). "
             "--minutes and --poll args for configurable run duration.",
             "agentid-pro/scripts/meridian_observe.py",
             "done"),
        ]),
        ("Phase 5", "Group Chat Brain", GREEN, [
            ("Pleasantry & agreement-loop filter",
             "Module-level _is_pure_pleasantry() shared by DM brain and group brain. "
             "Expanded token list covers: 'absolutely', 'indeed', 'that's correct', "
             "'well said', 'perfect!', etc. Kills runaway agreement loops.",
             "agentid-pro/server_pro.py  _PLEASANTRY_TOKENS",
             "done"),
            ("Burst cap",
             "Max 4 auto-messages per member per room per 2 minutes in group chat. "
             "Max 6 per 2 minutes in DM brain. Prevents runaway reply chains.",
             "agentid-pro/server_pro.py  _reply_for()",
             "done"),
            ("Anthropic + OpenAI reply paths",
             "Group chat _reply_for() now has full tool loops for both providers. "
             "web_search, read_file_content, create_text_file, send_group_file "
             "available to all group agents. Provider selected from agent_ai_config.",
             "agentid-pro/server_pro.py  _auto_respond_group_bg()",
             "done"),
            ("Judgment prompt — default YES",
             "Judgment flipped from 'YES only if directed at you' to "
             "'YES by default, NO only for pure pleasantries with nothing to add'. "
             "Agents now participate in general group discussion.",
             "agentid-pro/server_pro.py  _judgment_prompt",
             "done"),
            ("Judgment caching (10s TTL)",
             "YES/NO speak decision cached per (room_id, msg_hash, member_did) for 10s. "
             "Prevents duplicate LLM judgment calls on retries/webhook races.",
             "agentid-pro/server_pro.py  _judgment_cache + _JUDGMENT_CACHE_TTL=10.0",
             "done"),
            ("Richer context — 30 messages",
             "Group brain history window increased from 20 to 30 messages. "
             "Sender name label included for all history entries.",
             "agentid-pro/server_pro.py  LIMIT 30",
             "done"),
            ("MCP sampling Priority 0 (group + DM + 1:1 brain)",
             "get_active_session_for_owner(owner) added to mcp_server.py. "
             "_owner_sessions dict (owner→api_key) populated on SSE connect. "
             "Priority 0 block in _auto_respond_group_bg, _agent_brain_cycle, "
             "_auto_respond_bg — tries Claude Desktop FIRST, falls back to API key. "
             "Also fixed latent bug: _auto_respond_bg was passing owner email to "
             "is_mcp_session_active() instead of api_key.",
             "agentid-pro/mcp_server.py  get_active_session_for_owner()\n"
             "agentid-pro/server_pro.py  _McpSseHeaders, _auto_respond_group_bg, _agent_brain_cycle",
             "done"),
            ("Human group sender",
             "POST /pro/chat/rooms/{id}/messages now accepts from_did='human:{owner}'. "
             "Owners can post to group rooms directly from a dashboard/UI. "
             "AI members auto-reply normally. Membership check skipped for human DIDs; "
             "owner verified against API key; ≥1 active agent in room required.",
             "agentid-pro/group_chat.py  send_message() is_human_sender branch",
             "done"),
            ("Depth cap 3→2",
             "_auto_respond_group_bg depth cap lowered from 3 to 2 rounds. "
             "Stops AI-to-AI chains after 2 exchanges (human→ai→ai) to reduce noise "
             "without losing one meaningful response round.",
             "agentid-pro/server_pro.py  _depth >= 2",
             "done"),
            ("Owner instruction refresh (real-time)",
             "Brain fetches latest 5 human direct-messages on every _reply_for() call. "
             "Instructions sent mid-conversation take effect on the next group reply "
             "without any restart.",
             "agentid-pro/server_pro.py  owner_context DB fetch in _reply_for()",
             "done"),
            ("Group view flicker fix",
             "renderFeed() early-return when group room is active prevents the "
             "30-second setInterval from overwriting the group chat feed with empty state.",
             "agentid/docs/messages.html  renderFeed()",
             "done"),
            ("DM brain dedup + tool_call_id fix",
             "_brain_send_reply dedup guard (30s window). "
             "OpenAI tool_call_id normalization — fixes 400 errors when OpenAI "
             "returns id='id' literal as a placeholder.",
             "agentid-pro/server_pro.py  _brain_send_reply()",
             "done"),
        ]),
        ("Phase 4", "Multi-Provider + Tool Use", GREEN, [
            ("Provider abstraction layer",
             "LLMProvider ABC with three adapters:\n"
             "AnthropicProvider (Claude), OpenAIProvider (GPT-4o, Grok, Mistral, "
             "Ollama, Groq, Together), GeminiProvider (Google).\n"
             "Swap providers with zero other code changes.",
             "agentid/sdk/python/agentid/brain/providers/\n"
             "  base.py, anthropic.py, openai.py, gemini.py",
             "done"),
            ("Agentic judgment loop",
             "LLM researches with tools before deciding. Up to 8 rounds of "
             "tool-call → result → reasoning. Force-answer pass on timeout.",
             "agentid/sdk/python/agentid/brain/judgment/engine.py",
             "done"),
            ("WebSearchTool",
             "Brave Search API (free tier, 2000 queries/month). "
             "DuckDuckGo fallback when no key provided.",
             "agentid/sdk/python/agentid/brain/tools/web_search.py",
             "done"),
            ("FetchURLTool",
             "Fetches any URL. Strips HTML to readable text. "
             "Handles JSON, RSS/XML, plain text. Truncates with configurable limit.",
             "agentid/sdk/python/agentid/brain/tools/fetch_url.py",
             "done"),
            ("MCPSession bridge",
             "Connects to any MCP server (stdio subprocess or HTTP) and exposes "
             "its tools as Tool instances. Works with all providers.\n"
             "brain.add_mcp_server('npx', ['-y', '@mcp/server-brave-search'])",
             "agentid/sdk/python/agentid/brain/tools/mcp.py",
             "done"),
        ]),
        ("v0.9.0 / P0", "Bug Fix Sprint — 8 Critical Fixes (2026-05-11)", GREEN, [
            ("B1: capability_contracts search column index off-by-two",
             "_SELECT_COLS_CC selects 22 columns (indices 0-21). "
             "search_contracts joined a.name making it index 22 (not 20). "
             "_row_to_contract(row[:20]) → row[:22]; contract['agent_name'] = row[20] → row[22]. "
             "Prevented agent_name from ever appearing in search results.",
             "agentid-pro/capability_contracts.py  search_contracts + _row_to_contract",
             "done"),
            ("B2: psycopg2 datetime not a string — fromisoformat crash",
             "psycopg2 returns Python datetime objects for TIMESTAMPTZ columns, not strings. "
             "_compute_trust_score() called .replace('Z', ...) on a datetime object → AttributeError. "
             "Fixed with isinstance(v, datetime) guard; covers tz-naive datetimes too. "
             "Imported datetime, timezone from datetime module.",
             "agentid-pro/trust_score.py  _compute_trust_score created_at parsing",
             "done"),
            ("B3: trust score cache unbounded memory growth",
             "_SCORE_CACHE dict grew forever — one entry per DID, never evicted. "
             "Added _CACHE_MAX=2000 cap. _cache_get() / _cache_set() helpers. "
             "_cache_set() evicts the oldest 200 entries when limit hit. "
             "Both get_trust_score() callsites updated.",
             "agentid-pro/trust_score.py  _CACHE_MAX + _cache_get + _cache_set",
             "done"),
            ("B4: TOCTOU race in task queue depth check",
             "SELECT COUNT(*) then INSERT was not atomic — two concurrent submitters "
             "could both read depth=N&lt;cap and both insert, exceeding the cap. "
             "Fixed with single CTE: WITH queue_check AS (SELECT COUNT(*) FOR UPDATE) "
             "INSERT ... SELECT FROM queue_check WHERE depth &lt; cap RETURNING task_id. "
             "0 rows returned → cap exceeded → 429.",
             "agentid-pro/agent_task_requests.py  create_task_request CTE",
             "done"),
            ("B5: POLP prefix check reversed — siblings incorrectly allowed",
             "_check_polp() had: capability == s OR s.startswith(capability + '-'). "
             "s.startswith(capability+'-') means a scope of 'research-summary' allowed "
             "any 'research-*' call — backwards. Only the caller should be able to call "
             "narrower capabilities, not broader ones. "
             "Fixed to: capability == s OR capability.startswith(s + '-'). "
             "Exact match OR caller's capability starts with declared scope.",
             "agentid-pro/capability_contracts.py  _check_polp()",
             "done"),
            ("B6: trust score formula used raw sum not weighted average",
             "total_score was summing raw D1-D5 signals and dividing by 5 "
             "instead of using the documented weighted formula. "
             "Fixed to: d1*0.20 + d2*0.25 + d3*0.20 + d4*0.20 + d5*0.15 "
             "(weights sum to 1.0, D2 highest weight = reliability matters most). "
             "Clamped to [0, 100] with min/max.",
             "agentid-pro/trust_score.py  total_score weighted formula",
             "done"),
            ("B7: conn.rollback() inside transaction aborts all sub-queries",
             "trust_score.py had 11 bare conn.rollback() calls inside optional sub-queries. "
             "In psycopg2 autocommit=False, rollback() aborts the entire outer transaction — "
             "all subsequent queries in that connection fail with InFailedSqlTransaction. "
             "Fixed: replaced all 11 with named SAVEPOINTs. "
             "12 savepoints: sp_liveness, sp_activity, sp_badge, sp_deprecated, sp_revoked, "
             "sp_compromised, sp_complaints, sp_signing, sp_rotation, sp_tasks, sp_uptime, sp_sla_breach.",
             "agentid-pro/trust_score.py  11 SAVEPOINT replacements",
             "done"),
            ("B8: brain wake retry ignores task status — re-wakes completed tasks",
             "_notify_task_via_message() re-woke the brain after 6s unconditionally. "
             "If task was already completed in that window, _agent_brain_cycle() re-read it "
             "as pending and ran an extra cycle. "
             "Fixed: retry reads current task status before waking brain; "
             "only proceeds if status is still 'pending'.",
             "agentid-pro/agent_task_requests.py  _notify_task_via_message retry",
             "done"),
        ]),
        ("v0.9.0 / F1", "Trajectory — Structured Execution Audit Log (2026-05-11)", GREEN, [
            ("trajectory_events table + schema",
             "New table: id UUID PK, agent_did TEXT NOT NULL, session_id TEXT, "
             "action_type TEXT NOT NULL, direction TEXT, peer_did TEXT, "
             "payload_summary JSONB, outcome TEXT, error_code TEXT, "
             "duration_ms INTEGER, created_at TIMESTAMPTZ. "
             "4 indexes: (agent_did, created_at DESC), session_id, action_type, peer_did.",
             "agentid-pro/trajectory.py  init_trajectory_schema()",
             "done"),
            ("19 action types + record_trajectory()",
             "ACTION_TYPES: message_sent, message_received, task_sent, task_received, "
             "task_completed, task_failed, capability_called, contract_published, "
             "scope_violation, brain_cycle, key_rotated, trust_event, peer_attested, "
             "file_uploaded, webhook_registered, group_joined, agent_registered, "
             "capability_invoked, identity_verified. "
             "record_trajectory() sanitises payload (redacts key/secret/token/password/private/credential), "
             "never raises — trajectory is always best-effort.",
             "agentid-pro/trajectory.py  record_trajectory()",
             "done"),
            ("3 REST endpoints",
             "GET /pro/agents/{did}/trajectory — paginated event log (limit/offset/action_type filters). "
             "GET /pro/agents/{did}/trajectory/summary — grouped action counts + date range. "
             "GET /pro/agents/{did}/trajectory/export — NDJSON download with "
             "Content-Disposition: attachment; filename=trajectory_{did}.ndjson.",
             "agentid-pro/trajectory.py  router",
             "done"),
            ("Hooks wired into server_pro.py",
             "_record_traj() thin wrapper (never raises). "
             "Hooks: message_sent in send_agent_message, task_received in _notify_task_via_message, "
             "task_completed and task_failed in _brain_execute_task, "
             "scope_violation in _record_scope_violation.",
             "agentid-pro/server_pro.py  _record_traj() + 5 hook sites",
             "done"),
        ]),
        ("v0.9.0 / F2", "Dreaming — Background Memory Consolidation (2026-05-11)", GREEN, [
            ("run_dreaming_cycle() + _dream_agent()",
             "Dreaming compresses old thread summaries (>30 days) into a single "
             "consolidated memory row using an LLM call (Anthropic or OpenAI, max_tokens=600). "
             "run_dreaming_cycle(limit=100) iterates agents with AI config. "
             "_dream_agent() fetches old summaries + existing consolidated row, "
             "calls LLM with 200-400 word compression prompt, atomically DELETEs old rows "
             "and INSERTs one __dreaming_consolidated__ row with source_count metadata.",
             "agentid-pro/dreaming.py  run_dreaming_cycle() + _dream_agent()",
             "done"),
            ("Tunables + age buckets",
             "OLD_THRESHOLD_DAYS=30, MID_THRESHOLD_DAYS=7, MIN_OLD_TO_CONSOLIDATE=2, "
             "MAX_SUMMARIES_PER_PROMPT=20. Age buckets: recent (<7d), mid (7-30d), old (>30d). "
             "Only old bucket entries are candidates for compression. "
             "Existing __dreaming_consolidated__ row is merged back into the next compression "
             "ensuring idempotent re-runs and preventing unbounded growth.",
             "agentid-pro/dreaming.py  tunables",
             "done"),
            ("get_dream_stats() + 3 REST endpoints",
             "GET /pro/agents/{did}/dream/stats — total/consolidated/recent/mid/old counts + last_dream_at. "
             "POST /pro/agents/{did}/dream/run — trigger dreaming for a specific agent. "
             "POST /pro/internal/dream/run-all — admin trigger for full dreaming cycle. "
             "Scheduler: runs every 360 ticks (~6h) in _global_proactive_scheduler.",
             "agentid-pro/dreaming.py  get_dream_stats() + router\nagentid-pro/server_pro.py  scheduler hook",
             "done"),
        ]),
        ("v0.9.0 / F3", "Task Flow Registry — Multi-Step Workflow Engine (2026-05-11)", GREEN, [
            ("3 workflow tables",
             "workflow_definitions: id UUID, owner, name, description, steps JSONB, is_active. "
             "workflow_runs: id UUID, workflow_id, owner, initiator_did, status, current_step, "
             "step_outputs JSONB, final_output JSONB, error_message, started_at, completed_at. "
             "workflow_run_tasks: run_id, step_idx, task_id (links workflow steps to task API).",
             "agentid-pro/task_workflows.py  init_workflow_schema()",
             "done"),
            ("StepDef model + _resolve_inputs()",
             "StepDef Pydantic model: capability, target_did, title, input_map dict, "
             "static_inputs dict, timeout_seconds=300, on_failure='abort'|'skip'. "
             "_resolve_inputs() supports JSONPath-style mapping: "
             "$.step_index.field reads from step_outputs[step_index][field]; "
             "$.initial.field reads from initial_inputs.",
             "agentid-pro/task_workflows.py  StepDef + _resolve_inputs()",
             "done"),
            ("advance_run() — linear step execution",
             "advance_run(task_id, output, success) looks up run by task_id in workflow_run_tasks, "
             "saves step output to step_outputs[step_idx], dispatches next step or marks run complete. "
             "on_failure='skip' continues to next step; on_failure='abort' fails the run. "
             "_dispatch_task() inserts directly to DB (no HTTP) then calls _notify_task_via_message. "
             "Called from _brain_execute_task at task completion/failure.",
             "agentid-pro/task_workflows.py  advance_run()\nagentid-pro/server_pro.py  _wf_advance_run() hooks",
             "done"),
            ("CRUD + run endpoints",
             "POST /pro/workflows — create definition. "
             "GET /pro/workflows — list (owner-scoped). "
             "GET /pro/workflows/{id} — get definition. "
             "POST /pro/workflows/{id}/run — start run with initiator_did + initial_inputs. "
             "GET /pro/workflows/runs/{run_id} — poll run status + step_outputs.",
             "agentid-pro/task_workflows.py  router",
             "done"),
        ]),
        ("v0.9.0 / F4", "Commitments — Agent Promise Tracking (2026-05-11)", GREEN, [
            ("agent_commitments table",
             "id UUID PK, agent_did, target_did, body TEXT NOT NULL, due_at TIMESTAMPTZ, "
             "status (pending/fulfilled/broken/cancelled), ref_task_id, ref_message_id, "
             "trust_event_id, created_at, resolved_at. "
             "Indexes on (agent_did, status), due_at, ref_task_id.",
             "agentid-pro/commitments.py  init_commitments_schema()",
             "done"),
            ("extract_commitments_from_text() — heuristic extraction",
             "9 commitment phrase patterns (I'll, I will, will deliver/send/complete/finish/provide/submit/have). "
             "5 deadline patterns (within N minutes/hours/days, in N X, before N X, by [day name], SLA: N s). "
             "Splits into sentences, checks each for phrase + deadline combo, returns max 3 per message. "
             "No LLM required — zero latency on outbound message path.",
             "agentid-pro/commitments.py  extract_commitments_from_text()",
             "done"),
            ("sweep_broken_commitments() + fulfill_commitment_by_task()",
             "sweep_broken_commitments(): finds pending commitments past due_at, marks broken, "
             "calls _record_trust_event(delta=-2.0, event_type='commitment_broken'). "
             "fulfill_commitment_by_task(): on task completion, finds pending commitments "
             "for that task_id and agent_did, marks fulfilled, "
             "calls _record_trust_event(delta=+0.5, event_type='commitment_fulfilled'). "
             "Scheduler: sweep runs every 30 ticks (~30 min).",
             "agentid-pro/commitments.py  sweep + fulfill\nagentid-pro/server_pro.py  scheduler + task hook",
             "done"),
            ("Commitment extraction wired into send_agent_message",
             "After message INSERT, extract_commitments_from_text() runs in a background thread "
             "(never blocks the HTTP response). Extracted commitments inserted into agent_commitments "
             "with ref_message_id. target_did = message recipient.",
             "agentid-pro/server_pro.py  send_agent_message commitment thread",
             "done"),
            ("CRUD REST endpoints",
             "GET /pro/agents/{did}/commitments — list (status filter). "
             "GET /pro/agents/{did}/commitments/{id} — get one. "
             "PATCH /pro/agents/{did}/commitments/{id} — manually resolve (fulfilled/cancelled). "
             "POST /pro/agents/{did}/commitments — manually create commitment.",
             "agentid-pro/commitments.py  router",
             "done"),
        ]),
        ("v0.9.0 / F5", "ACP Action Approvals — Runtime Human Oversight (2026-05-11)", GREEN, [
            ("2 ACP tables",
             "acp_policies: id, owner, agent_did, action_category, threshold_field, "
             "threshold_op (gt/gte/eq/always), threshold_value, is_active. "
             "acp_approval_queue: id, policy_id, agent_did, owner, action_category, "
             "action_payload JSONB, resume_payload JSONB, status, reviewer_note, "
             "expires_at (TTL 24h), created_at, resolved_at. "
             "6 ACTION_CATEGORIES: message_broadcast, high_value_task, contract_publish, "
             "external_call, file_upload, capability_invoke.",
             "agentid-pro/action_approvals.py  init_acp_schema()",
             "done"),
            ("check_action_policy() — fail-open gate",
             "Looks up active policies for agent_did + action_category. "
             "_policy_matches() evaluates threshold_op against action_payload field. "
             "On match: inserts approval_queue row, notifies owner via agent_messages INSERT, "
             "returns {proceed: False, approval_id, status: 'pending_approval', expires_at}. "
             "On no match: returns {proceed: True}. "
             "Catches ALL exceptions and returns {proceed: True} — availability > strict gating.",
             "agentid-pro/action_approvals.py  check_action_policy()",
             "done"),
            ("ACP gate in send_agent_message",
             "check_action_policy() called before the message INSERT. "
             "If {proceed: False}: raises HTTPException(202, detail={approval info}). "
             "202 Accepted signals caller that message is queued for approval, not rejected. "
             "Owner receives a DM notification with approval_id and resume instructions.",
             "agentid-pro/server_pro.py  send_agent_message ACP block",
             "done"),
            ("sweep_expired_approvals() + CRUD endpoints",
             "sweep_expired_approvals(): marks status='expired' for pending items past expires_at. "
             "Runs every 30 ticks alongside sweep_broken_commitments(). "
             "POST /pro/acp/policies — create policy. "
             "GET /pro/acp/policies — list policies (owner-scoped). "
             "GET /pro/acp/queue — list pending approvals. "
             "POST /pro/acp/queue/{id}/approve — approve (proceed with action). "
             "POST /pro/acp/queue/{id}/deny — deny (action dropped). "
             "DELETE /pro/acp/policies/{id} — deactivate policy.",
             "agentid-pro/action_approvals.py  sweep + router",
             "done"),
        ]),
        ("v1.0 / OCB0", "OpenClaw Execution Bias — Block 0: ACP Gap Fix + Prompt Rewrite (2026-05-11)", GREEN, [
            ("ACP gap fixed in _brain_send_reply()",
             "Brain reply path bypassed action approval check. Added _check_action_policy() call "
             "BEFORE the message INSERT in _brain_send_reply(). On ACP hold: logs approval_id, "
             "calls _audit(), returns without inserting — message queued for human approval. "
             "flow_id also passed through to ACP queue entry for cross-table tracing.",
             "agentid-pro/server_pro.py  _brain_send_reply()",
             "done"),
            ("Execution Bias prompt rewrite",
             "Brain system prompt rewritten with EXECUTION BIAS block: 'Act in this turn. Use your "
             "tools. Do not reply with a plan or promise when tools can move it forward.' "
             "INTERMEDIARY ROLE collapsed from 2-option hedge to single mandate. ask_clarification "
             "description updated to 'max 1 precise question — not preferences'. "
             "Rule 3: prefer research_then_reply over ask_clarification if you can look it up. "
             "Hard override B: ask_clarification on task_notification forces reply with ACK text.",
             "agentid-pro/server_pro.py  system_prompt block",
             "done"),
        ]),
        ("v1.0 / OCB2", "OpenClaw Block 2: ask_clarification Rate Limit (2026-05-11)", GREEN, [
            ("agent_clarification_log table",
             "New table: id BIGSERIAL, agent_did, partner_did, asked_at TIMESTAMPTZ. "
             "Index on (agent_did, partner_did, asked_at). "
             "_init_clarification_rate_limit_schema() called at startup. "
             "_purge_clarification_log() deletes entries &gt;24h — runs every 30min in scheduler.",
             "agentid-pro/server_pro.py  _init_clarification_rate_limit_schema()",
             "done"),
            ("Rate limit dispatch gate",
             "_check_clarification_rate_limit(agent_did, partner_did): COUNT WHERE asked_at &gt; "
             "NOW()-1h &lt; 2. Fail-open (returns True on DB error). "
             "_log_clarification_ask(): INSERT — never raises. "
             "In brain dispatch: if over limit → force best-effort reply instead of asking. "
             "questions[:1] enforced (was [:3] — fixed to match 'max 1 question' in prompt).",
             "agentid-pro/server_pro.py  ask_clarification branch",
             "done"),
        ]),
        ("v1.0 / OCB3", "OpenClaw Block 3: Decision Trace (2026-05-11)", GREEN, [
            ("Brain cycle trajectory expansion",
             "After _mark_brain_processed: record_trajectory() called with expanded payload_summary "
             "including msg_count, decisions[] array (msg_id, action, from_did, reasoning[:200], "
             "score), memory_updates count, thread_updates count, cycle_ms (monotonic), provider. "
             "Max 20 decisions per cycle to cap payload size. "
             "_cycle_start_ms captured at _run() start for accurate duration measurement.",
             "agentid-pro/server_pro.py  step 8b decision trace",
             "done"),
        ]),
        ("v1.0 / OCB4", "OpenClaw Block 4: Bootstrap Files (2026-05-11)", GREEN, [
            ("agent_bootstrap table + schema",
             "Table: agent_did + name PRIMARY KEY; name CHECK IN ('SOUL','MISSION','STYLE','TOOLS'); "
             "content TEXT; updated_at TIMESTAMPTZ. Index on agent_did. "
             "init_agent_bootstrap_schema() called at startup. MAX_CONTENT_BYTES=4096.",
             "agentid-pro/agent_bootstrap.py  init_agent_bootstrap_schema()",
             "done"),
            ("get_bootstrap_prefix() injection",
             "get_bootstrap_prefix(agent_did): SELECT ordered by CASE WHEN SOUL=1..TOOLS=4. "
             "Prepends '## NAME\\ncontent' blocks separated by blank lines, ends with '---\\n'. "
             "Injected at top of system_prompt: _bootstrap_prefix + system_prompt. "
             "Never raises — returns '' on any DB error (fail-open).",
             "agentid-pro/server_pro.py + agent_bootstrap.py",
             "done"),
            ("Bootstrap CRUD endpoints",
             "GET /pro/agents/{did}/bootstrap — list all 4 slots with exists flag. "
             "GET /pro/agents/{did}/bootstrap/{name} — get one slot. "
             "PUT /pro/agents/{did}/bootstrap/{name} — upsert (4096 byte cap enforced). "
             "DELETE /pro/agents/{did}/bootstrap/{name} — clear slot. "
             "All endpoints owner-guarded via _assert_bootstrap_owner().",
             "agentid-pro/agent_bootstrap.py  router",
             "done"),
        ]),
        ("v1.0 / OCB5", "OpenClaw Block 5: Mission / Heartbeat Ticks (2026-05-11)", GREEN, [
            ("agent_missions table + schema",
             "Table: id UUID PK, agent_did, owner, name, mission_text (max 4096 bytes), "
             "cron_expr, is_active, last_fired_at, next_fire_at TIMESTAMPTZ NOT NULL, "
             "created_at, updated_at. Indexes: idx_missions_due (next_fire_at WHERE is_active), "
             "idx_missions_agent (agent_did).",
             "agentid-pro/missions.py  init_missions_schema()",
             "done"),
            ("fire_due_missions() — race-safe scheduler",
             "SELECT FOR UPDATE SKIP LOCKED (no double-fire with concurrent instances). "
             "All: advance next_fire_at + INSERT mission_tick in same transaction. "
             "Unparseable cron_expr → deactivate mission (not crash). "
             "every:Ns/m/h/d format (min 60s). POSIX cron via croniter (optional). "
             "Minimum interval checked for POSIX cron too (2-fire-gap check). "
             "Called every 60s from _mcp_session_cleanup_loop.",
             "agentid-pro/missions.py  fire_due_missions()",
             "done"),
            ("mission_tick brain handling",
             "msg_type='mission_tick' recognized in brain messages_text with MISSION TICK header. "
             "is_mission_tick flag set in dispatch loop. "
             "Hard enforcement: ask_clarification on mission_tick → force research_then_reply "
             "(derive search_query from subject/body). "
             "Hard enforcement: ignore on mission_tick → force reply. "
             "LLM failure: mission_tick treated as retryable (same as task_notification). "
             "Brain action prompt note: mission_tick = act immediately, never ask_clarification.",
             "agentid-pro/server_pro.py  brain dispatch block",
             "done"),
            ("Mission CRUD endpoints",
             "POST /pro/agents/{did}/missions (201) — create with schedule validation. "
             "GET /pro/agents/{did}/missions — list all missions. "
             "PATCH /pro/agents/{did}/missions/{id} — update name/text/schedule/active. "
             "DELETE /pro/agents/{did}/missions/{id} — delete. "
             "POST /pro/agents/{did}/missions/{id}/fire — manual trigger for testing "
             "(advances next_fire_at to prevent immediate scheduler re-fire). "
             "All owner-guarded via _assert_mission_agent_owner().",
             "agentid-pro/missions.py  router",
             "done"),
        ]),
        ("v1.0 / UI", "Customer-Facing UI: Bootstrap, Missions, Approvals, Flow Trace, Contracts (2026-05-11)", GREEN, [
            ("Brain Bootstrap editor — my-agents.html",
             "🧬 Brain button added to every agent row in My Agents. "
             "Modal has 4 tabs: SOUL / MISSION / STYLE / TOOLS. "
             "Loads all 4 files in parallel on open (GET /pro/agents/{did}/bootstrap/{name}). "
             "PUT /pro/agents/{did}/bootstrap/{name} on Save. "
             "Character counter shows 4096-byte limit per file.",
             "agentid/docs/my-agents.html",
             "done"),
            ("Missions manager — my-agents.html",
             "⏰ Missions button added to every agent row. "
             "Modal shows list of existing missions: name, schedule, next/last fire, "
             "Pause/Resume/Fire Now/Delete controls. "
             "Create form: name, instructions textarea, schedule preset dropdown "
             "(every:1h → every:7d + custom cron input). "
             "Calls GET/POST/PATCH/DELETE /pro/agents/{did}/missions + POST .../fire.",
             "agentid/docs/my-agents.html",
             "done"),
            ("ACP Approval Queue — dashboard.html",
             "New 'Approvals' nav item (with live badge count for pending items) added to Dashboard sidebar. "
             "Section shows approval list with status filter (pending/approved/denied). "
             "Each pending item shows: category, agent DID, payload (collapsible), timestamp. "
             "Approve / Deny buttons with optional reviewer note textarea. "
             "Calls GET /pro/acp/queue, POST /pro/approvals/{id}/approve|deny.",
             "agentid/docs/dashboard.html, agentid/docs/dashboard.js",
             "done"),
            ("Flow Trace modal — tasks.html",
             "Task detail modal gains 'Flow Trace' button (shown when task has flow_id). "
             "Flow modal displays an ordered timeline of all events in the flow: "
             "messages (💬), task requests (📋), capability calls (⚡), ACP approvals (🛡). "
             "Each event shows type, icon, timestamp, and a type-specific detail line. "
             "Calls GET /pro/flows/{flow_id}.",
             "agentid/docs/tasks.html",
             "done"),
            ("Capability Contracts tab — tasks.html (FIXED)",
             "Tasks / Contracts tab toggle added to the pane header. "
             "'Contracts' tab shows a table of capability contracts published by the selected agent. "
             "FIXED: loadContracts() now calls GET /agents/{did}/capability-contracts (not search endpoint). "
             "FIXED: deactivateContract() passes capability name string (not UUID) to "
             "DELETE /agents/{did}/capability-contracts/{capability}. "
             "FIXED: publishContract() posts to POST /agents/{did}/capability-contracts.",
             "agentid/docs/tasks.html",
             "done"),
            ("contracts.html — standalone Contracts page",
             "New page: agentid/docs/contracts.html. "
             "Tab 1 (My Contracts): loads all contracts across all owned agents via GET /pro/contracts. "
             "Stats row: total, active, challenge-passed, publishing-agents count. "
             "Click any row to see full contract detail modal (schema, SLA, pricing, signature, URL). "
             "Deactivate button on each row. "
             "Tab 2 (Marketplace Search): public capability contract discovery. "
             "Publish modal: agent dropdown + all contract fields. "
             "Auth: same x-api-key pattern as other pages. "
             "Nav link to contracts.html added to: dashboard.html, my-agents.html, tasks.html, messages.html.",
             "agentid/docs/contracts.html",
             "done"),
            ("Sub-accounts (Team) backend — sub_accounts.py",
             "New file: agentid-pro/sub_accounts.py. "
             "account_members table: id, parent_owner, email, label, api_key_hash, permissions JSONB, is_active, timestamps. "
             "Permission model: {agents: 'all'|[...DIDs], features: [...]}. "
             "Routes: GET/POST /pro/account/members, GET/PATCH/DELETE /pro/account/members/{id}, "
             "POST /pro/account/members/{id}/rotate-key. "
             "check_sub_account_permission() helper enforces agent + feature scoping. "
             "resolve_sub_account_by_key() for sub-account auth (sk-sub- prefix keys). "
             "Wired into server_pro.py startup + router. "
             "Settings → Team/Sub-accounts tab in dashboard.html + JS in dashboard.js.",
             "agentid-pro/sub_accounts.py, agentid/docs/dashboard.html, agentid/docs/dashboard.js",
             "done"),
            ("API inconsistencies fixed",
             "dashboard.js: _denyAction() POST /reject (was /deny). "
             "dashboard.js: password change → /auth/change-password (was /auth/password/change). "
             "dashboard.js: status labels updated to match backend (rejected/expired). "
             "action_approvals.py: GET /pro/acp/queue owner-level endpoint added. "
             "server_pro.py: GET /pro/dashboard endpoint added (owner, email, tier, counts). "
             "capability_contracts.py: GET /pro/contracts owner-level listing added. "
             "agent_task_requests.py: flow_id added to _get_task() and list_tasks() response.",
             "agentid/docs/dashboard.js, agentid-pro/action_approvals.py, "
             "agentid-pro/server_pro.py, agentid-pro/capability_contracts.py, "
             "agentid-pro/agent_task_requests.py",
             "done"),
            ("Bug fixes: NaN dims, footprint, auth, key errors, trust breakdown",
             "network.js: trust dimensions showed NaN — backend now returns {score, trend_30d} "
             "objects not plain numbers; extract .score before Math.round(). "
             "Handle all capability_trust shapes: number | {score:N} | {cap:score,...}. "
             "dashboard.js: footprint _initFootprintTab() added _fpTabInited guard (event "
             "listeners stacked on every tab switch); _fpLoadSummary() now called directly. "
             "PDF download + Create Team Key: fixed Invalid or missing API key — raw fetch "
             "used only in-memory apiKey (empty in cookie/session mode); now uses full "
             "fallback chain + credentials:include; _createTeamKey converted to apiFetch(). "
             "Login: write key to localStorage.agentid_key on login, clear on logout — "
             "enables cross-tab access for contracts/tasks/messages/my-agents pages. "
             "Trust score breakdown: replaced old 7-signal panel (signals don't add up to "
             "D1-D5 weighted total) with new D1-D5 view: each dim score/100, weight %, "
             "colour bar, trend arrow (↑/↓ from trend_30d), formula note. "
             "contracts.html: auth fallback now also reads localStorage.agentid_key so "
             "page auto-signs in when opened in a new tab.",
             "agentid/docs/dashboard.js, agentid/docs/network.js, agentid/docs/contracts.html",
             "done"),
            ("PDF Report Download (Pro/Enterprise)",
             "report_pdf.py: POST /pro/reports/pdf endpoint. "
             "ReportLab-based generation with branded header/footer + cover page. "
             "7 selectable sections: agents, trust_scores, contracts, tasks, messages, approvals, analytics. "
             "Agent scope: 'all' or a list of specific DIDs. "
             "Optional title and date_range (filters time-bound sections). "
             "Tier-gated: Pro/Enterprise only (403 for free). "
             "StreamingResponse with Content-Disposition attachment filename. "
             "Dashboard: pdf-btn now opens report modal (was hardcoded analytics endpoint). "
             "Modal: 7 section checkboxes with select-all toggle, "
             "agent scope radios (all / specific with lazy-loaded checklist), "
             "optional title input, optional date range pickers, error display. "
             "_submitReportDownload() POSTs JSON body, handles blob download with filename from CD header. "
             "report_pdf_router wired into server_pro.py.",
             "agentid-pro/report_pdf.py, agentid-pro/server_pro.py, "
             "agentid/docs/dashboard.html, agentid/docs/dashboard.js",
             "done"),
        ]),
        ("v1.0 / OCB6", "OpenClaw Block 6: flow_id Cross-Table Tracing (2026-05-11)", GREEN, [
            ("flow_id column added to 4 tables",
             "ALTER TABLE ... ADD COLUMN IF NOT EXISTS flow_id TEXT on: "
             "agent_messages (server_pro.py startup), "
             "acp_approval_queue (action_approvals.py init), "
             "agent_task_requests (agent_task_requests.py init), "
             "capability_call_logs (capability_contracts.py init). "
             "GIN/btree index on each: idx_*_flow_id WHERE flow_id IS NOT NULL.",
             "server_pro.py, action_approvals.py, agent_task_requests.py, capability_contracts.py",
             "done"),
            ("flow_id propagation through brain",
             "_get_unprocessed_messages() now SELECTs flow_id — fixes multi-hop chain propagation. "
             "_msg_flow_id = msg.get('flow_id') or str(uuid.uuid4()) computed per message in dispatch loop. "
             "_brain_send_reply(flow_id=None) stores flow_id in INSERT. "
             "All 8 _brain_send_reply() calls in dispatch pass flow_id=_msg_flow_id. "
             "_brain_execute_task(flow_id=None) added; stamps flow_id on task row (UPDATE WHERE flow_id IS NULL). "
             "ACP check_action_policy(flow_id=None) stores flow_id in approval_queue INSERT.",
             "agentid-pro/server_pro.py, action_approvals.py",
             "done"),
            ("GET /pro/flows/{flow_id} reconstruction endpoint",
             "flows.py: ownership check runs BEFORE data queries (CRITICAL security fix). "
             "_check_flow_ownership() uses EXISTS queries across all 4 tables with LIMIT 1 — fast. "
             "Returns 404 (not 403) to avoid leaking flow_id existence. "
             "UUID format validation before any DB hit (prevents full-table scans). "
             "Queries 4 tables, merges, sorts oldest-first (None ts → '9999-99-99' sentinel). "
             "Returns: {flow_id, total, messages, tasks, cap_calls, approvals, events[]}.",
             "agentid-pro/flows.py",
             "done"),
        ]),
    ]

    STATUS_COLORS = {"done": GREEN, "in-progress": ORANGE, "todo": GREY}

    for phase, section_title, color, items in built_sections:
        story += [
            sp(10),
            KeepTogether([
                Table([[
                    Paragraph(phase, style("ph", fontName="Helvetica-Bold", fontSize=8, textColor=WHITE)),
                    Paragraph(section_title, style("pt", fontName="Helvetica-Bold", fontSize=11, textColor=WHITE)),
                ]], colWidths=[0.75*inch, 6.05*inch]),
            ]),
        ]

        header_row = ["Feature", "Description", "File(s)", "Status"]
        rows = [header_row]
        for name, desc, files, status in items:
            rows.append([
                Paragraph(name, style("fn", fontName="Helvetica-Bold", fontSize=8, textColor=DARK)),
                Paragraph(desc, style("fd", fontName="Helvetica", fontSize=8, textColor=DARK, leading=12)),
                Paragraph(files, style("ff", fontName="Courier", fontSize=7, textColor=DARK, leading=11)),
                Paragraph(status.upper(), style("fs", fontName="Helvetica-Bold", fontSize=7,
                          textColor=STATUS_COLORS.get(status, GREY))),
            ])

        tbl = Table(rows, colWidths=[1.35*inch, 2.55*inch, 2.3*inch, 0.6*inch])
        tbl.setStyle(TableStyle([
            ("BACKGROUND",    (0,0),(-1,0),  color),
            ("TEXTCOLOR",     (0,0),(-1,0),  WHITE),
            ("FONTNAME",      (0,0),(-1,0),  "Helvetica-Bold"),
            ("FONTSIZE",      (0,0),(-1,0),  8),
            ("ROWBACKGROUNDS",(0,1),(-1,-1), [WHITE, LGREY]),
            ("GRID",          (0,0),(-1,-1), 0.3, colors.HexColor("#e5e7eb")),
            ("TOPPADDING",    (0,0),(-1,-1), 5),
            ("BOTTOMPADDING", (0,0),(-1,-1), 5),
            ("LEFTPADDING",   (0,0),(-1,-1), 6),
            ("VALIGN",        (0,0),(-1,-1), "TOP"),
        ]))
        story += [tbl, sp(8)]

    # ── What needs to be built ─────────────────────────────────────────────────
    story += [PageBreak(), Paragraph("What Needs to Be Built", H1), divider()]

    todo_items = [
        ("HIGH", "Precision trigger + system prompt",
         "Currently LLM searches on every trigger cycle. Need a two-phase approach: "
         "cheap detection (price threshold, news signal) triggers deep research only "
         "when something material happens. Update system prompt to skip research when "
         "perceptions already have sufficient context.",
         "brain/judgment/engine.py  +  brain/brain.py"),

        ("HIGH", "SDK documentation + examples",
         "Write README for agentid.brain and agentid.runtime. Create example scripts "
         "for common use cases: oil market monitor, code security watcher, "
         "competitor tracker. Add docstrings to all public classes.",
         "agentid/sdk/python/README.md  +  examples/"),

        ("HIGH", "Publish SDK to PyPI (v0.6.0)",
         "Package agentid-protocol v0.6.0 (canonical 8-symbol API now done). "
         "Test install: pip install agentid-protocol. "
         "Verify all entry points work. Set up PyPI publish step in ci.yml on tag push. "
         "Also publish mcp-agentid v0.1.0 to PyPI as a separate package.",
         "agentid/sdk/python/pyproject.toml  +  agentid/.github/workflows/ci.yml\n"
         "agentid/mcp-agentid/pyproject.toml  (ready for publish)"),

        ("MEDIUM", "Custom tool templates",
         "Pre-built tool classes for common domains: StockPriceTool (Yahoo Finance / "
         "Alpha Vantage), NewsTool (Reuters RSS), EarningsTool (SEC EDGAR). "
         "Users instantiate and pass to brain — no HTTP wiring needed.",
         "agentid/sdk/python/agentid/brain/tools/finance.py  etc."),

        ("MEDIUM", "Admin dashboard",
         "Web UI to manage agents, view brain activity logs, configure triggers "
         "and tools without touching code. Scoped to agentid-pro + agentid/docs.",
         "agentid-pro/  +  agentid/docs/admin.html"),

        ("MEDIUM", "Agent-to-agent collaboration patterns",
         "Standard patterns for: task delegation, consensus judgment (multiple brains "
         "vote), capability marketplace (brain finds and hires specialist agents). "
         "Build on top of find_and_contact action.",
         "agentid/sdk/python/agentid/brain/  +  server_pro.py"),


        ("LOW", "Brain monitoring + observability",
         "Dashboard showing: trigger fire history, tool calls made, judgments, "
         "actions taken, token cost per cycle. Helps tune trigger cadence.",
         "New: agentid/docs/brain-monitor.html"),

        ("LOW", "Deal finalization workflow",
         "Structured negotiation protocol between agents: proposal → counter-proposal "
         "→ acceptance → on-chain record. Both OpenAI and Anthropic code paths required.",
         "agentid-pro/server_pro.py  +  agentid/sdk/python/agentid/brain/"),
    ]

    priority_colors = {"HIGH": RED, "MEDIUM": ORANGE, "LOW": GREY}

    rows = [["Pri", "Feature", "Description", "Target Files"]]
    for pri, name, desc, files in todo_items:
        rows.append([
            Paragraph(pri, style("tp", fontName="Helvetica-Bold", fontSize=8,
                      textColor=priority_colors.get(pri, GREY))),
            Paragraph(name, style("tn", fontName="Helvetica-Bold", fontSize=8, textColor=DARK)),
            Paragraph(desc, style("td", fontName="Helvetica", fontSize=8, textColor=DARK, leading=12)),
            Paragraph(files, style("tf", fontName="Courier", fontSize=7, textColor=DARK, leading=11)),
        ])

    tbl = Table(rows, colWidths=[0.45*inch, 1.45*inch, 3.1*inch, 1.8*inch])
    tbl.setStyle(TableStyle([
        ("BACKGROUND",    (0,0),(-1,0),  DARK),
        ("TEXTCOLOR",     (0,0),(-1,0),  WHITE),
        ("FONTNAME",      (0,0),(-1,0),  "Helvetica-Bold"),
        ("FONTSIZE",      (0,0),(-1,0),  8),
        ("ROWBACKGROUNDS",(0,1),(-1,-1), [WHITE, LGREY]),
        ("GRID",          (0,0),(-1,-1), 0.3, colors.HexColor("#e5e7eb")),
        ("TOPPADDING",    (0,0),(-1,-1), 5),
        ("BOTTOMPADDING", (0,0),(-1,-1), 5),
        ("LEFTPADDING",   (0,0),(-1,-1), 6),
        ("VALIGN",        (0,0),(-1,-1), "TOP"),
    ]))
    story += [tbl, sp(16)]

    # ── Version changelog ──────────────────────────────────────────────────────
    story += [PageBreak(), Paragraph("Version Changelog", H1), divider(),
              Paragraph(
                  "Every SDK release that produced documentation changes is recorded here. "
                  "Update CHANGELOG in generate_docs.py after each session with code changes "
                  "and re-run: <font face='Courier'>python3 generate_docs.py</font>", BODY),
              sp(8)]

    cl_rows = [["Version", "Date", "What changed"]]
    for ver, date, notes in CHANGELOG:
        cl_rows.append([
            Paragraph(ver,   style("clv", fontName="Helvetica-Bold", fontSize=8, textColor=BLUE)),
            Paragraph(date,  style("cld", fontName="Helvetica",      fontSize=8, textColor=GREY)),
            Paragraph(notes, style("cln", fontName="Helvetica",      fontSize=8, textColor=DARK, leading=12)),
        ])

    cl_tbl = Table(cl_rows, colWidths=[0.6*inch, 0.85*inch, 5.35*inch])
    cl_tbl.setStyle(TableStyle([
        ("BACKGROUND",    (0,0),(-1,0),  DARK),
        ("TEXTCOLOR",     (0,0),(-1,0),  WHITE),
        ("FONTNAME",      (0,0),(-1,0),  "Helvetica-Bold"),
        ("FONTSIZE",      (0,0),(-1,0),  8),
        ("ROWBACKGROUNDS",(0,1),(-1,-1), [WHITE, LGREY]),
        ("GRID",          (0,0),(-1,-1), 0.3, colors.HexColor("#e5e7eb")),
        ("TOPPADDING",    (0,0),(-1,-1), 5),
        ("BOTTOMPADDING", (0,0),(-1,-1), 5),
        ("LEFTPADDING",   (0,0),(-1,-1), 7),
        ("VALIGN",        (0,0),(-1,-1), "TOP"),
    ]))
    story += [cl_tbl, sp(16)]

    # ── Existing PDF index ─────────────────────────────────────────────────────
    story += [Paragraph("Document Index", H1), divider(),
              Paragraph("All AgentID technical documents are stored in:", BODY),
              Paragraph("/Users/bereket/Documents/AgentID_Docs/", CODE),
              sp(8)]

    docs = [
        ["Filename", "Topic", "Status"],
        ["00_Master_Tracker.pdf",              "This document — full build tracker",                            "Current"],
        ["01_Autonomous_Search_ReAct.pdf",     "When/why agents search — ReAct pattern, two-phase detection",  "Current"],
        ["AgentID_Runtime_Layer_Plan.pdf",     "Runtime SDK design (long-poll, webhook, CLI)",                  "Older — see SDK code"],
        ["AgentID_Auto_Register_Webhook.pdf",  "Webhook auto-connect design",                                   "Older — see runtime/webhook.py"],
        ["AgentID_Admin_Guide.pdf",            "Admin operations guide",                                        "Older"],
        ["AgentID_Strategic_Review.pdf",       "Strategic vision document",                                     "Older"],
        ["AgentID_Todo_List.pdf",              "Original 85+ task checklist",                                   "Superseded by this doc"],
    ]

    dtbl = Table(docs, colWidths=[2.5*inch, 3.2*inch, 1.1*inch])
    dtbl.setStyle(TableStyle([
        ("BACKGROUND",    (0,0),(-1,0),  DARK),
        ("TEXTCOLOR",     (0,0),(-1,0),  WHITE),
        ("FONTNAME",      (0,0),(-1,0),  "Helvetica-Bold"),
        ("FONTSIZE",      (0,0),(-1,-1), 8.5),
        ("FONTNAME",      (0,1),(-1,-1), "Helvetica"),
        ("ROWBACKGROUNDS",(0,1),(-1,-1), [WHITE, LGREY]),
        ("GRID",          (0,0),(-1,-1), 0.3, colors.HexColor("#e5e7eb")),
        ("TOPPADDING",    (0,0),(-1,-1), 5),
        ("BOTTOMPADDING", (0,0),(-1,-1), 5),
        ("LEFTPADDING",   (0,0),(-1,-1), 7),
        ("VALIGN",        (0,0),(-1,-1), "TOP"),
    ]))
    story += [dtbl]

    doc.build(story, onFirstPage=hdr, onLaterPages=hdr)
    print(f"✓  {path}")


# ══════════════════════════════════════════════════════════════════════════════
# PDF 2 — AUTONOMOUS SEARCH / ReAct
# ══════════════════════════════════════════════════════════════════════════════

def build_react_doc():
    path = os.path.join(OUT, "01_Autonomous_Search_ReAct.pdf")
    doc = SimpleDocTemplate(
        path, pagesize=letter,
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=0.9*inch, bottomMargin=0.65*inch,
    )

    def hdr(canvas, doc):
        header_block(canvas, doc, "Autonomous Search — ReAct Pattern", "01")

    story = []

    # Cover
    story += [
        sp(30),
        Paragraph("AgentBrain", style("c2", fontName="Helvetica-Bold", fontSize=11, textColor=TEAL)),
        sp(4),
        Paragraph("When and Why Agents Search", TITLE),
        divider(TEAL, 2),
        Paragraph(
            "A clear explanation of how the brain decides when to call web_search, "
            "when to wake up at all, and what the ReAct pattern means in practice. "
            "Includes the current gap and what needs to be built next.",
            SUBTITLE),
        sp(4),
        Paragraph(f"{DATE}  ·  SDK v0.5.0  ·  Generated {GENERATED}", META),
        PageBreak(),
    ]

    # 1. The core question
    story += [
        Paragraph("1. The Core Question", H1), divider(),
        Paragraph(
            "The user asked: <i>\"Does the agent search randomly, or does it know when to search?\"</i>",
            BODY),
        sp(4),
        Paragraph(
            "Short answer: <b>not randomly.</b> There are two completely separate "
            "decisions happening, and understanding them is key to building a "
            "precise, cost-efficient autonomous agent.", BODY),
        sp(12),
    ]

    two_decisions = [
        ["Decision", "Who makes it?", "Cost", "Question answered"],
        ["When to wake up",  "Trigger layer\n(our Python code,\nno LLM involved)",
         "Free\n(timer / lightweight check)", "Is it time to check anything?"],
        ["Whether to search", "The LLM\n(during judgment cycle)",
         "Paid\n(LLM tokens + search API)",  "Do I have enough context\nto make a decision?"],
    ]
    t = Table(two_decisions, colWidths=[1.4*inch, 1.7*inch, 1.55*inch, 2.15*inch])
    t.setStyle(TableStyle([
        ("BACKGROUND",    (0,0),(-1,0),  DARK),
        ("TEXTCOLOR",     (0,0),(-1,0),  WHITE),
        ("FONTNAME",      (0,0),(-1,0),  "Helvetica-Bold"),
        ("FONTSIZE",      (0,0),(-1,-1), 8.5),
        ("FONTNAME",      (0,1),(-1,-1), "Helvetica"),
        ("ROWBACKGROUNDS",(0,1),(-1,-1), [WHITE, LGREY]),
        ("GRID",          (0,0),(-1,-1), 0.4, colors.HexColor("#e5e7eb")),
        ("TOPPADDING",    (0,0),(-1,-1), 6),
        ("BOTTOMPADDING", (0,0),(-1,-1), 6),
        ("LEFTPADDING",   (0,0),(-1,-1), 8),
        ("VALIGN",        (0,0),(-1,-1), "TOP"),
    ]))
    story += [t, sp(16)]

    # 2. The trigger layer
    story += [
        Paragraph("2. Decision 1 — When to Wake Up (Triggers)", H1), divider(),
        Paragraph(
            "Triggers are pure Python — no LLM, no API cost. They define "
            "<i>when the brain runs a cycle</i>, not what it does.", BODY),
        sp(8),
    ]

    triggers = [
        ["Trigger", "When it fires", "Best for", "Code"],
        ["IntervalTrigger",  "Every N seconds (min 10s)",
         "Regular monitoring\ne.g. every 30 min",
         "IntervalTrigger(seconds=1800)"],
        ["DailyTrigger",     "Once per day at a UTC time",
         "Daily reports\ne.g. 9am market open",
         "DailyTrigger(hour=9, minute=0)"],
        ["OnChangeTrigger",  "Only when a perception\nsource reports changed=True",
         "Event-driven\ne.g. price spike, new commit",
         "OnChangeTrigger(perception,\n  poll_interval=60)"],
    ]
    t = Table(triggers, colWidths=[1.3*inch, 1.4*inch, 1.5*inch, 2.6*inch])
    t.setStyle(TableStyle([
        ("BACKGROUND",    (0,0),(-1,0),  TEAL),
        ("TEXTCOLOR",     (0,0),(-1,0),  WHITE),
        ("FONTNAME",      (0,0),(-1,0),  "Helvetica-Bold"),
        ("FONTSIZE",      (0,0),(-1,-1), 8),
        ("FONTNAME",      (0,1),(-1,-1), "Helvetica"),
        ("ROWBACKGROUNDS",(0,1),(-1,-1), [WHITE, LGREY]),
        ("GRID",          (0,0),(-1,-1), 0.4, colors.HexColor("#e5e7eb")),
        ("TOPPADDING",    (0,0),(-1,-1), 6),
        ("BOTTOMPADDING", (0,0),(-1,-1), 6),
        ("LEFTPADDING",   (0,0),(-1,-1), 7),
        ("VALIGN",        (0,0),(-1,-1), "TOP"),
        ("FONTNAME",      (0,1),(-1,-1),  "Courier") if False else ("LEFTPADDING", (3,1), (3,-1), 7),
    ]))
    story += [t, sp(16)]

    # 3. The ReAct pattern
    story += [
        Paragraph("3. Decision 2 — Whether to Search (The ReAct Pattern)", H1), divider(),
        Paragraph(
            "Once awake, the brain calls the LLM. The model uses the "
            "<b>ReAct pattern</b> (Reason + Act) — alternating between "
            "reasoning about what it knows and taking actions to fill gaps.", BODY),
        sp(8),
        Paragraph("The loop in plain English:", H2),
        Paragraph(
            "1.  LLM reads: mission + perceptions + memory context<br/>"
            "2.  LLM reasons: <i>\"Do I have enough information to judge this?\"</i><br/>"
            "3a. If YES: output JSON judgment directly — no search needed<br/>"
            "3b. If NO:  call web_search(query) or fetch_url(url)<br/>"
            "4.  LLM reads the tool result<br/>"
            "5.  Back to step 2 — repeat up to 8 rounds<br/>"
            "6.  Final output: {should_act, reasoning, summary, actions[]}",
            BODY),
        sp(10),
        Paragraph("What drives the LLM to search:", H2),
    ]

    drivers = [
        ["Driver", "Example", "LLM behaviour"],
        ["Mission",    "\"Monitor oil markets\"",
         "LLM knows it needs current data — searches every wake-up "
         "because its training data is not real-time"],
        ["Perceptions", "GitPerception shows new commit\nwith unfamiliar library",
         "LLM searches for CVEs related to\nthat library before judging severity"],
        ["Memory",     "Note: \"OPEC meeting Thursday\"",
         "LLM searches for OPEC outcome\non Friday — context from prior cycle"],
        ["Gap in knowledge", "No perceptions configured,\ntool-only mode",
         "LLM always searches — it has no\ndata without tools"],
    ]
    t = Table(drivers, colWidths=[1.1*inch, 2.1*inch, 3.6*inch])
    t.setStyle(TableStyle([
        ("BACKGROUND",    (0,0),(-1,0),  DARK),
        ("TEXTCOLOR",     (0,0),(-1,0),  WHITE),
        ("FONTNAME",      (0,0),(-1,0),  "Helvetica-Bold"),
        ("FONTSIZE",      (0,0),(-1,-1), 8.5),
        ("FONTNAME",      (0,1),(-1,-1), "Helvetica"),
        ("ROWBACKGROUNDS",(0,1),(-1,-1), [WHITE, LGREY]),
        ("GRID",          (0,0),(-1,-1), 0.4, colors.HexColor("#e5e7eb")),
        ("TOPPADDING",    (0,0),(-1,-1), 6),
        ("BOTTOMPADDING", (0,0),(-1,-1), 6),
        ("LEFTPADDING",   (0,0),(-1,-1), 8),
        ("VALIGN",        (0,0),(-1,-1), "TOP"),
    ]))
    story += [t, sp(16)]

    # 4. Two-phase model
    story += [
        PageBreak(),
        Paragraph("4. The Right Architecture — Two-Phase Intelligence", H1), divider(),
        Paragraph(
            "The current system has a gap: the LLM searches on <i>every</i> trigger cycle, "
            "even when nothing changed. The correct model uses two phases:", BODY),
        sp(10),
    ]

    phases = [
        ["Phase", "What happens", "Cost", "Example"],
        ["1 — Detection\n(cheap)",
         "A lightweight check asks:\n\"Did anything material change?\"\n"
         "No LLM. Just a number comparison\nor RSS feed check.",
         "Near-zero\n(one HTTP call)",
         "Oil price API: did Brent move\nmore than 3% in the last hour?"],
        ["2 — Research\n(expensive)",
         "Only triggered by Phase 1.\nLLM uses web_search + fetch_url\n"
         "to understand WHY and WHAT to do.",
         "LLM tokens\n+ search API",
         "\"Oil dropped 8%. Let me search\nfor the cause before alerting.\""],
    ]
    t = Table(phases, colWidths=[1.0*inch, 2.6*inch, 1.1*inch, 2.1*inch])
    t.setStyle(TableStyle([
        ("BACKGROUND",    (0,0),(-1,0),  ORANGE),
        ("TEXTCOLOR",     (0,0),(-1,0),  WHITE),
        ("FONTNAME",      (0,0),(-1,0),  "Helvetica-Bold"),
        ("FONTSIZE",      (0,0),(-1,-1), 8.5),
        ("FONTNAME",      (0,1),(-1,-1), "Helvetica"),
        ("ROWBACKGROUNDS",(0,1),(-1,-1), [WHITE, LGREY]),
        ("GRID",          (0,0),(-1,-1), 0.4, colors.HexColor("#e5e7eb")),
        ("TOPPADDING",    (0,0),(-1,-1), 6),
        ("BOTTOMPADDING", (0,0),(-1,-1), 6),
        ("LEFTPADDING",   (0,0),(-1,-1), 8),
        ("VALIGN",        (0,0),(-1,-1), "TOP"),
    ]))
    story += [t, sp(14)]

    story += [
        Paragraph("How this maps to the existing trigger system:", H2),
        Paragraph(
            "Phase 1 is an <b>OnChangeTrigger</b> wrapping a cheap perception source "
            "(a price API that only returns changed=True when the threshold is crossed). "
            "Phase 2 is the normal LLM judgment cycle that fires when the trigger activates.",
            BODY),
        sp(8),
        Paragraph("Oil market example — correct setup:", H3),
        Paragraph(
            "brain.add_trigger(\n"
            "    OnChangeTrigger(\n"
            "        APIPerception(url='https://api.prices.com/brent',\n"
            "                      extract='price', threshold=3.0),\n"
            "        poll_interval=60,   # cheap: checks every 60s\n"
            "    )\n"
            ")\n"
            "# LLM only wakes when oil moved >3% -- not every hour",
            CODE),
        sp(16),
    ]

    # 5. What needs to be built
    story += [
        Paragraph("5. What Needs to Be Built", H1), divider(),
        Paragraph(
            "The current system is architecturally correct but needs these improvements "
            "to become production-grade:", BODY),
        sp(8),
    ]

    next_steps = [
        ("1", "Threshold support in APIPerception",
         "Add a threshold= parameter so the perception only reports changed=True "
         "when a numeric value moves past a configured amount.\n"
         "e.g. threshold=3.0 means 3% change required to trigger.",
         "brain/perception/api.py"),
        ("2", "Smarter system prompt",
         "Update the system prompt to say: if perceptions already have sufficient "
         "context, output the JSON judgment directly without calling any tools. "
         "This prevents unnecessary searching when GitPerception or APIPerception "
         "already provided complete data.",
         "brain/judgment/engine.py\n_SYSTEM_PROMPT constant"),
        ("3", "Cost tracking in BrainMemory",
         "Record how many tool calls and LLM tokens were used per cycle. "
         "Helps users tune their trigger cadence and identify expensive missions.",
         "brain/memory/store.py"),
        ("4", "Pre-built detection perceptions",
         "PricePerception(ticker, threshold%) — wraps Yahoo Finance or Alpha Vantage.\n"
         "NewsTitlePerception(query) — polls RSS feeds, fires only on new articles.",
         "brain/perception/price.py\nbrain/perception/news.py"),
    ]

    rows = [["Step", "What to build", "Why", "File"]]
    for step, name, desc, files in next_steps:
        rows.append([
            Paragraph(step, style("sn", fontName="Helvetica-Bold", fontSize=12,
                      textColor=TEAL, alignment=TA_CENTER)),
            Paragraph(name, style("nn", fontName="Helvetica-Bold", fontSize=8.5, textColor=DARK)),
            Paragraph(desc, style("nd", fontName="Helvetica", fontSize=8.5, textColor=DARK, leading=13)),
            Paragraph(files, style("nf", fontName="Courier", fontSize=7.5, textColor=DARK, leading=12)),
        ])

    tbl = Table(rows, colWidths=[0.4*inch, 1.6*inch, 3.05*inch, 1.75*inch])
    tbl.setStyle(TableStyle([
        ("BACKGROUND",    (0,0),(-1,0),  DARK),
        ("TEXTCOLOR",     (0,0),(-1,0),  WHITE),
        ("FONTNAME",      (0,0),(-1,0),  "Helvetica-Bold"),
        ("FONTSIZE",      (0,0),(-1,0),  8),
        ("ROWBACKGROUNDS",(0,1),(-1,-1), [WHITE, LGREY]),
        ("GRID",          (0,0),(-1,-1), 0.3, colors.HexColor("#e5e7eb")),
        ("TOPPADDING",    (0,0),(-1,-1), 6),
        ("BOTTOMPADDING", (0,0),(-1,-1), 6),
        ("LEFTPADDING",   (0,0),(-1,-1), 7),
        ("VALIGN",        (0,0),(-1,-1), "TOP"),
    ]))
    story += [tbl]

    doc.build(story, onFirstPage=hdr, onLaterPages=hdr)
    print(f"✓  {path}")


# ── Run ────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print(f"\nGenerating AgentID docs → {OUT}\n")
    build_tracker()
    build_react_doc()
    print("\nDone. Open AgentID_Docs/ to view all documents.\n")
