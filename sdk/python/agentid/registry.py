import json
import os
import re
from dataclasses import asdict
from pathlib import Path
from typing import Optional

DEFAULT_DIR = Path.home() / ".agentid"


class Registry:
    def __init__(self, path: str = None):
        base = Path(path) if path else DEFAULT_DIR
        self.db_path = base / "registry.json"
        self.keys_dir = base / "keys"
        self.db_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.keys_dir.mkdir(parents=True, exist_ok=True, mode=0o700)

    # ── persistence ──────────────────────────────────────────────────────────

    def _read(self) -> dict:
        if not self.db_path.exists():
            return {}
        with open(self.db_path) as f:
            return json.load(f)

    def _write(self, db: dict):
        # Fix #13 — write atomically with restrictive permissions
        tmp = self.db_path.parent / f".{self.db_path.name}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, json.dumps(db, indent=2).encode())
        finally:
            os.close(fd)
        tmp.replace(self.db_path)
        os.chmod(self.db_path, 0o600)

    def _key_path(self, did: str) -> Path:
        # Security fix: sanitize DID to prevent path traversal
        # (e.g. did:agentid:../../../../tmp/evil → safe filename)
        safe = re.sub(r"[^a-zA-Z0-9_\-]", "_", did)
        path = (self.keys_dir / (safe + ".key")).resolve()
        # Ensure the resolved path stays within the keys directory
        try:
            path.relative_to(self.keys_dir.resolve())
        except ValueError:
            raise ValueError(f"Path traversal attempt blocked for DID: {did!r}")
        return path

    # ── public API ───────────────────────────────────────────────────────────

    def register(self, document, private_key_bytes: bytes):
        db = self._read()
        db[document.did] = asdict(document)
        self._write(db)

        # Fix #6 — create key file with restrictive permissions atomically
        key_file = self._key_path(document.did)
        fd = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, private_key_bytes)
        finally:
            os.close(fd)

    def get(self, did: str) -> Optional[dict]:
        return self._read().get(did)

    def load_private_key(self, did: str) -> Optional[bytes]:
        key_file = self._key_path(did)
        return key_file.read_bytes() if key_file.exists() else None

    def search(self, capability: str = None, owner: str = None, name: str = None) -> list[dict]:
        results = []
        for doc in self._read().values():
            if capability and capability not in doc.get("capabilities", []):
                continue
            if owner and doc.get("owner") != owner:
                continue
            if name and name.lower() not in doc.get("name", "").lower():
                continue
            results.append(doc)
        return results

    def deregister(self, did: str):
        db = self._read()
        db.pop(did, None)
        self._write(db)
        key_file = self._key_path(did)
        if key_file.exists():
            key_file.unlink()
