# KOSPI Insight Dashboard

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?style=flat&logo=react&logoColor=61DAFB)
![Fastify](https://img.shields.io/badge/Fastify-000000?style=flat&logo=fastify&logoColor=white)
![Apache Kafka](https://img.shields.io/badge/Apache_Kafka-231F20?style=flat&logo=apache-kafka&logoColor=white)
![TimescaleDB](https://img.shields.io/badge/TimescaleDB-FDB515?style=flat&logo=postgresql&logoColor=black)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat&logo=docker&logoColor=white)
![AWS EKS](https://img.shields.io/badge/AWS_EKS-FF9900?style=flat&logo=amazonaws&logoColor=white)
![ArgoCD](https://img.shields.io/badge/ArgoCD-EF7B4D?style=flat&logo=argo&logoColor=white)

---

## Purpose

본 프로젝트는 단순한 대시보드를 만드는 것을 넘어, **금융 시세 데이터를 파이프라인 안에서 최소 지연으로 처리하고 정확하게 저장·제공하는 "모던 데이터 파이프라인"을 직접 구축하고 수치로 검증**하기 위해 시작되었습니다. 무료 소스를 쓰므로 국내 시세 자체는 소스에서 약 20분 늦습니다([알려진 한계](#알려진-한계)).
도커(Docker) 구동부터 **AWS EKS(쿠버네티스)** 와 **ArgoCD(GitOps)** 를 활용한 배포 실습까지 담은 인프라 & Ops(DevOps) 학습용 프로젝트입니다.

---

## Approach

*   **이벤트 기반 아키텍처 (EDA)**: Kafka를 **유일한 데이터 출처**로 두고, 실시간 전송 경로와 DB 저장 경로가 Kafka를 각자 독립적으로 읽습니다. 한쪽이 느려지거나 멈춰도 다른 쪽에 영향을 주지 않습니다.
*   **측정 기반 개선**: 모든 변경은 채택 기준을 먼저 정한 뒤 Before/After를 측정해서, 효과가 확인된 것만 반영했습니다.
*   **12-Factor App**: 코드와 설정을 분리했습니다. 코드를 바꾸지 않고 로컬(Docker Compose)과 클러스터(EKS)를 오갈 수 있도록 모든 접속 정보는 환경변수로 받습니다.
*   **GitOps 지향**: 인프라 상태를 GitHub에 두고 ArgoCD가 동기화하는 구조를 목표로 합니다.

---

## Architecture

```
Yahoo Finance (27개 지표, 요청 1회)
   │ 장중 5초 · 휴장 15초 · 장 마감 60초 (시장별 장 시간 + 소스의 장 상태로 판단)
   ▼
worker ── 값 검증 · 심볼 정규화 · 바뀐 값만 전송 ──▶ Kafka `market-ticks`
                                                       │
            ┌──────────────── 실시간 경로 ──────────────┴──────────── 저장 경로 ────────────┐
            ▼                                                                                ▼
   backend Gateway ── 먼저 전송 ──▶ Socket.io ──▶ 브라우저              db-sink ── 묶음 INSERT (중복 차단)
            └─ 그다음 Redis에 최신값 캐시 (기다리지 않음)                         ▼
                                                                    TimescaleDB
   backend History API ◀── 5분 · 1시간 · 1일 연속 집계 (1년 보관) ◀── 원본 tick (3시간 보관)

   잘못된 메시지 ──▶ Kafka `market-ticks.dlq` (격리 후 처리 계속)
   지표 ──▶ Prometheus ──▶ Grafana (대시보드 · 알림 규칙 자동 등록)

KRX Open API ──▶ krx-collector ──▶ Kafka `index-daily` ───────────────▶ Gateway(화면 최신값) + db-sink
                               └─▶ Kafka `market-breadth` · `stock-rankings` ──▶ db-sink
DART OpenAPI ──▶ disclosure-collector ──▶ Kafka `disclosures` ─────────▶ Gateway(새 공시) + db-sink
공공데이터포털 ──▶ market-stats-collector ──▶ Kafka `market-flows` ─────▶ db-sink
Yahoo 일봉 ──▶ db-sink가 받아 Kafka `yahoo-daily`로 전송 ───────────────▶ db-sink (검증 후 저장)
Yahoo 5분·1시간 봉 ──▶ 꺼져 있던 구간만 받아 Kafka `yahoo-bars`로 전송 ──▶ db-sink (검증 후 저장)
모든 수집 경로 ──▶ 실행 기록 Kafka `ingestion-runs` ─────────────────────▶ db-sink
db-sink ──▶ 15분마다 API별 품질 검사 26개 ──▶ `dq_results` + Grafana 패널·알림
   · 각 수집기는 자기 API 키만 가지며, 키가 없으면 외부에 접속하지 않고 대기합니다
   · 시작할 때 backend에 이미 저장된 기간을 물어 빠진 기간만 채웁니다
```

| 구성 요소 | 역할 |
| :--- | :--- |
| **worker** | Yahoo에서 27개 지표를 한 번의 요청으로 수집해 Kafka로 보냅니다. 요청 시간 제한, 실패 시 지수 백오프, 수집이 겹치지 않는 고정 주기 실행, 장 시간·휴장 판단에 따른 주기 조절. 열린 시장의 지표만 요청하고 전체는 60초마다 요청하며, 재시작해도 바뀌지 않은 값을 다시 보내지 않습니다 |
| **krx-collector** | KRX Open API에서 코스피200 변동성지수, 대표 지수 3종(코리아 밸류업·KRX 300·KRX 100), KRX 섹터 지수 17종의 일별 종가와 코스피 200 일봉, 유가증권·코스닥 시장 폭(상승·하락·보합 종목 수, 거래대금), 종목 순위 상위 100개를 받습니다(최근 1년 중 빠진 기간만 채우기, 이후 30분마다 필요한 날짜만 확인) |
| **disclosure-collector** | DART OpenAPI에서 유가증권 공시를 1분 주기(평일 낮)로 받고, 증자·사채 발행·자사주 공시는 금액을 함께 받습니다. 공시 제출인 이름은 저장하지 않습니다 |
| **market-stats-collector** | 공공데이터포털(금융투자협회 종합통계)에서 증시자금추이·신용공여잔고추이 14개 지표를 6시간마다 받습니다. 일시 실패는 30분 뒤 다시 시도합니다 |
| **Kafka** | KRaft 모드(Zookeeper 없음) 브로커 1대, 토픽 20개(데이터 10 + DLQ 10). 실시간 tick은 24시간, 나머지는 7일 보관합니다. 데이터는 볼륨에 보존되어 재기동해도 밀린 메시지를 이어서 처리합니다 |
| **backend (Fastify)** | Kafka를 읽어 WebSocket으로 즉시 전송(Gateway), 과거 그래프·공시·자금 흐름·순위·리스크·파이프라인 상태 REST API |
| **db-sink** | Kafka를 따로 읽어 TimescaleDB에 묶음 저장. 저장에 성공한 뒤에만 읽은 위치를 기록해서 데이터를 잃지 않습니다. Yahoo 일봉(과거 일봉, 빈 날, 장 마감 30분 뒤의 공식 종가)과 꺼져 있던 구간의 5분·1시간 봉도 받아 Kafka를 거쳐 저장합니다(집계는 다시 계산하지 않음). 잘못된 메시지와 DB가 거부한 값은 db-sink가 그 메시지만 DLQ로 보내고, Gateway는 세고 건너뜁니다. 15분마다 API별 품질 검사(신선도, 빠진 날, 소스 간 대조, 값 범위, 보관 초과 등)를 돌려 결과를 남깁니다 |
| **TimescaleDB** | 원본 tick은 3시간만 보관하고, 5분·1시간·1일 봉을 계층형 연속 집계로 1년 보관. 일별 지수(KRX·Yahoo 값을 API별 표로 분리)·시장 폭·종목 순위·공시·자금 흐름도 1년 보관. 공백을 메우는 5분·1시간 봉은 별도 테이블에 8일, 수집 실행 기록과 품질 검사 결과는 30일 보관합니다. 기간이 지난 데이터는 보관 정책이 자동으로 지우며, 청크 단위로 지워서 표에 따라 청크 간격만큼 더 남을 수 있습니다. 사용 통계 전송은 꺼 두었습니다 |
| **Redis** | 최신값 캐시(새로 접속한 화면에 바로 표시, 재기동해도 볼륨에 유지), 과거 조회 캐시 |
| **frontend (React + Vite)** | 흑백 라이트·다크 테마에 은은한 강조색, 왼쪽 사이드바 메뉴. 브라우저 탭 하나가 WebSocket 연결 하나를 공유합니다 |
| **Prometheus / Grafana** | 단계별 지연, 수집 성공률, 컨슈머 지연, DB 용량 대시보드와 알림 규칙 |

---

## 개선 결과 (로컬 측정값)

| 항목 | 개선 전 | 개선 후 |
| :--- | :--- | :--- |
| 화면 값의 평균 경과 시간 (수집 주기) | 5초 (10초 주기) | 2.5초 (5초 주기) |
| 수집 → WebSocket 전송 지연 (p50) | 약 50~66ms | 약 35~50ms |
| 과거 그래프 조회 (p50) | 138ms (외부 API 직접 호출) | 3ms (DB 집계 조회) |
| 집계 저장 용량 | 74.8MB | 5.7MB |
| Redis 장애 중 실시간 전송 | 사실상 중단 (분당 1건) | 정상 유지 (분당 120건) |
| 재시작 시 Kafka 재참여 | 약 12.6초 | 약 3.1초 |
| 잘못된 메시지 1건 | 실시간 전체 중단 | DLQ로 격리하고 처리 계속 |
| 수집기 재시작 시 외부 호출 | KRX 약 532회, DART 276회 | KRX 12회, DART 8회 |
| KRX 수집 주기당 호출 | 18회 | 받을 날짜가 없으면 0회 |
| 일봉 종가 (스택이 장 일부만 떠 있던 날) | 집계 값(S&P 500 최근 10일 중 3일이 공식 일봉과 다름) | 공식 일봉 사용(다른 날 0). 코스피·코스피 200·대형주 3종은 KRX 공식 종가와 50/50 일치 |
| 전체 재기동 시 닫힌 시장 재전송 | 17건 | 0건 |
| 꺼져 있던 구간의 그래프 (코스피 1일 / 1주 점 수) | 2점 / 4점 | 75점 / 34점 (집계 값 변화·중복 0) |
| DB가 거부하는 값 1건 (소수 거래량) | 저장 0행으로 전체 멈춤 | 그 메시지만 DLQ로 격리하고 저장 계속 |
| Redis 장애 중 구독 첫 값 읽기 | 8 ~ 37초 기다린 뒤 실패 | 1ms 이하, KRX 일별 지표는 DB 값으로 18ms 이하 |
| 응답 없는 시세 요청 (흉내 낸 상황) | 끊기지 않고 쌓임 (2분 동안 4건) | 시간 제한 때 끊겨 0건 |

수치는 개인 PC의 Docker Compose 환경에서 측정한 값이며, 환경에 따라 다를 수 있습니다. Kafka 파티션 증가, 컨슈머 대기 시간·acks 조정, 컨슈머 분리는 측정 결과 개선이 없어 채택하지 않았습니다.

### 알려진 한계

*   **국내 시세는 실시간이 아닙니다.** Yahoo가 코스피·코스닥·코스피 200·대형주 3종과 대만 가권을 약 20분, 니케이 225를 약 15분 늦게 제공합니다(국내 장중 실측). 파이프라인 내부 지연(p50 약 25ms)과는 별개이며, 소스를 바꾸지 않으면 줄어들지 않습니다. 화면에는 "지연" 배지로 표시됩니다.
*   스택이 꺼져 있는 동안의 틱은 복구되지 않아 실시간 차트에는 공백이 남습니다. 1일·1주 그래프는 Yahoo 5분·1시간 봉으로, 1개월 ~ 1년 그래프는 일봉으로(위안/원 제외) 채웁니다. 채운 값은 봉 종가이고, 소스에 봉이 없는 구간은 비어 있습니다.
*   거래소 값과 대조할 수 있는 지표는 코스피와 대형주 3종입니다. 해외 지표는 대조할 다른 출처가 없어 품질 검사가 날짜·값 범위 같은 내부 일관성만 확인합니다.
*   외부 공개를 전제로 만들지 않았습니다. 포트는 모두 `127.0.0.1`에만 열려 있으며, 공개 배포 전에 인증·비밀값 분리 등 보안 작업이 필요합니다.

---

## Quick Start - 로컬 실행

**단 하나의 명령어로 13개 서비스(DB, 캐시, 카프카, 백엔드, 수집기 4종, DB 적재기, 프론트엔드, 모니터링 3종)가 구동되도록 세팅**해 두었습니다. 별도의 `.env` 설정 없이도 실행되며, 이 경우 키가 필요한 수집기(KRX·DART·공공데이터포털)는 대기하고 해당 화면은 비어 있습니다.

### 요구 사항
*   Docker 및 Docker Compose 설치
*   (선택) KRX·DART·공공데이터포털 데이터를 받으려면 각 사이트에서 무료 인증키를 발급받아 **프로젝트 최상위 `.env`**에 `KRX_API_KEY`, `DART_API_KEY`, `DATA_GO_KR_SERVICE_KEY`로 넣습니다. KRX는 사용할 서비스(지수 일별 시세, 유가증권·코스닥 일별매매정보)별 이용 승인이, 공공데이터포털은 "금융투자협회 종합통계" 활용 신청이 필요합니다. `.env`는 git에 올라가지 않습니다

### 실행 명령어
```bash
# 레포지토리 클론 후 최상단 디렉토리에서 실행
docker-compose up -d --build

# 종료 (데이터는 볼륨에 유지)
docker-compose down
```
> 각 서비스는 의존 서비스가 준비(healthcheck)된 뒤 순서대로 시작합니다. 수집기와 DB 적재기는 첫 컨테이너가 뜬 뒤 약 20초 후에 시작됩니다.
> 처음 실행하면 DB 적재기가 최근 1년치 과거 데이터를 한 번 채웁니다(약 1~2분).

### 서비스 접속 주소

| 서비스 명 | 접속 주소 | 설명 |
| :--- | :--- | :--- |
| **프론트엔드 대시보드** | `http://localhost:5173` | 메인 UI (왼쪽 사이드바 아래 버튼으로 라이트·다크 전환) |
| **백엔드 API 서버** | `http://localhost:3001` | REST API 및 WebSocket |
| **Grafana 모니터링** | `http://localhost:3000` | "KOSPI Pipeline" 대시보드와 알림 규칙 자동 등록. 초기 계정은 Grafana 기본값(`admin` / `admin`)이며, 로컬 실습용입니다 |
| **Prometheus** | `http://localhost:9090` | 지표 원본 조회 |

### 테스트
```bash
cd backend && npm test     # 메시지 검증, 장 시간·휴장 판단, 심볼 허용 목록, 공시 분류, 외부 API 호출 보호, 응답 형식 계약, 품질 검사 규칙
cd frontend && npm test    # 차트 점 계산, 장 상태 배지, 숫자·금액 표시
```
Node 22 내장 테스트 러너(`node:test`)를 사용합니다. Docker 이미지 빌드와 GitHub Actions CI에서도 자동으로 실행되며, 테스트가 실패하면 이미지가 만들어지지 않습니다.

---

## 데이터 안내

| 구분 | 내용 |
| :--- | :--- |
| 시세 지표 (27개, Yahoo Finance, 장중 5초 수집) | **국내** 코스피·코스닥·코스피 200, 삼성전자·SK하이닉스·현대차 / **매크로** 원/달러·엔/원·위안/원, 달러 인덱스, 미 국채 13주·5년·10년·30년, VIX / **글로벌** S&P 500·나스닥 100·다우·러셀 2000·필라델피아 반도체, 니케이 225·대만 가권, WTI·브렌트·천연가스·금·구리 |
| 계산 지표 | 미 장단기 금리차(10년물 − 13주)는 저장하지 않고 조회할 때 두 지표로 계산합니다 |
| 지연 시세 | 엔/원·위안/원 약 3분, 달러 인덱스·원자재 선물 약 10분, 미 국채 금리·VIX·러셀 2000·니케이 225 약 15분, 국내 6종·대만 가권 약 20분 늦은 시세이며(로컬 실측), 화면에 "지연" 배지로 표시됩니다 |
| 일별 지표 (21개) | 코스피200 변동성지수, 대표 지수 3종, KRX 섹터 지수 17종은 KRX Open API의 **일별 종가**라 1주 ~ 1년 그래프만 있고 "일별 시세" 배지가 붙습니다 |
| 나중에 추가한 지표의 과거 | 1개월 ~ 1년 그래프는 수집을 시작하기 전 기간을 과거 일봉으로 이어 붙입니다(코스피 200은 KRX 일봉). 1일·1주 그래프는 최근 구간을 Yahoo 5분·1시간 봉으로 채웁니다. 위안/원은 소스가 과거 일봉을 주지 않아 1개월 ~ 1년 그래프가 수집 시작 뒤부터 쌓입니다 |
| 1일 봉 종가 | 국내·미국·도쿄·대만 지표 17종은 장 마감 30분 뒤부터 공식 일봉을 먼저 씁니다. 환율·원자재·VIX 10종은 하루 종가의 기준이 소스마다 달라 집계 값을 씁니다 |
| 공시·자본 이벤트 | 유가증권시장 공시 속보(분류 필터, DART 원문 링크)와 기간별 희석(유상증자·사채) / 주주환원(자사주 취득·소각) 금액. 금액을 알 수 없는 공시는 0이 아니라 "금액 없음"으로 표시하고 합계에서 뺍니다 |
| 시장 폭·거래대금 | 국내 전광판 아래. 유가증권·코스닥의 일별 상승·하락·보합 종목 수와 거래대금(KRX 일별매매정보, 장 마감 후 갱신) |
| 종목 순위 | 시장·날짜별 상승률·하락률·거래대금·시가총액 상위 100개(KRX 일별매매정보) |
| 증시 자금 흐름 | 투자자예탁금, 신용거래융자 등 14개 지표의 최근 1개월(공공데이터포털). 요약과 그래프 화면을 제공하며, 값은 영업일 기준 2 ~ 3일 늦게 공개됩니다 |
| 실적·배당 캘린더 | 이미 저장한 공시로 만든 월 달력(잠정실적·배당 결정·정기보고서). 앞으로의 예정일은 포함하지 않습니다 |
| 시장 연관성·리스크 | 코스피 대비 S&P 500·나스닥 100·필라델피아 반도체·원/달러·VIX·미 10년물의 상관계수·베타, 기간 수익률, 변동성, 최대 낙폭(1·3·12개월). 조회할 때 계산합니다 |
| 파이프라인 상태 | 사이드바의 톱니바퀴 설정 창에서 서비스 응답, 데이터 신선도, Kafka 지연·DLQ, 수집 결과를 보고 Grafana로 이동합니다 |
| 과거 그래프 | 1일(5분 봉), 1주(1시간 봉), 1개월·3개월·1년(1일 봉). 최초 실행 시 채운 과거 데이터는 종가 기준입니다 |
| 데이터 품질 | API별 규칙 26개를 15분마다 확인합니다. 결과는 Grafana "데이터 품질 검사" 패널에서 보고, 실패가 있으면 알림이 켜집니다. 수집 실행 기록(기간, 받은·보낸·버린 건수)도 DB에 남습니다 |
| 장 상태 | 시장별 정규 거래 시간(서울·뉴욕·도쿄(점심 휴장)·대만·24시간 선물/외환)과 소스의 장 상태로 "장중 / 휴장 / 장 마감"을 표시합니다 |

Yahoo Finance는 공식 공개 API가 아니므로, 학습·개인 용도로만 사용하시기 바랍니다. KRX·DART·공공데이터포털 데이터는 각 기관의 이용약관을 따릅니다.

---

## 주요 설정 (환경변수)

| 변수 | 기본값 | 설명 |
| :--- | :--- | :--- |
| `POLLING_INTERVAL_MS` | 10000 (Compose에서는 5000) | 장중 수집 주기 |
| `HOLIDAY_POLLING_INTERVAL_MS` | 15000 | 장 시간이지만 소스가 휴장일 때의 주기 |
| `IDLE_POLLING_INTERVAL_MS` | 60000 | 모든 시장이 닫혔을 때의 주기 |
| `KAFKA_BROKERS` | `localhost:9092` | Compose 안에서는 `kafka:29092` |
| `REDIS_URL`, `DB_HOST` 등 | localhost 기본값 | 접속 정보는 모두 환경변수로 받습니다 |
| `VITE_SOCKET_URL`, `VITE_API_URL` | `http://localhost:3001` 기준 | 프론트엔드가 접속할 주소 |
| `KRX_API_KEY`, `DART_API_KEY`, `DATA_GO_KR_SERVICE_KEY` | 없음 (최상위 `.env`) | 없으면 해당 수집기는 대기 |
| `MARKET_STATS_POLLING_INTERVAL_MS` | 21600000 (6시간) | 증시 자금 흐름 수집 주기 |
| `KRX_BACKFILL_DAYS` / `DISCLOSURE_BACKFILL_DAYS` | 370 / 365 | 처음 채우는 기간(이미 저장된 기간은 건너뜀). 0이면 채우지 않음 |
| `BACKEND_URL` | `http://localhost:3001` (Compose에서는 `http://backend:3001`) | 수집기가 저장된 기간을 묻는 내부 주소 |

---

## 클라우드 배포 가이드라인 (AWS EKS & ArgoCD)

> ⚠️ **`k8s/` 매니페스트는 현재 아키텍처(DB 적재기 분리, KRX·DART·공공데이터포털 수집기, 테스트·healthcheck, 장 시간 기반 수집 등)에 맞게 아직 갱신되지 않았습니다.** 배포 전에 매니페스트 현행화와 비밀값 분리(Kubernetes Secret)가 필요합니다. 아래 내용은 클러스터 실습 절차입니다.

그전에 도커 허브에 push가 진행되어야 합니다.

<details>
<summary><b>EKS + ArgoCD 배포 가이드 펼치기</b></summary>
<br>

### 개요 & 인프라 철학: 왜 EKS와 ArgoCD인가?
*   **12-Factor App (환경변수)**: 코드를 고치지 않고 클라우드 환경에 맞춰 설정값만 유연하게 갈아 끼우도록 설계되었습니다.
*   **ArgoCD GitOps (Pull 기반)**: EKS 클러스터 내부의 ArgoCD가 깃허브를 주시하다가, 변경 사항을 감지하면 서버 상태를 동기화(Pull)하고 자가 치유(Self-healing)합니다.

### 사전 준비 (Mac OS 기준)
```bash
brew install awscli kubectl
brew tap weaveworks/tap && brew install weaveworks/tap/eksctl
aws configure # AWS IAM 액세스 키 입력 (리전: ap-northeast-2)
```

### EKS 클러스터 생성 명령어 (실습 시작)
```bash
eksctl create cluster \
  --name kospi-eks-cluster \
  --region ap-northeast-2 \
  --nodegroup-name standard-workers \
  --node-type t3.medium \
  --nodes 2 \
  --managed
```
**소요 시간**: **약 15분 ~ 20분**. 

### AWS 콘솔 실시간 관전 포인트 
1.  **[CloudFormation]**: 수많은 인프라 스택이 실시간으로 조립(`CREATE_IN_PROGRESS`)되는 광경 캡처.
2.  **[VPC]**: 자동 세팅된 퍼블릭/프라이빗 서브넷과 라우팅 테이블 구경.
3.  **[EC2]**: 워커 노드로 일할 `t3.medium` 서버 2대가 `Running` 중인 모습 캡처.
4.  **[EKS]**: 대시보드의 **[컴퓨팅]** 탭에서 노드 2대가 `Ready` 상태로 연결된 모습 확인.

### 쿠버네티스 조종 및 검증
```bash
kubectl get nodes
kubectl get pods -n kube-system
```

### ArgoCD 연동 
```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
kubectl get pods -n argocd
```

### 클러스터 종료 
> **EKS는 실행하는 동안 비용이 발생합니다. 실습이 끝나면 반드시 클러스터를 종료하세요.**
```bash
eksctl delete cluster --name kospi-eks-cluster --region ap-northeast-2
```
*   **검증**: 삭제 명령 완료 후, AWS 콘솔의 **[EKS]** 메뉴와 **[EC2]** 메뉴가 텅 비었는지 눈으로 직접 확인하세요.
</details>

---

*(참고: 로컬 환경을 커스텀하려면 `frontend/.env.example` 및 `backend/.env.example` 파일을 복사하여 `.env`로 구성하시면 됩니다. 실제 비밀번호나 키는 `.env`에만 두고 저장소에 올리지 마세요.)*
