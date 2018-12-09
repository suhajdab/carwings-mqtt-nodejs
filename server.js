'use strict';
const { NissanConnect } = require('@beejjacobs/nissan-connect');

const mqtt = require('mqtt');
const clc = require("cli-color");

/**
 * Built on: https://github.com/quentinchap/hassio-repo
 * Using: https://github.com/blandman/carwings/
 * Protocol spec: https://github.com/blandman/carwings/blob/master/protocol.markdown
 *
 * TODO: poll interval option id:3 gh:5
 * TODO: graceful fail when data: { status: 404 } id:5 gh:7
 * TODO: Geolocation possible? id:6 gh:8
 * TODO: Remote HVAC schedule possible? id:2 gh:4
 */

// Carwings settings
const pollInterval = 30 * 60 * 1000; // 30 min
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
    nc = {},
    options = {};

/* CARWINGS */
/**
 * Polling function using a chain of Promises
 */
async function pollCarwings() {
    await nc.getBatteryStatus();
    let latestBattery = await nc.getLastBatteryStatus();
    let ac = await nc.getAcSchedule();

    parseData([latestBattery.info, ac.info])
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
            data['RemoteACState'] = (results[1]['RemoteACRecords']['RemoteACOperation'] !== 'STOP') ? 'ON' : 'OFF'; // START | STOP
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
async function setHVAC(state) {
    if (state === 'ON') await nc.acOn();
    else if (state === 'OFF') await nc.acOff();

    publishData({RemoteACState: state});
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

    nc = new NissanConnect(options.username, options.password);
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
            console, [mapping[method](new Date().toLocaleString())]
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
