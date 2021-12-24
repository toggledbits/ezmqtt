/* ezlo.js - part of ezmqtt -- An MQTT interface for Ezlo hubs
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

const version = 21356;

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const WSClient = require('./wsclient');
const util = require('./util');

const AUTH_NONE = 0;
const AUTH_LOCAL = 1;
const AUTH_REMOTE = 2;

var loginfo = {};
var dumpdir = ".";  // ??? fix me
var debug = ()=>{}; /* console.debug; /* */

function isUndef( r ) {
    return "undefined" === typeof r;
}
function coalesce( r ) {
    return isUndef( r ) || Number.isNaN( r ) ? null : r;
}

module.exports = class EzloClient {
    constructor( config ) {
        this.config = config;
        this.endpoint = config.endpoint || false;
        this.socket = false;
        this.authinfo = false;
        this.retries = 0;
        this.ezlo_version = false;
        this.pending = {};
        this.lastid = 0;
        this.require_auth = AUTH_NONE;
        this.modes = { "1": "Home", "2": "Away", "3": "Night", "4": "Vacation" };
        this.devices = {};
        this.items = {};
        this.deviceItems = {};
        this.nextheartbeat = 0;
        this.stopping = false;
        this.timer = false;
        this.handlers = {};
        this.close_resolver = false;

        if ( config.endpoint && config.endpoint.match( /^\d+\.\d+\.\d+\.\d+$/ ) ) {
            /* IP address only */
            this.endpoint = "wss://" + config.endpoint + ":17000";
        }
        if ( isUndef( config.username ) && isUndef( config.password ) ) {
            this.require_auth = AUTH_NONE;
        } else if ( ( this.endpoint || "" ).match( /^wss?:\/\// ) ) {
            this.require_auth = AUTH_LOCAL;
        } else if ( isUndef( config.serial ) ) {
            throw new Error( `Insufficient data for eZLO access; need serial` );
        } else {
            this.require_auth = AUTH_REMOTE;
        }
        
        if ( this.config.debug ) {
            debug = console.debug;
        }
    }

    start() {
        if ( ! this.socket ) {
            /* Not connected/started. Do it now. */
            let loginPromise;
            if ( AUTH_NONE === this.require_auth ) {
                loginPromise = Promise.resolve();
            } else {
                console.log( `ezlo: starting cloud auth for ${this.config.username}` );
                loginPromise = this._login( this.config.username, this.config.password, String( this.config.serial ) ).then( () => {
                    console.log( `ezlo: cloud auth succeeded` );
                });
            }
            return loginPromise.then( () => {
                /* Have/got token, connect local WebSocket to hub */
                console.log( `ezlo: hub connection to ${this.config.serial} at ${this.endpoint}` );
                let ws_opts = { maxPayload: 256 * 1024 * 1024, followRedirects: true, pingInterval: 31070 };
                if ( this.endpoint.startsWith( 'wss://' ) && false !== this.config.ignore_cert ) {
                    const https = require( "https" );
                    let agent_opts = {
                        rejectUnauthorized: false,
                        checkServerIdentity: () => undefined
                    };
                    if ( true === this.config.disable_ecc_ciphers && AUTH_REMOTE !== this.require_auth ) {
                        agent_opts.ciphers = "AES256-SHA256";
                        console.log( "ezlo: configured to use non-ECC ciphers (may reduce encryption strength)" );
                    }
                    ws_opts.agent = new https.Agent( agent_opts );
                }
                this.socket = new WSClient( this.endpoint, { connectTimeout: 60000 }, ws_opts );
                this.socket.on( "message", this.handle_message.bind( this ) );
                this.socket.on( "close", (code,reason) => {
                    console.log( 'ezlo: connection closing', code, reason );
                    this.socket = false;
                    if ( this.close_resolver ) {
                        try {
                            this.close_resolver();
                        } catch ( err ) {
                            console.error( err );
                        }
                        this.close_resolver = false;
                    }
                    this.trigger( 'offline' );
                    this._retry_connection();
                });
                this.socket.open().then( async () => {
                    console.log( `ezlo: hub websocket connected (${this.endpoint})` );
                    if ( AUTH_LOCAL === this.require_auth ) {
                        /* Local auth with token */
                        debug( "ezlo: sending local hub login" );
                        this.send( 'hub.offline.login.ui',
                            {
                                user: this.authinfo.local_user_id,
                                token: this.authinfo.local_access_token
                            }
                        ).then( () => {
                            console.log("ezlo: local login success; taking hub inventory" );
                            this._inventory_hub();
                        }).catch( err => {
                            console.error( "ezlo: failed to inventory hub", err );
                            this.socket.terminate();
                        });
                    } else if ( AUTH_REMOTE === this.require_auth ) {
                        /* Auth by remote */
                        console.log( "ezlo: sending remote hub login" );
                        let ll = await loginfo[ this.config.username ];
                        this.send( 'loginUserMios',
                            {
                                MMSAuth: ll.mmsauth,
                                MMSAuthSig: ll.mmsauthsig
                            }
                        ).then( resp => {
                            this.send( 'register', { serial: String( this.config.serial ) } ).then( () => {
                                console.log( "ezlo: remote login success; taking hub inventory" );
                                this._inventory_hub();
                            }).catch( err => {
                                console.error( "ezlo: hub registration failed:",err );
                                this.socket.terminate();
                            });
                        }).catch( err => {
                            console.error( "ezlo: hub login failed:",err );
                            this.socket.terminate();
                        });
                    } else {
                        /* No auth needed */
                        console.log( "ezlo: unauthenticated hub websocket connected" );
                        if ( this.config.heartbeat ) {
                            this.nextheartbeat = this.config.heartbeat * 1000 + Date.now();
                            this._start_timer( this.config.heartbeat * 1000 );
                        }
                        this._inventory_hub();
                    }
                }).catch( err => {
                    this.authinfo = false;
                    console.error( "ezlo: failed to connect websocket to", this.endpoint, err );
                    if ( err instanceof Error && 'EHOSTUNREACH' !== err.code ) {
                        console.error( err );
                    }
                    this.socket = false;
                    this._retry_connection();
                });
            }).catch( err => {
                console.error( "ezlo: failed to log in:", err );
                this.authinfo = false;
                if ( err instanceof Error ) {
                    console.error( err );
                }
                this._retry_connection();
                if ( 0 === ( this.retries % 5 ) ) {
                    /* Delete user authorization to really start over */
                    delete loginfo[ this.config.username ];
                }
            });
        }
    }

    _retry_connection() {
        if ( ! this.stopping ) {
            console.log( "ezlo: will retry login/connection in 5000ms" );
            setTimeout( this.start.bind( this ), 5000 );
        }
    }

    async stop() {
        this.stopping = true;
        this._stop_timer();
        this.pending = {}; /* should we wait for them? */
        if ( ! this.socket ) {
            return Promise.resolve();
        }
        /* Close the socket. The promise will wait for that. */
        return new Promise( resolve => {
            this.close_resolver = resolve;
            this.socket.close();
        });
    }

    connected() {
        return !!this.socket;
    }

    ezlo_tick() {
        if ( this.socket && this.config.heartbeat ) {
            if ( Date.now() >= this.nextheartbeat ) {
                debug( "ezlo: sending heartbeat request" );
                this.send( 'hub.room.list' ).catch( err => {
                    console.error( "ezlo: heartbeat request failed:", err );
                    if ( "TimedPromise timeout" === err ) {
                        /* If timeout, blast the connection; close notice will launch reconnect */
                        this.socket.terminate();
                    }
                });
                this.nextheartbeat = Date.now() + this.config.heartbeat * 1000;
                this._start_timer( this.config.heartbeat * 1000 );
            } else {
                this._start_timer( this.nextheartbeat - Date.now() );
            }
        } else {
            this.restart();
            this._start_timer( this.config.heartbeat * 1000 );
        }
    }

    _start_timer( delta ) {
        if ( this.timer ) {
            throw new Error( 'Timer already running' );
        }
        this.timer = setTimeout( this.ezlo_tick.bind( this ), Math.max( delta, 1 ) );
    }

    _stop_timer() {
        if ( this.timer ) {
            clearTimeout( this.timer );
            this.timer = false;
        }
    }

    _login( username, password, serial ) {
        const self = this;
        const crypto = require( 'crypto' );
        const { v1: uuidv1 } = require( 'uuid' );
        const salt = "oZ7QE6LcLJp6fiWzdqZc";
        let authurl = self.config.authurl || "https://vera-us-oem-autha11.mios.com/autha/auth/username/%username%?SHA1Password=%hash%&PK_Oem=1&TokenVersion=2";
        const tokenurl = self.config.tokenurl || "https://cloud.ezlo.com/mca-router/token/exchange/legacy-to-cloud/";
        const syncurl = self.config.syncurl || "https://api-cloud.ezlo.com/v1/request";

        return new Promise( async ( resolve, reject ) => {
            let auth_p;
            if ( loginfo[ self.config.username ] ) {
                debug( "ezlo: checking cached cloud auth" );
                let ll = await loginfo[ self.config.username ];
                if ( ll.expires > Date.now() ) {
                    /* Already logged in (user cloud auth ) */
                    console.log( "ezlo: re-using existing cloud auth for user", self.config.username );
                    auth_p = loginfo[ self.config.username ];
                }
            }
            if ( ! auth_p ) {
                /* Perform user login at cloud. */
                self.authinfo = false; /* invalidate token, too */
                /* eZLO apparently uses broken digest SHA1. Weak, but predictable. And a hard-coded, published salt. Oy. */
                /* Ref: https://eprint.iacr.org/2020/014.pdf */
                console.log( "ezlo: performing cloud login" );
                const sha = crypto.createHash( 'sha1' );
                sha.update( username );
                sha.update( password );
                sha.update( salt );
                let hashpass = sha.digest( 'hex' );
                authurl = authurl.replace( /%username%/, username );
                authurl = authurl.replace( /%hash%/, hashpass );
                auth_p = loginfo[ self.config.username ] = new Promise( ( auth_resolve, auth_reject ) => {
                    debug( "ezlo: login request:", authurl );
                    self.fetchJSON( authurl, { timeout: 30000, headers: { 'accept': 'application/json' } } ).then( authinfo => {
                        debug( "ezlo: authentication response", authinfo );
                        if ( true || self.config.dump_cloudauth ) {
                            try {
                                fs.writeFileSync( path.join( dumpdir, "ezlo_auth_login.json" ),
                                    JSON.stringify( { request_url: authinfo.request_url, config: self.config,
                                        response: authinfo }, null, 4 )
                                );
                            } catch( err ) {
                                console.error( "ezlo: unable to write diagnostic data:", err );
                            }
                        }
                        let ll = {
                            mmsauth: authinfo.Identity,
                            mmsauthsig: authinfo.IdentitySignature,
                            server_account: authinfo.Server_Account
                        };
                        const buff = Buffer.from( authinfo.Identity, 'base64' );
                        const ident = JSON.parse( buff.toString( 'utf-8' ) ); /* A lot of work to get expiration */
                        ll.expires = ident.Expires * 1000; /* secs to ms */
                        auth_resolve( ll );
                    }).catch( err => {
                        if ( err instanceof Error ) {
                            if ( 404 === err.status ) {
                                console.error( "ezlo: failed to authenticate username/password; check config and account" );
                                /* Fatal */
                                self.stopping = true;
                                auth_reject( new Error( "auth failed" ) );
                                return;
                            } else if ( 'ECONNREFUSED' === err.code ) {
                                console.error( "ezlo: unable to connect to Ezlo cloud services; will be retried." );
                                auth_reject( new Error( "connection refused" ) );
                                return;
                            }
                        }
                        console.error( "ezlo: failed to authenticate:", err );
                        auth_reject( err );
                    });
                }).catch( err => {
                    console.error( "ezlo: failed cloud login for", self.config.username, err );
                    reject( err );
                });
            }
            auth_p.catch( err => {
                console.log("AUTH",err);
            });
            if ( AUTH_REMOTE === self.require_auth ) {
                /* Log in through remote access API */
                // Ref: https://community.ezlo.com/t/ezlo-linux-firmware-http-documentation-preview/214564/143?u=rigpapa
                auth_p.then( ( ll ) => {
                    let requrl = "https://" + ll.server_account + "/device/device/device/" + self.config.serial;
                    console.log( "ezlo: requesting device remote access login via", ll.server_account );
                    self.fetchJSON( requrl,
                        { timeout: 30000,
                            headers: {
                                "MMSAuth": ll.mmsauth,
                                "MMSAuthSig": ll.mmsauthsig,
                                "accept": "application/json"
                            }
                        }
                    ).then( hubinfo => {
                        debug( "ezlo: account server replied", hubinfo );
                        if ( true || self.config.dump_cloudauth ) {
                            try {
                                fs.writeFileSync( path.join( dumpdir, "ezlo_account_device.json" ),
                                    JSON.stringify( { request_url: tokenurl, response: hubinfo }, null, 4 )
                                );
                            } catch( err ) {
                                console.error( "ezlo: unable to write diagnostic data:", err );
                            }
                        }
                        if ( ! hubinfo.NMAControllerStatus ) {
                            console.warn( `eZLO cloud reports that hub ${hubinfo.PK_Device} is not available (trying anyway...)` );
                        }
                        self.endpoint = hubinfo.Server_Relay;
                        self.authinfo = {};
                        resolve();
                    }).catch( err => {
                        console.error( "ezlo: unable to fetch remote access relay:", err );
                        throw err;
                    });
                });
            } else if ( AUTH_LOCAL === self.require_auth ) {
                /* Access using local API. Get token, get controller list to find controller, and open WebSocket */
                auth_p.then( ( ll ) => {
                    debug( "ezlo: requesting hub local access token" );
                    let reqHeaders = {
                        "MMSAuth": ll.mmsauth,
                        "MMSAuthSig": ll.mmsauthsig,
                        "accept": "application/json"
                    };
                    self.fetchJSON( tokenurl, { timeout: 60000, headers: reqHeaders } ).then( tokenData => {
                        /* Have token, get controller keys */
                        debug( "ezlo: token response", tokenData );
                        if ( true || self.config.dump_cloudauth ) {
                            try {
                                fs.writeFileSync( path.join( dumpdir, "ezlo_auth_token.json" ),
                                    JSON.stringify( { request_url: tokenurl, request_headers: reqHeaders,
                                        response: tokenData }, null, 4 )
                                );
                            } catch( err ) {
                                console.error( "ezlo: unable to write diagnostic data:", err );
                            }
                        }
                        let syncBody = {
                            "call": "access_keys_sync",
                            "version": "1",
                            "params": {
                                 "version": 53,
                                 "entity": "controller",
                                 "uuid": uuidv1()
                            }
                        };
                        let syncHeaders = {
                            "authorization": "Bearer " + tokenData.token,
                            "content-type": "application/json; charset=UTF-8",
                            "accept": "application/json"
                        };
                        self.fetchJSON( syncurl, { method: "post", timeout: 30000, headers: syncHeaders, body: JSON.stringify( syncBody ) } ).then( controllerData => {
                            debug( "ezlo: sync response", controllerData );
                            /* Wow. WTF is this convoluted bullshit?!? Response contains multiple keys. First, have to go
                               through and find the uuid that matches the controller. */
                            if ( true || self.config.dump_cloudauth ) {
                                try {
                                    fs.writeFileSync( path.join( dumpdir, "ezlo_auth_sync.json" ),
                                        JSON.stringify( { request_url: syncurl, request_headers: syncHeaders,
                                        request_body: syncBody, response: controllerData }, null, 4 )
                                    );
                                } catch( err ) {
                                    console.error( "ezlo: unable to write diagnostic data:", err );
                                }
                            }
                            let cid = false;
                            for ( const key in controllerData.data.keys ) {
                                const c = controllerData.data.keys[ key ];
                                if ( c.meta && c.meta.entity && "controller" === c.meta.entity.type &&
                                    serial === c.meta.entity.id ) {
                                    cid = c.meta.entity.uuid;
                                    break;
                                }
                            }
                            if ( ! cid ) {
                                console.error( `ezlo: no controller data for serial ${serial} in account` );
                                reject( "auth failed" );
                                return;
                            }
                            /* Now, find key with meta.entity.target.type="controller" and matching uuid; this will give
                               us the local access user and password/token. */
                            for ( const key in controllerData.data.keys ) {
                                const c = controllerData.data.keys[ key ];
                                if ( c.meta && c.meta.target && "controller" === c.meta.target.type &&
                                    cid === c.meta.target.uuid ) {
                                    /* We have it! */
                                    console.log( `ezlo: got local access token for serial`, serial );
                                    self.authinfo = {
                                        controller_id: cid,
                                        local_user_id: c.meta.entity.uuid,
                                        local_access_token: c.data.string
                                    };
                                    resolve();
                                    return;
                                }
                            }
                            /* Note slightly different message from prior, to distinguish failure type */
                            console.error( "ezlo: no controller token for serial ${serial} in account" );
                            reject( "auth failed" );
                        }).catch( err => {
                            console.error( "ezlo: failed to fetch controller data:", err );
                            reject( "auth failed" );
                        });
                    }).catch( err => {
                        console.error( "ezlo: failed to fetch token:", err );
                        reject( "auth failed" );
                    });
                });
            } else {
                /* No auth/login; really should never get here, because this func should not be called */
                resolve();
            }
        });
    }

    _inventory_hub() {
        let p = [];
        let info = {};
        p.push( ( resolve, reject ) => {
            console.log( "ezlo: requesting hub info" );
            this.send( "hub.info.get" ).then( data => {
                debug("ezlo: got hub.info.get response", data );
                info.hub_info_get = data;
                try {
                    this._process_hub_info( data );
                    resolve();
                } catch ( err ) {
                    console.error( "ezlo: failed to process hub info:", err );
                    reject( err );
                }
            }).catch( err => {
                reject( err );
            });
        });
        p.push( ( resolve, reject ) => {
            console.log( "ezlo: requesting mode info" );
            this.send( { method: "hub.modes.get", api: "2.0" } ).then( data => {
                debug( "ezlo: got hub.modes.get response", data );
                info.hub_modes_get = data;
                try {
                    this._process_hub_modes( data );
                    resolve();
                } catch ( err ) {
                    console.error( "ezlo: failed to process mode info:", err );
                    reject( err );
                }
            }).catch( err => {
                reject( err );
            });
        });
        p.push( ( resolve, reject ) => {
            console.log( "ezlo: requesting devices" );
            this.send( "hub.devices.list", {}, 60000 ).then( data => {
                /* Devices */
                debug( "ezlo: got hub.devices.list response" );
                //debug( data );
                info.hub_devices_list = data;
                try {
                    this._process_hub_devices( data );
                    resolve();
                } catch ( err ) {
                    console.error( "ezlo: failed to process devices:", err );
                    reject( err );
                }
            }).catch( err => {
                console.error( "ezlo: failed to fetch devices:", err );
                reject( err );
            });
        });
        p.push( ( resolve, reject ) => {
            console.log( "ezlo: requesting items" );
            this.send( "hub.items.list", {}, 60000 ).then( data => {
                /* "Compile" items -- create index arrays per-item and per-device */
                debug( "ezlo: got hub.items.list response" );
                // debug( data );
                info.hub_items_list = data;
                try {
                    this._process_hub_items( data );
                    resolve();
                } catch ( err ) {
                    console.error( "ezlo: failed to process items:", err );
                    reject( err );
                }
            }).catch( err => {
                console.error( "ezlo: failed to fetch items:", err );
                reject( err );
            });
        });
        return util.runInSequence( p ).then( () => {
            this.trigger( 'online' );
            fs.writeFileSync( "ezlo_inventory.json", JSON.stringify( info ), { encoding: "utf-8" } );
        }).catch( err => {
            console.error( "ezlo: failed inventory:", err );
            this.socket.terminate();
        });
    }

    _process_hub_info( data ) {
        console.log( `ezlo: hub ${data.result.serial} is ${data.result.model} hw ${data.result.hardware} fw ${data.result.firmware}` );
        if ( String( data.result.serial ) !== String( this.config.serial ) ) {
            console.error( "ezlo: MISCONFIGURATION! Connected hub serial ${data.result.serial} different from configuration serial ${this.config.serial}",
                data.result.serial, this.config.serial );
            this.stopping = true;
            this.socket.terminate();
            /* Close handler will mark off-line */
            throw new Error( "Hub serial mismatch; check configuration" );
        }
        if ( AUTH_REMOTE === this.require_auth && String( data.result.model ).startsWith( "ATOM" ) &&
            "undefined" === typeof this.config.disable_ecc_ciphers ) {
            /* Explicit check for undefined above, so that setting to false disables warning messages. */
            console.warn( "For Atoms, use of `disable_ecc_ciphers` in config is recommended" );
        }
        if ( AUTH_NONE === this.require_auth && ! data.result.offlineAnonymousAccess ) {
            console.error( "ezlo: stopping; hub's offline insecure access is disabled, and cloud auth info is not configured" );
            this.stopping = true;
            throw new Error( 'Hub anonymous access is disabled, and username and password are not configured' );
        }
        if ( "boolean" === typeof this.config.set_anonymous_access &&
                this.config.set_anonymous_access !== data.result.offlineAnonymousAccess ) {
            console.log( "ezlo: changing hub's anonymous access to", this.config.set_anonymous_access );
            this.send( "hub.offline.anonymous_access.enabled.set", { enabled: this.config.set_anonymous_access } ).then( () => {
                if ( this.config.set_anonymous_access ) {
                    console.log("ezlo: anonymous access has been enabled on the hub" );
                } else {
                    console.warn( "ezlo: anonymous access has been disabled on the hub; please make sure you have the username and password for your eZLO account in the config!" );
                }
                this.send( 'hub.reboot' );
            }).catch( err => {
                console.error( "ezlo: failed to modify the anonymous access setting:", err );
            });
        }
        if ( "boolean" === typeof this.config.set_insecure_access && this.config.set_insecure_access !== data.result.offlineInsecureAccess ) {
            /** 2021-07-08: This causes an immediate close before the reply can be received, so we just have to assume it worked... */
            console.log("ezlo: changing hub's insecure access to", this.config.set_insecure_access );
            this.send( "hub.offline.insecure_access.enabled.set", { enabled: this.config.set_insecure_access } ).then( () => {
                console.log( `ezlo: insecure (unencryped) access has been ${this.config.set_insecure_access ? "enabled" : "disabled"} on the hub` );
            }).catch( err => {
                console.error( "ezlo: failed to modify the insecure access setting:", err );
            });
        }
        if ( this.endpoint.startsWith( 'ws://' ) && data.result.offlineInsecureAccess && ! data.result.offlineAnonymousAccess ) {
            console.warn( "It appears you have configured eZLO hub {0:q} (controller ID {1:q}) for unencrypted connections but authenticated access. This means the authentication token will be sent in the clear (unencryped) on your network, which is not recommended. Please switch your `endpoint` field in the config for this controller back to `wss://` to use encrypted connections with authentication.", this.config.serial );
        }
    }

    _process_hub_modes( data ) {
        if ( Array.isArray( data.result.modes ) ) {
            this.modes = {};
            data.result.modes.forEach( el => {
                this.modes[ el._id ] = String( el.name || el._id );
            });
        }
        this.trigger( 'mode-changed', { id: data.result.current, name: this.modes[ data.result.current ] } );
    }

    _process_hub_items( data ) {
        debug( `ezlo: got ${( data.result.items || [] ).length} items` );
        data.result.items.forEach( item => {
            let iid = item._id;
            let changed = false;
            if ( ! this.items[ iid ] ) {
                changed = true;
            } else {
                changed = ! util.deepCompare( this.items[ iid ], item );
            }
            this.items[ item._id ] = item;
            this.devices[ item.deviceId ] = this.devices[ item.deviceId ] || { _id: item.deviceId };
            this.deviceItems[ item.deviceId ] = this.deviceItems[ item.deviceId ] || this.devices[ item.deviceId ];
            this.deviceItems[ item.deviceId ][ iid ] = item;
            this.deviceItems[ item.deviceId ][ item.name ] = item;
            if ( changed ) {
                this.trigger( 'item-updated', item, this.devices[ item.deviceId ] );
            }
        });
    }

    _process_hub_devices( data ) {
        debug( `ezlo: got ${( data.result.devices || [] ).length} devices` );
        data.result.devices.forEach( dev => {
            let did = dev._id;
            let changed = false;
            if ( ! this.devices[ did ] ) {
                changed = true;
            } else {
                changed = ! util.deepCompare( this.devices[ did ], dev );
            }
            this.devices[ did ] = dev;
            if ( changed ) {
                this.trigger( 'device-updated', dev );
            }
        });
    }

    handle_message( message ) {
        debug( `ezlo: received message ${message.length} bytes` );
        debug( message );
        let event = JSON.parse( message );
        if ( this.pending[ event.id ] ) {
            /* Response for tracked request */
            let slot = this.pending[ event.id ];
            if ( slot.timer ) {
                clearTimeout( slot.timer );
            }
            delete this.pending[ String( event.id ) ];
            if ( event.error ) {
                let e = new Error( event.error.message );
                e.code = event.error.code;
                e.reason = event.error.reason;
                slot.reject( e );
            } else {
                slot.resolve( event );
            }
        } else if ( "ui_broadcast" === event.id ) {
            /* UI broadcast message */
            switch ( ( event.msg_subclass || "" ).toLowerCase() ) {

                case "ezlostatechanged":
                    {
                        if ( AUTH_REMOTE === this.require_auth && false === event.result.connected &&
                            String( event.result.serial ) === String( this.config.serial ) ) {
                            console.warn( `ezlo: cloud service signalled that hub ${event.result.serial} is no longer connected` );
                            this.socket.close( 1000, "disconnected" );
                        }
                    }
                    break;

                case "hub.gateway.updated":
                    {
                        this.trigger( 'hub-status-change', event.result.status );
                    }
                    break;

                case "hub.modes.switched":
                    {
                        /* Change of house mode */
                        /* { "id": "ui_broadcast", "msg_id":"...", "msg_subclass": "hub.modes.switched",
                            "result": { "from": "1", "status":"done", "switchToDelay":0, "to":"3" } } */
                        let mid = coalesce( event.result.to );
                        let mode = coalesce( this.modes[ event.result.to ] );
                        if ( "begin" === event.result.status ) {
                            this.trigger( 'mode-changing', { id: mid, name: mode } );
                        } else if ( "done" === event.result.status ) {
                            this.trigger( 'mode-changed', { id: mid, name: mode } );
                        } else if ( "cancel" === event.result.status ) {
                            this.trigger( 'mode-changed', { id: event.result.from, name: this.modes[ event.result.from ] } );
                        } else {
                            console.error( "ezlo: unrecognized/unsupported house mode change status:", event.result.status );
                        }
                    }
                break;

                case "hub.info.changed":
                    {
                        debug( "ezlo: hub info change", event );
                    }
                    break;

                case "hub.network.changed":
                    // {"id":"ui_broadcast","msg_id":"61c53413123e5912538942d7","msg_subclass":"hub.network.changed","result":{"interfaces":[{"_id":"eth0","internetAvailable":true,"ipv4":{"dns":["192.168.0.15","192.168.0.44"],"gateway":"192.168.0.1","ip":"192.168.0.67","mask":"255.255.255.0"},"status":"up"}],"syncNotification":false}}
                    {
                        debug( "ezlo: hub.network.changed", event );
                    }
                    break;

                case "hub.device.added":
                    {
                        this.devices[ event.result._id ] = event.result;
                        this.deviceItems[ event.result._id ] = {};
                    }
                    break;

                case "hub.device.removed":
                    {
                    }
                    break;

                case "hub.device.updated":
                    {
                        /* Example:
                            {
                                "id": "ui_broadcast",
                                "msg_id": "60e3bc53123e59121fb77a09",
                                "msg_subclass": "hub.device.updated",
                                "result": {
                                    "_id": "60e3504c123e591215841010",
                                    "reachable": false,
                                    "serviceNotification": false,
                                    "syncNotification": false
                                }
                            }
                        */
                        debug( "ezlo: handling device update for", event.result._id );
                        for ( let [ key, value ] of Object.entries( event.result ) ) {
                            this.devices[ event.result._id ][ key ] = value;
                        }
                        this.trigger( 'device-updated', event.result );
                    }
                    break;

                case "hub.item.added":
                    debug( `ezlo: adding ${event.result.name} (${event.result._id}) value (${event.result.valueType})${String(event.result.value)} for device ${event.result.deviceName} (${event.result.deviceId})` );
                    this.items[ event.result._id ] = event.result;
                    this.deviceItems[ event.result.deviceId ] = this.deviceItems[ event.result.deviceId ] || {};
                    /* fall through */

                case "hub.item.updated":
                    {
                        /* Example:
                            {
                                "id": "ui_broadcast",
                                "msg_id": "60e353ce123e59124101dd0c",
                                "msg_subclass": "hub.item.updated",
                                "result": {
                                    "_id": "60e3504d123e591215841015",
                                    "deviceCategory": "dimmable_light",
                                    "deviceId": "60e3504c123e591215841010",
                                    "deviceName": "600W Dimmer",
                                    "deviceSubcategory": "dimmable_in_wall",
                                    "name": "dimmer",
                                    "notifications": [],
                                    "roomName": "",
                                    "serviceNotification": false,
                                    "syncNotification": false,
                                    "userNotification": false,
                                    "value": 0,
                                    "valueFormatted": "0",
                                    "valueType": "int"
                                }
                            }
                        */
                        console.log( `ezlo: updating device ${event.result.deviceName} (${event.result.deviceId}) item ${event.result.name} (${event.result._id}) to (${event.result.valueType})${String(event.result.value)}` );
                        let item = this.deviceItems[ event.result.deviceId ][ event.result._id ];
                        if ( ! item ) {
                            this.items[ event.result._id ] = event.result;
                            this.deviceItems[ event.result.deviceId ][ event.result._id ] = event.result;
                            this.deviceItems[ event.result.deviceId ][ event.result.name ] = event.result;
                        } else {
                            item.value = event.result.value;
                            item.valueFormatted = event.result.valueFormatted;
                            item.valueType = event.result.valueType;
                        }
                        this.trigger( 'item-updated', event.result, this.devices[ event.result.deviceId ] );
                    }
                    break;

                case "hub.room.created":
                    {
                    }
                    break;

                case "hub.room.deleted":
                    {
                    }
                    break;

                case "hub.room.edited":
                    {
                    }
                    break;

                case "hub.scene.added":
                    // {"id":"ui_broadcast","msg_id":"61c534d5123e5912538942d9","msg_subclass":"hub.scene.added","result":{"_id":"61c534d5123e59128604c10a","enabled":true,"house_modes":["1","2","3","4"],"is_group":false,"name":"Something","parent_id":"","syncNotification":true,"then":[{"_id":"61c534d5123e59128604c10b","blockOptions":{"method":{"args":{"item":"item","value":"value"},"name":"setItemValue"}},"blockType":"then","fields":[{"name":"item","type":"item","value":"61c393f4123e5921f55e806a"},{"name":"value","type":"int","value":0}]}],"user_notifications":[],"when":[]}}
                    {
                    }
                    break;

                case "hub.scene.deleted":
                    {
                    }
                    break;

                case "hub.scene.changed":
                    // {"id":"ui_broadcast","msg_id":"61c5353c123e5912538942de","msg_subclass":"hub.scene.changed","result":{"_id":"61c534d5123e59128604c10a","enabled":true,"group_id":"","house_modes":["1","2","3","4"],"is_group":false,"name":"Something","parent_id":"0","syncNotification":false,"then":[{"_id":"61c5353c123e59128604c10d","blockOptions":{"method":{"args":{"item":"item","value":"value"},"name":"setItemValue"}},"blockType":"then","fields":[{"name":"item","type":"item","value":"61c393f4123e5921f55e806a"},{"name":"value","type":"int","value":0}]}],"user_notifications":[],"when":[]}}
                    {
                    }
                    break;

                case "hub.scene.run.progress":
                    // {"id":"ui_broadcast","msg_id":"61c534f0123e5912538942db","msg_subclass":"hub.scene.run.progress","result":{"notifications":[],"scene_id":"61c534d5123e59128604c10a","scene_name":"Something","status":"started","userNotification":false}}
                    // {"id":"ui_broadcast", "msg_id":"61c534f0123e5912538942dc","msg_subclass":"hub.scene.run.progress","result":{"notifications":[],"scene_id":"61c534d5123e59128604c10a","scene_name":"Something","status":"finished","userNotification":true}}
                    {
                    }
                    break;

                default:
                    /* ignored */
            }
        } else {
            debug( "ezlo: ignoring unsupported message:", message );
        }
    }

    _ezlo_id() {
        let id = Date.now();
        if ( id <= this.lastid ) {
            id = ++this.lastid;
        } else {
            this.lastid = id;
        }
        return id.toString( 16 );
    }

    /** Returns a Promise that sends a request to Ezlo and resolves when it gets
     *  the matching reply. The reply can time out, and the Promise rejects.
     */
    send( method, params, timeout ) {
        timeout = timeout || 15000;
        let slot = { req_id: this._ezlo_id(), req_method: method, expires: Date.now() + timeout,
            resolve: false, reject: false, timer: false };
        this.pending[ slot.req_id ] = slot;
        let payload = {
            api: "1.0",
            id: slot.req_id,
            method: method,
            params: params || {}
        };
        if ( "object" === typeof method ) {
            payload.method = method.method;
            payload.api = method.api || "1.0";
        }
        slot.promise = new Promise( (resolve,reject) => {
            debug( `ezlo: sending tracked request ${slot.req_id}` );
            slot.timer = setTimeout( () => {
                    slot.timer = false;
                    slot.reject( 'timeout' );
                }, timeout );
            slot.resolve = resolve;
            slot.reject = reject;
            this.socket.send( JSON.stringify( payload ) );
        }, timeout ).catch( err => {
            console.error( `ezlo: request ${slot.req_id} (${slot.req_method}) failed:`, err );
            throw err;
        }).finally( () => {
            debug( "ezlo: removing settled tracked request", slot.req_id );
            delete this.pending[ slot.req_id ];
        });
        // debug( "ezlo: created tracked request ${slot.req_id} with payload", payload );
        return slot.promise;
    }

    /** Custom implementation for generic x_ezlo_device.set_item_value
     *  Returns Promise, as it must.
     */
    setItemValue( itemid, value ) {
        let item = this.items[ itemid ];
        if ( ! item ) {
            throw new ReferenceError( `Item ${itemid} does not exist` );
        }
        let device = this.devices[ item.deviceId ] || {};
        debug("ezlo: setItemValue",itemid,"=",value,"item",item._id);
        switch ( item.valueType  ) {
            case "int":
                value = parseInt( value );
                if ( isNaN( value ) ) {
                    throw TypeError( `Item ${item.name} requires ${item.valueType} value` );
                }
                if ( ( item.minValue && value < item.minValue ) || ( item.maxValue && value > item.maxValue ) ) {
                    throw new RangeError( `Item ${item.name} value out of range` );
                }
                break;
            case "bool":
                if ( "string" === typeof value ) {
                    value = value.match( /^\s*(1|y|yes|t|true|on)\s*$/i );
                } else if ( "boolean" !== typeof value ) {
                    value = !! value;
                }
                break;
            case "token":
            case "string":
                value = String( value );
                break;
            default:
                if ( "string" !== typeof value ) {
                    value = JSON.stringify( value );
                }
        }
        console.log( `ezlo: sending hub.item.value.set (${item.name}=${value} on ${device.name})` );
        debug( `ezlo: item valueType=${item.valueType}, value final type=${typeof value}` );
        debug( `ezlo: payload`, { _id: item._id, value: value } );
        return this.send( 'hub.item.value.set', { _id: item._id, value: value } );
    }

    async refresh() {
        return this._inventory_hub();
    }

    hasDevice( id ) {
        return !!this.devices[ id ];
    }

    enumDevices() {
        return Object.keys( this.devices );
    }

    getDevice( id ) {
        return this.devices[ id ];
    }

    getFullDevice( id ) {
        let d = { ...this.devices[ id ] };
        d.items = this.deviceItems[ id ];
        return d;
    }

    hasItem( id ) {
        return !!this.items[ id ];
    }

    enumItems() {
        return Object.keys( this.items );
    }

    getItem( id ) {
        return this.items[ id ];
    }

    on( event, callback, ...args ) {
        this.handlers[ event ] = this.handlers[ event ] || [];
        this.handlers[ event ].push( { callback: callback, args: args } );
    }

    async trigger( event, ...data ) {
        return new Promise( resolve => {
            for ( let handler of ( this.handlers[ event ] || [] ) ) {
                let allargs = ( handler.args || [] ).concat( data );
                try {
                    handler.callback( ...allargs );
                } catch ( err ) {
                    console.error( `ezlo: handler for ${event} threw uncaught exception:`, err );
                }
            }
            resolve();
        });
    }

    /* Convenience method to fetch a URL that returns a JSON response. */
    async fetchJSON( requestURL, opts ) {
        opts = opts || {};
        opts.timeout = opts.timeout || 15000;
        /* Force "Accept" header with JSON MIME type */
        opts.headers = opts.headers || {};
        let m = Object.keys( opts.headers ).map( k => k.toLowerCase() );
        if ( ! m.includes( 'accept' ) ) {
            opts.headers.accept = 'application/json';
        }
        return new Promise( (resolve,reject) => {
            fetch( requestURL, opts ).then( res => {
                if ( res.ok ) {
                    res.json().then( data => {
                        resolve( data );
                    }).catch( err => {
                        reject( err );
                    });
                } else {
                    let e = new Error( `Request failed: ${res.status} ${res.statusText}` );
                    e.status = res.status;
                    e.statusText = res.statusText;
                    reject( e );
                }
            }).catch( err => {
                reject( err );
            });
        });
    }
};
