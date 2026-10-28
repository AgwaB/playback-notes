import Handlebars from "handlebars";

const LIMIT = 50;
const QUOTED = /“[^”\n]*”|‘[^’\n]*’|"[^"\n]*"|(?<![\p{L}\p{N}])'[^'\n]*'(?![A-Za-z0-9])|\([^()\n]*\)/gu;
const WORD = "(?:[A-Za-z][A-Za-z0-9'’]*(?:[-./+][A-Za-z0-9]+)*|[0-9]+(?:[,.][0-9]+)*)";
const ENGLISH = new RegExp(`(?<![\\p{L}\\p{N}'’])${WORD}(?:[ \\t]+${WORD}){1,6}[가-힣]{0,6}(?![\\p{L}\\p{N}'’])`, "gu");
const TECHNICAL = /(?<![\p{L}\p{N}])[A-Za-z][A-Za-z0-9]*(?:[-./+][A-Za-z0-9]+)+[가-힣]*(?![\p{L}\p{N}])/gu;
const NUMBER = "[0-9]+(?:[,.][0-9]+)*";
const NUMERIC = new RegExp(`${NUMBER}(?:[~–−-]${NUMBER})?(?:[%％‰℃°]|[A-Za-zµμ]+)?[가-힣]*`, "gu");
const NUMERIC_LIST = new RegExp(`${NUMBER}(?:[·ㆍ]${NUMBER})+[가-힣]*`, "gu");
const KOREAN = [
  /(?<![\p{L}\p{N}])[\p{L}][\p{L}\p{N}]*(?:[·ㆍ][\p{L}\p{N}]+)+(?![\p{L}\p{N}])/gu,
  /(?<![\p{L}\p{N}])[가-힣]+[ \t]+수[ \t]+[가-힣]+(?![\p{L}\p{N}])/gu,
  /(?<![\p{L}\p{N}])[가-힣]+[ \t]+(?:안|못|것은|것이|것을|것도)[ \t]+[가-힣]+(?![\p{L}\p{N}])/gu,
  /(?<![\p{L}\p{N}])[가-힣]+[ \t]+[가-힣]+(?=[.!?…](?:\s|$)|$)/gu,
  /(?<![\p{L}\p{N}])(?:지금|바로|곧|오늘|내일|어제|다음|이번|지난)[ \t]+[가-힣]{1,4}(?![\p{L}\p{N}])/gu,
  /(?<![\p{L}\p{N}])(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)[ \t]+(?:살|세)[가-힣]*(?![\p{L}\p{N}])/gu,
  /—[ \t]+[가-힣]{1,8}[ \t]+[가-힣]{1,12}(?![\p{L}\p{N}])/gu,
];
const TRANSLITERATED = /(?<![\p{L}\p{N}])(?:[가-힣]{1,8}[ \t]+)?[가-힣]{1,8}[ \t]*\([A-Za-z][^()\n]{0,40}\)[가-힣]{0,6}(?![\p{L}\p{N}])/gu;

/** Bounded text groups preserve source wording; CSS can wrap an overwide group internally. */
export function phraseHtml(text) {
  const markup = [...text.matchAll(/<[^<>\n]*>/gu)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
  const connected = (index) => /[\p{L}\p{N}\p{M}_+*/÷×=^%％‰℃°~–−-]/u.test(text[index] ?? "")
    || (/[.'’]/u.test(text[index] ?? "") && /[\p{L}\p{N}]/u.test(text[index - 1] ?? "") && /[\p{L}\p{N}]/u.test(text[index + 1] ?? ""))
    || (/[,:]/u.test(text[index] ?? "") && /[0-9]/u.test(text[index - 1] ?? "") && /[0-9]/u.test(text[index + 1] ?? ""));
  // Expansion stops once a range is past the limit: it will be rejected anyway, and
  // scanning a whole long connected token for every match inside it is quadratic.
  const complete = ({ start, end }) => {
    while (start > 0 && end - start <= LIMIT && connected(start - 1)) start--;
    while (end < text.length && end - start <= LIMIT
      && (connected(end) || (/[)\]”’]/u.test(text[end]) && connected(end + 1)))) end++;
    return { start, end };
  };
  const quoted = [...text.matchAll(QUOTED)].map((match) => ({
    start: match.index, end: match.index + match[0].length,
  })).map(complete).filter((range) => !markup.some((tag) => range.start < tag.end && range.end > tag.start));
  const ranges = [];
  const add = (range) => {
    if (range.end - range.start > LIMIT) return;
    while (range.end - range.start < LIMIT && /[.,!?…:;，。！？、)\]”’]/u.test(text[range.end] ?? "")) range.end++;
    ranges.push(range);
  };
  for (const range of quoted) add({ ...range });
  const collect = (pattern, includeQuoted = false) => {
    for (const match of text.matchAll(pattern)) {
      const { start, end } = complete({ start: match.index, end: match.index + match[0].length });
      if (end - start <= LIMIT && !markup.some((tag) => start < tag.end && end > tag.start)
        && (includeQuoted || !quoted.some((range) => start < range.end && end > range.start)))
        add({ start, end });
    }
  };
  collect(ENGLISH);
  collect(TECHNICAL);
  collect(NUMERIC_LIST);
  collect(NUMERIC);
  for (const pattern of KOREAN) collect(pattern);
  collect(TRANSLITERATED, true);
  const groups = [];
  for (const range of ranges.sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = groups.at(-1);
    if (last && range.start < last.end) {
      if (Math.max(last.end, range.end) - last.start <= LIMIT) last.end = Math.max(last.end, range.end);
    } else groups.push({ start: range.start, end: range.end });
  }
  let html = "", cursor = 0;
  for (const { start, end } of groups) {
    const value = text.slice(start, end);
    const content = /^[\p{L}][\p{L}\p{N}]*(?:[·ㆍ][\p{L}\p{N}]+)+[.,!?…:;，。！？、)\]”’]*$/u.test(value)
      ? [...value.matchAll(/[^·ㆍ]+[·ㆍ]?/gu)].map(([unit]) => `<span class="source-phrase">${Handlebars.escapeExpression(unit)}</span>`).join("")
      : Handlebars.escapeExpression(value);
    html += Handlebars.escapeExpression(text.slice(cursor, start));
    html += `<span class="source-phrase">${content}</span>`;
    cursor = end;
  }
  return html + Handlebars.escapeExpression(text.slice(cursor));
}
