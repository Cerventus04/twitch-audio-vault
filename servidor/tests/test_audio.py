"""Comprueba los bytes que sirve /audio y el filtro de origen.

    python tests/test_audio.py

Usa una carpeta temporal: no toca config.json ni las grabaciones de verdad.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="vault-test-"))
os.environ["VAULT_CONFIG"] = str(TMP / "config.json")
os.environ["VAULT_AUDIO_DIR"] = str(TMP)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from vault import db, server  # noqa: E402

DATOS = bytes([0xFF]) + bytes(i % 251 for i in range(1, 1000))  # 1000 bytes, "AAC"


def preparar() -> int:
    audio = TMP / "prueba.aac"
    audio.write_bytes(DATOS)
    db.init()
    with db.tx() as conn:
        cur = conn.execute(
            "INSERT INTO recordings (login, capture_start, path, status) "
            "VALUES ('x', '2026-01-01T00:00:00+00:00', ?, 'done')",
            (str(audio),),
        )
        return cur.lastrowid


def main() -> None:
    rid = preparar()
    c = TestClient(server.app)  # sin `with`: no arranca el vigilante

    def rango(r: str):
        return c.get(f"/audio/{rid}", headers={"Range": r})

    assert c.get(f"/audio/{rid}").content == DATOS
    r = rango("bytes=0-9")
    assert r.status_code == 206 and r.content == DATOS[:10]
    assert r.headers["content-range"] == "bytes 0-9/1000"
    assert rango("bytes=990-").content == DATOS[990:]
    assert rango("bytes=-5").content == DATOS[-5:]
    assert rango("bytes=995-5000").content == DATOS[995:]
    assert rango("bytes=5-2").status_code == 416
    assert rango("bytes=1000-").status_code == 416

    # MP4 recortado: la cabecera va pegada delante de un trozo del cuerpo, y
    # el navegador pide rangos sobre ese fichero de mentira.
    falso = b"HEAD" + DATOS[50:]
    audio = TMP / "prueba.aac"
    for ini, fin in [(0, 3), (2, 5), (4, 9), (0, len(falso) - 1), (len(falso) - 3, len(falso) - 1)]:
        dado = b"".join(server._trozo(audio, b"HEAD", 50, ini, fin))
        assert dado == falso[ini : fin + 1], (ini, fin)

    # Sin contraseña, una web ajena no puede cambiar nada; el panel si.
    assert c.post("/api/config", json={}, headers={"Origin": "https://malo.example"}).status_code == 403
    assert c.post("/api/quit", headers={"Origin": "http://localhost:8711"}).status_code == 403
    assert c.post("/api/config", json={}, headers={"Origin": "http://localhost:8710"}).status_code == 200
    assert c.post("/api/config", json={}, headers={"Origin": "chrome-extension://abcdef"}).status_code == 200
    assert c.get("/api/status", headers={"Origin": "https://malo.example"}).status_code == 200

    print("ok")


if __name__ == "__main__":
    main()
