import type { Dataset, Filter, Row } from './catalog';
import type { ParquetQueryFilter } from 'hyparquet';
/** Optional literal alternatives belong to one reviewed field; stored rows stay unchanged. */
export function validFilter(value: unknown): value is Filter {
  if (!value || typeof value !== 'object') return false;
  const f = value as Filter;
  return typeof f.column === 'string' && typeof f.value === 'string' &&
    (f.values === undefined || Array.isArray(f.values) && f.values.length > 0 && f.values.length <= 8 && f.values.every(v => typeof v === 'string'));
}
const integerBits: Record<string, [number, boolean]> = {TINYINT:[8,true],SMALLINT:[16,true],INTEGER:[32,true],BIGINT:[64,true],UTINYINT:[8,false],USMALLINT:[16,false],UINTEGER:[32,false],UBIGINT:[64,false]};
export function exactTimestamp(value: string): bigint | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!m || !exactDate(m[1])) return;
  const clock=m[2].split(':').map(Number);
  if (clock[0]>23||clock[1]>59||clock[2]>59) return;
  if (m[4] && m[4] !== 'Z') {const [hours,minutes]=m[4].slice(1).split(':').map(Number);if(hours>23||minutes>59)return;}
  const milliseconds=Date.parse(`${m[1]}T${m[2]}${m[4]??'Z'}`);
  return Number.isFinite(milliseconds) ? BigInt(milliseconds)*1000000n+BigInt((m[3]??'').padEnd(9,'0')) : undefined;
}
function exactDate(value:string):string|undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
  const date=new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10)===value ? value : undefined;
}
function typedValue(value:string,type:string):string|number|bigint|boolean|undefined {
  const integer=integerBits[type];
  if(integer) {
    if(!/^-?\d+$/.test(value)) return;
    const n=BigInt(value),[bits,signed]=integer;
    if(n<(signed?-(1n<<BigInt(bits-1)):0n)||n>=(1n<<BigInt(signed?bits-1:bits)))return;
    return bits===64?n:Number(n);
  }
  if(type==='DATE')return exactDate(value);
  if(type.startsWith('TIMESTAMP'))return exactTimestamp(value);
  if(type==='BOOLEAN')return value==='true'?true:value==='false'?false:undefined;
  if(['FLOAT','DOUBLE'].includes(type)) {const n=Number(value);return value.trim()===value&&value!==''&&Number.isFinite(n)?n:undefined;}
  return value;
}
export function matchesFilters(row: Row, filters: Filter[], columns?:Dataset['columns']): boolean {
  return filters.every(f => {
    const value=row[f.column],type=columns?.find(c=>c.name===f.column)?.type;
    if(value==null)return false;
    if(typeof value==='number' && !Number.isSafeInteger(value) && (!type||integerBits[type]))return false;
    const actual=type?.startsWith('TIMESTAMP') ? (typeof value==='string'?exactTimestamp(value):undefined) : value;
    const typed=!!type&&(!!integerBits[type]||['VARCHAR','DATE','BOOLEAN','FLOAT','DOUBLE'].includes(type)||type.startsWith('TIMESTAMP'));
    return (f.values??[f.value]).some(v=> {
      const expected=type?typedValue(v,type):v;
      if(expected===undefined||actual===undefined)return false;
      return typed ? actual===expected : ['string','bigint','number','boolean'].includes(typeof actual)&&String(actual)===expected;
    });
  });
}
/** Unsupported types retain exact post-filtering and do not claim index pruning. */
export function parquetFilter(filters:Filter[],columns:Dataset['columns']):ParquetQueryFilter|undefined {
  const predicates=filters.flatMap(f=> {
    const type=columns.find(c=>c.name===f.column)?.type;
    if(!type||!(['VARCHAR','DATE','BOOLEAN','FLOAT','DOUBLE'].includes(type)||integerBits[type]))return [];
    const values=(f.values??[f.value]).map(v=>typedValue(v,type));
    if(values.some(v=>v===undefined))return [];
    return [{[f.column]:{$in:values}}];
  });
  return predicates.length?{$and:predicates}:undefined;
}
