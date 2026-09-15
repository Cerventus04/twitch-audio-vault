"""Configuracion persistente en disco (JSON junto al proyecto)."""
from __future__ import annotations

import json
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
# En un contenedor el fichero debe vivir en el volumen de datos; si no, cada
# reconstruccion de la imagen se llevaria por delante los ajustes.
CONFIG_PATH = Path(os.environ.get("VAULT_CONFIG") or BASE_DIR / "config.json")

DEFAULTS = {
    # Credenciales de la app de Twitch (dev.twitch.tv/console/apps)
    "client_id": "",
    "client_secret": "",
    # Donde se guardan los .aac y la base de datos
    "audio_dir": str(BASE_DIR / "grabaciones"),
    # Cada cuanto se pregunta a Twitch quien esta en directo (segundos)
    "poll_seconds": 60,
    # Calidad de audio que se pide a streamlink, en orden de preferencia
    "audio_quality": "audio_only,best",
    # Borra grabaciones mas antiguas que esto. 0 = no borrar nada.
    "retention_days": 0,
    # Puerto del servidor
    "port": 8710,
    # Interfaz donde escucha. 127.0.0.1 = solo este equipo (modo local).
    # En un servidor hay que poner 0.0.0.0 para aceptar conexiones de fuera.
    "host": "127.0.0.1",
    # Contraseña de acceso. Vacia = sin autenticacion, solo valido si `host`
    # es 127.0.0.1. En cuanto se abre a la red, es obligatoria.
    "auth_token": "",
}

# Estos ajustes son de despliegue: se tocan en el fichero o por variable de
# entorno, no desde el panel, para que nadie pueda desactivar la contraseña
# desde la propia interfaz.
SOLO_FICHERO = {"host", "auth_token", "port"}


def load() -> dict:
    cfg = dict(DEFAULTS)
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError):
            pass
    # En un contenedor lo comodo es pasar los ajustes por entorno, y ahi
    # mandan sobre el fichero.
    for clave in DEFAULTS:
        env = os.environ.get(f"VAULT_{clave.upper()}")
        if env is None or env == "":
            continue
        cfg[clave] = type(DEFAULTS[clave])(env) if isinstance(DEFAULTS[clave], int) else env
    return cfg


def save(cfg: dict) -> dict:
    current = load()
    current.update(
        {k: v for k, v in cfg.items() if k in DEFAULTS and k not in SOLO_FICHERO}
    )
    # En el primer arranque dentro del contenedor la carpeta puede no existir.
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(
        json.dumps(current, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return current


def audio_dir() -> Path:
    d = Path(load()["audio_dir"])
    d.mkdir(parents=True, exist_ok=True)
    return d


def db_path() -> Path:
    return audio_dir() / "vault.db"
