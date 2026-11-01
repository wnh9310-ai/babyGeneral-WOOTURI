# 아기장수우투리 웹 기록장

정적 파일만으로 동작하는 모바일 웹앱입니다. `index.html`을 HTTPS 호스팅하면 Safari의 공유 메뉴에서 홈 화면에 추가할 수 있습니다. 개발 중에는 프로젝트 루트에서 `python3 -m http.server 4175 --directory web`로 시작한 뒤 `http://localhost:4175`로 엽니다. 다른 로컬 서버와 저장 기록이 섞이지 않도록 별도 포트를 사용합니다.

- 데이터 계약과 Apple 건강 가져오기: [SHORTCUT_SETUP.md](./SHORTCUT_SETUP.md)
- 단위 테스트: `node --test web/tests/data.test.mjs`
- 브라우저 파서 점검: `web/tests/browser-smoke.html`을 로컬 서버에서 엽니다.

앱은 Apple 건강 내보내기 ZIP(내부 XML/GPX 자동 추출), 개별 XML/GPX, 단축어 JSON을 브라우저에서 읽고 IndexedDB에 저장합니다. 건강 데이터와 사진은 서버에 업로드하지 않습니다.

기본 지도는 API 키가 필요 없는 Leaflet + OpenStreetMap입니다. 지도 타일 요청으로 표시 지역과 IP가 OpenStreetMap 서버에 전달되며, 경로 선은 브라우저에서 그립니다. 지도 출처 표기를 유지하고 대량 다운로드·미리 받기를 제공하지 않습니다. Leaflet 1.9.4는 `vendor/leaflet`에 포함됩니다.

운동 상세에서 고도·XML 심박·속도를 각각 최저–최고 배율로 겹쳐 표시합니다. 경로 재생과 12초 영상 저장을 지원하며, 브라우저가 지원하는 MP4 또는 WebM을 사용합니다. 영상 배경은 지도 타일이 없는 경로 선입니다. 사진 스탬프는 8종 배치, 투명 배경, 크기 조절과 이동을 지원합니다.

전체 단위 테스트: `node --test web/tests/*.test.mjs`
