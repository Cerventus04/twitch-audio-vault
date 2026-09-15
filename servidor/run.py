"""Arranca Twitch Audio Vault: vigilante + interfaz en el navegador.

Opciones:
  --no-browser   no abre el navegador al arrancar (para el inicio automatico)
"""
from __future__ import annotations

import argparse
import logging
import socket
import sys
import threading
import webbrowser
from pathlib import Path

import uvicorn

from vault import auth, config

LOG_PATH = Path(__file__).resolve().parent / "vault.log"


def already_running(port: int) -> bool:
    """Comprueba si otra copia ya tiene el puerto cogido.

    Sin consola es facil hacer doble clic dos veces sin darse cuenta; en ese
    caso se abre el panel de la copia que ya estaba y se sale.
    """
    with socket.socket() as s:
        s.settimeout(0.6)
        return s.connect_ex(("127.0.0.1", port)) == 0


def ensure_streams() -> None:
    """Da un stdout/stderr reales cuando se arranca con pythonw.

    Sin consola, Python deja sys.stdout y sys.stderr a None, y uvicorn se cae
    al montar su logger porque intenta escribir en ellos.
    """
    if sys.stdout is not None and sys.stderr is not None:
        return
    sink = open(LOG_PATH, "a", encoding="utf-8", buffering=1)
    if sys.stdout is None:
        sys.stdout = sink
    if sys.stderr is None:
        sys.stderr = sink


def _sin_cortes_de_conexion(registro: logging.LogRecord) -> bool:
    """Descarta el ruido de las descargas que el navegador corta a media."""
    texto = registro.getMessage()
    if registro.exc_info and registro.exc_info[0] is not None:
        texto += " " + registro.exc_info[0].__name__
    return not any(
        x in texto
        for x in ("ConnectionResetError", "ConnectionAbortedError",
                  "_call_connection_lost")
    )


def main() -> None:
    ensure_streams()
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    cfg = config.load()
    port = int(cfg["port"])
    host = cfg["host"]
    url = f"http://localhost:{port}/"

    # Nunca abrir el panel a la red sin contraseña.
    auth.comprobar_configuracion()

    # En un servidor no hay navegador que abrir ni copia previa que detectar.
    if not auth.es_local():
        args.no_browser = True

    if auth.es_local() and already_running(port):
        if not args.no_browser:
            webbrowser.open(url)
        print(f"Twitch Audio Vault ya estaba abierto en {url}")
        return

    # Con pythonw no hay consola, asi que el registro va tambien a fichero.
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(levelname)-7s %(name)s  %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        handlers=[logging.FileHandler(LOG_PATH, encoding="utf-8")],
    )

    # El navegador corta la descarga en cuanto cambias de sitio en el VOD: pide
    # un trozo de audio, se arrepiente y cierra. asyncio lo cuenta como una
    # traza entera, y con un rato de uso el registro no hay quien lo lea. Son
    # cortes normales, no fallos.
    logging.getLogger("asyncio").addFilter(_sin_cortes_de_conexion)

    if not args.no_browser:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    logging.getLogger("vault").info("arrancando en %s", url)

    uvicorn.run("vault.server:app", host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
