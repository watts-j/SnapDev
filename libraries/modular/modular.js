/*
    modular.js

    Snap! extension primitives for the "Modular Synth" library.

    A module is a Snap! list of settings, held in a variable by the
    user, for example:

        type       oscillator
        wave       saw
        frequency  261.6
        control    (empty, or another module's list)
        trigger    (empty, or another module's list)

    Each settings list is linked, through a hidden table, to a live
    AudioWorklet node (see modular-worklet.js). Cables are the module
    lists stored in another module's jack rows. When a list has no
    node, for instance after a project has been loaded, the node is
    rebuilt from the settings the next time a block touches the list.

    primitives (prefix "syn_"):
        syn_create(type, name)         makes a global variable holding
                                       a new module
        syn_set(module, setting, value)
        syn_speaker(module)
        syn_preset(number, module)     copies a module's settings into
                                       the body of the "Preset <n>" block
*/

/*global SnapExtensions, Note, List, AudioWorkletNode, StageMorph,
  IDE_Morph, Context, BlockMorph, InputSlotMorph*/

(function () {
    'use strict';

    var WAVES = ['saw', 'square', 'triangle', 'sine'];

    var Modular = {
        workletURL: 'libraries/modular/modular-worklet.js',
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
                    ['frequency', 261.6]
                ],
                jacks: ['control', 'trigger'], // node input 0, 1
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
        var row = this.row(list, 'type');
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
            rows = [new List(['type', type])];
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
        node = new AudioWorkletNode(this.context(), spec.processor, {
            numberOfInputs: spec.jacks.length,
            numberOfOutputs: spec.outputs,
            outputChannelCount: [1]
        });
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
                source = this.resolve(row ? row.at(2) : '', jack);
            if (source instanceof List) {
                this.plug(list, rec, jack, source, visiting);
            }
        });
        return rec;
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
        var p = rec.node.parameters.get(key === 'wave' ? 'wave' : key),
            ctx = this.context(),
            v;
        if (key === 'wave') {
            v = WAVES.indexOf(String(value).toLowerCase());
            if (v < 0) {
                throw new Error(
                    'expecting one of ' + WAVES.join(', ') +
                    ' but getting "' + value + '"'
                );
            }
            p.setValueAtTime(v, ctx.currentTime);
            return WAVES[v];
        }
        v = +value;
        if (isNaN(v)) {
            throw new Error(
                'expecting a number but getting "' + value + '"'
            );
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

    Modular.set = function (list, setting, value) {
        var spec = this.spec(list),
            key = String(setting),
            rec = this.ensure(list),
            row = this.row(list, key),
            stored, source;
        if (!row || key === 'type') {
            throw new Error('a ' + this.typeOf(list) +
                ' has no setting named "' + key + '"');
        }
        if (spec.jacks.indexOf(key) > -1) {
            source = this.resolve(value, key);
            if (source instanceof List) {
                this.plug(list, rec, key, source);
                stored = value instanceof List ? value : String(value);
            } else {
                this.unplug(rec, key, spec.jacks.indexOf(key));
                stored = '';
            }
        } else {
            stored = this.applySetting(list, rec, key, value);
        }
        row.put(stored, 2);
        list.changed();
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
            throw new Error('the oscillator needs a name');
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
            items = [pair('type', this.typeOf(list))];
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
        'syn_set(module, setting, value)',
        function (list, setting, value, proc) {
            Modular.sprite = this;
            if (Modular.waitUntilReady(proc)) {
                Modular.set(list, setting, value);
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

    // menus for the "set oscillator" block
    // the value slot follows the chosen setting: a read-only list of
    // waves, a read-only list of modules, or a typed number

    function siblingSlot(slot, offset) {
        var block = slot.parentThatIsA(BlockMorph),
            inputs = block ? block.inputs() : [],
            idx = inputs.indexOf(slot),
            other = idx > -1 ? inputs[idx + offset] : null;
        return other instanceof InputSlotMorph ? other : null;
    }

    function shapeValueSlot(valueSlot, setting) {
        // make the value slot read-only or editable to suit the setting
        // and replace contents that no longer fit
        var current = valueSlot.evaluate(),
            block = valueSlot.parentThatIsA(BlockMorph),
            readOnly = setting !== 'frequency';
        valueSlot.isReadOnly = readOnly;
        if (setting === 'wave') {
            if (WAVES.indexOf(String(current)) < 0) {
                valueSlot.setContents('saw');
            }
        } else if (setting === 'frequency') {
            if (current === '' || isNaN(+current)) {
                valueSlot.setContents(261.6);
            }
        } else if (WAVES.indexOf(String(current)) > -1 ||
                !isNaN(+current)) {
            valueSlot.setContents('');
        }
        valueSlot.fixLayout();
        valueSlot.rerender();
        if (block) {
            block.fixLayout();
            block.changed();
        }
    }

    SnapExtensions.menus.set(
        'syn_settings',
        function () {
            var slot = this,
                menu = {};
            ['wave', 'frequency', 'control', 'trigger'].forEach(key => {
                menu[key] = function () {
                    var valueSlot = siblingSlot(slot, 1);
                    if (valueSlot) {
                        shapeValueSlot(valueSlot, key);
                    }
                    return key;
                };
            });
            return menu;
        }
    );

    SnapExtensions.menus.set(
        'syn_values',
        function () {
            var settingSlot = siblingSlot(this, -1),
                setting = settingSlot ? String(settingSlot.evaluate()) : '',
                ide = this.parentThatIsA(IDE_Morph),
                sprite = ide ? ide.currentSprite : Modular.sprite,
                menu = {};
            this.isReadOnly = setting !== 'frequency' && setting !== '';
            if (setting === 'wave') {
                WAVES.forEach(wave => {menu[wave] = wave; });
            } else if (setting === 'control' || setting === 'trigger') {
                if (sprite) {
                    Modular.moduleNames(sprite).forEach(name => {
                        menu[name] = name;
                    });
                }
            }
            return menu;
        }
    );

    SnapExtensions.Modular = Modular;
}());
