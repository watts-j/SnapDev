/*
    modular-worklet.js

    AudioWorklet processors for the Snap! "Modular Synth" library,
    modelled after modules of the Doepfer A-100 system.

    Signal conventions (approximating the A-100):
      - audio signals swing between -5 and +5 (volts)
      - pitch control voltages follow 1 V per octave
      - gates are "high" above 2.5 V
      - the ADSR envelope rises to +8 V

    Each processor is one module. Its patch jacks are the node's
    inputs and outputs, its knobs are AudioParams.

    This file runs inside the audio rendering thread. It must not
    reference Snap! or the DOM.
*/

/*global AudioWorkletProcessor, registerProcessor, sampleRate*/

var TWO_PI = Math.PI * 2,
    MIDDLE_C = 261.6255653005986, // 0 V on a VCO's pitch input
    AUDIO_LEVEL = 5,
    GATE_THRESHOLD = 2.5,
    ENV_PEAK = 8;

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

// VCO (after the A-110 "Standard VCO")

class VCOProcessor extends AudioWorkletProcessor {
    // inputs:  0 cv1 (1 V/oct)  1 cv2  2 pw cv  3 sync
    // outputs: 0 saw  1 square  2 triangle  3 sine

    static get parameterDescriptors() {
        return [
            {name: 'range', defaultValue: 0, minValue: -4, maxValue: 4,
                automationRate: 'k-rate'},        // octaves
            {name: 'tune', defaultValue: 0, minValue: -12, maxValue: 12,
                automationRate: 'k-rate'},        // semitones
            {name: 'pulse width', defaultValue: 0.5, minValue: 0,
                maxValue: 1, automationRate: 'k-rate'},
            {name: 'cv2 level', defaultValue: 0, minValue: 0, maxValue: 1,
                automationRate: 'k-rate'},
            {name: 'pw cv level', defaultValue: 0, minValue: 0,
                maxValue: 1, automationRate: 'k-rate'}
        ];
    }

    constructor() {
        super();
        this.phase = 0;
        this.lastSync = 0;
        this.tri = 0; // leaky integrator state for the triangle
    }

    process(inputs, outputs, parameters) {
        var cv1 = channel(inputs, 0),
            cv2 = channel(inputs, 1),
            pwcv = channel(inputs, 2),
            sync = channel(inputs, 3),
            saw = outputs[0][0],
            sqr = outputs[1][0],
            tri = outputs[2][0],
            sin = outputs[3][0],
            n = saw.length,
            range = param(parameters, 'range', 0),
            tune = param(parameters, 'tune', 0),
            pwKnob = param(parameters, 'pulse width', 0),
            cv2Level = param(parameters, 'cv2 level', 0),
            pwLevel = param(parameters, 'pw cv level', 0),
            baseVolts = range + tune / 12,
            maxFreq = sampleRate * 0.45,
            i, volts, freq, dt, pw, t, s, p, sy;

        for (i = 0; i < n; i += 1) {
            volts = baseVolts;
            if (cv1) {volts += cv1[i]; }
            if (cv2) {volts += cv2[i] * cv2Level; }
            freq = MIDDLE_C * Math.pow(2, volts);
            if (freq > maxFreq) {freq = maxFreq; }
            if (freq < 0.01) {freq = 0.01; }
            dt = freq / sampleRate;

            // hard sync: reset the phase on a rising edge
            if (sync) {
                sy = sync[i];
                if (sy > 0 && this.lastSync <= 0) {
                    this.phase = 0;
                }
                this.lastSync = sy;
            }

            pw = pwKnob;
            if (pwcv) {pw += pwcv[i] * pwLevel / AUDIO_LEVEL; }
            if (pw < 0.05) {pw = 0.05; }
            if (pw > 0.95) {pw = 0.95; }

            t = this.phase;

            // band-limited sawtooth
            s = 2 * t - 1 - polyBlep(t, dt);
            saw[i] = s * AUDIO_LEVEL;

            // band-limited pulse
            p = (t < pw ? 1 : -1) + polyBlep(t, dt)
                - polyBlep((t + 1 - pw) % 1, dt);
            sqr[i] = p * AUDIO_LEVEL;

            // triangle: leaky integral of the 50% pulse
            this.tri = this.tri * (1 - dt * 0.5)
                + ((t < 0.5 ? 1 : -1) + polyBlep(t, dt)
                    - polyBlep((t + 0.5) % 1, dt)) * 4 * dt;
            tri[i] = this.tri * AUDIO_LEVEL;

            sin[i] = Math.sin(TWO_PI * t) * AUDIO_LEVEL;

            this.phase += dt;
            if (this.phase >= 1) {this.phase -= 1; }
        }
        return true;
    }
}

// VCF (after the A-120 "24 dB Low Pass" ladder filter)

class VCFProcessor extends AudioWorkletProcessor {
    // inputs:  0 audio  1 cv1 (1 V/oct)  2 cv2  3 cv3
    // outputs: 0 lowpass

    static get parameterDescriptors() {
        return [
            {name: 'frequency', defaultValue: 1000, minValue: 10,
                maxValue: 20000, automationRate: 'k-rate'}, // Hz
            {name: 'resonance', defaultValue: 0, minValue: 0, maxValue: 1,
                automationRate: 'k-rate'},
            {name: 'audio level', defaultValue: 1, minValue: 0,
                maxValue: 1, automationRate: 'k-rate'},
            {name: 'cv2 level', defaultValue: 0, minValue: 0, maxValue: 1,
                automationRate: 'k-rate'},
            {name: 'cv3 level', defaultValue: 0, minValue: 0, maxValue: 1,
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
            cv1 = channel(inputs, 1),
            cv2 = channel(inputs, 2),
            cv3 = channel(inputs, 3),
            out = outputs[0][0],
            n = out.length,
            fKnob = param(parameters, 'frequency', 0),
            res = param(parameters, 'resonance', 0),
            level = param(parameters, 'audio level', 0),
            cv2Level = param(parameters, 'cv2 level', 0),
            cv3Level = param(parameters, 'cv3 level', 0),
            k = res * 5, // feedback; above 4 the filter self-oscillates
            maxFc = Math.min(20000, sampleRate * 0.45),
            i, volts, fc, g, G, S, u, x, v,
            s1 = this.s1, s2 = this.s2, s3 = this.s3, s4 = this.s4;

        // zero-delay-feedback ladder: four one-pole stages with feedback
        for (i = 0; i < n; i += 1) {
            volts = 0;
            if (cv1) {volts += cv1[i]; }
            if (cv2) {volts += cv2[i] * cv2Level; }
            if (cv3) {volts += cv3[i] * cv3Level; }
            fc = fKnob * Math.pow(2, volts);
            if (fc > maxFc) {fc = maxFc; }
            if (fc < 1) {fc = 1; }
            g = Math.tan(Math.PI * fc / sampleRate);
            G = g / (1 + g);

            x = audio ? audio[i] * level / AUDIO_LEVEL : 0;
            S = (1 - G) * (G * G * G * s1 + G * G * s2 + G * s3 + s4);
            u = (x - k * S) / (1 + k * G * G * G * G);
            u = 2 * Math.tanh(u / 2); // soft saturation bounds the feedback

            v = (u - s1) * G; u = v + s1; s1 = u + v;
            v = (u - s2) * G; u = v + s2; s2 = u + v;
            v = (u - s3) * G; u = v + s3; s3 = u + v;
            v = (u - s4) * G; u = v + s4; s4 = u + v;

            out[i] = u * AUDIO_LEVEL;
        }
        this.s1 = s1; this.s2 = s2; this.s3 = s3; this.s4 = s4;
        return true;
    }
}

// VCA (after the A-130 "Linear VCA")

class VCAProcessor extends AudioWorkletProcessor {
    // inputs:  0 audio 1  1 audio 2  2 cv1  3 cv2
    // outputs: 0 out

    static get parameterDescriptors() {
        return [
            {name: 'gain', defaultValue: 0, minValue: 0, maxValue: 1,
                automationRate: 'k-rate'},
            {name: 'audio 1 level', defaultValue: 1, minValue: 0,
                maxValue: 1, automationRate: 'k-rate'},
            {name: 'audio 2 level', defaultValue: 1, minValue: 0,
                maxValue: 1, automationRate: 'k-rate'},
            {name: 'cv2 level', defaultValue: 0, minValue: 0, maxValue: 1,
                automationRate: 'k-rate'}
        ];
    }

    process(inputs, outputs, parameters) {
        var in1 = channel(inputs, 0),
            in2 = channel(inputs, 1),
            cv1 = channel(inputs, 2),
            cv2 = channel(inputs, 3),
            out = outputs[0][0],
            n = out.length,
            gain = param(parameters, 'gain', 0),
            l1 = param(parameters, 'audio 1 level', 0),
            l2 = param(parameters, 'audio 2 level', 0),
            cv2Level = param(parameters, 'cv2 level', 0),
            i, a, x;

        for (i = 0; i < n; i += 1) {
            a = gain;
            if (cv1) {a += cv1[i] / AUDIO_LEVEL; } // unity gain at +5 V
            if (cv2) {a += cv2[i] * cv2Level / AUDIO_LEVEL; }
            if (a < 0) {a = 0; }
            if (a > 2) {a = 2; }
            x = 0;
            if (in1) {x += in1[i] * l1; }
            if (in2) {x += in2[i] * l2; }
            out[i] = x * a;
        }
        return true;
    }
}

// ADSR (after the A-140 "ADSR" envelope generator)

class ADSRProcessor extends AudioWorkletProcessor {
    // inputs:  0 gate  1 retrigger
    // outputs: 0 envelope  1 inverted

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
            {name: 'gate', defaultValue: 0, minValue: 0, maxValue: 1,
                automationRate: 'k-rate'}                  // manual gate
        ];
    }

    constructor() {
        super();
        this.level = 0;        // 0 .. 1
        this.stage = 'idle';   // idle | attack | decay | sustain | release
        this.gateWasHigh = false;
        this.lastRetrig = 0;
    }

    process(inputs, outputs, parameters) {
        var gateIn = channel(inputs, 0),
            retrig = channel(inputs, 1),
            env = outputs[0][0],
            inv = outputs[1][0],
            n = env.length,
            attack = param(parameters, 'attack', 0),
            decay = param(parameters, 'decay', 0),
            sustain = param(parameters, 'sustain', 0),
            release = param(parameters, 'release', 0),
            manual = param(parameters, 'gate', 0) > 0.5,
            // per-sample coefficients; a stage settles in about its time
            aStep = 1 / (attack * sampleRate),
            dCoef = 1 - Math.exp(-4 / (decay * sampleRate)),
            rCoef = 1 - Math.exp(-4 / (release * sampleRate)),
            i, high, r;

        for (i = 0; i < n; i += 1) {
            high = manual || (gateIn ? gateIn[i] > GATE_THRESHOLD : false);

            if (high && !this.gateWasHigh) {
                this.stage = 'attack';
            } else if (!high && this.gateWasHigh) {
                this.stage = 'release';
            }
            this.gateWasHigh = high;

            if (retrig) {
                r = retrig[i];
                if (r > GATE_THRESHOLD && this.lastRetrig <= GATE_THRESHOLD
                        && high) {
                    this.stage = 'attack';
                }
                this.lastRetrig = r;
            }

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

            env[i] = this.level * ENV_PEAK;
            inv[i] = -env[i];
        }
        return true;
    }
}

// LFO (after the A-145 "Low Frequency Oscillator")

class LFOProcessor extends AudioWorkletProcessor {
    // inputs:  0 reset
    // outputs: 0 sine  1 triangle  2 saw  3 square

    static get parameterDescriptors() {
        return [
            {name: 'frequency', defaultValue: 2, minValue: 0.01,
                maxValue: 500, automationRate: 'k-rate'} // Hz
        ];
    }

    constructor() {
        super();
        this.phase = 0;
        this.lastReset = 0;
    }

    process(inputs, outputs, parameters) {
        var reset = channel(inputs, 0),
            sin = outputs[0][0],
            tri = outputs[1][0],
            saw = outputs[2][0],
            sqr = outputs[3][0],
            n = sin.length,
            dt = param(parameters, 'frequency', 0) / sampleRate,
            i, t, r;

        for (i = 0; i < n; i += 1) {
            // restart the cycle on a rising edge at the reset input
            if (reset) {
                r = reset[i];
                if (r > GATE_THRESHOLD && this.lastReset <= GATE_THRESHOLD) {
                    this.phase = 0;
                }
                this.lastReset = r;
            }
            t = this.phase;
            sin[i] = Math.sin(TWO_PI * t) * AUDIO_LEVEL;
            tri[i] = (t < 0.5 ? 4 * t - 1 : 3 - 4 * t) * AUDIO_LEVEL;
            saw[i] = (2 * t - 1) * AUDIO_LEVEL;
            sqr[i] = (t < 0.5 ? 1 : -1) * AUDIO_LEVEL;
            this.phase += dt;
            if (this.phase >= 1) {this.phase -= 1; }
        }
        return true;
    }
}

registerProcessor('a100-vco', VCOProcessor);
registerProcessor('a100-vcf', VCFProcessor);
registerProcessor('a100-vca', VCAProcessor);
registerProcessor('a100-adsr', ADSRProcessor);
registerProcessor('a100-lfo', LFOProcessor);
