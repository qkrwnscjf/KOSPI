# Stage 1: Build React/Vite app
# CI와 같은 Node 버전으로 빌드한다 (docs/Task_ORDER.md T-09)
FROM node:22-alpine as builder

WORKDIR /app

# 잠금 파일(package-lock.json) 그대로 설치한다 (plan.md QA-43 / P6-3, T-182). 잠금 파일과 package.json이 어긋나면 빌드가 실패한다
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
# 테스트가 실패하면 이미지가 만들어지지 않는다 (docs/Task_ORDER.md T-45). Node 22 내장 node:test와 타입 제거 실행, 새 의존성 없음
RUN npm test

# Stage 2: Serve with Nginx
FROM nginx:alpine

# Copy built assets from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Expose port 80
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
