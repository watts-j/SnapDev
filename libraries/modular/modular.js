/*
    modular.js

    Snap! extension primitives for the "Modular Synth" library.

    A module is a Snap! list of settings, held in a variable by the
    user, for example:

        module       oscillator
        wave type    saw
        frequency    440
        pulse width  50
        control      (empty, or another module's list)
        trigger    (empty, or another module's list)

    Each settings list is linked, through a hidden table, to a live
    AudioWorklet node (see modular-worklet.js). Cables are the module
    lists stored in another module's jack rows. When a list has no
    node, for instance after a project has been loaded, the node is
    rebuilt from the settings the next time a block touches the list.

    primitives (prefix "syn_"):
        syn_create(type, name)         makes a global variable holding
                                       a new module
        syn_setup(type, module, values)  applies a whole row of settings
        syn_mix(inputs)                -> a mix module summing modules
        syn_gate(module, state)        opens or closes an ADSR's gate
        syn_speaker(module)            plugs a module into the speaker
        syn_scope(state)               shows ('on') or hides the oscilloscope
        menus: syn_names (jack entries), syn_modules (module names),
        syn_sources (keyboard sources)
        syn_preset(number, module)     copies a module's settings into
                                       the body of the "Preset <n>" block
*/

/*global SnapExtensions, Note, List, AudioWorkletNode, StageMorph,
  IDE_Morph, Context*/

(function () {
    'use strict';

    var WAVES = ['saw', 'square', 'triangle', 'sine'],
        CHOICES = {                 // settings chosen from a list
            'wave type': WAVES,
            'noise type': ['white', 'random steps'],
            type: ['low pass', 'high pass']
        },
        OLD_NAMES = {               // row names used by earlier tables
            'wave type': 'wave',
            'noise type': 'kind'
        },
        TEXT = ['pattern', 'notes', 'source'], // settings typed as text
        KEYS = ['a', 'w', 's', 'e', 'd', 'f', 't', 'g', 'y', 'h', 'u', 'j',
            'k', 'o', 'l', 'p', ';'], // computer keys as semitones upward
        NUMERIC = ['frequency', 'pulse width', 'cutoff', 'resonance',
            'attack', 'decay', 'sustain', 'release', 'amount', 'level',
            'speed', 'time', 'repeats', 'blend', 'fold', 'octaves', 'rise',
            'fall', 'divide by', 'tempo', 'lowest note'],
        PERCENT = ['pulse width', 'resonance', 'sustain', 'level',
            'repeats', 'blend', 'fold'], // typed 0 to 100, scaled inside
        PERCENT_MAX = {'pulse width': 99, repeats: 95},
        PERCENT_MIN = {'pulse width': 1},
        UNITS = {frequency: 'Hz', 'pulse width': '%', cutoff: 'Hz',
            resonance: '%', attack: 's', decay: 's', sustain: '%',
            release: 's', level: '%', speed: 'Hz', time: 's', repeats: '%',
            blend: '%', fold: '%', rise: 's', fall: 's',
            tempo: 'steps/min'},
        LABELS = {oscillator: 'an oscillator', filter: 'a filter',
            adsr: 'an ADSR', volume: 'a volume', lfo: 'an LFO',
            mix: 'a mix', delay: 'a delay', noise: 'a noise',
            'ring modulator': 'a ring modulator',
            'waveform processor': 'a waveform processor',
            'audio divider': 'an audio divider',
            'slew limiter': 'a slew limiter',
            'trigger divider': 'a trigger divider',
            'trigger sequencer': 'a trigger sequencer',
            'note sequencer': 'a note sequencer',
            keyboard: 'a keyboard'};

    var Modular = {
        workletURL: 'libraries/modular/modular-worklet.js?v=13',
        loading: null,      // Promise while the worklet loads
        ready: false,
        nodes: new WeakMap(), // settings list -> record {node, cables}
        speaker: null,      // master GainNode
        speakerSource: null, // record currently plugged into the speaker
        sprite: null,       // the sprite or stage running the current block

        types: {
            oscillator: {
                processor: 'modular-oscillator',
                settings: [
                    ['wave type', 'saw'],
                    ['frequency', 440],
                    ['pulse width', 50]
                ],
                jacks: ['control', 'trigger'], // node input 0, 1
                outputs: 1
            },
            filter: {
                processor: 'modular-filter',
                settings: [
                    ['type', 'low pass'],
                    ['cutoff', 1000],
                    ['resonance', 100]
                ],
                jacks: ['input', 'control'], // node input 0, 1
                outputs: 1
            },
            adsr: {
                processor: 'modular-envelope',
                settings: [
                    ['attack', 0.01],
                    ['decay', 0.3],
                    ['sustain', 70],
                    ['release', 0.5],
                    ['amount', 12]
                ],
                jacks: ['gate'], // node input 0
                outputs: 1
            },
            volume: {
                processor: 'modular-volume',
                settings: [
                    ['level', 100]
                ],
                jacks: ['input', 'control'], // node input 0, 1
                outputs: 1
            },
            lfo: {
                processor: 'modular-wobble',
                settings: [
                    ['wave type', 'sine'],
                    ['speed', 5],
                    ['amount', 1]
                ],
                jacks: ['trigger'], // node input 0
                outputs: 1
            },
            mix: {
                native: 'gain',      // a plain summing node
                settings: [],
                jacks: ['inputs'],   // one jack taking a list of modules
                multi: 'inputs',
                outputs: 1
            },
            delay: {
                processor: 'modular-delay',
                settings: [
                    ['time', 0.5],
                    ['repeats', 40],
                    ['blend', 50]
                ],
                jacks: ['input'],
                outputs: 1
            },
            noise: {
                processor: 'modular-noise',
                settings: [
                    ['noise type', 'white'],
                    ['speed', 8],
                    ['amount', 1]
                ],
                jacks: ['trigger'],
                outputs: 1
            },
            'ring modulator': {
                processor: 'modular-ring',
                settings: [],
                jacks: ['input', 'input 2'],
                outputs: 1
            },
            'waveform processor': {
                processor: 'modular-fold',
                settings: [
                    ['fold', 50]
                ],
                jacks: ['input', 'control'],
                outputs: 1
            },
            'audio divider': {
                processor: 'modular-divider',
                settings: [
                    ['octaves', 1]
                ],
                jacks: ['input'],
                outputs: 1
            },
            'slew limiter': {
                processor: 'modular-slew',
                settings: [
                    ['rise', 0.1],
                    ['fall', 0.1]
                ],
                jacks: ['input'],
                outputs: 1
            },
            'trigger divider': {
                processor: 'modular-trigger-divider',
                settings: [
                    ['divide by', 2]
                ],
                jacks: ['trigger'],
                outputs: 1
            },
            'trigger sequencer': {
                processor: 'modular-trigger-sequencer',
                settings: [
                    ['pattern', 'x.x.x.x.'],
                    ['tempo', 120]
                ],
                jacks: ['clock'],
                outputs: 1
            },
            'note sequencer': {
                processor: 'modular-sequencer',
                settings: [
                    ['notes', '69 72 76 79'],
                    ['tempo', 120]
                ],
                jacks: ['clock'],
                outputs: 1
            },
            keyboard: {
                processor: 'modular-keyboard',
                settings: [
                    ['source', 'computer keyboard'],
                    ['lowest note', 60]
                ],
                jacks: [],
                outputs: 3,
                outputNames: ['pitch', 'gate', 'velocity']
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
            this.speaker.gain.value = 0.5;
            this.speaker.connect(ctx.destination);
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

    // settings lists

    Modular.rows = function (list) {
        // answer the settings rows of a module list as [key, row] pairs
        if (!(list instanceof List)) {
            return null;
        }
        return list.itemsArray().filter(row =>
            row instanceof List && row.length() === 2
        ).map(row => [String(row.at(1)), row]);
    };

    Modular.row = function (list, key) {
        var rows = this.rows(list) || [],
            found = rows.find(pair => pair[0] === key) ||
                (OLD_NAMES[key] ?
                    rows.find(pair => pair[0] === OLD_NAMES[key]) : null);
        return found ? found[1] : null;
    };

    Modular.typeOf = function (list) {
        // the first row names the kind of module ("module"; older
        // tables used "type")
        var row = this.row(list, 'module') || this.row(list, 'type'),
            type = row ? String(row.at(2)) : null;
        return type === 'sequencer' ? 'note sequencer' : type; // older name
    };

    Modular.isModule = function (list) {
        var type = this.typeOf(list);
        return type !== null && this.types.hasOwnProperty(type);
    };

    Modular.spec = function (list) {
        var type = this.typeOf(list);
        if (!type || !this.types[type]) {
            throw new Error('expecting a module but getting "' +
                (list instanceof List ? 'a list' : list) + '"');
        }
        return this.types[type];
    };

    Modular.newList = function (type) {
        var spec = this.types[type],
            rows = [new List(['module', type])];
        spec.settings.forEach(pair => {
            rows.push(new List([pair[0], pair[1]]));
        });
        spec.jacks.forEach(jack => {
            rows.push(new List([jack, '']));
        });
        return new List(rows);
    };

    Modular.resolve = function (value, jack) {
        // answer the module table a jack value stands for: the table
        // itself, or the global variable of that name, or '' for none
        var frame, found;
        if (value instanceof List) {
            if (!this.isModule(value)) {
                throw new Error('expecting a module in "' + jack + '"');
            }
            return value;
        }
        if (value === '' || value === null || value === undefined) {
            return '';
        }
        frame = this.sprite ? this.sprite.globalVariables() : null;
        found = frame && frame.vars[String(value)] ?
            frame.vars[String(value)].value : undefined;
        if (!(found instanceof List) || !this.isModule(found)) {
            throw new Error('there is no module named "' + value +
                '" to plug into "' + jack + '"');
        }
        return found;
    };

    Modular.module = function (value) {
        // answer the module table a block's module slot stands for: the
        // table itself, or the global variable of that name (the slot's
        // dropdown gives the name as text)
        var frame, found;
        if (value instanceof List || value === '' || value === null ||
                value === undefined) {
            return value;
        }
        frame = this.sprite ? this.sprite.globalVariables() : null;
        found = frame && frame.vars[String(value)] ?
            frame.vars[String(value)].value : undefined;
        if (!(found instanceof List) || !this.isModule(found)) {
            throw new Error('there is no module named "' + value + '"');
        }
        return found;
    };

    Modular.lookup = function (name) {
        // answer the module table held in the global variable of that
        // name, or null
        var frame = this.sprite ? this.sprite.globalVariables() : null,
            found = frame && frame.vars[String(name)] ?
                frame.vars[String(name)].value : null;
        return found instanceof List && this.isModule(found) ? found : null;
    };

    Modular.source = function (value, jack) {
        // answer {list, output} for what a jack row holds: a module
        // table, the name of one, or "name: output" for a module with
        // several outputs; null for an empty jack
        var text, idx, name, outputName, list, names, output;
        if (value instanceof List) {
            return {list: this.resolve(value, jack), output: 0};
        }
        if (value === '' || value === null || value === undefined) {
            return null;
        }
        text = String(value);
        idx = text.lastIndexOf(': ');
        if (idx > -1 && !this.lookup(text)) {
            name = text.slice(0, idx);
            outputName = text.slice(idx + 2).toLowerCase();
            list = this.resolve(name, jack);
            names = this.spec(list).outputNames || [];
            output = names.indexOf(outputName);
            if (output < 0) {
                throw new Error('"' + name + '" has no output named "' +
                    outputName + '"');
            }
            return {list: list, output: output};
        }
        return {list: this.resolve(text, jack), output: 0};
    };

    Modular.outputNamesFor = function (name, list) {
        // answer the dropdown entries that stand for a module's outputs
        var names = this.spec(list).outputNames;
        return names ? names.map(each => name + ': ' + each) : [name];
    };

    Modular.moduleNames = function (sprite) {
        // answer the names of global variables holding modules
        var frame = sprite.globalVariables();
        return Object.keys(frame.vars).filter(name =>
            frame.vars[name].value instanceof List &&
                this.isModule(frame.vars[name].value)
        );
    };

    // live nodes

    Modular.ensure = function (list, visiting) {
        // answer the record for a module list, building its node from
        // the settings if it has none
        var spec = this.spec(list),
            rec = this.nodes.get(list),
            node;
        if (rec) {
            return rec;
        }
        visiting = visiting || new Set();
        if (visiting.has(list)) {
            throw new Error('modules are plugged into each other in a loop');
        }
        visiting.add(list);
        if (spec.native === 'gain') {
            node = this.context().createGain();
        } else {
            node = new AudioWorkletNode(this.context(), spec.processor, {
                numberOfInputs: spec.jacks.length,
                numberOfOutputs: spec.outputs,
                outputChannelCount: new Array(spec.outputs).fill(1)
            });
        }
        rec = {node: node, cables: {}, outputs: {}};
        this.nodes.set(list, rec);
        spec.settings.forEach(pair => {
            var row = this.row(list, pair[0]);
            if (row) {
                this.applySetting(list, rec, pair[0], row.at(2));
            }
        });
        spec.jacks.forEach(jack => {
            var row = this.row(list, jack),
                source;
            if (jack === spec.multi) {
                this.plugAll(list, rec, row ? row.at(2) : null, visiting);
                return;
            }
            source = this.source(row ? row.at(2) : '', jack);
            if (source) {
                this.plug(list, rec, jack, source, visiting);
            }
        });
        return rec;
    };

    Modular.plugAll = function (list, rec, sources, visiting) {
        // connect every module in a list of sources into a mix node
        var items = sources instanceof List ? sources.itemsArray() : [];
        (rec.cables.inputs || []).forEach(src => {
            try {
                src.node.disconnect(rec.node);
            } catch (ignored) {
                // already disconnected
            }
        });
        rec.cables.inputs = [];
        items.forEach(item => {
            var source = this.source(item, 'inputs'),
                srcRec;
            if (source) {
                srcRec = this.ensure(source.list, visiting);
                srcRec.node.connect(rec.node, source.output, 0);
                rec.cables.inputs.push(srcRec);
            }
        });
    };

    Modular.mix = function (sources) {
        // answer a new mix module summing the given modules
        var items = sources instanceof List ? sources.itemsArray() : [],
            list = new List([
                new List(['module', 'mix']),
                new List(['inputs', new List(items.filter(item =>
                    item !== '' && item !== null && item !== undefined
                ))])
            ]);
        this.ensure(list);
        return list;
    };

    Modular.plug = function (list, rec, jack, source, visiting) {
        // connect a source ({list, output}) into this module's jack
        var spec = this.spec(list),
            idx = spec.jacks.indexOf(jack),
            srcRec;
        this.unplug(rec, jack, idx);
        if (source) {
            srcRec = this.ensure(source.list, visiting);
            srcRec.node.connect(rec.node, source.output, idx);
            rec.cables[jack] = srcRec;
            rec.outputs[jack] = source.output;
        }
    };

    Modular.unplug = function (rec, jack, idx) {
        var old = rec.cables[jack];
        if (old) {
            try {
                old.node.disconnect(rec.node, rec.outputs[jack] || 0, idx);
            } catch (ignored) {
                // already disconnected
            }
            delete rec.cables[jack];
            delete rec.outputs[jack];
        }
    };

    Modular.applySetting = function (list, rec, key, value) {
        var ctx = this.context(),
            choices = CHOICES[key],
            p, v;
        if (key === 'source') {
            v = String(value);
            this.attachSource(rec, v);
            return v;
        }
        if (key === 'lowest note') {
            v = Math.round(+value);
            if (isNaN(v)) {
                throw new Error(
                    'expecting a number but getting "' + value + '"'
                );
            }
            v = Math.max(0, Math.min(115, v));
            rec.lowestNote = v;
            return v;
        }
        if (TEXT.indexOf(key) > -1) {
            v = String(value);
            rec.node.port.postMessage({text: v});
            return v;
        }
        p = rec.node.parameters.get(key === 'wave type' ? 'wave' :
            key === 'noise type' ? 'kind' : key);
        if (choices) {
            v = choices.indexOf(String(value).toLowerCase());
            if (v < 0) {
                throw new Error(
                    'expecting one of ' + choices.join(', ') +
                    ' but getting "' + value + '"'
                );
            }
            p.setValueAtTime(v, ctx.currentTime);
            return choices[v];
        }
        v = +value;
        if (isNaN(v)) {
            throw new Error(
                'expecting a number but getting "' + value + '"'
            );
        }
        if (PERCENT.indexOf(key) > -1) {
            v = Math.max(PERCENT_MIN[key] || 0,
                Math.min(PERCENT_MAX[key] || 100, v));
            p.cancelScheduledValues(ctx.currentTime);
            p.setTargetAtTime(v / 100, ctx.currentTime, 0.005);
            return v;
        }
        v = Math.max(p.minValue, Math.min(p.maxValue, v));
        p.cancelScheduledValues(ctx.currentTime);
        p.setTargetAtTime(v, ctx.currentTime, 0.005);
        return v;
    };

    // operations

    Modular.create = function (type) {
        var list = this.newList(type);
        this.ensure(list);
        return list;
    };

    Modular.set = function (list, setting, value, expectedType) {
        var spec = this.spec(list),
            key = String(setting),
            rec = this.ensure(list),
            row = this.row(list, key),
            stored, source, current;
        if (expectedType && this.typeOf(list) !== expectedType) {
            throw new Error('expecting ' + LABELS[expectedType] +
                ' but getting ' + LABELS[this.typeOf(list)]);
        }
        if (!row || key === 'module') {
            throw new Error('a ' + this.typeOf(list) +
                ' has no setting named "' + key + '"');
        }
        current = row.at(2);
        if (spec.jacks.indexOf(key) > -1) {
            source = this.source(value, key);
            if (source) {
                if (this.sameSource(current, source) && rec.cables[key]) {
                    return; // already plugged in
                }
                this.plug(list, rec, key, source);
                stored = value instanceof List ? value : String(value);
            } else {
                if (!rec.cables[key] && (current === '' || current === null)) {
                    return; // already unplugged
                }
                this.unplug(rec, key, spec.jacks.indexOf(key));
                stored = '';
            }
        } else {
            if (this.sameValue(key, current, value)) {
                return; // unchanged, so leave the engine alone
            }
            stored = this.applySetting(list, rec, key, value);
        }
        row.put(stored, 2);
        list.changed();
    };

    Modular.sameSource = function (current, source) {
        // is the source already named in a jack row the given one?
        var resolved;
        try {
            resolved = this.source(current, '');
        } catch (ignored) {
            return false;
        }
        return !!resolved && resolved.list === source.list &&
            resolved.output === source.output;
    };

    Modular.sameValue = function (key, current, value) {
        // would setting the value change what the row holds?
        var v;
        if (TEXT.indexOf(key) > -1) {
            return String(current) === String(value);
        }
        if (CHOICES[key]) {
            return String(current).toLowerCase() ===
                String(value).toLowerCase();
        }
        v = +value;
        if (isNaN(v) || current === '' || current === null) {
            return false;
        }
        if (PERCENT.indexOf(key) > -1) {
            v = Math.max(PERCENT_MIN[key] || 0,
                Math.min(PERCENT_MAX[key] || 100, v));
        }
        return +current === v;
    };

    Modular.setup = function (list, type, values) {
        // apply a whole row of settings and jacks, in table order;
        // an empty jack slot unplugs that jack
        var spec = this.spec(list),
            items = values instanceof List ? values.itemsArray() : [],
            keys = spec.settings.map(pair => pair[0]).concat(spec.jacks);
        if (this.typeOf(list) !== type) {
            throw new Error('expecting ' + LABELS[type] +
                ' but getting ' + LABELS[this.typeOf(list)]);
        }
        keys.forEach((key, i) => {
            var value = items[i];
            this.set(list, key, value === null || value === undefined ?
                '' : value);
        });
    };

    Modular.gate = function (list, open) {
        // open or close an envelope's gate by hand
        var rec = this.ensure(list),
            p = rec.node.parameters.get('gate');
        if (!p) {
            throw new Error('expecting an ADSR but getting ' +
                LABELS[this.typeOf(list)]);
        }
        p.setValueAtTime(open ? 1 : 0, this.context().currentTime);
    };

    Modular.toSpeaker = function (list, output) {
        var rec;
        this.ensureSpeaker();
        if (this.speakerSource) {
            try {
                this.speakerSource.node.disconnect(this.speaker);
            } catch (ignored) {
                // already disconnected
            }
            this.speakerSource = null;
        }
        if (list === '' || list === null || list === undefined) {
            return;
        }
        rec = this.ensure(list);
        rec.node.connect(this.speaker, output || 0);
        this.speakerSource = rec;
    };

    // the stop sign silences the speaker

    if (!StageMorph.prototype.modularStopHooked) {
        StageMorph.prototype.modularStopHooked = true;
        StageMorph.prototype.stopAllActiveSoundsBeforeModular =
            StageMorph.prototype.stopAllActiveSounds;
        StageMorph.prototype.stopAllActiveSounds = function () {
            this.stopAllActiveSoundsBeforeModular();
            if (SnapExtensions.Modular) {
                SnapExtensions.Modular.toSpeaker('');
            }
        };
    }

    // oscilloscope: a panel in the middle of the stage that draws the
    // sound reaching the speaker

    function ScopeMorph(analyser, stage) {
        this.init(analyser, stage);
    }

    ScopeMorph.prototype = new Morph();
    ScopeMorph.prototype.constructor = ScopeMorph;
    ScopeMorph.uber = Morph.prototype;

    ScopeMorph.prototype.init = function (analyser, stage) {
        ScopeMorph.uber.init.call(this);
        this.analyser = analyser;
        this.stage = stage;
        this.samples = new Float32Array(analyser.fftSize);
        this.fps = 30;
        this.fixLayout();
    };

    ScopeMorph.prototype.fixLayout = function () {
        // follow the stage's size and scale, centered
        var ext = this.stage.extent(),
            size = new Point(Math.round(ext.x * 0.6), Math.round(ext.y * 0.4));
        if (!this.extent().eq(size)) {
            this.bounds.setWidth(size.x);
            this.bounds.setHeight(size.y);
            this.rerender();
        }
        this.setCenter(this.stage.center());
    };

    ScopeMorph.prototype.step = function () {
        var kids = this.stage.children;
        if (kids[kids.length - 1] !== this) {
            this.stage.add(this); // stay in front of sprites and watchers
        }
        this.fixLayout();
        this.analyser.getFloatTimeDomainData(this.samples);
        this.rerender();
    };

    ScopeMorph.prototype.render = function (ctx) {
        var w = this.width(),
            h = this.height(),
            data = this.samples,
            span = Math.floor(data.length / 2),
            mid = h / 2,
            amp = h * 0.45,
            start = 0,
            i, x, y;

        ctx.fillStyle = 'rgb(12, 22, 18)';
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = 'rgba(90, 170, 110, 0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, mid + 0.5);
        ctx.lineTo(w, mid + 0.5);
        ctx.stroke();

        // start the trace where the wave rises through zero, so a steady
        // tone stands still
        for (i = 1; i < span; i += 1) {
            if (data[i - 1] < 0 && data[i] >= 0) {
                start = i;
                break;
            }
        }
        ctx.strokeStyle = 'rgb(90, 230, 120)';
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        for (i = 0; i < span; i += 1) {
            x = i / (span - 1) * w;
            y = mid - data[start + i] * amp;
            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.stroke();
        ctx.strokeStyle = 'rgb(120, 60, 160)';
        ctx.lineWidth = 2;
        ctx.strokeRect(1, 1, w - 2, h - 2);
    };

    Modular.scopeOn = function (stage) {
        this.ensureSpeaker();
        if (!this.analyser) {
            this.analyser = this.context().createAnalyser();
            this.analyser.fftSize = 2048;
            this.analyser.smoothingTimeConstant = 0;
            this.speaker.connect(this.analyser);
        }
        if (this.scope && this.scope.parent === stage) {
            return;
        }
        this.scopeOff();
        this.scope = new ScopeMorph(this.analyser, stage);
        stage.add(this.scope);
    };

    Modular.scopeOff = function () {
        if (this.scope) {
            this.scope.destroy();
            this.scope = null;
        }
    };

    // keyboards: notes from the computer keyboard or a MIDI device

    Modular.keyboards = new Set(); // records listening to the computer keys

    Modular.attachSource = function (rec, name) {
        this.detachSource(rec);
        rec.held = [];
        if (name.toLowerCase() === 'computer keyboard') {
            this.keyboards.add(rec);
            this.listenToKeys();
            return;
        }
        rec.midiName = name;
        this.midi().then(access => {
            if (rec.midiName !== name) {
                return; // the source changed meanwhile
            }
            access.inputs.forEach(input => {
                if (input.name === name) {
                    rec.midiInput = input;
                    rec.onMidi = event => this.midiMessage(rec, event.data);
                    input.addEventListener('midimessage', rec.onMidi);
                }
            });
        }, () => null);
    };

    Modular.detachSource = function (rec) {
        this.keyboards.delete(rec);
        if (rec.midiInput) {
            rec.midiInput.removeEventListener('midimessage', rec.onMidi);
            rec.midiInput = null;
        }
        rec.midiName = null;
        if (rec.held && rec.held.length) {
            rec.held = [];
            rec.node.port.postMessage({gate: 0});
        }
    };

    Modular.noteOn = function (rec, note, velocity) {
        rec.held = rec.held.filter(each => each !== note);
        rec.held.push(note);
        rec.node.port.postMessage({note: note, gate: 1, velocity: velocity});
    };

    Modular.noteOff = function (rec, note) {
        rec.held = rec.held.filter(each => each !== note);
        if (rec.held.length) { // fall back to the last key still held
            rec.node.port.postMessage({note: rec.held[rec.held.length - 1]});
        } else {
            rec.node.port.postMessage({gate: 0});
        }
    };

    Modular.midiMessage = function (rec, data) {
        var command = data[0] & 0xF0,
            note = data[1],
            velocity = data[2];
        if (command === 0x90 && velocity > 0) {
            this.noteOn(rec, note, Math.round(velocity / 127 * 100));
        } else if (command === 0x80 || (command === 0x90 && velocity === 0)) {
            this.noteOff(rec, note);
        }
    };

    Modular.midi = function () {
        // answer a Promise of MIDI access, asking the browser once
        if (!this.midiAccess) {
            this.midiAccess = navigator.requestMIDIAccess ?
                navigator.requestMIDIAccess() :
                Promise.reject(new Error('MIDI is not available here'));
            this.midiAccess.then(access => {
                this.midiDevices = access;
            }, () => null);
        }
        return this.midiAccess;
    };

    Modular.midiInputNames = function () {
        var names = [];
        if (this.midiDevices) {
            this.midiDevices.inputs.forEach(input => names.push(input.name));
        }
        return names;
    };

    Modular.listenToKeys = function () {
        if (this.keysHooked) {
            return;
        }
        this.keysHooked = true;
        document.addEventListener('keydown',
            event => this.keyEvent(event, true), true);
        document.addEventListener('keyup',
            event => this.keyEvent(event, false), true);
    };

    Modular.keyEvent = function (event, down) {
        var idx = KEYS.indexOf(String(event.key).toLowerCase());
        if (idx < 0 || event.repeat || event.ctrlKey || event.metaKey ||
                event.altKey) {
            return;
        }
        if (down && typeof world !== 'undefined' && world.cursor) {
            return; // typing into a text field
        }
        this.keyboards.forEach(rec => {
            var note = (rec.lowestNote === undefined ? 60 : rec.lowestNote) +
                idx;
            if (down) {
                this.noteOn(rec, note, 100);
            } else {
                this.noteOff(rec, note);
            }
        });
    };

    // variables

    Modular.createVariable = function (sprite, type, name) {
        // make (or reuse) a global variable and put a new module in it
        var frame = sprite.globalVariables(),
            ide = sprite.parentThatIsA(IDE_Morph),
            id = String(name).trim();
        if (!id) {
            throw new Error('the module needs a name');
        }
        if (frame.vars[id] === undefined) {
            frame.addVar(id);
        }
        frame.setVar(id, this.create(type));
        if (ide) {
            ide.flushBlocksCache('variables');
            ide.refreshPalette();
        }
    };

    // presets

    Modular.presetXML = function (list) {
        // answer the XML of a script reporting a copy of the settings,
        // with the jacks left empty
        var spec = this.spec(list),
            esc = txt => String(txt).replace(/&/g, '&amp;')
                .replace(/</g, '&lt;').replace(/>/g, '&gt;'),
            pair = (key, val) => '<block s="reportNewList"><list><l>' +
                esc(key) + '</l><l>' + esc(val) + '</l></list></block>',
            items = [pair('module', this.typeOf(list))];
        spec.settings.forEach(setting => {
            var row = this.row(list, setting[0]);
            items.push(pair(setting[0], row ? row.at(2) : setting[1]));
        });
        spec.jacks.forEach(jack => {
            items.push(pair(jack, ''));
        });
        return '<script><block s="doReport"><block s="reportNewList">' +
            '<list>' + items.join('') + '</list></block></block></script>';
    };

    Modular.savePreset = function (sprite, number, list) {
        var ide = sprite.parentThatIsA(IDE_Morph),
            stage = ide.stage,
            spec = 'Preset ' + String(number).trim(),
            def = stage.globalBlocks.find(each => each.spec === spec),
            model, script;
        this.spec(list); // make sure it is a module
        if (!def) {
            throw new Error('there is no block named "' + spec + '"');
        }
        model = ide.serializer.parse(this.presetXML(list));
        script = ide.serializer.loadScript(model, stage);
        def.body = new Context(null, script, null, stage);
        def.body.inputs = [];
        stage.allBlockInstances(def).forEach(block => block.refresh());
        ide.flushPaletteCache();
        ide.refreshPalette();
        ide.recordUnsavedChanges();
    };

    // primitives

    SnapExtensions.primitives.set(
        'syn_create(type, name)',
        function (type, name, proc) {
            var key = String(type).toLowerCase();
            Modular.sprite = this;
            if (!Modular.types[key]) {
                throw new Error('unknown module type "' + type + '"');
            }
            if (Modular.waitUntilReady(proc)) {
                Modular.createVariable(this, key, name);
            }
        }
    );

    SnapExtensions.primitives.set(
        'syn_preset(number, module)',
        function (number, list) {
            Modular.sprite = this;
            Modular.savePreset(this, number, Modular.module(list));
        }
    );

    SnapExtensions.primitives.set(
        'syn_setup(type, module, values)',
        function (type, list, values, proc) {
            Modular.sprite = this;
            if (Modular.waitUntilReady(proc)) {
                Modular.setup(Modular.module(list), String(type), values);
            }
        }
    );

    SnapExtensions.primitives.set(
        'syn_mix(inputs)',
        function (sources, proc) {
            Modular.sprite = this;
            if (Modular.waitUntilReady(proc)) {
                return Modular.mix(sources);
            }
        }
    );

    SnapExtensions.primitives.set(
        'syn_gate(module, state)',
        function (list, state, proc) {
            Modular.sprite = this;
            if (Modular.waitUntilReady(proc)) {
                Modular.gate(Modular.module(list),
                    String(state).toLowerCase() === 'open');
            }
        }
    );

    SnapExtensions.primitives.set(
        'syn_speaker(module)',
        function (list, proc) {
            var src;
            Modular.sprite = this;
            if (Modular.waitUntilReady(proc)) {
                src = Modular.source(list, 'speaker');
                Modular.toSpeaker(src ? src.list : '', src ? src.output : 0);
            }
        }
    );

    SnapExtensions.primitives.set(
        'syn_scope(state)',
        function (state) {
            var stage = this.parentThatIsA(StageMorph);
            if (String(state).toLowerCase() === 'on') {
                Modular.scopeOn(stage);
            } else {
                Modular.scopeOff();
            }
        }
    );

    // menu: the names of the variables that hold modules, for jack slots

    SnapExtensions.menus.set(
        'syn_names',
        function () {
            var ide = this.parentThatIsA(IDE_Morph),
                sprite = ide ? ide.currentSprite : Modular.sprite,
                menu = {};
            if (sprite) {
                Modular.sprite = sprite;
                Modular.moduleNames(sprite).forEach(name => {
                    Modular.outputNamesFor(name, Modular.lookup(name))
                        .forEach(entry => {
                            menu[entry] = entry;
                        });
                });
            }
            return menu;
        }
    );

    // menu: the names of the variables that hold modules, for module slots

    SnapExtensions.menus.set(
        'syn_modules',
        function () {
            var ide = this.parentThatIsA(IDE_Morph),
                sprite = ide ? ide.currentSprite : Modular.sprite,
                menu = {};
            if (sprite) {
                Modular.moduleNames(sprite).forEach(name => {
                    menu[name] = name;
                });
            }
            return menu;
        }
    );

    // menu: the computer keyboard and the MIDI devices found so far

    SnapExtensions.menus.set(
        'syn_sources',
        function () {
            var menu = {'computer keyboard': 'computer keyboard'};
            Modular.midi().catch(() => null);
            Modular.midiInputNames().forEach(name => {
                menu[name] = name;
            });
            return menu;
        }
    );

    SnapExtensions.Modular = Modular;
}());
