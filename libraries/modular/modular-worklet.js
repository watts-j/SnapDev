/*
    modular-worklet.js

    AudioWorklet processors for the Snap! "Modular Synth" library.

    Each processor is one module. Its jacks are the node's inputs and
    outputs, its knobs are AudioParams.

    Signal conventions:
      - sound signals swing between -1 and +1
      - pitch and cutoff control signals are in semitones
      - level control signals are in percent of full
      - "gate" and "trigger" signals count as on above 0.5

    This file runs inside the audio rendering thread. It must not
    reference Snap! or the DOM.
*/

/*global AudioWorkletProcessor, registerProcessor, sampleRate*/

var TWO_PI = Math.PI * 2,
    MIDDLE_C = 261.6255653005986, // pitch 0 on an oscillator
    ON = 0.5;

// helpers

function channel(inputs, idx) {
    // answer the first channel of the idx-th input, or null if unpatched
    var inp = inputs[idx];
    return (inp && inp.length) ? inp[0] : null;
}

function param(parameters, name, i) {
    // answer the value of a (k-rate or a-rate) parameter at sample i
    var p = parameters[name];
    return p.length > 1 ? p[i] : p[0];
}

function polyBlep(t, dt) {
    // correction for a discontinuity at phase 0 of a saw / pulse wave
    if (t < dt) {
        t /= dt;
        return t + t - t * t - 1;
    }
    if (t > 1 - dt) {
        t = (t - 1) / dt;
        return t * t + t + t + 1;
    }
    return 0;
}

// oscillator

class OscillatorProcessor extends AudioWorkletProcessor {
    // inputs:  0 control (semitones added to the frequency)  1 trigger
    // outputs: 0 the chosen wave

    static get parameterDescriptors() {
        return [
            {name: 'wave', defaultValue: 0, minValue: 0, maxValue: 3,
                automationRate: 'k-rate'}, // 0 saw 1 square 2 triangle 3 sine
            {name: 'frequency', defaultValue: 440,
                minValue: 0.01, maxValue: 20000, automationRate: 'k-rate'},
            {name: 'pulse width', defaultValue: 0.5, minValue: 0,
                maxValue: 1, automationRate: 'k-rate'}
        ];
    }

    constructor() {
        super();
        this.phase = 0;
        this.lastTrig = 0;
        this.tri = 0; // leaky integrator state for the triangle
    }

    process(inputs, outputs, parameters) {
        var control = channel(inputs, 0),
            trig = channel(inputs, 1),
            out = outputs[0][0],
            n = out.length,
            wave = Math.round(param(parameters, 'wave', 0)),
            base = param(parameters, 'frequency', 0),
            pw = param(parameters, 'pulse width', 0),
            maxFreq = sampleRate * 0.45,
            i, freq, dt, t, v, tr;

        if (pw < 0.05) {pw = 0.05; }
        if (pw > 0.95) {pw = 0.95; }

        for (i = 0; i < n; i += 1) {
            freq = control ? base * Math.pow(2, control[i] / 12) : base;
            if (freq > maxFreq) {freq = maxFreq; }
            if (freq < 0.01) {freq = 0.01; }
            dt = freq / sampleRate;

            // trigger: restart the wave on a rising edge
            if (trig) {
                tr = trig[i];
                if (tr > ON && this.lastTrig <= ON) {
                    this.phase = 0;
                }
                this.lastTrig = tr;
            }

            t = this.phase;
            switch (wave) {
            case 1: // band-limited pulse
                v = (t < pw ? 1 : -1) + polyBlep(t, dt)
                    - polyBlep((t + 1 - pw) % 1, dt);
                break;
            case 2: // triangle: leaky integral of the 50% pulse
                this.tri = this.tri * (1 - dt * 0.5)
                    + ((t < 0.5 ? 1 : -1) + polyBlep(t, dt)
                        - polyBlep((t + 0.5) % 1, dt)) * 4 * dt;
                v = this.tri;
                break;
            case 3:
                v = Math.sin(TWO_PI * t);
                break;
            default: // band-limited sawtooth
                v = 2 * t - 1 - polyBlep(t, dt);
            }
            out[i] = v;

            this.phase += dt;
            if (this.phase >= 1) {this.phase -= 1; }
        }
        return true;
    }
}

// filter (24 dB low pass ladder)

class FilterProcessor extends AudioWorkletProcessor {
    // inputs:  0 input  1 control (semitones added to the cutoff)
    // outputs: 0 output (low pass or high pass)

    static get parameterDescriptors() {
        return [
            {name: 'type', defaultValue: 0, minValue: 0, maxValue: 1,
                automationRate: 'k-rate'}, // 0 low pass  1 high pass
            {name: 'cutoff', defaultValue: 1000, minValue: 10,
                maxValue: 20000, automationRate: 'k-rate'}, // Hz
            {name: 'resonance', defaultValue: 1, minValue: 0, maxValue: 1,
                automationRate: 'k-rate'}
        ];
    }

    constructor() {
        super();
        this.s1 = 0;
        this.s2 = 0;
        this.s3 = 0;
        this.s4 = 0;
    }

    process(inputs, outputs, parameters) {
        var audio = channel(inputs, 0),
            cv = channel(inputs, 1),
            out = outputs[0][0],
            n = out.length,
            fKnob = param(parameters, 'cutoff', 0),
            highPass = param(parameters, 'type', 0) > 0.5,
            k = param(parameters, 'resonance', 0) * 5, // feedback amount
            maxFc = Math.min(20000, sampleRate * 0.45),
            i, fc, g, G, S, u, x, v,
            s1 = this.s1, s2 = this.s2, s3 = this.s3, s4 = this.s4;

        // zero-delay-feedback ladder: four one-pole stages with feedback
        for (i = 0; i < n; i += 1) {
            fc = cv ? fKnob * Math.pow(2, cv[i] / 12) : fKnob;
            if (fc > maxFc) {fc = maxFc; }
            if (fc < 1) {fc = 1; }
            g = Math.tan(Math.PI * fc / sampleRate);
            G = g / (1 + g);

            x = audio ? audio[i] : 0;
            S = (1 - G) * (G * G * G * s1 + G * G * s2 + G * s3 + s4);
            u = (x - k * S) / (1 + k * G * G * G * G);
            u = 2 * Math.tanh(u / 2); // soft saturation bounds the feedback

            v = (u - s1) * G; u = v + s1; s1 = u + v;
            v = (u - s2) * G; u = v + s2; s2 = u + v;
            v = (u - s3) * G; u = v + s3; s3 = u + v;
            v = (u - s4) * G; u = v + s4; s4 = u + v;

            // high pass: what the low pass removed
            out[i] = highPass ? x - u : u;
        }
        this.s1 = s1; this.s2 = s2; this.s3 = s3; this.s4 = s4;
        return true;
    }
}

// volume

class VolumeProcessor extends AudioWorkletProcessor {
    // inputs:  0 input  1 control (percent added to the level)
    // outputs: 0 output

    static get parameterDescriptors() {
        return [
            {name: 'level', defaultValue: 1, minValue: 0, maxValue: 1,
                automationRate: 'k-rate'}
        ];
    }

    process(inputs, outputs, parameters) {
        var audio = channel(inputs, 0),
            cv = channel(inputs, 1),
            out = outputs[0][0],
            n = out.length,
            knob = param(parameters, 'level', 0),
            i, a;

        for (i = 0; i < n; i += 1) {
            a = knob;
            if (cv) {a += cv[i] / 100; }
            if (a < 0) {a = 0; }
            if (a > 1) {a = 1; }
            out[i] = audio ? audio[i] * a : 0;
        }
        return true;
    }
}

// envelope

class EnvelopeProcessor extends AudioWorkletProcessor {
    // inputs:  0 gate
    // outputs: 0 output (0 .. amount)

    static get parameterDescriptors() {
        return [
            {name: 'attack', defaultValue: 0.01, minValue: 0.001,
                maxValue: 20, automationRate: 'k-rate'},   // seconds
            {name: 'decay', defaultValue: 0.3, minValue: 0.001,
                maxValue: 20, automationRate: 'k-rate'},   // seconds
            {name: 'sustain', defaultValue: 0.7, minValue: 0, maxValue: 1,
                automationRate: 'k-rate'},                 // fraction
            {name: 'release', defaultValue: 0.5, minValue: 0.001,
                maxValue: 20, automationRate: 'k-rate'},   // seconds
            {name: 'amount', defaultValue: 1, minValue: 0, maxValue: 100,
                automationRate: 'k-rate'},                 // output peak
            {name: 'gate', defaultValue: 0, minValue: 0, maxValue: 1,
                automationRate: 'k-rate'}                  // set by block
        ];
    }

    constructor() {
        super();
        this.level = 0;        // 0 .. 1
        this.stage = 'idle';   // idle | attack | decay | sustain | release
        this.wasHeld = false;
    }

    process(inputs, outputs, parameters) {
        var gateIn = channel(inputs, 0),
            out = outputs[0][0],
            n = out.length,
            attack = param(parameters, 'attack', 0),
            decay = param(parameters, 'decay', 0),
            sustain = param(parameters, 'sustain', 0),
            release = param(parameters, 'release', 0),
            amount = param(parameters, 'amount', 0),
            manual = param(parameters, 'gate', 0) > ON,
            // per-sample coefficients; a stage settles in about its time
            aStep = 1 / (attack * sampleRate),
            dCoef = 1 - Math.exp(-4 / (decay * sampleRate)),
            rCoef = 1 - Math.exp(-4 / (release * sampleRate)),
            i, held;

        for (i = 0; i < n; i += 1) {
            held = manual || (gateIn ? gateIn[i] > ON : false);

            if (held && !this.wasHeld) {
                this.stage = 'attack';
            } else if (!held && this.wasHeld) {
                this.stage = 'release';
            }
            this.wasHeld = held;

            switch (this.stage) {
            case 'attack':
                this.level += aStep;
                if (this.level >= 1) {
                    this.level = 1;
                    this.stage = 'decay';
                }
                break;
            case 'decay':
                this.level += (sustain - this.level) * dCoef;
                if (Math.abs(this.level - sustain) < 0.0005) {
                    this.level = sustain;
                    this.stage = 'sustain';
                }
                break;
            case 'sustain':
                this.level = sustain;
                break;
            case 'release':
                this.level += (0 - this.level) * rCoef;
                if (this.level < 0.0005) {
                    this.level = 0;
                    this.stage = 'idle';
                }
                break;
            default: // idle
                this.level = 0;
            }

            out[i] = this.level * amount;
        }
        return true;
    }
}

// wobble (low frequency oscillator)

class WobbleProcessor extends AudioWorkletProcessor {
    // inputs:  0 trigger
    // outputs: 0 output (-amount .. +amount)

    static get parameterDescriptors() {
        return [
            {name: 'wave', defaultValue: 3, minValue: 0, maxValue: 3,
                automationRate: 'k-rate'}, // 0 saw 1 square 2 triangle 3 sine
            {name: 'speed', defaultValue: 5, minValue: 0.01, maxValue: 500,
                automationRate: 'k-rate'}, // Hz
            {name: 'amount', defaultValue: 1, minValue: 0, maxValue: 100,
                automationRate: 'k-rate'}
        ];
    }

    constructor() {
        super();
        this.phase = 0;
        this.lastRestart = 0;
    }

    process(inputs, outputs, parameters) {
        var restart = channel(inputs, 0),
            out = outputs[0][0],
            n = out.length,
            wave = Math.round(param(parameters, 'wave', 0)),
            dt = param(parameters, 'speed', 0) / sampleRate,
            amount = param(parameters, 'amount', 0),
            i, t, r, v;

        for (i = 0; i < n; i += 1) {
            if (restart) {
                r = restart[i];
                if (r > ON && this.lastRestart <= ON) {
                    this.phase = 0;
                }
                this.lastRestart = r;
            }
            t = this.phase;
            switch (wave) {
            case 1: // square
                v = t < 0.5 ? 1 : -1;
                break;
            case 2: // triangle
                v = t < 0.5 ? 4 * t - 1 : 3 - 4 * t;
                break;
            case 3: // sine
                v = Math.sin(TWO_PI * t);
                break;
            default: // saw
                v = 2 * t - 1;
            }
            out[i] = v * amount;
            this.phase += dt;
            if (this.phase >= 1) {this.phase -= 1; }
        }
        return true;
    }
}

// delay (echo)

class DelayProcessor extends AudioWorkletProcessor {
    // inputs:  0 input
    // outputs: 0 output

    static get parameterDescriptors() {
        return [
            {name: 'time', defaultValue: 0.5, minValue: 0.001, maxValue: 5,
                automationRate: 'k-rate'},      // seconds
            {name: 'repeats', defaultValue: 0.4, minValue: 0, maxValue: 0.95,
                automationRate: 'k-rate'},      // feedback, fraction
            {name: 'blend', defaultValue: 0.5, minValue: 0, maxValue: 1,
                automationRate: 'k-rate'}       // echo share, fraction
        ];
    }

    constructor() {
        super();
        this.size = Math.ceil(sampleRate * 5) + 1;
        this.buffer = new Float32Array(this.size);
        this.write = 0;
    }

    process(inputs, outputs, parameters) {
        var audio = channel(inputs, 0),
            out = outputs[0][0],
            n = out.length,
            delay = Math.max(1, Math.round(
                param(parameters, 'time', 0) * sampleRate)),
            fb = param(parameters, 'repeats', 0),
            blend = param(parameters, 'blend', 0),
            i, x, read, echo;

        for (i = 0; i < n; i += 1) {
            x = audio ? audio[i] : 0;
            read = this.write - delay;
            if (read < 0) {read += this.size; }
            echo = this.buffer[read];
            this.buffer[this.write] = x + echo * fb;
            this.write += 1;
            if (this.write >= this.size) {this.write = 0; }
            out[i] = x * (1 - blend) + echo * blend;
        }
        return true;
    }
}

// noise / random

class NoiseProcessor extends AudioWorkletProcessor {
    // inputs:  0 trigger (new random step)
    // outputs: 0 output

    static get parameterDescriptors() {
        return [
            {name: 'kind', defaultValue: 0, minValue: 0, maxValue: 1,
                automationRate: 'k-rate'},      // 0 white  1 random steps
            {name: 'speed', defaultValue: 8, minValue: 0.01, maxValue: 500,
                automationRate: 'k-rate'},      // steps per second
            {name: 'amount', defaultValue: 1, minValue: 0, maxValue: 100,
                automationRate: 'k-rate'}
        ];
    }

    constructor() {
        super();
        this.held = 0;
        this.counter = 0;
        this.lastTrig = 0;
    }

    process(inputs, outputs, parameters) {
        var trig = channel(inputs, 0),
            out = outputs[0][0],
            n = out.length,
            kind = Math.round(param(parameters, 'kind', 0)),
            period = sampleRate / param(parameters, 'speed', 0),
            amount = param(parameters, 'amount', 0),
            i, tr;

        for (i = 0; i < n; i += 1) {
            if (kind === 0) {
                out[i] = (Math.random() * 2 - 1) * amount;
                continue;
            }
            this.counter += 1;
            if (this.counter >= period) {
                this.counter = 0;
                this.held = Math.random() * 2 - 1;
            }
            if (trig) {
                tr = trig[i];
                if (tr > ON && this.lastTrig <= ON) {
                    this.held = Math.random() * 2 - 1;
                    this.counter = 0;
                }
                this.lastTrig = tr;
            }
            out[i] = this.held * amount;
        }
        return true;
    }
}

// ring modulator

class RingProcessor extends AudioWorkletProcessor {
    // inputs:  0 input  1 input 2
    // outputs: 0 output

    static get parameterDescriptors() {
        return [];
    }

    process(inputs, outputs) {
        var a = channel(inputs, 0),
            b = channel(inputs, 1),
            out = outputs[0][0],
            n = out.length,
            i;
        for (i = 0; i < n; i += 1) {
            out[i] = (a ? a[i] : 0) * (b ? b[i] : 0);
        }
        return true;
    }
}

// wavefolder, also used by the waveform processor

function fold(y) {
    // reflect a value back into -1 .. +1, as many times as needed
    var t = (y + 1) / 4;
    return 4 * Math.abs(t - Math.floor(t + 0.5)) - 1;
}

class FoldProcessor extends AudioWorkletProcessor {
    // inputs:  0 input  1 control (percent added to fold)
    // outputs: 0 output

    static get parameterDescriptors() {
        return [
            {name: 'fold', defaultValue: 0, minValue: 0, maxValue: 1,
                automationRate: 'k-rate'}       // fraction, 1 = 8x gain
        ];
    }

    process(inputs, outputs, parameters) {
        var audio = channel(inputs, 0),
            cv = channel(inputs, 1),
            out = outputs[0][0],
            n = out.length,
            knob = param(parameters, 'fold', 0),
            i, f, gain;
        for (i = 0; i < n; i += 1) {
            f = knob;
            if (cv) {f += cv[i] / 100; }
            if (f < 0) {f = 0; }
            if (f > 1) {f = 1; }
            gain = 1 + f * 7;
            out[i] = fold((audio ? audio[i] : 0) * gain);
        }
        return true;
    }
}

// audio divider (sub-octave square)

class DividerProcessor extends AudioWorkletProcessor {
    // inputs:  0 input
    // outputs: 0 output

    static get parameterDescriptors() {
        return [
            {name: 'octaves', defaultValue: 1, minValue: 1, maxValue: 3,
                automationRate: 'k-rate'}
        ];
    }

    constructor() {
        super();
        this.last = 0;
        this.count = 0;
        this.state = 1;
    }

    process(inputs, outputs, parameters) {
        var audio = channel(inputs, 0),
            out = outputs[0][0],
            n = out.length,
            every = Math.pow(2, Math.round(param(parameters, 'octaves', 0)) - 1),
            i, x;
        for (i = 0; i < n; i += 1) {
            x = audio ? audio[i] : 0;
            if (x > 0 && this.last <= 0) {
                this.count += 1;
                if (this.count >= every) {
                    this.count = 0;
                    this.state = -this.state;
                }
            }
            this.last = x;
            out[i] = audio ? this.state : 0;
        }
        return true;
    }
}

// slew limiter

class SlewProcessor extends AudioWorkletProcessor {
    // inputs:  0 input
    // outputs: 0 output

    static get parameterDescriptors() {
        return [
            {name: 'rise', defaultValue: 0.1, minValue: 0.001, maxValue: 20,
                automationRate: 'k-rate'},      // seconds
            {name: 'fall', defaultValue: 0.1, minValue: 0.001, maxValue: 20,
                automationRate: 'k-rate'}       // seconds
        ];
    }

    constructor() {
        super();
        this.level = 0;
    }

    process(inputs, outputs, parameters) {
        var cv = channel(inputs, 0),
            out = outputs[0][0],
            n = out.length,
            up = 1 - Math.exp(-4 / (param(parameters, 'rise', 0) * sampleRate)),
            down = 1 - Math.exp(-4 / (param(parameters, 'fall', 0) * sampleRate)),
            i, target;
        for (i = 0; i < n; i += 1) {
            target = cv ? cv[i] : 0;
            this.level += (target - this.level) *
                (target > this.level ? up : down);
            out[i] = this.level;
        }
        return true;
    }
}

// trigger divider

class TriggerDividerProcessor extends AudioWorkletProcessor {
    // inputs:  0 trigger
    // outputs: 0 output (every n-th gate passes through)

    static get parameterDescriptors() {
        return [
            {name: 'divide by', defaultValue: 2, minValue: 1, maxValue: 16,
                automationRate: 'k-rate'}
        ];
    }

    constructor() {
        super();
        this.last = 0;
        this.count = 0;
        this.pass = false;
    }

    process(inputs, outputs, parameters) {
        var trig = channel(inputs, 0),
            out = outputs[0][0],
            n = out.length,
            every = Math.round(param(parameters, 'divide by', 0)),
            i, tr;
        for (i = 0; i < n; i += 1) {
            tr = trig ? trig[i] : 0;
            if (tr > ON && this.last <= ON) {
                this.count += 1;
                if (this.count >= every) {
                    this.count = 0;
                    this.pass = true;
                }
            } else if (tr <= ON && this.last > ON) {
                this.pass = false;
            }
            this.last = tr;
            out[i] = this.pass ? 1 : 0;
        }
        return true;
    }
}

// step sequencers: a shared base that walks steps on an internal
// clock (tempo in steps per minute) or on a rising edge at the clock
// input, and takes its step data as text through the message port

class StepProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            {name: 'tempo', defaultValue: 120, minValue: 1, maxValue: 1000,
                automationRate: 'k-rate'}       // steps per minute
        ];
    }

    constructor() {
        super();
        this.steps = [];
        this.step = -1;
        this.counter = 0;
        this.lastClock = 0;
        this.clockHigh = false;
        this.port.onmessage = event => {
            this.steps = this.parse(String(event.data.text || ''));
            this.step = -1;
            this.counter = 0;
        };
    }

    advance() {
        if (this.steps.length) {
            this.step = (this.step + 1) % this.steps.length;
        }
    }

    process(inputs, outputs, parameters) {
        var clock = channel(inputs, 0),
            out = outputs[0][0],
            n = out.length,
            period = sampleRate * 60 / param(parameters, 'tempo', 0),
            i, c, phase;
        for (i = 0; i < n; i += 1) {
            if (clock) {
                c = clock[i];
                if (c > ON && this.lastClock <= ON) {
                    this.advance();
                }
                this.lastClock = c;
                this.clockHigh = c > ON;
                out[i] = this.value(this.clockHigh);
            } else {
                if (this.counter <= 0) {
                    this.advance();
                    this.counter = period;
                }
                phase = 1 - this.counter / period; // 0 .. 1 within the step
                this.counter -= 1;
                out[i] = this.value(phase < 0.5);
            }
        }
        return true;
    }
}

class TriggerSequencerProcessor extends StepProcessor {
    // inputs:  0 clock
    // outputs: 0 output (gate)

    parse(text) {
        return text.replace(/\s+/g, '').split('').map(ch =>
            ch === 'x' || ch === 'X' || ch === '1' ? 1 : 0);
    }

    value(high) {
        return this.step >= 0 && this.steps[this.step] && high ? 1 : 0;
    }
}

class SequencerProcessor extends StepProcessor {
    // inputs:  0 clock
    // outputs: 0 output (pitch in semitones; MIDI note 69 is 0)

    parse(text) {
        return text.split(/[\s,]+/).filter(item => item !== '')
            .map(item => +item - 69).filter(num => !isNaN(num));
    }

    value() {
        return this.step >= 0 ? this.steps[this.step] : 0;
    }
}

registerProcessor('modular-oscillator', OscillatorProcessor);
registerProcessor('modular-filter', FilterProcessor);
registerProcessor('modular-volume', VolumeProcessor);
registerProcessor('modular-envelope', EnvelopeProcessor);
registerProcessor('modular-wobble', WobbleProcessor);
registerProcessor('modular-delay', DelayProcessor);
registerProcessor('modular-noise', NoiseProcessor);
registerProcessor('modular-ring', RingProcessor);
registerProcessor('modular-fold', FoldProcessor);
registerProcessor('modular-divider', DividerProcessor);
registerProcessor('modular-slew', SlewProcessor);
registerProcessor('modular-trigger-divider', TriggerDividerProcessor);
registerProcessor('modular-trigger-sequencer', TriggerSequencerProcessor);
registerProcessor('modular-sequencer', SequencerProcessor);
