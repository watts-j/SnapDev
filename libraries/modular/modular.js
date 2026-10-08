/*
    modular.js

    Snap! extension primitives for the "Modular Synth" library.

    Modules are AudioWorklet nodes (see modular-worklet.js). Their
    jacks are node inputs / outputs, their knobs are AudioParams.
    Scripts only create modules, turn knobs and patch cables; every
    signal, including control signals, stays inside Web Audio.

    primitives (prefix "syn_"):
        syn_create(type, name)
        syn_delete(name)
        syn_clear()
        syn_connect(module, output, module, input)
        syn_disconnect(module, input)
        syn_set(module, knob, value)
        syn_get(module, knob)
        syn_gate(module, bool)
        syn_modules()

    menus (prefix "syn_"):
        syn_names, syn_outputs, syn_inputs, syn_knobs
*/

/*global SnapExtensions, Note, List, AudioWorkletNode, BlockMorph*/

(function () {
    'use strict';

    var WAVES = ['sine', 'triangle', 'saw', 'square'];

    var Modular = {
        workletURL: 'libraries/modular/modular-worklet.js',
        loading: null,      // Promise while the worklet loads
        ready: false,
        modules: new Map(), // name -> module record
        connections: [],    // {src, out, dst, in} records
        speaker: null,      // master GainNode

        types: {
            oscillator: {
                processor: 'modular-oscillator',
                inputs: ['pitch', 'trigger'],
                outputs: ['saw', 'square', 'triangle', 'sine'],
                knobs: ['octave', 'tune', 'pulse width']
            },
            filter: {
                processor: 'modular-filter',
                inputs: ['input', 'cutoff'],
                outputs: ['output'],
                knobs: ['cutoff', 'resonance']
            },
            volume: {
                processor: 'modular-volume',
                inputs: ['input', 'level'],
                outputs: ['output'],
                knobs: ['level']
            },
            envelope: {
                processor: 'modular-envelope',
                inputs: ['gate'],
                outputs: ['output'],
                knobs: ['attack', 'decay', 'sustain', 'release', 'amount']
            },
            wobble: {
                processor: 'modular-wobble',
                inputs: ['trigger'],
                outputs: ['output'],
                knobs: ['wave', 'speed', 'amount']
            }
        }
    };

    // audio context & setup

    Modular.context = function () {
        return Note.prototype.getAudioContext();
    };

    Modular.load = function () {
        // answer a Promise that resolves once the worklet is registered
        var ctx = this.context();
        if (this.ready) {
            return Promise.resolve();
        }
        if (!this.loading) {
            if (!ctx.audioWorklet) {
                return Promise.reject(new Error(
                    'AudioWorklet is not available.\n' +
                    'The modular synth needs a secure (https) page.'
                ));
            }
            this.loading = ctx.audioWorklet.addModule(this.workletURL)
                .then(() => {
                    this.ready = true;
                    this.ensureSpeaker();
                });
        }
        return this.loading;
    };

    Modular.ensureSpeaker = function () {
        var ctx = this.context();
        if (!this.speaker) {
            this.speaker = ctx.createGain();
            this.speaker.gain.value = 0.5; // volume 1 leaves mixing headroom
            this.speaker.connect(ctx.destination);
            this.modules.set('speaker', {
                name: 'speaker',
                type: 'speaker',
                node: this.speaker,
                inputs: ['input'],
                outputs: [],
                knobs: ['volume']
            });
        }
    };

    Modular.waitUntilReady = function (proc) {
        // make the calling process yield until the worklet has loaded.
        // answer true if the caller may proceed, false if it must wait.
        if (this.ready) {
            return true;
        }
        if (!proc.context.accumulator) {
            proc.context.accumulator = {done: false, error: null};
            this.load().then(
                () => {proc.context.accumulator.done = true; },
                err => {proc.context.accumulator.error = err; }
            );
        } else if (proc.context.accumulator.error) {
            throw proc.context.accumulator.error;
        } else if (proc.context.accumulator.done) {
            return true;
        }
        proc.pushContext('doYield');
        proc.pushContext();
        return false;
    };

    // registry helpers

    Modular.module = function (name) {
        var rec = this.modules.get(String(name));
        if (!rec) {
            throw new Error('there is no module named "' + name + '"');
        }
        return rec;
    };

    Modular.jackIndex = function (rec, kind, jack) {
        var idx = rec[kind].indexOf(String(jack));
        if (idx < 0) {
            throw new Error(
                'module "' + rec.name + '" has no ' +
                (kind === 'inputs' ? 'input' : 'output') +
                ' named "' + jack + '"'
            );
        }
        return idx;
    };

    Modular.knob = function (rec, name) {
        var key = String(name);
        if (rec.type === 'speaker') {
            if (key === 'volume') {
                return rec.node.gain;
            }
        } else if (rec.knobs.indexOf(key) > -1) {
            return rec.node.parameters.get(key);
        }
        throw new Error(
            'module "' + rec.name + '" has no knob named "' + name + '"'
        );
    };

    Modular.create = function (type, name) {
        var key = String(type).toLowerCase(),
            spec = this.types[key],
            id = String(name),
            node, rec;
        if (!spec) {
            throw new Error('unknown module type "' + type + '"');
        }
        if (!id || id === 'speaker') {
            throw new Error('"' + id + '" is not a valid module name');
        }
        if (this.modules.has(id)) {
            this.remove(id);
        }
        node = new AudioWorkletNode(this.context(), spec.processor, {
            numberOfInputs: spec.inputs.length,
            numberOfOutputs: spec.outputs.length,
            outputChannelCount: spec.outputs.map(() => 1)
        });
        rec = {
            name: id,
            type: key,
            node: node,
            inputs: spec.inputs,
            outputs: spec.outputs,
            knobs: spec.knobs
        };
        this.modules.set(id, rec);
        return rec;
    };

    Modular.remove = function (name) {
        var rec = this.module(name);
        if (rec.type === 'speaker') {
            throw new Error('the speaker cannot be deleted');
        }
        this.connections = this.connections.filter(c => {
            if (c.src === rec || c.dst === rec) {
                this.unplug(c);
                return false;
            }
            return true;
        });
        this.modules.delete(rec.name);
    };

    Modular.clear = function () {
        Array.from(this.modules.keys()).forEach(name => {
            if (name !== 'speaker') {
                this.remove(name);
            }
        });
    };

    Modular.unplug = function (c) {
        if (c.dst.type === 'speaker') {
            c.src.node.disconnect(c.dst.node, c.out);
        } else {
            c.src.node.disconnect(c.dst.node, c.out, c.in);
        }
    };

    Modular.connect = function (srcName, output, dstName, input) {
        var src = this.module(srcName),
            dst = this.module(dstName),
            out = this.jackIndex(src, 'outputs', output),
            inp = this.jackIndex(dst, 'inputs', input),
            exists = this.connections.some(c =>
                c.src === src && c.out === out && c.dst === dst && c.in === inp
            );
        if (exists) {
            return;
        }
        if (dst.type === 'speaker') {
            src.node.connect(dst.node, out);
        } else {
            src.node.connect(dst.node, out, inp);
        }
        this.connections.push({src: src, out: out, dst: dst, in: inp});
    };

    Modular.disconnect = function (dstName, input) {
        var dst = this.module(dstName),
            inp = this.jackIndex(dst, 'inputs', input);
        this.connections = this.connections.filter(c => {
            if (c.dst === dst && c.in === inp) {
                this.unplug(c);
                return false;
            }
            return true;
        });
    };

    Modular.set = function (name, knob, value) {
        var rec = this.module(name),
            p = this.knob(rec, knob),
            v, ctx = this.context();
        if (String(knob) === 'wave') {
            v = WAVES.indexOf(String(value).toLowerCase());
            if (v < 0) {
                v = +value - 1; // also accept 1 .. 4
            }
            if (isNaN(v) || v < 0 || v > 3) {
                throw new Error(
                    'expecting one of ' + WAVES.join(', ') +
                    ' but getting "' + value + '"'
                );
            }
        } else {
            v = +value;
            if (isNaN(v)) {
                throw new Error(
                    'expecting a number but getting "' + value + '"'
                );
            }
        }
        if (rec.type === 'speaker') {
            v = Math.max(0, Math.min(1, v)) * 0.5;
        } else {
            v = Math.max(p.minValue, Math.min(p.maxValue, v));
        }
        p.cancelScheduledValues(ctx.currentTime);
        p.setTargetAtTime(v, ctx.currentTime, 0.005);
    };

    Modular.get = function (name, knob) {
        var rec = this.module(name),
            p = this.knob(rec, knob),
            v = p.value;
        if (String(knob) === 'wave') {
            return WAVES[Math.round(v)];
        }
        if (rec.type === 'speaker') {
            v *= 2;
        }
        // AudioParams hold single-precision floats, round them for display
        return Math.round(v * 1e6) / 1e6;
    };

    Modular.gate = function (name, open) {
        var rec = this.module(name),
            p = rec.node.parameters ?
                rec.node.parameters.get('gate') : null;
        if (!p) {
            throw new Error('module "' + rec.name + '" has no gate');
        }
        p.setValueAtTime(open ? 1 : 0, this.context().currentTime);
    };

    // primitives

    SnapExtensions.primitives.set(
        'syn_create(type, name)',
        function (type, name, proc) {
            if (Modular.waitUntilReady(proc)) {
                Modular.create(type, name);
            }
        }
    );

    SnapExtensions.primitives.set(
        'syn_delete(name)',
        function (name) {
            Modular.remove(name);
        }
    );

    SnapExtensions.primitives.set(
        'syn_clear()',
        function () {
            Modular.clear();
        }
    );

    SnapExtensions.primitives.set(
        'syn_connect(module, output, module, input)',
        function (src, output, dst, input) {
            Modular.connect(src, output, dst, input);
        }
    );

    SnapExtensions.primitives.set(
        'syn_disconnect(module, input)',
        function (dst, input) {
            Modular.disconnect(dst, input);
        }
    );

    SnapExtensions.primitives.set(
        'syn_set(module, knob, value)',
        function (name, knob, value) {
            Modular.set(name, knob, value);
        }
    );

    SnapExtensions.primitives.set(
        'syn_get(module, knob)',
        function (name, knob) {
            return Modular.get(name, knob);
        }
    );

    SnapExtensions.primitives.set(
        'syn_gate(module, bool)',
        function (name, open) {
            Modular.gate(name, open === true);
        }
    );

    SnapExtensions.primitives.set(
        'syn_modules()',
        function () {
            return new List(Array.from(Modular.modules.keys()));
        }
    );

    // menus

    function dict(names) {
        var result = {};
        names.forEach(name => {result[name] = name; });
        return result;
    }

    function moduleBefore(slot) {
        // answer the module record named in the slot preceding this one
        var block = slot.parentThatIsA(BlockMorph),
            inputs = block.inputs(),
            idx = inputs.indexOf(slot),
            name = idx > 0 ? inputs[idx - 1].evaluate() : null;
        return name ? Modular.modules.get(String(name)) : null;
    }

    SnapExtensions.menus.set(
        'syn_names',
        function () {
            return dict(Array.from(Modular.modules.keys()));
        }
    );

    SnapExtensions.menus.set(
        'syn_outputs',
        function () {
            var rec = moduleBefore(this);
            return dict(rec ? rec.outputs : []);
        }
    );

    SnapExtensions.menus.set(
        'syn_inputs',
        function () {
            var rec = moduleBefore(this);
            return dict(rec ? rec.inputs : []);
        }
    );

    SnapExtensions.menus.set(
        'syn_knobs',
        function () {
            var rec = moduleBefore(this);
            return dict(rec ? rec.knobs : []);
        }
    );

    SnapExtensions.Modular = Modular;
}());
