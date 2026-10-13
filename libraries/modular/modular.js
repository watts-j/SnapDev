/*
    modular.js

    Snap! extension primitives for the "Modular Synth" library.

    A module is a Snap! list of settings, held in a variable by the
    user, for example:

        type       oscillator
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
        syn_set(type, module, setting, value)
        syn_speaker(module)
        syn_preset(number, module)     copies a module's settings into
                                       the body of the "Preset <n>" block
*/

/*global SnapExtensions, Note, List, AudioWorkletNode, StageMorph,
  IDE_Morph, Context, BlockMorph, InputSlotMorph, CustomCommandBlockMorph*/

(function () {
    'use strict';

    var WAVES = ['saw', 'square', 'triangle', 'sine'],
        NUMERIC = ['frequency', 'pulse width', 'cutoff', 'resonance'],
        PERCENT = ['pulse width', 'resonance'], // typed 0 to 100, scaled
        UNITS = {frequency: 'Hz', 'pulse width': '%', cutoff: 'Hz',
            resonance: '%'},
        SET_SPECS = {                                  // "set" block -> type
            "set oscillator %'module' %'setting' to %'value'": 'oscillator',
            "set filter %'module' %'setting' to %'value'": 'filter'
        };

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
                    ['frequency', 440],
                    ['pulse width', 50]
                ],
                jacks: ['control', 'trigger'], // node input 0, 1
                outputs: 1
            },
            filter: {
                processor: 'modular-filter',
                settings: [
                    ['cutoff', 1000],
                    ['resonance', 100]
                ],
                jacks: ['input', 'control'], // node input 0, 1
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
        if (PERCENT.indexOf(key) > -1) {
            v = Math.max(key === 'pulse width' ? 1 : 0,
                Math.min(key === 'pulse width' ? 99 : 100, v));
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
            stored, source;
        if (expectedType && this.typeOf(list) !== expectedType) {
            throw new Error('expecting ' + (expectedType === 'oscillator' ?
                'an ' : 'a ') + expectedType + ' but getting ' +
                (expectedType === 'filter' ? 'an ' : 'a ') +
                this.typeOf(list));
        }
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
            throw new Error('the ' + type + ' needs a name');
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
        'syn_set(type, module, setting, value)',
        function (type, list, setting, value, proc) {
            Modular.sprite = this;
            if (Modular.waitUntilReady(proc)) {
                Modular.set(list, setting, value, String(type));
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

    // menus for the "set <module>" blocks
    // the value slot follows the chosen setting: a read-only list of
    // waves, a read-only list of modules, or a typed number

    function blockType(slot) {
        // answer the module type a "set" block's slot belongs to
        var block = slot.parentThatIsA(BlockMorph);
        return block && block.definition ?
            SET_SPECS[block.definition.spec] : null;
    }

    function settingNames(type) {
        var spec = Modular.types[type];
        return spec ? spec.settings.map(pair => pair[0]).concat(spec.jacks)
            : [];
    }

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
            type = blockType(valueSlot),
            spec = Modular.types[type],
            def = spec ? spec.settings.find(pair => pair[0] === setting)
                : null;
        applyShape(valueSlot, setting);
        if (setting === 'wave') {
            if (WAVES.indexOf(String(current)) < 0) {
                valueSlot.setContents('saw');
            }
        } else if (NUMERIC.indexOf(setting) > -1) {
            if (current === '' || isNaN(+current)) {
                valueSlot.setContents(def ? def[1] : 0);
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

    function applyShape(valueSlot, setting) {
        // numeric settings: a typed number without a dropdown;
        // anything else: a read-only dropdown.
        // answer true if the shape changed
        var before = String(valueSlot.choices) + valueSlot.isReadOnly;
        valueSlot.isModularValue = true;
        if (NUMERIC.indexOf(setting) > -1) {
            valueSlot.isReadOnly = false;
            valueSlot.choices = null;
            valueSlot.arrow().setSize(0); // so clicks reach the text
        } else if (setting) {
            valueSlot.isReadOnly = true;
            valueSlot.choices = 'ext_syn_values';
        }
        return String(valueSlot.choices) + valueSlot.isReadOnly !== before;
    }

    function showUnit(block, unit) {
        // show a unit label such as "Hz" after the value slot, or none
        var label = block.children.find(child => child.isModularUnit);
        if (label && label.text !== unit) {
            label.destroy();
            label = null;
        }
        if (unit && !label) {
            label = block.labelPart(unit);
            label.isModularUnit = true;
            block.add(label);
        }
    }

    function shapeFromSetting(valueSlot) {
        // apply the shape the chosen setting calls for, e.g. on a
        // block that came back from a saved project
        var settingSlot = siblingSlot(valueSlot, -1);
        if (settingSlot) {
            applyShape(valueSlot, String(settingSlot.evaluate()));
        }
    }

    if (!InputSlotMorph.prototype.modularHooked) {
        InputSlotMorph.prototype.modularHooked = true;
        // whenever a "set oscillator" block lays itself out, e.g. when a
        // project loads, its value slot takes the shape its setting needs
        CustomCommandBlockMorph.prototype.fixLayoutBeforeModular =
            CustomCommandBlockMorph.prototype.fixLayout;
        CustomCommandBlockMorph.prototype.fixLayout = function () {
            var inputs, setting;
            if (this.definition && SET_SPECS[this.definition.spec]) {
                inputs = this.inputs();
                if (inputs[1] instanceof InputSlotMorph &&
                        inputs[2] instanceof InputSlotMorph) {
                    setting = String(inputs[1].evaluate());
                    if (applyShape(inputs[2], setting)) {
                        inputs[2].fixLayout();
                    }
                    showUnit(this, UNITS[setting]);
                }
            }
            return this.fixLayoutBeforeModular();
        };
        InputSlotMorph.prototype.mouseDownLeftBeforeModular =
            InputSlotMorph.prototype.mouseDownLeft;
        InputSlotMorph.prototype.mouseDownLeft = function (pos) {
            if (this.choices === 'ext_syn_values' || this.isModularValue) {
                shapeFromSetting(this);
            }
            return this.mouseDownLeftBeforeModular(pos);
        };
    }

    SnapExtensions.menus.set(
        'syn_settings',
        function () {
            var slot = this,
                menu = {};
            settingNames(blockType(slot)).forEach(key => {
                menu[key] = function () {
                    var valueSlot = siblingSlot(slot, 1);
                    slot.setContents(key);
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
                spec = Modular.types[blockType(this)],
                menu = {};
            shapeFromSetting(this);
            if (setting === 'wave') {
                WAVES.forEach(wave => {menu[wave] = wave; });
            } else if (spec && spec.jacks.indexOf(setting) > -1) {
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
