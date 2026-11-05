import { App, Modal } from 'obsidian';
import { dateRange, dayKey, shiftPeriod, type DateGrain } from './arrangeCore';
import { ArrangeStore } from './arrangeStore';
import { permanentThreshold, REWARD_LABELS, REWARD_TIERS, rewardProgress, rewardTotal, type RewardPeriod } from './arrangeRewards';

const periods: RewardPeriod[] = ['day', 'week', 'month', 'year', 'permanent'];
/** A small projection of the existing Vault completion facts; no independent ledger. */
export class ArrangeRewardsView {
 private top: HTMLButtonElement;
 private panel: HTMLElement;
 private open = false;
 private days: Partial<Record<DateGrain, string>> = {};
 private effects = new Set<HTMLElement>();
 constructor(private app: App, private store: ArrangeStore, private root: HTMLElement, private header: HTMLElement) {
  this.top = header.createEl('button', { cls: 'gvkit-reward-top', attr: { type: 'button' } });
  header.insertBefore(this.top, header.children[1] ?? null);
  this.panel = root.createDiv('gvkit-reward-panel');
  this.panel.hidden = true;
  this.top.onclick = event => { event.stopPropagation(); this.open = !this.open; this.paint(); };
 }
 private today() { return dayKey(new Date(), this.store.state.timezone); }
 private total(period: RewardPeriod, day = this.today()) { return rewardTotal(this.store.rewards, period, day, this.store.state.timezone); }
 levels() { return periods.map(period => rewardProgress(this.total(period), period).level); }
 paint(): void {
  this.top.empty();
  const points = this.total('day');
  this.top.createSpan({ cls: 'gvkit-reward-summary', text: `${points}点` });
  this.top.setAttribute('aria-label', `今天奖励 ${points} 点，${this.open ? '收起' : '展开'}成就面板`);
  this.top.setAttribute('aria-expanded', String(this.open));
  this.panel.hidden = !this.open;
  if (!this.open) return;
  // Keep buttons in place while ordinary list refreshes happen, preserving focus.
  const focused = this.panel.ownerDocument.activeElement as HTMLElement;
  const focusKey = this.panel.contains(focused) ? focused.dataset.rewardControl : undefined;
  this.panel.empty();
  for (const period of periods) {
   const row = this.panel.createDiv('gvkit-reward-row'); row.dataset.period = period;
   const day = period === 'permanent' ? this.today() : this.days[period] ?? this.today();
   const arrow = (direction: number) => {
    const button = row.createEl('button', { cls: 'gvkit-reward-arrow', text: direction < 0 ? '‹' : '›',
     attr: { type: 'button', 'aria-label': `${direction < 0 ? '上一' : '下一'}${REWARD_LABELS[period]}周期` } });
    button.dataset.rewardControl = `${period}:${direction}`;
    if (period === 'permanent') { button.hidden = true; return; }
    button.disabled = direction > 0 && dateRange(day, period).end >= this.today();
    button.onclick = event => { event.stopPropagation(); this.days[period] = shiftPeriod(day, period, direction); this.paint(); };
   };
   if (period === 'permanent') row.createSpan({ cls: 'gvkit-reward-arrow-space' }); else arrow(-1);
   const strip = row.createEl('button', { cls: 'gvkit-reward-strip', attr: { type: 'button', 'aria-label': `${REWARD_LABELS[period]}奖励详情` } });
   strip.dataset.rewardControl = `${period}:detail`;
   this.bar(strip, period, day, this.label(period, day));
   strip.onclick = () => this.detail(period, day);
   if (period === 'permanent') row.createSpan({ cls: 'gvkit-reward-arrow-space' }); else arrow(1);
  }
  if (focusKey) this.panel.querySelector<HTMLElement>(`[data-reward-control="${focusKey}"]`)?.focus({ preventScroll: true });
 }
 private label(period: RewardPeriod, day: string) {
  if (period === 'permanent') return '永久';
  const start = dateRange(day, period).start;
  return period === 'year' ? `年 ${start.slice(0,4)}` : period === 'month' ? `月 ${start.slice(0,7)}` : `${REWARD_LABELS[period]} ${start.slice(5).replace('-', '/')}${start.slice(0,4) !== this.today().slice(0,4) ? '·'+start.slice(0,4) : ''}`;
 }
 private beforeEnabled(period: RewardPeriod, day: string) {
  return period !== 'permanent' && this.store.state.rewardsEnabledAt
   && dateRange(day, period).end < dayKey(new Date(this.store.state.rewardsEnabledAt), this.store.state.timezone);
 }
 private bar(parent: HTMLElement, period: RewardPeriod, day: string, label: string) {
  const points = this.total(period, day), progress = rewardProgress(points, period);
  const bar = parent.createSpan({ cls: 'gvkit-reward-bar' });
  bar.toggleClass('is-segmented', period !== 'permanent');
  bar.toggleClass('is-high', progress.level >= (period === 'permanent' ? 40 : 8));
  bar.style.setProperty('--reward-fill', `${progress.fill * 100}%`);
  const before = this.beforeEnabled(period, day);
  bar.createSpan({ cls: 'gvkit-reward-bar-text', text: before ? `${label} · 启用前无奖励点记录` : `${label} ${points}点 · ${period === 'permanent' ? '' : progress.level ? progress.level+'档·' : ''}${progress.name}` });
  if (!before) parent.createSpan({ cls: 'gvkit-reward-next', text: progress.next === null ? '满档' : `${progress.next}·${progress.nextName}` });
 }
 private detail(period: RewardPeriod, day: string): void {
  const modal = new Modal(this.app), content = modal.contentEl;
  content.addClass('gvkit-reward-detail');
  content.createEl('h3', { text: `${REWARD_LABELS[period]}成就` });
  const range = period === 'permanent' ? null : dateRange(day, period);
  content.createEl('p', { text: range ? `${range.start} — ${range.end}（${this.store.state.timezone}）` : `自 ${this.store.state.rewardsEnabledAt ? dayKey(new Date(this.store.state.rewardsEnabledAt), this.store.state.timezone) : this.today()} 启用起累计` });
  if (this.beforeEnabled(period, day)) content.createEl('p', { text: '启用前无奖励点记录' });
  else {
   const points = this.total(period, day), progress = rewardProgress(points, period);
   content.createEl('p', { text: `${points}点 · ${progress.level}档 · ${progress.name}${progress.next === null ? ' · 满档' : ` · 本档进度 ${points - progress.floor}/${progress.next - progress.floor}`}` });
   if (period !== 'permanent') {
    REWARD_TIERS[period].thresholds.forEach((threshold, index) => content.createDiv({ cls: `gvkit-reward-tier${points >= threshold ? ' is-earned' : ''}`, text: `${index+1}档 · ${REWARD_TIERS[period].names[index]} · ${threshold}点` }));
   } else {
    for (let n = Math.max(1, progress.level - 2); n <= progress.level + 2; n++) content.createDiv({ cls: `gvkit-reward-tier${n <= progress.level ? ' is-earned' : ''}`, text: `${n}档 · ${permanentThreshold(n)}点` });
    content.createEl('h4', { text: '已获得等级' });
    const records = [...this.store.rewards].sort((a,b) => a.completedAt.localeCompare(b.completedAt));
    let sum = 0;
    const arrivals = records.map(record => { sum += record.points; return { at: record.completedAt, level: rewardProgress(sum, 'permanent').level }; });
    let shown = 0;
    const list = content.createDiv();
    const more = content.createEl('button', { text: '查看更多', attr: { type: 'button' } });
    const append = () => {
     const end = Math.min(progress.level, shown + 20);
     for (let n = shown + 1; n <= end; n++) {
      const at = arrivals.find(entry => entry.level >= n)?.at;
      list.createDiv({ text: `${n}档 · ${at ? dayKey(new Date(at), this.store.state.timezone) : ''}` });
     }
     shown = end; more.hidden = shown >= progress.level;
    };
    if (!progress.level) list.createDiv({ text: '朝一档前进' });
    more.onclick = append; append();
   }
  }
  modal.open();
 }
 celebrate(points: number, before: number[], rect?: DOMRect): void {
  if (!points) return;
  const doc = this.root.ownerDocument, win = doc.defaultView ?? window;
  const effect = doc.body.createDiv({ cls: 'gvkit-reward-float', text: `+${points} ✦`, attr: { role: 'status', 'aria-label': `+${points} 奖励点` } });
  effect.style.left = `${Math.max(8, Math.min((rect?.left ?? this.root.getBoundingClientRect().left) + 8, win.innerWidth - 110))}px`;
  effect.style.top = `${Math.max(80, rect?.top ?? this.root.getBoundingClientRect().top + 100)}px`;
  this.removeLater(effect, 2400);
  const after = this.levels();
  const upgrades = periods.filter((_, index) => after[index]! > before[index]!).map(period => `${REWARD_LABELS[period]}·${rewardProgress(this.total(period), period).name}`);
  if (upgrades.length) {
   const toast = doc.body.createDiv({ cls: 'gvkit-reward-celebration', attr: { role: 'status' } });
   toast.createEl('strong', { text: '✦ 成就升级！' }); toast.createSpan({ text: upgrades.join(' · ') });
   this.removeLater(toast, 2000);
  }
 }
 private removeLater(element: HTMLElement, ms: number) {
  this.effects.add(element);
  (this.root.ownerDocument.defaultView ?? window).setTimeout(() => { element.remove(); this.effects.delete(element); }, ms);
 }
 close() { this.top.remove(); this.panel.remove(); for (const effect of this.effects) effect.remove(); this.effects.clear(); }
}
