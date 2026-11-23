# Stage 1: Build React/Vite app
# CI와 같은 Node 버전으로 빌드한다 (docs/Task_ORDER.md T-09)
# 기반 이미지는 다이제스트로 고정한다 (plan.md 5장 S-4, docs/security.md SEC-006, T-36): 2026-11-23 빌드에서 쓰던 이미지 그대로
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a as builder

WORKDIR /app

# 잠금 파일(package-lock.json) 그대로 설치한다 (plan.md QA-43 / P6-3, T-182). 잠금 파일과 package.json이 어긋나면 빌드가 실패한다
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
# 시험 코드 타입 검사와 lint (plan.md P6-3 · QA-43, T-224). 오류나 경고가 있으면 이미지가 만들어지지 않는다
RUN npm run typecheck:test
RUN npm run lint
# 테스트가 실패하면 이미지가 만들어지지 않는다 (docs/Task_ORDER.md T-45). Node 22 내장 node:test와 타입 제거 실행, 새 의존성 없음
RUN npm test

# Stage 2: Serve with Nginx
# 다이제스트 고정(S-4). 비root 실행은 컨테이너 포트를 80 → 8080으로 바꿔야 해 사용자 결정 대기(plan.md 5.3 결정 1)
FROM nginx:alpine@sha256:fb4658584bd9a916ffb6f6e365f97c25cfdb2923801f551ea08356e695f14ff7

# Copy built assets from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html
# 압축·캐시 헤더 설정 (plan.md FQA-18, T-207)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose port 80
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
