# 사내 MICE 뉴스레터 프로젝트

> 상태: **기획 단계 (Phase 0)** — 별도 Git 프로젝트 생성 전까지 이 폴더에서 마크다운으로 기획·콘텐츠를 관리합니다.

## 한 줄 요약
MICE 업계 동향, 국내 주요 venue 행사 캘린더, 동종(등록) 업체 소식을 한곳에 모아 사내에 정기 배포하고, 이후 수집·작성·발송을 단계적으로 자동화한다.

## 목적
1. **업계 관심 환기** — 우리 회사가 속한 MICE 업계 현황을 누구나 쉽게 파악하고 관심을 갖도록 한다.
2. **정체 방지** — 국내 1·2위 인지도에 안주하지 않도록, 동종 업계의 새 시스템·신생 업체·주요 업데이트를 꾸준히 접하고 자극받는다.

## 문서 구성

| 파일 | 내용 |
|---|---|
| [01-planning.md](01-planning.md) | 기획서: 목적, 독자, 발행 주기, 섹션 구성, 톤앤매너 |
| [02-sources.md](02-sources.md) | 정보 소스 목록: venue 캘린더, 업계 뉴스, 동종 업체 |
| [03-distribution-plan.md](03-distribution-plan.md) | 배포 계획: 채널, 일정, 역할, 운영 프로세스, 성과 지표 |
| [04-automation-roadmap.md](04-automation-roadmap.md) | 자동화 로드맵: 수동 → 반자동 → 자동 단계별 계획 |
| [templates/newsletter-template.md](templates/newsletter-template.md) | 매 호 작성용 템플릿 |
| [data/sources.yaml](data/sources.yaml) | 자동화 대비 소스 목록(기계가 읽을 수 있는 형태) |
| `issues/` | 발행 호별 원고 (`YYYY-MM.md` 또는 `YYYY-Www.md`) |

## 진행 단계 (요약)
- **Phase 0 — 기획 (현재)**: 문서 확정, 소스 검증, 파일럿 1호 수동 제작
- **Phase 1 — 수동 운영**: 템플릿 기반으로 2~3회 발행, 피드백 수집, 주기 확정
- **Phase 2 — 반자동**: venue 캘린더·뉴스 수집 스크립트 + AI 요약 초안 → 사람이 검수 후 발송
- **Phase 3 — 자동화**: 예약 실행(GitHub Actions 등)으로 초안 생성·검수 요청·발송까지 파이프라인화

자세한 내용은 [04-automation-roadmap.md](04-automation-roadmap.md) 참고.

## 미결 사항 (Open Questions)
- [ ] 발행 주기 확정 (권장안: 월간 본편 + 격주/주간 "행사 캘린더 단신" — [01-planning.md](01-planning.md#3-발행-주기) 참고)
- [ ] 배포 채널 확정 (사내 메일 / 메신저(Slack·Teams·잔디 등) / 그룹웨어 게시판)
- [ ] 뉴스레터 이름
- [ ] 편집 담당자 및 검수자 지정
- [ ] 자사 시스템 소개서 반영 — **첨부 파일이 저장소에 없어 아직 확인하지 못함.** `newsletter/reference/`에 넣어주면 경쟁사 비교 관점(기능 체크리스트)을 소개서 기준으로 보강 예정
- [ ] 동종 업체(경쟁사) 리스트 확정 — 사내에서 실제로 경쟁하는 업체명 보강 필요
