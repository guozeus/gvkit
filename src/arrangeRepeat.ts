import { offsetDay, shiftDateMonth } from './arrangeCore';

export interface RepeatRule {
 unit: 'day' | 'week' | 'month' | 'year';
 interval: number;
 anchor: string;
 weekdays?: number[];
 monthDays?: number[];
 yearDates?: string[]; // MM-DD, including 02-29; absent dates are skipped.
}
export interface RepeatCompletion {
 id: string;
 date: string | null;
 completed_at: string;
 title: string;
 body: string;
 parent: string | null;
 reward_points: number;
 reward_awarded: number;
 archived?: boolean;
}
export function validDate(value: unknown): value is string {
 return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value+'T12:00:00Z')) && new Date(value+'T12:00:00Z').toISOString().slice(0,10) === value;
}
export function repeatRule(value: unknown): RepeatRule | null {
 if (value === null || value === undefined) return null;
 const r = value as RepeatRule;
 if (!['day','week','month','year'].includes(r.unit) || !Number.isSafeInteger(r.interval) || r.interval < 1 || !validDate(r.anchor))
  throw Error('重复间隔须为正整数，并选择日期');
 if (r.weekdays !== undefined && (r.unit !== 'week' || !Array.isArray(r.weekdays) || !r.weekdays.length
  || r.weekdays.some(n => !Number.isInteger(n) || n < 0 || n > 6))) throw Error('请选择重复的星期');
 if (r.monthDays !== undefined && (r.unit !== 'month' || !Array.isArray(r.monthDays) || !r.monthDays.length
  || r.monthDays.some(n => !Number.isInteger(n) || n < 1 || n > 31))) throw Error('请至少选择一个日期');
 if (r.yearDates !== undefined && (r.unit !== 'year' || !Array.isArray(r.yearDates) || !r.yearDates.length
  || r.yearDates.some(d => typeof d !== 'string' || !/^\d{2}-\d{2}$/.test(d) || !validDate('2000-'+d)))) throw Error('请至少选择一个有效的月日');
 return { unit:r.unit, interval:r.interval, anchor:r.anchor,
  ...(r.weekdays ? {weekdays:[...new Set(r.weekdays)].sort((a,b)=>a-b)} : {}),
  ...(r.monthDays ? {monthDays:[...new Set(r.monthDays)].sort((a,b)=>a-b)} : {}),
  ...(r.yearDates ? {yearDates:[...new Set(r.yearDates)].sort()} : {}) };
}
/** The anchor is persistent cadence state, not a field the rule dialog edits. */
export function sameRepeatCadence(a: RepeatRule | null, b: RepeatRule | null): boolean {
 if (!a || !b) return a === b;
 if (a.unit !== b.unit || a.interval !== b.interval) return false;
 if (a.unit === 'month') return JSON.stringify(a.monthDays) === JSON.stringify(b.monthDays);
 if (a.unit === 'year') return JSON.stringify(a.yearDates) === JSON.stringify(b.yearDates);
 if (a.unit !== 'week') return true;
 const days = (r: RepeatRule) => (r.weekdays ?? [new Date(r.anchor+'T12:00:00Z').getUTCDay()]).join(',');
 return days(a) === days(b);
}
/** The scheduled day drives progression, never the wall-clock completion time. */
export function nextRepeatDate(day: string, rule: RepeatRule): string {
 let next: string;
 if (rule.monthDays || rule.yearDates) return nextSelectedDate(day,rule);
 if (rule.unit === 'week' && rule.weekdays) {
  const anchorWeek = offsetDay(rule.anchor, -((new Date(rule.anchor+'T12:00:00Z').getUTCDay()+6)%7));
  const week = offsetDay(day, -((new Date(day+'T12:00:00Z').getUTCDay()+6)%7));
  const weeks = Math.round((Date.parse(week+'T12:00:00Z')-Date.parse(anchorWeek+'T12:00:00Z'))/604800000);
  const ordered = [...rule.weekdays].sort((a,b)=>(a+6)%7-(b+6)%7);
  const current = ordered.map(n=>offsetDay(week,(n+6)%7)).find(date=>date>day);
  const remainder = ((weeks%rule.interval)+rule.interval)%rule.interval;
  next = remainder===0 && current ? current : offsetDay(week,(rule.interval-remainder)*7+(ordered[0]!+6)%7);
 } else if (rule.unit === 'day' || rule.unit === 'week') next = offsetDay(day,rule.interval*(rule.unit==='week'?7:1));
 else {
  const months = rule.interval*(rule.unit==='year'?12:1);
  const distance=(Number(day.slice(0,4))-Number(rule.anchor.slice(0,4)))*12+Number(day.slice(5,7))-Number(rule.anchor.slice(5,7));
  next=shiftDateMonth(rule.anchor,(Math.floor(distance/months)+1)*months);
 }
 if (!validDate(next) || next <= day) throw Error('重复日期超出可用范围，请缩短间隔');
 return next;
}
/** Enumerate selected dates in aligned periods, never every intervening day.
 * Gregorian validity repeats within 400 years. Legacy anchor-only rules above
 * keep their established month-end clamping and are never migrated on load. */
function nextSelectedDate(day: string, rule: RepeatRule): string {
 const yearly=rule.unit==='year';
 const period=(date:string)=>Number(date.slice(0,4))*(yearly?1:12)+(yearly?0:Number(date.slice(5,7))-1);
 const origin=period(rule.anchor), distance=period(day)-origin;
 let cycle=Math.max(0,Math.floor(distance/rule.interval));
 for (let checked=0;checked<(yearly?400:4800);checked++,cycle++) {
  const value=origin+cycle*rule.interval;
  const year=yearly?value:Math.floor(value/12), month=yearly?0:value%12+1;
  if (!Number.isSafeInteger(value) || year>9999) break;
  const prefix=String(year).padStart(4,'0')+'-';
  const dates=yearly ? rule.yearDates!.map(d=>prefix+d)
   : rule.monthDays!.map(d=>prefix+String(month).padStart(2,'0')+'-'+String(d).padStart(2,'0'));
  const next=dates.filter(date=>date>day && validDate(date)).sort()[0];
  if (next) return next;
 }
 throw Error('重复规则没有可用的后续日期，请调整日期或间隔');
}
/** First matching occurrence at or after the chosen starting date. */
export function firstRepeatDate(day: string, rule: RepeatRule): string {
 return rule.weekdays || rule.monthDays || rule.yearDates ? nextRepeatDate(offsetDay(day,-1),rule) : day;
}
/** Detailed wording is confined to the picker; existing list/detail labels stay compact. */
export function repeatSummary(rule: RepeatRule | null | undefined): string {
 if (!rule) return '';
 if (rule.unit==='week') return `${rule.interval===1?'每周':`每${rule.interval}周`}${(rule.weekdays??[new Date(rule.anchor+'T12:00:00Z').getUTCDay()]).slice().sort((a,b)=>(a+6)%7-(b+6)%7).map(n=>'一二三四五六日'[(n+6)%7]).join('、')}`;
 if (rule.unit==='month') return `${rule.interval===1?'每月':`每${rule.interval}个月`}${(rule.monthDays??[Number(rule.anchor.slice(8))]).join('、')}号`;
 if (rule.unit==='year') return `${rule.interval===1?'每年':`每${rule.interval}年`}${(rule.yearDates??[rule.anchor.slice(5)]).map(d=>`${Number(d.slice(0,2))}月${Number(d.slice(3))}日`).join('、')}`;
 return repeatLabel(rule);
}
export function repeatLabel(rule: RepeatRule | null | undefined): string {
 if (!rule) return '不重复';
 if (rule.monthDays || rule.yearDates) return repeatSummary(rule);
 if (rule.unit==='week' && rule.weekdays) return `${rule.interval===1?'每周':`每${rule.interval}周`} ${[...rule.weekdays].sort((a,b)=>(a+6)%7-(b+6)%7).map(n=>'一二三四五六日'[(n+6)%7]).join('、')}`;
 return rule.interval===1 ? {day:'每天',week:'每周',month:'每月',year:'每年'}[rule.unit] : `每${rule.interval}${{day:'天',week:'周',month:'个月',year:'年'}[rule.unit]}`;
}
