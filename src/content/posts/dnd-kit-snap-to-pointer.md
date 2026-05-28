---
title: "dnd-kit에 SnapToPointer modifier를 기여하기까지"
meta_title: ""
description: "직접 drag-and-drop을 구현하며 겪은 어려움에서 출발해, dnd-kit 내부 구조를 파고들고 SnapToPointer modifier를 기여하기까지의 과정과 그 안에서 배운 것들."
date: 2026-05-28T09:00:00Z
image: "/images/posts/dnd-kit-snap-to-pointer.jpg"
categories: ["오픈소스"]
tags: ["dnd-kit", "오픈소스", "drag and drop"]
draft: false
---

오픈소스 기여. 개발자라면 한 번쯤 해보고 싶은 일이지만, 막상 시작하려면 어디서부터 해야 할지 막막하다. 나 역시 그랬다. 이 글은 내가 어떻게 dnd-kit에 SnapToPointer modifier를 기여하게 됐는지, 그 과정에서 무엇을 배웠는지를 기록해보려고 한다.

### Drag and Drop 기능 구현

BCSD Lab이라는 대학 IT 동아리에서 내부 관리 서비스를 개발하던 중, 동아리 회의 가능 시간을 선택하는 기능을 맡게 됐다. Google Calendar에서 드래그로 일정을 만드는 것처럼, 마우스를 누른 채 셀 위를 지나가면 해당 시간대가 채워지는 기능이다. When2Meet의 메인 기능과 동일하다.

```tsx
const [dragStart, setDragStart] = useState<TimeSlotSelection | null>(null);
const [dragEnd, setDragEnd] = useState<TimeSlotSelection | null>(null);
const [dragging, setDragging] = useState(false);

const handleMouseDown = ({ timeFrom, timeTo, day }: TimeSlotSelection) => {
  setDragging(true);
  setDragStart({ timeFrom, timeTo, day });
};

const handleMouseUp = () => {
  const [startHourFrom, startMinuteFrom] = dragStart.timeFrom.split(':').map(Number);
  const [endHourTo, endMinuteTo] = dragEnd.timeTo.split(':').map(Number);

  // 위에서 아래로 드래그 vs 아래에서 위로 드래그를 직접 판별
  if (startHourFrom < endHourTo || ((startHourFrom === endHourTo) && (startMinuteFrom <= endMinuteTo))) {
    setSelectionRange((prev) => [...prev, { start: { time: dragStart.timeFrom, day: dragStart.day }, end: { time: dragEnd.timeTo, day: dragEnd.day } }]);
  } else if (...) { ... }
};
```

이걸 제대로 하려면 '어떻게 설계해야 하는 걸까'라는 의문이 생긴 건 자연스러운 수순이었다.

생각보다 훨씬 복잡했다. 드래그 방향(위→아래 vs 아래→위)을 직접 시간 비교로 판별하고, 각 셀에 이벤트 핸들러를 개별로 붙이는 방식이다. 기능은 동작했지만 엣지케이스가 꽤 남아 있었고, 버그도 남아 있었다. 그 과정에서 자연스럽게 드래그 인터랙션을 제대로 처리하는 라이브러리들이 궁금해졌고, 그렇게 dnd-kit을 처음 알게 됐다.

### dnd-kit 소스를 파보다

dnd-kit은 단순한 drag-and-drop 유틸리티가 아니다. 코드를 열어보면 패키지부터 역할이 명확하게 나뉘어 있다.

- `@dnd-kit/abstract` — 핵심 추상화. Modifier, Sensor, DragDropManager 등 모든 개념의 인터페이스가 여기 정의된다
- `@dnd-kit/dom` — DOM 환경에 맞는 구체적 구현. PointerSensor, SnapToPointer 같은 실제 동작이 여기에 있다
- `@dnd-kit/react` — React 바인딩

중심에는 DragDropManager가 있다. Draggable/Droppable의 등록, 드래그 상태(DragOperation), 이벤트 발행, 충돌 감지까지 전부 이 매니저를 통해 흐른다.

Sensor는 사용자 입력을 감지하는 역할이다. PointerSensor가 `pointerdown` 이벤트를 잡으면 `manager.actions.setDragSource(id)`를 호출해 드래그를 시작시킨다. 이후 포인터 이동마다 `manager.actions.move(coordinates)`로 위치를 업데이트한다.

핵심은 transform이 계산되는 방식이었다. DragOperation에는 이러한 getter가 있다.

```tsx
get transform() {
  const { x, y } = this.position.delta;
  let transform = { x, y };
  for (const modifier of this.modifiers) {
    transform = modifier.apply({ ...this.snapshot(), transform });
  }
  return transform;
}
```

포인터 이동량(`position.delta`)을 기반으로 transform을 만들고, 등록된 Modifier들이 순서대로 이 값을 변환한다. Modifier는 이 파이프라인에 끼어드는 레이어다.

각 Modifier의 `apply()` 메서드는 DragOperationSnapshot을 받는다. 여기에는 드래그 중인 요소의 초기/현재 bounding rectangle(shape), 드래그를 시작한 이벤트(activatorEvent), 현재 transform이 모두 담겨 있다. 이 정보를 조합하면 다양한 동작을 구현할 수 있다.

직접 구현할 때 어려웠던 이유가 보였다. 드래그 방향 판별, 시작 지점 추적, 이벤트 타이밍 처리 같은 것들을 전부 수동으로 관리했는데, dnd-kit은 이것들을 DragOperation 하나에 모아두고 추상화한 것이었다.

### 오픈소스 기여 - SnapToCenterCursor

오픈소스 기여를 해보고 싶다는 생각이 들었을 때, 자연스럽게 dnd-kit이 떠올랐다. 내부 구조를 어느 정도 파악하고 있었으니까. 이슈 트래커를 열어보니 [#1863](https://github.com/clauderic/dnd-kit/issues/1863)가 눈에 들어왔다.

"드래그 시 아이템이 커서 중앙에 스냅됐으면 좋겠다"는 요청이었다. 기본적으로 dnd-kit는 클릭한 위치의 offset을 그대로 유지한다. 요소를 잡으면 해당 요소의 커서를 그대로 따라가는 식이다. 하지만 어디를 클릭하든 항상 요소의 중앙이 커서에 맞춰지는 동작이 필요한 경우가 있다. 드래그 오버레이를 쓸 때나, 카드처럼 크기 있는 요소를 자연스럽게 끌고 싶을 때가 대표적이다.

### SnapToPointer 구현 — 핵심 로직

처음 구현한 이름은 SnapCenterToCursor였다. 요소의 중앙이 커서에 붙도록 transform 값을 보정하는 modifier다. 핵심 로직은 세 단계다.

- 드래그 시작 시점의 커서 위치를 `activatorEvent.clientX / clientY`로 읽는다
- 요소의 boundingRectangle에서 앵커 좌표(anchorX, anchorY)를 계산한다
- 현재 transform에 (커서 위치 - 앵커 좌표)의 차이를 더해 반환한다

수식으로 쓰면 이렇다.

```tsx
const x = transform.x + activatorEvent.clientX - anchorX;
const y = transform.y + activatorEvent.clientY - anchorY;
```

직접 drag-drop을 구현할 때 씨름했던 바로 그 좌표 계산 영역이었다. 그때는 엣지케이스에 치여 버그를 잡지 못했는데, 이번엔 그 로직을 정돈된 형태로 볼 수 있었다.

### 메인테이너의 리뷰

PR을 올렸더니 리뷰어가 중요한 피드백을 남겼다. 중앙만 지원하면 너무 제한적이지 않냐, 다른 앵커 포인트도 지원하면 더 유용할 것 같다고.

![메인테이너의 첫 번째 리뷰](https://velog.velcdn.com/images/ehgns0305/post/eb256b1c-0994-450c-85fd-53c9cf379914/image.png)

맞는 말이었다. 예를 들어 카드의 우측 상단에 커서를 두고 드래그하고 싶을 수도 있다.

그래서 anchor 옵션을 추가하기로 했다.

```tsx
type Anchor =
  | "center"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export class SnapToPointer extends Modifier<DragDropManager, Options> {
  apply({ activatorEvent, shape, transform }: DragOperation) {
    if (!shape || !(activatorEvent instanceof PointerEvent)) {
      return transform;
    }
    const anchor = this.options?.anchor ?? "center";
    const { boundingRectangle, center } = shape.initial;

    let anchorX: number;
    let anchorY: number;

    // anchor 처리
    switch (anchor) {
      case "top-left":
        anchorX = boundingRectangle.left;
        anchorY = boundingRectangle.top;
        break;
      case "top-right":
        anchorX = boundingRectangle.right;
        anchorY = boundingRectangle.top;
        break;
      case "bottom-left":
        anchorX = boundingRectangle.left;
        anchorY = boundingRectangle.bottom;
        break;
      case "bottom-right":
        anchorX = boundingRectangle.right;
        anchorY = boundingRectangle.bottom;
        break;
      default:
        anchorX = center.x;
        anchorY = center.y;
    }

    // 이하 생략
  }
}
```

enum 방식을 적용해서 직관적이고 자동완성도 되기 때문에 나쁘지 않게 구현했다고 생각했다.

그런데 두 번째 리뷰에서 또 피드백이 왔다.

![메인테이너의 두 번째 리뷰](https://velog.velcdn.com/images/ehgns0305/post/d02957c4-5223-4ad5-a3ef-5f32291ff787/image.png)

정리하면 percentage 방식으로 모델링하는 게 훨씬 좋다는 이야기다. 그렇게 되면 Anchor에서 정의한 내용뿐만 아니라 사용자가 원하는 위치에 snap을 적용할 수 있다. 훨씬 더 좋은 방식이라는 것에 동의하게 되었다.

```ts
export class SnapToPointer extends Modifier<DragDropManager, Options> {
  apply({ activatorEvent, shape, transform }: DragOperation) {
    if (!shape || !(activatorEvent instanceof PointerEvent)) {
      return transform;
    }

    const anchor = this.options?.anchor ?? DEFAULT_ANCHOR;
    const { boundingRectangle } = shape.initial;

    const anchorX = boundingRectangle.left + boundingRectangle.width * anchor.x;
    const anchorY = boundingRectangle.top + boundingRectangle.height * anchor.y;

    return {
      x: transform.x + activatorEvent.clientX - anchorX,
      y: transform.y + activatorEvent.clientY - anchorY,
    };
  }

  static configure = configurator(SnapToPointer);
}
```

드래그한 물체(boundingRectangle)의 width와 height에 anchor 값을 곱해 위치를 고정시켰다. 덕분에 코드 라인도 줄었고, 범용성 넓은 기능을 완성할 수 있었다.

### 코드 이외의 주변 작업

구현 코드 자체는 30줄 남짓이었지만, 머지까지 가는 데 주변 작업이 생각보다 많았다.

- DTS 빌드 에러 수정 — 명시적 반환 타입 추가
- import 경로 수정
- changeset 파일 추가 — 라이브러리의 버전 관리 체계를 파악해야 했다
- 문서 업데이트 — modifiers 레퍼런스에 SnapToPointer 내용 추가

오픈소스 기여는 코드만이 아니다. 라이브러리의 규칙을 파악하고, 빌드 시스템을 이해하고, 문서를 맞추는 것까지 전부 포함된다.

### 마무리

PR [\[experimental\] Add SnapToPointer modifier #2028](https://github.com/clauderic/dnd-kit/pull/2028)이 머지됐다. 이번 기여에서 가장 인상적이었던 건 코드보다 설계 논의에 시간이 더 걸렸다는 점이다. 구현 자체는 하루 만에 끝났지만, "어떤 API가 더 나은가"를 리뷰어와 주고받는 데 훨씬 많은 에너지가 들었다. 혼자였다면 첫 번째 설계로 마무리했을 텐데, 리뷰 덕분에 더 유연한 방향으로 나아갈 수 있었다. 오픈소스 기여는 코드를 제출하는 게 아니라 함께 설계를 다듬는 과정이었다.

또 하나는, 직접 부딪혀본 경험이 이해의 깊이를 만든다는 것이다. BCSD에서 드래그를 직접 구현하며 겪은 어려움이 있었기에, dnd-kit이 왜 그 구조로 설계됐는지 더 빠르게 체감할 수 있었다. 라이브러리를 쓰기만 했다면 소스를 읽어도 와닿지 않았을 것이다. 잘 만들어진 추상화의 가치는, 직접 날것의 구현을 해본 사람일수록 더 깊이 느껴진다는 것을 알게 됐다.
