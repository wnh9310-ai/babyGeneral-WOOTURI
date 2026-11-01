# Apple 건강 XML 가져오기와 단축어 연결

> 단축어 JSON 계약 안내입니다. iPhone에 설치할 실제 단축어 파일이나 iCloud 공유 링크는 아직 없습니다.

Safari 웹앱은 HealthKit에 직접 접근할 수 없습니다. 건강 앱에서 XML/ZIP을 만든 뒤 웹앱에서 파일을 한 번 선택하면 XML 파싱, ZIP 안의 GPX 추출·운동 연결, 기존 기록과 병합, 브라우저 IndexedDB 저장까지 자동으로 이어집니다. 파일 내용은 페이지 서버로 전송되지 않습니다. 가져온 운동·활동 날짜·경로 수와 저장 성공 여부를 결과 문구에 표시합니다.

## 파일 형식

UTF-8 JSON, `schemaVersion`은 `1`이어야 합니다. 날짜와 시각은 ISO 8601로 적습니다. 숫자 단위는 걸음 수/층 수=count, 거리=meter, 활동 에너지=kcal, 심박수=bpm입니다. 없는 값은 생략하거나 `null`로 둡니다.

```json
{
  "schemaVersion": 1,
  "source": "apple-shortcuts",
  "generatedAt": "2026-11-01T07:00:00+09:00",
  "dailyActivity": [
    {
      "date": "2026-11-01",
      "stepCount": 7342,
      "walkingRunningDistanceMeters": 5120,
      "flightsClimbed": 3,
      "activeEnergyKilocalories": 310
    }
  ],
  "workouts": [
    {
      "activityTypeIdentifier": "HKWorkoutActivityTypeRunning",
      "activityTypeName": "달리기",
      "startDate": "2026-11-01T06:00:00+09:00",
      "endDate": "2026-11-01T06:45:00+09:00",
      "durationSeconds": 2700,
      "distanceMeters": 7000,
      "activeEnergyKilocalories": 420,
      "sourceName": "Apple Watch",
      "heartRate": [
        {"timestamp": "2026-11-01T06:10:00+09:00", "beatsPerMinute": 145}
      ],
      "route": [
        {"latitude": 37.5001, "longitude": 127.0012},
        {"latitude": 37.5010, "longitude": 127.0023}
      ]
    }
  ]
}
```

`route`는 위도·경도 배열이며 최소 두 점이 있어야 사진 합성에 사용할 수 있습니다. XML과 GPX를 함께 선택해도 됩니다. GPX 경로는 시작 시각이 가까운 운동 기록에 자동으로 연결됩니다.

## XML 또는 ZIP 가져오기

iPhone 건강 앱에서 프로필 사진 → **모든 건강 데이터 내보내기**를 누릅니다. 내보낸 ZIP 파일을 웹앱에서 선택하면 브라우저가 안의 `export.xml`과 `workout-routes/*.gpx`를 자동으로 열고, GPX를 해당 운동에 연결합니다. ZIP이 열리지 않는 구형 브라우저에서는 Files 앱에서 압축을 푼 뒤 XML과 필요한 GPX를 직접 선택할 수 있습니다.

이 흐름은 파일 선택 후의 처리를 자동화합니다. 건강 앱의 XML 내보내기 자체는 사용자가 시작해야 하고, Safari 웹앱은 새 XML이 생겼는지 Files/iCloud Drive를 감시하지 않습니다. 매일 자동으로 파일 생성과 가져오기를 이어가는 건 웹앱에서 할 수 없습니다. 그런 지속 동기화에는 HealthKit 권한을 가진 네이티브 iOS 앱이 필요합니다.

## 단축어 자동 수집 상태

Apple 단축어는 필요한 건강 샘플을 JSON 파일로 만들 수 있지만, 건강 앱의 전체 XML 내보내기를 대신 생성하지는 않습니다. JSON 형식은 위 계약에 따르며 웹앱에서 XML/ZIP과 같은 가져오기 동작으로 읽습니다. 저장소에는 아직 설치용 Shortcut 파일이나 iCloud 공유 링크가 없으므로 자동화 단축어 배포는 제공하지 않습니다. 단축어로 파일을 만들더라도 갱신된 파일은 웹앱에서 다시 선택해야 합니다.

## 저장 범위

- 원본 파일은 업로드하지 않습니다.
- 가져온 건강 값과 경로는 이 브라우저의 IndexedDB에 저장됩니다.
- 사진은 메모리에서만 편집하고, 저장할 때 합성된 JPEG만 내려받습니다.
- **내 데이터 JSON으로 내보내기**로 백업하고, **이 기기의 기록 지우기**로 로컬 기록을 지울 수 있습니다.
- GitHub Pages를 공개 호스팅하면 방문 시각/접속 IP 같은 페이지 요청 정보는 호스팅 사업자에 전달될 수 있습니다. 건강 파일 내용은 페이지 코드에서 네트워크 전송하지 않습니다.
