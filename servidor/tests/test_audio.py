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

from vault import adts, db, server, twitch  # noqa: E402

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

    # Un poll_seconds que no sea numero mataba el hilo del vigilante.
    assert c.post("/api/config", json={"poll_seconds": "abc"}).status_code == 400
    assert c.post("/api/config", json={"poll_seconds": None}).status_code == 400
    assert c.post("/api/config", json={"poll_seconds": "45", "retention_days": -3}).status_code == 200
    cfg = c.get("/api/config").json()
    assert (cfg["poll_seconds"], cfg["retention_days"]) == (45, 0), cfg

    indice_incremental()
    directo_de_canal_renombrado()
    grabaciones_traidas_de_otra_maquina()
    print("ok")


def grabaciones_traidas_de_otra_maquina() -> None:
    """Rutas guardadas en otro equipo se recolocan si el fichero esta en su sitio."""
    from vault import watcher

    (TMP / "canal").mkdir(exist_ok=True)
    for nombre in ("de-windows.aac", "de-linux.aac"):
        (TMP / "canal" / nombre).write_bytes(b"x")
    rutas = {
        r"C:\Users\Otro\grabaciones\canal\de-windows.aac": TMP / "canal" / "de-windows.aac",
        "/data/canal/de-linux.aac": TMP / "canal" / "de-linux.aac",
        r"C:\perdida\canal\no-existe.aac": None,  # sin fichero: se deja como estaba
    }
    ids = {}
    for vieja in rutas:
        with db.tx() as conn:
            ids[vieja] = conn.execute(
                "INSERT INTO recordings (login, capture_start, path, status) "
                "VALUES ('canal', '2026-01-01T00:00:00+00:00', ?, 'done')",
                (vieja,),
            ).lastrowid
    watcher.Watcher._reubicar()
    for vieja, esperada in rutas.items():
        ahora = db.one("SELECT path FROM recordings WHERE id=?", (ids[vieja],))["path"]
        assert ahora == str(esperada or vieja), (vieja, ahora)


def directo_de_canal_renombrado() -> None:
    """Un canal que cambia de nombre se sigue encontrando por su user_id."""
    pedido = []

    def falso(path, params):
        pedido.extend(params)
        return {"data": [
            {"type": "live", "user_id": "42", "user_login": "nuevonombre"},
            {"type": "live", "user_id": "7", "user_login": "sinid"},
        ]}

    real, twitch._get = twitch._get, falso
    try:
        live = twitch.live_streams([
            {"login": "viejonombre", "user_id": "42"},
            {"login": "sinid", "user_id": None},  # fila antigua sin user_id
            {"login": "apagado", "user_id": "99"},
        ])
    finally:
        twitch._get = real
    assert ("user_id", "42") in pedido and ("user_login", "sinid") in pedido, pedido
    assert set(live) == {"viejonombre", "sinid"}, live
    assert live["viejonombre"]["user_login"] == "nuevonombre"


def indice_incremental() -> None:
    """El indice de una grabacion que crece debe salir igual que hecho de una vez."""
    # Trama ADTS de 100 bytes, AAC-LC a 48 kHz: 1024 muestras = 21,33 ms.
    trama = bytes([0xFF, 0xF1, 0x4C, 0x80, 100 >> 3, ((100 & 7) << 5) | 0x1F, 0xFC]) + bytes(93)
    todo = trama * 1000  # 21,3 s
    entero, creciendo = TMP / "entero.aac", TMP / "creciendo.aac"
    entero.write_bytes(todo)
    # Se corta a mitad de una trama, como cuando el grabador aun esta escribiendo.
    creciendo.write_bytes(todo[: 500 * 100 + 50])
    adts.indice(creciendo)
    with open(creciendo, "ab") as fh:
        fh.write(todo[500 * 100 + 50 :])

    a, b = adts.indice(creciendo), adts.indice(entero)
    assert a["marcas"] == b["marcas"] == [0, 46900, 93800], a["marcas"]
    assert a["tiempos"] == b["tiempos"] and abs(a["duracion"] - 1000 * 1024 / 48000) < 1e-9

    # Ventana de 10 s desde 0: corta en la segunda marca y dice su duracion real.
    principio, fin, dura = adts.tramo(entero, 0, 10)
    assert (principio, fin) == (0, 46900) and abs(dura - 469 * 1024 / 48000) < 1e-9
    # Pedir mas de lo que queda sirve hasta el final, no una ventana vacia.
    principio, fin, dura = adts.tramo(entero, 12, 300)
    assert (principio, fin) == (46900, 0) and abs(dura - 531 * 1024 / 48000) < 1e-9


if __name__ == "__main__":
    main()
