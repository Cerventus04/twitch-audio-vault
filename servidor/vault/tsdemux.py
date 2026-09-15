"""Extrae el AAC de un flujo MPEG-TS y lo deja en ADTS.

Twitch entrega el audio dentro de un contenedor MPEG-TS, que es lo que usa
HLS. Los navegadores **no** saben reproducir MPEG-TS en un elemento <audio>,
pero si reproducen ADTS (audio/aac), que es lo que va dentro. Aqui se le quita
la envoltura.

De paso el fichero adelgaza en torno a un 20 %: se van las cabeceras de los
paquetes de 188 bytes y el relleno.

Funciona en flujo: se le pasan trozos segun llegan y devuelve lo que ya puede
emitir, guardando el resto para la siguiente vuelta.
"""
from __future__ import annotations

PAQUETE = 188
SYNC = 0x47

# Tipos de flujo que nos valen: AAC en ADTS.
TIPOS_AAC = {0x0F}


class Demuxer:
    def __init__(self) -> None:
        self.resto = b""
        self.pmt_pid: int | None = None
        self.audio_pid: int | None = None
        self._pes = bytearray()  # PES en construccion
        self.paquetes = 0
        self.descartados = 0
        # PTS (en segundos) del primer audio capturado. Es la marca que el
        # transcodificador de Twitch pone al contenido, y el VOD usa la misma
        # linea temporal: comparandolas sale el desfase exacto.
        self.primer_pts: float | None = None

    # -- tablas --------------------------------------------------------

    def _leer_pat(self, payload: bytes) -> None:
        # payload empieza con el puntero al inicio de la seccion.
        p = payload[0] + 1
        seccion = payload[p:]
        if len(seccion) < 13:
            return
        longitud = ((seccion[1] & 0x0F) << 8) | seccion[2]
        # 8 bytes de cabecera de seccion, 4 de CRC al final.
        fin = 3 + longitud - 4
        i = 8
        while i + 4 <= fin and i + 4 <= len(seccion):
            programa = (seccion[i] << 8) | seccion[i + 1]
            pid = ((seccion[i + 2] & 0x1F) << 8) | seccion[i + 3]
            if programa != 0:  # 0 seria la NIT
                self.pmt_pid = pid
                return
            i += 4

    def _leer_pmt(self, payload: bytes) -> None:
        p = payload[0] + 1
        s = payload[p:]
        if len(s) < 12:
            return
        longitud = ((s[1] & 0x0F) << 8) | s[2]
        fin = 3 + longitud - 4
        info_len = ((s[10] & 0x0F) << 8) | s[11]
        i = 12 + info_len
        while i + 5 <= fin and i + 5 <= len(s):
            tipo = s[i]
            pid = ((s[i + 1] & 0x1F) << 8) | s[i + 2]
            es_len = ((s[i + 3] & 0x0F) << 8) | s[i + 4]
            if tipo in TIPOS_AAC:
                self.audio_pid = pid
                return
            i += 5 + es_len

    # -- PES -----------------------------------------------------------

    @staticmethod
    def leer_pts(pes: bytes) -> float | None:
        """PTS de una PES, si la trae. Viene en unidades de 90 kHz."""
        if len(pes) < 14 or pes[0] or pes[1] or pes[2] != 1:
            return None
        if not (pes[7] & 0x80):  # bandera de PTS
            return None
        b = pes[9:14]
        pts = (
            ((b[0] >> 1 & 0x07) << 30)
            | (b[1] << 22)
            | ((b[2] >> 1) << 15)
            | (b[3] << 7)
            | (b[4] >> 1)
        )
        return pts / 90000.0

    @staticmethod
    def _quitar_cabecera_pes(pes: bytes) -> bytes:
        """Se queda con los datos, sin el prefijo ni la cabecera opcional."""
        if len(pes) < 9 or pes[0:3] != b"\x00\x00\x01":
            return b""
        return bytes(pes[9 + pes[8] :])

    def _cerrar_pes(self, salida: bytearray) -> None:
        if self._pes:
            salida += self._quitar_cabecera_pes(bytes(self._pes))
            self._pes.clear()

    # -- entrada -------------------------------------------------------

    def feed(self, datos: bytes) -> bytes:
        buf = self.resto + datos
        salida = bytearray()
        i = 0
        n = len(buf)

        while i + PAQUETE <= n:
            if buf[i] != SYNC:
                # Se perdio el alineamiento: se busca la siguiente sincronia.
                j = buf.find(bytes([SYNC]), i + 1)
                if j < 0 or j + PAQUETE > n:
                    break
                self.descartados += j - i
                i = j
                continue

            paquete = buf[i : i + PAQUETE]
            i += PAQUETE
            self.paquetes += 1

            b1, b2, b3 = paquete[1], paquete[2], paquete[3]
            if b1 & 0x80:  # transport_error_indicator
                continue
            pid = ((b1 & 0x1F) << 8) | b2
            inicio = bool(b1 & 0x40)
            afc = (b3 >> 4) & 0x03
            if afc == 0 or afc == 2:  # sin carga util
                continue
            off = 4
            if afc == 3:
                off = 5 + paquete[4]
            if off >= PAQUETE:
                continue
            carga = paquete[off:]

            if pid == 0:
                if inicio:
                    self._leer_pat(carga)
            elif self.pmt_pid is not None and pid == self.pmt_pid:
                if inicio:
                    self._leer_pmt(carga)
            elif self.audio_pid is not None and pid == self.audio_pid:
                if inicio:
                    self._cerrar_pes(salida)
                    if self.primer_pts is None:
                        self.primer_pts = self.leer_pts(bytes(carga))
                self._pes += carga

        self.resto = buf[i:]
        return bytes(salida)

    def flush(self) -> bytes:
        """Lo que quede pendiente al cerrar el fichero."""
        salida = bytearray()
        self._cerrar_pes(salida)
        return bytes(salida)


def convertir(origen, destino) -> tuple[int, int]:
    """Convierte un fichero ya grabado. Devuelve (bytes_entrada, bytes_salida)."""
    d = Demuxer()
    entrada = salida = 0
    with open(origen, "rb") as fi, open(destino, "wb") as fo:
        while True:
            trozo = fi.read(1 << 20)
            if not trozo:
                break
            entrada += len(trozo)
            out = d.feed(trozo)
            fo.write(out)
            salida += len(out)
        out = d.flush()
        fo.write(out)
        salida += len(out)
    return entrada, salida
