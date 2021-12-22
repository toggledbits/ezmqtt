/* ezmqtt -- Copyright (C) 2021, Patrick H. Rigney, All Rights Reserved
 * 
 */

const version = 21355;

require('trace-unhandled');

const fs = require('fs');
const path = require('path');

// Ref: https://github.com/mqttjs/MQTT.js#readme
const mqtt = require( 'mqtt' );

const EzloClient = require( './ezlo' );

var mqtt_client = false;
var stopping = false;
var dumpdir = ".";

var config = {
    serial: "90000473",
    endpoint: "wss://192.168.0.67:17000",
    username: "rigpapa",
    password: "STOP!thisMADn3ss",
    mqtt: "mqtt://192.168.0.66:1883"
}; // ??? TBD

config.mqtt_ident = config.mqtt_ident || "ezmqtt";

function online() {
    mqtt_send( `tele/LWT`, "online", { qos: 1, retain: true } );
}

function offline() {
    mqtt_send( `tele/LWT`, "offline", { qos: 1, retain: true } );
}

function mqtt_send( topic, payload, opts ) {
    opts = opts || { qos: 1, retain: true };
    mqtt_client.publish( `${config.mqtt_ident}/${topic}`, payload, opts );
}

function mqtt_device_message( topic, payload ) {
    let m = topic.match( "device/([^/]+)/" );
    if ( 2 === m.length && ezlo.hasDevice( m[1] ) ) {
        payload = ezlo.getFullDevice( m[1] );
        mqtt_send( `device/${m[1]}/update`, payload );
    } else {
        console.log( "Topic",topic,"can't locate device");
    }
}

function mqtt_device_item_message( topic, payload ) {
    let m = topic.match( "device/([^/]+)/item/([^/]+)" );
    if ( 3 === m.length && ezlo.hasDevice( m[1] ) ) {
        let device = ezlo.getFullDevice( m[1] );
        if ( device.items[ m[2] ] ) {
            if ( 0 !== payload.length ) {
                /* With payload, attempt to set value */
                ezlo.setItemValue( device.items[ m[2] ]._id, payload );
            } else {
                /* No payload -- just echo current value */
                mqtt_send( `device/${m[1]}/item/${m[2]}`, device.items[ m[2] ] );
            }
        } else {
            console.log( "Topic",topic,"no such item on device");
        } 
    } else {
        console.log( "Topic",topic,"can't locate device");
    }
}

function mqtt_item_message( topic, payload ) {
    let m = topic.match( "/item/(.*)$" );
    if ( 2 === m.length ) {
        ezlo.setItemValue( m[1], payload );
    } else {
        console.error("Topic",topic,"malformed");
    }
}

var retries = 0;

async function start_mqtt() {
    return new Promise( ( resolve, reject ) => {
        let url = config.mqtt || "mqtt://127.0.0.1:1883";
        console.log("Connecting to broker %1", url);
        let copt = config.mqtt_options || {};
        if ( config.mqtt_username ) {
            copt.username = config.mqtt_username;
            copt.password = config.mqtt_password || "";
        }
        copt.clientId = copt.clientId || config.mqtt_ident;
        copt.reconnectPeriod = parseInt( copt.reconnectPeriod ) || 15000;
        copt.connectTimeout = parseInt( copt.connectTimeout ) || 10000;
        copt.resubscribe = false;
        copt.will = {
            topic: `${config.mqtt_ident}/tele/LWT`,
            payload: 'offline',
            qos: 1,
            retain: true,
            properties: {
                willDelayInterval: 30
            }
        };

        console.log("Connecting to MQTT broker", url);
        mqtt_client = mqtt.connect( url, copt );
        mqtt_client.on( "connect", () => {
            console.log("MQTT broker connected at ", url);
            retries = 0;
            mqtt_client.on( "message", ( topic, payload, packet ) => {
                if ( ! topic.startsWith( `${config.mqtt_ident}/` ) ) {
                    /* Not for us */
                    return;
                }
                // ??? do something
                payload = payload.toString( 'UTF-8' );
                console.log("received",topic,payload);
                if ( topic.match( /^.*\/tele\// ) ) {
                    /* ignore -- listening to ourselves */
                } else if ( topic.match( /^.*\/set\/device\/.*\/item\/[^/]*$/ ) ) {
                    mqtt_device_item_message( topic, payload );
                } else if ( topic.match( /^.*\/get\/device\/[^/]*$/ ) ) {
                    mqtt_device_message( topic, payload );
                } else if ( topic.match( /^.*\/set\/item\/[^/]*$/ ) ) {
                    mqtt_item_message( topic, payload );
                } else if ( topic.match( /^.*\/cmd\// ) ) {
                    let m = topic.match( /cmd\/(.+)/ );
                    if ( 2 === m.length ) {
                        let command = m[1].replace( /\//g, "." );
                        ezlo.send( command, payload ).then( data => {
                            console.log("Hub command", command, "complete; reply is", data);
                            return data;
                        });
                    }
                } else {
                    console.error("Unhandled/unrecognized message", topic, payload);
                }
            });
            let pattern = `${config.mqtt_ident}/#`;
            mqtt_client.subscribe( pattern, {}, ( err ) => {
                if ( err ) {
                    throw new Error( `Unable to subscribe to ${pattern}: ${String(err)}` );
                } else {
                    online();
                }
            });
        });
        mqtt_client.on( "reconnect", () => {
            console.log("Reconnecting to", url);
        });
        mqtt_client.on( "error", ( err ) => {
            console.log("Error communicating with MQTT broker:", err );
        });
        mqtt_client.on( "offline", () => {
            console.log("MQTT broker connection lost!");
            if ( 0 === ( ++retries % 3 ) ) {
                offline();
                console.error( "Too many retries to MQTT; full recycle." );
                mqtt_recycle();
            } // else waiting for auto reconnect on this client
        });
        resolve();
    });
}

/* Force close and recycle connection */
function mqtt_recycle() {
    try {
        if ( mqtt_client ) {
            mqtt_client.end( true );
        }
    } catch ( err ) {
        /* ignored */
    } finally {
        mqtt_client = false;
        if ( ! stopping ) {
            setTimeout( () => {
                start_mqtt();
            }, config.mqtt_options?.reconnectPeriod || 5000 );
        }
    }
}

process.on( 'XunhandledRejection', ( reason, promise ) => {
    console.log( "Trapped unhandled Promise rejection", reason );
    console.error( reason );
    console.error( promise );
    console.trace();
    console.error( promise.stack );
    try {
        log.error( "Trapped unhandled Promise rejection: %1", reason );
        log.error( "Please refer to the console log for trace" );
    } catch ( err ) {
        /* nada */
    }
});

/* Main */
const ezlo = new EzloClient( config );

start_mqtt().then( () => {

    console.log("MQTT connected; setting up Ezlo hub connection");
    
    ezlo.on( 'device-updated', device => {
        mqtt_send( `tele/device/${device._id}/update`, device );
    });

    ezlo.on( 'item-updated', (item, device) => {
        mqtt_send( `tele/item/${item._id}`, item );
        mqtt_send( `tele/device/${device._id}/item/${item.name}`, item );
    });

    ezlo.on( 'mode-changed', data => {
        mqtt_send( `tele/mode/current`, data );
    });

    ezlo.on( 'mode-changing', data => {
        mqtt_send( `tele/mode/changing`, data, { qos: 0, retain: false } );
    });

    ezlo.on( 'online', online );
    ezlo.on( 'offline', offline );

    ezlo.start();
});

new Promise( (resolve) => { } ).catch( () => {
    console.log("body promise rejected");
});