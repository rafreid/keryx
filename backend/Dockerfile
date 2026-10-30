FROM python:3.12-alpine
LABEL org.opencontainers.image.title="Keryx" \
      org.opencontainers.image.description="Live visual activity monitor for Hermes Agent" \
      org.opencontainers.image.source="https://github.com/rafreid/keryx" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="Aflux Systems LLC"
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
COPY static ./static
ENV HERMES_DATA=/opt/data GRAPH_PORT=9120
EXPOSE 9120
# /api/health answers without a token, so the probe works with KERYX_TOKEN set
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${GRAPH_PORT}/api/health" | grep -q '"ok":true' || exit 1
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${GRAPH_PORT}"]
