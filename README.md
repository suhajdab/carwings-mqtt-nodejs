# Carwings MQTT API built in nodejs

This code is meant for interacting with the Nissan Leaf Carwings API. This API allows one to receive updates a swath of information about the vehicle, some of it cached in the cloud and some pulled directly from the vehicle over its cellular connectivity. The API also allows modifying a limited set of vehicle states (AC on/off).

## Getting Started

After cloning the code (and installing node.js) simply run `npm install` to install required dependencies.
Rename `blank.options.json` to `options.json` and fill in your carwings username and password.