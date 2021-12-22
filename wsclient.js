/* ezmqtt -- Copyright (C) 2021, Patrick H. Rigney, All Rights Reserved
 *
 */

const WebSocket = require( 'ws' );

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
            console.log( "WSClient opening", self.url, self.ws_opts );
            self.websocket = new WebSocket( self.url, undefined, self.ws_opts );
            let connected = false;
            let connectTimer = setTimeout( () => {
                connectTimer = false;
                try {
                    self.websocket.terminate();
                } catch ( err ) { /* nada */ }
                console.log("WSClient connection timeout");
                reject( 'timeout' );
            }, 50 + ( self.options.connectTimeout || 15000 ) );
            self.websocket.on( 'open', () => {
                console.log( "WSClient connected!");
                connected = true;
                clearTimeout( connectTimer );
                connectTimer = false;
                self.websocket.on( 'message', ( m ) => {
                    try {
                        self.trigger( 'message', m );
                    } catch ( err ) {
                        console.error( "1", err );
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
                        console.warn( "WSClient ignoring pong on closed socket", self );
                    }
                });

                /* Start the ping timer */
                self.pingTimer = setTimeout( self._wsping_expire.bind( self ), self.options.pingInterval || 60000 );
                self.pingok = true;

                /* Mark me, James. We've been successful. */
                console.log( "WSClient: resolving open" );
                resolve( self );
            });
            self.websocket.on( 'close', ( code, reason ) => {
                if ( ! connected ) {
                    if ( connectTimer ) {
                        clearTimeout( connectTimer );
                        connectTimer = false;
                    }
                    console.log( "WSClient websocket to %2 closed during open/negotiation", self.url );
                    reject( "unexpected close" );
                } else {
                    console.log( 7, "WSClient got websocket close" );
                    try {
                        self.trigger( 'close', code, reason );
                    } catch ( err ) {
                        console.error( err );
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
                    console.warn( "WSClient websocket error during open/negotation:", e );
                } else {
                    console.warn( "WSClient websocket error:", e );
                }
                try {
                    self.websocket.terminate();
                } catch ( err ) {
                    console.log( 8, "WSClient error terminating socket: %2", err );
                }
                if ( !connected ) {
                    reject( e );
                }
            });
        }).catch( err => {
            console.log( 5, "WSClient open caught %2", err );
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
                console.error( "WSClient websocket to %2 ping got no reply!", this, this.url );
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
                    console.log("handler",handler);
                    handler.callback( ...allargs );
                } catch ( err ) {
                    console.error( "Handler for", event, "threw uncaught exception:", err );
                    console.error( err );
                }
            }
            resolve();
        });
    }
};
