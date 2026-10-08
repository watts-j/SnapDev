/*
    modular-worklet.js

    AudioWorklet processors for the Snap! "Modular Synth" library.

    Each processor is one module. Its jacks are the node's inputs and
    outputs, its knobs are AudioParams.

    Signal conventions:
      - sound signals swing between -1 and +1
      - pitch and cutoff control signals are in semitones
      - level control signals are a fraction of full, 0 to 1
      - "key held" and "trigger" signals count as on above 0.5

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
    // inputs:  0 pitch (semitones)  1 trigger
    // outputs: 0 saw  1 square  2 triangle  3 sine

    static get parameterDescriptors() {
        return [
            {name: 'octave', defaultValue: 0, minValue: -4, maxValue: 4,
                automationRate: 'k-rate'},
            {name: 'tune', defaultValue: 0, minValue: -48, maxValue: 48,
                automationRate: 'k-rate'},        // semitones
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
        var pitch = channel(inputs, 0),
            trig = channel(inputs, 1),
            saw = outputs[0][0],
            sqr = outputs[1][0],
            tri = outputs[2][0],
            sin = outputs[3][0],
            n = saw.length,
            base = param(parameters, 'octave', 0) * 12
                + param(parameters, 'tune', 0),
            pw = param(parameters, 'pulse width', 0),
            maxFreq = sampleRate * 0.45,
            i, semis, freq, dt, t, s, p, tr;

        if (pw < 0.05) {pw = 0.05; }
        if (pw > 0.95) {pw = 0.95; }

        for (i = 0; i < n; i += 1) {
            semis = base;
            if (pitch) {semis += pitch[i]; }
            freq = MIDDLE_C * Math.pow(2, semis / 12);
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

            // band-limited sawtooth
            s = 2 * t - 1 - polyBlep(t, dt);
            saw[i] = s;

            // band-limited pulse
            p = (t < pw ? 1 : -1) + polyBlep(t, dt)
                - polyBlep((t + 1 - pw) % 1, dt);
            sqr[i] = p;

            // triangle: leaky integral of the 50% pulse
            this.tri = this.tri * (1 - dt * 0.5)
                + ((t < 0.5 ? 1 : -1) + polyBlep(t, dt)
                    - polyBlep((t + 0.5) % 1, dt)) * 4 * dt;
            tri[i] = this.tri;

            sin[i] = Math.sin(TWO_PI * t);

            this.phase += dt;
            if (this.phase >= 1) {this.phase -= 1; }
        }
        return true;
    }
}

// filter (24 dB low pass ladder)

class FilterProcessor extends AudioWorkletProcessor {
    // inputs:  0 input  1 cutoff (semitones)
    // outputs: 0 output

    static get parameterDescriptors() {
        return [
            {name: 'cutoff', defaultValue: 1000, minValue: 10,
                maxValue: 20000, automationRate: 'k-rate'}, // Hz
            {name: 'resonance', defaultValue: 0, minValue: 0, maxValue: 1,
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

            out[i] = u;
        }
        this.s1 = s1; this.s2 = s2; this.s3 = s3; this.s4 = s4;
        return true;
    }
}

// volume

class VolumeProcessor extends AudioWorkletProcessor {
    // inputs:  0 input  1 level (fraction of full)
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
            if (cv) {a += cv[i]; }
            if (a < 0) {a = 0; }
            if (a > 1) {a = 1; }
            out[i] = audio ? audio[i] * a : 0;
        }
        return true;
    }
}

// envelope

class EnvelopeProcessor extends AudioWorkletProcessor {
    // inputs:  0 key held
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
            {name: 'key held', defaultValue: 0, minValue: 0, maxValue: 1,
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
        var keyIn = channel(inputs, 0),
            out = outputs[0][0],
            n = out.length,
            attack = param(parameters, 'attack', 0),
            decay = param(parameters, 'decay', 0),
            sustain = param(parameters, 'sustain', 0),
            release = param(parameters, 'release', 0),
            amount = param(parameters, 'amount', 0),
            manual = param(parameters, 'key held', 0) > ON,
            // per-sample coefficients; a stage settles in about its time
            aStep = 1 / (attack * sampleRate),
            dCoef = 1 - Math.exp(-4 / (decay * sampleRate)),
            rCoef = 1 - Math.exp(-4 / (release * sampleRate)),
            i, held;

        for (i = 0; i < n; i += 1) {
            held = manual || (keyIn ? keyIn[i] > ON : false);

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
            {name: 'wave', defaultValue: 0, minValue: 0, maxValue: 3,
                automationRate: 'k-rate'}, // 0 sine 1 triangle 2 saw 3 square
            {name: 'speed', defaultValue: 2, minValue: 0.01, maxValue: 500,
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
            case 1:
                v = t < 0.5 ? 4 * t - 1 : 3 - 4 * t;
                break;
            case 2:
                v = 2 * t - 1;
                break;
            case 3:
                v = t < 0.5 ? 1 : -1;
                break;
            default:
                v = Math.sin(TWO_PI * t);
            }
            out[i] = v * amount;
            this.phase += dt;
            if (this.phase >= 1) {this.phase -= 1; }
        }
        return true;
    }
}

registerProcessor('modular-oscillator', OscillatorProcessor);
registerProcessor('modular-filter', FilterProcessor);
registerProcessor('modular-volume', VolumeProcessor);
registerProcessor('modular-envelope', EnvelopeProcessor);
registerProcessor('modular-wobble', WobbleProcessor);
