/* wsclient - part of ezmqtt -- An MQTT interface for Ezlo hubs
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

const WebSocket = require( 'ws' );

var debug = ()=>{}; /* console.debug; /* */

module.exports = class WSClient {

    constructor( url, options, ws_opts ) {
        this.url = url;
        this.options = options || {};
        this.ws_opts = { ...(ws_opts || {}) };
        this.ws_opts.handshakeTimeout = this.ws_opts.handshakeTimeout || ( this.options.connectTimeout || 15000 );
        this.websocket = false;
        this.pingTimer = false;
        this.pingok = true;
        this.closePromise = false;
        this.handlers = {}; // ??? should be Map
        if ( options.debug ) {
            debug = console.debug;
        }
    }

    /** startWS() starts a WebSocket connection to an endpoint. */
    async open() {
        const self = this;
        if ( this.pingTimer ) {
            try {
                clearTimeout( this.pingTimer );
                this.pingTimer = false;
            } catch ( err ) {
                /* Nada */
            }
        }
        if ( this.websocket ) {
            try {
                this.websocket.terminate();
            } catch ( err ) {
                /* Nada */
            }
        }
        return new Promise( ( resolve, reject ) => {
            self.closePromise = false;
            debug( "wsclient: opening", self.url, self.ws_opts );
            self.websocket = new WebSocket( self.url, undefined, self.ws_opts );
            let connected = false;
            let connectTimer = setTimeout( () => {
                connectTimer = false;
                try {
                    self.websocket.terminate();
                } catch ( err ) { /* nada */ }
                debug("wsclient: connection timeout");
                reject( 'timeout' );
            }, 50 + ( self.options.connectTimeout || 15000 ) );
            self.websocket.on( 'open', () => {
                debug( "wsclient: connected!");
                connected = true;
                clearTimeout( connectTimer );
                connectTimer = false;
                self.websocket.on( 'message', ( m ) => {
                    try {
                        self.trigger( 'message', m );
                    } catch ( err ) {
                        console.error( "wsclient: message handler threw untrapped exception:", err );
                    }
                });
                self.websocket.on( 'ping', () => {
                    if ( self.pingTimer ) {
                        clearTimeout( self.pingTimer );
                    }
                    self.pingTimer = setTimeout( self._wsping_expire.bind( self ), self.options.pingInterval || 60000 );
                    self.trigger( 'ping' );
                });
                self.websocket.on( 'pong', () => {
                    if ( self.websocket ) {
                        self.pingok = true;
                        if ( self.pingTimer ) {
                            clearTimeout( self.pingTimer );
                        }
                        self.pingTimer = setTimeout( self._wsping_expire.bind( self ), self.options.pingInterval || 60000 );
                    } else {
                        console.warn( "wsclient: ignoring pong on closed socket", self );
                    }
                });

                /* Start the ping timer */
                self.pingTimer = setTimeout( self._wsping_expire.bind( self ), self.options.pingInterval || 60000 );
                self.pingok = true;

                /* Mark me, James. We've been successful. */
                resolve( self );
            });
            self.websocket.on( 'close', ( code, reason ) => {
                if ( ! connected ) {
                    if ( connectTimer ) {
                        clearTimeout( connectTimer );
                        connectTimer = false;
                    }
                    debug( "wsclient: websocket to %2 closed during open/negotiation", self.url );
                    reject( "unexpected close" );
                } else {
                    debug( "wsclient: got websocket close" );
                    try {
                        self.trigger( 'close', code, reason );
                    } catch ( err ) {
                        console.error( 'wsclient: close handler threw untrapped exception:', err );
                    }
                }
                self.websocket = false;
                if ( self.pingTimer ) {
                    clearTimeout( self.pingTimer );
                    self.pingTimer = false;
                }
                if ( self.closeResolver ) {
                    self.closeResolver();
                    delete self.closeResolver;
                }
            });
            self.websocket.on( 'error', e => {
                if ( !connected ) {
                    if ( connectTimer ) {
                        clearTimeout( connectTimer );
                        connectTimer = false;
                    }
                    console.warn( "wsclient: websocket error during open/negotation:", e );
                } else {
                    console.warn( "wsclient: websocket error:", e );
                }
                try {
                    self.websocket.terminate();
                } catch ( err ) {
                    debug( 8, "wsclient: error while terminating socket:", err );
                }
                if ( !connected ) {
                    reject( e );
                }
            });
        }).catch( err => {
            debug( "wsclient: open caught", err );
            try {
                self.websocket.terminate();
            } catch( err ) {
                /* nada */
            }
            throw err;
        });
    }

    /** Called when the ping timer expires, which means the pong was not received when
     *  expected. That's a problem, so we terminate the connection if that happens. The
     *  subclass is expected to know it is closed (via ws_closing()) and do what it needs
     *  to open a new connection (or not). Note that we accept a ping from the server as
     *  our ping, so ping/pong in either direction resets the timer.
     */
    _wsping_expire() {
        this.pingTimer = false;
        if ( this.websocket ) {
            if ( ! this.pingok ) {
                console.error( "wsclient: ping got no timely reply from", this.url );
                this.terminate();
                return;
            }
            this.ping();
        }
    }

    ping() {
        if ( this.websocket ) {
            this.pingok = false; /* goes back true on received pong */
            if ( this.pingTimer ) {
                clearTimeout( this.pingTimer );
            }
            this.websocket.ping();
            this.pingTimer = setTimeout( this._wsping_expire.bind( this ),
                this.options.pingTimeout || ( ( this.options.pingInterval || 60000 ) / 2 ) );
        } else {
            throw new Error( "WebSocket not connected" );
        }
    }

    send( data ) {
        if ( this.websocket ) {
            this.websocket.send( data );
        } else {
            throw new Error( "WebSocket not connected" );
        }
    }

    async close( code, reason ) {
        if ( this.websocket ) {
            if ( this.closePromise ) {
                return this.closePromise;
            }
            return ( this.closePromise = new Promise( resolve => {
                this.closeResolver = resolve;
                this.websocket.close( code, reason );
            }));
        } else {
            return this.closePromise || Promise.resolve();
        }
    }

    terminate() {
        if ( this.websocket ) {
            this.websocket.terminate();
        }
    }

    on( event, callback, ...args ) {
        this.handlers[ event ] = this.handlers[ event ] || [];
        this.handlers[ event ].push( { callback: callback, args: args } );
    }

    trigger( event, ...data ) {
        return new Promise( resolve => {
            for ( let handler of ( this.handlers[ event ] || [] ) ) {
                let allargs = ( handler.args || [] ).concat( data );
                try {
                    handler.callback( ...allargs );
                } catch ( err ) {
                    console.error( `wsclient: handler for ${event} threw untrapped exception:`, err );
                }
            }
            resolve();
        });
    }
};
