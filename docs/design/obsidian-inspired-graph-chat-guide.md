# Obsidian-inspired Graph Chat Design Guide

작성 일시: `2026-04-25 KST`
공식 자료 재확인: `2026-04-25 KST` — Brand Guidelines, Graph View, CSS Colors, Canvas, Ribbon 기준을 재확인했다.

이 문서는 `legalize-kr` 지식그래프 챗봇 GUI에 바로 적용할 수 있는 디자인 스타일 가이드다. 목표는 Obsidian 앱의 생산성/지식작업 UI 언어를 참고하되, Obsidian 브랜드 자산을 복제하지 않고 Graphify Legal Graph Chat만의 제품 UI로 구현하는 것이다.

## 1. 디자인 목표

### 제품 목표
- 사용자가 법령 그래프를 “검색”이 아니라 “대화 + 근거 탐색 + 그래프 조망”으로 이해하게 한다.
- `9,001 nodes / 176,128 edges / 12 communities` 규모의 그래프를 안정적으로 탐색하게 한다.
- 답변과 근거를 항상 함께 보여줘 법률 자문으로 오해되지 않도록 한다.

### 시각 목표
- Obsidian처럼 어두운 작업공간, 분할 pane, ribbon, tab, graph/canvas 중심 상호작용을 사용한다.
- 법령 데이터에 맞게 전문적이고 차분하며, 불필요한 SaaS식 장식/그라디언트를 피한다.
- 전체 3D graph는 “시각 조망” 메뉴로, 실제 분석은 chat + evidence + 3D subgraph에서 수행한다.

## 2. 조사한 자료와 핵심 해석

공식 자료 재확인일: `2026-04-25 KST`

| 출처 | 재확인 결과 | 우리 제품에 적용 |
|---|---|---|
| Obsidian Brand Guidelines | 로고 편집/변경/왜곡/재색상/재구성 금지. 이름, 로고, 앱 아이콘은 trademark. 상업 사용은 문의 필요. | Obsidian 로고/이름/아이콘/lockup은 사용하지 않는다. “Obsidian-inspired” 구조와 UX 패턴만 참고한다. |
| Obsidian CSS Colors | dark base는 `#1e1e1e`, `#212121`, `#242424`, `#262626` 계열. purple dark는 `#a882ff`. RGB opacity variables 패턴을 사용한다. | `--lg-bg-*`, `--lg-accent`, `--lg-accent-rgb` 등 token 기반으로 opacity를 만든다. 하드코딩 rgba를 새 코드에 추가하지 않는다. |
| Obsidian Graph View | nodes/edges, hover highlight, click open, search/filter/groups, node size, link thickness, force controls, local graph depth가 핵심. | 2D/3D graph에 community color, degree size, confidence/weight edge, search/focus/filter/depth controls 적용. |
| Obsidian Canvas | infinite space, cards, connections, pan/zoom, group/color, local JSON Canvas 아이디어가 핵심. | evidence card, graph panel, community overview를 canvas-like workspace로 설계하되 데이터는 Graphify API DTO를 사용한다. |
| Obsidian Ribbon | left sidebar의 vertical command strip, icon action, tooltip/customization 패턴. | 좌측 48px ribbon에 Chat, Communities, 3D Subgraph, Full 3D, Report, Verify 메뉴를 둔다. |
| Obsidian styling docs | CSS variables를 써서 native-looking UI와 theme compatibility를 확보. | 모든 컴포넌트는 CSS custom properties 기반으로 작성한다. 색상, spacing, radius 하드코딩 금지. |

### 2.1 공식 자료 반영 한계

- 이 문서는 Obsidian 제품을 복제하지 않고, 지식 작업 UI 패턴을 Graphify Legal Graph Chat에 맞게 해석한다.
- Obsidian trademark, 로고, 앱 아이콘, 공식 브랜드 자산은 repo asset이나 UI에 포함하지 않는다.
- “Obsidian”은 내부 디자인 참고 출처를 설명할 때만 쓰고, 제품명/마케팅 문구/화면 headline처럼 사용하지 않는다.
- 공식 자료는 변동될 수 있으므로, 출시 또는 외부 배포 전 Brand Guidelines를 한 번 더 확인한다.

## 3. 디자인 원칙

### 3.1 Obsidian-inspired, not Obsidian-branded
- 사용 가능: pane layout, ribbon, tabbed workspace, graph/canvas UX, dark surface, purple accent.
- 사용 금지: Obsidian 로고, 앱 아이콘, “Obsidian”을 제품명처럼 사용하는 문구, 공식 자산 재색상.
- 문구: “Obsidian-style workspace”보다 “Graph workspace” 또는 “Vault-like workspace”를 우선한다.

### 3.2 Source-first 답변
- 챗봇 답변은 항상 evidence card와 함께 표시한다.
- 근거 없는 요약만 보여주는 assistant message는 금지한다.
- 모든 relation은 `source_file`, `relation`, `confidence`, `community`를 표시할 수 있어야 한다.

### 3.3 Pane-first 정보 구조
- 전체 앱은 `Ribbon + Left Sidebar + Main Workspace + Right Inspector + Statusbar` 구조를 기본으로 한다.
- 좌측은 탐색/필터, 중앙은 채팅/그래프 작업공간, 우측은 근거/상세/검증이다.

### 3.4 Progressive graph disclosure
1. 질문 결과 기반 3D subgraph: 기본 분석용.
2. Community Overview 3D: 전체 구조 조망용.
3. Full 3D Graph: 사용자가 명시적으로 여는 실험적 전체 렌더링.

### 3.5 Token-first implementation
- 색상은 `--lg-*` token을 우선 사용한다.
- 투명도는 `--lg-accent-rgb`, `--lg-red-rgb`처럼 RGB channel token과 `rgb(var(--token) / alpha)` 패턴을 사용한다.
- `rgba(168, 130, 255, ...)`, `#242424`, `8px` 같은 값은 prototype이 아닌 production UI에 직접 쓰지 않는다.
- 신규 컴포넌트는 최소한 background, text, border, focus, state color를 token으로 받는다.
- token rename은 하위 구현을 깨므로, 기존 token 변경보다 alias 추가를 우선한다.

### 3.6 Full 3D lazy-load principle
- 앱 초기 로드와 기본 Chat 화면에서는 `/graph/full-3d` 또는 전체 graph payload를 요청하지 않는다.
- 사용자가 `Full 3D Graph` 메뉴를 열고 성능 경고 modal을 확인한 뒤에만 slim payload를 요청한다.
- 기본 edge mode는 `hidden` 또는 `focus-neighborhood`다. `all` edge mode는 별도 opt-in이다.
- Full 3D는 실패 가능한 실험 view로 취급하고, WebGL 미지원/timeout/payload too large는 `.lg-state-fallback` 또는 2D/evidence fallback으로 전환한다.
- Full 3D 결과는 법률 답변의 기본 근거가 아니라 전체 구조 조망 보조 수단이다.

## 4. IA / App Shell

### 4.1 Desktop layout

```text
┌────────┬────────────────────┬──────────────────────────────┬────────────────────┐
│Ribbon  │ Left Sidebar        │ Main Workspace                │ Right Inspector    │
│48px    │ 288px               │ fluid                         │ 360px              │
│        │ Communities/Search  │ Chat / 3D Subgraph / Overview │ Evidence/Source    │
├────────┴────────────────────┴──────────────────────────────┴────────────────────┤
│ Statusbar: graph health · node/edge count · mode · selected node                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Workspace tabs

권장 탭:
- `Chat`
- `3D Subgraph`
- `Community Overview`
- `Full 3D Graph`
- `Report`
- `Wiki`
- `Verify`

### 4.3 Left ribbon commands

| Command | Icon 후보 | 기능 |
|---|---|---|
| Chat | message-circle | 질문 화면 |
| Communities | network | community list |
| 3D Subgraph | orbit | 질문 결과 3D |
| Overview | boxes / component | community 3D overview |
| Full 3D | globe-2 | 전체 3D graph |
| Report | file-text | GRAPH_REPORT |
| Verify | check-circle | VERIFY/health |
| Settings | sliders | 그래프 표시 설정 |

아이콘은 `lucide-react` 사용을 권장한다.

## 5. Visual system

### 5.1 Color tokens

실제 적용 CSS는 [obsidian-inspired-tokens.css](obsidian-inspired-tokens.css)를 사용한다.

핵심 토큰:

```css
--lg-bg-primary: #1e1e1e;
--lg-bg-primary-alt: #212121;
--lg-bg-secondary: #242424;
--lg-bg-secondary-alt: #262626;
--lg-border: #363636;
--lg-text-normal: #dadada;
--lg-text-muted: #999999;
--lg-accent: #a882ff;
--lg-accent-rgb: 168 130 255;
--lg-accent-strong: #7852ee;
--lg-accent-strong-rgb: 120 82 238;
```

### 5.2 Semantic colors

| 용도 | 색상 |
|---|---|
| Primary action / focus | `--lg-accent` |
| Selected node | `--lg-accent` + glow ring |
| EXTRACTED edge | `--lg-text-muted` 55~70% opacity |
| INFERRED edge | `--lg-accent` 45% opacity + dashed |
| AMBIGUOUS edge | `--lg-orange` 또는 `--lg-red` |
| Success health | `--lg-green` |
| Warning performance | `--lg-yellow` / `--lg-orange` |
| Error graph missing | `--lg-red` |

### 5.3 Community palette

현재 legalize-kr는 12 communities다. CSS는 `--lg-community-0` ~ `--lg-community-11`을 제공한다.

적용 규칙:
- community node fill = community color
- normal law node fill = community color 80% opacity
- selected node = community color + white/purple ring
- external reference hub = desaturated community color 또는 `--lg-text-muted`

### 5.4 Typography

| 요소 | 크기 | 굵기 | 비고 |
|---|---:|---:|---|
| App chrome / side nav | 12px | 500 | compact UI |
| Body / chat | 13px | 400 | 기본 |
| Evidence title | 13px | 600 | source 강조 |
| Workspace heading | 15px | 600 | pane title |
| Modal title | 18px | 650 | 경고/전체 3D |
| Code/path | 12px | 400 | mono |

권장 font stack:

```css
font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", "Apple SD Gothic Neo", Arial, sans-serif;
```

### 5.5 Spacing / density

- 기본 간격: 4px unit.
- sidebar item height: 28~32px.
- tab height: 30~36px.
- evidence card padding: 12px.
- inspector section gap: 16px.
- graph toolbar gap: 8px.

Obsidian과 유사하게 “넓은 SaaS dashboard”가 아니라 “작업 도구” 밀도를 유지한다.

### 5.6 Shape / border

- card radius: 8~12px.
- buttons/input radius: 6~8px.
- panel separation은 shadow보다 1px border를 우선한다.
- full-screen graph modal만 restrained shadow 사용.

## 6. Component specs

### 6.1 AppShell

```tsx
<AppShell className="lg-app-shell">
  <Ribbon className="lg-ribbon" />
  <Sidebar className="lg-sidebar" />
  <Workspace>
    <TabBar className="lg-tabbar" />
    <MainPane className="lg-main-workspace" />
  </Workspace>
  <Inspector className="lg-inspector" />
  <StatusBar className="lg-statusbar" />
</AppShell>
```

CSS는 `obsidian-inspired-tokens.css`의 `.lg-app-shell` 구조를 따른다.

### 6.2 Chat panel

#### 구조

```html
<section class="lg-chat-pane">
  <header class="lg-pane-header">Chat</header>
  <div class="lg-chat-scroll">
    <article class="lg-message lg-message-user">...</article>
    <article class="lg-message lg-message-assistant">...</article>
  </div>
  <form class="lg-chat-composer">...</form>
</section>
```

#### 규칙
- user message는 우측 정렬하지 말고 workspace density에 맞게 compact block으로 표시한다.
- assistant message는 summary + evidence chips + “Open 3D subgraph” action을 포함한다.
- 긴 답변보다 관련 node/edge를 더 강조한다.

### 6.3 Evidence card

#### 필수 필드
- Node label
- Relation
- Confidence
- Source file
- Community
- Degree 또는 reference count

#### 예시 구조

```html
<article class="lg-evidence-card" data-confidence="EXTRACTED">
  <div class="lg-evidence-card__title">개인정보 보호법 시행령</div>
  <div class="lg-evidence-card__meta">
    <span>references</span>
    <span>EXTRACTED</span>
    <span>Community 1</span>
  </div>
  <code>kr/개인정보보호법/시행령.md</code>
</article>
```

#### 상태
- `EXTRACTED`: border normal, confidence chip muted.
- `INFERRED`: accent border, dashed edge indicator.
- `AMBIGUOUS`: warning border and icon.
- CSS hook은 `data-confidence`를 사용한다. 예: `<article class="lg-evidence-card" data-confidence="EXTRACTED">`.
- confidence는 색상만으로 구분하지 않고 chip 텍스트와 tooltip/aria-label도 함께 제공한다.

### 6.4 Graph viewport

#### 공통 toolbar

```text
Search node | Depth | Edge mode | Labels | Physics | Fit view
```

#### 공통 interactions
- hover: neighbor highlight + inspector preview.
- click: select node + inspector detail.
- double click: expand node neighborhood.
- keyboard `/`: focus graph search.
- keyboard `Esc`: clear selection.

### 6.5 3D Subgraph panel

#### 목적
질문 답변과 직접 관련된 node/edge만 보여준다.

#### 데이터 제한
- 기본: 100 nodes / 500 edges.
- 최대: 300 nodes / 1,500 edges.
- 고차수 node는 top weighted neighbors만 포함한다.

#### visual mapping

| 데이터 | 시각 표현 |
|---|---|
| community | node color |
| degree | node size |
| confidence | edge opacity/dash |
| relation | edge label on hover |
| selected seed | larger node + accent halo |
| source exists | node solid |
| external reference | node outline/dim fill |

#### 빈 상태
질문 전에는 “질문을 입력하면 관련 법령 그래프가 여기에 표시됩니다.”를 보여준다.

### 6.6 Community Overview 3D

#### 목적
전체 그래프를 12개 community로 안전하게 조망한다.

#### node
- label: community label
- size: member count
- color: community palette
- tooltip: member count, top God Nodes, cohesion

#### edge
- width: cross-community edge count
- opacity: normalized count

#### click action
- 오른쪽 inspector에 community summary 표시.
- `Open wiki article`
- `Use as chat context`
- `View community subgraph`

### 6.7 Full 3D Graph

#### 목적
사용자가 명시적으로 전체를 “보고 싶을 때” 제공하는 실험적 메뉴.

#### 진입 modal
문구:

```text
전체 3D 그래프를 로드합니다.
9,001개 노드와 176,128개 엣지를 렌더링하므로 브라우저/GPU 환경에 따라 느릴 수 있습니다.
먼저 edge 숨김 모드로 시작하는 것을 권장합니다.
```

#### 기본값
- initial edge mode: `focus-neighborhood` 또는 `hidden` 권장.
- labels: off.
- physics cooldown: 제한.
- search/focus 필수.
- pause/resume 필수.
- full payload request는 modal 확인 이후에만 발생한다.
- 실패/저성능 상황은 `.lg-state-fallback` 또는 `.lg-graph-warning`으로 명시한다.

## 7. HTML/CSS implementation conventions

### 7.1 Class prefix
모든 신규 UI class는 `lg-` prefix를 사용한다.

```text
lg-app-shell
lg-ribbon
lg-tabbar
lg-sidebar
lg-main-workspace
lg-inspector
lg-graph-viewport
lg-evidence-card
```

### 7.2 State attributes
상태는 class보다 data attribute를 우선한다.

```html
<button class="lg-tab" data-active="true">Chat</button>
<article class="lg-evidence-card" data-confidence="EXTRACTED"></article>
<div class="lg-graph-viewport" data-edge-mode="focus"></div>
```

### 7.3 Theme tokens only
금지:

```css
.some-card { background: #242424; }
.some-glow { box-shadow: 0 0 0 2px rgba(168, 130, 255, 0.34); }
```

권장:

```css
.some-card { background: var(--lg-bg-secondary); }
.some-glow { box-shadow: 0 0 0 2px rgb(var(--lg-accent-rgb) / 0.34); }
```

### 7.4 State classes and data attributes
공통 상태 UI는 아래 class/data attribute를 우선한다.

```html
<section class="lg-state lg-state-loading">그래프를 불러오는 중...</section>
<section class="lg-state lg-state-empty">질문을 입력하세요.</section>
<section class="lg-state lg-state-error">그래프를 읽을 수 없습니다.</section>
<section class="lg-state lg-state-partial">일부 결과만 표시 중입니다.</section>
<section class="lg-state lg-state-fallback">3D 대신 근거 목록을 표시합니다.</section>
<div class="lg-graph-viewport" data-state="fallback" data-edge-mode="hidden"></div>
```

### 7.5 Responsive rules
- Desktop: 4-pane layout을 기본으로 한다.
- Tablet: inspector는 overlay/collapsible로 접고, sidebar 폭을 줄인다.
- Mobile: ribbon은 하단/상단 compact nav로 전환하고, chat/evidence를 graph보다 우선한다.

### 7.6 Focus-visible 필수
모든 interactive element는 `:focus-visible` 스타일을 가져야 한다.

## 8. Interaction and motion

### 8.1 Motion principle
- 그래프 이동/카메라 외의 장식 모션은 최소화한다.
- UI transition은 110~180ms.
- loading shimmer보다 명확한 spinner/progress text를 선호한다.
- `prefers-reduced-motion: reduce` 환경에서는 transition/animation을 사실상 비활성화한다.

### 8.2 Loading states
| 상황 | 표시 |
|---|---|
| graph health loading | statusbar skeleton text |
| query loading | assistant placeholder + cancel button |
| 3D subgraph loading | graph viewport overlay |
| full 3D loading | modal progress + edge mode hint |

### 8.3 Empty/error/partial/fallback states
- Chat empty: “질문을 입력하세요. 예: 개인정보 보호법과 전자정부법 관계”
- Evidence empty: “답변을 선택하면 근거가 표시됩니다.”
- 3D Subgraph empty: “질문 결과 그래프가 여기에 표시됩니다.”
- Community Overview empty: “그래프 상태를 먼저 확인하세요.”
- Error: 표준 `ApiError.code/message/recover_action`을 보여주고 재시도 버튼을 제공한다.
- Partial: payload limit/timeout으로 일부만 표시할 때 count와 이유를 보여준다.
- Fallback: WebGL 미지원 또는 3D 렌더 실패 시 evidence list/2D list로 전환한다.

## 9. Accessibility

- 모든 아이콘 버튼은 `aria-label` 필수.
- color-only encoding 금지. confidence는 텍스트 chip도 함께 표시.
- graph canvas 위 주요 동작은 toolbar 버튼으로도 접근 가능해야 한다.
- focus ring은 `--lg-shadow-focus` 사용.
- 텍스트 대비는 dark background 기준으로 `--lg-text-normal`/`--lg-text-muted`를 사용한다.

## 10. Legal/product copy guidelines

### 사용할 문구
- “그래프 근거”
- “관련 법령 연결”
- “명시 인용 관계”
- “source file”
- “검증 필요”

### 피할 문구
- “법률 자문”
- “정답”
- “판단해드립니다”
- “법적으로 확실합니다”

### disclaimer 예시

```text
이 UI는 법령 그래프 탐색 도구입니다. 답변은 graph.json의 노드/엣지와 source file을 기반으로 한 탐색 결과이며, 법률 자문이 아닙니다.
```

## 11. Do / Don't

### Do
- Pane, ribbon, tab, inspector를 일관되게 사용한다.
- 질문 결과에는 3D subgraph와 evidence를 연결한다.
- 전체 3D는 lazy-load하고 성능 경고를 제공한다.
- CSS 변수와 `lg-` class prefix를 사용한다.

### Don't
- Obsidian 로고/아이콘/브랜드 자산을 사용하지 않는다.
- 전체 `graph.json`을 기본 화면에서 직접 fetch하지 않는다.
- 모든 node label을 기본 표시하지 않는다.
- source 없는 챗봇 답변을 표시하지 않는다.
- 과한 gradient/glow로 전문성을 해치지 않는다.

## 12. Implementation checklist for next feature

새 기능을 추가할 때 이 체크리스트를 통과해야 한다.

- [ ] `obsidian-inspired-tokens.css` 변수를 사용했는가?
- [ ] RGB opacity는 `--lg-*-rgb` token을 사용했는가?
- [ ] `lg-` prefix class naming을 따랐는가?
- [ ] `data-confidence`와 텍스트 chip을 함께 사용했는가?
- [ ] keyboard focus-visible 상태가 있는가?
- [ ] responsive tablet/mobile 상태가 있는가?
- [ ] reduced motion 환경에서 불필요한 animation이 꺼지는가?
- [ ] loading/empty/error/partial/fallback state가 있는가?
- [ ] dark surface + border hierarchy가 일관적인가?
- [ ] source/evidence를 함께 표시하는가?
- [ ] graph payload를 필요한 만큼만 lazy-load하는가?
- [ ] Full 3D payload가 기본 화면에서 자동 요청되지 않는가?
- [ ] node color/size/edge style mapping이 가이드와 일치하는가?
- [ ] Obsidian 상표/로고/고유 자산을 사용하지 않았는가?

## 13. Source links

재확인 기준일: `2026-04-25 KST`

- Obsidian Brand Guidelines: https://obsidian.md/brand
- Obsidian Graph View Help: https://help.obsidian.md/plugins/graph
- Obsidian Canvas: https://obsidian.md/canvas
- Obsidian CSS styling: https://docs.obsidian.md/Reference/CSS%20variables/About%20styling
- Obsidian CSS colors: https://docs.obsidian.md/Reference/CSS%20variables/Foundations/Colors
- Obsidian Ribbon: https://obsidian.md/help/ribbon
