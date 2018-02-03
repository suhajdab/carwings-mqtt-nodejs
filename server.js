'use strict';
const carwings = require('carwings');
const mqtt = require('mqtt');

/**
 * Built on: https://github.com/quentinchap/hassio-repo
 * Using: https://github.com/blandman/carwings/
 * Protocol spec: https://github.com/blandman/carwings/blob/master/protocol.markdown
 *
 * TODO:20 exports and config function rather than .json
 * TODO:50 poll interval option
 * TODO:30 graceful fail when data: { status: 404 }
 * TODO:40 only invalidate session when neccessary
 * TODO:0 Geolocation possible?
 * TODO:10 Remote HVAC schedule possible?
 */

// Carwings settings
const pollInterval = 30 * 60 * 1000; // 30 min
const minPollIntervalOnError = 30 * 1000; // 30 sec
const maxPollIntervalOnError = 2 * 60 * 60 * 1000; // 2 h
const pollIntervalOnErrorMultiplier = 1.5;
var pollIntervalOnError = minPollIntervalOnError;

const timeoutRetrySetHVAC = 15 * 1000; // 15 sec
const maxRetriesSetHVAC = 3; // attemps at changing HVAC state
var retriesSetHVAC = 0; // attempts used


// mqtt client
const client = mqtt.connect('mqtt://' + options.mqtt_server + ':' + options.mqtt_port);

client.on('connect', function onConnect() {
    console.log('mqtt', 'connect', arguments);
    client.subscribe(options.command_topic + '/ac', function onSubscribe(err, granted) {
        console.log('mqtt', 'subscribe', arguments);
    });

	pollCarwings();
});

// carwings login
function authenticate() {
    return new Promise(function(resolve, reject) {
        carwings.loginSession(options.username, options.password, options.regioncode)
            .then(function(session) {
                if (typeof session !== 'function') {
                    console.log('session not fn');
                    reject("session is not a function");
                } else {
                    resolve(session);
                }
            });
    });
}

// polling carwings status
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
    console.log('pollTimeout', pollInterval);
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
    console.log('handlePollError', err);

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
        client.publish(options.telemetry_topic, JSON.stringify(data), function onPublish(err) {
            console.log('mqtt', 'publish', arguments);

            if (err) reject(err);
            else resolve(true);
        });
    });
}

// set HVAC
function setHVAC(state) {
    login()
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
    console.log('handleHVACError', err);

    invalidate_session();
    retriesSetHVAC++;
    if (retriesSetHVAC < maxRetriesSetHVAC) {
        console.log('setHVAC retry #', retriesSetHVAC);
        setTimeout(setHVAC.bind(null, state), timeoutRetrySetHVAC);
    }
}

client.on('message', function onMessage(topic, buffer) {
    var msg = buffer.toString();
    console.log(arguments);

    setHVAC(msg);
});
