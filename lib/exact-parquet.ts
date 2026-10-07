/** Preserve sub-millisecond timestamps; the default Date parser truncates them. */
function timestamp(value:bigint,units:bigint,digits:number):string {
  const seconds=value/units-(value<0n&&value%units!==0n?1n:0n);
  const fraction=value-seconds*units;
  return new Date(Number(seconds*1000n)).toISOString().slice(0,19)+'.'+fraction.toString().padStart(digits,'0')+'Z';
}
export const exactParsers={
  dateFromDays:(days:number)=>new Date(days*86400000).toISOString().slice(0,10),
  timestampFromMilliseconds:(value:bigint)=>timestamp(value,1000n,3),
  timestampFromMicroseconds:(value:bigint)=>timestamp(value,1000000n,6),
  timestampFromNanoseconds:(value:bigint)=>timestamp(value,1000000000n,9),
};
