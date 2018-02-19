'use strict';
const carwings = require('carwings');
const mqtt = require('mqtt');
const clc = require("cli-color");

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
const pollTimeoutAfterHVAC = 30 * 1000; // 30 sec
const minPollIntervalOnError = 30 * 1000; // 30 sec
const maxPollIntervalOnError = 2 * 60 * 60 * 1000; // 2 h
const pollIntervalOnErrorMultiplier = 1.5;
var pollIntervalOnError = minPollIntervalOnError;
var timeout;

const timeoutRetrySetHVAC = 15 * 1000; // 15 sec
const maxRetriesSetHVAC = 3; // attemps at changing HVAC state
var retriesSetHVAC = 0; // attempts used


/* MQTT CLIENT */
var mqtt_client = null,
    options = {};

/* CARWINGS */
/**
 * Carwings login
 * @return {Promise}
 */
function authenticate() {
    return new Promise(function(resolve, reject) {
        carwings.loginSession(options.username, options.password, options.regioncode)
            .then(function(session) {
                if (typeof session !== 'function') {
                    reject("session is not a function");
                } else {
                    resolve(session);
                }
            });
    });
}

/**
 * Polling function using a chain of Promises
 */
function pollCarwings() {
    authenticate()
        .then(requestStatusCheck)
        .then(fetchData)
        .then(parseData)
        .then(publishData)
        .then(generateTimeout(pollCarwings, pollInterval))
        .catch(handlePollError);
}

/**
 * Increases poll interval in case of an error to reduce server load
 * @param  {Number} currentInterval
 * @return {Number} updated interval
 */
function incrementPollIntervalOnError(currentInterval) {
    if (currentInterval * pollIntervalOnErrorMultiplier < maxPollIntervalOnError) {
        return Math.floor(currentInterval * pollIntervalOnErrorMultiplier)
    } else {
        return maxPollIntervalOnError;
    }
}

/**
 * reset poll interval for errors
 */
function resetPollIntervalOnError() {
    pollIntervalOnError = minPollIntervalOnError;
}

/**
 * request a status update from the car (would otherwise return cached values)
 * @param  {Function} session session returned by login
 * @return {Promise}         resolved with session object
 */
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

/**
 * [fetchData description]
 * @param  {Function} session Session from Carwings login
 * @return {Promise}         Promise of requests from Carwings API
 */
function fetchData(session) {
    return Promise.all([
        carwings.batteryRecords(session),
        carwings.hvacStatus(session)
    ]);
}

/**
 * rejected poll handler, schedules next attempt
 * @param  {Error} err Cause of Promise rejection
 */
function handlePollError(err) {
    console.error('handlePollError', err);

    pollIntervalOnError = incrementPollIntervalOnError(pollIntervalOnError);
    generateTimeout(pollCarwings, pollIntervalOnError)();
}

/**
 * Carwings data filtering and parsing
 * @param  {Object} results raw data from Carwings API
 * @return {Promise}         Promise of parsing
 */
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

/**
 * Publish data retrieved from Carwings API to mqtt
 * @param  {Object} data Carwings data
 * @return {Promise}      Promise of publishing data
 */
function publishData(data) {
    return new Promise(function(resolve, reject) {
        mqtt_client.publish(options.telemetry_topic, JSON.stringify(data), function onPublish(err) {
            console.log('mqtt', 'publish', arguments);

            if (err) reject(err);
            else resolve(true);
        });
    });
}

/**
 * Promise chain for HVAC requests
 * @param {[type]} state [description]
 */
function setHVAC(state) {
    authenticate()
        .then(getHVACPromise(state))
		.then(generateTimeout(pollCarwings, pollTimeoutAfterHVAC))
        .catch(handleHVACError.bind(null, state));
}

/**
 * Generate function with Promise for the requested HVAC state
 * @param  {String} state requested state of HVAC
 * @return {Function}       request promise
 */
function getHVACPromise(state) {
    return function setHVACstate(session) {
        if (state === true) return carwings.hvacOn(session);
        else if (state === false) return carwings.hvacOff(session);
        else return Promise.reject('setHVACstate: unknown state');
    }
}

/**
 * handler for rejected HVAC request promise
 * @param  {[type]} state [description]
 * @param  {[type]} err   [description]
 * @return {[type]}       [description]
 */
function handleHVACError(state, err) {
    console.error('handleHVACError', err);

    retriesSetHVAC++;
    if (retriesSetHVAC < maxRetriesSetHVAC) {
        console.warn('setHVAC retry #', retriesSetHVAC);
        generateTimeout(setHVAC.bind(null, state), timeoutRetrySetHVAC)();
    } else {
		console.error('Max number of retries for setHVAC. Will not continue.');
        pollCarwings();
	}
}

// MQTT client
/**
 * mqtt connect event handler, subscribes to command topic and starts polling
 */
function onConnect() {
    mqtt_client.subscribe(options.command_topic + '/#', function onSubscribe(err, granted) {
        if (err) console.error('mqtt', 'subscribe', err);
        else console.log('mqtt', 'subscribe', granted);
    });

    pollCarwings();
}

/**
 * mqtt message event handler, executing carwings functions based on topic
 * @param  {String} topic  topic of the received packet
 * @param  {Buffer} buffer payload of the received packet
 */
function onMessage(topic, buffer) {
    var msg = buffer.toString(),
        cmnd = topic.replace(options.command_topic, '');

    console.log('onMessage', cmnd, msg);

    switch (cmnd) {
        case '/ac':
            setHVAC(msg);
            break;
        default:
            console.warn('unknown cmnd:', cmnd);
    }
}

/**
 * Initialize modue with options
 * @param  {Object} opts Configuration object
 */
function setup(opts) {
    options = opts;
    mqtt_client = mqtt.connect('mqtt://' + options.mqtt_server + ':' + options.mqtt_port, {
        username: options.mqtt_username,
        password: options.mqtt_password
    });

    mqtt_client.on('connect', onConnect);
    mqtt_client.on('message', onMessage);
}


/* UTILS */
/**
 * Prettier logging with timestamp
 * src: https://medium.com/@garychambers108/better-logging-in-node-js-b3cc6fd0dafd
 */
var mapping = {
    log: clc.blue,
    warn: clc.yellow,
    error: clc.red
};

["log", "warn", "error"].forEach(function(method) {
    var oldMethod = console[method].bind(console);
    console[method] = function() {
        oldMethod.apply(
            console, [mapping[method](new Date().toISOString())]
            .concat(arguments)
        );
    };
});

/**
 * Generate a timeout
 * @param  {Function} fn function to execute after timeout
 * @param  {[type]}   t  timeout in millisec
 * @return {[type]}      function
 */
function generateTimeout(fn, t) {
    return function pollTimeout() {
        clearTimeout(timeout);

        return new Promise(function(resolve, reject) {

            console.log(`"${fn.name}" timeout: ${Math.round(t/1000/60)} min`);
            timeout = setTimeout(function timedOutFn() {
                fn();
                resolve();
            }, t);
        });
    }
}

module.exports.setup = setup;
