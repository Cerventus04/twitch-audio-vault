"""Control de acceso.

En local (escuchando solo en 127.0.0.1) no hace falta contraseña: nadie de
fuera puede llegar. En cuanto el servidor se abre a la red es obligatoria, y
el programa se niega a arrancar sin ella.

El audio se protege con la contraseña en la URL (`?t=...`) en vez de con una
cabecera, porque un elemento <audio> no puede enviar cabeceras propias.
"""
from __future__ import annotations

import re
import secrets

from fastapi import Request
from fastapi.responses import JSONResponse

from . import config

CABECERA = "x-auth-token"
PARAMETRO = "t"

# Rutas que se sirven sin contraseña: son las que pintan la pantalla de
# acceso. No exponen ningun dato.
PUBLICAS = {"/", "/index.html", "/style.css", "/app.js", "/api/auth"}

# Quien puede hablar con el servidor desde un navegador: la extension y el
# propio panel (en su puerto; Chrome resuelve cualquier *.localhost a esta
# maquina). Lo usan CORS y el filtro de abajo, asi que es una sola regla.
ORIGENES_PROPIOS = (
    r"(chrome-extension|moz-extension)://[a-z0-9-]+"
    rf"|https?://([a-z0-9-]+\.)?(localhost|127\.0\.0\.1):{int(config.load()['port'])}"
)
_PROPIO = re.compile(ORIGENES_PROPIOS)


def token() -> str:
    return (config.load().get("auth_token") or "").strip()


def es_local() -> bool:
    return config.load().get("host", "127.0.0.1") in {"127.0.0.1", "localhost", "::1"}


def comprobar_configuracion() -> None:
    """Impide abrir el panel a la red sin contraseña."""
    if not es_local() and not token():
        raise SystemExit(
            "\n  El servidor esta configurado para escuchar en la red "
            f"({config.load()['host']}) pero no tiene contraseña.\n"
            "  Pon `auth_token` en config.json o la variable VAULT_AUTH_TOKEN.\n"
        )


def _presentado(request: Request) -> str | None:
    valor = request.headers.get(CABECERA)
    if valor:
        return valor
    return request.query_params.get(PARAMETRO)


def valido(request: Request) -> bool:
    esperado = token()
    if not esperado:
        return True
    dado = _presentado(request)
    if not dado:
        return False
    return coincide(dado, esperado)


def coincide(dado: str, esperado: str) -> bool:
    """Compara contraseñas sin filtrar nada por el tiempo de respuesta.

    En bytes y no en texto: compare_digest lanza TypeError con texto no ASCII,
    y una contraseña con ñ o acentos dejaba a todo el mundo fuera (500 en
    cada intento, tambien con la buena).
    """
    return secrets.compare_digest(dado.encode("utf-8"), esperado.encode("utf-8"))


async def middleware(request: Request, call_next):
    if not token():
        # Sin contraseña cualquier web abierta puede mandar un POST a
        # localhost (el navegador lo envia aunque no deje leer la respuesta):
        # bastaba para apagar el grabador o poner retention_days=1 y borrarlo
        # todo. Los navegadores siempre ponen Origin en esas peticiones.
        origen = request.headers.get("origin")
        if (request.method not in ("GET", "HEAD", "OPTIONS") and origen
                and not _PROPIO.fullmatch(origen)):
            return JSONResponse({"detail": "Origen no permitido"}, status_code=403)
        return await call_next(request)
    if request.method == "OPTIONS":
        return await call_next(request)

    ruta = request.url.path
    if ruta in PUBLICAS or ruta.startswith("/icons/"):
        return await call_next(request)

    if not valido(request):
        return JSONResponse(
            {"detail": "Contraseña incorrecta o ausente"}, status_code=401
        )
    return await call_next(request)
