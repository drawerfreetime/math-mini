/**
 * 미니 수학 게임 — 즉석 연산 문제 생성 (문제 은행 없음)
 */

const OPS = ['+', '-', '×'];

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** @returns {{ text: string, answer: number }} */
export function generateMathProblem() {
  const op = OPS[randInt(0, OPS.length - 1)];
  let a;
  let b;
  let answer;

  if (op === '+') {
    a = randInt(1, 50);
    b = randInt(1, 50);
    answer = a + b;
  } else if (op === '-') {
    a = randInt(10, 99);
    b = randInt(1, a);
    answer = a - b;
  } else {
    a = randInt(2, 12);
    b = randInt(2, 12);
    answer = a * b;
  }

  return {
    text: `${a} ${op} ${b}`,
    answer,
  };
}

/** 정답 + 오답 보기 4개 */
export function generateChoices(correctAnswer, count = 4) {
  const wrongs = new Set();
  while (wrongs.size < count - 1) {
    const delta = randInt(-12, 12) || randInt(3, 9);
    const candidate = correctAnswer + delta;
    if (candidate > 0 && candidate !== correctAnswer) wrongs.add(candidate);
  }
  return shuffle([correctAnswer, ...wrongs]);
}

/** 두더지용 정답 + 오답 2개 */
export function generateHoleOptions(correctAnswer) {
  const wrongs = new Set();
  while (wrongs.size < 2) {
    const delta = randInt(-15, 15) || randInt(4, 10);
    const candidate = correctAnswer + delta;
    if (candidate > 0 && candidate !== correctAnswer) wrongs.add(candidate);
  }
  return shuffle([correctAnswer, ...wrongs]);
}

export function pickRandomIndices(total, pick) {
  return shuffle(Array.from({ length: total }, (_, i) => i)).slice(0, pick);
}

export { shuffle };
