import { Modal, Notice, type App } from 'obsidian';
import type { ArrangeStore } from './arrangeStore';
import type { OrderIntent } from './arrangeV2';

const names: Record<string, string> = {
  order: '事项顺序', dailyGoal: '今日目标', specialReminderDay: '特别提醒处理日', rewardsEnabledAt: '奖励启用时间', timezone: '时区',
  listFontSize: '列表标题字号', detailFontSize: '详情标题字号', bodyFontSize: '详情正文字号', dateFontSize: '日期提示字号',
  rowHeight: '事项行高', parentFontSize: '上级导航字号', keyboardGap: '键盘间距', fullscreenThreshold: '全屏阈值',
  tips: '提醒文字', tipsScrollSpeed: '提醒滚动速度', tipsInterval: '提醒间隔', tipsProbability: '提醒概率', tipsTextColor: '提醒文字颜色', tipsBackgroundColor: '提醒背景色',
  submitArrowSize: '提交箭头大小', submitColor: '提交箭头颜色', detailShadow: '详情阴影', bodyPlaceholder: '正文输入提示',
  composerMaxRows: '输入框最大行数', bodyMinRows: '正文最少行数', completedStyle: '完成样式', rootItemStyle: '上级事项样式',
  completionSound: '完成音效', rowActions: '列表操作', detailActions: '详情操作', swipeAction: '滑动操作', pullDownClose: '下拉关闭',
  showCompletedChildren: '显示已完成下级', rowDividers: '行分隔线', selectedBreathePeriod: '选中呼吸周期', selectedBreatheLight: '浅色呼吸强度', selectedBreatheDark: '深色呼吸强度',
  gripHeight: '顶部触摸带高度', gripWidth: '拖动横条宽度', toolbarHeight: '详情操作栏高度', closeThreshold: '关闭阈值',
  selectionColor: '选中颜色', dateHintColor: '日期提示颜色', rowIconGap: '列表图标间距', detailIconGap: '详情图标间距', pinColor: '钉住颜色',
  checkboxScale: '勾选框尺寸', rowRightGap: '列表右侧留白', mobileHeaderGap: '手机顶栏间距',
};
const labels: Record<string, string> = { true: '开启', false: '关闭', none: '无', background: '背景', text: '文字',
  blue: '蓝色', purple: '紫色', gold: '金色', parent: '上级', date: '日期', top: '置顶', pin: '钉住', changeParent: '修改上级',
  copy: '复制', archive: '归档', developmentCompleted: 'AI已执行', developmentProject: '开发工程', specialReminder: '特别提醒' };
export function conflictValue(store: ArrangeStore, field: string, value: unknown): string {
  const title = (id: string) => store.items.find(item => item.id === id)?.title ?? '未同步事项';
  if (value === null || value === undefined || value === '') return '未设置';
  if (field === 'dailyGoal') { const goal = value as {day:string;id:string|null}; return `${goal.day} · ${goal.id ? title(goal.id) : '无目标'}`; }
  if (field === 'order' && !Array.isArray(value)) {
    const order = value as OrderIntent;
    return `${{move:'移动',top:'置顶',front:'移到最前',remove:'移出顺序'}[order.kind]}：${order.ids.map(title).join('、') || '保留当前顺序'}`;
  }
  if (field === 'order') return (value as string[]).slice(0, 5).map(title).join('、') + ((value as string[]).length > 5 ? '…' : '');
  if (Array.isArray(value)) return value.map(v => labels[String(v)] ?? String(v)).join('、');
  return labels[String(value)] ?? String(value);
}
/** Only appears for an actual unresolved field; confirms exactly the observed IDs. */
export function showConfigConflict(app: App, store: ArrangeStore, changed: () => void): void {
  const first = store.v2.projection?.pending.entries().next().value as [string, string[]] | undefined;
  if (!first) return;
  const [field, ids] = first, modal = new Modal(app);
  modal.setTitle(`${names[field] ?? (field.startsWith('achieved:') ? field.slice(9) + '达成状态' : '设置')}待确认`);
  modal.contentEl.createEl('p', {text:'多设备修改不一致。当前值仅暂用，请选择保留值。'});
  const state = store.v2.projection!.state;
  const current = field.startsWith('achieved:') ? state.achievedDays.includes(field.slice(9)) : (state as unknown as Record<string, unknown>)[field];
  const buttons: HTMLButtonElement[] = [];
  const add = (label: string, choice?: string) => {
    const button = modal.contentEl.createEl('button', {text:label, cls:'gvkit-arrange-conflict-choice', attr:{type:'button'}});
    buttons.push(button);
    button.onclick = async () => {
      buttons.forEach(b => b.disabled = true);
      try {
        await store.resolveConfigConflict(field, ids, choice);
        modal.close(); changed();
        new Notice(store.hasConfigConflict(field) ? '仍有新冲突，请再次确认' : store.v2.pending ? '已在本机确认，等待同步' : '已确认');
        if (store.v2.projection?.pending.size) showConfigConflict(app, store, changed);
      } catch (error) {
        modal.close(); changed(); new Notice(error instanceof Error ? error.message : String(error));
        if (store.v2.projection?.pending.size) showConfigConflict(app, store, changed);
      }
    };
  };
  add('保留当前：' + conflictValue(store, field, current));
  const shown = new Set([JSON.stringify(current)]);
  for (const choice of store.v2.conflictChoices(field)) {
    const signature = JSON.stringify(choice.value);
    if (shown.has(signature)) continue;
    shown.add(signature);
    add('采用：' + conflictValue(store, field, choice.value), choice.id);
  }
  modal.open();
}
