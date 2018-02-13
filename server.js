'use strict';
const carwings = require('carwings');
const mqtt = require('mqtt');

/**
 * Built on: https://github.com/quentinchap/hassio-repo
 * Using: https://github.com/blandman/carwings/
 * Protocol spec: https://github.com/blandman/carwings/blob/master/protocol.markdown
 *
 * TODO: follow HVAC request with new polling, calcelling previous id:8 gh:13 ic:gh
 * TODO: poll interval option id:3 gh:5
 * TODO: graceful fail when data: { status: 404 } id:5 gh:7
 * TODO: Geolocation possible? id:6 gh:8
 * TODO: Remote HVAC schedule possible? id:2 gh:4
 * TODO: always cancel previous hvac request id:7 gh:10 ic:gh
 */

// Carwings settings
const pollInterval = 20 * 60 * 1000; // 20 min
const minPollIntervalOnError = 30 * 1000; // 30 sec
const maxPollIntervalOnError = 2 * 60 * 60 * 1000; // 2 h
const pollIntervalOnErrorMultiplier = 1.5;
var pollIntervalOnError = minPollIntervalOnError;

const timeoutRetrySetHVAC = 15 * 1000; // 15 sec
const maxRetriesSetHVAC = 3; // attemps at changing HVAC state
var retriesSetHVAC = 0; // attempts used


// utils
function log() {
    var args = [(new Date).toISOString()].concat(arguments);
    console.log.apply(console, args);
}


// mqtt client
var mqtt_client = null,
    options = {};

// carwings login
function authenticate() {
    return new Promise(function(resolve, reject) {
        carwings.loginSession(options.username, options.password, options.regioncode)
            .then(function(session) {
                if (typeof session !== 'function') {
                    log('session not fn');
                    reject("session is not a function");
                } else {
                    resolve(session);
                }
            });
    });
}

// carwings polling
function pollCarwings() {
    authenticate()
        .then(requestStatusCheck)
        .then(fetchData)
        .then(parseData)
        .then(publishData)
        .then(pollTimeout)
        .catch(handlePollError);
}

function pollTimeout() {
    log('pollTimeout', pollInterval);
    setTimeout(pollCarwings, pollInterval);
}

function incrementPollIntervalOnError() {
    pollIntervalOnError = (pollIntervalOnError * pollIntervalOnErrorMultiplier < maxPollIntervalOnError) ?
        Math.floor(pollIntervalOnError * pollIntervalOnErrorMultiplier) :
        maxPollIntervalOnError;
}

function resetPollIntervalOnError() {
    pollIntervalOnError = minPollIntervalOnError;
}

function requestStatusCheck(session) {
    return new Promise(function(resolve, reject) {
        carwings.batteryStatusCheckRequest(session)
            .then(function(checkStatus) {
                if (checkStatus.status == 401) {
                    reject("checkStatus.status = 401");
                } else {
                    resolve(session);
                }
            });
    });
}

function fetchData(session) {
    return Promise.all([
        requestBatteryRecords(session),
        requestHvacStatus(session)
    ]);
}

function handlePollError(err) {
    log('handlePollError', err);

    incrementPollIntervalOnError();
    setTimeout(pollCarwings, pollIntervalOnError);
}

function requestBatteryRecords(session) {
    return carwings.batteryRecords(session);
}

function requestHvacStatus(session) {
    return carwings.hvacStatus(session);
}

function parseData(results) {
    var data = {};

    try {
        data['status_BatteryStatusRecords'] = results[0]['status'];
        data['SOC'] = results[0]['BatteryStatusRecords']['BatteryStatus']['SOC']['Value'];
        data['isBatteryCharging'] = results[0]['BatteryStatusRecords']['BatteryStatus']['BatteryChargingStatus'] !== 'NOT_CHARGING'; // NOT_CHARGING | NORMAL_CHARGING
        data['CruisingRangeAcOn'] = results[0]['BatteryStatusRecords']['CruisingRangeAcOn'];
        data['CruisingRangeAcOff'] = results[0]['BatteryStatusRecords']['CruisingRangeAcOff'];
        data['isPluggedin'] = results[0]['BatteryStatusRecords']['PluginState'] !== 'NOT_CONNECTED'; // NOT_CONNECTED | CONNECTED

        if (results[1]['RemoteACRecords']) {
            data['isRemoteACOn'] = (results[1]['RemoteACRecords']['RemoteACOperation'] !== 'STOP'); // START | STOP
            data['PreAC_temp'] = results[1]['RemoteACRecords']['PreAC_temp'];
        }

    } catch (e) {
        return Promise.reject(e);
    }

    return Promise.resolve(data);
}

function publishData(data) {
    return new Promise(function(resolve, reject) {
        mqtt_client.publish(options.telemetry_topic, JSON.stringify(data), function onPublish(err) {
            log('mqtt', 'publish', arguments);

            if (err) reject(err);
            else resolve(true);
        });
    });
}

// set HVAC
function setHVAC(state) {
    authenticate()
        .then(getHVACPromise(state))
        .catch(handleHVACError.bind(null, state));
}

function getHVACPromise(state) {
    return function setHVACstate(session) {
        if (state == 'ON') return carwings.hvacOn(session);
        else if (state == 'OFF') return carwings.hvacOff(session);
        else return Promise.reject('setHVACstate: unknown state');
    }
}

function handleHVACError(state, err) {
    log('handleHVACError', err);

    retriesSetHVAC++;
    if (retriesSetHVAC < maxRetriesSetHVAC) {
        log('setHVAC retry #', retriesSetHVAC);
        setTimeout(setHVAC.bind(null, state), timeoutRetrySetHVAC);
    }
}

// MQTT client
function onConnect() {
    mqtt_client.subscribe(options.command_topic + '/#', function onSubscribe(err, granted) {
        log('mqtt', 'subscribe', arguments);
    });

    pollCarwings();
}

function onMessage(topic, buffer) {
    var msg = buffer.toString(),
        cmnd = topic.replace(options.command_topic, '');

    log('onMessage', cmnd, msg);

    switch (cmnd) {
        case '/ac':
            setHVAC(msg);
            break;
        default:
            log('unknown cmnd:', cmnd);
    }
}

function setup(opts) {
    options = opts;
    mqtt_client = mqtt.connect('mqtt://' + options.mqtt_server + ':' + options.mqtt_port, {
        username: options.mqtt_username,
        password: options.mqtt_password
    });

    mqtt_client.on('connect', onConnect);
    mqtt_client.on('message', onMessage);
}

module.exports.setup = setup;
