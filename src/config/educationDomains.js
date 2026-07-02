/**
 * 교육청 이메일 도메인 목록
 * 새 도메인 추가 시 배열에 문자열을 추가하면 됩니다.
 */
export const EDUCATION_DOMAINS = [
  'sen.go.kr',   // 서울특별시교육청
  'goe.go.kr',   // 경기도교육청
  'ice.go.kr',   // 인천광역시교육청
  'pen.go.kr',   // 부산광역시교육청
  'dge.go.kr',   // 대구광역시교육청
  'gen.go.kr',   // 광주광역시교육청
  'dje.go.kr',   // 대전광역시교육청
  'use.go.kr',   // 울산광역시교육청
  'sje.go.kr',   // 세종특별자치시교육청
  'gwe.go.kr',   // 강원도교육청
  'cbe.go.kr',   // 충청북도교육청
  'cne.go.kr',   // 충청남도교육청
  'jbe.go.kr',   // 전라북도교육청
  'jne.go.kr',   // 전라남도교육청
  'gbe.kr',      // 경상북도교육청
  'gne.go.kr',   // 경상남도교육청
  'jje.go.kr',   // 제주특별자치도교육청
];

/**
 * 이메일이 교육청 도메인인지 확인하는 함수
 * @param {string} email
 * @returns {boolean}
 */
export function isEducationEmail(email) {
  if (!email || !email.includes('@')) return false;
  const domain = email.split('@')[1]?.toLowerCase();
  return EDUCATION_DOMAINS.includes(domain);
}

/**
 * 이메일 도메인만 반환
 * @param {string} email
 * @returns {string}
 */
export function getEmailDomain(email) {
  if (!email || !email.includes('@')) return '';
  return email.split('@')[1]?.toLowerCase() || '';
}
