---
title: "Web Worker와 OffscreenCanvas로 이미지 업로드 최적화하기"
meta_title: ""
description: "원본 이미지를 그대로 올려 평균 10초씩 걸리던 업로드를, 이미지 처리를 메인 스레드 밖으로 분리해 1.4초로 줄이고 UI 멈춤까지 없앤 과정."
date: 2026-05-29T09:00:00Z
image: "/images/posts/web-worker-offscreencanvas.png"
categories: ["트러블슈팅"]
tags: ["Web Worker", "OffscreenCanvas", "성능 최적화"]
draft: false
---

이번 글에서는 실제 서비스 개발 중 마주한 이미지 업로드 성능 문제를 Web Worker와 OffscreenCanvas 조합으로 해결한 과정을 정리했다.

처음에는 단순히 업로드가 느리다는 문제로 보였다. 하지만 원인을 따라가 보니 파일 크기, 이미지 처리 비용, 메인 스레드 블로킹이 함께 얽혀 있었다. 이 글에서는 그 문제를 어떻게 정의했고, 어떤 선택지를 검토했으며, 왜 이 방식이 적절했다고 판단했는지를 순서대로 정리해봤다.

특히 다음 질문에 답하는 흐름으로 글을 구성했다.

- 왜 기존 방식이 느렸는가?
- 왜 Canvas API만으로는 충분하지 않았는가?
- 왜 Web Worker와 OffscreenCanvas를 함께 선택했는가?
- 이 선택이 사용자 경험에 어떤 차이를 만들었는가?

## 문제 상황

서비스에서 이미지 업로드 기능을 구현할 때 처음에는 원본 파일을 그대로 서버로 전송하고 있었다.

스마트폰 카메라로 촬영한 이미지는 보통 **3~8MB** 정도였고, 이를 별도 처리 없이 업로드하니 평균 **10초**, 느릴 때는 **30초**까지 걸렸다.

겉으로는 “업로드가 느리다”는 한 문장이었지만, 실제 문제는 세 가지가 겹쳐 있었다.

- **원본 이미지 자체가 너무 컸다.**
  리사이징이나 압축 없이 업로드하다 보니 전송해야 할 데이터 양이 과도했다.
- **모바일 환경에서 체감이 더 심했다.**
  모바일 네트워크 환경은 상대적으로 불안정했고, 카메라 원본 이미지는 데스크톱에서 다루는 이미지보다 훨씬 큰 경우가 많았다.
- **다중 이미지 업로드에서 대기 시간이 급격히 늘어났다.**
  이미지 한 장이 느린 것도 문제였지만, 여러 장을 올리면 그 지연이 그대로 누적됐다.

즉, 이 문제는 단순한 속도 문제가 아니라 **사용자가 기능을 쓰는 동안 기다려야 하는 시간 전체를 어떻게 줄일 것인가**의 문제였다.

## 가장 먼저 떠오른 방법: Canvas API로 리사이징하기

클라이언트 사이드에서 이미지를 줄이는 방법으로 가장 먼저 떠오른 건 Canvas API였다.

브라우저에서 이미지를 `drawImage()`로 캔버스에 그린 다음, `toBlob()`으로 다시 압축하면 서버에 전송하는 파일 크기를 줄일 수 있었다.

이 접근 자체는 틀리지 않았다. 실제로 전송 용량은 줄어들고, 업로드 시간도 단축됐다.

문제는 **어디에서 실행되느냐**였다.

Canvas API는 기본적으로 **메인 스레드**에서 동작했다.

이미지 디코딩, 리사이징, 다시 인코딩하는 작업은 생각보다 CPU 비용이 컸고, 이 작업이 메인 스레드를 점유하는 동안 브라우저는 사용자 입력과 화면 갱신에 제대로 반응하지 못했다.

단일 이미지라면 잠깐 버틸 수 있었을지도 모른다.

하지만 여러 장의 이미지를 순차적으로 처리하면 다음과 같은 일이 벌어졌다.

- 이미지 하나를 처리할 때마다 UI가 잠깐씩 멈췄다.
- 업로드 버튼, 스크롤, 입력 같은 상호작용이 버벅였다.
- 사용자는 “느리다”를 넘어 “멈췄다”고 느끼게 됐다.

즉, Canvas API만으로는 **파일 크기 문제**는 줄일 수 있어도, **UI 블로킹 문제**까지 함께 해결하기는 어려웠다.

![](https://velog.velcdn.com/images/ehgns0305/post/dadf5404-8062-4842-882f-0b6904648ac0/image.png)

(UI 블로킹 발생)

## Web Worker + OffscreenCanvas

최종적으로 선택한 방법은 **Web Worker + OffscreenCanvas** 조합이었다.

이 조합이 적절하다고 판단한 이유는 명확했다.

### 1. 무거운 작업을 메인 스레드에서 분리할 수 있었다

Web Worker는 메인 스레드와 별도로 동작하는 백그라운드 스레드다.

이미지 디코딩, 리사이징, 압축처럼 CPU를 많이 쓰는 작업을 Worker 쪽으로 넘기면, 메인 스레드는 UI 렌더링과 사용자 입력 처리에 집중할 수 있었다.

즉, 업로드 성능을 개선하면서도 **화면이 멈추지 않는 경험**을 만들 수 있었다.

### 2. 브라우저 네이티브 API만으로 해결할 수 있었다

OffscreenCanvas는 DOM과 분리된 캔버스다.

이 덕분에 Worker 내부에서도 캔버스를 생성하고 이미지를 그린 뒤 `convertToBlob()`으로 결과를 만들 수 있었다.

중요했던 점은 이것이 **별도 라이브러리 없이 가능한 방식**이었다는 점이었다.

`sharp`나 `browser-image-compression` 같은 라이브러리를 도입하지 않고도, 브라우저가 제공하는 기능만으로 충분히 목적을 달성할 수 있었다.

### 3. 디코딩까지 Worker 안에서 처리할 수 있었다

여기에 `createImageBitmap()`까지 함께 사용하면 이미지 디코딩도 Worker 스코프 내부에서 수행할 수 있었다.

즉, 전체 플로우를 다음처럼 구성할 수 있었다.

1. 메인 스레드는 `File` 객체를 Worker에 전달했다.
2. Worker는 `createImageBitmap()`으로 이미지 디코딩을 수행했다.
3. `OffscreenCanvas`에 리사이징된 이미지를 그렸다.
4. `convertToBlob()`으로 압축 결과를 생성했다.
5. 최종 `Blob`만 다시 메인 스레드로 전달했다.

이 구조에서는 메인 스레드가 무거운 연산에 직접 개입하지 않았다.

결과적으로 “파일 크기를 줄인다”와 “UI를 멈추지 않게 한다”를 동시에 달성할 수 있었다.

![](https://velog.velcdn.com/images/ehgns0305/post/054bcda5-7f30-41dc-997f-9a91e90fe791/image.png)
(Canvas API와 WebWorker + OffscreenCanvas 비교)

## Web Worker가 왜 중요한가

JavaScript는 기본적으로 **단일 스레드** 환경에서 동작한다. 브라우저는 스크립트 실행, 레이아웃 계산, DOM 업데이트, 사용자 입력 처리 등을 모두 메인 스레드에서 수행한다.

그래서 CPU 비용이 큰 작업이 메인 스레드를 오래 점유하면 다음 문제가 발생했다.

- 클릭이나 입력에 대한 반응이 늦어졌다.
- 스크롤이 끊겼다.
- 애니메이션이 버벅였다.
- 사용자는 앱이 느리거나 멈췄다고 인식하게 됐다.

이런 맥락에서 Web Worker는 단순한 “병렬 처리 도구” 이상이었다.

이는 **사용자 경험을 보호하기 위한 격리 장치**에 가까웠다.

특히 이 문제는 Core Web Vitals의 **INP(Interaction to Next Paint)** 와도 연결된다.

사용자가 어떤 상호작용을 했을 때 다음 화면 반응이 나타나기까지의 시간을 측정하는 지표인데, 메인 스레드에 긴 작업(Long Task)이 많을수록 INP는 나빠진다.

![](https://velog.velcdn.com/images/ehgns0305/post/8f582298-54a3-407a-944b-4a3d2057913d/image.png)

(수정 전 4MB 이미지 7개 다중 요청 시 Long task)

이미지 처리처럼 계산량이 큰 작업을 Worker로 넘긴다는 것은, 단순히 구현을 분리하는 것이 아니라 **인터랙션 품질을 지키는 방향으로 아키텍처를 바꾸는 것**이라고 볼 수 있었다.

## OffscreenCanvas가 필요한 이유

기존 `<canvas>` 요소는 DOM에 묶여 있기 때문에 메인 스레드에서 주로 다뤘다.

반면 **OffscreenCanvas**는 DOM과 분리된 캔버스였고, Worker 내부에서도 사용할 수 있었다.

이 점이 중요한 이유는 이미지 최적화 과정 자체가 캔버스 기반 작업을 필요로 했기 때문이다.

이미지 최적화 과정은 보통 다음 단계를 거쳤다.

1. 이미지 디코딩
2. 원하는 크기로 리사이징
3. 다시 압축된 포맷으로 인코딩

여기서 2번과 3번을 처리하려면 캔버스 기반 작업이 필요했다.

그런데 일반 Canvas API만 사용하면 결국 이 처리가 메인 스레드 쪽에 남게 됐다.

OffscreenCanvas를 사용하면 이 작업까지 Worker 안으로 옮길 수 있었다.

즉, “연산은 Worker에서 하지만 캔버스는 메인 스레드에서 다룬다” 같은 반쯤 분리된 구조가 아니라, **디코딩부터 압축 결과 생성까지 한 스레드 안에서 일관되게 처리**할 수 있었다.

이 점이 이번 구조의 핵심이었다.

## createImageBitmap

`createImageBitmap()`은 `Blob`, `File` 같은 소스로부터 디코딩된 비트맵을 비동기적으로 생성하는 API다.

이번 구현에서 특히 유용했던 이유는 두 가지였다.

- Worker 내부에서 직접 호출할 수 있어서 메인 스레드 부담이 없었다.
- 디코딩된 결과를 바로 캔버스에 그리기 좋았다.

즉, `<img>` 태그를 만들고 로드 이벤트를 기다리는 식의 흐름보다 훨씬 단순했고, Worker 환경에 자연스럽게 녹아들었다.

이미지 처리 최적화에서는 보통 “리사이징”에만 집중하기 쉬운데, 실제로는 **디코딩 비용**도 무시할 수 없었다.

그래서 `createImageBitmap()`을 함께 사용한 것이 꽤 큰 의미가 있었다.

## 구현 방식

실제 구현은 크게 두 부분으로 나뉘었다.

- Worker에서 실제 이미지 처리를 수행했다.
- 메인 스레드에서 Worker와 통신하고 결과를 업로드 플로우에 연결했다.

### 1. Worker에서 이미지 처리하기

Worker는 `file`, `maxWidth`, `quality`, `format` 값을 전달받아 다음 순서로 작업했다.

1. `createImageBitmap(file)`로 이미지 디코딩을 수행했다.
2. `maxWidth`를 초과하면 비율을 유지한 채 리사이징했다.
3. `OffscreenCanvas`에 이미지를 그렸다.
4. `convertToBlob()`으로 압축된 결과를 생성했다.
5. 결과 `Blob`을 메인 스레드로 전달했다.

```tsx
/// <reference lib="webworker" />

self.onmessage = async (event: MessageEvent) => {
  const {
    file,
    maxWidth = 1920,
    quality = 0.8,
    format = "image/jpeg",
  } = event.data;

  try {
    const bitmap = await createImageBitmap(file);
    let { width, height } = bitmap;

    if (width > maxWidth) {
      height = Math.round((height * maxWidth) / width);
      width = maxWidth;
    }

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");

    if (!ctx) {
      throw new Error("Canvas 2D context not available");
    }

    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob = await canvas.convertToBlob({
      type: format,
      quality,
    });

    bitmap.close();

    self.postMessage({ success: true, blob, width, height });
  } catch (error) {
    self.postMessage({
      success: false,
      error: (error as Error).message,
    });
  }
};
```

여기서 핵심은 **무거운 처리가 모두 Worker 안에서 끝난다**는 점이었다.

메인 스레드는 최적화된 결과만 전달받았다.

또 하나 중요했던 부분은 `bitmap.close()`였다.

`ImageBitmap`은 사용 후 명시적으로 정리해주는 편이 안전했다. 이미지 여러 장을 다룰 때는 이런 작은 정리 하나가 메모리 사용량에 꽤 큰 차이를 만들 수 있었다.

### 2. 메인 스레드에서 Worker와 통신하기

메인 스레드에서는 `processImage()` 함수가 Worker 생성, 메시지 전달, 결과 수신을 담당했다.

```tsx
const processImage = useCallback(
  async (file: File): Promise<File> => {
    if (!window.Worker) return file;

    return new Promise((resolve) => {
      const worker = new Worker(
        new URL("../workers/image-processor.worker.ts", import.meta.url),
        { type: "module" },
      );

      worker.onmessage = (event) => {
        const { success, blob } = event.data;
        worker.terminate();

        if (success && blob) {
          resolve(new File([blob], file.name, { type: blob.type }));
        } else {
          resolve(file);
        }
      };

      worker.onerror = () => {
        worker.terminate();
        resolve(file);
      };

      worker.postMessage({ file, maxWidth, quality });
    });
  },
  [maxWidth, quality],
);
```

설계적으로는 몇 가지 포인트가 있었다.

### Worker를 이미지마다 생성하고 종료

처음에는 Worker Pool 같은 구조도 생각할 수 있었다.

하지만 이 경우에는 이미지 한 장을 처리한 뒤 바로 종료하는 단순한 구조가 더 적절했다.

- 구현이 단순했다.
- 생명주기를 추적하기 쉬웠다.
- 메모리 누수 가능성을 줄이기 좋았다.

처리량이 아주 큰 상황이 아니라면, 이런 단순한 구조가 유지보수 측면에서 오히려 이점이 컸다.

### 실패해도 업로드는 진행

이미지 최적화는 성능 개선을 위한 보조 단계이지, 업로드 성공 자체를 막아서는 안 됐다.

그래서 Worker 처리에 실패하더라도 `reject`로 흐름을 끊지 않고, **원본 파일을 그대로 반환하는 graceful fallback** 구조를 선택했다.

이 판단 덕분에 브라우저 환경이나 예외 상황에 따라 최적화가 실패하더라도, 사용자는 적어도 업로드 기능 자체는 계속 사용할 수 있었다.

## 전체 업로드 플로우

최종 업로드 흐름은 다음처럼 정리됐다.

1. 사용자가 파일을 선택
2. 파일 수, 타입, 용량 검증
3. `processImage(file)`를 호출해 Worker에서 최적화
4. 최적화된 `File`을 업로드
5. 상태를 업데이트해 UI에 반영

이 구조 덕분에 이미지 최적화 로직은 공통으로 유지하면서도, 서비스 요구사항에 맞게 업로드 타이밍을 유연하게 제어할 수 있었다.

## 결과: 업로드 시간이 단축되고, 체감 역시 좋아졌다.

적용 전후를 직접 측정한 결과는 다음과 같았다.

- **평균 업로드 시간:** 10초 → 1.4초
- **최대 업로드 시간:** 30초 → 2.8초

수치로 보면 평균 약 **86%**, 최대 약 **91%** 개선이었다.

하지만 실제로 더 크게 느껴졌던 변화는 따로 있었다.

바로 **업로드 중에도 UI가 멈추지 않는다**는 점이었다.

사용자 입장에서 성능은 단순히 “작업이 얼마나 빨리 끝났는가”만으로 판단되지 않는다. 버튼이 눌리는지, 화면이 움직이는지, 뭔가 진행되고 있다는 느낌이 드는지도 매우 중요했다. 이번 개선은 전송 시간을 줄인 것뿐 아니라, 업로드 과정 전체를 덜 답답하게 만들었다. 특히 모바일에서 여러 장의 사진을 한 번에 선택했을 때 체감 차이가 크게 났다.

## 이번 작업에서 배운 점

이번 작업을 하면서 다시 확인한 건, 성능 문제를 해결할 때 가장 중요한 것은 **무조건 빠른 도구를 찾는 것**이 아니라는 점이었다.

먼저 해야 할 일은 보통 다음과 같았다.

- 어디에서 시간이 오래 걸리는지 확인하기
- 그 병목이 네트워크인지, CPU인지, 렌더링인지 구분하기
- 단순한 속도 개선이 아니라 사용자 경험까지 함께 볼 수 있는지 판단하기

이번 사례에서는 병목이 단순히 “업로드 요청”에만 있는 것이 아니었다.

**큰 이미지 파일 자체**, **클라이언트 리사이징 비용**, **메인 스레드 블로킹**이 모두 얽혀 있었다.

그래서 해결책도 단순 압축이 아니라, **이미지 처리 파이프라인을 메인 스레드 밖으로 분리하는 방향**이어야 했다.

## 마치며

Web Worker와 OffscreenCanvas는 이미지 업로드 최적화에만 쓰이는 기술은 아니다.

3D 렌더링, 실시간 데이터 처리, 머신러닝 추론처럼 메인 스레드를 오래 점유하기 쉬운 작업 전반에 적용할 수 있다.

하지만 이번 경험을 통해 특히 인상 깊었던 건, 이 기술들이 거창한 대규모 시스템에서만 의미 있는 것이 아니라는 점이었다.

사용자가 이미지를 올리는 아주 일상적인 기능에서도, 스레드 분리와 브라우저 네이티브 API 조합만으로 체감 성능을 크게 개선할 수 있었다.

이번 작업은 단순히 “업로드를 빠르게 만들었다”는 것보다, **사용자가 기다리는 시간을 어떻게 줄이고, 그 기다림의 질을 어떻게 바꿀 것인가**를 고민한 과정에 더 가까웠다.

비슷한 병목을 겪고 있다면, 이미지 파일 크기만 볼 것이 아니라 **그 처리가 어디서 실행되고 있는지**도 함께 살펴보면 좋겠다.

생각보다 큰 차이는 그 지점에서 만들어질 수 있었다.

## 참고 자료

- MDN — [Using Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers)
- web.dev — [Web worker overview](https://web.dev/learn/performance/web-worker-overview?hl=ko)
- MDN — [OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas)
- web.dev — [OffscreenCanvas: speed up your canvas operations with a web worker](https://web.dev/articles/offscreen-canvas)
- web.dev — [Interaction to Next Paint (INP)](https://web.dev/articles/inp)
- Evil Martians — [Faster WebGL/Three.js with OffscreenCanvas](https://evilmartians.com/chronicles/faster-webgl-three-js-3d-graphics-with-offscreencanvas-and-web-workers)
- Chrome for Developers — [Transferable objects are lightning fast](https://developer.chrome.com/blog/transferable-objects-lightning-fast)
