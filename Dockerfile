# NiHonGo — language learning web app
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    NIHONGO_DB=/data/progress.db

WORKDIR /app

# Install dependencies first for better layer caching.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code.
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Run as a non-root user and give it ownership of the data dir. A fresh named
# volume mounted at /data inherits this ownership, so the app can write the
# SQLite progress db without running as root.
RUN useradd --create-home --uid 1000 appuser \
    && mkdir -p /data \
    && chown -R appuser:appuser /data
USER appuser

VOLUME ["/data"]
EXPOSE 8000

# Simple healthcheck against the API.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/api/health').status==200 else 1)"

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
