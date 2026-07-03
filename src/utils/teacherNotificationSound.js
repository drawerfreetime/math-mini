/**
 * 교사 대시보드 검수 알림음 — Web Audio API (외부 mp3 불필요)
 * 짧은 두 음(C5→E5) 벨. 연구실·교실 알림에 적합한 톤.
 */

let audioCtx = null;
let unlocked = false;

function getCtx() {
  if (typeof window === 'undefined') return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) audioCtx = new Ctx();
  return audioCtx;
}

/** 브라우저 자동재생 정책 — 교사가 화면을 한 번 클릭한 뒤부터 재생 가능 */
export function unlockTeacherNotificationAudio() {
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
  unlocked = true;
}

export function isTeacherNotificationAudioUnlocked() {
  return unlocked;
}

/**
 * @param {{ volume?: number }} [opts] volume 0~1 (기본 0.35)
 */
export function playTeacherNotificationSound(opts = {}) {
  const ctx = getCtx();
  if (!ctx || !unlocked) return;

  const volume = typeof opts.volume === 'number' ? opts.volume : 0.35;
  const now = ctx.currentTime;

  const playTone = (freq, start, duration) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.05);
  };

  playTone(523.25, now, 0.18);       // C5
  playTone(659.25, now + 0.2, 0.22); // E5
}
