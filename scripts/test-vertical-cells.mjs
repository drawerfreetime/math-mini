import {
  normalizeVerticalArithmeticRow,
  normalizeVerticalScriptsInText,
} from '../src/utils/verticalArithmeticCells.js';

const rowCases = [
  ['[  ㉠  ]0', '㉠0'],
  ['1[  ㉡  ][  ㉢  ]50', '1㉡㉢50'],
  ['[          ]', ''],
  ['[  (ㄱ)  ]', 'ㄱ'],
];

for (const [input, expected] of rowCases) {
  const got = normalizeVerticalArithmeticRow(input);
  if (got !== expected) {
    console.error('FAIL row', JSON.stringify(input), 'got', JSON.stringify(got), 'want', JSON.stringify(expected));
    process.exit(1);
  }
}

const text =
  '13.\n$MULTVERT { rows: "347 # [  ㉠  ]0 # 1[  ㉡  ][  ㉢  ]50" ; cols: 5 ; divLine: 1 ; opRow: 1 }$\n(㉠: [          ]  ㉡: [          ])';
const norm = normalizeVerticalScriptsInText(text);
if (!norm.includes('rows: "347 # ㉠0 # 1㉡㉢50"')) {
  console.error('FAIL multvert', norm);
  process.exit(1);
}
if (!norm.includes('(㉠: [          ]')) {
  console.error('FAIL answer line preserved', norm);
  process.exit(1);
}
console.log('JS vertical cell tests OK');
