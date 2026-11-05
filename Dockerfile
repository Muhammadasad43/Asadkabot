# One container, two processes: Flask (public, $PORT) + Asad MD (background)
FROM node:22-slim AS nodedeps
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/asad-md
COPY asad-md/package.json ./
RUN npm install --omit=dev

FROM python:3.12-slim
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node
ENV PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
COPY --from=nodedeps /app/asad-md/node_modules ./asad-md/node_modules
RUN chmod +x start.sh
CMD ["./start.sh"]
