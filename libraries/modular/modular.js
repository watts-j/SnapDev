/*
    modular.js

    Snap! extension primitives for the "Modular Synth" library.

    A module is a Snap! list of settings, held in a variable by the
    user, for example:

        module       oscillator
        wave         saw
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
        syn_speaker(module)
        syn_preset(number, module)     copies a module's settings into
                                       the body of the "Preset <n>" block
*/

/*global SnapExtensions, Note, List, AudioWorkletNode, StageMorph,
  IDE_Morph, Context*/

(function () {
    'use strict';

    var WAVES = ['saw', 'square', 'triangle', 'sine'],
        CHOICES = {                 // settings chosen from a list
            wave: WAVES,
            kind: ['white', 'random steps'],
            type: ['low pass', 'high pass']
        },
        TEXT = ['pattern', 'notes'], // settings typed as text
        NUMERIC = ['frequency', 'pulse width', 'cutoff', 'resonance',
            'attack', 'decay', 'sustain', 'release', 'amount', 'level',
            'speed', 'time', 'repeats', 'blend', 'fold', 'octaves', 'rise',
            'fall', 'divide by', 'tempo'],
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
            wavefolder: 'a wavefolder',
            'waveform processor': 'a waveform processor',
            'audio divider': 'an audio divider',
            'slew limiter': 'a slew limiter',
            'trigger divider': 'a trigger divider',
            'trigger sequencer': 'a trigger sequencer',
            sequencer: 'a sequencer'};

    var Modular = {
        workletURL: 'libraries/modular/modular-worklet.js?v=7',
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
                    ['wave', 'saw'],
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
                    ['wave', 'sine'],
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
                    ['kind', 'white'],
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
            wavefolder: {
                processor: 'modular-fold',
                settings: [
                    ['fold', 50]
                ],
                jacks: ['input'],
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
            sequencer: {
                processor: 'modular-sequencer',
                settings: [
                    ['notes', '69 72 76 79'],
                    ['tempo', 120]
                ],
                jacks: ['clock'],
                outputs: 1
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
            found = rows.find(pair => pair[0] === key);
        return found ? found[1] : null;
    };

    Modular.typeOf = function (list) {
        // the first row names the kind of module ("module"; older
        // tables used "type")
        var row = this.row(list, 'module') || this.row(list, 'type');
        return row ? String(row.at(2)) : null;
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
                outputChannelCount: [1]
            });
        }
        rec = {node: node, cables: {}};
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
            source = this.resolve(row ? row.at(2) : '', jack);
            if (source instanceof List) {
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
            var source = this.resolve(item, 'inputs'),
                srcRec;
            if (source instanceof List) {
                srcRec = this.ensure(source, visiting);
                srcRec.node.connect(rec.node);
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
        // connect the source module's output into this module's jack
        var spec = this.spec(list),
            idx = spec.jacks.indexOf(jack),
            srcRec;
        this.unplug(rec, jack, idx);
        if (source instanceof List) {
            srcRec = this.ensure(source, visiting);
            srcRec.node.connect(rec.node, 0, idx);
            rec.cables[jack] = srcRec;
        }
    };

    Modular.unplug = function (rec, jack, idx) {
        var old = rec.cables[jack];
        if (old) {
            try {
                old.node.disconnect(rec.node, 0, idx);
            } catch (ignored) {
                // already disconnected
            }
            delete rec.cables[jack];
        }
    };

    Modular.applySetting = function (list, rec, key, value) {
        var ctx = this.context(),
            choices = CHOICES[key],
            p, v;
        if (TEXT.indexOf(key) > -1) {
            v = String(value);
            rec.node.port.postMessage({text: v});
            return v;
        }
        p = rec.node.parameters.get(key);
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
            source = this.resolve(value, key);
            if (source instanceof List) {
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
        // is the module already named in a jack row the given one?
        var resolved;
        try {
            resolved = this.resolve(current, '');
        } catch (ignored) {
            return false;
        }
        return resolved === source;
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

    Modular.toSpeaker = function (list) {
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
        rec.node.connect(this.speaker);
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
            Modular.savePreset(this, number, list);
        }
    );

    SnapExtensions.primitives.set(
        'syn_setup(type, module, values)',
        function (type, list, values, proc) {
            Modular.sprite = this;
            if (Modular.waitUntilReady(proc)) {
                Modular.setup(list, String(type), values);
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
                Modular.gate(list, String(state).toLowerCase() === 'open');
            }
        }
    );

    SnapExtensions.primitives.set(
        'syn_speaker(module)',
        function (list, proc) {
            Modular.sprite = this;
            if (Modular.waitUntilReady(proc)) {
                Modular.toSpeaker(list);
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
                Modular.moduleNames(sprite).forEach(name => {
                    menu[name] = name;
                });
            }
            return menu;
        }
    );

    SnapExtensions.Modular = Modular;
}());
