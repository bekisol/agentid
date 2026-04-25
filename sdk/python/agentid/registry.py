import json
import os
from dataclasses import asdict
from pathlib import Path
from typing import Optional

DEFAULT_DIR = Path.home() / ".agentid"


class Registry:
    def __init__(self, path: str = None):
        base = Path(path) if path else DEFAULT_DIR
        self.db_path = base / "registry.json"
        self.keys_dir = base / "keys"
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.keys_dir.mkdir(parents=True, exist_ok=True)

    # ── persistence ──────────────────────────────────────────────────────────

    def _read(self) -> dict:
        if not self.db_path.exists():
            return {}
        with open(self.db_path) as f:
            return json.load(f)

    def _write(self, db: dict):
        with open(self.db_path, "w") as f:
            json.dump(db, f, indent=2)

    def _key_path(self, did: str) -> Path:
        return self.keys_dir / (did.replace(":", "_") + ".key")

    # ── public API ───────────────────────────────────────────────────────────

    def register(self, document, private_key_bytes: bytes):
        db = self._read()
        db[document.did] = asdict(document)
        self._write(db)

        key_file = self._key_path(document.did)
        key_file.write_bytes(private_key_bytes)
        os.chmod(key_file, 0o600)

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
