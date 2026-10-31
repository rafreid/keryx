/**
 * Notification sounds synthesised with the Web Audio API (the way hermes-workspace does it): no audio
 * files, a short distinct phrase per level, nothing plays until the user turned sounds on.
 */
const NOTE = { C5: 523.25, E5: 659.25, G5: 783.99, C6: 1046.5, A4: 440, G4: 392, E4: 329.63, C4: 261.63 }

/** The phrase for a toast level: [frequency, start offset s, length s] per note. Pure, unit-tested. */
export function toneFor(level) {
  switch (level) {
    case 'ok': return { type: 'sine', notes: [[NOTE.E5, 0, 0.12], [NOTE.G5, 0.12, 0.12], [NOTE.C6, 0.24, 0.2]] }      // rising: Hermes is done
    case 'err': return { type: 'square', notes: [[NOTE.A4, 0, 0.1], [NOTE.E4, 0.14, 0.1], [NOTE.C4, 0.28, 0.25]] }   // falling: something failed
    case 'warn': return { type: 'triangle', notes: [[NOTE.G4, 0, 0.14], [NOTE.G4, 0.2, 0.14]] }                      // two knocks: look here
    default: return { type: 'sine', notes: [[NOTE.C5, 0, 0.1]] }                                                      // a tick: something started
  }
}

let ctx = null
/** Browsers only allow audio after a user gesture: call this from the toggle's click handler. */
export function unlockAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return false
    ctx = ctx || new AC()
    if (ctx.state === 'suspended') ctx.resume()
    return true
  } catch { return false }
}

export function playSound(level, volume = 0.08) {
  if (!ctx) return false
  try {
    const { type, notes } = toneFor(level)
    const t0 = ctx.currentTime + 0.01
    for (const [freq, at, len] of notes) {
      const osc = ctx.createOscillator(), gain = ctx.createGain()
      osc.type = type; osc.frequency.value = freq
      gain.gain.setValueAtTime(0, t0 + at)
      gain.gain.linearRampToValueAtTime(volume, t0 + at + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0005, t0 + at + len)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t0 + at); osc.stop(t0 + at + len + 0.02)
    }
    return true
  } catch { return false }
}
