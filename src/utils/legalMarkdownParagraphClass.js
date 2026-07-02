import { isValidElement } from 'react';

/** react-markdown 문단 children → 검색용 평문 */
export function remarkChildrenToPlainText(children) {
  if (children == null || children === false) return '';
  if (typeof children === 'string' || typeof children === 'number') {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map(remarkChildrenToPlainText).join('');
  }
  if (isValidElement(children)) {
    return remarkChildrenToPlainText(children.props.children);
  }
  return '';
}

/**
 * 가./1)/(1) 등 세부 항목은 legal-doc__md-detail (줄간격 1.6 묶음),
 * 조문 내 1. 2. 단계는 legal-doc__md-num (줄간격 1.8·굵기),
 * 그 외 본문은 legal-doc__md-body.
 *
 * 단일 문단 텍스트만으로는 중첩 단계를 구분할 수 없어,
 * 모든 `n.` 패턴을 일단 md-num으로 분류한다.
 * 정확한 최상위/중첩 판정은 buildLegalMarkdownClassMap 참고.
 */
export function legalMarkdownParagraphClass(plain) {
  const t = plain.trim();
  if (!t) return 'legal-doc__md-body';
  if (t.startsWith('※')) return 'legal-doc__md-note';
  if (/^[가-힣]\.\s/.test(t)) return 'legal-doc__md-detail';
  if (/^\d+\)\s/.test(t)) return 'legal-doc__md-detail';
  if (/^[가-힣]\)\s/.test(t)) return 'legal-doc__md-detail';
  if (/^\(\d+\)\s/.test(t)) return 'legal-doc__md-detail';
  if (/^\d+\.\s/.test(t)) return 'legal-doc__md-num';
  return 'legal-doc__md-body';
}

/**
 * 마크다운 전체를 한 번 훑어 각 문단의 시작 라인 번호 → CSS 클래스 맵을 만든다.
 *
 * 핵심 규칙:
 *  - `## 제n조` 헤딩을 만나면 최상위 카운터를 1로 리셋한다.
 *  - `n.` 형태 문단은 n이 카운터와 일치할 때만 최상위(`legal-doc__md-num`)로
 *    분류하고 카운터를 +1 한다. 일치하지 않으면 중첩으로 간주해
 *    `legal-doc__md-detail`을 부여한다.
 *  - `가./나./1)/가)/(1)` 등은 항상 `legal-doc__md-detail`.
 *  - 그 외는 `legal-doc__md-body`. `※` 시작은 `legal-doc__md-note`.
 *
 * react-markdown의 paragraph node가 가지는 `node.position.start.line`으로
 * 이 맵을 조회해 클래스를 적용한다.
 */
export function buildLegalMarkdownClassMap(markdown) {
  const map = new Map();
  if (!markdown) return map;

  const lines = markdown.split('\n');
  let topCounter = 1;
  let paragraphStart = null;
  let paragraphLines = [];

  const classify = (text) => {
    const t = text.trim();
    if (!t) return null;
    if (t.startsWith('※')) return 'legal-doc__md-note';
    if (/^[가-힣]\.\s/.test(t)) return 'legal-doc__md-detail';
    if (/^\d+\)\s/.test(t)) return 'legal-doc__md-detail';
    if (/^[가-힣]\)\s/.test(t)) return 'legal-doc__md-detail';
    if (/^\(\d+\)\s/.test(t)) return 'legal-doc__md-detail';
    const numMatch = t.match(/^(\d+)\.\s/);
    if (numMatch) {
      const n = parseInt(numMatch[1], 10);
      if (n === topCounter) {
        topCounter += 1;
        return 'legal-doc__md-num';
      }
      return 'legal-doc__md-detail';
    }
    return 'legal-doc__md-body';
  };

  const flush = () => {
    if (paragraphStart != null && paragraphLines.length) {
      const text = paragraphLines.join('\n');
      const cls = classify(text);
      if (cls) map.set(paragraphStart, cls);
    }
    paragraphStart = null;
    paragraphLines = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^#{1,6}\s/.test(trimmed)) {
      flush();
      if (/^##\s+제\d+조/.test(trimmed)) {
        topCounter = 1;
      }
      continue;
    }

    if (!trimmed) {
      flush();
      continue;
    }

    if (paragraphStart == null) {
      paragraphStart = i + 1;
    }
    paragraphLines.push(line);
  }
  flush();

  return map;
}
