FROM python:3.13-slim

# ffmpeg no hace falta: el audio se guarda tal cual llega, sin recodificar.
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY vault/ ./vault/
COPY web/ ./web/
COPY run.py ./

# El audio y la base de datos viven en un volumen, para que sobrevivan a las
# actualizaciones de la imagen.
ENV VAULT_AUDIO_DIR=/data \
    VAULT_CONFIG=/data/config.json \
    VAULT_HOST=0.0.0.0 \
    VAULT_PORT=8710
VOLUME ["/data"]
EXPOSE 8710

CMD ["python", "run.py", "--no-browser"]
