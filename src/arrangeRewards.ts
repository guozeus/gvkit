import { dateRange, type DateGrain } from './arrangeCore';

export const REWARD_VALUES = [1, 2, 3, 5, 8] as const;
export type RewardPeriod = DateGrain | 'permanent';
export interface RewardRecord { id: string; completedAt: string; points: number }
export const REWARD_TIERS = {
 day: { thresholds: [1, 3, 5, 8, 12, 18, 26, 36, 50, 70], names: ['起步','不错','进展','顺畅','很赞','出色','高效','强劲','卓越','巅峰'] },
 week: { thresholds: [5,12,22,38,60,90,130,180,250,350], names: ['开局','有序','扎实','稳进','精彩','精进','出众','突破','非凡','鼎盛'] },
 month: { thresholds: [20,50,100,180,300,450,650,900,1200,1600], names: ['起势','积累','前行','持续','奋进','佳绩','丰硕','飞跃','辉煌','登峰'] },
 year: { thresholds: [250,650,1250,2200,3500,5200,7400,10400,14000,18500], names: ['启程','开拓','深耕','稳健','成长','跃进','丰收','卓著','辉煌','传奇'] },
} as const;
export const REWARD_LABELS: Record<RewardPeriod, string> = { day: '日', week: '周', month: '月', year: '年', permanent: '永久' };
export function rewardValue(value: unknown): number { return value === 0 || REWARD_VALUES.includes(value as 1) ? Number(value) : 1; }
export function permanentThreshold(n: number): number { return n <= 40 ? 3 * n * (n + 1) / 2 : 2460 + 120 * (n - 40); }
export function rewardProgress(points: number, period: RewardPeriod) {
 if (period === 'permanent') {
  const level = points >= 2460 ? 40 + Math.floor((points - 2460) / 120) : Math.floor((Math.sqrt(1 + 8 * points / 3) - 1) / 2);
  const floor = permanentThreshold(level), next = permanentThreshold(level + 1);
  return { level, name: `${level}档`, next, nextName: `${level + 1}档`, fill: (points - floor) / (next - floor), floor };
 }
 const { thresholds, names } = REWARD_TIERS[period];
 const level = thresholds.filter(n => points >= n).length;
 const floor = level ? thresholds[level - 1]! : 0, next = thresholds[level] ?? null;
 return { level, name: level ? names[level - 1]! : '待起步', next, nextName: names[level] ?? '满档',
  fill: next === null ? 1 : (level + (points - floor) / (next - floor)) / 10, floor };
}
export function rewardTotal(records: readonly RewardRecord[], period: RewardPeriod, day: string, timezone: string): number {
 if (period === 'permanent') return records.reduce((sum, record) => sum + record.points, 0);
 const range = dateRange(day, period);
 // One formatter per calculation, not per completion. History stays cheap to browse.
 const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
 return records.reduce((sum, record) => {
  const parts = formatter.formatToParts(new Date(record.completedAt));
  const get = (type: string) => parts.find(part => part.type === type)?.value;
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  return sum + (date >= range.start && date <= range.end ? record.points : 0);
 }, 0);
}
/** Only explicit snapshots matching the still-effective completion count. Loading never awards. */
export function rewardRecord(fields: Record<string, unknown>): RewardRecord | null {
 const at = fields.completed_at, points = fields.reward_awarded;
 return fields.gvkit_arrange === true && typeof fields.gvid === 'string' && typeof at === 'string'
  && Number.isFinite(Date.parse(at)) && at === fields.reward_completed_at
  && typeof points === 'number' && [0, ...REWARD_VALUES].includes(points)
  ? { id: fields.gvid, completedAt: at, points } : null;
}
