// Receipt parsing preserves its existing behavior. Reference parsing also
// checks original number tokens against the maintained SQL reader's range.
export function parseExact(text: string, integerReferences = false): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: {source: string}) => {
    if (typeof value !== 'number') return value;
    if (integerReferences) {
      const source = context?.source;
      if (!source || !/^-?(0|[1-9][0-9]*)$/.test(source)) return {unsupportedJsonNumber: source ?? 'unverified'};
      const exact = BigInt(source);
      if (exact < -(1n << 63n) || exact > (1n << 64n) - 1n) return {unsupportedJsonNumber: source};
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (!context?.source) throw new Error('This browser cannot preserve a large receipt integer.');
      return BigInt(context.source);
    }
    return value;
  });
}
