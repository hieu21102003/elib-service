# elib-service — Dockerfile (Giai đoạn 1)
# Build:  docker build -t elib-service .
# Dùng node:22-slim (Debian) thay vì alpine vì @node-rs/argon2 là native module;
# slim tránh rủi ro thiếu bản build musl. (Reverse_proxy dùng alpine được vì
# không có native dependency.)
# LƯU Ý: chưa build thử bằng Docker thật (môi trường chuẩn bị không có Docker).

FROM node:22-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# wget cho HEALTHCHECK bên dưới; qpdf để giải mã/cắt trang preview cho PDF mã hóa (user password rỗng).
RUN apt-get update \
  && apt-get install -y --no-install-recommends wget qpdf \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# Cài dependency production + tsx để chạy được các script quản trị trong container:
#   docker compose exec elib npm run migrate
#   docker compose exec elib npm run seed:categories
#   docker compose exec elib npm run create-admin -- --email ... --password '...'
# (tsx nằm ở devDependencies nên cài riêng bằng --no-save, không sửa package.json.)
RUN npm ci --omit=dev \
  && npm install --no-save tsx@^4.19.3 \
  && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist
# src/ + tsconfig.json cần cho tsx chạy các script ở src/scripts/*.ts.
COPY --chown=node:node src ./src
COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node public ./public
# migrate.ts tìm thư mục migrations/ ở cấp gốc dự án (../../migrations tính từ
# src/scripts/ khi chạy tsx, hoặc từ dist/scripts/ khi chạy bản compile).
COPY --chown=node:node migrations ./migrations
# Thư mục storage mặc định trong container (compose mount volume vào đây).
# Tạo sẵn + chown để named volume lần đầu mount kế thừa quyền ghi của user node.
RUN mkdir -p /data/storage && chown node:node /data/storage
USER node
EXPOSE 3200
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3200}/health" >/dev/null 2>&1 || exit 1
ENTRYPOINT ["node", "dist/server.js"]
