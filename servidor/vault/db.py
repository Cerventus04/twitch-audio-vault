"""Capa de datos: SQLite con los canales vigilados y las grabaciones."""
from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from typing import Any, Iterator

from . import config

_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS channels (
    login         TEXT PRIMARY KEY,
    user_id       TEXT,
    display_name  TEXT,
    avatar_url    TEXT,
    added_at      TEXT NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS recordings (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    login             TEXT NOT NULL,
    stream_id         TEXT,
    vod_id            TEXT,
    vod_created_at    TEXT,
    -- Segundos que hay que restar al tiempo del VOD para caer en el mismo
    -- instante del fichero de audio: capture_start - vod_created_at.
    vod_offset        REAL,
    -- PTS del primer audio capturado: permite el calculo exacto.
    first_pts         REAL,
    -- Con que metodo salio `vod_offset`: 'pts' es el exacto, el resto son
    -- aproximaciones que conviene rehacer cuando el VOD haya crecido.
    offset_metodo     TEXT,
    title             TEXT,
    -- Copia del nombre y el avatar del canal en el momento de grabar: si
    -- luego se deja de vigilar ese canal, la grabacion sigue reconocible.
    display_name      TEXT,
    avatar_url        TEXT,
    -- Instante real (UTC ISO) en que empezo a entrar audio en el fichero.
    capture_start     TEXT NOT NULL,
    -- Instante en que Twitch dice que arranco el directo. Base del calculo
    -- de offset contra el VOD.
    stream_start      TEXT,
    capture_end       TEXT,
    path              TEXT NOT NULL,
    bytes             INTEGER NOT NULL DEFAULT 0,
    duration_seconds  REAL,
    status            TEXT NOT NULL DEFAULT 'recording',
    error             TEXT,
    -- Ajuste fino en segundos que el usuario aplica desde el reproductor.
    offset_override   REAL
);

CREATE INDEX IF NOT EXISTS idx_recordings_vod ON recordings(vod_id);
CREATE INDEX IF NOT EXISTS idx_recordings_login ON recordings(login);
"""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(config.db_path(), timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def get() -> sqlite3.Connection:
    """Una conexion por hilo: el watcher y el servidor web escriben a la vez."""
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = _local.conn = _connect()
    return conn


# Columnas añadidas despues de la primera version. CREATE TABLE IF NOT EXISTS
# no toca las tablas que ya existen, asi que hay que agregarlas a mano.
MIGRACIONES = {
    "recordings": {
        "first_pts": "REAL",
        "display_name": "TEXT",
        "avatar_url": "TEXT",
        # Con que metodo se calculo `vod_offset`. Si no fue el exacto ('pts'),
        # se vuelve a intentar mas adelante: al emparejar una grabacion nada
        # mas empezar el directo, el VOD aun es demasiado corto para medirlo.
        "offset_metodo": "TEXT",
    },
}


def init() -> None:
    conn = get()
    conn.executescript(SCHEMA)
    for tabla, columnas in MIGRACIONES.items():
        existentes = {r[1] for r in conn.execute(f"PRAGMA table_info({tabla})")}
        for nombre, tipo in columnas.items():
            if nombre not in existentes:
                conn.execute(f"ALTER TABLE {tabla} ADD COLUMN {nombre} {tipo}")
    conn.commit()


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    conn = get()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def query(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    return [dict(r) for r in get().execute(sql, params).fetchall()]


def one(sql: str, params: tuple = ()) -> dict[str, Any] | None:
    row = get().execute(sql, params).fetchone()
    return dict(row) if row else None
