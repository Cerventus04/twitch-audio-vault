# Twitch Audio Vault — servidor

Graba el **audio original** de los directos de Twitch mientras se emiten y lo sirve por HTTP para que la [extensión](../extension) lo reproduzca sincronizado sobre el VOD.

El problema que resuelve: muchos streamers mandan a Twitch dos pistas con la opción *VOD Track* de OBS. La del directo lleva la música; la que queda en el VOD no, para evitar el silenciado por copyright. Esa pista **no se puede recuperar después** de los servidores de Twitch: hay que capturarla mientras el directo está en el aire. Eso es lo que hace este programa.

## Cómo funciona

Un vigilante pregunta a la API de Twitch cada pocos segundos quién está en directo de una lista de canales. Cuando alguno empieza, abre el stream con `streamlink`, se queda solo con la pista de audio y la escribe a disco. Al terminar, empareja la grabación con el VOD publicado y calcula el desfase entre ambos, que es lo que permite reproducir encima sincronizado.

## Instalación

Requiere **Python 3.9 o superior**.

```bash
pip install -r requirements.txt
```

Hacen falta un *Client ID* y un *Client Secret* de una aplicación creada en [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps). Son de solo lectura: no dan acceso a ninguna cuenta.

```bash
cp config.example.json config.json
```

Rellena `client_id` y `client_secret`. El resto puede quedarse como está.

## Arranque

```bash
python run.py
```

Abre el panel en `http://localhost:8710`. Con `--no-browser` no lo abre, que es lo que interesa al arrancarlo como servicio.

En Windows hay dos lanzadores sin ventana de consola: `Iniciar.vbs` y `Iniciar en segundo plano.vbs`. Como no hay consola, el programa se cierra desde el panel (*Ajustes → Cerrar Twitch Audio Vault*), y el registro va a `vault.log`.

## Configuración

Todo vive en `config.json`. Cualquier clave se puede sobrescribir con una variable de entorno `VAULT_<CLAVE_EN_MAYÚSCULAS>` (por ejemplo `VAULT_AUTH_TOKEN`), útil en Docker. Con `VAULT_CONFIG` se indica otra ruta para el fichero.

| Clave | Por defecto | Qué hace |
|---|---|---|
| `client_id`, `client_secret` | vacío | Credenciales de la app de Twitch |
| `audio_dir` | `grabaciones` | Dónde se guardan los audios y la base de datos |
| `poll_seconds` | `60` | Cada cuánto se pregunta quién está en directo |
| `audio_quality` | `audio_only,best` | Calidad que se pide a streamlink, por orden |
| `retention_days` | `0` | Borra grabaciones más antiguas. `0` = no borrar |
| `port` | `8710` | Puerto del servidor |
| `host` | `127.0.0.1` | Interfaz. `0.0.0.0` para aceptar conexiones de fuera |
| `auth_token` | vacío | Contraseña de acceso |

### El token y el puerto

`host`, `port` y `auth_token` **solo se tocan en el fichero o por variable de entorno**, nunca desde el panel: así nadie puede desactivar la contraseña desde la propia interfaz.

Con `host` en `127.0.0.1` el token es opcional, porque solo se puede llegar desde el mismo equipo. **En cuanto se abre a la red es obligatorio**: el programa se niega a arrancar sin él.

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

La extensión lo manda en la cabecera `X-Auth-Token`.

## La API que consume la extensión

Todas las respuestas son JSON salvo `/audio/{id}`, que devuelve audio.

### `GET /api/match?vod=<id>`

El endpoint principal. Devuelve los trozos de audio grabado que cubren ese VOD, en orden. Normalmente es uno, pero un directo puede quedar partido en varios ficheros si el programa se reinició a mitad; entre trozo y trozo queda un hueco real, donde suena el audio del propio VOD.

Cada trozo trae:

| Campo | Qué es |
|---|---|
| `id` | Identificador de la grabación, para pedirla a `/audio/{id}` |
| `inicio` | Segundo del VOD donde empieza este trozo |
| `fin` | Segundo donde acaba, o `null` si aún se está grabando |
| `duracion` | Duración del trozo, en segundos |
| `origen` | Desplazamiento de la línea temporal del fichero (ver más abajo) |
| `absoluto` | `true` en MP4 fragmentado, `false` en AAC crudo |
| `granularidad` | Múltiplo al que se redondean los cortes, en segundos |
| `ventana` | Segundos que conviene pedir de golpe en cada salto |
| `audio_url` | Ruta del audio, `/audio/<id>` |

### `GET /audio/{id}?desde=<s>&dura=<s>`

Devuelve el audio, `audio/aac` o `audio/mp4` según el formato real del fichero (se mira la cabecera, no la extensión). Admite peticiones `Range`, que es lo que permite buscar dentro del audio.

- `desde`: segundo por el que empezar. Se redondea hacia abajo a un múltiplo de `granularidad`, para que cliente y servidor calculen el mismo corte.
- `dura`: segundos a servir. Sin él, llega hasta el final del fichero.

Cabecera de respuesta **`X-Dura-Real`**: la duración real del tramo servido, que casi nunca coincide con `dura` porque los dos extremos caen en marcas del índice. La extensión la necesita para programar el relevo entre tramos justo donde acaba uno, sin pasarse del final. Va expuesta por CORS.

### Resto de endpoints

| Endpoint | Qué hace |
|---|---|
| `GET /api/status` | Estado: qué se está grabando, espacio usado, último error |
| `GET /api/canal?login=<canal>` | VODs grabados de un canal, más reciente primero |
| `GET` / `POST /api/config` | Lee y escribe la configuración (el secreto no vuelve) |
| `GET` / `POST /api/channels` | Lista y añade canales a vigilar |
| `PATCH` / `DELETE /api/channels/{login}` | Activa, desactiva o quita un canal |
| `GET /api/recordings` | Lista de grabaciones, filtrable por `login` |
| `PATCH` / `DELETE /api/recordings/{id}` | Ajusta el desfase manual, o borra |
| `GET` / `POST /api/auth` | Si hace falta contraseña, e inicio de sesión |
| `POST /api/quit` | Cierra el programa |

## Lo que costó

**Twitch entrega dos formatos y hay que soportar los dos.** Según cómo emita cada streamer, el audio llega en **MPEG-TS** (se le quita la envoltura y queda AAC crudo) o en **MP4 fragmentado** (si usa la Emisión Mejorada). Depende del directo concreto, no del canal, así que no se puede asumir ninguno. De ahí `tsdemux.py` y `mp4.py`.

**El desfase no se calcula con el reloj.** Comparar la hora a la que empezó la grabación con la del VOD daba errores de unos 13 segundos. Se calcula con las marcas de tiempo del propio contenido: los **PTS** en MPEG-TS y las cajas **`tfdt`** en MP4 fragmentado. Además se revisa una vez emparejado, por si al principio el VOD era demasiado corto para medirlo.

**Las dos líneas temporales no son iguales.** En AAC crudo el fichero recortado empieza en cero. En MP4 fragmentado cada fragmento lleva su tiempo absoluto, así que el recorte conserva la línea temporal del contenido: por eso cada trozo trae un `origen` y un `absoluto` que dicen cómo interpretarlo.

**Saltar dentro de un fichero de horas es caro.** Ninguno de los dos formatos trae índice propio, así que el navegador tendría que recorrerlo entero. El servidor mantiene el suyo (`adts.py` y `mp4idx.py`), que apunta en qué byte empieza cada tramo, y sirve el audio **ya recortado**. En una grabación en curso el índice se amplía de forma incremental: se conserva lo recorrido y solo se leen los bytes nuevos.

**La base de datos es SQLite en modo WAL.** Para respaldarla hay que copiar `vault.db` **y** sus ficheros `-wal` y `-shm`; copiar solo el `.db` se lleva un estado viejo.

## Estructura

```
run.py              arranque
vault/
  server.py         API HTTP y servicio del audio
  watcher.py        vigila quién está en directo y empareja con los VOD
  recorder.py       captura el audio del directo
  twitch.py         cliente de la API de Twitch
  tsdemux.py        extrae el AAC del envoltorio MPEG-TS
  mp4.py            lectura de cajas MP4 y marcas tfdt
  adts.py           índice de AAC crudo
  mp4idx.py         índice de MP4 fragmentado
  db.py             SQLite
  auth.py           token de acceso
  config.py         configuración
web/                panel de control
despliegue/         guía e instalador para un servidor Linux
```

## Aviso

`config.json` lleva las credenciales de Twitch y la contraseña del servidor. No compartas esa carpeta sin quitarlo; por eso está en el `.gitignore`.
