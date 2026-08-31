// 짧게 떴다 사라지는 알림. 지금은 "복사됨" 하나뿐이지만 다른 곳에서도
// 쓸 수 있게 문자열만 받는다.
//
// 동시에 여러 개를 쌓지 않는다 — 터미널 위에 겹쳐 뜨는 물건이라
// 새 메시지가 오면 이전 것을 갈아치우고 타이머만 다시 건다.
// 같은 문자열이 연속으로 올 때 애니메이션이 다시 돌도록 seq를 올린다.

const DURATION_MS = 1400;

const _state = $state<{ message: string | null; seq: number }>({
  message: null,
  seq: 0,
});

let timer: number | undefined;

export const toast = {
  get message(): string | null { return _state.message; },
  get seq(): number { return _state.seq; },
};

export function showToast(message: string): void {
  _state.message = message;
  _state.seq += 1;
  if (timer !== undefined) clearTimeout(timer);
  timer = window.setTimeout(() => {
    _state.message = null;
    timer = undefined;
  }, DURATION_MS);
}
