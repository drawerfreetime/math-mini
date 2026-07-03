import {
  extractMatchingItemLabel,
  normalizeMatchingSideItems,
  normalizeMatchingPayload,
  defaultMatchingLabel,
} from '../src/utils/matchingItems.js';

// OCR 예시: (1) 475×80 / 가 37800
const left = normalizeMatchingSideItems(['(1) 475×80', '(2) 540×70', '(3) 700×50'], 'left');
if (left.labels.join(',') !== '(1),(2),(3)') {
  console.error('left labels', left.labels);
  process.exit(1);
}
if (left.items[0] !== '475×80') {
  console.error('left content', left.items);
  process.exit(1);
}

const right = normalizeMatchingSideItems(['가 37800', '나 35000', '다 38000'], 'right');
if (right.labels.join(',') !== '(가),(나),(다)') {
  console.error('right labels', right.labels);
  process.exit(1);
}
if (right.items[0] !== '37800') {
  console.error('right content', right.items);
  process.exit(1);
}

const defaults = normalizeMatchingSideItems(['475×80', '540×70'], 'left');
if (defaults.labels[0] !== '(1)' || defaults.labels[1] !== '(2)') {
  console.error('default left', defaults.labels);
  process.exit(1);
}

const defRight = normalizeMatchingSideItems(['37800', '35000'], 'right');
if (defRight.labels[0] !== '(가)' || defRight.labels[1] !== '(나)') {
  console.error('default right', defRight.labels);
  process.exit(1);
}

const payload = normalizeMatchingPayload({
  question: '계산 결과에 맞게 선으로 이어 보시오.',
  leftItems: ['(1) 475×80', '(2) 540×70'],
  rightItems: ['가 37800', '나 35000'],
});
if (!payload.leftLabels.includes('(1)')) {
  console.error('payload', payload);
  process.exit(1);
}

console.log('matching label tests OK');
