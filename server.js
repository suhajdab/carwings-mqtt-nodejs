'use strict';
const carwings = require('carwings');
const mqtt = require('mqtt');

/**
 * Built on: https://github.com/quentinchap/hassio-repo
 * Using: https://github.com/blandman/carwings/
 * Protocol spec: https://github.com/blandman/carwings/blob/master/protocol.markdown
 *
 * TODO
 * ☑ polling
 * ☑ config for user data
 * ☐ re-auth for HVAC toggle
 * ☐ poll interval option
 * ☐ graceful fail when data: { status: 404 }
 * ☐ only invalidate session when neccessary
 */

// Carwings
const pollInterval = 30 * 60 * 1000; // 30 min
const minPollIntervalOnError = 30 * 1000; // 30 sec
const maxPollIntervalOnError = 2 * 60 * 60 * 1000; // 2 h
const pollIntervalOnErrorMultiplier = 1.5;
var pollIntervalOnError = minPollIntervalOnError;

const timeoutRetrySetHVAC = 15 * 1000; // 15 sec
const maxRetriesSetHVAC = 3; // attemps at changing HVAC state
var retriesSetHVAC = 0; // attempts used

const options = require('./options');

if (!options.username || !options.password || !options.regioncode) throw ("Config incomplete!");

var cache = {};
var cached_session = null;

const client = mqtt.connect('mqtt://' + options.mqtt_server + ':' + options.mqtt_port);

client.on('connect', function onConnect() {
    console.log('mqtt', 'connect', arguments);
    client.subscribe(options.command_topic + '/ac', function onSubscribe(err, granted) {
        console.log('mqtt', 'subscribe', arguments);
    });

    client.publish(options.telemetry_topic, 'CONNECTED', function onPublish(err) {
        console.log('mqtt', 'publish', arguments);
    });
});

// carwings login
function login() {
    return new Promise(function(resolve, reject) {
        if (cached_session) {
            resolve(cached_session);
        } else {
            carwings.loginSession(options.username, options.password, options.regioncode)
                .then(function(session) {
                    if (typeof session !== 'function') {
                        console.log('session not fn');
                        reject("session is not a function");
                    } else {
                        cached_session = session;
                        resolve(session);
                    }
                });
        }
    });
}

// polling carwings status
function poll() {
    login()
        .then(requestStatusCheck)
        .then(fetchData)
        .then(publishData)
        .then(pollTimeout)
        .catch(handlePollError);
}

function pollTimeout() {
	console.log('pollTimeout', pollInterval);
    setTimeout(poll, pollInterval);
}

function invalidate_session() {
    cached_session = null;
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
        carwings.batteryStatusCheckRequest(cached_session)
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

    invalidate_session();
    incrementPollIntervalOnError();
    setTimeout(poll, pollIntervalOnError);
}

function requestBatteryRecords(session) {
    return carwings.batteryRecords(session);
}

function requestHvacStatus(session) {
    return carwings.hvacStatus(session);
}

function publishData(data) {
    console.log(arguments);

    try {
        cache['status_BatteryStatusRecords'] = data[0]['status'];
        cache['SOC'] = data[0]['BatteryStatusRecords']['BatteryStatus']['SOC']['Value'];
        cache['isBatteryCharging'] = data[0]['BatteryStatusRecords']['BatteryStatus']['BatteryChargingStatus'] !== 'NOT_CHARGING'; // NOT_CHARGING | NORMAL_CHARGING
        cache['CruisingRangeAcOn'] = data[0]['BatteryStatusRecords']['CruisingRangeAcOn'];
        cache['CruisingRangeAcOff'] = data[0]['BatteryStatusRecords']['CruisingRangeAcOff'];
        cache['isPluggedin'] = data[0]['BatteryStatusRecords']['PluginState'] !== 'NOT_CONNECTED'; // NOT_CONNECTED | CONNECTED

        if (!data[1]['RemoteACRecords']) {
            cache['isRemoteACOn'] = '';
            cache['PreAC_temp'] = '';
        } else {
            cache['isRemoteACOn'] = (data[1]['RemoteACRecords']['RemoteACOperation'] !== 'STOP'); // START | STOP
            cache['PreAC_temp'] = data[1]['RemoteACRecords']['PreAC_temp'];
        }

        client.publish(options.telemetry_topic, JSON.stringify(cache), function onPublish(err){
			console.log('mqtt', 'publish', arguments);
		});

    } catch (e) {
        return Promise.reject(e);
    }

    return Promise.resolve(true);
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

poll();
