# Thumbdrive, Python edition. Build from this directory: docker build -t thumbdrive-python .
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.13 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never

WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN uv sync --frozen --no-dev

RUN useradd --system --uid 10001 --home-dir /data thumbdrive && mkdir -p /data && chown thumbdrive /data
USER thumbdrive

# Inside the container we listen on all interfaces; publish the port on 127.0.0.1 only (see compose.yaml).
ENV PATH=/app/.venv/bin:$PATH THUMBDRIVE_HOST=0.0.0.0 THUMBDRIVE_PORT=8484 DATA_DIR=/data
VOLUME /data
EXPOSE 8484
HEALTHCHECK CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8484/healthz')"]
CMD ["thumbdrive"]
