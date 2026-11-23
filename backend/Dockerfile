# yahoo-finance2가 Node 22 이상을 요구한다 (docs/Task_ORDER.md T-09, P-18)
# 기반 이미지를 다이제스트로 고정한다 (plan.md 5장 S-4, docs/security.md SEC-006, T-36): 2026-11-23 빌드에서 쓰던 이미지 그대로.
# 태그만 쓰면 새로 받을 때마다 내용이 바뀔 수 있다. 보안 패치를 받으려면 승인된 빌드에서 다이제스트를 바꾼다
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

WORKDIR /app

# Install dependencies first for caching
# 잠금 파일(package-lock.json) 그대로 설치한다 (plan.md QA-43 / P6-3, T-182). 잠금 파일과 package.json이 어긋나면 빌드가 실패한다
COPY package*.json ./
RUN npm ci

# Copy source code and build
COPY . .
RUN npm run build
# 테스트가 실패하면 이미지가 만들어지지 않는다 (docs/Task_ORDER.md T-45). Node 내장 node:test + 기존 tsx, 새 의존성 없음
RUN npm test

# Expose API port
EXPOSE 3001

# 실행은 root가 아닌 이미지의 기본 일반 사용자(node, uid 1000)로 (plan.md 5장 S-4, SEC-006, T-36).
# 앱은 디스크에 쓰지 않는다(읽기만). 설치·빌드·시험은 위에서 root로 끝낸다. 포트는 모두 1024보다 커서 권한이 필요 없다
USER node

# Default command (can be overridden by docker-compose for the worker)
# npm을 거치지 않고 node를 직접 실행해서 SIGTERM이 앱의 종료 처리로 바로 전달되게 한다 (docs/Task_ORDER.md T-28).
# npm run start와 같은 명령이다 (package.json의 start 스크립트).
CMD ["node", "dist/index.js"]
