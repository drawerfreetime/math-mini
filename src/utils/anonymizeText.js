/**
 * anonymizeText.js — 문제 텍스트 내 학생 실명 익명화
 *
 * 방식: 한국어 조사(이가, 가, 는, 를 등) 앞에 오는 2~4글자 한글을 이름 후보로 탐지
 * 원칙: 동일 이름 → 동일한 '학생N' 으로 일관 변환 (문맥 유지)
 *
 * [저장] nameMap → Firebase에 nameMapToObject()로 변환해 저장
 * [복원] 교사 대시보드에서 restoreNames()로 원래 이름 표시
 *
 * 오탐(예: '크기를' → '학생1를')이 검수 정확도에 영향을 주므로 기본 비활성.
 */

/** false면 원문 그대로 API 전송 (이름 치환 없음) */
export const ANONYMIZE_STUDENT_NAMES_ENABLED = false;

/** 이름이 아닌 일반 한국어 단어 제외 목록 */
const EXCLUDE_WORDS = new Set([
  // 사람 관련
  '사람', '학생', '선생', '교사', '어린이', '아이들', '친구들', '가족', '부모',
  '어머니', '아버지', '언니', '오빠', '형이', '동생', '누나',
  // 장소/기관
  '나라', '학교', '교실', '도서관', '마트', '시장', '병원', '공원', '놀이터',
  // 과목
  '수학', '국어', '과학', '사회', '영어', '체육', '음악', '미술', '도덕',
  // 과일/음식
  '사과', '바나나', '오렌지', '딸기', '포도', '수박', '참외', '복숭아',
  '배추', '당근', '오이', '토마토', '감자', '고구마',
  '사탕', '초콜릿', '과자', '빵', '우유', '주스', '물',
  // 학용품
  '연필', '공책', '지우개', '가방', '책상', '의자', '칠판', '교과서', '색연필', '자',
  // 동물
  '강아지', '고양이', '토끼', '물고기', '새들', '곰이', '코끼리', '사자', '호랑이',
  // 색깔
  '빨간', '파란', '노란', '초록', '하얀', '검은', '분홍', '보라', '주황',
  // 도형
  '사각형', '삼각형', '원형', '직사각형', '정사각형', '마름모',
  // 수학 용어
  '합계', '모두', '전체', '나머지', '처음', '나중', '먼저', '마지막',
  '하나', '둘이', '셋이', '넷이', '다섯', '여섯', '일곱', '여덟', '아홉', '열이',
  // 단위
  '미터', '킬로', '리터', '그램', '센티', '밀리', '킬로미터',
  // 기타 공통 단어
  '문제', '정답', '풀이', '방법', '결과', '경우', '조건', '이상', '이하',
  '같이', '함께', '혼자', '모두', '각각', '서로',
]);

/**
 * 한글 마지막 글자의 종성(받침) 코드 반환
 * @param {string} char 한글 글자 하나
 * @returns {number} 0 = 받침 없음(모음 끝), 1~27 = 받침 있음, -1 = 한글 아님
 */
function getJongseong(char) {
  const code = char.charCodeAt(0) - 0xAC00;
  if (code < 0 || code > 11171) return -1;
  return code % 28;
}

/**
 * 문제 텍스트에서 학생 이름을 찾아 '학생N' 으로 치환
 *
 * @param {string} text 원본 문제 텍스트
 * @returns {{ anonymized: string, nameMap: Map<string, string> }}
 *   - anonymized: 이름이 '학생N'으로 치환된 텍스트
 *   - nameMap: Map<원래이름, '학생N'>
 */
export function anonymizeText(text) {
  if (!text || typeof text !== 'string') {
    return { anonymized: text || '', nameMap: new Map() };
  }
  if (!ANONYMIZE_STUDENT_NAMES_ENABLED) {
    return { anonymized: text, nameMap: new Map() };
  }

  const nameMap = new Map(); // originalName → '학생N'
  let counter = 1;

  function getOrCreate(name) {
    if (!nameMap.has(name)) {
      nameMap.set(name, `학생${counter++}`);
    }
    return nameMap.get(name);
  }

  let result = text;

  // ── 패턴 1: 받침 있는 이름 + 이(연결) + 조사 ──
  // 예) 민준이가, 철수이는, 현우이를, 준혁이와
  // [가-힣]{2,4} 뒤에 '이' + 조사가 따라오면 이름 후보
  result = result.replace(
    /([가-힣]{2,4})(이)([가는를와고야도랑의라며면기])/g,
    (match, name, linkVowel, particle) => {
      if (EXCLUDE_WORDS.has(name)) return match;
      // 이름의 마지막 글자가 받침 있어야 '이'가 연결 모음으로 쓰임
      const jong = getJongseong(name[name.length - 1]);
      if (jong <= 0) return match; // 받침 없으면 패턴2에서 처리
      return getOrCreate(name) + linkVowel + particle;
    }
  );

  // ── 패턴 2: 받침 없는(모음 끝) 이름 + 조사 ──
  // 예) 영희가, 지수는, 유진를, 나나야
  result = result.replace(
    /([가-힣]{2,4})([가는를와야의에])/g,
    (match, name, particle) => {
      if (EXCLUDE_WORDS.has(name)) return match;
      // 이미 '학생N' 패턴이면 건너뜀 (재치환 방지)
      if (/^학생\d+$/.test(name)) return match;
      // 받침 없는 이름만 (받침 있는 건 패턴1에서 처리)
      const jong = getJongseong(name[name.length - 1]);
      if (jong !== 0) return match;
      return getOrCreate(name) + particle;
    }
  );

  return { anonymized: result, nameMap };
}

/**
 * Map을 Firebase 저장 가능한 일반 객체로 변환
 * @param {Map<string, string>} nameMap
 * @returns {Record<string, string>} { '철수': '학생1', '영희': '학생2', ... }
 */
export function nameMapToObject(nameMap) {
  if (!nameMap || nameMap.size === 0) return {};
  const obj = {};
  for (const [original, anonymized] of nameMap) {
    obj[original] = anonymized;
  }
  return obj;
}

/**
 * Firebase에 저장된 nameMap 객체로 '학생N' → 원래 이름 복원
 * (교사 대시보드에서 사용)
 *
 * @param {string} text '학생N'이 포함된 텍스트
 * @param {Record<string, string>} nameMapObj { '철수': '학생1', '영희': '학생2' }
 * @returns {string} 원래 이름이 복원된 텍스트
 */
export function restoreNames(text, nameMapObj) {
  if (!text) return text || '';
  if (!nameMapObj || typeof nameMapObj !== 'object' || Object.keys(nameMapObj).length === 0) {
    return text;
  }

  // 역방향 매핑: '학생N' → 원래이름
  const reverseMap = {};
  for (const [original, anonymized] of Object.entries(nameMapObj)) {
    reverseMap[anonymized] = original;
  }

  // 긴 것부터 치환 (학생10 → 학생1 오치환 방지)
  const anonKeys = Object.keys(reverseMap).sort((a, b) => b.length - a.length);
  let result = text;
  for (const anon of anonKeys) {
    result = result.split(anon).join(reverseMap[anon]);
  }
  return result;
}
