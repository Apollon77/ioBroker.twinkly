'use strict';

const utils = require('@iobroker/adapter-core');
const ping  = require('./lib/ping');
const twinkly = require('./lib/twinkly');

/**
 * The adapter instance
 * @type {ioBroker.Adapter}
 */
let adapter;

/**
 * Interval für das Polling
 */
let pollingInterval = null;

/**
 * Twinkly-Verbindungen
 * @type {{{enabled: Boolean, name: String, host: String, connected: Boolean, twinkly: Twinkly}}}
 */
const connections = {};

/**
 * Liste aller States
 * @type {{connection: String, group: String, command: String}}
 */
const subscribedStates = {};

/**
 * Namen der einzelnen States
 * @type {{{name: string, id: string}}}
 */
const stateNames = {
    on            : 'on',
    mode          : 'mode',
    bri           : 'bri',
    name          : 'name',
    mqtt          : {
        id: 'mqtt',
        subIDs : {

        }
    },
    timer : {
        id     : 'timer',
        subIDs : {
            time_now : 'now',
            time_on  : 'on',
            time_off : 'off'
        }
    },
    reset         : 'reset',
    details : {
        id     : 'details',
        subIDs : {

        }
    },
    firmware      : 'firmware'

    // movieConfig   : 'movieConfig',
    // networkStatus : 'networkStatus'
};

/**
 * Anzulegende States
 * @type {[]}
 */
const statesConfig = [
    stateNames.on,
    stateNames.mode,
    stateNames.bri,
    stateNames.name,
    stateNames.timer.id,
    stateNames.firmware,
    stateNames.reset
];

/**
 * Starts the adapter instance
 * @param {Partial<utils.AdapterOptions>} [options]
 */
function startAdapter(options) {
    // Create the adapter and define its methods
    return adapter = utils.adapter(Object.assign({}, options, {
        name: 'twinkly',

        ready: main,
        unload: (callback) => {
            try {
                // Interval abbrechen
                if (pollingInterval) {
                    clearTimeout(pollingInterval);
                    pollingInterval = null;
                }

                // Alle Verbindungen abmelden...
                for (const connection of Object.keys(connections))
                    connections[connection].twinkly.logout().catch(error => {
                        adapter.log.error(`[onStop.${connections[connection].twinkly.name}] ${error}`);
                    });

                callback();
            } catch (e) {
                callback();
            }
        },

        // is called if a subscribed state changes
        stateChange: async (id, state) => {
            if (state) {
                if (state.ack) return;

                // The state was changed
                adapter.log.debug(`[stateChange] state ${id} changed: ${state.val} (ack = ${state.ack})`);

                // Ist der state bekannt?
                if (!Object.keys(subscribedStates).includes(id)) {
                    adapter.log.warn(`${id} wird nicht verarbeitet!`);
                    return;
                }

                const
                    connection = subscribedStates[id].connection,
                    group      = subscribedStates[id].group,
                    command    = subscribedStates[id].command;

                // Nur ausführen, wenn Gerät verbunden ist!
                if (!connections[connection].connected) {
                    adapter.log.debug(`[stateChange] ${connections[connection].name} ist nicht verfügbar!`);
                    return;
                }

                // Gerät ein-/ausschalten
                if (!group && command === stateNames.on) {
                    connections[connection].twinkly.set_mode(state.val ? twinkly.lightModes.value.on : twinkly.lightModes.value.off)
                        .catch(error => {
                            adapter.log.error(`Could not set ${connection}.${command} ${error}`);
                        });

                // Mode anpassen
                } else if (!group && command === stateNames.mode) {
                    connections[connection].twinkly.set_mode(state.val)
                        .catch(error => {
                            adapter.log.error(`Could not set ${connection}.${command} ${error}`);
                        });

                // Helligkeit anpassen
                } else if (!group && command === stateNames.bri) {
                    connections[connection].twinkly.set_brightness(state.val)
                        .catch(error => {adapter.log.error(`Could not set ${connection}.${command} ${error}`);});

                // Namen anpassen
                } else if (!group && command === stateNames.name) {
                    connections[connection].twinkly.set_name(state.val)
                        .catch(
                            error => {adapter.log.error(`Could not set ${connection}.${command} ${error}`);
                            });

                // MQTT anpassen
                } else if (!group && command === stateNames.mqtt.id) {
                    connections[connection].twinkly.set_mqtt_str(state.val)
                        .catch(error => {
                            adapter.log.error(`Could not set ${connection}.${command} ${error}`);
                        });

                // Timer anpassen
                } else if (!group && command === stateNames.timer.id) {
                    connections[connection].twinkly.set_timer_str(state.val)
                        .catch(error => {
                            adapter.log.error(`Could not set ${connection}.${command} ${error}`);
                        });
                } else if (group && group === stateNames.timer.id) {
                    const json = {};
                    await getJSONStates(connection + '.' + group, json, stateNames.timer.subIDs, {id: command, val: state.val});

                    connections[connection].twinkly.set_timer_str(JSON.stringify(json))
                        .catch(error => {
                            adapter.log.error(`Could not set ${connection}.${group}.${command} ${error}`);
                        });

                // Reset
                } else if (!group && command === stateNames.reset) {
                    await adapter.setState(id, false, true);
                    connections[connection].twinkly.reset()
                        .catch(error => {
                            adapter.log.error(`Could not set ${connection}.${command} ${error}`);
                        });
                }
            } else {
                // The state was deleted
                adapter.log.debug(`[stateChange] state ${id} deleted`);
            }
        }
    }));
}

async function poll() {
    if (pollingInterval) {
        clearTimeout(pollingInterval);
        pollingInterval = null;
    }

    adapter.log.debug(`[poll] Start polling...`);
    try {
        for (const connection of Object.keys(connections)) {
            // Ping-Check
            await ping.probe(connections[connection].host, {log: adapter.log.debug})
                .then(({host, alive, ms}) => {
                    adapter.log.debug('[poll] Ping result for ' + host + ': ' + alive + ' in ' + (ms === null ? '-' : ms) + 'ms');

                    connections[connection].connected = alive;
                    adapter.setState(connection + '.connected', connections[connection].connected, true);
                })
                .catch(error => {
                    adapter.log.error(connection + ': ' + error);
                });

            // Nur ausführen, wenn Gerät verbunden ist!
            if (!connections[connection].connected) {
                adapter.log.debug(`[poll] ${connection} ist nicht verfügbar!`);
                continue;
            }

            for (const command of statesConfig) {
                adapter.log.debug(`[poll] Polling ${connection}.${command}`);

                if (command === stateNames.mode) {
                    await connections[connection].twinkly.get_mode()
                        .then(async ({mode}) => {
                            adapter.setStateAsync(connection + '.' + stateNames.on, mode !== twinkly.lightModes.value.off, true);
                            adapter.setStateAsync(connection + '.' + stateNames.mode, mode, true);
                        })
                        .catch(error => {
                            adapter.log.error(`Could not get ${connection}.${command} ${error}`);
                        });

                } else if (command === stateNames.bri) {
                    await connections[connection].twinkly.get_brightness()
                        .then(async ({value}) => {
                            await adapter.setStateAsync(connection + '.' + command, value, true);
                        })
                        .catch(error => {
                            adapter.log.error(`Could not get ${connection}.${command} ${error}`);
                        });

                } else if (command === stateNames.name) {
                    await connections[connection].twinkly.get_name()
                        .then(async ({name}) => {
                            adapter.setStateAsync(connection + '.' + command, name, true);
                        })
                        .catch(error => {
                            adapter.log.error(`Could not get ${connection}.${command} ${error}`);
                        });

                } else if (command === stateNames.mqtt.id) {
                    await connections[connection].twinkly.get_mqtt()
                        .then(async ({mqtt}) => {
                            adapter.setStateAsync(connection + '.' + command, JSON.stringify(mqtt), true);
                        })
                        .catch(error => {
                            adapter.log.error(`Could not get ${connection}.${command} ${error}`);
                        });

                } else if (command === stateNames.timer.id) {
                    await connections[connection].twinkly.get_timer()
                        .then(async ({timer}) => {
                            saveJSONinState(connection + '.' + command, timer, stateNames.timer.subIDs);
                        })
                        .catch(error => {
                            adapter.log.error(`Could not get ${connection}.${command} ${error}`);
                        });

                } else if (command === stateNames.details.id) {
                    await connections[connection].twinkly.get_details()
                        .then(async ({details}) => {
                            adapter.setStateAsync(connection + '.' + command, JSON.stringify(details), true);
                        })
                        .catch(error => {
                            adapter.log.error(`Could not get ${connection}.${command} ${error}`);
                        });

                } else if (command === stateNames.firmware) {
                    await connections[connection].twinkly.get_firmware_version()
                        .then(async ({version}) => {
                            adapter.setStateAsync(connection + '.' + command, version, true);
                        })
                        .catch(error => {
                            adapter.log.error(`Could not get ${connection}.${command} ${error}`);
                        });
                }
            }
        }
    } catch (e) {
        adapter.log.error(e);
    }

    adapter.log.debug(`[poll] Finished polling...`);

    pollingInterval = setTimeout(async () => {await poll();}, adapter.config.interval * 1000);
}

async function main() {
    adapter.subscribeStates('*');

    // Set Config Default Values
    adapter.config.interval = parseInt(adapter.config.interval, 10) < 15 ? 15 : parseInt(adapter.config.interval);
    if (adapter.config.devices === undefined)
        adapter.config.devices = {};
    if (adapter.config.details === undefined)
        adapter.config.details = false;
    if (adapter.config.mqtt === undefined)
        adapter.config.mqtt = false;
    if (adapter.config.expandJSON === undefined)
        adapter.config.expandJSON = false;

    // States/Objekte anlegen...
    syncConfig()
        .then(result => {
            if (result)
                // Polling starten...
                pollingInterval = setTimeout(async () => {await poll();}, 5000);
            else
                adapter.log.error('Polling wird nicht gestartet!');
        })
        .catch(error => {
            adapter.log.error(error);
        });
}

/**
 * Konfiguration auslesen und verarbeiten
 * @return Promise<Boolean>
 */
function syncConfig() {
    return new Promise((resolve, reject) => {
        // Details hinzufügen, wenn gewünscht
        if (adapter.config.details)
            statesConfig.push(stateNames.details.id);
        // MQTT hinzufügen, wenn gewünscht
        if (adapter.config.mqtt)
            statesConfig.push(stateNames.mqtt.id);

        let result = true;
        try {
            adapter.log.debug('[syncConfig] config devices: '    + JSON.stringify(adapter.config.devices));
            adapter.log.debug('[syncConfig] config interval: '   + adapter.config.interval);
            adapter.log.debug('[syncConfig] config details: '    + adapter.config.details);
            adapter.log.debug('[syncConfig] config mqtt: '       + adapter.config.mqtt);
            adapter.log.debug('[syncConfig] config expandJSON: ' + adapter.config.expandJSON);

            if (!adapter.config.devices) {
                adapter.log.warn('no connections added...');
                result = false;
            }

            // Verbindungen auslesen und erstellen
            if (result)
                for (const device of adapter.config.devices) {
                    // Verbindung aktiviert?
                    if (!device.enabled) {
                        adapter.log.debug(`[syncConfig] ${device.name} deaktiviert... ${JSON.stringify(device)}`);
                        continue;
                    }

                    // Host gefüllt
                    if (device.host === '') {
                        adapter.log.warn(`${device.name}: Host nicht gefüllt!`);
                        continue;
                    }

                    // Verbindung anlegen
                    const deviceName = device.name.replace(/[\][*,;'"`<>\\?]/g, '_').replace(/[.\s]+/g, '_');
                    if (Object.keys(connections).includes(deviceName))
                        adapter.log.warn(`Objects with same id = ${buildId({device: deviceName})} created for two connections ${JSON.stringify(device)}`);
                    else
                        connections[deviceName] = {
                            enabled        : device.enabled,
                            name           : device.name,
                            host           : device.host,
                            connected      : false,
                            twinkly        : new twinkly.Connection(adapter.log, device.name, device.host)
                        };
                }

            // Prüfung ob aktive Verbindungen verfügbar sind
            if (result && Object.keys(connections).length === 0) {
                result = false;
                adapter.log.warn('no enabled connections added...');
            }
        } catch (e) {
            result = false;
        }

        if (result) {
            adapter.log.debug('[syncConfig] Prepare objects');
            const preparedObjects = prepareObjectsByConfig();
            adapter.log.debug('[syncConfig] Get existing objects');

            adapter.getAdapterObjects(_objects => {
                adapter.log.debug('[syncConfig] Prepare tasks of objects update');
                const tasks = prepareTasks(preparedObjects, _objects);

                adapter.log.debug('[syncConfig] Start tasks of objects update');
                processTasks(tasks)
                    .then(response => {
                        result = response;
                        adapter.log.debug('[syncConfig] Finished tasks of objects update');
                    })
                    .catch(error => {
                        result = false;
                        reject(error);
                    });
            });
        }

        resolve(result);
    });
}

/**
 * prepareObjectsByConfig
 * @returns {{}}
 */
function prepareObjectsByConfig() {
    const result = [];
    for (const connection of Object.keys(connections)) {
        const config = {
            device: {
                id: {
                    device: connection
                },
                common: {
                    name: connections[connection].name
                },
                native: {
                    host: connections[connection].twinkly.host
                }
            },
            states  : [],
            channels: []
        };

        if (statesConfig.includes(stateNames.on))
            config.states.push({
                id: {device: connection, state: stateNames.on},
                common: {
                    name : config.device.common.name + ' eingeschaltet',
                    read : true,
                    write: true,
                    type : 'boolean',
                    role : 'switch',
                    def  : false
                }
            });

        if (statesConfig.includes(stateNames.mode))
            config.states.push({
                id: {device: connection, state: stateNames.mode},
                common: {
                    name  : config.device.common.name + ' Mode',
                    read  : true,
                    write : true,
                    type  : 'string',
                    role  : 'state',
                    def   : twinkly.lightModes.value.off,
                    states: twinkly.lightModes.text
                }
            });

        if (statesConfig.includes(stateNames.bri))
            config.states.push({
                id: {device: connection, state: stateNames.bri},
                common: {
                    name : config.device.common.name + ' Brightness',
                    read : true,
                    write: true,
                    type : 'number',
                    role : 'level.dimmer',
                    min  : 0,
                    max  : 100,
                    def  : 0
                }
            });

        if (statesConfig.includes(stateNames.name))
            config.states.push({
                id: {device: connection, state: stateNames.name},
                common: {
                    name : config.device.common.name + ' Name',
                    read : true,
                    write: true,
                    type : 'string',
                    role : 'info.name',
                    def: ''
                }
            });

        if (statesConfig.includes(stateNames.mqtt.id)) {
            // TODO: Extend
            config.states.push({
                id: {device: connection, state: stateNames.mqtt.id},
                common: {
                    name : config.device.common.name + ' MQTT',
                    read : true,
                    write: true,
                    type : 'string',
                    role : 'json',
                    def  : '{}'
                }
            });
        }

        if (statesConfig.includes(stateNames.timer.id)) {
            if (adapter.config.expandJSON) {
                config.channels.push({
                    id: {device: connection, channel: stateNames.timer.id},
                    common: {
                        name : config.device.common.name + ' Timer',
                        read : true,
                        write: false,
                        type : 'string',
                        role : 'json',
                        def  : '{}'
                    }
                });

                config.states.push({
                    id: {device: connection, channel: stateNames.timer.id, state: stateNames.timer.subIDs.time_now},
                    common: {
                        name : config.device.common.name + ' Timer Now',
                        read : true,
                        write: false,
                        type : 'number',
                        role : 'value',
                        def  : '0'
                    }
                });

                config.states.push({
                    id: {device: connection, channel: stateNames.timer.id, state: stateNames.timer.subIDs.time_on},
                    common: {
                        name : config.device.common.name + ' Timer On',
                        read : true,
                        write: true,
                        type : 'number',
                        role : 'value',
                        def  : '-1'
                    }
                });

                config.states.push({
                    id: {device: connection, channel: stateNames.timer.id, state: stateNames.timer.subIDs.time_off},
                    common: {
                        name : config.device.common.name + ' Timer Off',
                        read : true,
                        write: true,
                        type : 'number',
                        role : 'value',
                        def  : '-1'
                    }
                });
            } else {
                config.states.push({
                    id: {device: connection, state: stateNames.timer.id},
                    common: {
                        name : config.device.common.name + ' Timer',
                        read : true,
                        write: true,
                        type : 'string',
                        role : 'json',
                        def  : '{}'
                    }
                });
            }
        }

        if (statesConfig.includes(stateNames.reset))
            config.states.push({
                id: {device: connection, state: stateNames.reset},
                common: {
                    name : config.device.common.name + ' Reset',
                    read : true,
                    write: true,
                    type : 'boolean',
                    role : 'button',
                    def  : false
                }
            });

        if (statesConfig.includes(stateNames.details.id)) {
            // TODO: Extend
            config.states.push({
                id: {device: connection, state: stateNames.details.id},
                common: {
                    name : config.device.common.name + ' Details',
                    read : true,
                    write: false,
                    type : 'string',
                    role : 'json',
                    def  : '{}'
                }
            });
        }

        if (statesConfig.includes(stateNames.firmware))
            config.states.push({
                id: {device: connection, state: stateNames.firmware},
                common: {
                    name : config.device.common.name + ' Firmware',
                    read : true,
                    write: false,
                    type : 'string',
                    role : 'state',
                    def  : ''
                }
            });

        config.states.push({
            id: {device: connection, state: 'connected'},
            common: {
                name : config.device.common.name + ' Connected',
                read : true,
                write: false,
                type : 'boolean',
                role : 'indicator.connected',
                def  : false
            }
        });

        result.push(config);
    }

    return result;
}

/**
 * prepareTasks
 * @param preparedObjects
 * @param old_objects
 * @returns {{id: string, type: string}[]}
 */
function prepareTasks(preparedObjects, old_objects) {
    const devicesToUpdate  = [];
    const channelsToUpdate = [];
    const statesToUpdate   = [];

    try {
        for (const group of preparedObjects) {
            // Device prüfen
            if (group.device) {
                const fullID = buildId(group.device.id);
                const oldObj = old_objects[fullID];

                // Native ergänzen falls nicht vorhanden
                if (!group.device.native) group.device.native = {};

                if (oldObj && oldObj.type === 'device') {
                    if (!areStatesEqual(oldObj, group.device)) {
                        devicesToUpdate.push({
                            type : 'update_device',
                            id   : group.device.id,
                            data : {
                                common : group.device.common,
                                native : group.device.native
                            }
                        });
                    }
                    old_objects[fullID] = undefined;
                } else {
                    devicesToUpdate.push({
                        type : 'create_device',
                        id   : group.device.id,
                        data : {
                            common : group.device.common,
                            native : group.device.native
                        }
                    });
                }
            }

            // Channels prüfen
            if (group.channels) {
                for (const channel of group.channels) {
                    const fullID = buildId(channel.id);
                    const oldObj = old_objects[fullID];

                    // Native ergänzen falls nicht vorhanden
                    if (!channel.native) channel.native = {};

                    if (oldObj && oldObj.type === 'channel') {
                        if (!areStatesEqual(oldObj, channel)) {
                            channelsToUpdate.push({
                                type: 'update_channel',
                                id: channel.id,
                                data: {
                                    common: channel.common,
                                    native: channel.native
                                }
                            });
                        }
                        old_objects[fullID] = undefined;
                    } else {
                        channelsToUpdate.push({
                            type: 'create_channel',
                            id: channel.id,
                            data: {
                                common: channel.common,
                                native: channel.native
                            }
                        });
                    }
                }
            }

            // States prüfen
            if (group.states) {
                for (const state of group.states) {
                    const fullID = buildId(state.id);
                    const oldObj = old_objects[fullID];

                    // Native ergänzen falls nicht vorhanden
                    if (!state.native) state.native = {};

                    // Nur wenn der State bearbeitet werden darf hinzufügen
                    if (state.common.write)
                        subscribedStates[fullID] = {connection: state.id.device, group: state.id.channel, command: state.id.state};

                    if (oldObj && oldObj.type === 'state') {
                        if (!areStatesEqual(oldObj, state)) {
                            statesToUpdate.push({
                                type: 'update_state',
                                id: state.id,
                                data: {
                                    common: state.common,
                                    native: state.native
                                }
                            });
                        }
                        old_objects[fullID] = undefined;
                    } else {
                        statesToUpdate.push({
                            type: 'create_state',
                            id: state.id,
                            data: {
                                common: state.common,
                                native: state.native
                            }
                        });
                    }
                }
            }
        }
    } catch (e) {
        adapter.log.error(e.name + ': ' + e.message);
    }

    // eslint-disable-next-line no-unused-vars
    const oldEntries       = Object.keys(old_objects).map(id => ([id, old_objects[id]])).filter(([id, object]) => object);
    // eslint-disable-next-line no-unused-vars
    const devicesToDelete  = oldEntries.filter(([id, object]) => object.type === 'device') .map(([id, object]) => ({ type: 'delete_device', id: id }));
    // eslint-disable-next-line no-unused-vars
    const channelsToDelete = oldEntries.filter(([id, object]) => object.type === 'channel').map(([id, object]) => ({ type: 'delete_channel', id: id }));
    // eslint-disable-next-line no-unused-vars
    const stateToDelete    = oldEntries.filter(([id, object]) => object.type === 'state')  .map(([id, object]) => ({ type: 'delete_state',  id: id }));

    return stateToDelete.concat(devicesToUpdate, devicesToDelete, channelsToUpdate, channelsToDelete, statesToUpdate);
}

/**
 * areStatesEqual
 * @param rhs
 * @param lhs
 * @returns {boolean}
 */
function areStatesEqual(rhs, lhs) {
    return areObjectsEqual(rhs.common, lhs.common) &&
           areObjectsEqual(rhs.native, lhs.native);
}

/**
 * Check if two Objects are identical
 * @param aObj
 * @param bObj
 * @returns {boolean}
 */
function areObjectsEqual(aObj, bObj) {
    function doCheck(aObj, bObj) {
        let result = typeof aObj !== 'undefined' && typeof bObj !== 'undefined';

        if (result)
            for (const key of Object.keys(aObj)) {
                let equal = Object.keys(bObj).includes(key);
                if (equal) {
                    if (typeof aObj[key] === 'object' && typeof bObj[key] === 'object')
                        equal = areObjectsEqual(aObj[key], bObj[key]);
                    else
                        equal = aObj[key] === bObj[key];
                }

                if (!equal) {
                    result = false;
                    break;
                }
            }

        return result;
    }

    return doCheck(aObj, bObj) && doCheck(bObj, aObj);
}

/**
 * buildId
 * @param id
 * @returns {string}
 */
function buildId(id) {
    if (typeof id === 'object')
        return adapter.namespace + (id.device ? '.' + id.device : '') + (id.channel ? '.' + id.channel : '') + (id.state ? '.' + id.state : '');
    else
        return id;
}

/**
 * processTasks
 * @param tasks
 * @return Promise<Boolean>
 */
function processTasks(tasks) {
    return new Promise((resolve, reject) => {
        if (!tasks || !tasks.length || tasks.length === 0) {
            reject('Tasks nicht gefüllt!');
        } else {
            while (tasks.length > 0) {
                const task = tasks.shift(),
                    id = buildId(task.id);
                adapter.log.debug('[processTasks] Task: ' + JSON.stringify(task) + ', ID: ' + id);

                if (task.type === 'create_device') {
                    adapter.log.debug('[processTasks] Create device id=' + id);
                    try {
                        adapter.createDevice(task.id.device, task.data.common, task.data.native, err => {
                            if (err) adapter.log.error('Cannot create device: ' + id + ' Error: ' + err);
                        });
                    } catch (err) {
                        adapter.log.error('Cannot create device: ' + id + ' Error: ' + err);
                    }
                } else if (task.type === 'update_device') {
                    adapter.log.debug('[processTasks] Update device id=' + id);
                    adapter.extendObject(id, task.data, err => {
                        if (err) adapter.log.error('Cannot update device: ' + id + ' Error: ' + err);
                    });
                } else if (task.type === 'delete_device') {
                    adapter.log.debug('[processTasks] Delete device id=' + id);

                    adapter.delObject(id, err => {
                        if (err) adapter.log.error('Cannot delete device : ' + id + ' Error: ' + err);
                    });

                } else if (task.type === 'create_channel') {
                    adapter.log.debug('[processTasks] Create channel id=' + id);

                    try {
                        adapter.createChannel(task.id.device, task.id.channel, task.data.common, task.data.native, err => {
                            err && adapter.log.error('Cannot create channel : ' + id + ' Error: ' + err);
                        });
                    } catch (err) {
                        adapter.log.error('Cannot create channel : ' + id + ' Error: ' + err);
                    }
                } else if (task.type === 'update_channel') {
                    adapter.log.debug('[processTasks] Update channel id=' + id);

                    adapter.extendObject(id, task.data, err => {
                        err && adapter.log.error('Cannot update channel : ' + id + ' Error: ' + err);
                    });
                } else if (task.type === 'delete_channel') {
                    adapter.log.debug('[processTasks] Delete channel id=' + id);

                    adapter.delObject(id, err => {
                        err && adapter.log.error('Cannot delete channel : ' + id + ' Error: ' + err);
                    });

                } else if (task.type === 'create_state') {
                    adapter.log.debug('[processTasks] Create state id=' + id);

                    try {
                        adapter.createState(task.id.device, task.id.channel, task.id.state, task.data.common, task.data.native, err => {
                            if (err) adapter.log.error('Cannot create state : ' + id + ' Error: ' + err);
                        });
                    } catch (err) {
                        adapter.log.error('Cannot create state : ' + id+ ' Error: ' + err);
                    }
                } else if (task.type === 'update_state') {
                    adapter.log.debug('[processTasks] Update state id=' + id);

                    adapter.extendObject(id, task.data, err => {
                        if (err) adapter.log.error('Cannot update state : ' + id + ' Error: ' + err);
                    });
                } else if (task.type === 'delete_state') {
                    adapter.log.debug('[processTasks] Delete state id=' + id);

                    adapter.delObject(id, err => {
                        if (err) adapter.log.error('Cannot delete state : ' + id + ' Error: ' + err);
                    });
                } else
                    adapter.log.error('Unknown task type: ' + JSON.stringify(task));
            }

            resolve(true);
        }
    });
}

/**
 * Save States from JSON
 * @param state <String>
 * @param json <{}>
 * @param mapping <{}>
 */
function saveJSONinState(state, json, mapping) {
    if (adapter.config.expandJSON) {
        for (const key of Object.keys(json)) {
            if (Object.keys(mapping).includes((key)))
                adapter.setStateAsync(state + '.' + mapping[key], json[key], true);
            else
                adapter.log.warn(`[saveJSONinState] State <${state}> with key <${key}> does not exist!`);
        }
    } else
        adapter.setStateAsync(state, JSON.stringify(json), true);
}

/**
 * Get States in JSON
 * @param state <String>
 * @param json <{}>
 * @param lastState <{id: String, val: any}>
 * @param mapping <{}>
 */
async function getJSONStates(state, json, mapping, lastState) {
    for (const key of Object.keys(mapping)) {
        if (!Object.keys(json).includes((key))) {
            // Check LastState first
            if (lastState && mapping[key] === lastState.id)
                json[key] = lastState.val;
            else
                await adapter.getStateAsync(state + '.' + mapping[key])
                    .then(state => {
                        if (state)
                            json[key] = state.val;
                        else
                            json[key] = '';
                    });
        }
    }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export startAdapter in compact mode
    module.exports = startAdapter;
} else {
    // otherwise start the instance directly
    startAdapter();
}