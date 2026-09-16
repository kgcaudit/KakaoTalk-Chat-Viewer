# 대화서랍 (KakaoTalk Chat Viewer)

카카오톡에서 내보낸 대화 TXT/ZIP을 **브라우저 안에서만** 열어 보는 단일 HTML 뷰어입니다.
`index.html` 하나가 전부이며, 빌드 과정이 없습니다.

```
index.html            뷰어 본체 (이 파일만 배포됩니다)
.github/workflows/    CI + GitHub Pages 배포
deploy/               정적 호스팅용 보안 헤더 설정 (nginx · Caddy · Netlify/Cloudflare Pages)
tools/csp-hashes.mjs  인라인 스크립트·스타일의 CSP 해시 생성기
tests/verify.mjs      배포 전 검증 스위트
```

## 인라인 스크립트를 수정했다면

CSP가 인라인 스크립트를 **해시로 고정**하고 있습니다. `index.html`의 `<script>`나 `<style>`을
한 글자라도 고치면 반드시 해시를 다시 만드세요.

```sh
npm run csp     # <meta> CSP를 현재 내용에 맞게 갱신
```

잊어도 조용히 깨지지는 않습니다. `npm test`가 브라우저를 띄우기 전에 해시를 먼저 검사하고,
어긋나면 실행할 명령을 알려주며 멈춥니다.

## 배포

### GitHub Pages (현재 사용 중)

`main`의 검증이 통과하면 `.github/workflows/verify.yml`의 `deploy` 잡이 자동으로 배포합니다.
공개되는 파일은 **`index.html` 하나뿐**이며, 테스트·도구·서버 설정은 저장소에만 남습니다.

처음 한 번은 **Settings → Pages → Source** 를 `GitHub Actions`로 지정해야 합니다
(워크플로가 스스로 켜려 시도하지만, 저장소 권한에 따라 수동 선택이 필요할 수 있습니다).

Pages는 응답 헤더를 설정할 수 없어 `deploy/`의 `frame-ancestors` 등은 적용되지 않습니다.
**이 페이지에서는 실질적인 차이가 없습니다** — 서버에 세션도 저장 데이터도 없고, 파괴적인
동작(`저장된 대화 삭제`)은 네이티브 `confirm()`을, 가져오기는 네이티브 파일 선택창을 거치므로
클릭재킹으로 유도할 수 없습니다. 바깥 통신을 막는 `connect-src 'none'`은 페이지의 `<meta>`
CSP에 있어 Pages에서도 그대로 작동합니다. 메시지 속 링크는 `rel="noopener noreferrer"`라
리퍼러도 새지 않습니다.

### 직접 호스팅

`index.html`을 정적 호스팅에 올리고, `deploy/` 아래 설정 중 환경에 맞는 것을 적용하세요.
Cloudflare Pages·Netlify는 `deploy/_headers`를, nginx·Caddy는 해당 설정 파일을 그대로 씁니다.
이쪽은 `frame-ancestors`와 GET·HEAD 외 메서드 거부까지 적용됩니다.

```sh
# 로컬 확인
npm run serve        # http://localhost:8080

# 배포 전 검증
npm ci
npx playwright install chromium
npm test
```

`npm test`는 세 가지를 차례로 돌립니다.

| 단계 | 내용 |
|---|---|
| `tools/csp-hashes.mjs --check` | CSP 해시가 현재 인라인 스크립트와 일치하는지 |
| `npm run lint:html` | `html-validate` 마크업 검사 |
| `tests/verify.mjs` | 실제 Chromium으로 가져오기·내보내기·성능 28개 항목 |

빠른 두 가지를 먼저 돌리므로, 해시를 잊었거나 마크업이 깨졌으면 브라우저가 뜨기 전에 멈춥니다.

**CI**: `.github/workflows/verify.yml`이 `main` 푸시와 모든 PR에서 같은 순서로 실행합니다.
브라우저 빌드는 Playwright 버전에 묶여 있으므로 `package.json`이 버전을 **정확히 고정**하고
(범위 지정 아님), 워크플로는 그 버전을 캐시 키로 씁니다. Playwright를 올릴 때는 버전을
직접 바꿔 주세요.

## 업로드 자료는 호스팅에 남지 않습니다

사용자가 가져온 대화 TXT·ZIP·첨부물은 **서버로 전송되지 않습니다.** 설계상 전송할 경로가 없고,
그 상태를 아래 세 겹으로 강제·검증합니다.

**1. 브라우저가 차단합니다.** `index.html`의 `<meta>` CSP가 모든 바깥 통신을 막습니다.

```
default-src 'none'; script-src 'sha256-…'; style-src-elem 'sha256-…';
connect-src 'none'; form-action 'none'; base-uri 'none'
```

`connect-src 'none'`은 `fetch`·`XMLHttpRequest`·`sendBeacon`·WebSocket을 전부 거부하고,
`form-action 'none'`은 폼 전송을, `base-uri 'none'`은 기준 URL 탈취를 막습니다.
`script-src`에 `'unsafe-inline'`이 없고 실제 스크립트의 SHA-256만 들어 있으므로,
주입된 인라인 스크립트는 실행되지 않습니다(`style-src-elem`도 같은 방식). 앱이 쓰는
인라인 style **속성**은 `style-src`로 허용되며, `style-src-elem`을 모르는 브라우저는
`style-src`로 안전하게 되돌아갑니다.
파일은 `<input type="file">`과 File API로만 읽으므로 네트워크를 거치지 않습니다.
ZIP 해제(`DecompressionStream`)와 미리보기(`blob:` URL)도 전부 브라우저 안에서 끝납니다.

**2. 서버가 받지 않습니다.** `deploy/`의 nginx·Caddy 설정은 GET·HEAD 외의 메서드를 거부하고
요청 본문 크기를 0으로 둡니다. 업로드를 받을 수 없는 서버는 업로드를 보관할 수도 없습니다.

**3. 매번 검증합니다.** `npm test`가 실제 Chromium으로 ZIP 가져오기 → 내보내기 → 재열기
전 과정을 재생하면서, 문서 자신과 `blob:`/`data:` 외의 요청이 **단 한 건이라도** 발생하면
실패합니다. 내보낸 파일이 이 사이트의 저장소를 건드리지 않는지, 5만 건 대화가 2초 안에
그려지는지도 같은 스위트에서 확인합니다.

가져온 대화는 **사용자 기기의 IndexedDB**에만 남습니다(서버가 아니라 그 사람의 브라우저입니다).
사이드바의 `저장된 대화 삭제`로 지울 수 있습니다. 공용 PC에서는 이 점을 안내해 주세요.

`HTML 파일로 저장`으로 내보낸 파일에는 대화 내용이 그대로 들어 있습니다.
내보낸 파일은 **공개 경로에 올리지 마세요.** 파일 자체에 `noindex,noarchive,nosnippet`를
넣어 두었지만 그것만으로 접근이 막히지는 않습니다.

## 브라우저 요구 사항

Chrome/Edge 113+, Firefox 113+, Safari 16.4+.
ZIP 가져오기에 `DecompressionStream('deflate-raw')`이 필요합니다. 지원하지 않는 브라우저에서는
압축을 풀어 TXT와 첨부물을 따로 가져오라는 안내가 표시됩니다.

## 알려진 동작

- 본문이 정확히 `사진`, `동영상`, `음성메시지`인 메시지에는 "첨부물 확인 필요" 카드가
  **본문과 함께** 표시됩니다. 카카오톡 내보내기 형식이 원본 파일명을 남기지 않아 실제 사진인지
  사용자가 그렇게 친 것인지 구분할 수 없으므로, 본문을 지우지 않고 파일 연결 수단만 덧붙입니다.
- ZIP은 512MB까지, 항목 10,000개까지 받습니다. 더 큰 기록은 압축을 풀어 나누어 가져와야 합니다.
- 내보내기는 첨부물을 base64로 인라인하므로 결과 파일이 원본의 약 1.34배가 됩니다
  (base64의 이론상 하한). 첨부물이 수백 MB인 대화는 나누어 내보내세요.
- 내보낸 파일의 대화 데이터는 `<script id="embedded-chat">` 안에 평문 JSON으로 들어갑니다.
  **HTML 미니파이어를 거치지 마세요.** 스크립트 본문을 건드리면 데이터가 깨집니다.
  이전 버전이 만든 base64 형식의 파일도 그대로 열립니다.
