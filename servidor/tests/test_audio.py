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

import struct  # noqa: E402

from vault import adts, db, mp4idx, server, twitch  # noqa: E402

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
    indice_mp4()
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


def indice_mp4() -> None:
    """MP4 fragmentado: marcas, cabecera que toca a cada tramo y reanudacion."""

    def caja(tipo: bytes, cuerpo: bytes = b"") -> bytes:
        return struct.pack(">I", 8 + len(cuerpo)) + tipo + cuerpo

    # Inicializacion: escala de 48000 en mdhd (version 0).
    mdhd = caja(b"mdhd", bytes(12) + struct.pack(">I", 48000) + bytes(8))
    init = caja(b"ftyp", b"iso6") + caja(b"moov", caja(b"trak", caja(b"mdia", mdhd)))

    def segmento(segundo: int) -> bytes:  # 2 s de audio cada uno
        tfdt = caja(b"tfdt", b"\x01\x00\x00\x00" + struct.pack(">Q", segundo * 48000))
        return caja(b"styp", b"msdh") + caja(b"moof", caja(b"traf", tfdt)) + caja(b"mdat", bytes(100))

    # 30 segmentos (60 s) desde el segundo 1000 de contenido, y a mitad un
    # segundo segmento de inicializacion, como el que manda Twitch tras una
    # discontinuidad.
    datos = bytearray(init)
    inicio_seg = {}
    inits = [[0, len(init)]]
    for i in range(30):
        if i == 15:
            inits.append([len(datos), len(datos) + len(init)])
            datos += init
        inicio_seg[i] = len(datos)
        datos += segmento(1000 + 2 * i)
    datos = bytes(datos)

    entero, creciendo = TMP / "entero.mp4", TMP / "creciendo.mp4"
    entero.write_bytes(datos)
    # Cortado a mitad del segmento 10, que lleva marca: su styp ya escrito, su moof aun no.
    creciendo.write_bytes(datos[: inicio_seg[10] + 20])
    mp4idx.indice(creciendo)
    with open(creciendo, "ab") as fh:
        fh.write(datos[inicio_seg[10] + 20 :])

    a, b = mp4idx.indice(creciendo), mp4idx.indice(entero)
    for clave in ("marcas", "tiempos", "de_init", "inits"):
        assert a[clave] == b[clave], (clave, a[clave], b[clave])
    # Una marca cada 10 s: segmentos 0, 5, 10... y empieza en su styp.
    assert b["marcas"] == [inicio_seg[i] for i in (0, 5, 10, 15, 20, 25)], b["marcas"]
    assert b["inits"] == inits, b["inits"]

    # Ventana de 25 s desde el 12: de la marca de 10 s a la de 30 s, con la
    # primera inicializacion.
    cab, principio, fin, real = mp4idx.corte(entero, 12, 25)
    assert (cab, principio, fin, real) == (inits[0], inicio_seg[5], inicio_seg[15], 20.0)
    # Despues de la discontinuidad toca la segunda inicializacion.
    cab, principio, fin, real = mp4idx.corte(entero, 41, 0)
    assert (cab, principio, fin) == (inits[1], inicio_seg[20], len(datos)), (cab, principio, fin)


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
