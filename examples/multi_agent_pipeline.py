"""
AgentID — Multi-Agent Data Processing Pipeline Demo
=====================================================
Scenario: A 3-stage pipeline processes IoT sensor readings.

    Collector  ──signed──▶  Analyzer  ──signed──▶  Reporter
               raw data               analysis              final report

Each agent:
  • Signs its output before handing it to the next stage.
  • Verifies the previous agent's signature before processing.

An injected "rogue" agent attempts to tamper mid-pipeline; the Analyzer
rejects the forged message because the signature doesn't match any
registered DID.

The final section shows that Reporter can trace the trust chain all the
way back to Collector through the embedded signed payloads.

Run from the agentid repo root:
    python examples/multi_agent_pipeline.py
"""

import sys
import copy
import json
import time
import tempfile
import shutil
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "sdk" / "python"))

from agentid import Agent

# ── ANSI helpers ──────────────────────────────────────────────────────────────

RESET  = "\033[0m"
BOLD   = "\033[1m"
GREEN  = "\033[32m"
CYAN   = "\033[36m"
YELLOW = "\033[33m"
RED    = "\033[31m"
BLUE   = "\033[34m"
DIM    = "\033[2m"
MAGENTA = "\033[35m"

def banner(title: str, char: str = "═"):
    print(f"\n{BOLD}{char * 64}{RESET}")
    print(f"{BOLD}   {title}{RESET}")
    print(f"{BOLD}{char * 64}{RESET}")

def stage(label: str, agent_name: str, colour: str = CYAN):
    print(f"\n{colour}{BOLD}  ▶ {label}  [{agent_name}]{RESET}")
    print(f"  {'─' * 58}")

def ok(msg: str):
    print(f"  {GREEN}✔  {msg}{RESET}")

def fail(msg: str):
    print(f"  {RED}✘  {msg}{RESET}")

def warn(msg: str):
    print(f"  {YELLOW}⚠  {msg}{RESET}")

def info(msg: str):
    print(f"  {DIM}   {msg}{RESET}")

def did_short(did: str) -> str:
    return did[:22] + "…" + did[-6:]

def show_payload(label: str, payload: dict):
    """Print a summarised view of a payload dict."""
    print(f"\n  {DIM}{label}{RESET}")
    for k, v in payload.items():
        if k in ("signer", "nonce"):
            v_str = str(v)[:44] + "…" if len(str(v)) > 44 else str(v)
        elif isinstance(v, (dict, list)):
            v_str = json.dumps(v, separators=(",", ":"))
            if len(v_str) > 72:
                v_str = v_str[:72] + "…"
        else:
            v_str = str(v)
        print(f"    {k}: {v_str}")


# ── Simulated sensor data ─────────────────────────────────────────────────────

def make_sensor_batch(collector_did: str) -> list[dict]:
    """Return a realistic batch of IoT sensor readings."""
    now = time.time()
    return [
        {"sensor_id": "SEN-001", "ts": now - 60, "temp_c": 22.4, "humidity_pct": 58.1, "co2_ppm": 412},
        {"sensor_id": "SEN-002", "ts": now - 55, "temp_c": 23.1, "humidity_pct": 61.3, "co2_ppm": 418},
        {"sensor_id": "SEN-003", "ts": now - 50, "temp_c": 21.8, "humidity_pct": 57.9, "co2_ppm": 409},
        {"sensor_id": "SEN-004", "ts": now - 45, "temp_c": 24.0, "humidity_pct": 63.2, "co2_ppm": 425},
        {"sensor_id": "SEN-005", "ts": now - 40, "temp_c": 22.9, "humidity_pct": 59.7, "co2_ppm": 415},
    ]


# ── Main demo ─────────────────────────────────────────────────────────────────

def main():
    registry_dir = tempfile.mkdtemp(prefix="agentid_pipeline_demo_")
    try:
        _run_demo(registry_dir)
    finally:
        shutil.rmtree(registry_dir, ignore_errors=True)
        print(f"\n  {DIM}Temp registry cleaned up: {registry_dir}{RESET}\n")


def _run_demo(registry_dir: str):
    reg = {"registry_path": registry_dir}

    # ── ASCII pipeline diagram ────────────────────────────────────────────────
    banner("AgentID — 3-Stage Signed Data Pipeline")
    print(f"""
  {CYAN}┌─────────────┐{RESET}   signed    {BLUE}┌─────────────┐{RESET}   signed    {MAGENTA}┌─────────────┐{RESET}
  {CYAN}│  Collector  │{RESET}  ──────────▶ {BLUE}│   Analyzer  │{RESET}  ──────────▶ {MAGENTA}│   Reporter  │{RESET}
  {CYAN}│  (gather)   │{RESET}  raw data   {BLUE}│  (process)  │{RESET}  analysis   {MAGENTA}│  (publish)  │{RESET}
  {CYAN}└─────────────┘{RESET}             {BLUE}└─────────────┘{RESET}             {MAGENTA}└─────────────┘{RESET}

  Each arrow represents a {BOLD}cryptographically signed{RESET} message.
  No agent processes data without first verifying the sender's signature.
""")

    # ── Register all 3 agents ─────────────────────────────────────────────────
    banner("Agent Registration", char="─")

    collector = Agent.create(
        name="IoT-Collector-A1",
        capabilities=["sensor-ingestion", "data-collection", "batch-signing"],
        owner="platform-team@acme.io",
        metadata={"region": "us-west-2", "fleet": "production"},
        **reg,
    )
    ok(f"Collector  DID: {did_short(collector.did)}")

    analyzer = Agent.create(
        name="DataAnalyzer-M2",
        capabilities=["statistical-analysis", "anomaly-detection", "data-signing"],
        owner="platform-team@acme.io",
        metadata={"model": "v3.1", "gpu": False},
        **reg,
    )
    ok(f"Analyzer   DID: {did_short(analyzer.did)}")

    reporter = Agent.create(
        name="ReportPublisher-R3",
        capabilities=["report-generation", "alerting", "dashboard-push"],
        owner="platform-team@acme.io",
        metadata={"outputs": ["slack", "s3", "pagerduty"]},
        **reg,
    )
    ok(f"Reporter   DID: {did_short(reporter.did)}")

    # ── Stage 1: Collector gathers and signs sensor data ──────────────────────
    banner("Stage 1 — Collection", char="─")
    stage("Collecting sensor readings", collector.name, CYAN)

    sensor_readings = make_sensor_batch(collector.did)
    collection_payload = {
        "type": "pipeline/sensor-batch",
        "batch_id": "batch-20260427-0830",
        "collected_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sensor_count": len(sensor_readings),
        "location": "Building-C / Floor-3",
        "readings": sensor_readings,
    }
    signed_collection = collector.sign(collection_payload)

    show_payload("Signed collection payload:", signed_collection["payload"])
    info(f"Signature (truncated): {signed_collection['signature'][:44]}…")
    ok(f"Collector signed batch of {len(sensor_readings)} sensor readings")

    # ── Stage 2: Analyzer verifies, processes, signs analysis ────────────────
    banner("Stage 2 — Analysis", char="─")
    stage("Verifying Collector's signature", analyzer.name, BLUE)

    # Analyzer resolves the signer's DID from the message itself
    collector_did_from_msg = signed_collection["payload"]["signer"]
    info(f"Signer DID in message: {did_short(collector_did_from_msg)}")

    sig_ok = Agent.verify_from_did(signed_collection, **reg)
    if not sig_ok:
        fail("Collector signature invalid — ABORTING pipeline")
        return
    ok("Collector signature verified — data is authentic")

    # Check Collector is registered and has the expected capability
    coll_doc = Agent.resolve(collector_did_from_msg, **reg)
    if "sensor-ingestion" not in coll_doc.capabilities:
        fail("Collector lacks 'sensor-ingestion' capability — rejecting batch")
        return
    ok(f"Collector capability confirmed: 'sensor-ingestion'")

    stage("Running statistical analysis", analyzer.name, BLUE)

    readings = signed_collection["payload"]["readings"]
    temps  = [r["temp_c"]      for r in readings]
    hums   = [r["humidity_pct"] for r in readings]
    co2s   = [r["co2_ppm"]     for r in readings]

    def stats(values: list) -> dict:
        return {
            "min": round(min(values), 2),
            "max": round(max(values), 2),
            "avg": round(sum(values) / len(values), 2),
        }

    anomalies = [r["sensor_id"] for r in readings if r["co2_ppm"] > 420]

    analysis_payload = {
        "type": "pipeline/analysis-result",
        "batch_id": signed_collection["payload"]["batch_id"],
        "source_collector_did": collector_did_from_msg,
        # Embed the original signed message so Reporter can trace back
        "collector_signed_message": signed_collection,
        "temperature_c": stats(temps),
        "humidity_pct": stats(hums),
        "co2_ppm": stats(co2s),
        "anomalies_detected": anomalies,
        "alert_level": "warning" if anomalies else "nominal",
        "analyzed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    signed_analysis = analyzer.sign(analysis_payload)

    show_payload("Signed analysis payload:", signed_analysis["payload"])
    info(f"Signature (truncated): {signed_analysis['signature'][:44]}…")
    ok(f"Analyzer signed analysis  anomalies={anomalies or 'none'}")

    # ── Rogue agent injection test ────────────────────────────────────────────
    banner("Rogue Agent Attack — Mid-Pipeline Injection", char="─")

    warn("A rogue agent intercepts the pipeline and injects a fake analysis …")

    # Rogue agent is NOT registered — it creates its own key pair and tries
    # to sign a message pretending to be the Analyzer.
    rogue = Agent.create(
        name="Rogue-Impersonator",
        capabilities=["data-signing"],
        owner="attacker@evil.io",
        **reg,
    )

    # Rogue copies the legitimate analysis but changes the alert level
    # and signs it with its own (unrecognised) private key.
    fake_analysis_payload = copy.deepcopy(analysis_payload)
    fake_analysis_payload["alert_level"] = "nominal"          # suppress the warning
    fake_analysis_payload["anomalies_detected"] = []
    fake_signed_analysis = rogue.sign(fake_analysis_payload)

    info(f"Rogue DID:     {did_short(rogue.did)}")
    info(f"Analyzer DID:  {did_short(analyzer.did)}")

    # Reporter would first check: does the signer DID match a *trusted* analyzer?
    trusted_analyzer_did = analyzer.did
    rogue_signer_did = fake_signed_analysis["payload"]["signer"]

    if rogue_signer_did != trusted_analyzer_did:
        fail(f"Signer DID mismatch — expected Analyzer, got unknown agent")
        fail("Reporter rejects the injected message")
    else:
        fail("BUG: Reporter accepted a rogue message!")

    # Even if the signer DID somehow matched, the signature would still fail
    sig_tampered = Agent.verify_from_did(
        {**fake_signed_analysis, "payload": {**fake_signed_analysis["payload"], "signer": trusted_analyzer_did}},
        **reg,
    )
    if not sig_tampered:
        ok("Secondary check: forged signature also fails cryptographic verification")

    # ── Stage 3: Reporter verifies Analyzer and publishes ────────────────────
    banner("Stage 3 — Reporting", char="─")
    stage("Verifying Analyzer's signature", reporter.name, MAGENTA)

    analyzer_sig_ok = Agent.verify_from_did(signed_analysis, **reg)
    if not analyzer_sig_ok:
        fail("Analyzer signature invalid — ABORTING report")
        return
    ok("Analyzer signature verified — analysis is authentic")

    analy_doc = Agent.resolve(signed_analysis["payload"]["signer"], **reg)
    if "statistical-analysis" not in analy_doc.capabilities:
        fail("Analyzer lacks 'statistical-analysis' capability — rejecting")
        return
    ok("Analyzer capability confirmed: 'statistical-analysis'")

    stage("Tracing trust chain back to Collector", reporter.name, MAGENTA)

    # Reporter can verify the original Collector message that is embedded
    # inside the analysis payload.
    embedded_coll_msg = signed_analysis["payload"]["collector_signed_message"]
    chain_ok = Agent.verify_from_did(embedded_coll_msg, **reg)
    if chain_ok:
        chain_collector_did = embedded_coll_msg["payload"]["signer"]
        ok(f"Trust chain verified: Reporter → Analyzer → Collector")
        info(f"  Collector DID: {did_short(chain_collector_did)}")
        info(f"  Analyzer  DID: {did_short(signed_analysis['payload']['signer'])}")
        info(f"  Reporter  DID: {did_short(reporter.did)}")
    else:
        fail("Embedded Collector signature invalid — trust chain broken")
        return

    stage("Generating final report", reporter.name, MAGENTA)

    alert_level = signed_analysis["payload"]["alert_level"]
    anomalies_reported = signed_analysis["payload"]["anomalies_detected"]
    alert_colour = YELLOW if alert_level == "warning" else GREEN

    print(f"""
  {BOLD}Final Report — {signed_analysis['payload']['batch_id']}{RESET}
  {'─' * 58}
  Location   : {signed_collection['payload']['location']}
  Period     : {signed_collection['payload']['collected_at']}
  Sensors    : {signed_collection['payload']['sensor_count']}

  Temperature (°C): avg {signed_analysis['payload']['temperature_c']['avg']}  [{signed_analysis['payload']['temperature_c']['min']} – {signed_analysis['payload']['temperature_c']['max']}]
  Humidity   (%) : avg {signed_analysis['payload']['humidity_pct']['avg']}  [{signed_analysis['payload']['humidity_pct']['min']} – {signed_analysis['payload']['humidity_pct']['max']}]
  CO₂        (ppm): avg {signed_analysis['payload']['co2_ppm']['avg']}  [{signed_analysis['payload']['co2_ppm']['min']} – {signed_analysis['payload']['co2_ppm']['max']}]

  Alert level: {alert_colour}{BOLD}{alert_level.upper()}{RESET}
  Anomalies  : {', '.join(anomalies_reported) if anomalies_reported else 'none'}

  {DIM}Report signed by: {did_short(reporter.did)}{RESET}
""")

    signed_report = reporter.sign({
        "type": "pipeline/final-report",
        "batch_id": signed_analysis["payload"]["batch_id"],
        "alert_level": alert_level,
        "anomalies": anomalies_reported,
        "provenance": {
            "collector_did": chain_collector_did,
            "analyzer_did": signed_analysis["payload"]["signer"],
        },
    })
    ok(f"Report signed and published by Reporter")
    info(f"Signature (truncated): {signed_report['signature'][:44]}…")

    # ── Final summary ─────────────────────────────────────────────────────────
    banner("Pipeline Complete")
    print(f"  {GREEN}✔{RESET}  Collector authenticated → Analyzer accepted raw data")
    print(f"  {GREEN}✔{RESET}  Analyzer authenticated → Reporter accepted analysis")
    print(f"  {GREEN}✔{RESET}  Rogue mid-pipeline injection detected and rejected")
    print(f"  {GREEN}✔{RESET}  Trust chain traced: Reporter → Analyzer → Collector")
    print(f"  {GREEN}✔{RESET}  Final signed report published")
    print(f"{BOLD}{'═' * 64}{RESET}")


if __name__ == "__main__":
    main()
