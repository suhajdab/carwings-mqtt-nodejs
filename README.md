[![TODO board](https://imdone.io/api/1.0/projects/5a761c0f8e15fc0bd32630ff/badge)](https://imdone.io/app#/board/suhajdab/carwings-mqtt-nodejs)

# Carwings MQTT API built in nodejs

This code is meant for interacting with the Nissan Leaf Carwings API. This API allows one to receive updates a swath of information about the vehicle, some of it cached in the cloud and some pulled directly from the vehicle over its cellular connectivity. The API also allows modifying a limited set of vehicle states (AC on/off).

## Getting Started

After cloning the code (and installing node.js) simply run `npm install` to install required dependencies.
Configure & run.
```
var config =
{
	"username": "",
	"password": "",
	"regioncode": "NE",
	"mqtt_server": "localhost",
	"mqtt_port": 1883,
	"command_topic": "cmnd/leaf",
	"telemetry_topic": "tele/leaf"
}

require('carwings-mqtt-nodejs').setup(config);
```
