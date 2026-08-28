# ---------- 阶段 1：构建演示产物 ----------
FROM node:22-alpine AS build
# 启用 pnpm（已由 corepack 内置），避免全局安装
RUN corepack enable
WORKDIR /app

# 先拷贝依赖清单，利用 Docker 层缓存
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# 再拷贝源码并构建
COPY . .
RUN pnpm build

# ---------- 阶段 2：Nginx 静态托管 --------------
FROM nginx:1.27-alpine
# 具体演示页是纯静态资源（无后端、无 DB、无状态、零信任客户端）
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]