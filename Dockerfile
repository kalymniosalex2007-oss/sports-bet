FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production DB_PATH=/data/app.db
EXPOSE 3000
CMD ["node", "src/server.js"]
