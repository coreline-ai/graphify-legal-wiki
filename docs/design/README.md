# Design docs

Graphify Legal Graph Chat UI 디자인 문서 모음.

## 문서

- [Obsidian-inspired Graph Chat Design Guide](obsidian-inspired-graph-chat-guide.md)
- [Obsidian-inspired CSS tokens](obsidian-inspired-tokens.css)

## 공식 자료 재확인

재확인일: `2026-04-25 KST`

- Obsidian Brand Guidelines: 로고 편집/변경/왜곡/재색상/재구성 금지, 이름/로고/앱 아이콘은 trademark, 상업 사용은 문의 필요.
- Obsidian Graph View: nodes/edges, hover highlight, click open, search/filter/groups, node size, link thickness, force controls, local graph depth 패턴 확인.
- Obsidian CSS Colors: dark base `#1e1e1e`/`#212121`/`#242424`/`#262626`, purple dark `#a882ff`, RGB opacity variables 패턴 확인.
- Obsidian Canvas: infinite space, cards, connections, pan/zoom, group/color, local JSON Canvas 아이디어 확인.

## 적용 원칙

- Obsidian의 정보 구조, workspace/pane/ribbon 패턴, dark neutral surface, purple accent, graph controls를 참고한다.
- Obsidian 로고, 앱 아이콘, 상표, 고유 브랜드 자산은 사용하지 않는다.
- 구현 시 `obsidian-inspired-tokens.css`의 CSS custom properties를 먼저 적용하고, 컴포넌트는 디자인 가이드의 class naming과 layout spec을 따른다.
- 색상/opacity는 `--lg-accent`, `--lg-accent-rgb`, `--lg-*` semantic token을 사용한다. 하드코딩 `rgba(168, 130, 255, ...)` 같은 값은 새 코드에 추가하지 않는다.
- confidence는 `data-confidence="EXTRACTED|INFERRED|AMBIGUOUS"`와 텍스트 chip을 함께 사용해 color-only encoding을 피한다.
- Full 3D Graph는 기본 화면에서 자동 요청하지 않는다. 사용자가 별도 메뉴에 진입하고 성능 경고를 확인한 뒤 slim payload를 lazy-load한다.
