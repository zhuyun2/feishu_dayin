// 人民币金额转中文大写。
// 例：1234.56 → 壹仟贰佰叁拾肆元伍角陆分；100 → 壹佰元整；0 → 零元整。

const DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
const UNITS = ['', '拾', '佰', '仟'];
const BIG_UNITS = ['', '万', '亿', '兆'];

// 从任意文本/数字提取数值（复用与填充引擎一致的宽松解析）
export function parseAmount(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v == null) return NaN;
  const m = String(v).replace(/[^0-9.\-]/g, '').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
}

// 把 4 位以内的一组数字转中文（含内部“零”处理），返回如 "壹仟零伍"
function convertGroup(num: number): string {
  let s = '';
  let zero = false;
  let started = false; // 是否已遇到第一个非零位（用于跳过前导零）
  const str = String(num).padStart(4, '0');
  for (let i = 0; i < 4; i++) {
    const d = parseInt(str[i], 10);
    const unit = UNITS[3 - i];
    if (d === 0) {
      if (started) zero = true; // 仅内部零标记，前导零忽略
    } else {
      if (zero) s += '零';
      s += DIGITS[d] + unit;
      zero = false;
      started = true;
    }
  }
  return s;
}

export function amountToChinese(input: unknown): string {
  let n = parseAmount(input);
  if (!isFinite(n)) return '';
  const negative = n < 0;
  n = Math.abs(n);

  // 四舍五入到分
  const rounded = Math.round(n * 100);
  const integerPart = Math.floor(rounded / 100);
  const jiao = Math.floor((rounded % 100) / 10);
  const fen = rounded % 10;

  // 整数部分分组（每 4 位一组）
  let intStr = '';
  if (integerPart === 0) {
    intStr = '零';
  } else {
    const groups: number[] = [];
    let rest = integerPart;
    while (rest > 0) {
      groups.unshift(rest % 10000);
      rest = Math.floor(rest / 10000);
    }
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const bigUnit = BIG_UNITS[groups.length - 1 - i];
      if (g === 0) {
        // 中间的空组，避免重复“零”
        if (!intStr.endsWith('零') && i !== groups.length - 1) intStr += '零';
      } else {
        let part = convertGroup(g);
        // 非最高组且高位不足 4 位时前面补零
        if (i > 0 && g < 1000) part = '零' + part;
        intStr += part + bigUnit;
      }
    }
  }
  intStr = intStr.replace(/零+$/, '').replace(/零+/g, '零') || '零';

  let result = intStr + '元';

  if (jiao === 0 && fen === 0) {
    result += '整';
  } else {
    if (jiao > 0) result += DIGITS[jiao] + '角';
    else if (fen > 0) result += '零'; // 有分无角时补零
    if (fen > 0) result += DIGITS[fen] + '分';
  }

  return (negative ? '负' : '') + result;
}
