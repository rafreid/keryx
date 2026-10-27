FROM python:3.12-alpine
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
COPY static ./static
ENV HERMES_DATA=/opt/data GRAPH_PORT=9120
EXPOSE 9120
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${GRAPH_PORT}"]
