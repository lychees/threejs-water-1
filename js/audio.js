// 合成环境音与音效：全程序化 WebAudio，无音频文件
// AudioContext 延迟到首次用户交互（点"出航"）后创建；M 键/HUD 按钮静音，状态存 sessionStorage

const MASTER_VOLUME = 0.8;
const MUTE_KEY = 'waters-muted';

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.muted = sessionStorage.getItem(MUTE_KEY) === '1';
  }

  // 首次用户交互时调用
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();

    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : MASTER_VOLUME;
    this.master.connect(this.ctx.destination);

    // 海浪底噪：棕噪声（低频积分白噪）循环 → 低通 → 增益
    const len = this.ctx.sampleRate * 3;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    this.oceanFilter = this.ctx.createBiquadFilter();
    this.oceanFilter.type = 'lowpass';
    this.oceanFilter.frequency.value = 500;
    this.oceanGain = this.ctx.createGain();
    this.oceanGain.gain.value = 0.15;
    src.connect(this.oceanFilter);
    this.oceanFilter.connect(this.oceanGain);
    this.oceanGain.connect(this.master);
    src.start();
  }

  // 每帧：天气强度 / 相机高度 / 水下程度 驱动海浪底噪
  setEnvironment(weatherStrength, camHeight, underT) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const gain = 0.12 + weatherStrength * 0.25 + Math.max(0, 3 - camHeight) * 0.015;
    this.oceanGain.gain.setTargetAtTime(gain, now, 0.25);
    const cutoff = (420 + weatherStrength * 520) * (1 - underT * 0.78); // 水下闷化
    this.oceanFilter.frequency.setTargetAtTime(cutoff, now, 0.25);
  }

  // 短促噪声爆发（炮声/水花/命中的基础件）
  _noiseBurst(dur, filterType, freq, peak) {
    if (!this.ctx) return;
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.value = peak;
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start();
  }

  _tone(freq, dur, peak, type = 'sine', when = 0) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + when;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(peak, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  cannon() {
    this._noiseBurst(0.35, 'lowpass', 300, 0.9);  // 炮口爆音
    this._tone(55, 0.3, 0.6);                     // 低频轰鸣
  }

  splash() {
    this._noiseBurst(0.25, 'highpass', 1500, 0.3);
  }

  hit() {
    this._noiseBurst(0.3, 'bandpass', 350, 0.7);
    this._tone(120, 0.2, 0.4, 'triangle');
  }

  pickup() {
    this._tone(660, 0.12, 0.3, 'triangle');
    this._tone(880, 0.18, 0.3, 'triangle', 0.1);
  }

  toggleMute() {
    this.muted = !this.muted;
    sessionStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    if (this.master) this.master.gain.value = this.muted ? 0 : MASTER_VOLUME;
    return this.muted;
  }
}
