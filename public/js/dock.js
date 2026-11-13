import { $, fmt, clamp, setText } from './util.js';

/** 底部操作列：輪到自己時的按鈕、加注滑桿、預先行動。 */
export class Dock {
  constructor({ send }) {
    this.send = send;
    this.s = null;
    this.legal = null;
    this.raiseTo = 0;
    this.pre = null;
    this.acted = false;
    this.preStage = null;
    this.turnKey = null;
    this.preTimer = null;

    this.slider = $('raise-slider');
    this.input = $('raise-input');

    $('btn-fold').addEventListener('click', () => this._act('fold'));
    $('btn-call').addEventListener('click', () => this._callOrCheck());
    $('btn-raise').addEventListener('click', () => this._raise());
    this.slider.addEventListener('input', () => {
      // 滑桿有步進，拖到底不一定剛好等於上限；貼齊上限才能全下
      const max = Number(this.slider.max);
      const value = Number(this.slider.value);
      this._setRaise(max - value < Number(this.slider.step) ? max : value);
    });
    this.input.addEventListener('change', () => this._setRaise(Number(this.input.value)));
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        this._setRaise(Number(this.input.value));
        this._raise();
      }
    });

    for (const button of document.querySelectorAll('.presets button')) {
      button.addEventListener('click', () => this._preset(button.dataset.frac));
    }
    for (const button of document.querySelectorAll('.pre')) {
      button.addEventListener('click', () => {
        this.pre = this.pre === button.dataset.pre ? null : button.dataset.pre;
        this._renderPre();
      });
    }

    $('btn-sit').addEventListener('click', () => {
      const hero = this._hero();
      if (hero) this.send({ t: 'sit', in: hero.sittingOut });
    });
    $('btn-rebuy').addEventListener('click', () => this.send({ t: 'rebuy' }));
    $('btn-show').addEventListener('click', () => this.send({ t: 'show' }));

    document.addEventListener('keydown', (event) => this._onKey(event));
  }

  _hero() {
    return this.s?.players.find((p) => p.id === this.s.you) || null;
  }

  /** 伺服器拒絕操作時把按鈕放回來。 */
  restore() {
    if (this.acted) {
      this.acted = false;
      this._renderActions();
    }
  }

  update(state) {
    this.s = state;
    const hero = this._hero();
    if (!hero) return;

    const key = state.legal ? state.turnId : null;
    if (key !== this.turnKey) {
      this.turnKey = key;
      this.acted = false;
      this.legal = state.legal;
      if (state.legal) this._setRaise(state.legal.minRaiseTo);
    }
    this.legal = state.legal;

    const stageKey = `${state.handNo}:${state.stage}`;
    if (stageKey !== this.preStage) {
      this.preStage = stageKey;
      this.pre = null;
    }

    this._renderInfo(hero, state);
    this._renderActions();
    this._renderPre();
    if (state.legal && this.pre) this._firePre();
  }

  _renderInfo(hero, state) {
    setText($('hand-name'), hero.inHand && !hero.folded ? state.yourHandName || '' : '');

    let note = '';
    if (hero.inHand && hero.folded && state.stage !== 'showdown') note = '已棄牌，等待下一手';
    else if (hero.allIn && state.stage !== 'showdown') note = '已全下';
    else if (!hero.inHand && state.stage !== 'waiting') {
      if (hero.stack === 0) note = '籌碼用完了';
      else if (hero.sittingOut) note = '離座中';
      else note = '下一手加入';
    }
    setText($('dock-note'), note);

    const sit = $('btn-sit');
    setText(sit, hero.sittingOut ? '回到牌桌' : '下手離座');
    sit.hidden = !state.started || hero.stack === 0;

    const rebuy = $('btn-rebuy');
    rebuy.hidden = !(state.settings.allowRebuy && hero.stack === 0 && !hero.inHand);
    setText(rebuy, `重新買入 ${fmt(state.settings.startingStack)}`);

    // 別人都棄牌、或自己棄牌後，可以選擇亮牌
    const results = state.results;
    const canShow = results && hero.inHand && hero.cards.length
      && (results.uncontested || hero.folded)
      && !hero.shown;
    $('btn-show').hidden = !canShow;
  }

  _renderActions() {
    const legal = this.legal;
    const actions = $('actions');
    const show = Boolean(legal) && !this.acted;
    if (actions.hidden === show) actions.hidden = !show;
    if (!show) return;

    $('btn-fold').hidden = legal.canCheck;
    const callLabel = $('btn-call').querySelector('span');
    setText(callLabel, legal.canCheck ? '過牌' : `跟注 ${fmt(legal.callAmount)}`);

    $('raise-box').hidden = !legal.canRaise;
    $('btn-raise').hidden = !legal.canRaise;
    if (!legal.canRaise) return;

    this.slider.min = legal.minRaiseTo;
    this.slider.max = legal.maxRaiseTo;
    this.slider.step = Math.min(this.s.settings.smallBlind, Math.max(1, legal.maxRaiseTo - legal.minRaiseTo));
    this._setRaise(this.raiseTo);
  }

  _renderPre() {
    const state = this.s;
    const hero = this._hero();
    const show = Boolean(hero && hero.inHand && !hero.folded && !hero.allIn && !state.legal
      && state.toActSeat !== null);
    const root = $('pre-actions');
    if (root.hidden === show) root.hidden = !show;
    for (const button of root.children) {
      button.classList.toggle('is-on', this.pre === button.dataset.pre);
    }
  }

  _firePre() {
    clearTimeout(this.preTimer);
    const pre = this.pre;
    const legal = this.legal;
    this.pre = null;
    this.preTimer = setTimeout(() => {
      if (pre === 'checkfold') this._act(legal.canCheck ? 'check' : 'fold');
      else this._act(legal.canCheck ? 'check' : 'call');
    }, 260);
  }

  _setRaise(value) {
    const legal = this.legal;
    if (!legal || !legal.canRaise) return;
    const amount = clamp(Math.round(value) || legal.minRaiseTo, legal.minRaiseTo, legal.maxRaiseTo);
    this.raiseTo = amount;
    this.slider.value = amount;
    this.input.value = amount;
    const span = legal.maxRaiseTo - legal.minRaiseTo;
    this.slider.style.setProperty('--fill', `${span ? ((amount - legal.minRaiseTo) / span) * 100 : 100}%`);
    const allIn = amount === legal.maxRaiseTo;
    const verb = allIn ? '全下' : this.s.currentBet === 0 ? '下注' : '加注到';
    setText($('btn-raise').querySelector('span'), `${verb} ${fmt(amount)}`);
  }

  _preset(frac) {
    const legal = this.legal;
    if (!legal || !legal.canRaise) return;
    if (frac === 'all') {
      this._setRaise(legal.maxRaiseTo);
      return;
    }
    // 底池加注：先算跟注後的底池大小，再乘上比例
    const pot = this.s.potOnTable + this.s.betsTotal + legal.callAmount;
    this._setRaise(this.s.currentBet + pot * Number(frac));
  }

  _act(action, amount) {
    if (!this.legal || this.acted) return;
    this.acted = true;
    this._renderActions();
    this.send({ t: 'action', action, amount });
  }

  _callOrCheck() {
    if (!this.legal) return;
    this._act(this.legal.canCheck ? 'check' : 'call');
  }

  _raise() {
    if (!this.legal?.canRaise) return;
    this._act('raise', this.raiseTo);
  }

  _onKey(event) {
    const target = event.target;
    const typing = target instanceof HTMLInputElement && target.type !== 'range';
    if (typing || event.ctrlKey || event.metaKey || event.altKey || !this.legal || this.acted) return;
    const key = event.key.toLowerCase();
    if (key === 'f' && !this.legal.canCheck) this._act('fold');
    else if (key === 'c') this._callOrCheck();
    else if (key === 'r') this._raise();
  }
}
