import { App, Modal, Notice, setIcon } from 'obsidian';
import { dateRange, offsetDay, shiftDateMonth, shiftPeriod } from './arrangeCore';
import { firstRepeatDate, nextRepeatDate, repeatRule, repeatSummary, type RepeatRule } from './arrangeRepeat';

type Snapshot = { date: string | null; rule: RepeatRule | null };
export interface RepeatEditor {
 rule: RepeatRule | null;
 save: (rule: RepeatRule | null, date: string | null) => Promise<boolean>;
}
export interface BatchDateOptions {
 count: number;
 mixed: boolean;
 anyDate: boolean;
 clearBlocked?: string;
 failureMessage: () => string;
 failureDetails: () => string[];
 onClose: () => void;
}
export function appendBatchFailures(parent: HTMLElement, failures: readonly string[]): void {
 if(!failures.length)return;
 const details=parent.createEl('details',{cls:'gvkit-arrange-batch-failures'});
 details.createEl('summary',{text:'查看未保存'});
 const list=details.createDiv();
 for(const text of failures)list.createEl('p',{text});
}
const weekday = (date: string) => new Date(date+'T12:00:00Z').getUTCDay();
const weekName = (n: number) => '一二三四五六日'[(n+6)%7];
const monthDay = (month: number, day: number) => `${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
const signature = (rule: RepeatRule | null) => !rule ? 'none' : JSON.stringify([
 rule.unit, rule.interval,
 rule.unit==='week' ? rule.weekdays??[weekday(rule.anchor)] :
 rule.unit==='month' ? rule.monthDays??[Number(rule.anchor.slice(8))] :
 rule.unit==='year' ? rule.yearDates??[rule.anchor.slice(5)] : null,
]);

/** One date/repeat surface, shared by desktop, mobile and the new-item draft.
 * UI selection is immediate; the same complete snapshot is saved atomically.
 * Rapid changes coalesce, and closing waits for the last real write. */
export class ArrangeDatePicker extends Modal {
 private current: Snapshot;
 private saved: Snapshot;
 private dirty = false;
 private savedCertain = true;
 private mixed = false;
 private anyDate = false;
 private writing: Promise<boolean> | null = null;
 private timer: ReturnType<typeof setTimeout> | null = null;
 private inputTimer: ReturnType<typeof setTimeout> | null = null;
 private feedback!: HTMLElement;
 private retry!: HTMLButtonElement;
 private discard!: HTMLButtonElement;
 private status = '';
 private failed = false;
 private invalid = '';
 private inputPending = false;
 private commitInput: (() => void) | null = null;
 private updateSummary: (() => void) | null = null;
 private exiting = false;
 constructor(app: App, current: string | null, private day: string,
  private saveDate: (date: string | null) => Promise<boolean>, private repeat?: RepeatEditor,
  private interaction?: (event: Event) => void, private batch?: BatchDateOptions) {
  super(app);
  this.current = this.saved = {date:current,rule:repeat?.rule??null};
  this.mixed=Boolean(batch?.mixed);this.anyDate=batch?.anyDate??Boolean(current);
  this.savedCertain=!this.mixed;
  this.modalEl?.addClass('gvkit-arrange-date-dialog');
  this.modalEl?.setAttribute('aria-label',batch?'批量日期':'日期与重复');
  this.contentEl.addClass('gvkit-arrange-date-menu');
  for (const name of ['click','input','change']) this.contentEl.addEventListener(name,event=>this.interaction?.(event),true);
  this.showDate();
 }
 private button(parent: HTMLElement, label: string, action: () => void, cls = '', icon?: string, aria = label): HTMLButtonElement {
  const button = parent.createEl('button',{cls,attr:{type:'button','aria-label':aria}});
  if (icon) setIcon(button.createSpan({attr:{'aria-hidden':'true'}}),icon);
  button.createSpan({text:label});
  button.onclick=action;
  return button;
 }
 private footer(): void {
  const footer=this.contentEl.createDiv('gvkit-arrange-date-feedback');
  this.feedback=footer.createSpan({attr:{role:'status','aria-live':'polite'}});
  this.retry=this.button(footer,'重试',()=>{void this.flush();});
  this.discard=this.button(footer,this.batch?'结束设置':'取消更改',()=>{
   if(this.timer!==null)clearTimeout(this.timer);
   if(this.inputTimer!==null)clearTimeout(this.inputTimer);
   this.current=this.saved;this.dirty=false;super.close();
  });
  this.paintFeedback();
 }
 private paintFeedback(): void {
  if (!this.feedback) return;
  this.feedback.textContent=this.invalid||this.status;
  this.feedback.toggleClass('is-error',Boolean(this.invalid)||this.failed);
  this.feedback.parentElement!.hidden=!this.invalid&&!this.status;
  this.retry.hidden=!this.failed;
  this.discard.hidden=!this.failed;
  this.feedback.parentElement!.querySelector('.gvkit-arrange-batch-failures')?.remove();
  if(this.failed&&this.batch)appendBatchFailures(this.feedback.parentElement!,this.batch.failureDetails());
 }
 private request(next: Snapshot): void {
  this.invalid='';
  this.current=next;
  this.updateSummary?.();
  // A no-op opening/return must never reset a legacy month-end anchor.
  this.dirty=!this.savedCertain||JSON.stringify(next)!==JSON.stringify(this.saved);
  this.failed=false;this.status=this.dirty?'正在保存…':'';this.paintFeedback();
  if(this.timer!==null) clearTimeout(this.timer);
  this.timer=this.dirty ? setTimeout(()=>{this.timer=null;void this.persist();},220) : null;
 }
 private persist(): Promise<boolean> {
  if(this.writing) return this.writing;
  this.writing=(async()=>{
   while(this.dirty) {
    this.failed=false;this.status='正在保存…';this.paintFeedback();
    const snapshot=this.current;
    this.dirty=false;
    let ok=false;
    try { ok=this.repeat ? await this.repeat.save(snapshot.rule,snapshot.date) : await this.saveDate(snapshot.date); }
    catch { /* Keep the user's selection and the retry action visible. */ }
    if(!ok) {
     this.dirty=true;if(this.batch)this.savedCertain=false;this.failed=true;this.status=this.batch?.failureMessage()||'未保存，请重试';this.paintFeedback();
     return false;
    }
    this.saved=snapshot;this.savedCertain=true;
    // Changes made while a slow write is pending get exactly one next write.
    this.dirty=JSON.stringify(this.current)!==JSON.stringify(snapshot);
   }
   this.failed=false;this.status='';this.paintFeedback();
   return true;
  })().finally(()=>{this.writing=null;});
  return this.writing;
 }
 private flush(): Promise<boolean> {
  if(this.timer!==null) {clearTimeout(this.timer);this.timer=null;}
  return this.persist();
 }
 private finishInput(): void {
  if(this.inputTimer!==null) {clearTimeout(this.inputTimer);this.inputTimer=null;}
  if(this.inputPending) this.commitInput?.();
 }
 override close(): void {
  if(this.exiting || this.failed) return;
  this.exiting=true;
  this.finishInput();
  void this.flush().then(ok=>{
   if(ok) {if(this.invalid)new Notice(this.batch?this.invalid:'未完整的重复设置未保存');super.close();}
  }).finally(()=>{this.exiting=false;});
 }
 override onClose(): void { this.batch?.onClose(); }
 private changeDate(date: string | null): void {
  if(date===null&&this.batch?.clearBlocked){this.invalid=this.batch.clearBlocked;this.paintFeedback();return;}
  this.mixed=false;this.anyDate=Boolean(date);
  let rule=this.current.rule;
  if(date!==this.current.date && rule) rule=date?{...rule,anchor:date}:null;
  this.request({date,rule});
 }
 private showDate(): void {
  this.contentEl.empty();this.contentEl.removeClass('gvkit-arrange-repeat');
  this.commitInput=null;this.inputPending=false;this.invalid='';
  const header=this.contentEl.createDiv('gvkit-arrange-date-heading');
  const clear=this.button(header,'清除',()=>this.changeDate(null),'gvkit-arrange-date-clear','calendar-x','清除日期');
  const status=header.createDiv({cls:'gvkit-arrange-date-current',attr:{'aria-live':'polite'}});
  const date=status.createSpan('gvkit-arrange-date-value');
  const rule=status.createSpan('gvkit-arrange-date-rule');
  header.createSpan({cls:'gvkit-arrange-date-spacer',attr:{'aria-hidden':'true'}});
  this.updateSummary=()=>{
   clear.hidden=!this.current.date&&!this.anyDate;
   date.textContent=(this.batch?`${this.batch.count}项 · `:'')+(this.mixed?'日期不同':this.current.date ? `${this.current.date} ` : '未设日期');
   date.toggleClass('is-empty',!this.current.date);
   rule.textContent=repeatSummary(this.current.rule);rule.hidden=!this.current.rule;
  };
  this.updateSummary();
  const quick=this.contentEl.createDiv('gvkit-arrange-date-actions');
  for(const [label,icon,action] of [
   ['今天','calendar-check',()=>this.changeDate(this.day)],
   ['明天','calendar-plus',()=>this.changeDate(offsetDay(this.day,1))],
   ['后天','calendar-days',()=>this.changeDate(offsetDay(this.day,2))],
   ['下周','calendar-range',()=>this.changeDate(offsetDay(this.day,7))],
   ['选择','calendar',()=>this.calendar()],
  ] as const) this.button(quick,label,action,'',icon,label==='选择'?'选择日期':label);
  const shifts=this.contentEl.createDiv('gvkit-arrange-date-shifts');
  for(const [label,aria,action] of [
   ['+1天','推一天',()=>this.changeDate(offsetDay(this.current.date??this.day,1))],
   ['-1天','提前一天',()=>this.changeDate(offsetDay(this.current.date??this.day,-1))],
   ['+1周','推一周',()=>this.changeDate(offsetDay(this.current.date??this.day,7))],
   ['+1月','推一月',()=>this.changeDate(shiftDateMonth(this.current.date??this.day,1))],
  ] as const) this.button(shifts,label,action,'gvkit-arrange-date-shift',undefined,aria);
  if(this.repeat) this.button(shifts,'重复',()=>this.showRepeat(),'gvkit-arrange-repeat-entry','repeat');
  this.footer();
 }
 private showRepeat(): void {
  const original=this.current.rule, startingDate=this.current.date??this.day;
  const base=original?.anchor??startingDate;
  const weekdays=new Set(original?.weekdays??[weekday(base)]);
  const monthDays=new Set(original?.monthDays??[Number(base.slice(8))]);
  const yearDates=new Set(original?.yearDates??[base.slice(5)]);
  let month=Number(base.slice(5,7));
  let selected:string='custom';
  const todayWeek=weekday(this.day), todayDate=Number(this.day.slice(8)), todayMonth=Number(this.day.slice(5,7));
  const presetRule=(kind:string):RepeatRule|null=>kind==='none'?null:repeatRule({unit:kind,interval:1,anchor:startingDate,
   ...(kind==='week'?{weekdays:[todayWeek]}:{}),...(kind==='month'?{monthDays:[todayDate]}:{}),...(kind==='year'?{yearDates:[this.day.slice(5)]}:{})});
  for(const kind of ['none','day','week','month','year']) if(signature(original)===signature(presetRule(kind)))selected=kind;
  this.contentEl.empty();this.contentEl.addClass('gvkit-arrange-repeat');
  const heading=this.contentEl.createDiv('gvkit-arrange-repeat-heading');
  this.button(heading,'',()=>{
   if(this.failed)return;
   this.finishInput();void this.flush().then(ok=>{if(ok){if(this.invalid)new Notice('未完整的重复设置未保存');this.showDate();}});
  },'gvkit-arrange-repeat-back','chevron-left','返回日期');
  const summary=heading.createSpan({attr:{'aria-live':'polite'}});
  this.updateSummary=()=>{summary.textContent=repeatSummary(this.current.rule)||'不重复';};this.updateSummary();
  const presets=this.contentEl.createDiv('gvkit-arrange-repeat-presets');
  const buttons=new Map<string,HTMLButtonElement>();
  const choose=(candidate:RepeatRule|null)=>{
   this.inputPending=false;
   if(this.inputTimer!==null){clearTimeout(this.inputTimer);this.inputTimer=null;}
   try {
    let rule=candidate, date=this.current.date;
    if(rule) {
     if(signature(rule)===signature(original)) {rule=original;date=startingDate;}
     else {date=firstRepeatDate(startingDate,rule);rule={...rule,anchor:date};}
     nextRepeatDate(date!,rule!);
    }
    this.request({date,rule});
   } catch(error) {this.invalid=error instanceof Error?error.message:'请选择有效的重复日期';this.paintFeedback();}
   paintSelection();
  };
  for(const [kind,label,hint] of [
   ['none','无',''],['day','每天',''],['week','每周',`（周${weekName(todayWeek)}）`],
   ['month','每月',`（${todayDate}号）`],['year','每年',`（${todayMonth}月${todayDate}号）`],
  ]) {
   const button=this.button(presets,label!,()=>{selected=kind!;choose(presetRule(kind!));},'',undefined,label!);
   button.dataset.preset=kind;
   if(hint)button.createSpan({cls:'gvkit-arrange-repeat-hint',text:hint});
   buttons.set(kind!,button);
  }
  const custom=this.contentEl.createDiv('gvkit-arrange-repeat-custom');
  custom.createSpan({text:'每'});
  const interval=custom.createEl('input',{type:'number',value:String(original?.interval??1),attr:{min:'1',step:'1',inputmode:'numeric','aria-label':'重复间隔'}});
  const unit=custom.createEl('select',{attr:{'aria-label':'间隔单位'}});
  for(const [value,text] of [['day','天'],['week','周'],['month','月'],['year','年']]) unit.createEl('option',{value,text});
  unit.value=original?.unit??'day';
  const choices=this.contentEl.createDiv('gvkit-arrange-repeat-choices');
  const note=this.contentEl.createDiv({cls:'gvkit-arrange-repeat-hint',text:'无此日期时跳过'});
  const paintSelection=()=>{
   for(const [kind,button] of buttons)button.setAttribute('aria-pressed',String(selected===kind));
   custom.toggleClass('is-active',selected==='custom');
   choices.toggleClass('is-active',selected==='custom');
   for(const button of Array.from(choices.querySelectorAll<HTMLButtonElement>('[data-choice]'))) {
    const key=button.dataset.choice!;
    button.setAttribute('aria-pressed',String(selected==='custom' && (unit.value==='week'?weekdays.has(Number(key)):unit.value==='month'?monthDays.has(Number(key)):yearDates.has(key))));
   }
   const active=this.current.rule;
   const shortMonth=active?.unit==='month' && (active.monthDays??[Number(active.anchor.slice(8))]).some(n=>n>28);
   const leapDay=active?.unit==='year' && (active.yearDates??[active.anchor.slice(5)]).includes('02-29');
   note.hidden=!(shortMonth||leapDay);
   note.textContent=active?.monthDays||active?.yearDates?'无此日期时跳过':shortMonth?'短月按月末':'非闰年按2月28日';
  };
  const applyCustom=()=>{
   this.inputPending=false;selected='custom';
   try {
    const amount=Number(interval.value);
    if(!interval.value.trim() || !Number.isSafeInteger(amount) || amount<1)throw Error('请输入有效的正整数');
    const rule=repeatRule({unit:unit.value,interval:amount,anchor:startingDate,
     ...(unit.value==='week'?{weekdays:[...weekdays]}:{}),
     ...(unit.value==='month'?{monthDays:[...monthDays]}:{}),
     ...(unit.value==='year'?{yearDates:[...yearDates]}:{})});
    choose(rule);
   } catch(error){this.invalid=error instanceof Error?error.message:'请选择重复日期';this.paintFeedback();paintSelection();}
  };
  const renderChoices=()=>{
   choices.empty();
   if(unit.value==='year') {
    const months=choices.createDiv('gvkit-arrange-repeat-month');
    this.button(months,'',()=>{month=month===1?12:month-1;renderChoices();},'','chevron-left','上个月');
    months.createSpan({text:`${month}月`});
    this.button(months,'',()=>{month=month===12?1:month+1;renderChoices();},'','chevron-right','下个月');
   }
   if(unit.value!=='day') {
    const grid=choices.createDiv('gvkit-arrange-repeat-days');
    const days=unit.value==='week'?[1,2,3,4,5,6,0]:Array.from({length:unit.value==='year'?Number(dateRange(`2000-${String(month).padStart(2,'0')}-01`,'month').end.slice(8)):31},(_,i)=>i+1);
    for(const n of days) {
     const key=unit.value==='year'?monthDay(month,n):String(n);
     const label=unit.value==='week'?`周${weekName(n)}`:String(n);
     const button=this.button(grid,label,()=>{
      const set=unit.value==='week'?weekdays:monthDays;
      if(unit.value==='year'){if(yearDates.has(key))yearDates.delete(key);else yearDates.add(key);}
      else {if(set.has(n))set.delete(n);else set.add(n);}
      applyCustom();
     },'',undefined,unit.value==='year'?`${month}月${n}日`:unit.value==='month'?`${n}号`:label);
     button.dataset.choice=key;
    }
   }
   paintSelection();
  };
  this.commitInput=applyCustom;
  interval.oninput=()=>{
   selected='custom';this.inputPending=true;paintSelection();
   if(this.inputTimer!==null)clearTimeout(this.inputTimer);
   this.inputTimer=setTimeout(()=>{this.inputTimer=null;applyCustom();},250);
  };
  interval.onchange=()=>{this.finishInput();};
  unit.onchange=()=>{renderChoices();applyCustom();};
  renderChoices();this.footer();
 }
 private calendar(): void {
  const modal=new Modal(this.app);modal.setTitle('选择日期');
  modal.contentEl.addClass('gvkit-arrange-calendar-menu');
  for(const name of ['click','input','change'])modal.contentEl.addEventListener(name,event=>this.interaction?.(event),true);
  let selected=this.current.date??this.day, month=selected.slice(0,7);
  const calendar=modal.contentEl.createDiv('gvkit-arrange-calendar');
  const paint=()=>{
   calendar.empty();
   const header=calendar.createDiv('gvkit-arrange-calendar-header');
   const shift=(direction:-1|1)=>{month=shiftPeriod(`${month}-01`,'month',direction).slice(0,7);paint();};
   this.button(header,'',()=>shift(-1),'gvkit-arrange-icon','chevron-left','上个月');
   header.createSpan({text:month.replace('-','年')+'月',attr:{'aria-live':'polite'}});
   this.button(header,'',()=>shift(1),'gvkit-arrange-icon','chevron-right','下个月');
   const grid=calendar.createDiv('gvkit-arrange-calendar-days');
   for(const name of '一二三四五六日')grid.createSpan({text:name});
   for(let i=0;i<(weekday(`${month}-01`)+6)%7;i++)grid.createSpan();
   const count=Number(dateRange(`${month}-01`,'month').end.slice(8));
   for(let n=1;n<=count;n++) {
    const date=`${month}-${String(n).padStart(2,'0')}`;
    const button=this.button(grid,String(n),()=>{selected=date;paint();},'',undefined,date);
    button.setAttribute('aria-pressed',String(date===selected));
   }
  };
  paint();
  const feedback=modal.contentEl.createDiv({cls:'gvkit-arrange-date-feedback',attr:{role:'status','aria-live':'polite'}});
  feedback.hidden=true;
  const controls=modal.contentEl.createDiv('gvkit-arrange-calendar-controls');
  const cancel=this.button(controls,'取消',()=>modal.close());
  const done=this.button(controls,'完成',()=>{
   done.disabled=cancel.disabled=true;calendar.inert=true;
   feedback.hidden=false;feedback.textContent='正在保存…';feedback.removeClass('is-error');
   this.changeDate(selected);
   void this.flush().then(ok=>{
    if(ok) {modal.close();super.close();}
    else {
     feedback.textContent=this.batch?.failureMessage()||'未保存，请重试';feedback.addClass('is-error');
     if(this.batch)appendBatchFailures(feedback,this.batch.failureDetails());
     done.lastElementChild!.textContent='重试';done.setAttribute('aria-label','重试');
    }
   }).finally(()=>{done.disabled=cancel.disabled=false;calendar.inert=false;});
  },'mod-cta');
  modal.open();
 }
}
