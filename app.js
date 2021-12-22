/* ezmqtt -- Copyright (C) 2021, Patrick H. Rigney, All Rights Reserved
 *
 */

const version = 21356;

const fs = require('fs');
const path = require('path');
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
    try {
        if ( "object" === typeof payload ) {
            payload = JSON.stringify( payload );
        } else {
            payload = String( payload );
        }
        mqtt_client.publish( `${config.mqtt_ident}/${topic}`, payload, opts );
    } catch ( err ) {
        console.log( err );
    }
}

function mqtt_device_message( topic, payload ) {
    let m = topic.match( /device\/([^/]+)/ );
    if ( m && 2 === m.length && ezlo.hasDevice( m[1] ) ) {
        payload = ezlo.getFullDevice( m[1] );
        try {
            mqtt_send( `tele/device/${m[1]}`, payload );
        } catch ( err ) {
            console.error( "mqtt: failed to send device update:", err );
        }
    } else {
        console.log( "Topic",topic,"can't locate device");
    }
}

function mqtt_device_item_message( topic, payload ) {
    let m = topic.match( "device/([^/]+)/item/([^/]+)" );
    if ( m && 3 === m.length && ezlo.hasDevice( m[1] ) ) {
        let device = ezlo.getFullDevice( m[1] );
        if ( device.items[ m[2] ] ) {
            let item = device.items[ m[2] ];
            if ( 0 !== payload.length ) {
                /* With payload, attempt to set value */
                try {
                    ezlo.setItemValue( device.items[ m[2] ]._id, payload ).then( () => {
                        console.log( `mqtt: <${topic} ${payload}> success; item value set.` );
                    }).catch( err => {
                        console.error( `mqtt: <${topic} ${payload}> failed; ${err.message} (${err.code}): ${err.reason}` );
                    });
                } catch ( err ) {
                    console.log( `mqtt: <${topic} ${payload}> failed:`, err );
                }
            } else {
                /* No payload -- just echo current value */
                mqtt_send( `tele/device/${m[1]}/item/${item.name}`, item.value );
                mqtt_send( `tele/item/${item._id}`, item );
            }
        } else {
            console.log( `mqtt: <${topic} ${payload}> failed: item not present on device` );
        }
    } else {
        console.log( `mqtt: <${topic} ${payload}> failed: device unknown or malformed topic` );
    }
}

function mqtt_item_message( topic, payload ) {
    let m = topic.match( "/item/(.*)$" );
    if ( m && 2 === m.length ) {
        let item = ezlo.getItem( m[1] );
        if ( ! item ) {
            console.log( `mqtt: <${topic} ${payload}> failed: item unknown` );
        } else {
            if ( 0 !== payload.length ) {
                try {
                    ezlo.setItemValue( m[1], payload ).then( () => {
                        console.log( `mqtt: <${topic} ${payload}> success` );
                    }).catch( err => {
                        console.error( `mqtt: <${topic} ${payload}> failed; ${err.message} (${err.code}): ${err.reason}` );
                    });;
                } catch ( err ) {
                    console.log( `mqtt: <${topic} ${payload}> failed:`, err );
                }
            } else {
                /* No payload -- just echo current value */
                mqtt_send( `tele/device/${item.deviceId}/item/${item.name}`, item.value );
                mqtt_send( `tele/item/${item._id}`, item );
            }
        }
    } else {
        console.log( `mqtt: <${topic} ${payload}> failed: topic malformed` );
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
                } else if ( topic.match( /^.*\/set\/device\/[^/]*$/ ) ) {
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

process.on( 'unhandledRejection', ( reason, promise ) => {
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
        mqtt_send( `tele/device/${device._id}/item/${item.name}`, item.value );
    });

    ezlo.on( 'mode-changed', data => {
        mqtt_send( `tele/mode/current`, data );
    });

    ezlo.on( 'mode-changing', data => {
        mqtt_send( `tele/mode/changing`, data, { qos: 0, retain: false } );
    });

    ezlo.on( 'hub-status-change', status => {
        mqtt_send( `tele/hub/status`, status );
    });

    ezlo.on( 'online', online );
    ezlo.on( 'offline', offline );

    ezlo.start();
});

new Promise( (resolve) => { } ).catch( () => {
    console.log("body promise rejected");
});