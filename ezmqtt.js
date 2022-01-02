#!/usr/bin/env node

/* ezmqtt -- An MQTT interface for Ezlo hubs
Copyright (C) 2021, Patrick H. Rigney, All Rights Reserved

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, version 3.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/* TO-DO:
 *  set config values via MQTT?
 *  Build for Docker
 * persistent storage for devices/items?
 */
const version = 22002;

const fs = require('fs');
const path = require('path');
const mqtt = require( 'mqtt' );

const EzloClient = require( './lib/ezloclient' );

var mqtt_client = false;
var stopping = false;

console.log( "ezmqtt (C) 2021 Patrick H. Rigney, All Rights Reserved");
console.log( "Please see license at https://github.com/toggledbits/ezmqtt" );
console.log( "Version", version, "in", path.resolve( '.' ), 'run from' , __dirname );

/* Find the configuration file. Docker containers will set EZMQTT_VAR; if not
 * set, use the directory from whence the command was launched (not
 * necessarily where this file may be installed, which is often a system
 * directory and not a good spot for a config file like this).
 */
var cf = path.resolve( process.env.EZMQTT_VAR || ".", "ezmqtt-config.yaml" );
console.log( `ezmqtt: configuration path ${cf}` );
if ( ! fs.existsSync( cf ) ) {
    try {
        fs.copyFileSync( path.resolve( __dirname, "./ezmqtt-config.yaml-dist" ), cf );
    } catch( err ) {
        console.error( `ezmqtt: failed to copy configuration template:`, err );
        process.exit( 1 );
    }
}
var config;
try {
    const yaml = require( 'js-yaml' );
    config = fs.readFileSync( cf );
    config = yaml.safeLoad( config );
} catch ( err ) {
    console.error( `ezmqtt: failed to read configuration ${cf}:`, err );
    process.exit( 1 );
}

if ( "12345678" === ( config.ezlo_hub.serial || "12345678" ) ) {
    console.error( "ezmqtt: configuration required; please refer to the README" );
    process.exit( 0 ); /* non-failure to try to avoid docker auto-restarts (on-failure) */
}

config.mqtt = config.mqtt || {};
config.mqtt.url = config.mqtt.url || "mqtt://127.0.0.1:1883"
config.mqtt.ident = config.mqtt.ident || "ezmqtt";

var debug = ()=>{}; /* console.debug; /* */
if ( config.debug ) {
    debug = console.debug;
}

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
        debug( `mqtt: sending ${config.mqtt.ident}/${topic} ${payload}` );
        mqtt_client.publish( `${config.mqtt.ident}/${topic}`, payload, opts );
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
        console.log( `mqtt: topic <${topic}> can't locate device` );
    }
}

function mqtt_mode_message( topic, payload ) {
    if ( payload ) {
        ezlo.setHouseMode( payload );
    } else {
        let mode = ezlo.getHouseMode();
        mqtt_send( `tele/mode/current`, data );
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
                    });
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
    return new Promise( ( resolve ) => {
        let url = config.mqtt.url || "mqtt://127.0.0.1:1883";
        console.log("Connecting to broker", url);
        let copt = config.mqtt.options || {};
        if ( config.mqtt.username ) {
            copt.username = config.mqtt.username;
            copt.password = config.mqtt.password || "";
        }
        copt.clientId = copt.clientId || config.mqtt.ident;
        copt.reconnectPeriod = parseInt( copt.reconnectPeriod ) || 15000;
        copt.connectTimeout = parseInt( copt.connectTimeout ) || 10000;
        copt.resubscribe = false;
        copt.will = {
            topic: `${config.mqtt.ident}/tele/LWT`,
            payload: 'offline',
            qos: 1,
            retain: true,
            properties: {
                willDelayInterval: 30
            }
        };

        console.log( "mqtt: connecting to broker at", url );
        mqtt_client = mqtt.connect( url, copt );
        mqtt_client.on( "connect", () => {
            debug( "mqtt: broker connection established; completing client setup" );
            retries = 0;
            mqtt_client.on( "message", ( topic, payload ) => {
                if ( ! topic.startsWith( `${config.mqtt.ident}/` ) ) {
                    /* Not for us */
                    return;
                }
                if ( topic.startsWith( `${config.mqtt.ident}/tele/` ) ) {
                    debug( `mqtt: received echo of <${topic}>` );
                    return;
                }
                payload = payload.toString( 'UTF-8' );
                if ( 0 === payload.length ) {
                    console.log( `mqtt: received <${topic}> with no (empty) payload` );
                } else if ( payload.length <= 64 ) {
                    console.log( `mqtt: received <${topic} ${payload}>` );
                } else {
                    console.log( `mqtt: received <${topic}> with ${payload.length} byte payload` );
                    debug( payload );
                }
                if ( topic.match( /^.*\/set\/device\/.*\/item\/[^/]*$/ ) ) {
                    mqtt_device_item_message( topic, payload );
                } else if ( topic.match( /^.*\/set\/device\/[^/]*$/ ) ) {
                    mqtt_device_message( topic, payload );
                } else if ( topic.match( /^.*\/set\/item\/[^/]*$/ ) ) {
                    mqtt_item_message( topic, payload );
                } else if ( topic.match( /^.*\/set\/mode$/ ) ) {
                    mqtt_mode_message( topic, payload );
                } else if ( topic.match( /^.*\/cmd\// ) ) {
                    let m = topic.match( /cmd\/(.+)/ );
                    if ( 2 === m.length ) {
                        let command = m[1].replace( /\//g, "." );
                        ezlo.send( command, payload ).then( data => {
                            console.log( `mqtt: hub command <${command}> complete; reply is`, data);
                            return data;
                        });
                    }
                } else if ( topic.match( /refresh$/ ) ) {
                    console.log( "mqtt: request for hub refresh; starting..." );
                    ezlo.refresh().catch( err => {
                        console.error( "mqtt: hub refresh failed:", err );
                    });
                } else {
                    console.error( "mqtt: unhandled/unrecognized topic", topic );
                }
            });
            let pattern = `${config.mqtt.ident}/#`;
            mqtt_client.subscribe( pattern, {}, ( err ) => {
                console.log( `mqtt: subscribed to ${pattern}` );
                if ( err ) {
                    throw new Error( `Unable to subscribe to ${pattern}: ${String(err)}` );
                } else {
                    online();
                }
            });
            resolve();
        });
        mqtt_client.on( "reconnect", () => {
            console.log( "mqtt: reconnecting to", url );
        });
        mqtt_client.on( "error", ( err ) => {
            console.log( "mqtt: error communicating with MQTT broker:", err );
        });
        mqtt_client.on( "offline", () => {
            console.log( "mqtt: broker connection lost!" );
            if ( 0 === ( ++retries % 3 ) ) {
                offline();
                console.error( "mqtt: too many retries; starting full recycle." );
                mqtt_recycle();
            } // else waiting for auto reconnect on this client
        });
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
            }, config.mqtt.options?.reconnectPeriod || 5000 );
        }
    }
}

process.on( 'unhandledRejection', ( reason, promise ) => {
    try {
        console.error( "Trapped unhandled Promise rejection:", reason );
        console.error( reason );
        console.error( promise );
        console.trace();
        console.error( promise.stack );
    } catch ( err ) {
        /* nada */
    }
});

async function shutdown_handler( sig ) {
    console.log( "ezmqtt: exiting, got", sig );
    stopping = true;
    offline();
    try {
        if ( this.client ) {
            console.log( "mqtt: closing broker connection" );
            this.client.close();
        }
    } catch ( err ) {
        console.error( err );
    } finally {
        this.client = false;
    }
    try {
        await ezlo.stop();
    } catch ( err ) {
        console.error( err );
    }
    if ( 'SIGQUIT' === sig ) {
        process.exit( 0 );
    } else {
        process.exit( 1 );
    }
}

process.on( 'SIGINT', shutdown_handler );
process.on( 'SIGTERM', shutdown_handler );
process.on( 'SIGQUIT', shutdown_handler );
process.on( 'SIGUSR1', shutdown_handler );

/* Main */
const ezlo = new EzloClient( config.ezlo_hub );

start_mqtt().then( () => {

    console.log("mqtt: connected to broker");

    ezlo.on( 'device-updated', device => {
        mqtt_send( `tele/device/${device._id}`, device );
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

    console.log( "mqtt: connecting to Ezlo hub" );
    ezlo.start();
});

// new Promise( (resolve) => { } ).catch( () => {});
