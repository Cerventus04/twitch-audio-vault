"""Cliente minimo de la API Helix de Twitch (app access token).

Solo se usan endpoints publicos de lectura: quien esta en directo, datos del
canal y la lista de VODs. No hace falta que el usuario inicie sesion.
"""
from __future__ import annotations

import threading
import time
from typing import Any

import httpx

from . import config

TOKEN_URL = "https://id.twitch.tv/oauth2/token"
HELIX = "https://api.twitch.tv/helix"

_lock = threading.Lock()
_token: str | None = None
_token_expires: float = 0.0


class TwitchError(RuntimeError):
    pass


def _credentials() -> tuple[str, str]:
    cfg = config.load()
    cid, secret = cfg["client_id"].strip(), cfg["client_secret"].strip()
    if not cid or not secret:
        raise TwitchError(
            "Faltan client_id / client_secret. Creala en dev.twitch.tv/console/apps "
            "y pegalas en Ajustes."
        )
    return cid, secret


def _access_token(force: bool = False) -> str:
    global _token, _token_expires
    with _lock:
        if not force and _token and time.time() < _token_expires - 60:
            return _token
        cid, secret = _credentials()
        r = httpx.post(
            TOKEN_URL,
            data={
                "client_id": cid,
                "client_secret": secret,
                "grant_type": "client_credentials",
            },
            timeout=20,
        )
        if r.status_code != 200:
            raise TwitchError(f"No se pudo obtener el token ({r.status_code}): {r.text}")
        data = r.json()
        _token = data["access_token"]
        _token_expires = time.time() + data.get("expires_in", 3600)
        return _token


def _get(path: str, params: list[tuple[str, str]] | dict) -> dict[str, Any]:
    cid, _ = _credentials()
    for attempt in (0, 1):
        token = _access_token(force=attempt == 1)
        r = httpx.get(
            f"{HELIX}{path}",
            params=params,
            headers={"Client-ID": cid, "Authorization": f"Bearer {token}"},
            timeout=20,
        )
        # 401 -> el token caduco antes de tiempo; se pide otro y se reintenta.
        if r.status_code == 401 and attempt == 0:
            continue
        if r.status_code != 200:
            raise TwitchError(f"Helix {path} devolvio {r.status_code}: {r.text}")
        return r.json()
    raise TwitchError(f"Helix {path}: autenticacion rechazada dos veces")


def users(logins: list[str]) -> list[dict]:
    """Datos de canal (id, nombre visible, avatar) para hasta 100 logins."""
    out: list[dict] = []
    for i in range(0, len(logins), 100):
        chunk = logins[i : i + 100]
        out += _get("/users", [("login", l) for l in chunk]).get("data", [])
    return out


def live_streams(logins: list[str]) -> dict[str, dict]:
    """Devuelve {login: stream} solo para los que estan en directo ahora."""
    result: dict[str, dict] = {}
    for i in range(0, len(logins), 100):
        chunk = logins[i : i + 100]
        data = _get("/streams", [("user_login", l) for l in chunk]).get("data", [])
        for s in data:
            if s.get("type") == "live":
                result[s["user_login"].lower()] = s
    return result


def archives(user_id: str, limit: int = 20) -> list[dict]:
    """VODs de tipo 'archive' (la grabacion automatica del directo)."""
    return _get(
        "/videos", {"user_id": user_id, "type": "archive", "first": str(limit)}
    ).get("data", [])


def check_credentials() -> bool:
    _access_token(force=True)
    return True
