/** Format decimal text without converting source money to a JavaScript number. */
export function currency(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) return undefined;
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const grouped = whole.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${grouped}.${fraction.replace(/0+$/, '').padEnd(2, '0')} USD`;
}
